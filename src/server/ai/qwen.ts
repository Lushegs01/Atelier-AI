import "server-only";
import { z } from "zod";
import {
  type FashionProvider,
  type GenerationContext,
  type ImageOptions,
  type VideoOptions,
  type TryOnOptions,
  type Prediction,
  type ProviderCapability,
  ProviderError,
  imageOptionsSchema,
  tryOnOptionsSchema,
} from "./contracts";
import { getQwenEndpoint, getQwenOutputRequest } from "./endpoint";
import { readBoundedBody, validateImage } from "@/server/storage/validation";

export const QWEN_MODEL = "Qwen/Qwen-Image-Edit-2511";
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const uuidSchema = z.string().uuid();
const responseSchema = z.object({
  id: uuidSchema,
  model: z.literal(QWEN_MODEL),
  status: z.enum(["in_queue", "processing", "completed", "failed"]),
  output: z.array(z.string().max(2048)).max(1).optional(),
  error_code: z
    .string()
    .regex(/^[a-z0-9_]{1,80}$/)
    .nullable()
    .optional(),
});
const dimensions: Record<ImageOptions["aspectRatio"], [number, number]> = {
  "1:1": [1024, 1024],
  "3:4": [864, 1152],
  "4:3": [1152, 864],
  "9:16": [720, 1280],
  "16:9": [1280, 720],
  "2:3": [832, 1248],
  "3:2": [1248, 832],
  "4:5": [896, 1120],
  "5:4": [1120, 896],
};

export function getQwenCapabilities(): ProviderCapability[] {
  let configured = Boolean(process.env.QWEN_API_KEY && process.env.QWEN_API_KEY.length >= 32);
  try {
    getQwenEndpoint();
  } catch {
    configured = false;
  }
  return [
    {
      provider: "qwen",
      operation: "photo",
      model: QWEN_MODEL,
      lifecycle: "Experimental",
      enabled: configured && process.env.ENABLE_PHOTO_GENERATION === "true",
      minInputDimension: 256,
      supportedViews: ["front", "mannequin", "hanger", "flat-lay"],
      notes: "Self-hosted image editing. Review garment fidelity before publication.",
    },
    {
      provider: "qwen",
      operation: "try_on",
      model: QWEN_MODEL,
      lifecycle: "Experimental",
      enabled: configured && process.env.ENABLE_TRY_ON === "true",
      minInputDimension: 256,
      supportedViews: ["front", "mannequin", "hanger", "flat-lay"],
      notes: "Experimental multi-image editing, not a specialized fit or measurement model.",
    },
    {
      provider: "qwen",
      operation: "video",
      model: QWEN_MODEL,
      lifecycle: "Experimental",
      enabled: false,
      minInputDimension: 256,
      supportedViews: [],
      reason: "Qwen-Image-Edit generates still images and cannot generate video.",
    },
  ];
}

/** An authenticated private GPU endpoint, not a free hosted Hugging Face inference API. */
export class QwenProvider implements FashionProvider {
  constructor(private readonly request: typeof fetch = fetch) {}

  getProviderCapabilities() {
    return getQwenCapabilities();
  }

  private configuration() {
    const base = getQwenEndpoint().toString().replace(/\/$/, "");
    const key = process.env.QWEN_API_KEY;
    if (!key || key.length < 32)
      throw new ProviderError(
        "The private Qwen service credential is not configured.",
        "qwen_not_configured",
      );
    return { base, headers: { Authorization: `Bearer ${key}` } };
  }

  private assertOptions(options: ImageOptions | TryOnOptions) {
    if (
      options.resolution !== "1k" ||
      options.quality !== "balanced" ||
      options.numImages !== 1 ||
      options.outputFormat !== "png"
    ) {
      throw new ProviderError(
        "Qwen currently supports one balanced 1K PNG per request.",
        "qwen_unsupported_options",
      );
    }
  }

