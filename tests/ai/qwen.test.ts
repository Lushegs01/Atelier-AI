import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { QwenProvider, QWEN_MODEL, getQwenCapabilities } from "@/server/ai/qwen";
import { imageOptionsSchema, tryOnOptionsSchema, videoOptionsSchema } from "@/server/ai/contracts";

const id = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const base = "https://gpu.example/qwen";
const source =
  "https://project.supabase.co/storage/v1/object/sign/private-media/org/asset/original.png?token=synthetic-signature";
const output = `${base}/v1/jobs/${id}/output`;
const key = "synthetic-private-service-credential-123456";
let fixture: Uint8Array<ArrayBuffer>;
const accepted = () => Response.json({ id, model: QWEN_MODEL, status: "in_queue", output: [] });

describe("Qwen private-service adapter (HTTP doubles; no live model inference)", () => {
  beforeAll(async () => {
    fixture = Uint8Array.from(
      await sharp({ create: { width: 512, height: 512, channels: 3, background: "blue" } })
        .png()
        .toBuffer(),
    );
  });
  beforeEach(() => {
    vi.stubEnv("QWEN_API_URL", base);
    vi.stubEnv("QWEN_API_KEY", key);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("ENABLE_PHOTO_GENERATION", "true");
    vi.stubEnv("ENABLE_TRY_ON", "true");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("sends bounded image bytes and a stable request UUID to the authenticated endpoint", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(fixture))
      .mockResolvedValueOnce(accepted());
    const result = await new QwenProvider(request).generateFashionImage(
      source,
      imageOptionsSchema.parse({}),
      { requestId: id },
    );
    expect(result).toEqual({ id });
    const [url, init] = request.mock.calls[1];
    expect(url).toBe(`${base}/v1/jobs`);
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${key}` });
    const body = JSON.parse(init!.body as string);
    expect(body).toMatchObject({
      request_id: id,
      operation: "photo",
      width: 864,
      height: 1152,
      seed: 42,
      num_inference_steps: 40,
      true_cfg_scale: 4,
      output_format: "png",
    });
    expect(body.images).toHaveLength(1);
    expect(body.images[0]).toMatch(/^data:image\/(jpeg|png);base64,/);
    expect(init!.body).not.toContain("synthetic-signature");
    expect(init!.body).not.toContain(key);
    expect(body.prompt).toContain("Do not redesign the garment");
  });

  it("keeps consented person and garment input order explicit without transmitting session metadata", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(fixture))
      .mockResolvedValueOnce(new Response(fixture))
      .mockResolvedValueOnce(accepted());
    await new QwenProvider(request).generateVirtualTryOn(
      source,
      source,
      tryOnOptionsSchema.parse({ tryOnSessionId: otherId }),
      { requestId: id },
    );
    const body = JSON.parse(request.mock.calls[2][1]!.body as string);
    expect(body.operation).toBe("try_on");
    expect(body.images).toHaveLength(2);
    expect(body.prompt).toContain("Image 1 is an adult person");
    expect(body.prompt).toContain("Image 2 shows the garment");
    expect(request.mock.calls[2][1]!.body).not.toContain(otherId);
  });

  it.each([
    "https://attacker.example/image.png",
    "https://project.supabase.co/auth/v1/admin?token=x",
    "https://project.supabase.co/storage/v1/object/public/private-media/image.png?token=x",
    "https://name:secret@project.supabase.co/storage/v1/object/sign/private-media/image.png?token=x",
  ])("rejects untrusted input URL %s before network access", async (url) => {
    const request = vi.fn<typeof fetch>();
    await expect(
      new QwenProvider(request).generateFashionImage(url, imageOptionsSchema.parse({}), {
        requestId: id,
      }),
    ).rejects.toMatchObject({ code: "qwen_input_untrusted" });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects missing stable identifiers, unpriced modes, and video before making a request", async () => {
    const request = vi.fn<typeof fetch>();
    const provider = new QwenProvider(request);
    await expect(
      provider.generateFashionImage(source, imageOptionsSchema.parse({})),
    ).rejects.toMatchObject({ code: "qwen_request_id_required" });
    await expect(
      provider.generateFashionImage(source, imageOptionsSchema.parse({ resolution: "4k" }), {
        requestId: id,
      }),
    ).rejects.toMatchObject({ code: "qwen_unsupported_options" });
    await expect(
      provider.generateFashionVideo(source, videoOptionsSchema.parse({})),
    ).rejects.toMatchObject({ code: "qwen_video_unsupported" });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects oversized bytes and corrupt images instead of trusting Content-Type", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("fake", { headers: { "content-length": "99999999" } }))
      .mockResolvedValueOnce(
        new Response("not an image", { headers: { "content-type": "image/png" } }),
      );
    const provider = new QwenProvider(request);
    for (let i = 0; i < 2; i++)
      await expect(
        provider.generateFashionImage(source, imageOptionsSchema.parse({}), { requestId: id }),
      ).rejects.toMatchObject({ code: "qwen_input_invalid" });
    expect(request.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
  });

  it("recovers an accepted deterministic job after its submission response is lost", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(fixture))
      .mockRejectedValueOnce(new Error("private error containing signed image"))
      .mockResolvedValueOnce(
        Response.json({ id, model: QWEN_MODEL, status: "processing", output: [] }),
      );
    await expect(
      new QwenProvider(request).generateFashionImage(source, imageOptionsSchema.parse({}), {
        requestId: id,
      }),
    ).resolves.toEqual({ id });
    expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("keeps lost submissions safely retryable using the same persisted UUID", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(fixture))
      .mockRejectedValueOnce(new Error("sensitive endpoint information"))
      .mockResolvedValueOnce(new Response("private", { status: 404 }));
    await expect(
      new QwenProvider(request).generateFashionImage(source, imageOptionsSchema.parse({}), {
        requestId: id,
      }),
    ).rejects.toMatchObject({
      code: "qwen_submission_unavailable",
      retryable: true,
      ambiguous: false,
    });
  });

  it("makes a received queue rejection retryable without exposing its raw body", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(fixture))
      .mockResolvedValueOnce(new Response("private image or prompt", { status: 429 }));
    await expect(
      new QwenProvider(request).generateFashionImage(source, imageOptionsSchema.parse({}), {
        requestId: id,
      }),
    ).rejects.toMatchObject({ code: "qwen_http_429", retryable: true, ambiguous: false });
  });

  it("validates model, identifier and authenticated output path on completed status", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ id, model: QWEN_MODEL, status: "completed", output: [output] }),
      );
    await expect(new QwenProvider(request).getGenerationStatus(id)).resolves.toMatchObject({
      id,
      status: "completed",
      outputs: [output],
    });
    expect(request.mock.calls[0][1]?.headers).toMatchObject({ Authorization: `Bearer ${key}` });
    expect(request.mock.calls[0][1]?.redirect).toBe("error");
  });

  it.each([
    `${base}/v1/jobs/${otherId}/output`,
    "https://attacker.example/output",
    `${output}?token=x`,
  ])("rejects output substitution %s", async (url) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ id, model: QWEN_MODEL, status: "completed", output: [url] }),
      );
    await expect(new QwenProvider(request).getGenerationStatus(id)).rejects.toMatchObject({
      code: "untrusted_output",
    });
  });

  it("rejects missing or mismatched predictions and non-completed outputs", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("hidden", { status: 404 }))
      .mockResolvedValueOnce(
        Response.json({ id: otherId, model: QWEN_MODEL, status: "processing" }),
      )
      .mockResolvedValueOnce(
        Response.json({ id, model: QWEN_MODEL, status: "processing", output: [output] }),
      );
    const provider = new QwenProvider(request);
    await expect(provider.getGenerationStatus(id)).rejects.toMatchObject({
      code: "qwen_job_not_found",
      retryable: false,
    });
    await expect(provider.getGenerationStatus(id)).rejects.toMatchObject({
      code: "invalid_prediction",
    });
    await expect(provider.getGenerationStatus(id)).rejects.toMatchObject({
      code: "qwen_response_invalid",
    });
  });

  it("authenticates idempotent deletion and never follows a redirect", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const provider = new QwenProvider(request);
    await provider.deleteGeneration(id);
    await provider.deleteGeneration(id);
    expect(request.mock.calls[0]).toMatchObject([
      `${base}/v1/jobs/${id}`,
      { method: "DELETE", redirect: "error", headers: { Authorization: `Bearer ${key}` } },
    ]);
    await expect(provider.deleteGeneration("../private")).rejects.toMatchObject({
      code: "invalid_prediction",
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("reports experimental still-image modes without advertising video or paid FASHN access", () => {
    expect(getQwenCapabilities().find((c) => c.operation === "photo")).toMatchObject({
      model: QWEN_MODEL,
      enabled: true,
      lifecycle: "Experimental",
    });
    expect(getQwenCapabilities().find((c) => c.operation === "video")).toMatchObject({
      enabled: false,
    });
    vi.stubEnv("QWEN_API_KEY", "");
    expect(getQwenCapabilities().every((c) => !c.enabled)).toBe(true);
  });
});
