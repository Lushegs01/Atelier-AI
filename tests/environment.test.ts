import { describe, expect, it } from "vitest";
import { environmentReadiness, parseEnvironment } from "@/lib/env";
import { scrubMonitoringText } from "@/lib/monitoring";
describe("release configuration", () => {
  it("cannot silently run production with demo mode or missing auth", () => {
    const state = environmentReadiness({ NODE_ENV: "production", NEXT_PUBLIC_DEMO_MODE: "true" });
    expect(state.ready).toBe(false);
    expect(state.missing).toContain("DEMO_MODE_MUST_BE_DISABLED");
    expect(state.missing).toContain("HTTPS_APP_URL");
  });
  it("keeps unverified model capabilities off by default", () => {
    const env = parseEnvironment({});
    expect(env.ENABLE_PHOTO_GENERATION).toBe(false);
    expect(env.ENABLE_VIDEO_GENERATION).toBe(false);
    expect(env.ENABLE_TRY_ON).toBe(false);
    expect(env.AI_PROVIDER).toBe("qwen");
  });
  it("does not require FASHN credentials when Qwen is selected", () => {
    const state = environmentReadiness({
      NODE_ENV: "test",
      ENABLE_PHOTO_GENERATION: "true",
      AI_PROVIDER: "qwen",
    });
    expect(state.missing).toContain("QWEN_API_URL");
    expect(state.missing).toContain("QWEN_API_KEY");
    expect(state.missing).not.toContain("FASHN_API_KEY");
  });
  it("rejects unsupported Qwen video and insecure production service endpoints", () => {
    const state = environmentReadiness({
      NODE_ENV: "production",
      AI_PROVIDER: "qwen",
      ENABLE_VIDEO_GENERATION: "true",
      QWEN_API_URL: "http://localhost:8000",
      QWEN_ALLOW_INSECURE_LOCAL: "true",
    });
    expect(state.missing).toContain("QWEN_VIDEO_UNSUPPORTED");
    expect(state.missing).toContain("QWEN_HTTPS_ENDPOINT_REQUIRED");
  });
  it("rejects malformed flags and oversized upload configuration", () => {
    expect(() => parseEnvironment({ ENABLE_TRY_ON: "yes" })).toThrow();
    expect(() => parseEnvironment({ MAX_UPLOAD_BYTES: "9999999999" })).toThrow();
  });
  it("scrubs guest and callback tokens from telemetry", () => {
    const token = "x".repeat(43);
    expect(
      scrubMonitoringText(
        `/try/${token} /api/try-on/${token} https://example.com/auth/callback?code=abc`,
      ),
    ).not.toContain(token);
    expect(scrubMonitoringText("https://example.com/auth/callback?code=abc")).not.toContain("abc");
  });
});
