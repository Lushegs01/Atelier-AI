import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  normalizeGenerationOptions,
  normalizeProviderGenerationOptions,
  paymentDomain,
  pricingOptionKey,
  validateVerifiedPayment,
  verifyPaystackSignature,
} from "@/server/billing/domain";

const expected = {
  reference: "atelier-fixture",
  amount_kobo: 1500000,
  currency: "NGN",
  expected_domain: "test" as const,
  buyer_email: "owner@example.test",
};
const valid = {
  id: 9001,
  reference: expected.reference,
  amount: expected.amount_kobo,
  currency: "NGN",
  domain: "test",
  status: "success",
  customer: { email: "owner@example.test" },
};

describe("Paystack boundary validation", () => {
  it("validates the documented HMAC SHA512 over raw bytes", () => {
    const body = '{"event":"charge.success","data":{"reference":"fixture"}}';
    const secret = "fixture-test-secret";
    const signature = createHmac("sha512", secret).update(body).digest("hex");
    expect(verifyPaystackSignature(body, signature, secret)).toBe(true);
    expect(verifyPaystackSignature(`${body} `, signature, secret)).toBe(false);
    expect(verifyPaystackSignature(body, "ff", secret)).toBe(false);
    expect(verifyPaystackSignature(body, null, secret)).toBe(false);
  });
  it("requires successful verified transaction data and exact integer money", () => {
    expect(validateVerifiedPayment(expected, valid).id).toBe(9001);
    expect(() => validateVerifiedPayment(expected, { ...valid, status: "pending" })).toThrow(
      /not succeeded/i,
    );
    expect(() => validateVerifiedPayment(expected, { ...valid, amount: 1 })).toThrow(/mismatch/i);
    expect(() => validateVerifiedPayment(expected, { ...valid, amount: 1500000.5 })).toThrow();
  });
  it.each(["reference", "currency", "domain", "customer"] as const)(
    "rejects %s mismatches",
    (field) => {
      const mismatched = {
        ...valid,
        [field]:
          field === "customer"
            ? { email: "other@example.test" }
            : field === "domain"
              ? "live"
              : "bad-value",
      };
      expect(() => validateVerifiedPayment(expected, mismatched)).toThrow(/mismatch/i);
    },
  );
  it("requires explicit live authorization and valid key prefixes", () => {
    expect(paymentDomain("sk_test_fixture", false)).toBe("test");
    expect(() => paymentDomain("sk_live_fixture", false)).toThrow();
    expect(paymentDomain("sk_live_fixture", true)).toBe("live");
    expect(() => paymentDomain("invented-key", true)).toThrow();
  });
});

describe("server owned generation pricing", () => {
  it("rejects unpriced Qwen JPEG and video options before reservation", () => {
    expect(() =>
      normalizeProviderGenerationOptions("qwen", "photo", { outputFormat: "jpeg" }),
    ).toThrow(/balanced 1K PNG/);
    expect(() => normalizeProviderGenerationOptions("qwen", "video", {})).toThrow(/still images/);
    expect(normalizeProviderGenerationOptions("qwen", "try_on", {})).toMatchObject({
      resolution: "1k",
      quality: "balanced",
      outputFormat: "png",
      numImages: 1,
    });
  });
  it("normalizes release image settings to balanced 1k and one image", () => {
    expect(normalizeGenerationOptions("photo", {})).toEqual({
      resolution: "1k",
      quality: "balanced",
      outputFormat: "png",
      numImages: 1,
    });
    expect(pricingOptionKey("photo", { scene: "Soft daylight" })).toBe("default");
  });
  it("rejects expensive unpriced provider options and browser supplied prices", () => {
    expect(() => normalizeGenerationOptions("photo", { quality: "quality" })).toThrow();
    expect(() => normalizeGenerationOptions("photo", { resolution: "4k" })).toThrow();
    expect(() => normalizeGenerationOptions("try_on", { numImages: 5 })).toThrow();
    expect(() => normalizeGenerationOptions("video", { credits: 1 })).toThrow();
  });
  it("maps every supported video duration and resolution to its own price", () => {
    for (const duration of [5, 10])
      for (const resolution of ["480p", "720p", "1080p"]) {
        expect(pricingOptionKey("video", { duration, resolution })).toBe(
          `${duration}:${resolution}`,
        );
      }
    expect(() => normalizeGenerationOptions("video", { duration: 120 })).toThrow();
  });
});
