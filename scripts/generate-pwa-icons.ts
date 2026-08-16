/**
 * Rasterises the PWA icon set in public/brand/ from the three brand SVGs.
 *
 * WHY RASTER AT ALL. An SVG in the manifest is not reliably honoured as
 * `maskable` by Android launchers, and maskable is the whole reason the entry
 * exists: it is the promise that the launcher may crop this bitmap to whatever
 * shape the device uses without cutting the glyph. A launcher that will not
 * treat the SVG as maskable falls back to letterboxing the icon inside a white
 * square, which is the exact look the maskable purpose exists to avoid.
 *
 * WHY THE OUTPUT IS COMMITTED. `next build` must not depend on anyone having
 * run this. A manifest that points at PNGs which only exist on the machine that
 * last ran the script ships 404s, and Chrome answers a manifest with missing
 * icons by silently declining to offer the install prompt at all - no error,
 * just no PWA. Same rule as scripts/generate-md3-tokens.ts: run it when a
 * source SVG changes, commit the result in the same PR.
 *
 *   npm run gen:icons
 *
 * src/app/manifest.test.ts asserts every icon the manifest declares exists on
 * disk as a PNG of its declared pixel size, so the two cannot drift.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import sharp from "sharp";

/** The manifest declares 192 (home screen) and 512 (splash, store listings). */
const SIZES = [192, 512] as const;

const SOURCES = [
  // Rounded square with its own ground - the browser/`any` icon.
  { source: "icon.svg", stem: "icon" },
  // Full-bleed ground, glyph inside the 60% safe zone - the launcher crops it.
  { source: "icon-maskable.svg", stem: "icon-maskable" },
  // Transparent ground, single colour - the launcher re-tints the alpha.
  { source: "icon-monochrome.svg", stem: "icon-monochrome" },
] as const;

const BRAND_DIR = join(process.cwd(), "public", "brand");

/** The viewBox every brand SVG uses. Density is scaled off it so the rasteriser
 *  renders AT the target size instead of rendering small and upscaling. */
const VIEWBOX = 64;
const BASE_DENSITY = 72;

async function main(): Promise<void> {
  for (const { source, stem } of SOURCES) {
    const svg = readFileSync(join(BRAND_DIR, source));

    for (const size of SIZES) {
      const png = await sharp(svg, { density: (BASE_DENSITY * size) / VIEWBOX })
        .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();

      const out = join(BRAND_DIR, `${stem}-${size}.png`);
      writeFileSync(out, png);
      console.log(`wrote public/brand/${stem}-${size}.png (${png.length} bytes)`);
    }
  }
}

// Not top-level await: tsx transforms this file to CJS, where that is a syntax
// error. Rethrowing keeps a failed rasterisation a non-zero exit.
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
