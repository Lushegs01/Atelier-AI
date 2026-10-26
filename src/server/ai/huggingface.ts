import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  FashionProvider,
  GenerationContext,
  GenerationOperation,
  ImageOptions,
  VideoOptions,
  TryOnOptions,
  Prediction,
  ProviderCapability,
  ProviderError,
  requireEnabledCapability,
  unsupportedOptionMessage,
  imageOptionsSchema,
  videoOptionsSchema,
  tryOnOptionsSchema,
} from "./contracts";
import { validateProviderOutputUrl } from "@/server/storage/validation";

/**
 * Public ZeroGPU Spaces whose Gradio signatures, slider bounds and preprocessing were re-verified
 * on 26 October 2026 (docs/HUGGINGFACE-VERIFICATION.md). Requests are positional and
 * Space-specific, so an override must be a duplicate of the same Space.
 */
export const DEFAULT_HF_SPACES: Record<GenerationOperation, string> = {
  photo: "multimodalart/Qwen-Image-Edit-Fast",
  try_on: "franciszzj/Leffa",
  video: "zerogpu-aoti/wan2-2-fp8da-aoti-faster",
};
/** Stable model ids for pricing and job pinning; a duplicated Space serves the same model. */
export const HF_MODELS: Record<GenerationOperation, string> = {
  photo: "Qwen/Qwen-Image-Edit",
  try_on: "franciszzj/Leffa",
  video: "Wan-AI/Wan2.2-I2V-A14B",
};
/** Disclosure a designer acknowledges before their photographs are sent to public Spaces. */
export const HF_PROCESSING_DISCLOSURE_VERSION = "2026-10-26-hf-spaces-v1";
/**
 * Messages are buffered by the Space until read, so the first read is delayed by roughly the
 * expected queue and GPU time instead of holding a connection that would cancel the job if closed.
 */
export const HF_FIRST_READ_DELAY_SECONDS: Record<GenerationOperation, number> = {
  photo: 15,
  try_on: 30,
  video: 45,
};
const SPACE_ENV: Record<GenerationOperation, string> = {
  photo: "HF_PHOTO_SPACE",
  try_on: "HF_TRY_ON_SPACE",
  video: "HF_VIDEO_SPACE",
};
const ENDPOINT: Record<GenerationOperation, string> = {
  photo: "infer",
  try_on: "leffa_predict_vt",
  video: "generate_video",
};
// The prediction id carries the operation so a later read can find the Space holding the result.
const PREFIX: Record<GenerationOperation, string> = {
  photo: "photo",
  try_on: "tryon",
  video: "video",
};
const OPERATION_BY_PREFIX: Record<string, GenerationOperation> = {
  photo: "photo",
  tryon: "try_on",
  video: "video",
};
const MAX_STREAM_CHARS = 1_000_000;
const MAX_SEED = 2_147_483_647;
/** Wan resizes into 480-832 px and centre-crops anything outside this range, so it is rejected. */
const WAN_MIN_ASPECT = 480 / 832;
const WAN_MAX_ASPECT = 832 / 480;
const STARTING_STAGES = ["BUILDING", "RUNNING_BUILDING", "APP_STARTING", "RUNNING_APP_STARTING"];

const GARMENT_FIDELITY =
  "Keep the garment exactly as it appears in the reference image: the same colours, fabric texture, print and pattern placement, embroidery, embellishments, seams, closures, logos, neckline, sleeve and hem lengths, and silhouette. Do not redesign, recolour, simplify, crop or add details to the garment.";
const PHOTO_DIRECTIONS: Record<ImageOptions["direction"], (options: ImageOptions) => string> = {
  faithful: (o) =>
    `Show ${o.model} wearing exactly this garment in a plain light-grey photography studio, full-length front view, natural standing pose, even soft lighting, the whole garment clearly visible.`,
  editorial: (o) =>
    `Create a full-length editorial fashion photograph of ${o.model} wearing exactly this garment. Pose: ${o.pose}. Setting: ${o.scene}. Refined, magazine-quality lighting with the garment as the focus.`,
  lifestyle: (o) =>
    `Create a natural lifestyle campaign photograph of ${o.model} wearing exactly this garment. Pose: ${o.pose}, relaxed and candid. Setting: ${o.scene}. Soft natural light with the whole garment visible.`,
  product: (o) =>
    `Create a clean promotional product photograph of exactly this garment on an invisible ghost mannequin, centred and fully visible. Background: ${o.scene}. Soft, even studio lighting. No person.`,
};
const MOTION_PRESETS: Record<VideoOptions["motionPreset"], string> = {
  subtle:
    "The model stays in place with subtle, natural movement: a slight shift of weight, gentle breathing and relaxed hands. The camera stays steady.",
  fabric:
    "The model holds a natural, relaxed pose while a light breeze gently moves the fabric with small, realistic motion. The camera stays steady.",
  camera:
    "The model holds a natural, relaxed pose with minimal movement while the camera performs a very slow, smooth push-in.",
};
const VIDEO_CONSISTENCY =
  "The outfit stays exactly the same for the whole clip: the same garment, colours, pattern, fit and details. Calm, realistic fashion campaign footage.";
