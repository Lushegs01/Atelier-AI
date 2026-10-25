import "server-only";
import { z } from "zod";
import {
  FashionProvider,
  GarmentContext,
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

/**
 * Public ZeroGPU Spaces whose Gradio signatures were verified on 25 October 2026. Requests are
 * positional and Space-specific, so an override must be a duplicate of the same Space.
 */
export const DEFAULT_HF_SPACES: Record<GenerationOperation, string> = {
  photo: "multimodalart/Qwen-Image-Edit-Fast",
  try_on: "franciszzj/Leffa",
  video: "zerogpu-aoti/wan2-2-fp8da-aoti-faster",
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
// The prediction id carries the operation so a later poll can find the Space holding the result.
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
// Leaves room for output transfer inside the 120-second Inngest step budget.
const RESULT_WAIT_MS = 85_000;
const MAX_STREAM_CHARS = 1_000_000;
const MAX_SEED = 2_147_483_647;
const VIDEO_NEGATIVE_PROMPT =
  "oversaturated, overexposed, static, blurry details, subtitles, still frame, grey cast, worst quality, low quality, JPEG artifacts, deformed, disfigured, extra fingers, poorly drawn hands, poorly drawn face, fused fingers, cluttered background, walking backwards";

const spaceIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const submissionSchema = z.object({ event_id: z.string().regex(/^[a-zA-Z0-9_]{1,150}$/) });

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

export function getHuggingFaceCapabilities(): ProviderCapability[] {
  const configured = Boolean(process.env.HF_TOKEN);
  return [
    {
      operation: "photo",
      model: huggingFaceSpace("photo"),
      lifecycle: "Experimental",
      enabled: configured && process.env.ENABLE_PHOTO_GENERATION === "true",
      minInputDimension: 15,
      supportedViews: ["front", "mannequin", "hanger", "flat-lay"],
      supportedResolutions: ["1k"],
    },
    {
      operation: "try_on",
      model: huggingFaceSpace("try_on"),
      lifecycle: "Experimental",
      enabled: configured && process.env.ENABLE_TRY_ON === "true",
      minInputDimension: 15,
      supportedViews: ["front", "mannequin", "hanger", "flat-lay"],
      supportedResolutions: ["1k"],
    },
    {
      operation: "video",
      model: huggingFaceSpace("video"),
      lifecycle: "Experimental",
      enabled: configured && process.env.ENABLE_VIDEO_GENERATION === "true",
      minInputDimension: 301,
      supportedViews: ["generated_image", "front"],
      supportedResolutions: ["480p"],
      supportedDurations: [5],
    },
  ];
}

function requireSupported(
  operation: GenerationOperation,
  options: { resolution?: string; duration?: number },
): void {
  const message = unsupportedOptionMessage(
    requireEnabledCapability(getHuggingFaceCapabilities(), operation),
    options,
  );
  if (message) throw new ProviderError(message, "unsupported_option");
}

const gradioFile = (url: string) => ({ path: url, url, meta: { _type: "gradio.FileData" } });

/** Leffa's VITON-HD weights cover tops only; its DressCode weights add dresses and bottoms. */
function leffaGarment(category?: string): [string, string] {
  if (category === "dress") return ["dress_code", "dresses"];
  if (category === "bottom") return ["dress_code", "lower_body"];
  return ["viton_hd", "upper_body"];
}

/**
 * Free Hugging Face ZeroGPU Spaces called through Gradio's documented `/call` API. A job keeps
 * running after submission and holds its result until one reader collects it. Closing a result
 * stream early cancels the job, so status reads wait for the final event instead of polling.
 */
export class HuggingFaceProvider implements FashionProvider {
  constructor(
    private readonly token = process.env.HF_TOKEN ?? "",
    private readonly request: typeof fetch = fetch,
  ) {}

  getProviderCapabilities(): ProviderCapability[] {
    return getHuggingFaceCapabilities();
  }

  async generateFashionImage(source: string, raw: ImageOptions): Promise<{ id: string }> {
    const options = imageOptionsSchema.parse(raw);
    requireSupported("photo", options);
    return this.submit("photo", [
      gradioFile(source),
      `Photograph ${options.model} wearing exactly this garment. ${options.pose}. ${options.scene}. Full-length editorial fashion photograph. Preserve the supplied garment's silhouette, construction, colours, print and embellishments. Do not redesign the garment.`,
      options.seed % (MAX_SEED + 1),
      false, // randomize_seed
      1, // true_guidance_scale expected by the Space's Lightning LoRA
      8, // num_inference_steps for the 8-step Lightning LoRA
      false, // rewrite_prompt would send the garment to a further hosted language model
    ]);
  }

  async generateFashionVideo(source: string, raw: VideoOptions): Promise<{ id: string }> {
    const options = videoOptionsSchema.parse(raw);
    requireSupported("video", options);
    return this.submit("video", [
      gradioFile(source),
      options.motion ||
        "The model moves naturally with a gentle turn, the fabric drapes and moves realistically, steady camera",
      6, // steps: the Space default for its Lightning LoRA
      VIDEO_NEGATIVE_PROMPT,
      options.duration,
      1, // guidance_scale
      1, // guidance_scale_2
      42, // seed
      false, // randomize_seed
    ]);
  }

  async generateVirtualTryOn(
    product: string,
    person: string,
    raw: TryOnOptions,
    garment?: GarmentContext,
  ): Promise<{ id: string }> {
    const options = tryOnOptionsSchema.parse(raw);
    requireSupported("try_on", options);
    const [modelType, garmentType] = leffaGarment(garment?.category);
    return this.submit("try_on", [
      gradioFile(person),
      gradioFile(product),
      false, // ref_acceleration
      options.quality === "quality" ? 50 : 30, // inference steps; the Space accepts 30-100
      2.5, // guidance scale
      options.seed % (MAX_SEED + 1),
      modelType,
      garmentType,
      false, // vt_repaint
    ]);
  }

  private spaceUrl(operation: GenerationOperation): string {
    return `https://${huggingFaceSpaceHost(huggingFaceSpace(operation))}`;
  }

  private async submit(operation: GenerationOperation, data: unknown[]): Promise<{ id: string }> {
    if (!this.token) throw new ProviderError("AI provider is not configured.", "not_configured");
    let response: Response;
    try {
      response = await this.request(
        `${this.spaceUrl(operation)}/gradio_api/call/${ENDPOINT[operation]}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ data }),
          redirect: "error",
          signal: AbortSignal.timeout(25_000),
        },
      );
    } catch {
      // Unlike a paid prediction, a duplicate Space job only spends free GPU quota, so retry.
      throw new ProviderError(
        "The AI provider could not be reached.",
        "provider_unreachable",
        true,
      );
    }
    if (!response.ok)
      throw new ProviderError(
        "The AI provider rejected this request.",
        `provider_http_${response.status}`,
        response.status === 429 || response.status >= 500,
      );
    try {
      const { event_id } = submissionSchema.parse(await response.json());
      return { id: `${PREFIX[operation]}-${event_id}` };
    } catch {
      throw new ProviderError(
        "The provider returned an unrecognized submission response.",
        "provider_invalid_response",
        true,
      );
    }
  }

  async getGenerationStatus(id: string): Promise<Prediction> {
    const match = /^(photo|tryon|video)-([a-zA-Z0-9_]{1,150})$/.exec(id);
    if (!match) throw new ProviderError("Invalid prediction identifier.", "invalid_prediction");
    const operation = OPERATION_BY_PREFIX[match[1]];
    const base = this.spaceUrl(operation);
    let response: Response;
    try {
      response = await this.request(`${base}/gradio_api/call/${ENDPOINT[operation]}/${match[2]}`, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: "text/event-stream" },
        redirect: "error",
        signal: AbortSignal.timeout(RESULT_WAIT_MS),
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
    let final: ServerEvent | null;
    try {
      final = await readFinalEvent(response);
    } catch {
      // The stream is closed, which cancels the Space job; there is no result to come back for.
      return { id, status: "failed", outputs: [], errorCode: "provider_timeout" };
    }
    if (!final) return { id, status: "failed", outputs: [], errorCode: "provider_failed" };
    if (final.event === "error")
      return { id, status: "failed", outputs: [], errorCode: spaceErrorCode(final.data) };
    const output = outputUrl(final.data, base);
    if (!output) return { id, status: "failed", outputs: [], errorCode: "provider_invalid_output" };
    return { id, status: "completed", outputs: [output] };
  }
}

interface ServerEvent {
  event: string;
  data: unknown;
}

function parseEvent(block: string): ServerEvent {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  try {
    return { event, data: JSON.parse(data.join("\n")) };
  } catch {
    return { event, data: data.join("\n") };
  }
}

/** Reads server-sent events until Gradio reports `complete` or `error`; null if the stream ends. */
async function readFinalEvent(response: Response): Promise<ServerEvent | null> {
  if (!response.body) return null;
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let received = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) return null;
      received += part.value.length;
      if (received > MAX_STREAM_CHARS) throw new Error("Provider event stream is too large.");
      buffer += part.value;
      let separator: RegExpExecArray | null;
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        const message = parseEvent(buffer.slice(0, separator.index));
        buffer = buffer.slice(separator.index + separator[0].length);
        if (message.event === "complete" || message.event === "error") return message;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Newer Gradio releases include the Space's error text; older ones send none. */
function spaceErrorCode(data: unknown): string {
  return /quota|runs limit/i.test(JSON.stringify(data ?? ""))
    ? "provider_quota_exceeded"
    : "provider_failed";
}

/** The first output component holds the image or video; it must be served by the same Space. */
function outputUrl(data: unknown, base: string): string | null {
  if (!Array.isArray(data) || !data.length) return null;
  const first = data[0] as Record<string, unknown> | null;
  // Gradio 4 and 5 wrap a video as { video, subtitles }; Gradio 6 returns the file directly.
  const file = (
    first && typeof first.video === "object" && first.video ? first.video : first
  ) as Record<string, unknown> | null;
  if (!file) return null;
  const candidate =
    typeof file.url === "string"
      ? file.url
      : typeof file.path === "string"
        ? `${base}/gradio_api/file=${file.path}`
        : null;
  if (!candidate) return null;
  try {
    return new URL(candidate).origin === base ? candidate : null;
  } catch {
    return null;
  }
}
