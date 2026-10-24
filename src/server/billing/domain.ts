import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const operationSchema = z.enum(["photo", "video", "try_on"]);
export type Operation = z.infer<typeof operationSchema>;
export class BillingError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code = "BILLING_ERROR",
  ) {
    super(message);
    this.name = "BillingError";
  }
}

export function safeBillingDatabaseError(message: string): Error {
  if (message.includes("Insufficient credits"))
    return new BillingError(
      402,
      "You do not have enough available credits.",
      "INSUFFICIENT_CREDITS",
    );
  if (message.includes("Daily spending limit"))
    return new BillingError(
      429,
      "Your workspace has reached its daily spending limit.",
      "SPENDING_LIMIT",
    );
  if (message.includes("Too many active generations"))
    return new BillingError(
      429,
      "Wait for an active generation to finish before starting another.",
      "CONCURRENCY_LIMIT",
    );
  if (message.includes("pricing not enabled"))
    return new BillingError(503, "Generation pricing is awaiting review.", "PRICING_DISABLED");
  if (message.includes("Try-on session unavailable"))
    return new BillingError(410, "This try-on link is no longer available.", "SESSION_UNAVAILABLE");
  if (message.includes("Consent required"))
    return new BillingError(
      422,
      "Your consent is required before processing this photograph.",
      "CONSENT_REQUIRED",
    );
  if (message.includes("Idempotency key reused"))
    return new BillingError(
      409,
      "This request key was already used for different settings. Start a new request.",
      "IDEMPOTENCY_CONFLICT",
    );
  if (message.includes("Price quote changed"))
    return new BillingError(
      409,
      "The generation price changed. Review a new quote before continuing.",
      "QUOTE_CHANGED",
    );
  return new Error("The billing transaction could not be completed.");
}
const imageOptionsSchema = z
  .object({
    scene: z.string().max(300).optional(),
    model: z.string().max(200).optional(),
    pose: z.string().max(200).optional(),
    prompt: z.string().max(500).optional(),
    aspectRatio: z
      .enum(["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9"])
      .optional(),
    resolution: z.literal("1k").default("1k"),
    quality: z.literal("balanced").default("balanced"),
    outputFormat: z.enum(["png", "jpeg"]).default("png"),
    seed: z.number().int().min(0).max(4_294_967_295).optional(),
    numImages: z.literal(1).default(1),
    tryOnSessionId: z.uuid().optional(),
  })
  .strict();
const videoOptionsSchema = z
  .object({
    duration: z.union([z.literal(5), z.literal(10)]).default(5),
    resolution: z.enum(["480p", "720p", "1080p"]).default("1080p"),
    motion: z.string().max(200).optional(),
    prompt: z.string().max(200).optional(),
  })
  .strict();

/** Customer prices are selected from a finite server-owned matrix. */
export function normalizeGenerationOptions(operation: Operation, input: unknown = {}) {
  return operation === "video" ? videoOptionsSchema.parse(input) : imageOptionsSchema.parse(input);
}
export function pricingOptionKey(operation: Operation, input: unknown = {}) {
  const options = normalizeGenerationOptions(operation, input);
  return operation === "video" && "duration" in options
    ? `${options.duration}:${options.resolution}`
    : "default";
}

export function verifyPaystackSignature(
  rawBody: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature || !/^[a-f0-9]{128}$/i.test(signature)) return false;
  const expected = createHmac("sha512", secret).update(rawBody).digest();
  const received = Buffer.from(signature, "hex");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export interface ExpectedPayment {
  reference: string;
  amount_kobo: number;
  currency: string;
  expected_domain: "test" | "live";
  buyer_email: string;
}
export const verifiedPaymentSchema = z.object({
  id: z.union([z.number().int().positive(), z.string().min(1)]),
  reference: z.string().min(1),
  amount: z.number().int().positive(),
  currency: z.string(),
  domain: z.enum(["test", "live"]),
  status: z.string(),
  customer: z.object({ email: z.email() }),
  receipt_number: z.string().nullable().optional(),
});
export type VerifiedPayment = z.infer<typeof verifiedPaymentSchema>;

export function validateVerifiedPayment(
  expected: ExpectedPayment,
  input: unknown,
): VerifiedPayment {
  const payment = verifiedPaymentSchema.parse(input);
  if (payment.status !== "success") throw new Error("Payment has not succeeded.");
  if (
    payment.reference !== expected.reference ||
    payment.amount !== expected.amount_kobo ||
    payment.currency !== expected.currency ||
    payment.domain !== expected.expected_domain ||
    payment.customer.email.toLowerCase() !== expected.buyer_email.toLowerCase()
  ) {
    throw new Error("Payment verification mismatch. No credits have been issued.");
  }
  return payment;
}

export function paymentDomain(secret: string, allowLive: boolean): "test" | "live" {
  if (secret.startsWith("sk_test_")) return "test";
  if (secret.startsWith("sk_live_") && allowLive) return "live";
  throw new Error("Paystack requires a test secret, or explicitly enabled live credentials.");
}