const VIDEO_NEGATIVE_PROMPT =
  "outfit change, clothing transformation, morphing garment, changing colours, changing pattern, turning around, spinning, fast motion, sudden movement, camera shake, oversaturated, overexposed, blurry details, subtitles, grey cast, worst quality, low quality, JPEG artifacts, deformed, disfigured, extra limbs, extra fingers, poorly drawn hands, poorly drawn face, fused fingers, cluttered background, many people in background, walking backwards";

const spaceIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const submissionSchema = z.object({ event_id: z.string().regex(/^[a-zA-Z0-9_-]{1,150}$/) });
const runtimeSchema = z.object({ stage: z.string().max(64) });
const predictionPattern = /^(photo|tryon|video)-([a-zA-Z0-9_]{1,150})$/;

export function huggingFaceSpace(operation: GenerationOperation): string {
  return process.env[SPACE_ENV[operation]]?.trim() || DEFAULT_HF_SPACES[operation];
}

/** Hugging Face serves `owner/Name.v2` at `owner-name-v2.hf.space`. */
export function huggingFaceSpaceHost(spaceId: string): string {
  if (!spaceIdPattern.test(spaceId))
    throw new ProviderError("The configured Hugging Face Space id is invalid.", "not_configured");
  return `${spaceId.toLowerCase().replace(/[^a-z0-9]/g, "-")}.hf.space`;
}

export function huggingFaceOutputHosts(): string[] {
  return (Object.keys(DEFAULT_HF_SPACES) as GenerationOperation[]).flatMap((operation) => {
    try {
      return [huggingFaceSpaceHost(huggingFaceSpace(operation))];
    } catch {
      return [];
    }
  });
}

/** Outputs must come from a configured Space; a private duplicate serves files only to its owner. */
export function huggingFaceOutputRequest(value: string): {
  url: URL;
  headers: Record<string, string> | undefined;
} {
  return {
    url: validateProviderOutputUrl(value, huggingFaceOutputHosts()),
    headers: process.env.HF_TOKEN ? { Authorization: `Bearer ${process.env.HF_TOKEN}` } : undefined,
  };
}

/**
 * Deterministic receipt for one submission attempt. It is the Gradio session hash the job is
 * queued under, so the worker records it before the POST and can always look the job up later.
 */
export function huggingFacePredictionId(
  operation: GenerationOperation,
  requestId: string,
  attempt = 0,
): string {
  const compact = requestId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 64);
  if (!compact) throw new ProviderError("A request identifier is required.", "invalid_prediction");
  return `${PREFIX[operation]}-atl${compact}r${Math.max(0, Math.floor(attempt))}`;
}

/** Bounded by the Inngest route's maxDuration so a read never outlives its invocation. */
export function huggingFaceResultWaitMs(): number {
  const seconds = Number(process.env.HF_RESULT_WAIT_SECONDS);
  return (Number.isFinite(seconds) ? Math.min(Math.max(seconds, 30), 280) : 240) * 1000;
}

export function getHuggingFaceCapabilities(): ProviderCapability[] {
  const configured = Boolean(process.env.HF_TOKEN);
  return [
    {
      provider: "huggingface",
      operation: "photo",
      model: HF_MODELS.photo,
      lifecycle: "Experimental",
      enabled: configured && process.env.ENABLE_PHOTO_GENERATION === "true",
      minInputDimension: 256,
      supportedViews: ["front", "mannequin", "hanger", "flat-lay"],
      supportedResolutions: ["1k"],
      notes: `Public Hugging Face Space ${huggingFaceSpace("photo")} (general image editing, about 1 megapixel). Compare every output with the original garment.`,
    },
    {
      provider: "huggingface",
      operation: "try_on",
      model: HF_MODELS.try_on,
      lifecycle: "Experimental",
      enabled: configured && process.env.ENABLE_TRY_ON === "true",
      minInputDimension: 256,
      minAspectRatio: 0.4,
      maxAspectRatio: 1,
      supportedViews: ["front", "mannequin", "hanger", "flat-lay"],
      supportedResolutions: ["1k"],
      notes: `Public Hugging Face Space ${huggingFaceSpace("try_on")}. Output is 768 × 1024; a visualization, not a fit guarantee.`,
    },
    {
      provider: "huggingface",
      operation: "video",
      model: HF_MODELS.video,
      lifecycle: "Experimental",
      enabled: configured && process.env.ENABLE_VIDEO_GENERATION === "true",
      minInputDimension: 480,
      minAspectRatio: WAN_MIN_ASPECT,
      maxAspectRatio: WAN_MAX_ASPECT,
      freeTextMotion: false,
      supportedViews: ["generated_image", "front"],
      supportedResolutions: ["480p"],
      supportedDurations: [5],
      notes: `Public Hugging Face Space ${huggingFaceSpace("video")}. 5-second, 16 fps clips, 480–832 px per side.`,
    },
  ];
}

