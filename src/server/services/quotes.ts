import "server-only";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { ApiError, constantTimeEqual, hashToken } from "@/server/auth/security";

const schema = z
  .object({
    organizationId: z.string().uuid(),
    actorId: z.string().uuid(),
    operation: z.enum(["photo", "video", "try_on"]),
    provider: z.enum(["qwen", "fashn", "huggingface"]),
    providerModel: z.string().min(1).max(160),
    garmentId: z.string().uuid().nullable(),
    sourceAssetId: z.string().uuid().nullable(),
    optionsHash: z.string().length(64),
    credits: z.number().int().positive(),
    priceRuleId: z.string().uuid(),
    expiresAt: z.number().int().positive(),
  })
  .strict();
type QuotePayload = z.infer<typeof schema>;
export type QuoteContext = Pick<
  QuotePayload,
  | "organizationId"
  | "actorId"
  | "operation"
  | "garmentId"
  | "sourceAssetId"
  | "provider"
  | "providerModel"
> & { options: Record<string, unknown> };

function optionsHash(options: Record<string, unknown>) {
  return hashToken(
    JSON.stringify(
      Object.fromEntries(Object.entries(options).sort(([a], [b]) => a.localeCompare(b))),
    ),
  );
}
function sign(value: string) {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw new ApiError(503, "Price confirmation is not configured.", "NOT_CONFIGURED");
  return createHmac("sha256", secret)
    .update(`atelier-generation-quote:v1.${value}`)
    .digest("base64url");
}

export function createQuoteToken(
  context: QuoteContext,
  quote: { credits: number; priceRuleId: string },
) {
  const { options, ...fields } = context;
  const payload = schema.parse({
    ...fields,
    optionsHash: optionsHash(options),
    credits: quote.credits,
    priceRuleId: quote.priceRuleId,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });
  const value = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${value}.${sign(value)}`;
}

export function verifyQuoteToken(token: string | undefined, context: QuoteContext) {
  if (!token || token.length > 4096)
    throw new ApiError(409, "Review a current price quote before generating.", "QUOTE_REQUIRED");
  const parts = token.split(".");
  if (
    parts.length !== 2 ||
    !/^[A-Za-z0-9_-]+$/.test(parts[0]) ||
    !constantTimeEqual(parts[1], sign(parts[0]))
  )
    throw new ApiError(
      409,
      "The price confirmation is invalid. Review the cost again.",
      "QUOTE_INVALID",
    );
  let payload: QuotePayload;
  try {
    payload = schema.parse(JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")));
  } catch {
    throw new ApiError(
      409,
      "The price confirmation is invalid. Review the cost again.",
      "QUOTE_INVALID",
    );
  }
  if (payload.expiresAt <= Date.now())
    throw new ApiError(
      409,
      "This price quote has expired. Review the cost again.",
      "QUOTE_EXPIRED",
    );
  const { options, ...fields } = context;
  if (
    Object.entries(fields).some(([key, value]) => payload[key as keyof QuotePayload] !== value) ||
    payload.optionsHash !== optionsHash(options)
  )
    throw new ApiError(
      409,
      "The garment or generation settings changed. Review the cost again.",
      "QUOTE_CHANGED",
    );
  return payload;
}
