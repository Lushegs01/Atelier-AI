import "server-only";
import { z } from "zod";
import {
  FashionProvider,
  ImageOptions,
  VideoOptions,
  TryOnOptions,
  Prediction,
  ProviderCapability,
  ProviderError,
  requireEnabledCapability,
  imageOptionsSchema,
  videoOptionsSchema,
  tryOnOptionsSchema,
} from "./contracts";

const API = "https://api.fashn.ai/v1";
/** Documented output CDN origins; redirects are separately rejected. */
export const FASHN_OUTPUT_HOSTS = ["cdn.fashn.ai", "media.fashn.ai"] as const;
const predictionSchema = z.object({
  id: z.string().min(1).max(180),
  status: z.enum(["starting", "in_queue", "processing", "completed", "failed"]),
  output: z.array(z.string()).max(4).optional(),
  error: z.object({ name: z.string().optional(), message: z.string().optional() }).nullish(),
});
const submissionSchema = z.object({ id: z.string().min(1).max(180), error: z.unknown().nullish() });

export function getFashnCapabilities(): ProviderCapability[] {
  const configured = Boolean(process.env.FASHN_API_KEY);
  return [
    {
      operation: "photo",
      model: "product-to-model",
      lifecycle: "Preview",
      enabled: configured && process.env.ENABLE_PHOTO_GENERATION === "true",
      minInputDimension: 15,
      supportedViews: ["front", "mannequin", "hanger", "flat-lay"],
    },
    {
      operation: "try_on",
      model: "tryon-max",
      lifecycle: "Preview",
      enabled: configured && process.env.ENABLE_TRY_ON === "true",
      minInputDimension: 15,
      supportedViews: ["front", "mannequin", "hanger", "flat-lay"],
    },
    {
      operation: "video",
      model: "image-to-video",
      lifecycle: "Experimental",
      enabled: configured && process.env.ENABLE_VIDEO_GENERATION === "true",
      minInputDimension: 301,
      supportedViews: ["generated_image", "front"],
    },
  ];
}

/** Exact endpoint schemas verified against official FASHN docs on 24 October 2026. */
export class FashnProvider implements FashionProvider {
  constructor(
    private readonly apiKey = process.env.FASHN_API_KEY ?? "",
    private readonly request: typeof fetch = fetch,
  ) {}

  getProviderCapabilities(): ProviderCapability[] {
    return getFashnCapabilities();
  }

  async generateFashionImage(source: string, raw: ImageOptions): Promise<{ id: string }> {
    requireEnabledCapability(getFashnCapabilities(), "photo");
    const options = imageOptionsSchema.parse(raw);
    return this.submit("product-to-model", {
      product_image: source,
      prompt: `${options.model}. ${options.pose}. ${options.scene}. Preserve the supplied garment's silhouette, construction, colours, print and embellishments. Do not redesign the garment.`,
      aspect_ratio: options.aspectRatio,
      resolution: options.resolution,
      generation_mode: options.quality,
      output_format: options.outputFormat,
      seed: options.seed,
      num_images: 1,
      return_base64: false,
    });
  }

  async generateFashionVideo(source: string, raw: VideoOptions): Promise<{ id: string }> {
    requireEnabledCapability(getFashnCapabilities(), "video");
    const options = videoOptionsSchema.parse(raw);
    return this.submit("image-to-video", {
      image: source,
      duration: options.duration,
      resolution: options.resolution,
      ...(options.motion ? { prompt: options.motion } : {}),
    });
  }

  async generateVirtualTryOn(
    product: string,
    person: string,
    raw: TryOnOptions,
  ): Promise<{ id: string }> {
    requireEnabledCapability(getFashnCapabilities(), "try_on");
    const options = tryOnOptionsSchema.parse(raw);
    return this.submit("tryon-max", {
      product_image: product,
      model_image: person,
      resolution: options.resolution,
      generation_mode: options.quality,
      output_format: options.outputFormat,
      seed: options.seed,
      num_images: 1,
      return_base64: false,
    });
  }

  private async submit(model: string, inputs: Record<string, unknown>): Promise<{ id: string }> {
    if (!this.apiKey) throw new ProviderError("AI provider is not configured.", "not_configured");
    let response: Response;
    try {
      response = await this.request(`${API}/run`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model_name: model, inputs }),
        signal: AbortSignal.timeout(25_000),
      });
    } catch {
      // FASHN documents no client idempotency key. A network timeout may follow an accepted paid request.
      throw new ProviderError(
        "Submission outcome is unknown. An operator must reconcile it before retrying.",
        "submission_ambiguous",
        false,
        true,
      );
    }
    if (!response.ok) {
      // A received API-level rejection has no prediction id and may safely be retried after backoff.
      throw new ProviderError(
        "The AI provider rejected this request.",
        `provider_http_${response.status}`,
        response.status === 429 || response.status >= 500,
      );
    }
    try {
      const data = submissionSchema.parse(await response.json());
      if (data.error) throw new Error("Unexpected submission error");
      return { id: data.id };
    } catch {
      throw new ProviderError(
        "The provider returned an unrecognized submission response. Reconcile before retrying.",
        "submission_ambiguous",
        false,
        true,
      );
    }
  }

  async getGenerationStatus(id: string): Promise<Prediction> {
    if (!/^[a-zA-Z0-9_-]{1,180}$/.test(id))
      throw new ProviderError("Invalid prediction identifier.", "invalid_prediction");
    let response: Response;
    try {
      response = await this.request(`${API}/status/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(20_000),
        cache: "no-store",
      });
    } catch {
      throw new ProviderError(
        "Provider status is temporarily unavailable.",
        "status_unavailable",
        true,
      );
    }
    if (!response.ok)
      throw new ProviderError(
        "Provider status is unavailable.",
        `provider_http_${response.status}`,
        response.status === 429 || response.status >= 500,
      );
    const data = predictionSchema.parse(await response.json());
    if (data.id !== id)
      throw new ProviderError("Provider response identifier mismatch.", "invalid_prediction");
    const credits = Number(response.headers.get("x-fashn-credits-used"));
    return {
      id,
      status: data.status,
      outputs: data.output ?? [],
      ...(Number.isSafeInteger(credits) &&
      credits >= 0 &&
      response.headers.has("x-fashn-credits-used")
        ? { creditsUsed: credits }
        : {}),
      ...(data.error?.name ? { errorCode: data.error.name.slice(0, 100) } : {}),
    };
  }
}
