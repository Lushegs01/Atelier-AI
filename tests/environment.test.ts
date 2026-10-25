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
  });
  it("requires the selected AI provider's credential before generation flags take effect", () => {
    const base = { ENABLE_TRY_ON: "true" };
    expect(parseEnvironment({}).AI_PROVIDER).toBe("huggingface");
    expect(environmentReadiness(base).missing).toContain("HF_TOKEN");
    expect(environmentReadiness({ ...base, HF_TOKEN: "hf_synthetic" }).missing).not.toContain(
      "HF_TOKEN",
    );
    const fashn = environmentReadiness({ ...base, AI_PROVIDER: "fashn", HF_TOKEN: "hf_synthetic" });
    expect(fashn.missing).toContain("FASHN_API_KEY");
    expect(() => parseEnvironment({ AI_PROVIDER: "replicate" })).toThrow();
    expect(() => parseEnvironment({ HF_TRY_ON_SPACE: "https://evil.test/space" })).toThrow();
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
