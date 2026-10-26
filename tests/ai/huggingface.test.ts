import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HuggingFaceProvider,
  buildPhotoPrompt,
  buildVideoPrompt,
  getHuggingFaceCapabilities,
  huggingFaceOutputRequest,
  huggingFacePredictionId,
  huggingFaceResultWaitMs,
  huggingFaceSpaceHost,
  spaceErrorCode,
  spaceErrorDetail,
} from "@/server/ai/huggingface";
import {
  imageOptionsSchema,
  sourceShapeMessage,
  tryOnOptionsSchema,
  unsupportedOptionMessage,
  videoOptionsSchema,
} from "@/server/ai/contracts";

const jobId = "b10f30d0-67cf-467a-9a39-e19c56392c71";
const session = "atlb10f30d067cf467a9a39e19c56392c71r0";
const leffa = "https://franciszzj-leffa.hf.space";
const qwen = "https://multimodalart-qwen-image-edit-fast.hf.space";
const wan = "https://zerogpu-aoti-wan2-2-fp8da-aoti-faster.hf.space";
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

/** `/gradio_api/queue/data` frames, as observed from the live Qwen Space on 26 October 2026. */
function queue(...messages: Record<string, unknown>[]): Response {
  return new Response(messages.map((m) => `data: ${JSON.stringify(m)}\n\n`).join(""), {
    headers: { "Content-Type": "text/event-stream" },
  });
}
const completed = (data: unknown[]) => ({
  msg: "process_completed",
  event_id: "e1",
  output: { data },
  success: true,
});

/** Routes the Hub runtime lookup and the Gradio POST; records every request. */
function space(
  post: () => Response | Promise<Response> = () => Response.json({ event_id: "e1" }),
  stage = "RUNNING",
) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.startsWith("https://huggingface.co/api/spaces/")) return Response.json({ stage });
    if (url.endsWith("/config")) return Response.json({});
    return post();
  });
}

function submitted(request: ReturnType<typeof vi.fn<typeof fetch>>) {
  const call = request.mock.calls.find(([, init]) => init?.method === "POST")!;
  const body = JSON.parse(call[1]!.body as string) as { data: unknown[]; session_hash: string };
  return { url: String(call[0]), init: call[1]!, data: body.data, sessionHash: body.session_hash };
}

