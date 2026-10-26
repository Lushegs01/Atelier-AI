import "server-only";
import { z } from "zod";
import { requireTenant, consumeRateLimit } from "@/server/auth/context";
import { ApiError } from "@/server/auth/security";
import {
  generationOperationSchema,
  imageOptionsSchema,
  videoOptionsSchema,
  tryOnOptionsSchema,
  unsupportedOptionMessage,
  sourceShapeMessage,
} from "@/server/ai/contracts";
import { HF_PROCESSING_DISCLOSURE_VERSION } from "@/server/ai/huggingface";
import { getProviderCapabilities } from "@/server/ai/registry";
import { quoteGeneration, reserveGeneration } from "@/server/billing/service";
import { dispatchGeneration } from "@/workers/client";
import { assertDatabaseResult } from "./http";
import { createQuoteToken, verifyQuoteToken } from "./quotes";
import { assertProviderQuotaAvailable } from "./provider-health";

export const generationInputSchema = z
  .object({
    organizationId: z.string().uuid().optional(),
    operation: generationOperationSchema,
    garmentId: z.string().uuid().optional(),
    sourceAssetId: z.string().uuid().optional(),
    options: z.record(z.string(), z.unknown()).default({}),
    idempotencyKey: z.string().min(8).max(200).optional(),
    quoteToken: z.string().max(4096).optional(),
    /** Disclosure version the designer accepted before sending photographs to a public Space. */
    processingAcknowledgement: z.string().max(64).optional(),
  })
  .strict();

export function parseGenerationOptions(
  operation: z.infer<typeof generationOperationSchema>,
  value: unknown,
) {
  return operation === "photo"
    ? imageOptionsSchema.parse(value)
    : operation === "video"
      ? videoOptionsSchema.parse(value)
      : tryOnOptionsSchema.parse(value);
}

export function requireCapability(operation: z.infer<typeof generationOperationSchema>) {
  const capability = getProviderCapabilities().find((item) => item.operation === operation);
  if (!capability?.enabled)
    throw new ApiError(
      503,
      "This generation mode is not enabled yet. Configure the provider and review pricing first.",
      "CAPABILITY_DISABLED",
    );
  return capability;
}

