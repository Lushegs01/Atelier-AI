import { afterEach, describe, expect, it, vi } from "vitest";
import { probeQwenReadiness } from "@/server/services/provider-readiness";

afterEach(() => vi.unstubAllEnvs());
describe("Qwen readiness probe without inference (test doubles)", () => {
  function configure() {
    vi.stubEnv("QWEN_API_URL", "https://gpu.example.test/private");
    vi.stubEnv("QWEN_API_KEY", "synthetic-private-service-bearer-key-123456");
  }
  it("authenticates to /ready and requires the exact loaded model", async () => {
    configure();
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ status: "ready", ready: true, model: "Qwen/Qwen-Image-Edit-2511" }),
      );
    expect(await probeQwenReadiness(transport)).toEqual({ checked: true, ready: true });
    expect(transport).toHaveBeenCalledWith(
      "https://gpu.example.test/private/ready",
      expect.objectContaining({
        redirect: "error",
        cache: "no-store",
        headers: { Authorization: "Bearer synthetic-private-service-bearer-key-123456" },
      }),
    );
    expect(transport.mock.calls[0][1]?.method).toBeUndefined();
  });
  it.each([
    { status: "ready", ready: true, model: "other-model" },
    { status: "not_ready", ready: false, model: "Qwen/Qwen-Image-Edit-2511" },
  ])("fails closed for a mismatched or unloaded model", async (body) => {
    configure();
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));
    expect(await probeQwenReadiness(transport)).toEqual({ checked: true, ready: false });
  });
  it("redacts transport errors and oversized upstream bodies", async () => {
    configure();
    const failure = vi.fn<typeof fetch>().mockRejectedValue(new Error("secret-token/private-host"));
    expect(await probeQwenReadiness(failure)).toEqual({ checked: true, ready: false });
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response("x".repeat(5000)));
    expect(await probeQwenReadiness(large)).toEqual({ checked: true, ready: false });
  });
});
