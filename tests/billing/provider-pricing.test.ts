import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  rule: {} as Record<string, unknown>,
  equalities: [] as unknown[][],
}));
vi.mock("@/lib/supabase/admin", () => ({
  getAdminClient: () => ({ from: mock.from, rpc: mock.rpc }),
}));
import { quoteGeneration, reserveGeneration } from "@/server/billing/service";

beforeEach(() => {
  vi.clearAllMocks();
  mock.equalities = [];
  vi.stubEnv("AI_PROVIDER", "qwen");
  vi.stubEnv("QWEN_API_URL", "https://gpu.example.test");
  vi.stubEnv("QWEN_API_KEY", "synthetic-provider-test-bearer-key-123456");
  vi.stubEnv("FASHN_API_KEY", "");
  vi.stubEnv("ENABLE_PHOTO_GENERATION", "true");
  vi.stubEnv("ENABLE_TRY_ON", "true");
  vi.stubEnv("ENABLE_VIDEO_GENERATION", "true");
  mock.rule = {
    id: "price-qwen",
    provider: "qwen",
    provider_model: "Qwen/Qwen-Image-Edit-2511",
    credits: 17,
    provider_credits_milli: 0,
    estimated_provider_cost_microusd: 123456,
  };
  mock.from.mockImplementation((table: string) => {
    const chain = { select: vi.fn(), eq: vi.fn(), not: vi.fn(), single: vi.fn() };
    chain.select.mockReturnValue(chain);
    chain.not.mockReturnValue(chain);
    chain.eq.mockImplementation((...args: unknown[]) => {
      mock.equalities.push(args);
      return chain;
    });
    chain.single.mockImplementation(async () => ({
      data: table === "generation_price_rules" ? mock.rule : { available: 100, reserved: 0 },
      error: null,
    }));
    return chain;
  });
  mock.rpc.mockResolvedValue({ data: { id: "job-qwen", provider: "qwen" }, error: null });
});
afterEach(() => vi.unstubAllEnvs());

describe("provider-aware billing selection (explicit test doubles)", () => {
  it("quotes the selected Qwen model without any FASHN credential or credit conversion", async () => {
    const quote = await quoteGeneration({
      organizationId: "workspace-fixture",
      operation: "photo",
      options: {},
    });
    expect(quote).toMatchObject({
      provider: "qwen",
      providerModel: "Qwen/Qwen-Image-Edit-2511",
      credits: 17,
      providerCreditsMilli: 0,
      estimatedProviderCostMicrousd: 123456,
      lifecycle: "experimental",
    });
    expect(mock.equalities).toContainEqual(["provider", "qwen"]);
  });
  it("does not treat unknown GPU cost as zero or select a fallback FASHN price", async () => {
    mock.rule.estimated_provider_cost_microusd = null;
    await expect(
      quoteGeneration({ organizationId: "workspace-fixture", operation: "photo" }),
    ).rejects.toMatchObject({ code: "PROVIDER_COST_UNREVIEWED" });
    expect(mock.equalities).toContainEqual(["provider", "qwen"]);
    expect(mock.equalities).not.toContainEqual(["provider", "fashn"]);
  });
  it("requires pricing to match the exact configured model", async () => {
    mock.rule.provider_model = "product-to-model";
    await expect(
      quoteGeneration({ organizationId: "workspace-fixture", operation: "photo" }),
    ).rejects.toMatchObject({ code: "PRICING_MODEL_MISMATCH" });
  });
  it("pins reservations to the selected provider and keeps confirmed price parameters", async () => {
    await reserveGeneration({
      organizationId: "workspace-fixture",
      actorId: "actor-fixture",
      operation: "photo",
      options: {},
      idempotencyKey: "qwen-quote-fixture",
      expectedCredits: 17,
      expectedPriceRuleId: "price-qwen",
    });
    expect(mock.rpc).toHaveBeenCalledWith(
      "reserve_generation",
      expect.objectContaining({
        p_provider: "qwen",
        p_expected_credits: 17,
        p_expected_price_rule_id: "price-qwen",
      }),
    );
  });
  it("rejects a changed invitation provider and Qwen video before reserving or quoting", async () => {
    await expect(
      reserveGeneration({
        provider: "fashn",
        organizationId: "workspace-fixture",
        actorId: null,
        operation: "try_on",
        idempotencyKey: "guest-fixture",
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_CHANGED" });
    await expect(
      quoteGeneration({ organizationId: "workspace-fixture", operation: "video" }),
    ).rejects.toMatchObject({ code: "GENERATION_DISABLED" });
    expect(mock.rpc).not.toHaveBeenCalled();
    expect(mock.from).not.toHaveBeenCalled();
  });
  it("allows FASHN only when explicitly selected and configured by the operator", async () => {
    vi.stubEnv("AI_PROVIDER", "fashn");
    vi.stubEnv("FASHN_API_KEY", "synthetic-fashn-fixture-key");
    mock.rule = {
      ...mock.rule,
      provider: "fashn",
      provider_model: "product-to-model",
      provider_credits_milli: 2000,
      estimated_provider_cost_microusd: null,
    };
    expect(
      await quoteGeneration({ organizationId: "workspace-fixture", operation: "photo" }),
    ).toMatchObject({ provider: "fashn", providerModel: "product-to-model", lifecycle: "preview" });
    expect(mock.equalities).toContainEqual(["provider", "fashn"]);
  });
  it("quotes free Hugging Face video only for the 5-second 480p clip", async () => {
    vi.stubEnv("AI_PROVIDER", "huggingface");
    vi.stubEnv("HF_TOKEN", "hf_synthetic-test-token");
    mock.rule = {
      ...mock.rule,
      provider: "huggingface",
      provider_model: "Wan-AI/Wan2.2-I2V-A14B",
      credits: 15,
      estimated_provider_cost_microusd: 0,
    };
    expect(
      await quoteGeneration({
        organizationId: "workspace-fixture",
        operation: "video",
        options: { duration: 5, resolution: "480p" },
      }),
    ).toMatchObject({ provider: "huggingface", optionKey: "5:480p", credits: 15 });
    expect(mock.equalities).toContainEqual(["provider", "huggingface"]);
    await expect(
      quoteGeneration({
        organizationId: "workspace-fixture",
        operation: "video",
        options: { duration: 10, resolution: "480p" },
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_OPTIONS_UNSUPPORTED" });
    await expect(
      reserveGeneration({
        organizationId: "workspace-fixture",
        actorId: "actor-fixture",
        operation: "video",
        options: { duration: 5, resolution: "1080p" },
        idempotencyKey: "hf-unsupported-resolution",
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_OPTIONS_UNSUPPORTED" });
    expect(mock.rpc).not.toHaveBeenCalled();
  });
});
