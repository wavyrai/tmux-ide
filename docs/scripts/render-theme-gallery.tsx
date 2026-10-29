/**
 * Renders the /themes gallery: the production `tmux-ide app` Terminals view
 * once per shipped theme preset, through the same headless OpenTUI renderer
 * and SVG writer as the homepage demo (tui-demo-scene.tsx, tui-demo-svg.ts).
 *
 *   pnpm demo:themes    render, then rasterize to docs/public/themes/*.webp
 *
 * This step writes one SVG per preset and presets.json into the cache
 * directory; rasterize-theme-gallery.mjs turns them into WebP and records
 * the presets and the source fingerprint in components/themes-gallery/gallery.json.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { VISUAL_THEME_PRESETS } from "../../packages/contracts/src/visual-theme-presets.ts";
import { renderScene } from "./tui-demo-scene.tsx";
import { svgDocument } from "./tui-demo-svg.ts";

const COLS = 120;
const ROWS = 32;
const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const GALLERY_CACHE = resolve(repoRoot, "node_modules/.cache/tmux-ide-theme-gallery");

type Rgba = { readonly red: number; readonly green: number; readonly blue: number };
const hex = ({ red, green, blue }: Rgba) =>
  `#${[red, green, blue].map((value) => value.toString(16).padStart(2, "0")).join("")}`;

rmSync(GALLERY_CACHE, { recursive: true, force: true });
mkdirSync(GALLERY_CACHE, { recursive: true });
const presets = [];
for (const preset of VISUAL_THEME_PRESETS) {
  const { surfaces, text, borders, statusTone } = preset.overrides;
  if (
    !surfaces?.canvas ||
    !text?.primary ||
    !borders?.focused ||
    !statusTone?.success ||
    !statusTone.warning ||
    !statusTone.danger
  )
    throw new Error(`Preset ${preset.id} lacks a colour the gallery swatches show`);
  const frame = await renderScene({
    cols: COLS,
    rows: ROWS,
    surface: "terminals",
    focusedPane: "pane.claude",
    mode: preset.appearance,
    preset: preset.id,
  });
  writeFileSync(
    resolve(GALLERY_CACHE, `${preset.id}.svg`),
    await svgDocument([{ label: "Terminals", frame }], { cols: COLS, rows: ROWS }, 0),
  );
  presets.push({
    id: preset.id,
    name: preset.name,
    appearance: preset.appearance,
    swatches: {
      background: hex(surfaces.canvas),
      text: hex(text.primary),
      accent: hex(borders.focused),
      success: hex(statusTone.success),
      warning: hex(statusTone.warning),
      danger: hex(statusTone.danger),
    },
  });
}
writeFileSync(resolve(GALLERY_CACHE, "presets.json"), JSON.stringify(presets));
process.stdout.write(`Rendered ${presets.length} theme presets into ${GALLERY_CACHE}\n`);
