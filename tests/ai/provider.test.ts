import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FashnProvider, getFashnCapabilities } from "@/server/ai/fashn";
import {
  estimateProviderCredits,
  imageOptionsSchema,
  tryOnOptionsSchema,
  videoOptionsSchema,
} from "@/server/ai/contracts";

const id = "123a87r9-4129-4bb3-be18-9c9fb5bd7fc1-u1";

describe("FASHN adapter contracts (HTTP test doubles; no live AI calls)", () => {
  beforeEach(() => {
    vi.stubEnv("FASHN_API_KEY", "synthetic-test-provider-key");
    vi.stubEnv("ENABLE_PHOTO_GENERATION", "true");
    vi.stubEnv("ENABLE_TRY_ON", "true");
    vi.stubEnv("ENABLE_VIDEO_GENERATION", "true");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("submits product-to-model inputs in the documented nested envelope", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id, error: null }));
    const provider = new FashnProvider("test-key", request);
    await provider.generateFashionImage(
      "https://storage.example/signed-garment",
      imageOptionsSchema.parse({
        scene: "daylight atelier",
        model: "Adult model",
        pose: "standing",
      }),
    );
    const [url, init] = request.mock.calls[0];
    expect(url).toBe("https://api.fashn.ai/v1/run");
    const body = JSON.parse(init!.body as string);
    expect(body.model_name).toBe("product-to-model");
    expect(body.inputs).toMatchObject({
      product_image: "https://storage.example/signed-garment",
      aspect_ratio: "3:4",
      resolution: "1k",
      generation_mode: "balanced",
      num_images: 1,
    });
    expect(body.inputs.prompt).toContain("Preserve the supplied garment");
    expect(body).not.toHaveProperty("product_image");
  });

  it("keeps try-on person and product inputs distinct", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id }));
    await new FashnProvider("test-key", request).generateVirtualTryOn(
      "garment",
      "person",
      tryOnOptionsSchema.parse({}),
    );
    const body = JSON.parse(request.mock.calls[0][1]!.body as string);
    expect(body).toMatchObject({
      model_name: "tryon-max",
      inputs: {
        product_image: "garment",
        model_image: "person",
        generation_mode: "balanced",
        resolution: "1k",
      },
    });
    expect(body.inputs).not.toHaveProperty("tryOnSessionId");
  });

  it("sends only actual video duration and resolution settings", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id }));
    await new FashnProvider("test-key", request).generateFashionVideo(
      "source",
      videoOptionsSchema.parse({ duration: 10, resolution: "720p", motion: "turning gently" }),
    );
    expect(JSON.parse(request.mock.calls[0][1]!.body as string)).toEqual({
      model_name: "image-to-video",
      inputs: { image: "source", duration: 10, resolution: "720p", prompt: "turning gently" },
    });
    expect(() => videoOptionsSchema.parse({ duration: 30 })).toThrow();
  });

  it("marks lost submission response ambiguous so orchestration never automatically resubmits", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new DOMException("timeout", "AbortError"));
    await expect(
      new FashnProvider("test-key", request).generateFashionImage(
        "source",
        imageOptionsSchema.parse({}),
      ),
    ).rejects.toMatchObject({ code: "submission_ambiguous", ambiguous: true, retryable: false });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("marks a received API rejection as safely retryable and hides raw body", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("sensitive provider data", { status: 429 }));
    await expect(
      new FashnProvider("test-key", request).generateFashionImage(
        "source",
        imageOptionsSchema.parse({}),
      ),
    ).rejects.toMatchObject({ code: "provider_http_429", retryable: true, ambiguous: false });
  });

  it("treats a successful but unrecognized submission response as ambiguous", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ unrecognized: true }));
    await expect(
      new FashnProvider("test-key", request).generateFashionImage(
        "source",
        imageOptionsSchema.parse({}),
      ),
    ).rejects.toMatchObject({ code: "submission_ambiguous", retryable: false });
  });

  it("reads documented prediction states and integer provider credit header", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { id, status: "completed", output: ["https://media.fashn.ai/output.png"], error: null },
          { headers: { "x-fashn-credits-used": "2" } },
        ),
      );
    const result = await new FashnProvider("test-key", request).getGenerationStatus(id);
    expect(result).toMatchObject({
      status: "completed",
      creditsUsed: 2,
      outputs: ["https://media.fashn.ai/output.png"],
    });
    expect(request.mock.calls[0][0]).toBe(`https://api.fashn.ai/v1/status/${id}`);
  });

  it("rejects arbitrary prediction path input and mismatched provider ids", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ id: "different", status: "processing" }));
    const provider = new FashnProvider("test-key", request);
    await expect(provider.getGenerationStatus("../admin")).rejects.toMatchObject({
      code: "invalid_prediction",
    });
    expect(request).not.toHaveBeenCalled();
    await expect(provider.getGenerationStatus(id)).rejects.toMatchObject({
      code: "invalid_prediction",
    });
  });

  it("disables all unstable endpoints unless flags and credentials are configured", () => {
    vi.stubEnv("FASHN_API_KEY", "");
    expect(getFashnCapabilities().every((capability) => !capability.enabled)).toBe(true);
    vi.stubEnv("FASHN_API_KEY", "test-key");
    vi.stubEnv("ENABLE_VIDEO_GENERATION", "false");
    expect(
      getFashnCapabilities().find((capability) => capability.operation === "video"),
    ).toMatchObject({ lifecycle: "Experimental", enabled: false });
  });

  it("calculates documented provider credit units separately from retail billing", () => {
    expect(estimateProviderCredits("photo", {})).toBe(2);
    expect(estimateProviderCredits("try_on", { quality: "quality", resolution: "4k" })).toBe(5);
    expect(estimateProviderCredits("video", { duration: 10, resolution: "1080p" })).toBe(12);
    expect(() => imageOptionsSchema.parse({ numImages: 4 })).toThrow();
  });
});
