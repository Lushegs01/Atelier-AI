import { describe, expect, it } from "vitest";
import {
  operationAvailability,
  providerDisclosure,
  type WorkspaceCapability,
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
    expect(providerDisclosure({ id: "huggingface", label: "Hugging Face" })).toContain(
      "Hugging Face Spaces",
    );
    expect(providerDisclosure()).toContain("must be identified");
  });
});