function requireSupported(
  operation: GenerationOperation,
  options: { resolution?: string; duration?: number; motion?: string },
): void {
  const message = unsupportedOptionMessage(
    requireEnabledCapability(getHuggingFaceCapabilities(), operation),
    options,
  );
  if (message) throw new ProviderError(message, "unsupported_option");
}

export function buildPhotoPrompt(options: ImageOptions): string {
  return `${PHOTO_DIRECTIONS[options.direction](options)} ${GARMENT_FIDELITY}`;
}

export function buildVideoPrompt(options: VideoOptions): string {
  return `${MOTION_PRESETS[options.motionPreset]} ${VIDEO_CONSISTENCY}`;
}

const gradioFile = (url: string) => ({ path: url, url, meta: { _type: "gradio.FileData" } });

/** Leffa's VITON-HD weights cover tops only; its DressCode weights add dresses and bottoms. */
function leffaGarment(category?: string): [string, string] {
  if (category === "dress") return ["dress_code", "dresses"];
  if (category === "bottom") return ["dress_code", "lower_body"];
  return ["viton_hd", "upper_body"];
}

/**
 * Free Hugging Face ZeroGPU Spaces called through Gradio's `/call` API with a caller-chosen
 * session hash. A queued job runs whether or not anyone is reading, and its messages are buffered
 * under that session until one reader collects them from `/queue/data`. Closing a reader before
 * the final message cancels the job, so a read waits for completion and is never used to poll.
 */
export class HuggingFaceProvider implements FashionProvider {
  constructor(
    private readonly token = process.env.HF_TOKEN ?? "",
    private readonly request: typeof fetch = fetch,
  ) {}

  getProviderCapabilities(): ProviderCapability[] {
    return getHuggingFaceCapabilities();
  }

  async generateFashionImage(
    source: string,
    raw: ImageOptions,
    context?: GenerationContext,
  ): Promise<{ id: string }> {
    const options = imageOptionsSchema.parse(raw);
    requireSupported("photo", options);
    return this.submit(
      "photo",
      [
        gradioFile(source),
        buildPhotoPrompt(options),
        options.seed % (MAX_SEED + 1),
        false, // randomize_seed: the job seed keeps a retry reproducible
        1, // true_guidance_scale expected by the Space's Lightning LoRA (range 1-10)
        8, // num_inference_steps for the 8-step Lightning LoRA (range 4-28)
        false, // rewrite_prompt would send the garment to a further hosted language model
      ],
      context,
    );
  }

  async generateFashionVideo(
    source: string,
    raw: VideoOptions,
    context?: GenerationContext,
  ): Promise<{ id: string }> {
    const options = videoOptionsSchema.parse(raw);
    requireSupported("video", options);
    return this.submit(
      "video",
      [
        gradioFile(source),
        buildVideoPrompt(options),
        6, // steps: the Space default for its Lightning LoRA (range 1-30)
        VIDEO_NEGATIVE_PROMPT,
        options.duration, // seconds; the Space accepts 0.5-5.0 at 16 fps
        1, // guidance_scale (high-noise stage)
        1, // guidance_scale_2 (low-noise stage)
        options.seed % (MAX_SEED + 1),
        false, // randomize_seed
      ],
      context,
    );
  }

  async generateVirtualTryOn(
    product: string,
    person: string,
    raw: TryOnOptions,
    context?: GenerationContext,
  ): Promise<{ id: string }> {
    const options = tryOnOptionsSchema.parse(raw);
    requireSupported("try_on", options);
    const [modelType, garmentType] = leffaGarment(context?.garmentCategory);
    return this.submit(
      "try_on",
      [
        gradioFile(person),
        gradioFile(product),
        false, // ref_acceleration
        options.quality === "quality" ? 50 : 30, // inference steps; the Space accepts 30-100
        2.5, // guidance scale (range 0.1-5)
        options.seed % (MAX_SEED + 1),
        modelType,
        garmentType,
        false, // vt_repaint
      ],
      context,
    );
  }

