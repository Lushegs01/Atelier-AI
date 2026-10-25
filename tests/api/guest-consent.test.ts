import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  getSession: vi.fn(),
  upload: vi.fn(),
  reserve: vi.fn(),
  dispatch: vi.fn(),
  insert: vi.fn(),
  admin: vi.fn(),
}));
vi.mock("@/server/services/try-on", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/services/try-on")>()),
  getGuestSession: mock.getSession,
}));
vi.mock("@/server/services/generations", () => ({
  requireCapability: vi.fn(() => ({ provider: "qwen", minInputDimension: 256 })),
}));
vi.mock("@/server/ai/cleanup", () => ({ purgeQwenPrediction: vi.fn() }));
vi.mock("@/server/auth/context", () => ({ consumeRateLimit: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ getAdminClient: mock.admin }));
vi.mock("@/server/storage/media", () => ({
  uploadPrivateImage: mock.upload,
  deletePrivateAsset: vi.fn(),
  getAssetSignedUrl: vi.fn(),
}));
vi.mock("@/server/billing/service", () => ({ reserveGeneration: mock.reserve }));
vi.mock("@/workers/client", () => ({ dispatchGeneration: mock.dispatch }));
import { POST } from "@/app/api/try-on/[token]/route";
import { ApiError } from "@/server/auth/security";

const session = {
  id: "session-1",
  organization_id: "org-1",
  garment_id: "garment-1",
  provider: "qwen",
  provider_model: "Qwen/Qwen-Image-Edit-2511",
};
function request(consent?: string, version = "2026-10-25-qwen-v1") {
  const form = new FormData();
  form.append("file", new File(["synthetic-bytes"], "person.jpg", { type: "image/jpeg" }));
  if (consent) form.append("consent", consent);
  form.append("consentVersion", version);
  return new Request("https://atelier.test/api/try-on/token", {
    method: "POST",
    body: form,
    headers: { origin: "https://atelier.test" },
  });
}
const context = { params: Promise.resolve({ token: "a".repeat(43) }) };

describe("guest submission with explicit synthetic test doubles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("AI_PROVIDER", "qwen");
    mock.getSession.mockResolvedValue(session);
    mock.upload.mockResolvedValue({
      id: "customer-asset",
      width: 800,
      height: 1200,
      byte_size: 100,
    });
    mock.reserve.mockResolvedValue({
      id: "job-1",
      source_asset_id: "customer-asset",
      status: "queued",
    });
    mock.dispatch.mockResolvedValue(undefined);
    mock.insert.mockResolvedValue({ error: null });
    mock.admin.mockReturnValue({ from: () => ({ insert: mock.insert }) });
  });
  afterEach(() => vi.unstubAllEnvs());
  it("does not persist or send photos without current explicit consent", async () => {
    for (const [consent, version] of [
      [undefined, "2026-10-25-qwen-v1"],
      ["false", "2026-10-25-qwen-v1"],
      ["true", "old-version"],
      ["true", "2026-10-24-v1"],
    ]) {
      const response = await POST(request(consent, version), context);
      expect(response.status).toBe(422);
    }
    expect(mock.insert).not.toHaveBeenCalled();
    expect(mock.upload).not.toHaveBeenCalled();
    expect(mock.reserve).not.toHaveBeenCalled();
  });
  it("rejects expired, revoked and exhausted sessions before uploading", async () => {
    for (const code of ["LINK_EXPIRED", "LINK_REVOKED", "LINK_EXHAUSTED"]) {
      mock.getSession.mockRejectedValueOnce(new ApiError(410, "Session unavailable.", code));
      expect((await POST(request("true"), context)).status).toBe(410);
    }
    expect(mock.upload).not.toHaveBeenCalled();
  });
  it("rejects a provider change before consent, upload or credit reservation", async () => {
    vi.stubEnv("AI_PROVIDER", "fashn");
    const response = await POST(request("true"), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "PROVIDER_CHANGED" });
    expect(mock.insert).not.toHaveBeenCalled();
    expect(mock.upload).not.toHaveBeenCalled();
    expect(mock.reserve).not.toHaveBeenCalled();
  });
  it("records consent before private upload and atomically reserves before dispatch", async () => {
    const response = await POST(request("true"), context);
    expect(response.status).toBe(200);
    expect(mock.insert).toHaveBeenCalledWith(
      expect.objectContaining({ version: "2026-10-25-qwen-v1", try_on_session_id: "session-1" }),
    );
    expect(mock.upload).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-1", actorId: null, kind: "customer_photo" }),
    );
    expect(mock.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        actorId: null,
        tryOnSessionId: "session-1",
        sourceAssetId: "customer-asset",
        idempotencyKey: "tryon:session-1",
      }),
    );
    expect(mock.insert.mock.invocationCallOrder[0]).toBeLessThan(
      mock.upload.mock.invocationCallOrder[0],
    );
    expect(mock.reserve.mock.invocationCallOrder[0]).toBeLessThan(
      mock.dispatch.mock.invocationCallOrder[0],
    );
  });
  it("retains a committed job if immediate queue dispatch fails; outbox recovery owns retry", async () => {
    mock.dispatch.mockRejectedValue(new Error("network unavailable"));
    const response = await POST(request("true"), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ job: { id: "job-1", status: "queued" } });
    expect(mock.reserve).toHaveBeenCalledTimes(1);
  });
});
