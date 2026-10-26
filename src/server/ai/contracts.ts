import { z } from "zod";

export const generationOperationSchema = z.enum(["photo", "video", "try_on"]);
export type GenerationOperation = z.infer<typeof generationOperationSchema>;

/**
 * Prompt presets for the same image-editing model. They change the written direction only; they
 * are not separate model capabilities.
 */
export const photoDirectionSchema = z.enum(["faithful", "editorial", "lifestyle", "product"]);
/** Restrained motion presets for image-to-video; garment consistency is never guaranteed. */
export const motionPresetSchema = z.enum(["subtle", "fabric", "camera"]);

export const imageOptionsSchema = z.object({
  direction: photoDirectionSchema.default("editorial"),
  scene: z.string().max(300).default("Soft daylight photography studio"),
  model: z.string().max(200).default("Adult fashion model"),
  pose: z.string().max(150).default("Natural standing pose"),
  aspectRatio: z
    .enum(["1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2", "4:5", "5:4"])
    .default("3:4"),
  resolution: z.enum(["1k", "2k", "4k"]).default("1k"),
  quality: z.enum(["fast", "balanced", "quality"]).default("balanced"),
  outputFormat: z.enum(["png", "jpeg"]).default("png"),
  seed: z.number().int().min(0).max(4_294_967_295).default(42),
  // This release deliberately supports one output per paid request.
  numImages: z.literal(1).default(1),
});

export const videoOptionsSchema = z.object({
  duration: z.union([z.literal(5), z.literal(10)]).default(5),
  resolution: z.enum(["480p", "720p", "1080p"]).default("1080p"),
  motion: z.string().max(180).default(""),
  motionPreset: motionPresetSchema.default("subtle"),
  seed: z.number().int().min(0).max(4_294_967_295).default(42),
});

export const tryOnOptionsSchema = z.object({
  resolution: z.enum(["1k", "2k", "4k"]).default("1k"),
  quality: z.enum(["fast", "balanced", "quality"]).default("balanced"),
  outputFormat: z.enum(["png", "jpeg"]).default("png"),
  seed: z.number().int().min(0).max(4_294_967_295).default(42),
  numImages: z.literal(1).default(1),
  tryOnSessionId: z.string().uuid().optional(),
});

export type ImageOptions = z.infer<typeof imageOptionsSchema>;
export type VideoOptions = z.infer<typeof videoOptionsSchema>;
export type TryOnOptions = z.infer<typeof tryOnOptionsSchema>;

export type ProviderState = "starting" | "in_queue" | "processing" | "completed" | "failed";
export interface Prediction {
  id: string;
  status: ProviderState;
  outputs: string[];
  creditsUsed?: number;
  errorCode?: string;
  /** Short, sanitized provider explanation for operators; never contains URLs or markup. */
  errorDetail?: string;
}

export interface ProviderCapability {
  provider?: "fashn" | "qwen" | "huggingface";
  operation: GenerationOperation;
  model: string;
  lifecycle: "Preview" | "Experimental";
  enabled: boolean;
  minInputDimension: number;
  supportedViews: readonly string[];
  /** Option values the provider can honour. Absent means every schema value is supported. */
  supportedResolutions?: readonly string[];
  supportedDurations?: readonly number[];
  /**
   * Accepted width/height range of the primary photograph (garment for photos, start frame for
   * video, person for try-on). Outside it the provider would crop or distort the image.
   */
  minAspectRatio?: number;
  maxAspectRatio?: number;
  /** False when only server-owned motion presets are accepted for video. */
  freeTextMotion?: boolean;
  reason?: string;
  notes?: string;
}

export interface GenerationContext {
  /** Stable application job UUID; self-hosted services use this to deduplicate submissions. */
  requestId: string;
  /** Garment category, for adapters whose try-on weights differ by garment type. */
  garmentCategory?: string;
  /** Submission attempt; adapters with caller-chosen receipts derive a distinct one per attempt. */
  attempt?: number;
}

export interface FashionProvider {
  generateFashionImage(
    source: string,
    options: ImageOptions,
    context?: GenerationContext,
  ): Promise<{ id: string }>;
  generateFashionVideo(
    source: string,
    options: VideoOptions,
    context?: GenerationContext,
  ): Promise<{ id: string }>;
  generateVirtualTryOn(
    product: string,
    person: string,
    options: TryOnOptions,
    context?: GenerationContext,
  ): Promise<{ id: string }>;
  getGenerationStatus(id: string): Promise<Prediction>;
  getProviderCapabilities(): ProviderCapability[];
  /** Available only for operator-controlled services that can purge retained inputs/results. */
  deleteGeneration?(id: string): Promise<void>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable = false,
    public readonly ambiguous = false,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export function requireEnabledCapability(
  capabilities: ProviderCapability[],
  operation: GenerationOperation,
): ProviderCapability {
  const capability = capabilities.find((item) => item.operation === operation);
  if (!capability?.enabled)
    throw new ProviderError(
      "This generation capability is unavailable. The workspace owner must configure and enable it.",
      "capability_disabled",
    );
  return capability;
}

/** Returns a customer-safe explanation when the provider cannot honour a requested option. */
export function unsupportedOptionMessage(
  capability: ProviderCapability,
  options: { resolution?: string; duration?: number; motion?: string },
): string | null {
  if (capability.freeTextMotion === false && options.motion?.trim())
    return "The configured AI provider accepts the listed motion presets only.";
  if (
    options.resolution &&
    capability.supportedResolutions &&
    !capability.supportedResolutions.includes(options.resolution)
  )
    return `The configured AI provider supports ${capability.supportedResolutions.join(", ")} output only.`;
  if (
    options.duration !== undefined &&
    capability.supportedDurations &&
    !capability.supportedDurations.includes(options.duration)
  )
    return `The configured AI provider supports ${capability.supportedDurations.join(", ")}-second videos only.`;
  return null;
}

/** Returns a customer-safe explanation when a photograph's shape is unsuitable for the provider. */
export function sourceShapeMessage(
  capability: ProviderCapability,
  width: number,
  height: number,
): string | null {
  if (width < capability.minInputDimension || height < capability.minInputDimension)
    return `Choose a photograph at least ${capability.minInputDimension} pixels wide and high.`;
  const ratio = width / height;
  if (
    (capability.minAspectRatio !== undefined && ratio < capability.minAspectRatio - 1e-6) ||
    (capability.maxAspectRatio !== undefined && ratio > capability.maxAspectRatio + 1e-6)
  )
    return capability.operation === "try_on"
      ? "Use a portrait or square photograph of the person (taller than it is wide, up to 1:1)."
      : `Choose a photograph between ${formatRatio(capability.minAspectRatio)} and ${formatRatio(capability.maxAspectRatio)} (width:height). The model would otherwise crop away part of the garment.`;
  return null;
}

function formatRatio(value?: number) {
  return value === undefined ? "any" : `${Math.round(value * 100) / 100}:1`;
}

/** Provider billing units, not the customer's Atelier credit price. */
export function estimateProviderCredits(operation: GenerationOperation, raw: unknown): number {
  if (operation === "video") {
    const options = videoOptionsSchema.parse(raw);
    return { "480p": 1, "720p": 3, "1080p": 6 }[options.resolution] * (options.duration / 5);
  }
  const options =
    operation === "photo" ? imageOptionsSchema.parse(raw) : tryOnOptionsSchema.parse(raw);
  return (
    { fast: 1, balanced: 2, quality: 3 }[options.quality] +
    { "1k": 0, "2k": 1, "4k": 2 }[options.resolution]
  );
}