  private spaceUrl(operation: GenerationOperation): string {
    return `https://${huggingFaceSpaceHost(huggingFaceSpace(operation))}`;
  }

  /** Reads the Space's runtime stage so a sleeping or broken Space is never sent a job. */
  private async assertSpaceRunning(operation: GenerationOperation): Promise<void> {
    const space = huggingFaceSpace(operation);
    huggingFaceSpaceHost(space);
    let stage: string | undefined;
    try {
      const response = await this.request(`https://huggingface.co/api/spaces/${space}/runtime`, {
        headers: { Authorization: `Bearer ${this.token}` },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
      });
      if (response.status === 401 || response.status === 403 || response.status === 404)
        throw new ProviderError(
          "The configured Hugging Face Space is unavailable to this token.",
          "provider_unavailable",
        );
      if (response.ok) stage = runtimeSchema.safeParse(await response.json()).data?.stage;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      // Status lookups are advisory; the submission itself reports a sleeping or full Space.
      return;
    }
    if (!stage || stage === "RUNNING") return;
    if (stage === "SLEEPING" || STARTING_STAGES.includes(stage)) {
      // Any request to a sleeping Space starts it. Configuration reads use no GPU.
      if (stage === "SLEEPING")
        await this.request(`${this.spaceUrl(operation)}/config`, {
          redirect: "error",
          signal: AbortSignal.timeout(5_000),
          cache: "no-store",
        }).catch(() => undefined);
      throw new ProviderError(
        "The free AI provider is starting up. The request will be sent once it is running.",
        "provider_starting",
        true,
      );
    }
    throw new ProviderError(
      "The free AI provider is currently unavailable.",
      "provider_unavailable",
    );
  }

