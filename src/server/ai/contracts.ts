import { z } from "zod";

export const generationOperationSchema = z.enum(["photo", "video", "try_on"]);
export type GenerationOperation = z.infer<typeof generationOperationSchema>;

export const imageOptionsSchema = z.object({
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
}

export interface ProviderCapability {
  operation: GenerationOperation;
  model: string;
  lifecycle: "Preview" | "Experimental";
  enabled: boolean;
  minInputDimension: number;
  supportedViews: readonly string[];
}

export interface FashionProvider {
  generateFashionImage(source: string, options: ImageOptions): Promise<{ id: string }>;
  generateFashionVideo(source: string, options: VideoOptions): Promise<{ id: string }>;
  generateVirtualTryOn(
    product: string,
    person: string,
    options: TryOnOptions,
  ): Promise<{ id: string }>;
  getGenerationStatus(id: string): Promise<Prediction>;
  getProviderCapabilities(): ProviderCapability[];
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