export async function submitDesignerGeneration(raw: unknown, quoteOnly = false) {
  const input = generationInputSchema.parse(raw);
  if (input.operation === "try_on" && !quoteOnly)
    throw new ApiError(
      422,
      "Create a consent-based customer link to start a virtual try-on.",
      "CONSENT_LINK_REQUIRED",
    );
  const tenant = await requireTenant(input.organizationId, "create");
  const capability = requireCapability(input.operation);
  const options = parseGenerationOptions(input.operation, input.options);
  const unsupported = unsupportedOptionMessage(capability, options);
  if (unsupported) throw new ApiError(422, unsupported, "OPTION_UNSUPPORTED");
  if (capability.provider) await assertProviderQuotaAvailable(capability.provider);
  await consumeRateLimit(`generation:${tenant.organizationId}`, quoteOnly ? 60 : 15, 60);
  if (!input.garmentId && input.operation !== "video")
    throw new ApiError(422, "Select a garment first.", "GARMENT_REQUIRED");
  let sourceId = input.sourceAssetId;
  if (input.operation !== "video") {
    const { data: garment, error } = await tenant.client
      .from("garments")
      .select("id")
      .eq("organization_id", tenant.organizationId)
      .eq("id", input.garmentId)
      .is("deleted_at", null)
      .is("archived_at", null)
      .maybeSingle();
    assertDatabaseResult(error);
    if (!garment) throw new ApiError(404, "This garment is unavailable.", "NOT_FOUND");
    let assets = tenant.client
      .from("assets")
      .select("id,view,width,height,byte_size")
      .eq("organization_id", tenant.organizationId)
      .eq("garment_id", garment.id)
      .in("kind", ["original", "garment_original"])
      .in("view", [...capability.supportedViews])
      .gte("width", capability.minInputDimension)
      .gte("height", capability.minInputDimension)
      .is("deleted_at", null);
    if (capability.provider === "qwen") assets = assets.lte("byte_size", 4 * 1024 * 1024);
    if (sourceId) assets = assets.eq("id", sourceId);
    const { data: source, error: assetError } = await assets
      .order("created_at")
      .limit(1)
      .maybeSingle();
    assertDatabaseResult(assetError);
    if (!source)
      throw new ApiError(
        422,
        "Upload a front, mannequin, hanger, or flat-lay garment photograph.",
        "SOURCE_INCOMPATIBLE",
      );
    if (capability.provider === "qwen" && source.byte_size > 4 * 1024 * 1024)
      throw new ApiError(
        422,
        `Choose a source photograph at least ${capability.minInputDimension} pixels wide and high, up to 4 MB.`,
        "SOURCE_INCOMPATIBLE",
      );
    const shape = sourceShapeMessage(capability, source.width, source.height);
    if (shape) throw new ApiError(422, shape, "SOURCE_INCOMPATIBLE");
    sourceId = source.id;
  } else {
    if (!sourceId)
      throw new ApiError(422, "Choose an approved photograph to animate.", "SOURCE_REQUIRED");
    const { data: asset, error } = await tenant.client
      .from("assets")
      .select("id,width,height,kind,generation_job_id")
      .eq("organization_id", tenant.organizationId)
      .eq("id", sourceId)
      .is("deleted_at", null)
      .maybeSingle();
    assertDatabaseResult(error);
    if (
      !asset ||
      !["original", "garment_original", "generated_image"].includes(asset.kind) ||
      asset.width < 301 ||
      asset.height < 301
    )
      throw new ApiError(
        422,
        "Choose a compatible photograph at least 301 pixels wide and high.",
        "SOURCE_INCOMPATIBLE",
      );
    const shape = sourceShapeMessage(capability, asset.width, asset.height);
    if (shape) throw new ApiError(422, shape, "SOURCE_INCOMPATIBLE");
    if (asset.kind === "generated_image") {
      const { data: parent, error: parentError } = await tenant.client
        .from("generation_jobs")
        .select("operation,status")
        .eq("id", asset.generation_job_id)
        .eq("organization_id", tenant.organizationId)
        .maybeSingle();
      assertDatabaseResult(parentError);
      if (parent?.operation !== "photo" || parent.status !== "succeeded")
        throw new ApiError(
          422,
          "Customer try-on photographs cannot be used for campaign videos.",
          "CUSTOMER_REUSE_FORBIDDEN",
        );
      const { data: output } = await tenant.client
        .from("generation_outputs")
        .select("id,approved_at,rejected_at")
        .eq("organization_id", tenant.organizationId)
        .eq("asset_id", sourceId)
        .maybeSingle();
      if (!output?.approved_at || output.rejected_at)
        throw new ApiError(
          422,
          "Approve this generated photograph before creating a video.",
          "APPROVAL_REQUIRED",
        );
    }
  }
  const quote = await quoteGeneration({
    organizationId: tenant.organizationId,
    operation: input.operation,
    options,
  });
  const quoteContext = {
    organizationId: tenant.organizationId,
    actorId: tenant.user.id,
    operation: input.operation,
    garmentId: input.garmentId || null,
    sourceAssetId: sourceId || null,
    options,
    provider: quote.provider,
    providerModel: quote.providerModel,
  };
  if (quoteOnly)
    return {
      quote: {
        credits: quote.credits,
        available: quote.available,
        reserved: quote.reserved,
        sufficient: quote.sufficient,
        operation: quote.operation,
        lifecycle: quote.lifecycle,
        provider: quote.provider,
        providerModel: quote.providerModel,
      },
      quoteToken: createQuoteToken(quoteContext, quote),
      capabilities: getProviderCapabilities(),
    };
  if (!input.idempotencyKey)
    throw new ApiError(422, "A request identifier is required.", "IDEMPOTENCY_REQUIRED");
  const confirmed = verifyQuoteToken(input.quoteToken, quoteContext);
  // Public Spaces are third-party processors; the designer must acknowledge that before sending.
  const acknowledged =
    confirmed.provider === "huggingface"
      ? { processingDisclosure: HF_PROCESSING_DISCLOSURE_VERSION }
      : {};
  if (
    confirmed.provider === "huggingface" &&
    input.processingAcknowledgement !== HF_PROCESSING_DISCLOSURE_VERSION
  )
    throw new ApiError(
      422,
      "Review and accept the third-party processing notice before generating.",
      "PROCESSING_ACKNOWLEDGEMENT_REQUIRED",
    );
  const job = await reserveGeneration({
    organizationId: tenant.organizationId,
    actorId: tenant.user.id,
    operation: input.operation,
    garmentId: input.garmentId,
    sourceAssetId: sourceId,
    inputAssetIds: sourceId ? [sourceId] : [],
    options: { ...options, ...acknowledged },
    idempotencyKey: input.idempotencyKey,
    expectedCredits: confirmed.credits,
    expectedPriceRuleId: confirmed.priceRuleId,
    provider: confirmed.provider,
  });
  // The transactional outbox remains authoritative if event dispatch is unavailable.
  await dispatchGeneration(job.id, tenant.organizationId).catch(() => undefined);
  return { job };
}
