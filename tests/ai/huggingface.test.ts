import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HuggingFaceProvider,
  getHuggingFaceCapabilities,
  huggingFaceOutputRequest,
  huggingFaceSpaceHost,
} from "@/server/ai/huggingface";
import { imageOptionsSchema, tryOnOptionsSchema, videoOptionsSchema } from "@/server/ai/contracts";

const event = "8933e0b4162541a989c50d4f0f803cdb";
const leffa = "https://franciszzj-leffa.hf.space";
// Output shape captured from a live Leffa run on 25 October 2026.
const leffaOutput = {
  path: "/tmp/gradio/ad14/image.webp",
  url: `${leffa}/gradio_api/file=/tmp/gradio/ad14/image.webp`,
  size: null,
  orig_name: "image.webp",
  mime_type: null,
  is_stream: false,
  meta: { _type: "gradio.FileData" },
};

function sse(...events: [string, unknown][]): Response {
  return new Response(
    events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

function submitted(request: ReturnType<typeof vi.fn<typeof fetch>>) {
  const [url, init] = request.mock.calls[0];
  return { url, init, data: JSON.parse(init!.body as string).data as unknown[] };
}

describe("Hugging Face Spaces adapter (HTTP test doubles; no live AI calls)", () => {
  beforeEach(() => {
    vi.stubEnv("HF_TOKEN", "hf_synthetic-test-token");
    vi.stubEnv("ENABLE_PHOTO_GENERATION", "true");
    vi.stubEnv("ENABLE_TRY_ON", "true");
    vi.stubEnv("ENABLE_VIDEO_GENERATION", "true");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("submits a Leffa try-on with the person first and boolean radio values", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ event_id: event }));
    const result = await new HuggingFaceProvider("hf_test", request).generateVirtualTryOn(
      "https://storage.example/garment",
      "https://storage.example/person",
      tryOnOptionsSchema.parse({}),
      { requestId: "job-1", garmentCategory: "dress" },
    );
    expect(result).toEqual({ id: `tryon-${event}` });
    const { url, init, data } = submitted(request);
    expect(url).toBe(`${leffa}/gradio_api/call/leffa_predict_vt`);
    expect(init?.headers).toMatchObject({ Authorization: "Bearer hf_test" });
    expect(data[0]).toEqual({
      path: "https://storage.example/person",
      url: "https://storage.example/person",
      meta: { _type: "gradio.FileData" },
    });
    expect(data[1]).toMatchObject({ path: "https://storage.example/garment" });
    expect(data.slice(2)).toEqual([false, 30, 2.5, 42, "dress_code", "dresses", false]);
  });

  it.each([
    ["top", "viton_hd", "upper_body"],
    ["outerwear", "viton_hd", "upper_body"],
    ["bottom", "dress_code", "lower_body"],
    [undefined, "viton_hd", "upper_body"],
  ])("maps a %s garment to matching Leffa weights", async (category, model, type) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ event_id: event }));
    await new HuggingFaceProvider("hf_test", request).generateVirtualTryOn(
      "garment",
      "person",
      tryOnOptionsSchema.parse({ quality: "quality" }),
      { requestId: "job-1", garmentCategory: category },
    );
    const { data } = submitted(request);
    expect(data[3]).toBe(50);
    expect(data.slice(6, 8)).toEqual([model, type]);
  });

  it("asks the photo Space to preserve the garment without its external prompt rewriter", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ event_id: event }));
    const result = await new HuggingFaceProvider("hf_test", request).generateFashionImage(
      "https://storage.example/garment",
      imageOptionsSchema.parse({ model: "Adult model", seed: 4_294_967_295 }),
    );
    expect(result).toEqual({ id: `photo-${event}` });
    const { url, data } = submitted(request);
    expect(url).toBe("https://multimodalart-qwen-image-edit-fast.hf.space/gradio_api/call/infer");
    expect(data[1]).toContain("Adult model wearing exactly this garment");
    expect(data[1]).toContain("Preserve the supplied garment");
    expect(data[2]).toBeLessThanOrEqual(2_147_483_647);
    expect(data.slice(3)).toEqual([false, 1, 8, false]);
  });

  it("rejects options the free Spaces cannot honour before any request", async () => {
    const request = vi.fn<typeof fetch>();
    const provider = new HuggingFaceProvider("hf_test", request);
    await expect(
      provider.generateFashionVideo("source", videoOptionsSchema.parse({ resolution: "1080p" })),
    ).rejects.toMatchObject({ code: "unsupported_option" });
    await expect(
      provider.generateFashionVideo(
        "source",
        videoOptionsSchema.parse({ resolution: "480p", duration: 10 }),
      ),
    ).rejects.toMatchObject({ code: "unsupported_option" });
    await expect(
      provider.generateFashionImage("source", imageOptionsSchema.parse({ resolution: "4k" })),
    ).rejects.toMatchObject({ code: "unsupported_option" });
    expect(request).not.toHaveBeenCalled();
  });

  it("sends a 5-second 480p video to a configured duplicate Space", async () => {
    vi.stubEnv("HF_VIDEO_SPACE", "Studio-Owner/Wan2.2_Private");
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ event_id: event }));
    const result = await new HuggingFaceProvider("hf_test", request).generateFashionVideo(
      "https://storage.example/look",
      videoOptionsSchema.parse({ resolution: "480p", motion: "slow turn" }),
    );
    expect(result).toEqual({ id: `video-${event}` });
    const { url, data } = submitted(request);
    expect(url).toBe("https://studio-owner-wan2-2-private.hf.space/gradio_api/call/generate_video");
    expect(data[1]).toBe("slow turn");
    expect(data[4]).toBe(5);
  });

  it("retries a lost submission instead of holding it for manual reconciliation", async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"));
    await expect(
      new HuggingFaceProvider("hf_test", request).generateFashionImage(
        "source",
        imageOptionsSchema.parse({}),
      ),
    ).rejects.toMatchObject({ code: "provider_unreachable", retryable: true, ambiguous: false });
  });

  it("marks a busy Space retryable and requires a token", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("queue full", { status: 503 }));
    await expect(
      new HuggingFaceProvider("hf_test", request).generateFashionImage(
        "source",
        imageOptionsSchema.parse({}),
      ),
    ).rejects.toMatchObject({ code: "provider_http_503", retryable: true });
    await expect(
      new HuggingFaceProvider("", request).generateFashionImage(
        "source",
        imageOptionsSchema.parse({}),
      ),
    ).rejects.toMatchObject({ code: "not_configured" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("waits through heartbeats for the completed Space output", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        sse(["heartbeat", null], ["generating", null], ["complete", [leffaOutput, leffaOutput]]),
      );
    const result = await new HuggingFaceProvider("hf_test", request).getGenerationStatus(
      `tryon-${event}`,
    );
    expect(result).toEqual({
      id: `tryon-${event}`,
      status: "completed",
      outputs: [leffaOutput.url],
    });
    expect(request.mock.calls[0][0]).toBe(`${leffa}/gradio_api/call/leffa_predict_vt/${event}`);
  });

  it("parses events split across chunks with CRLF line endings", async () => {
    const text = `event: heartbeat\r\ndata: null\r\n\r\nevent: complete\r\ndata: ${JSON.stringify([leffaOutput])}\r\n\r\n`;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < text.length; index += 7)
          controller.enqueue(encoder.encode(text.slice(index, index + 7)));
        controller.close();
      },
    });
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    const result = await new HuggingFaceProvider("hf_test", request).getGenerationStatus(
      `tryon-${event}`,
    );
    expect(result.outputs).toEqual([leffaOutput.url]);
  });

  it("accepts the wrapped video output of Gradio 4 and 5", async () => {
    const url = "https://zerogpu-aoti-wan2-2-fp8da-aoti-faster.hf.space/gradio_api/file=/tmp/v.mp4";
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        sse(["complete", [{ video: { path: "/tmp/v.mp4", url }, subtitles: null }, 42]]),
      );
    const result = await new HuggingFaceProvider("hf_test", request).getGenerationStatus(
      `video-${event}`,
    );
    expect(result).toMatchObject({ status: "completed", outputs: [url] });
  });

  it.each([
    [["error", null], "provider_failed"],
    [
      ["error", { error: "You have exceeded your ZeroGPU runs limit.", title: "Error" }],
      "provider_quota_exceeded",
    ],
    [
      ["complete", [{ url: "https://attacker.hf.space/gradio_api/file=/tmp/x.webp" }]],
      "provider_invalid_output",
    ],
    [["complete", []], "provider_invalid_output"],
  ] as [[string, unknown], string][])(
    "reports final event %j as a failed prediction",
    async (final, code) => {
      const request = vi.fn<typeof fetch>().mockResolvedValue(sse(final));
      const result = await new HuggingFaceProvider("hf_test", request).getGenerationStatus(
        `tryon-${event}`,
      );
      expect(result).toMatchObject({ status: "failed", outputs: [], errorCode: code });
    },
  );

  it("treats an interrupted result stream as a cancelled Space job", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: heartbeat\ndata: null\n\n"));
        controller.error(new DOMException("The operation timed out.", "TimeoutError"));
      },
    });
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    await expect(
      new HuggingFaceProvider("hf_test", request).getGenerationStatus(`photo-${event}`),
    ).resolves.toMatchObject({ status: "failed", errorCode: "provider_timeout" });
  });

  it("keeps an unreachable status endpoint retryable", async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"));
    await expect(
      new HuggingFaceProvider("hf_test", request).getGenerationStatus(`photo-${event}`),
    ).rejects.toMatchObject({ code: "status_unavailable", retryable: true });
  });

  it("rejects unknown prediction identifiers without a request", async () => {
    const request = vi.fn<typeof fetch>();
    const provider = new HuggingFaceProvider("hf_test", request);
    for (const id of ["../admin", "photo-", "fashn-abc", "123a87r9-4129-4bb3-be18-9c9fb5bd7fc1"])
      await expect(provider.getGenerationStatus(id)).rejects.toMatchObject({
        code: "invalid_prediction",
      });
    expect(request).not.toHaveBeenCalled();
  });

  it("disables every capability without a token and limits video to 5-second 480p", () => {
    expect(getHuggingFaceCapabilities().every((capability) => capability.enabled)).toBe(true);
    expect(getHuggingFaceCapabilities().map(({ provider, model }) => [provider, model])).toEqual([
      ["huggingface", "Qwen/Qwen-Image-Edit"],
      ["huggingface", "franciszzj/Leffa"],
      ["huggingface", "Wan-AI/Wan2.2-I2V-A14B"],
    ]);
    expect(
      getHuggingFaceCapabilities().find((capability) => capability.operation === "video"),
    ).toMatchObject({ supportedResolutions: ["480p"], supportedDurations: [5] });
    vi.stubEnv("HF_TOKEN", "");
    expect(getHuggingFaceCapabilities().some((capability) => capability.enabled)).toBe(false);
  });

  it("keeps the pinned model when a duplicate Space is configured", () => {
    vi.stubEnv("HF_TRY_ON_SPACE", "studio-owner/Leffa");
    expect(
      getHuggingFaceCapabilities().find((capability) => capability.operation === "try_on"),
    ).toMatchObject({ model: "franciszzj/Leffa" });
  });

  it("accepts output only from configured Spaces and sends the token for private copies", () => {
    vi.stubEnv("HF_TRY_ON_SPACE", "studio-owner/Leffa");
    const transfer = huggingFaceOutputRequest(
      "https://studio-owner-leffa.hf.space/gradio_api/file=/tmp/gradio/a/image.webp",
    );
    expect(transfer.url.hostname).toBe("studio-owner-leffa.hf.space");
    expect(transfer.headers).toEqual({ Authorization: "Bearer hf_synthetic-test-token" });
    expect(() =>
      huggingFaceOutputRequest("https://franciszzj-leffa.hf.space/gradio_api/file=/tmp/x.webp"),
    ).toThrow();
    expect(() => huggingFaceOutputRequest("https://cdn.fashn.ai/output.png")).toThrow();
  });

  it("derives valid Space hosts for standalone adapter configuration", () => {
    expect(huggingFaceSpaceHost("black-forest-labs/FLUX.1-Kontext-Dev")).toBe(
      "black-forest-labs-flux-1-kontext-dev.hf.space",
    );
    expect(() => huggingFaceSpaceHost("https://evil.test/x")).toThrow();
  });
});
