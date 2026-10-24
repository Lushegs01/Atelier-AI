import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const directory = new URL("../public/icons/", import.meta.url);
await mkdir(directory, { recursive: true });
for (const size of [192, 512]) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512"><rect width="512" height="512" rx="110" fill="#183952"/><path d="M117 383L254 112L394 383M169 296H342M196 383L267 235L335 383" fill="none" stroke="#fff" stroke-width="15" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  await sharp(Buffer.from(svg))
    .png()
    .toFile(fileURLToPath(new URL(`icon-${size}.png`, directory)));
}
await sharp(
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#183952"/><path d="M144 365L254 148L366 365M186 295H324M208 365L266 247L321 365" fill="none" stroke="#fff" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ),
)
  .png()
  .toFile(fileURLToPath(new URL("maskable-512.png", directory)));
console.log("Generated 192px, 512px and maskable PWA icons.");