  private async sourceDataUri(value: string): Promise<string> {
    let url: URL;
    let configured: URL;
    try {
      url = new URL(value);
      configured = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || "");
    } catch {
      throw new ProviderError("The private source image is unavailable.", "qwen_input_untrusted");
    }
    const bucket = process.env.STORAGE_BUCKET || "private-media";
    const prefix = `${configured.pathname.replace(/\/$/, "")}/storage/v1/object/sign/${encodeURIComponent(bucket)}/`;
    if (
      url.origin !== configured.origin ||
      url.username ||
      url.password ||
      url.hash ||
      !url.pathname.startsWith(prefix) ||
      !url.searchParams.get("token")
    ) {
      throw new ProviderError(
        "The source image must be an authorized private storage object.",
        "qwen_input_untrusted",
      );
    }
    let response: Response;
    try {
      response = await this.request(url, {
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
        cache: "no-store",
      });
    } catch {
      throw new ProviderError(
        "The source image could not be retrieved.",
        "qwen_input_unavailable",
        true,
      );
    }
    if (!response.ok)
      throw new ProviderError(
        "The source image link expired or is unavailable.",
        "qwen_input_unavailable",
        true,
      );
    try {
      const raw = await readBoundedBody(response, MAX_INPUT_BYTES);
      const validated = await validateImage(raw, MAX_INPUT_BYTES);
      if (validated.width < 256 || validated.height < 256) throw new Error("Input too small");
      return `data:${validated.mimeType};base64,${validated.buffer.toString("base64")}`;
    } catch {
      throw new ProviderError(
        "Choose a valid source photo at least 256 pixels wide and high, up to 4 MB.",
        "qwen_input_invalid",
      );
    }
  }

  async generateFashionImage(
    source: string,
    raw: ImageOptions,
    context?: GenerationContext,
  ): Promise<{ id: string }> {
    const options = imageOptionsSchema.parse(raw);
    this.assertOptions(options);
    const requestId = this.requestId(context);
    const [width, height] = dimensions[options.aspectRatio];
    const prompt = `Create a professional full-length fashion campaign photograph. The image is the source garment. Place that same garment on ${options.model}. Pose: ${options.pose}. Setting: ${options.scene}. Preserve the supplied garment's exact silhouette, construction, neckline, sleeves, length, colours, print placement, embroidery and embellishments. Do not redesign the garment or add accessories that obscure it. Use a fully clothed adult model. Photographic realism.`;
    return this.submit(
      requestId,
      "photo",
      [await this.sourceDataUri(source)],
      prompt,
      width,
      height,
      options.seed,
    );
  }

  async generateVirtualTryOn(
    product: string,
    person: string,
    raw: TryOnOptions,
    context?: GenerationContext,
  ): Promise<{ id: string }> {
    const options = tryOnOptionsSchema.parse(raw);
    this.assertOptions(options);
    const requestId = this.requestId(context);
    // Person is image 1; garment is image 2. The consent/session id never leaves the application.
    const images = await Promise.all([this.sourceDataUri(person), this.sourceDataUri(product)]);
    const prompt =
      "Create a private virtual try-on visualization. Image 1 is an adult person who has consented to this image edit. Image 2 shows the garment to wear. Keep the person in image 1 recognizable, with their face, body shape, skin tone, pose and background unchanged as far as possible. Replace the relevant clothing with the garment from image 2, preserving its silhouette, neckline, sleeves, length, colours, print, embroidery and details. Keep the person fully clothed. This is a clothing visualization, not a body transformation or measurement.";
    return this.submit(requestId, "try_on", images, prompt, 864, 1152, options.seed);
  }

  async generateFashionVideo(
    _source: string,
    _options: VideoOptions,
    _context?: GenerationContext,
  ): Promise<{ id: string }> {
    // Preserve the shared provider method signature without interpreting unsupported video inputs.
    void _source;
    void _options;
    void _context;
    throw new ProviderError(
      "Qwen-Image-Edit generates still images. Fashion video is unavailable with this provider.",
      "qwen_video_unsupported",
    );
  }

  private requestId(context?: GenerationContext) {
    const result = uuidSchema.safeParse(context?.requestId);
    if (!result.success)
      throw new ProviderError(
        "A stable application job identifier is required.",
        "qwen_request_id_required",
      );
    this.configuration();
    return result.data;
  }

  private async submit(
    id: string,
    operation: "photo" | "try_on",
    images: string[],
    prompt: string,
    width: number,
    height: number,
    seed: number,
  ): Promise<{ id: string }> {
    const { base, headers } = this.configuration();
    let response: Response;
    try {
      response = await this.request(`${base}/v1/jobs`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        redirect: "error",
        body: JSON.stringify({
          request_id: id,
          operation,
          images,
          prompt,
          width,
          height,
          seed,
          output_format: "png",
          num_inference_steps: 40,
          true_cfg_scale: 4.0,
        }),
        signal: AbortSignal.timeout(25_000),
        cache: "no-store",
      });
    } catch {
      // The service persists a request-id/fingerprint pair. Replays of this same job cannot duplicate work.
      // Query its deterministic id after a lost response before asking the durable workflow to retry.
      try {
        await this.getGenerationStatus(id);
        return { id };
      } catch {
        /* A same-id retry remains safe. */
      }
      throw new ProviderError(
        "The private image service is temporarily unavailable. The same request identifier will be reused.",
        "qwen_submission_unavailable",
        true,
      );
    }
    if (!response.ok)
      throw new ProviderError(
        "The private image service rejected the request.",
        `qwen_http_${response.status}`,
        response.status === 429 || response.status >= 500,
      );
    try {
      const result = responseSchema.parse(await response.json());
      if (result.id !== id) throw new Error("Identifier mismatch");
      return { id };
    } catch {
      throw new ProviderError(
        "The private image service returned an invalid response. The same request identifier will be reused.",
        "qwen_response_invalid",
        true,
      );
    }
  }

  async getGenerationStatus(id: string): Promise<Prediction> {
    if (!uuidSchema.safeParse(id).success)
      throw new ProviderError("Invalid Qwen job identifier.", "invalid_prediction");
    const { base, headers } = this.configuration();
    let response: Response;
    try {
      response = await this.request(`${base}/v1/jobs/${id}`, {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        cache: "no-store",
      });
    } catch {
      throw new ProviderError(
        "The private image service status is temporarily unavailable.",
        "qwen_status_unavailable",
        true,
      );
    }
    if (response.status === 404)
      throw new ProviderError(
        "This Qwen job was not accepted by the private service.",
        "qwen_job_not_found",
        false,
      );
    if (!response.ok)
      throw new ProviderError(
        "The private image service status is unavailable.",
        `qwen_http_${response.status}`,
        response.status === 429 || response.status >= 500,
      );
    let data: z.infer<typeof responseSchema>;
    try {
      data = responseSchema.parse(await response.json());
    } catch {
      throw new ProviderError(
        "The private image service returned an invalid status.",
        "qwen_response_invalid",
        true,
      );
    }
    if (data.id !== id)
      throw new ProviderError(
        "The image service response identifier did not match this job.",
        "invalid_prediction",
      );
    const outputs = data.output || [];
    if (
      (data.status === "completed" && outputs.length !== 1) ||
      (data.status !== "completed" && outputs.length !== 0)
    )
      throw new ProviderError(
        "The image service returned an invalid output count.",
        "qwen_response_invalid",
      );
    for (const output of outputs) getQwenOutputRequest(output, id);
    return {
      id,
      status: data.status,
      outputs,
      ...(data.error_code ? { errorCode: data.error_code } : {}),
    };
  }

  async deleteGeneration(id: string): Promise<void> {
    if (!uuidSchema.safeParse(id).success)
      throw new ProviderError("Invalid Qwen job identifier.", "invalid_prediction");
    const { base, headers } = this.configuration();
    let response: Response;
    try {
      response = await this.request(`${base}/v1/jobs/${id}`, {
        method: "DELETE",
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        cache: "no-store",
      });
    } catch {
      throw new ProviderError(
        "The private image service deletion must be retried.",
        "qwen_deletion_unavailable",
        true,
      );
    }
    if (!response.ok && response.status !== 404)
      throw new ProviderError(
        "The private image service deletion must be retried.",
        `qwen_http_${response.status}`,
        true,
      );
  }
}
