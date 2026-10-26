import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { query } = vi.hoisted(() => ({
  query: { select: vi.fn(), eq: vi.fn(), is: vi.fn(), maybeSingle: vi.fn() },
}));
vi.mock("@/lib/supabase/admin", () => ({ getAdminClient: () => ({ from: () => query }) }));
import { transferProviderOutput } from "@/server/storage/media";
import {
  MediaValidationError,
  ProviderOutputGoneError,
  validatePlayableMp4,
} from "@/server/storage/validation";

const box = (type: string, ...content: Buffer[]) => {
  const body = Buffer.concat(content);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(8 + body.length);
  return Buffer.concat([size, Buffer.from(type, "ascii"), body]);
};
/** Minimal synthetic MP4 with one track: handler, media header and first sample entry. */
function mp4(handler = "vide", codec = "avc1", duration = 80, timescale = 16) {
  const mdhd = Buffer.alloc(24);
  mdhd.writeUInt32BE(timescale, 12);
  mdhd.writeUInt32BE(duration, 16);
  const hdlr = Buffer.concat([Buffer.alloc(8), Buffer.from(handler, "ascii"), Buffer.alloc(12)]);
  const stsd = Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]), box(codec, Buffer.alloc(78))]);
  const trak = box(
    "trak",
    box("mdia", box("mdhd", mdhd), box("hdlr", hdlr), box("minf", box("stbl", box("stsd", stsd)))),
  );
  return Buffer.concat([
    box("ftyp", Buffer.from("isom0000")),
    box("moov", trak),
    box("mdat", Buffer.from([1, 2, 3, 4])),
  ]);
}

describe("playable video validation (synthetic MP4 fixtures)", () => {
  it("accepts an H.264 video track with a positive duration", () => {
    expect(validatePlayableMp4(mp4())).toEqual({ codec: "avc1", durationSeconds: 5 });
    expect(validatePlayableMp4(mp4("vide", "av01")).codec).toBe("av01");
  });
  it.each([
    [mp4("vide", "mp4v"), "codec"],
    [mp4("vide", "hev1"), "codec"],
    [mp4("soun", "mp4a"), "video track"],
    [mp4("vide", "avc1", 0), "duration"],
    [mp4().subarray(0, 40), "Truncated"],
  ])("rejects media a browser cannot play (%#)", (buffer, message) => {
    expect(() => validatePlayableMp4(buffer)).toThrow(message);
  });
});

describe("Hugging Face output transfer (HTTP and database test doubles)", () => {
  const url =
    "https://zerogpu-aoti-wan2-2-fp8da-aoti-faster.hf.space/gradio_api/file=/tmp/gradio/v/video.mp4";
  const args = {
    organizationId: "organization",
    jobId: "467219f3-84c1-4423-a709-2d68ed8f10de",
    index: 0,
    isVideo: true,
    provider: "huggingface" as const,
  };
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of ["select", "eq", "is"] as const) query[key].mockReturnValue(query);
    query.maybeSingle.mockResolvedValue({ data: null, error: null });
    vi.stubEnv("HF_TOKEN", "hf_synthetic-test-token");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("downloads only from a configured Space, with the token, without following redirects", async () => {
    const request = vi.fn().mockResolvedValue(new Response("", { status: 302 }));
    vi.stubGlobal("fetch", request);
    for (const untrusted of [
      "https://attacker.hf.space/gradio_api/file=/tmp/v.mp4",
      "https://huggingface.co/x",
      "http://zerogpu-aoti-wan2-2-fp8da-aoti-faster.hf.space/gradio_api/file=/tmp/v.mp4",
      "https://storage.example/private-signed-url",
    ])
      await expect(transferProviderOutput({ ...args, url: untrusted })).rejects.toThrow(
        MediaValidationError,
      );
    expect(request).not.toHaveBeenCalled();
    await expect(transferProviderOutput({ ...args, url })).rejects.toThrow("transfer failed");
    expect(request).toHaveBeenCalledWith(
      new URL(url),
      expect.objectContaining({
        redirect: "error",
        headers: { Authorization: "Bearer hf_synthetic-test-token" },
      }),
    );
  });

  it.each([404, 410])("reports an expired output (%i) as gone, not retryable", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status })));
    await expect(transferProviderOutput({ ...args, url })).rejects.toBeInstanceOf(
      ProviderOutputGoneError,
    );
  });

  it("refuses an unplayable video before anything is stored", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(mp4("vide", "mp4v"))));
    await expect(transferProviderOutput({ ...args, url })).rejects.toThrow("codec");
  });
});
