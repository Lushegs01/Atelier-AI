import sharp from "sharp";

export class MediaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaValidationError";
  }
}

export interface ValidatedImage {
  buffer: Buffer;
  mimeType: "image/jpeg" | "image/png";
  width: number;
  height: number;
  byteSize: number;
}
export const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_IMAGE_PIXELS = 40_000_000;

export function detectImageFormat(buffer: Buffer): "jpeg" | "png" | "webp" | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    return "jpeg";
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "png";
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  )
    return "webp";
  return null;
}

export async function validateImage(
  buffer: Buffer,
  maxBytes = DEFAULT_MAX_UPLOAD_BYTES,
): Promise<ValidatedImage> {
  if (!buffer.length || buffer.length > maxBytes)
    throw new MediaValidationError(
      `Choose an image smaller than ${Math.floor(maxBytes / 1024 / 1024)} MB.`,
    );
  const format = detectImageFormat(buffer);
  if (!format)
    throw new MediaValidationError(
      "Choose a JPEG, PNG or WebP photograph. SVG and animated formats are unsupported.",
    );
  const maxPixels = Number(process.env.MAX_IMAGE_PIXELS) || DEFAULT_MAX_IMAGE_PIXELS;
  try {
    const source = sharp(buffer, {
      limitInputPixels: maxPixels,
      failOn: "warning",
      animated: false,
    });
    const metadata = await source.metadata();
    if (
      !metadata.width ||
      !metadata.height ||
      metadata.width < 15 ||
      metadata.height < 15 ||
      metadata.width * metadata.height > maxPixels ||
      (metadata.pages ?? 1) > 1
    )
      throw new MediaValidationError("The photo dimensions are unsupported.");
    const ratio = metadata.width / metadata.height;
    if (ratio < 1 / 16 || ratio > 16)
      throw new MediaValidationError("Choose a photo with a conventional aspect ratio.");
    // Fully decode and re-encode; this also strips EXIF location and other metadata.
    const normalized = await (
      metadata.hasAlpha
        ? source.rotate().png()
        : source.rotate().jpeg({ quality: 95, mozjpeg: true })
    ).toBuffer({ resolveWithObject: true });
    if (normalized.data.length > maxBytes)
      throw new MediaValidationError("The normalized photo exceeds the upload limit.");
    return {
      buffer: normalized.data,
      mimeType: metadata.hasAlpha ? "image/png" : "image/jpeg",
      width: normalized.info.width,
      height: normalized.info.height,
      byteSize: normalized.data.length,
    };
  } catch (error) {
    if (error instanceof MediaValidationError) throw error;
    throw new MediaValidationError("This file could not be decoded as a safe photograph.");
  }
}

export async function createThumbnail(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer, { limitInputPixels: DEFAULT_MAX_IMAGE_PIXELS })
    .rotate()
    .resize(640, 800, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
}

/** Only documented provider CDN origins; redirects are separately rejected. */
export function validateProviderOutputUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MediaValidationError("Invalid provider output URL.");
  }
  if (
    url.protocol !== "https:" ||
    !["cdn.fashn.ai", "media.fashn.ai"].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password
  )
    throw new MediaValidationError("Untrusted provider output origin.");
  return url;
}

export async function readBoundedBody(response: Response, limit: number): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > limit)
    throw new MediaValidationError("Media exceeds the transfer limit.");
  if (!response.body) throw new MediaValidationError("Media response is empty.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new MediaValidationError("Media exceeds the transfer limit.");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (!size) throw new MediaValidationError("Media response is empty.");
  return Buffer.concat(chunks);
}

/** Parse bounded ISO BMFF top-level boxes; this validates structure, not video codec fidelity. */
export function validateMp4Container(buffer: Buffer): void {
  if (buffer.length < 32 || buffer.toString("ascii", 4, 8) !== "ftyp")
    throw new MediaValidationError("The provider did not return an MP4 container.");
  let offset = 0;
  let boxes = 0;
  let hasMovie = false;
  let hasMedia = false;
  while (offset < buffer.length) {
    if (++boxes > 100_000 || offset + 8 > buffer.length)
      throw new MediaValidationError("Invalid MP4 box structure.");
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > buffer.length) throw new MediaValidationError("Invalid MP4 extended box.");
      const largeSize = buffer.readBigUInt64BE(offset + 8);
      if (largeSize > BigInt(Number.MAX_SAFE_INTEGER))
        throw new MediaValidationError("Invalid MP4 box size.");
      size = Number(largeSize);
      header = 16;
    } else if (size === 0) size = buffer.length - offset;
    if (size < header || offset + size > buffer.length)
      throw new MediaValidationError("Truncated MP4 container.");
    if (type === "moov" && size > header) hasMovie = true;
    if (type === "mdat" && size > header) hasMedia = true;
    offset += size;
  }
  if (!hasMovie || !hasMedia)
    throw new MediaValidationError("The MP4 container lacks movie or media data.");
}
