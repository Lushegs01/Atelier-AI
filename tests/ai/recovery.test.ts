import { describe, expect, it } from "vitest";
import { retryDelaySeconds, submissionDecision } from "@/workers/policy";

describe("paid submission recovery policy", () => {
  const now = Date.parse("2026-10-24T12:00:00Z");
  it("resumes accepted predictions after worker restarts", () => {
    expect(submissionDecision({ status: "processing", provider_reference: "known-id" }, now)).toBe(
      "resume",
    );
    expect(submissionDecision({ status: "retry_wait", provider_reference: "known-id" }, now)).toBe(
      "resume",
    );
  });
  it("never resubmits an unknown outcome or expired submission lease", () => {
    expect(
      submissionDecision(
        { status: "retry_wait", provider_reference: null, error_code: "submission_ambiguous" },
        now,
      ),
    ).toBe("reconcile");
    expect(
      submissionDecision(
        { status: "submitting", provider_reference: null, lease_until: "2026-10-24T11:59:00Z" },
        now,
      ),
    ).toBe("reconcile");
  });
  it("waits while a different worker holds a valid submission lease", () => {
    expect(
      submissionDecision(
        { status: "submitting", provider_reference: null, lease_until: "2026-10-24T12:01:00Z" },
        now,
      ),
    ).toBe("wait");
  });
  it("permits only known unsubmitted jobs to claim and ignores terminal jobs", () => {
    expect(submissionDecision({ status: "queued", provider_reference: null }, now)).toBe("claim");
    expect(
      submissionDecision(
        { status: "retry_wait", provider_reference: null, error_code: "provider_http_429" },
        now,
      ),
    ).toBe("claim");
    for (const status of ["succeeded", "failed", "cancelled"])
      expect(submissionDecision({ status, provider_reference: "previous" }, now)).toBe("terminal");
  });
  it("uses bounded exponential backoff with jitter", () => {
    expect(retryDelaySeconds(0, () => 0)).toBe(15);
    expect(retryDelaySeconds(3, () => 0.9)).toBe(129);
    expect(retryDelaySeconds(100, () => 0.9)).toBeLessThanOrEqual(309);
  });
});
