import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { query } = vi.hoisted(() => ({
  query: { select: vi.fn(), eq: vi.fn(), is: vi.fn(), maybeSingle: vi.fn() },
}));
vi.mock("@/lib/supabase/admin", () => ({ getAdminClient: () => ({ from: () => query }) }));
import { transferProviderOutput } from "@/server/storage/media";
const id = "467219f3-84c1-4423-a709-2d68ed8f10de";
const args = {
  organizationId: "organization",
  jobId: id,
  index: 0,
  isVideo: false,
  provider: "qwen" as const,
  providerReference: id,
};
describe("private Qwen output transfer (HTTP and database test doubles)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of ["select", "eq", "is"] as const) query[key].mockReturnValue(query);
    query.maybeSingle.mockResolvedValue({ data: null, error: null });
    vi.stubEnv("QWEN_API_URL", "https://gpu.example.test");
    vi.stubEnv("QWEN_API_KEY", "synthetic-service-key-00000000000000000");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  it("never fetches a substituted origin or another prediction's output", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    await expect(
      transferProviderOutput({ ...args, url: `https://attacker.test/v1/jobs/${id}/output` }),
    ).rejects.toThrow("Untrusted");
    await expect(
      transferProviderOutput({
        ...args,
        url: `https://gpu.example.test/v1/jobs/11111111-1111-1111-1111-111111111111/output`,
      }),
    ).rejects.toThrow("Untrusted");
    expect(request).not.toHaveBeenCalled();
  });
  it("authenticates only the exact configured output and forbids redirects and oversized streams", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(
        new Response("synthetic", { headers: { "Content-Length": String(31 * 1024 * 1024) } }),
      );
    vi.stubGlobal("fetch", request);
    await expect(
      transferProviderOutput({ ...args, url: `https://gpu.example.test/v1/jobs/${id}/output` }),
    ).rejects.toThrow("transfer limit");
    expect(request.mock.calls[0][1]).toMatchObject({
      headers: { Authorization: "Bearer synthetic-service-key-00000000000000000" },
      redirect: "error",
      cache: "no-store",
    });
  });
  it("does not send the private GPU credential to legacy FASHN delivery hosts", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(
        new Response("synthetic", { headers: { "Content-Length": String(31 * 1024 * 1024) } }),
      );
    vi.stubGlobal("fetch", request);
    await expect(
      transferProviderOutput({
        ...args,
        provider: "fashn",
        url: "https://cdn.fashn.ai/result.png",
      }),
    ).rejects.toThrow("transfer limit");
    expect(request.mock.calls[0][1].headers).toBeUndefined();
  });
});
