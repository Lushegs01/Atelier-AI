import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  quotaRefusals: 0,
  asset: { id: "", width: 864, height: 1152, byte_size: 900_000, kind: "garment_original" },
}));
const ids = {
  org: "467219f3-84c1-4423-a709-2d68ed8f10de",
  user: "10000000-0000-4000-8000-000000000001",
  garment: "30000000-0000-4000-8000-000000000001",
  asset: "40000000-0000-4000-8000-000000000001",
  rule: "60000000-0000-4000-8000-000000000001",
};

function tenantQuery(table: string) {
  const query = {
    select: () => query,
    eq: () => query,
    in: () => query,
    is: () => query,
    gte: () => query,
    lte: () => query,
    order: () => query,
    limit: () => query,
    maybeSingle: async () => ({
      data:
        table === "garments"
          ? { id: ids.garment }
          : table === "assets"
            ? { ...state.asset, generation_job_id: null }
            : null,
      error: null,
    }),
  };
  return query;
}

vi.mock("@/server/auth/context", () => ({
  requireTenant: async () => ({
    organizationId: ids.org,
    user: { id: ids.user },
    client: { from: tenantQuery },
  }),
  consumeRateLimit: vi.fn(async () => undefined),
}));
vi.mock("@/lib/supabase/admin", () => ({
  getAdminClient: () => ({
    from: () => {
      const query = {
        select: () => query,
        eq: () => query,
        gte: async () => ({ count: state.quotaRefusals, error: null }),
      };
      return query;
    },
  }),
}));
const billing = vi.hoisted(() => ({
  quoteGeneration: vi.fn(),
  reserveGeneration: vi.fn(),
}));
vi.mock("@/server/billing/service", () => billing);
vi.mock("@/workers/client", () => ({ dispatchGeneration: vi.fn(async () => undefined) }));

import { submitDesignerGeneration } from "@/server/services/generations";
import { HF_PROCESSING_DISCLOSURE_VERSION } from "@/server/ai/huggingface";

const photo = {
  organizationId: ids.org,
  operation: "photo",
  garmentId: ids.garment,
  options: { direction: "faithful", seed: 1234 },
};
const video = (options: Record<string, unknown> = {}) => ({
  organizationId: ids.org,
  operation: "video",
  sourceAssetId: ids.asset,
  options: { duration: 5, resolution: "480p", motionPreset: "subtle", ...options },
});

async function quoteAndSubmit(input: Record<string, unknown>, extra: Record<string, unknown>) {
  const quoted = (await submitDesignerGeneration(input, true)) as { quoteToken: string };
  return submitDesignerGeneration({
    ...input,
    quoteToken: quoted.quoteToken,
    idempotencyKey: "request-identifier-1",
    ...extra,
  });
}

describe("free Hugging Face request safeguards (service with database test doubles)", () => {
  beforeEach(() => {
    vi.stubEnv("AI_PROVIDER", "huggingface");
    vi.stubEnv("HF_TOKEN", "hf_synthetic-test-token");
    vi.stubEnv("ENABLE_PHOTO_GENERATION", "true");
    vi.stubEnv("ENABLE_VIDEO_GENERATION", "true");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-service-role-signing-secret");
    state.quotaRefusals = 0;
    state.asset = {
      id: ids.asset,
      width: 864,
      height: 1152,
      byte_size: 900_000,
      kind: "garment_original",
    };
    billing.quoteGeneration.mockImplementation(async ({ operation }) => ({
      credits: 12,
      available: 50,
      reserved: 0,
      sufficient: true,
      operation,
      lifecycle: "Experimental",
      provider: "huggingface",
      providerModel: operation === "video" ? "Wan-AI/Wan2.2-I2V-A14B" : "Qwen/Qwen-Image-Edit",
      priceRuleId: ids.rule,
    }));
    billing.reserveGeneration.mockResolvedValue({ id: "job", status: "queued" });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("requires the third-party processing acknowledgement before reserving credits", async () => {
    await expect(quoteAndSubmit(photo, {})).rejects.toMatchObject({
      status: 422,
      code: "PROCESSING_ACKNOWLEDGEMENT_REQUIRED",
    });
    await expect(
      quoteAndSubmit(photo, { processingAcknowledgement: "2020-01-01-outdated" }),
    ).rejects.toMatchObject({ code: "PROCESSING_ACKNOWLEDGEMENT_REQUIRED" });
    expect(billing.reserveGeneration).not.toHaveBeenCalled();
  });

  it("records the acknowledged disclosure version on the reserved job", async () => {
    await quoteAndSubmit(photo, { processingAcknowledgement: HF_PROCESSING_DISCLOSURE_VERSION });
    expect(billing.reserveGeneration).toHaveBeenCalledTimes(1);
    expect(billing.reserveGeneration.mock.calls[0][0]).toMatchObject({
      provider: "huggingface",
      idempotencyKey: "request-identifier-1",
      options: expect.objectContaining({
        direction: "faithful",
        seed: 1234,
        processingDisclosure: HF_PROCESSING_DISCLOSURE_VERSION,
      }),
    });
  });

  it("refuses new work while the shared free quota is exhausted, before quoting or reserving", async () => {
    state.quotaRefusals = 1;
    await expect(submitDesignerGeneration(photo, true)).rejects.toMatchObject({
      status: 503,
      code: "PROVIDER_QUOTA_EXHAUSTED",
    });
    expect(billing.quoteGeneration).not.toHaveBeenCalled();
    expect(billing.reserveGeneration).not.toHaveBeenCalled();
  });

  it.each([
    [720, 1280],
    [1400, 600],
    [400, 600],
  ])("rejects a %ix%i video source rather than letting the model crop it", async (w, h) => {
    state.asset = { ...state.asset, width: w, height: h };
    await expect(submitDesignerGeneration(video(), true)).rejects.toMatchObject({
      status: 422,
      code: "SOURCE_INCOMPATIBLE",
    });
    expect(billing.quoteGeneration).not.toHaveBeenCalled();
  });

  it("accepts a portrait source and quotes only the 5-second preset clip", async () => {
    await expect(submitDesignerGeneration(video(), true)).resolves.toMatchObject({
      quote: { provider: "huggingface", credits: 12 },
    });
    await expect(
      submitDesignerGeneration(video({ motion: "a fast spin and an outfit change" }), true),
    ).rejects.toMatchObject({ code: "OPTION_UNSUPPORTED" });
    await expect(submitDesignerGeneration(video({ duration: 10 }), true)).rejects.toMatchObject({
      code: "OPTION_UNSUPPORTED",
    });
  });

  it("never lets a browser choose a provider, Space or inference URL", async () => {
    for (const extra of [
      { provider: "fashn" },
      { space: "attacker/space" },
      { endpoint: "https://attacker.example/infer" },
    ])
      await expect(submitDesignerGeneration({ ...photo, ...extra }, true)).rejects.toThrow();
    // Unknown option keys never reach the provider prompt.
    const quoted = (await submitDesignerGeneration(
      { ...photo, options: { ...photo.options, spaceUrl: "https://attacker.example" } },
      true,
    )) as { quote: { provider: string } };
    expect(quoted.quote.provider).toBe("huggingface");
    expect(billing.quoteGeneration.mock.calls.at(-1)![0].options).not.toHaveProperty("spaceUrl");
  });
});
