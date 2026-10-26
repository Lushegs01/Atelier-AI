import { describe, expect, it } from "vitest";
import {
  operationAvailability,
  providerDisclosure,
  type WorkspaceCapability,
  failureExplanation,
  jobStatusLabel,
} from "@/features/workspace/provider";

describe("provider-aware interface contract", () => {
  it("cannot enable Qwen video even with a contradictory capability record", () => {
    const capabilities: WorkspaceCapability[] = [
      { operation: "video", enabled: true, lifecycle: "Experimental", provider: "qwen" },
    ];
    const availability = operationAvailability("video", capabilities, {
      id: "qwen",
      label: "Qwen Image Edit",
    });
    expect(availability.enabled).toBe(false);
    expect(availability.reason).toContain("does not generate video");
  });
  it("uses server capabilities and defaults missing operations to unavailable", () => {
    expect(operationAvailability("photo", []).enabled).toBe(false);
    expect(
      operationAvailability("try_on", [
        {
          operation: "try_on",
          enabled: false,
          lifecycle: "Experimental",
          reason: "Customer image editing requires acceptance.",
        },
      ]).reason,
    ).toContain("requires acceptance");
    expect(
      operationAvailability("photo", [
        { operation: "photo", enabled: true, lifecycle: "Experimental" },
      ]).enabled,
    ).toBe(true);
  });
  it("discloses the supplied actual provider without inventing free compute or fit guarantees", () => {
    expect(
      providerDisclosure({
        id: "qwen",
        label: "Qwen",
        disclosure: "Operator-specific private GPU disclosure.",
      }),
    ).toBe("Operator-specific private GPU disclosure.");
    expect(providerDisclosure({ id: "qwen", label: "Qwen" })).toContain(
      "not a validated fitting system",
    );
    expect(providerDisclosure({ id: "fashn", label: "FASHN" })).toContain("third-party");
    expect(providerDisclosure({ id: "huggingface", label: "Hugging Face" })).toMatch(
      /public Hugging Face Space run by a third party.*not a private environment/,
    );
    expect(providerDisclosure()).toContain("must be identified");
  });
});

describe("generation state wording", () => {
  it("distinguishes quota exhaustion, outages, timeouts and unusable output", () => {
    expect(failureExplanation("provider_quota_exceeded")).toMatchObject({ category: "quota" });
    expect(failureExplanation("provider_quota_cooldown")).toMatchObject({ category: "quota" });
    for (const code of ["provider_busy", "provider_starting", "provider_http_503"])
      expect(failureExplanation(code).category).toBe("unavailable");
    for (const code of ["provider_timeout", "provider_result_unavailable"])
      expect(failureExplanation(code).category).toBe("timeout");
    for (const code of ["provider_invalid_output", "provider_output_expired"])
      expect(failureExplanation(code).category).toBe("output");
    expect(failureExplanation("something-new").category).toBe("failed");
    expect(failureExplanation(null).category).toBe("failed");
  });

  it("labels every lifecycle state without inventing progress", () => {
    const labels = [
      { status: "queued" },
      { status: "submitting" },
      { status: "processing" },
      { status: "retry_wait", error_code: "provider_starting" },
      { status: "succeeded" },
      { status: "failed", error_code: "provider_quota_exceeded" },
      { status: "failed", error_code: "provider_unavailable" },
      { status: "failed", error_code: "provider_timeout" },
    ].map(jobStatusLabel);
    expect(labels).toEqual([
      "Waiting to start",
      "Sending to provider",
      "Processing",
      "Provider starting up",
      "Completed",
      "Quota exhausted",
      "Temporarily unavailable",
      "Failed",
    ]);
    expect(labels.join(" ")).not.toMatch(/%/);
  });
});
