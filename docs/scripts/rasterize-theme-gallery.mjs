// Second step of `pnpm demo:themes`: turns the SVGs render-theme-gallery.tsx
// left in the cache into WebP files for /themes, then records the presets and
// the source fingerprint (tui-demo-sources.mjs) in gallery.json, so
// check:tui-demo fails when the app's theme code changes without a re-render.
//
// Only the presets in shown-presets.mjs are published. Each gets a thumbnail (THUMB_WIDTH wide) and a full-size view at
// twice the SVG's own size. Chromium encodes the WebP from a canvas.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";
import { format, resolveConfig } from "prettier";

import { SHOWN_PRESETS } from "../components/themes-gallery/shown-presets.mjs";
import { GALLERY_RECORD, galleryFingerprint } from "./tui-demo-sources.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CACHE = resolve(repoRoot, "node_modules/.cache/tmux-ide-theme-gallery");
const OUT = resolve(repoRoot, "docs/public/themes");
const THUMB_WIDTH = 960;
const QUALITY = 0.82;

const presets = JSON.parse(readFileSync(resolve(CACHE, "presets.json"), "utf8"));
const unknown = SHOWN_PRESETS.filter(({ id }) => !presets.some((preset) => preset.id === id));
if (unknown.length > 0)
  throw new Error(
    `shown-presets.mjs names presets the app does not ship: ${unknown.map(({ id }) => id)}`,
  );
const shown = new Set(SHOWN_PRESETS.map(({ id }) => id));
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();
let size;
for (const preset of presets.filter(({ id }) => shown.has(id))) {
  const svg = readFileSync(resolve(CACHE, `${preset.id}.svg`), "utf8");
  const declared = /<svg[^>]*\swidth="([\d.]+)" height="([\d.]+)"/u.exec(svg);
  if (!declared) throw new Error(`${preset.id}.svg has no declared size`);
  const [width, height] = [Number(declared[1]), Number(declared[2])];
  const targets = [
    { file: `${preset.id}.webp`, width: THUMB_WIDTH },
    { file: `${preset.id}-full.webp`, width: Math.round(width * 2) },
  ];
  const encoded = await page.evaluate(
    async ({ svg, width, height, targets, quality }) => {
      const image = new Image();
      image.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
      await image.decode();
      // Fonts inside an SVG image load asynchronously; give them a frame.
      await new Promise((done) => setTimeout(done, 300));
      return targets.map((target) => {
        const canvas = document.createElement("canvas");
        canvas.width = target.width;
        canvas.height = Math.round((target.width * height) / width);
        canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
        return {
          file: target.file,
          width: canvas.width,
          height: canvas.height,
          data: canvas.toDataURL("image/webp", quality),
        };
      });
    },
    { svg, width, height, targets, quality: QUALITY },
  );
  for (const { file, data } of encoded) {
    if (!data.startsWith("data:image/webp;base64,"))
      throw new Error(`Chromium did not encode ${file} as WebP`);
    writeFileSync(resolve(OUT, file), Buffer.from(data.split(",")[1], "base64"));
  }
  size = {
    thumb: { width: encoded[0].width, height: encoded[0].height },
    full: { width: encoded[1].width, height: encoded[1].height },
  };
}
await browser.close();

const record = {
  regenerate: "pnpm demo:themes",
  size,
  presets,
  sources: galleryFingerprint(),
};
const options = (await resolveConfig(GALLERY_RECORD)) ?? {};
writeFileSync(
  GALLERY_RECORD,
  await format(JSON.stringify(record), { ...options, filepath: GALLERY_RECORD }),
);
const bytes = readdirSync(OUT).reduce(
  (total, file) => total + readFileSync(resolve(OUT, file)).length,
  0,
);
process.stdout.write(
  `Wrote ${shown.size * 2} WebP files (${Math.round(bytes / 1024)} KB) to docs/public/themes\n`,
);
