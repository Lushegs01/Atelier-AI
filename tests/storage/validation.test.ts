import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  createThumbnail,
  detectImageFormat,
  readBoundedBody,
  validateImage,
  validateProviderOutputUrl,
  validateMp4Container,
} from "@/server/storage/validation";

const fashnHosts = ["cdn.fashn.ai", "media.fashn.ai"];

describe("private image and output validation", () => {
  it("fully decodes, normalizes and strips metadata from a synthetic fixture", async () => {
    const source = await sharp({
      create: { width: 400, height: 600, channels: 3, background: "#183952" },
    })
      .jpeg()
      .withMetadata({ exif: { IFD0: { Artist: "must be stripped" } } })
      .toBuffer();
    const normalized = await validateImage(source);
    expect(normalized).toMatchObject({ width: 400, height: 600, mimeType: "image/jpeg" });
    const metadata = await sharp(normalized.buffer).metadata();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
  });

  it("rejects SVG payloads disguised by a browser-supplied file name", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    expect(detectImageFormat(svg)).toBeNull();
    await expect(validateImage(svg)).rejects.toThrow("JPEG, PNG or WebP");
  });

  it("rejects corrupt files with valid JPEG magic bytes", async () => {
    await expect(validateImage(Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0]))).rejects.toThrow(
      "could not be decoded",
    );
  });

  it("rejects oversize and undersize decoded images", async () => {
    const image = await sharp({
      create: { width: 10, height: 10, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    await expect(validateImage(image)).rejects.toThrow("dimensions");
    await expect(validateImage(Buffer.alloc(1025), 1024)).rejects.toThrow("smaller");
  });

  it("generates bounded, metadata-free WebP previews", async () => {
    const input = await sharp({
      create: { width: 1000, height: 1600, channels: 3, background: "#6991ac" },
    })
      .png()
      .toBuffer();
    const preview = await sharp(await createThumbnail(input)).metadata();
    expect(preview.width).toBeLessThanOrEqual(640);
    expect(preview.height).toBeLessThanOrEqual(800);
    expect(preview.format).toBe("webp");
  });

  it.each([
    "http://cdn.fashn.ai/image",
    "https://cdn.fashn.ai.attacker.test/a",
    "https://127.0.0.1/a",
    "https://cdn.fashn.ai:8443/a",
    "https://user:password@cdn.fashn.ai/a",
    "file:///etc/passwd",
    "https://franciszzj-leffa.hf.space/gradio_api/file=/tmp/a.webp",
  ])("blocks untrusted output origin %s", (value) => {
    expect(() => validateProviderOutputUrl(value, fashnHosts)).toThrow();
  });

  it("accepts both official CDN delivery origins", () => {
    expect(
      validateProviderOutputUrl("https://cdn.fashn.ai/id/output.png", fashnHosts).hostname,
    ).toBe("cdn.fashn.ai");
    expect(
      validateProviderOutputUrl("https://media.fashn.ai/id/output.mp4", fashnHosts).hostname,
    ).toBe("media.fashn.ai");
  });

  it("accepts only the configured Hugging Face Space origins", () => {
    const hosts = ["franciszzj-leffa.hf.space"];
    expect(
      validateProviderOutputUrl(
        "https://franciszzj-leffa.hf.space/gradio_api/file=/tmp/gradio/a/image.webp",
        hosts,
      ).hostname,
    ).toBe("franciszzj-leffa.hf.space");
    expect(() =>
      validateProviderOutputUrl("https://attacker-space.hf.space/gradio_api/file=/x", hosts),
    ).toThrow();
    expect(() => validateProviderOutputUrl("https://cdn.fashn.ai/id/output.png", hosts)).toThrow();
  });

  it("bounds streaming media even without a content-length header", async () => {
    const response = new Response(new Uint8Array(1025));
    await expect(readBoundedBody(response, 1024)).rejects.toThrow("transfer limit");
    expect(await readBoundedBody(new Response("safe"), 8)).toEqual(Buffer.from("safe"));
  });
  it("validates MP4 box boundaries rather than trusting MIME or an ftyp signature alone", () => {
    const box = (type: string, content: Buffer) => {
      const size = Buffer.alloc(4);
      size.writeUInt32BE(8 + content.length);
      return Buffer.concat([size, Buffer.from(type), content]);
    };
    const headerOnly = box("ftyp", Buffer.from("isom0000"));
    const synthetic = Buffer.concat([
      headerOnly,
      box("moov", Buffer.from([0, 0, 0, 0])),
      box("mdat", Buffer.from([1, 2, 3, 4])),
    ]);
    expect(() => validateMp4Container(synthetic)).not.toThrow();
    expect(() => validateMp4Container(headerOnly)).toThrow();
    expect(() => validateMp4Container(synthetic.subarray(0, synthetic.length - 1))).toThrow(
      "Truncated",
    );
  });
});
