/**
 * Opt-in live smoke test of the three Hugging Face Spaces through the application's own adapter.
 * It spends real ZeroGPU quota on the HF_TOKEN account, so it never runs in CI or `npm test`.
 *
 *   HF_LIVE_SMOKE=1 HF_TOKEN=hf_... npm run smoke:hf -- photo      # or try_on, video, all
 *
 * Inputs are the public, MIT-licensed example images published with franciszzj/Leffa. No
 * customer photograph is used. Outputs are written to SMOKE_OUTPUT_DIR (default ./smoke-output)
 * only after their bytes pass the same validation the worker applies.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  HF_FIRST_READ_DELAY_SECONDS,
  HuggingFaceProvider,
  huggingFaceOutputRequest,
} from "@/server/ai/huggingface";
import {
  imageOptionsSchema,
  tryOnOptionsSchema,
  videoOptionsSchema,
  type GenerationOperation,
} from "@/server/ai/contracts";
import { readBoundedBody, validateImage, validatePlayableMp4 } from "@/server/storage/validation";

const FIXTURES = {
  garment: "https://huggingface.co/franciszzj/Leffa/resolve/main/examples/garment/01449_00.jpg",
  person: "https://huggingface.co/franciszzj/Leffa/resolve/main/examples/person1/01350_00.jpg",
};

/** The Space downloads inputs itself; hand it the final CDN location rather than a redirect. */
async function resolveFixture(url: string): Promise<string> {
  const response = await fetch(url, { method: "HEAD", redirect: "manual" });
  const location = response.headers.get("location");
  if (response.status >= 300 && response.status < 400 && location)
    return new URL(location, url).toString();
  if (!response.ok) throw new Error(`Fixture unavailable (${response.status}).`);
  return url;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(operation: GenerationOperation, outputDir: string) {
  const provider = new HuggingFaceProvider();
  const requestId = randomUUID();
  const started = Date.now();
  const [garment, person] = await Promise.all([
    resolveFixture(FIXTURES.garment),
    resolveFixture(FIXTURES.person),
  ]);
  const { id } =
    operation === "photo"
      ? await provider.generateFashionImage(
          garment,
          imageOptionsSchema.parse({ direction: "product", seed: 7 }),
          { requestId },
        )
      : operation === "try_on"
        ? await provider.generateVirtualTryOn(garment, person, tryOnOptionsSchema.parse({}), {
            requestId,
            garmentCategory: "top",
          })
        : await provider.generateFashionVideo(
            person,
            videoOptionsSchema.parse({ resolution: "480p", motionPreset: "subtle", seed: 7 }),
            { requestId },
          );
  console.log(`[${operation}] queued with receipt ${id}`);
  await sleep(HF_FIRST_READ_DELAY_SECONDS[operation] * 1000);
  const prediction = await provider.getGenerationStatus(id);
  if (prediction.status !== "completed")
    throw new Error(`[${operation}] not completed: ${prediction.errorCode ?? prediction.status}`);
  const transfer = huggingFaceOutputRequest(prediction.outputs[0]);
  const response = await fetch(transfer.url, {
    headers: transfer.headers,
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`[${operation}] output download failed (${response.status}).`);
  const bytes = await readBoundedBody(response, 100 * 1024 * 1024);
  let summary: string;
  let file: string;
  if (operation === "video") {
    const video = validatePlayableMp4(bytes);
    summary = `${video.codec}, ${video.durationSeconds.toFixed(2)} s`;
    file = join(outputDir, `${operation}.mp4`);
  } else {
    const image = await validateImage(bytes, 30 * 1024 * 1024);
    summary = `${image.width}×${image.height} ${image.mimeType}`;
    file = join(outputDir, `${operation}.${image.mimeType === "image/png" ? "png" : "jpg"}`);
    writeFileSync(file, image.buffer);
  }
  if (operation === "video") writeFileSync(file, bytes);
  console.log(
    `[${operation}] verified output (${summary}) in ${Math.round((Date.now() - started) / 1000)} s → ${file}`,
  );
}

async function main() {
  if (process.env.HF_LIVE_SMOKE !== "1" || !process.env.HF_TOKEN) {
    console.error(
      "Live smoke tests spend real ZeroGPU quota. Set HF_LIVE_SMOKE=1 and a read-only HF_TOKEN to run them.",
    );
    process.exit(2);
  }
  const requested = process.argv[2] ?? "photo";
  const operations: GenerationOperation[] =
    requested === "all" ? ["photo", "try_on", "video"] : [requested as GenerationOperation];
  if (!operations.every((operation) => ["photo", "try_on", "video"].includes(operation)))
    throw new Error("Choose photo, try_on, video or all.");
  // Capabilities are enabled for this process only.
  process.env.ENABLE_PHOTO_GENERATION = "true";
  process.env.ENABLE_TRY_ON = "true";
  process.env.ENABLE_VIDEO_GENERATION = "true";
  const outputDir = process.env.SMOKE_OUTPUT_DIR || "smoke-output";
  mkdirSync(outputDir, { recursive: true });
  let failed = false;
  for (const operation of operations) {
    try {
      await run(operation, outputDir);
    } catch (error) {
      failed = true;
      console.error(error instanceof Error ? error.message : `[${operation}] failed`);
    }
  }
  process.exit(failed ? 1 : 0);
}

void main();