describe("Hugging Face Spaces adapter (HTTP test doubles; no live AI calls)", () => {
  beforeEach(() => {
    vi.stubEnv("HF_TOKEN", "hf_synthetic-test-token");
    vi.stubEnv("ENABLE_PHOTO_GENERATION", "true");
    vi.stubEnv("ENABLE_TRY_ON", "true");
    vi.stubEnv("ENABLE_VIDEO_GENERATION", "true");
  });
  afterEach(() => vi.unstubAllEnvs());

  describe("submission", () => {
    it("queues a Leffa try-on under the job's deterministic session with the person first", async () => {
      const request = space();
      const result = await new HuggingFaceProvider("hf_test", request).generateVirtualTryOn(
        "https://storage.example/garment",
        "https://storage.example/person",
        tryOnOptionsSchema.parse({}),
        { requestId: jobId, garmentCategory: "dress" },
      );
      expect(result).toEqual({ id: `tryon-${session}` });
      const { url, init, data, sessionHash } = submitted(request);
      expect(url).toBe(`${leffa}/gradio_api/call/leffa_predict_vt`);
      expect(sessionHash).toBe(session);
      expect(init.headers).toMatchObject({ Authorization: "Bearer hf_test" });
      expect(init.redirect).toBe("error");
      expect(data[0]).toEqual({
        path: "https://storage.example/person",
        url: "https://storage.example/person",
        meta: { _type: "gradio.FileData" },
      });
      expect(data[1]).toMatchObject({ path: "https://storage.example/garment" });
      // Verified bounds: steps 30-100, guidance 0.1-5, boolean radio choices.
      expect(data.slice(2)).toEqual([false, 30, 2.5, 42, "dress_code", "dresses", false]);
    });

    it.each([
      ["top", "viton_hd", "upper_body"],
      ["outerwear", "viton_hd", "upper_body"],
      ["bottom", "dress_code", "lower_body"],
      [undefined, "viton_hd", "upper_body"],
    ])("maps a %s garment to matching Leffa weights", async (category, model, type) => {
      const request = space();
      await new HuggingFaceProvider("hf_test", request).generateVirtualTryOn(
        "garment",
        "person",
        tryOnOptionsSchema.parse({ quality: "quality" }),
        { requestId: jobId, garmentCategory: category },
      );
      const { data } = submitted(request);
      expect(data[3]).toBe(50);
      expect(data.slice(6, 8)).toEqual([model, type]);
    });

    it("sends the photo Space a fidelity-first prompt without its external prompt rewriter", async () => {
      const request = space();
      const result = await new HuggingFaceProvider("hf_test", request).generateFashionImage(
        "https://storage.example/garment",
        imageOptionsSchema.parse({ model: "Adult model", seed: 4_294_967_295 }),
        { requestId: jobId, attempt: 2 },
      );
      expect(result).toEqual({ id: `photo-${session.replace(/r0$/, "r2")}` });
      const { url, data } = submitted(request);
      expect(url).toBe(`${qwen}/gradio_api/call/infer`);
      expect(data[1]).toContain("Adult model wearing exactly this garment");
      expect(data[1]).toContain("Keep the garment exactly as it appears in the reference image");
      expect(data[2]).toBeLessThanOrEqual(2_147_483_647);
      // randomize_seed, true_guidance_scale (1-10), steps (4-28), rewrite_prompt.
      expect(data.slice(3)).toEqual([false, 1, 8, false]);
    });

    it.each(["faithful", "editorial", "lifestyle", "product"] as const)(
      "keeps the garment-preservation instruction in the %s direction",
      (direction) => {
        const prompt = buildPhotoPrompt(imageOptionsSchema.parse({ direction }));
        expect(prompt).toContain("Do not redesign, recolour");
        if (direction === "product") expect(prompt).toContain("No person");
      },
    );

    it("sends a restrained motion preset and a 5-second clip to a configured duplicate Space", async () => {
      vi.stubEnv("HF_VIDEO_SPACE", "Studio-Owner/Wan2.2_Private");
      const request = space();
      const result = await new HuggingFaceProvider("hf_test", request).generateFashionVideo(
        "https://storage.example/look",
        videoOptionsSchema.parse({ resolution: "480p", motionPreset: "fabric", seed: 7 }),
        { requestId: jobId },
      );
      expect(result).toEqual({ id: `video-${session}` });
      const { url, data } = submitted(request);
      expect(url).toBe(
        "https://studio-owner-wan2-2-private.hf.space/gradio_api/call/generate_video",
      );
      expect(data[1]).toBe(buildVideoPrompt(videoOptionsSchema.parse({ motionPreset: "fabric" })));
      expect(data[1]).toContain("outfit stays exactly the same");
      expect(data[3]).toContain("outfit change");
      // steps (1-30), duration (0.5-5.0 s), guidance x2, seed, randomize_seed.
      expect([data[2], ...data.slice(4)]).toEqual([6, 5, 1, 1, 7, false]);
    });

    it("rejects options the free Spaces cannot honour before any request", async () => {
      const request = vi.fn<typeof fetch>();
      const provider = new HuggingFaceProvider("hf_test", request);
      for (const options of [
        { resolution: "1080p" },
        { resolution: "480p", duration: 10 },
        { resolution: "480p", motion: "spin around quickly" },
      ])
        await expect(
          provider.generateFashionVideo("source", videoOptionsSchema.parse(options)),
        ).rejects.toMatchObject({ code: "unsupported_option" });
      await expect(
        provider.generateFashionImage("source", imageOptionsSchema.parse({ resolution: "4k" })),
      ).rejects.toMatchObject({ code: "unsupported_option" });
      expect(request).not.toHaveBeenCalled();
    });

    it("marks an unconfirmed POST ambiguous so it is read, never resent", async () => {
      const request = space(() => Promise.reject(new TypeError("fetch failed")));
      await expect(
        new HuggingFaceProvider("hf_test", request).generateFashionImage(
          "source",
          imageOptionsSchema.parse({}),
          { requestId: jobId },
        ),
      ).rejects.toMatchObject({ code: "submission_unconfirmed", ambiguous: true });
      for (const status of [500, 502, 504])
        await expect(
          new HuggingFaceProvider(
            "hf_test",
            space(() => new Response("gateway", { status })),
          ).generateFashionImage("source", imageOptionsSchema.parse({}), { requestId: jobId }),
        ).rejects.toMatchObject({ code: `provider_http_${status}`, ambiguous: true });
    });

    it.each([
      [429, "provider_rate_limited", true],
      [503, "provider_unavailable", true],
      [401, "provider_auth_failed", false],
      [404, "provider_endpoint_missing", false],
      [422, "provider_http_422", false],
    ])("maps a definite HTTP %i rejection to %s", async (status, code, retryable) => {
      const request = space(() => new Response("no", { status }));
      await expect(
        new HuggingFaceProvider("hf_test", request).generateFashionImage(
          "source",
          imageOptionsSchema.parse({}),
          { requestId: jobId },
        ),
      ).rejects.toMatchObject({ code, retryable, ambiguous: false });
    });

    it("requires a token before any request", async () => {
      const request = space();
      await expect(
        new HuggingFaceProvider("", request).generateFashionImage(
          "source",
          imageOptionsSchema.parse({}),
        ),
      ).rejects.toMatchObject({ code: "not_configured" });
      expect(request).not.toHaveBeenCalled();
    });

    it("wakes a sleeping Space without submitting and asks for a later retry", async () => {
      const request = space(undefined, "SLEEPING");
      await expect(
        new HuggingFaceProvider("hf_test", request).generateFashionImage(
          "source",
          imageOptionsSchema.parse({}),
          { requestId: jobId },
        ),
      ).rejects.toMatchObject({ code: "provider_starting", retryable: true, ambiguous: false });
      expect(request.mock.calls.map(([url]) => String(url))).toEqual([
        "https://huggingface.co/api/spaces/multimodalart/Qwen-Image-Edit-Fast/runtime",
        `${qwen}/config`,
      ]);
    });

    it.each(["PAUSED", "RUNTIME_ERROR", "BUILD_ERROR", "STOPPED"])(
      "never submits to a %s Space",
      async (stage) => {
        const request = space(undefined, stage);
        await expect(
          new HuggingFaceProvider("hf_test", request).generateFashionImage(
            "source",
            imageOptionsSchema.parse({}),
            { requestId: jobId },
          ),
        ).rejects.toMatchObject({ code: "provider_unavailable", retryable: false });
        expect(request.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
      },
    );

    it("still submits when the advisory runtime lookup is unreachable", async () => {
      const request = vi.fn<typeof fetch>(async (input) =>
        String(input).includes("huggingface.co/api")
          ? Promise.reject(new TypeError("offline"))
          : Response.json({ event_id: "e1" }),
      );
      await expect(
        new HuggingFaceProvider("hf_test", request).generateFashionImage(
          "source",
          imageOptionsSchema.parse({}),
          { requestId: jobId },
        ),
      ).resolves.toEqual({ id: `photo-${session}` });
    });
  });

  describe("result reads", () => {
    it("reads buffered queue messages for the session until the job completes", async () => {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          queue(
            { msg: "estimation", rank: 0, queue_size: 1 },
            { msg: "process_starts" },
            { msg: "heartbeat" },
            completed([leffaOutput, leffaOutput, leffaOutput]),
          ),
        );
      const result = await new HuggingFaceProvider("hf_test", request).getGenerationStatus(
        `tryon-${session}`,
      );
      expect(result).toEqual({
        id: `tryon-${session}`,
        status: "completed",
        outputs: [leffaOutput.url],
      });
      expect(request.mock.calls[0][0]).toBe(
        `${leffa}/gradio_api/queue/data?session_hash=${session}`,
      );
      expect(request.mock.calls[0][1]).toMatchObject({ redirect: "error", cache: "no-store" });
    });

    it("reads legacy receipts, whose event id is also their session", async () => {
      const event = "8933e0b4162541a989c50d4f0f803cdb";
      const request = vi.fn<typeof fetch>().mockResolvedValue(queue(completed([leffaOutput])));
      await new HuggingFaceProvider("hf_test", request).getGenerationStatus(`tryon-${event}`);
      expect(request.mock.calls[0][0]).toBe(`${leffa}/gradio_api/queue/data?session_hash=${event}`);
    });

    it("parses messages split across chunks with CRLF line endings", async () => {
      const text = `data: {"msg":"heartbeat"}\r\n\r\ndata: ${JSON.stringify(completed([leffaOutput]))}\r\n\r\n`;
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
        `tryon-${session}`,
      );
      expect(result.outputs).toEqual([leffaOutput.url]);
    });

    it("accepts a direct or wrapped video file and resolves a server path on the same Space", async () => {
      const url = `${wan}/gradio_api/file=/tmp/gradio/v/video.mp4`;
      for (const first of [
        { path: "/tmp/gradio/v/video.mp4", url },
        { video: { path: "/tmp/gradio/v/video.mp4", url }, subtitles: null },
        { path: "/tmp/gradio/v/video.mp4", url: "https://internal-proxy:7860/file=x" },
      ]) {
        const request = vi.fn<typeof fetch>().mockResolvedValue(queue(completed([first, 42])));
        const result = await new HuggingFaceProvider("hf_test", request).getGenerationStatus(
          `video-${session}`,
        );
        expect(result).toMatchObject({ status: "completed", outputs: [url] });
      }
    });

    it.each([
      [
        { msg: "process_completed", output: { error: null }, success: false, title: "Error" },
        "provider_failed",
      ],
      [
        {
          msg: "process_completed",
          success: false,
          title: "ZeroGPU quota exceeded",
          output: {
            error: "You have exceeded your free ZeroGPU quota (120s requested vs. 30s left).",
          },
        },
        "provider_quota_exceeded",
      ],
      [
        {
          msg: "process_completed",
          success: false,
          title: "ZeroGPU queue timeout",
          output: { error: "No GPU was available after 60s" },
        },
        "provider_busy",
      ],
      [
        { msg: "unexpected_error", message: "404: Not Found", session_not_found: true },
        "provider_result_unavailable",
      ],
      [{ msg: "unexpected_error", message: "Server stopped unexpectedly." }, "provider_failed"],
      [{ msg: "close_stream" }, "provider_result_unavailable"],
      [
        completed([{ url: "https://attacker.hf.space/gradio_api/file=/tmp/x.webp" }]),
        "provider_invalid_output",
      ],
      [completed([{ path: "/tmp/../../etc/passwd" }]), "provider_invalid_output"],
      [completed([]), "provider_invalid_output"],
    ] as [Record<string, unknown>, string][])(
      "never reports %j as a success",
      async (final, code) => {
        const request = vi.fn<typeof fetch>().mockResolvedValue(queue(final));
        const result = await new HuggingFaceProvider("hf_test", request).getGenerationStatus(
          `tryon-${session}`,
        );
        expect(result).toMatchObject({ status: "failed", outputs: [], errorCode: code });
      },
    );

    it("treats an interrupted or ended stream as a lost Space job", async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"msg":"heartbeat"}\n\n'));
          controller.error(new DOMException("The operation timed out.", "TimeoutError"));
        },
      });
      await expect(
        new HuggingFaceProvider(
          "hf_test",
          vi.fn<typeof fetch>().mockResolvedValue(new Response(body)),
        ).getGenerationStatus(`photo-${session}`),
      ).resolves.toMatchObject({ status: "failed", errorCode: "provider_timeout" });
      await expect(
        new HuggingFaceProvider(
          "hf_test",
          vi.fn<typeof fetch>().mockResolvedValue(queue({ msg: "heartbeat" })),
        ).getGenerationStatus(`photo-${session}`),
      ).resolves.toMatchObject({ status: "failed", errorCode: "provider_connection_lost" });
    });

    it("rejects an oversized result stream", async () => {
      const big = `data: {"msg":"log","log":"${"x".repeat(1_100_000)}"}\n\n`;
      const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(big));
      await expect(
        new HuggingFaceProvider("hf_test", request).getGenerationStatus(`photo-${session}`),
      ).resolves.toMatchObject({ status: "failed", errorCode: "provider_invalid_response" });
    });

    it("keeps a read that never opened retryable, since no Space job was cancelled", async () => {
      const request = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"));
      await expect(
        new HuggingFaceProvider("hf_test", request).getGenerationStatus(`photo-${session}`),
      ).rejects.toMatchObject({ code: "status_unavailable", retryable: true });
      const busy = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 502 }));
      await expect(
        new HuggingFaceProvider("hf_test", busy).getGenerationStatus(`photo-${session}`),
      ).rejects.toMatchObject({ code: "provider_http_502", retryable: true });
    });

    it("rejects unknown prediction identifiers without a request", async () => {
      const request = vi.fn<typeof fetch>();
      const provider = new HuggingFaceProvider("hf_test", request);
      for (const id of [
        "../admin",
        "photo-",
        "fashn-abc",
        "photo-a&b=c",
        "123a87r9-4129-4bb3-be18-9c9fb5bd7fc1",
      ])
        await expect(provider.getGenerationStatus(id)).rejects.toMatchObject({
          code: "invalid_prediction",
        });
      expect(request).not.toHaveBeenCalled();
    });
  });

  it("reports a GPU worker crash with its own code and a short sanitized explanation", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      queue({
        msg: "process_completed",
        success: false,
        title: "ZeroGPU worker error",
        output: { error: "GPU task aborted" },
      }),
    );
    await expect(
      new HuggingFaceProvider("hf_test", request).getGenerationStatus(`photo-${session}`),
    ).resolves.toEqual({
      id: `photo-${session}`,
      status: "failed",
      outputs: [],
      errorCode: "provider_gpu_error",
      errorDetail: "ZeroGPU worker error: GPU task aborted",
    });
  });

  it("keeps only a bounded, markup- and link-free provider explanation", () => {
    expect(
      spaceErrorDetail(
        "ZeroGPU quota exceeded",
        'You have exceeded your free ZeroGPU quota (120s requested vs. 30s left). <a href="https://huggingface.co/subscribe/pro">Subscribe</a> https://huggingface.co/settings/tokens',
      ),
    ).toBe(
      "ZeroGPU quota exceeded: You have exceeded your free ZeroGPU quota (120s requested vs. 30s left). Subscribe [link]",
    );
    expect(spaceErrorDetail("Error", null)).toBe("Error");
    expect(spaceErrorDetail(null, "x".repeat(500))).toHaveLength(160);
    expect(spaceErrorDetail(undefined, "  ")).toBeNull();
  });

  it("maps ZeroGPU error titles to stable codes without keeping upstream text", () => {
    expect(spaceErrorCode("ZeroGPU quota exceeded", "anything")).toBe("provider_quota_exceeded");
    expect(spaceErrorCode("Error", "You have exceeded your ZeroGPU runs limit.")).toBe(
      "provider_quota_exceeded",
    );
    expect(spaceErrorCode("ZeroGPU pending credits exceeded", null)).toBe(
      "provider_quota_exceeded",
    );
    expect(spaceErrorCode("ZeroGPU client error", "No GPU was available")).toBe("provider_busy");
    expect(spaceErrorCode("ZeroGPU illegal duration", "")).toBe("provider_rejected");
    expect(spaceErrorCode("ZeroGPU worker error", "OutOfMemoryError")).toBe("provider_gpu_error");
    expect(spaceErrorCode(undefined, undefined)).toBe("provider_failed");
  });

  it("derives a distinct, bounded receipt per job and attempt", () => {
    expect(huggingFacePredictionId("photo", jobId)).toBe(`photo-${session}`);
    expect(huggingFacePredictionId("video", jobId, 3)).toBe(
      `video-${session.replace(/r0$/, "r3")}`,
    );
    expect(() => huggingFacePredictionId("photo", "---")).toThrow();
  });

  it("bounds the result wait to the worker invocation", () => {
    expect(huggingFaceResultWaitMs()).toBe(240_000);
    vi.stubEnv("HF_RESULT_WAIT_SECONDS", "85");
    expect(huggingFaceResultWaitMs()).toBe(85_000);
    vi.stubEnv("HF_RESULT_WAIT_SECONDS", "100000");
    expect(huggingFaceResultWaitMs()).toBe(280_000);
  });

  it("disables every capability without a token and limits video to 5-second clips", () => {
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

  it("rejects sources Wan would crop and landscape person photos Leffa would shrink", () => {
    const [photo, tryOn, video] = getHuggingFaceCapabilities();
    expect(sourceShapeMessage(video, 864, 1152)).toBeNull();
    expect(sourceShapeMessage(video, 832, 480)).toBeNull();
    expect(sourceShapeMessage(video, 720, 1280)).toMatch(/crop/);
    expect(sourceShapeMessage(video, 400, 500)).toMatch(/480 pixels/);
    expect(sourceShapeMessage(tryOn, 768, 1024)).toBeNull();
    expect(sourceShapeMessage(tryOn, 1600, 900)).toMatch(/portrait/);
    expect(sourceShapeMessage(photo, 2000, 600)).toBeNull();
    expect(sourceShapeMessage(photo, 200, 600)).toMatch(/256 pixels/);
    expect(unsupportedOptionMessage(video, { motion: " " })).toBeNull();
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
    for (const url of [
      "https://franciszzj-leffa.hf.space/gradio_api/file=/tmp/x.webp",
      "https://cdn.fashn.ai/output.png",
      "http://studio-owner-leffa.hf.space/gradio_api/file=/tmp/x.webp",
      "https://studio-owner-leffa.hf.space:8443/x",
      "https://user:pass@studio-owner-leffa.hf.space/x",
    ])
      expect(() => huggingFaceOutputRequest(url)).toThrow();
  });

  it("derives valid Space hosts and refuses URL-shaped Space ids", () => {
    expect(huggingFaceSpaceHost("black-forest-labs/FLUX.1-Kontext-Dev")).toBe(
      "black-forest-labs-flux-1-kontext-dev.hf.space",
    );
    expect(() => huggingFaceSpaceHost("https://evil.test/x")).toThrow();
    expect(() => huggingFaceSpaceHost("owner/../../x")).toThrow();
  });
});
