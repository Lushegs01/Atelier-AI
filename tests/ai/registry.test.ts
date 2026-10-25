import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProviderForJob,
  getActiveProviderId,
  getProviderCapabilities,
  QWEN_MODEL,
} from "@/server/ai/registry";
import { getQwenEndpoint, getQwenOutputRequest } from "@/server/ai/endpoint";

const requestId = "467219f3-84c1-4423-a709-2d68ed8f10de";
const fixtureEnvironment = {
  NODE_ENV: "test",
  QWEN_API_URL: "https://gpu.example.test/private",
  QWEN_API_KEY: "synthetic-service-credential-00000000000000",
};

afterEach(() => vi.unstubAllEnvs());
describe("provider selection and pinning", () => {
  it("defaults to Qwen without silently enabling a paid fallback", () => {
    vi.stubEnv("AI_PROVIDER", "");
    vi.stubEnv("QWEN_API_URL", "");
    vi.stubEnv("QWEN_API_KEY", "");
    vi.stubEnv("FASHN_API_KEY", "synthetic-key");
    vi.stubEnv("ENABLE_PHOTO_GENERATION", "true");
    expect(getActiveProviderId()).toBe("qwen");
    expect(getProviderCapabilities().every((capability) => !capability.enabled)).toBe(true);
  });
  it("enables only the explicitly configured Qwen still-image capabilities", () => {
    vi.stubEnv("AI_PROVIDER", "qwen");
    vi.stubEnv("QWEN_API_URL", fixtureEnvironment.QWEN_API_URL);
    vi.stubEnv("QWEN_API_KEY", fixtureEnvironment.QWEN_API_KEY);
    vi.stubEnv("ENABLE_PHOTO_GENERATION", "true");
    vi.stubEnv("ENABLE_TRY_ON", "false");
    vi.stubEnv("ENABLE_VIDEO_GENERATION", "true");
    expect(getProviderCapabilities().map(({ operation, enabled }) => [operation, enabled])).toEqual(
      [
        ["photo", true],
        ["try_on", false],
        ["video", false],
      ],
    );
  });
  it("retains historical FASHN jobs after selecting Qwen", () => {
    vi.stubEnv("AI_PROVIDER", "qwen");
    const provider = createProviderForJob({
      provider: "fashn",
      provider_model: "product-to-model",
      operation: "photo",
    });
    expect(provider.constructor.name).toBe("FashnProvider");
  });
  it("rejects unknown or mismatched pinned models rather than rerouting", () => {
    expect(() =>
      createProviderForJob({ provider: "fashn", provider_model: QWEN_MODEL, operation: "photo" }),
    ).toThrow("pinned provider model");
    expect(() => createProviderForJob({ provider: "other", operation: "photo" })).toThrow(
      "unknown provider",
    );
    expect(() =>
      createProviderForJob({ provider: "qwen", provider_model: QWEN_MODEL, operation: "video" }),
    ).toThrow("does not support video");
  });
});

describe("private GPU endpoint and credential boundary", () => {
  it("allows an operator-configured HTTPS origin and optional path prefix", () => {
    expect(getQwenEndpoint(fixtureEnvironment).origin).toBe("https://gpu.example.test");
    expect(
      getQwenOutputRequest(
        `https://gpu.example.test/private/v1/jobs/${requestId}/output`,
        requestId,
        fixtureEnvironment,
      ).headers.Authorization,
    ).toBe(`Bearer ${fixtureEnvironment.QWEN_API_KEY}`);
  });
  it.each([
    "https://evil.test/v1/jobs/id/output",
    `https://gpu.example.test/private/v1/jobs/${requestId}/output?redirect=evil`,
    `https://gpu.example.test/private/v1/jobs/${requestId}/output#fragment`,
    `https://gpu.example.test/other/v1/jobs/${requestId}/output`,
    `https://gpu.example.test/private/v1/jobs/${requestId}/output/`,
  ])("does not send credentials to substituted output %s", (value) => {
    expect(() => getQwenOutputRequest(value, requestId, fixtureEnvironment)).toThrow(
      "Untrusted Qwen output",
    );
  });
  it("does not accept another job's result or credentials embedded in configuration", () => {
    expect(() =>
      getQwenOutputRequest(
        `https://gpu.example.test/private/v1/jobs/11111111-1111-1111-1111-111111111111/output`,
        requestId,
        fixtureEnvironment,
      ),
    ).toThrow();
    expect(() =>
      getQwenEndpoint({
        ...fixtureEnvironment,
        QWEN_API_URL: "https://user:password@gpu.example.test",
      }),
    ).toThrow();
  });
  it("permits cleartext only for an explicitly enabled local development endpoint", () => {
    expect(() =>
      getQwenEndpoint({ ...fixtureEnvironment, QWEN_API_URL: "http://localhost:8000" }),
    ).toThrow();
    expect(
      getQwenEndpoint({
        ...fixtureEnvironment,
        QWEN_API_URL: "http://localhost:8000",
        QWEN_ALLOW_INSECURE_LOCAL: "true",
      }).protocol,
    ).toBe("http:");
    expect(() =>
      getQwenEndpoint({
        ...fixtureEnvironment,
        NODE_ENV: "production",
        QWEN_API_URL: "http://localhost:8000",
        QWEN_ALLOW_INSECURE_LOCAL: "true",
      }),
    ).toThrow();
    expect(() =>
      getQwenEndpoint({
        ...fixtureEnvironment,
        QWEN_API_URL: "http://192.168.1.9:8000",
        QWEN_ALLOW_INSECURE_LOCAL: "true",
      }),
    ).toThrow();
  });
});
