// Run via: npx tsx scripts/generate-icons.ts
//
// Renders three flat-color PNGs into `public/icons/`:
//   icon-192.png             192x192, opaque background, glyph filling ~60%
//   icon-512.png             512x512, opaque background, glyph filling ~60%
//   icon-maskable-512.png    512x512, glyph constrained to 80% inner safe area
//
// The maskable variant must keep its glyph inside the central 80% so OS
// shells (Android adaptive icons, iOS rounded squares) can crop without
// clipping the design.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";

const OUT = resolve("public/icons");
mkdirSync(OUT, { recursive: true });

const svg = (size: number, padded: boolean): string => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="#18181b"/>
  <text x="50%" y="50%" font-size="${padded ? size * 0.45 : size * 0.6}"
        font-family="-apple-system, BlinkMacSystemFont, sans-serif"
        font-weight="700" fill="#fafafa"
        text-anchor="middle" dominant-baseline="central">E</text>
</svg>`;

async function main(): Promise<void> {
  await sharp(Buffer.from(svg(192, false))).png().toFile(`${OUT}/icon-192.png`);
  await sharp(Buffer.from(svg(512, false))).png().toFile(`${OUT}/icon-512.png`);
  await sharp(Buffer.from(svg(512, true)))
    .png()
    .toFile(`${OUT}/icon-maskable-512.png`);
  console.log("Generated icons at", OUT);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
