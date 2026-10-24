import "server-only";
import { z } from "zod";
import { paymentDomain } from "./domain";

const initializationSchema = z.object({
  status: z.literal(true),
  data: z.object({
    authorization_url: z.url(),
    access_code: z.string(),
    reference: z.string(),
  }),
});

export class PaystackProvider {
  readonly domain: "test" | "live";
  constructor(
    private readonly secret: string,
    allowLive = false,
    private readonly transport: typeof fetch = fetch,
  ) {
    this.domain = paymentDomain(secret, allowLive);
  }
  private async request(path: string, body?: unknown) {
    const response = await this.transport(`https://api.paystack.co/${path}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${this.secret}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error("Payment provider temporarily unavailable.");
    return response.json() as Promise<unknown>;
  }
  async initialize(input: {
    email: string;
    amount: number;
    currency: string;
    reference: string;
    callbackUrl: string;
    organizationId: string;
  }) {
    const result = initializationSchema.parse(
      await this.request("transaction/initialize", {
        email: input.email,
        amount: String(input.amount),
        currency: input.currency,
        reference: input.reference,
        callback_url: input.callbackUrl,
        metadata: { organization_id: input.organizationId },
      }),
    );
    const checkout = new URL(result.data.authorization_url);
    if (
      checkout.protocol !== "https:" ||
      checkout.hostname !== "checkout.paystack.com" ||
      result.data.reference !== input.reference
    ) {
      throw new Error("Invalid payment checkout response.");
    }
    return { authorizationUrl: result.data.authorization_url, reference: result.data.reference };
  }
  async verify(reference: string) {
    const result = z
      .object({ status: z.literal(true), data: z.unknown() })
      .parse(await this.request(`transaction/verify/${encodeURIComponent(reference)}`));
    return result.data;
  }
  async createRefund(input: {
    reference: string;
    amount: number;
    currency: string;
    reason: string;
  }) {
    return z
      .object({
        status: z.literal(true),
        data: z.object({
          id: z.union([z.number().int().positive(), z.string().min(1)]),
          status: z.string(),
          amount: z.number().int().positive(),
          currency: z.string(),
          domain: z.enum(["test", "live"]),
        }),
      })
      .parse(
        await this.request("refund", {
          transaction: input.reference,
          amount: input.amount,
          currency: input.currency,
          merchant_note: input.reason,
          customer_note: "Atelier AI credit purchase refund",
        }),
      ).data;
  }
  async fetchRefund(id: string) {
    return z
      .object({
        status: z.literal(true),
        data: z.object({
          id: z.union([z.number().int().positive(), z.string().min(1)]),
          status: z.string(),
          amount: z.number().int().positive(),
          currency: z.string(),
          domain: z.enum(["test", "live"]),
          transaction: z.union([
            z.number().int().positive(),
            z.string().min(1),
            z.object({
              id: z.union([z.number().int().positive(), z.string().min(1)]),
              reference: z.string().optional(),
            }),
          ]),
        }),
      })
      .parse(await this.request(`refund/${encodeURIComponent(id)}`)).data;
  }
}