  private async submit(
    operation: GenerationOperation,
    data: unknown[],
    context?: GenerationContext,
  ): Promise<{ id: string }> {
    if (!this.token) throw new ProviderError("AI provider is not configured.", "not_configured");
    const id = huggingFacePredictionId(
      operation,
      context?.requestId ?? randomUUID(),
      context?.attempt,
    );
    const sessionHash = predictionPattern.exec(id)![2];
    await this.assertSpaceRunning(operation);
    let response: Response;
    try {
      response = await this.request(
        `${this.spaceUrl(operation)}/gradio_api/call/${ENDPOINT[operation]}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ data, session_hash: sessionHash }),
          redirect: "error",
          signal: AbortSignal.timeout(25_000),
        },
      );
    } catch {
      // The Space may have queued the job. Its session is read before anything is resubmitted.
      throw new ProviderError(
        "The AI provider did not confirm the request. Its result is being checked; nothing has been resubmitted.",
        "submission_unconfirmed",
        true,
        true,
      );
    }
    if (!response.ok) {
      const status = response.status;
      // A gateway error can follow a queued job, so it is reconciled by reading, not resent.
      if (status >= 500 && status !== 503)
        throw new ProviderError(
          "The AI provider did not confirm the request. Its result is being checked; nothing has been resubmitted.",
          `provider_http_${status}`,
          true,
          true,
        );
      throw submissionRejection(status);
    }
    try {
      submissionSchema.parse(await response.json());
    } catch {
      throw new ProviderError(
        "The provider returned an unrecognized submission response.",
        "provider_invalid_response",
        true,
        true,
      );
    }
    return { id };
  }

  async getGenerationStatus(id: string): Promise<Prediction> {
    const match = predictionPattern.exec(id);
    if (!match) throw new ProviderError("Invalid prediction identifier.", "invalid_prediction");
    const operation = OPERATION_BY_PREFIX[match[1]];
    const base = this.spaceUrl(operation);
    const failed = (errorCode: string): Prediction => ({
      id,
      status: "failed",
      outputs: [],
      errorCode,
    });
    let response: Response;
    try {
      response = await this.request(
        `${base}/gradio_api/queue/data?session_hash=${encodeURIComponent(match[2])}`,
        {
          headers: { Authorization: `Bearer ${this.token}`, Accept: "text/event-stream" },
          redirect: "error",
          signal: AbortSignal.timeout(huggingFaceResultWaitMs()),
          cache: "no-store",
        },
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError")
        return failed("provider_timeout");
      // No stream was opened, so no Space job was cancelled; the read can be retried.
      throw new ProviderError(
        "Provider status is temporarily unavailable.",
        "status_unavailable",
        true,
      );
    }
    if (!response.ok) {
      if (response.status === 429 || response.status >= 500)
        throw new ProviderError(
          "Provider status is temporarily unavailable.",
          `provider_http_${response.status}`,
          true,
        );
      return failed("provider_result_unavailable");
    }
    let final: QueueMessage | null;
    try {
      final = await readFinalMessage(response);
    } catch (error) {
      // The stream is closed, which cancels an unfinished Space job; nothing is left to collect.
      return failed(
        error instanceof StreamLimitError ? "provider_invalid_response" : "provider_timeout",
      );
    }
    if (!final) return failed("provider_connection_lost");
    if (final.msg === "unexpected_error")
      return failed(final.session_not_found ? "provider_result_unavailable" : "provider_failed");
    if (final.msg === "close_stream") return failed("provider_result_unavailable");
    if (!final.success) return failed(spaceErrorCode(final.title, final.output?.error));
    const output = outputUrl(final.output?.data, base);
    if (!output) return failed("provider_invalid_output");
    return { id, status: "completed", outputs: [output] };
  }
}

function submissionRejection(status: number): ProviderError {
  if (status === 429)
    return new ProviderError(
      "The free AI provider is rate limiting requests.",
      "provider_rate_limited",
      true,
    );
  if (status === 503)
    return new ProviderError(
      "The free AI provider is busy or starting up.",
      "provider_unavailable",
      true,
    );
  if (status === 401 || status === 403)
    return new ProviderError(
      "The AI provider rejected the configured token.",
      "provider_auth_failed",
    );
  if (status === 404)
    return new ProviderError(
      "The configured Space no longer offers the expected API.",
      "provider_endpoint_missing",
    );
  return new ProviderError("The AI provider rejected this request.", `provider_http_${status}`);
}

interface QueueMessage {
  msg: string;
  success?: boolean;
  title?: string | null;
  session_not_found?: boolean;
  output?: { data?: unknown; error?: unknown };
}

class StreamLimitError extends Error {}

function parseMessage(block: string): QueueMessage | null {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return null;
  try {
    const value = JSON.parse(data) as unknown;
    return value && typeof value === "object" && typeof (value as QueueMessage).msg === "string"
      ? (value as QueueMessage)
      : null;
  } catch {
    return null;
  }
}

const FINAL_MESSAGES = ["process_completed", "unexpected_error", "close_stream"];

/** Reads server-sent queue messages until the job's final message; null if the stream ends. */
async function readFinalMessage(response: Response): Promise<QueueMessage | null> {
  if (!response.body) return null;
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let received = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) return null;
      received += part.value.length;
      if (received > MAX_STREAM_CHARS) throw new StreamLimitError();
      buffer += part.value;
      let separator: RegExpExecArray | null;
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        const message = parseMessage(buffer.slice(0, separator.index));
        buffer = buffer.slice(separator.index + separator[0].length);
        if (message && FINAL_MESSAGES.includes(message.msg)) return message;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** ZeroGPU raises titled errors; only a stable code is kept, never the upstream text. */
export function spaceErrorCode(title: unknown, message: unknown): string {
  const text = `${typeof title === "string" ? title : ""} ${typeof message === "string" ? message : ""}`;
  if (/quota exceeded|pending credits|runs limit|GPU limit|exceeded your .*quota/i.test(text))
    return "provider_quota_exceeded";
  if (/queue timeout|No GPU was available|ZeroGPU client error/i.test(text)) return "provider_busy";
  if (/illegal duration/i.test(text)) return "provider_rejected";
  return "provider_failed";
}

/** The first output component holds the image or video; it must be served by the same Space. */
function outputUrl(data: unknown, base: string): string | null {
  if (!Array.isArray(data) || !data.length) return null;
  const first = data[0] as Record<string, unknown> | null;
  // Gradio 4 and 5 can wrap a video as { video, subtitles }; Gradio 6 returns the file directly.
  const file = (
    first && typeof first.video === "object" && first.video ? first.video : first
  ) as Record<string, unknown> | null;
  if (!file || typeof file !== "object") return null;
  if (typeof file.url === "string") {
    try {
      if (new URL(file.url).origin === base) return file.url;
    } catch {
      // Fall through to the server path.
    }
  }
  // Behind a proxy Gradio may report another root; its server path is then resolved on this Space.
  if (
    typeof file.path === "string" &&
    file.path.startsWith("/") &&
    !file.path.includes("..") &&
    !/[\s?#\\]/.test(file.path)
  )
    return `${base}/gradio_api/file=${file.path}`;
  return null;
}
