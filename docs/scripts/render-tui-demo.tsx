/**
 * Renders docs/public/tui-demo.svg from the production `tmux-ide app` shell.
 *
 *   pnpm demo:tui            regenerate the SVG, the landing mini-figures
 *                            (tui-mini-figure-frames.json) and the fingerprint
 *   pnpm demo:tui --text     also print each frame as plain text (for review)
 *
 * The frames are the real ApplicationShellView composition — machine sidebar,
 * Home agent roster, palette commands, pane headers, footer hints — rendered
 * headlessly with OpenTUI's test renderer over the fixture fleet in
 * tui-demo-fixture.ts. Only the terminal *contents* are invented. Glyphs ship
 * inside the SVG as a Geist Mono subset so it looks the same on every OS.
 */
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { demoFingerprint, RECORD } from "./tui-demo-sources.mjs";
import { frameText, renderScene, type Scene } from "./tui-demo-scene.tsx";
import { FONT_DIR_PATH, svgDocument, type DemoFrame } from "./tui-demo-svg.ts";
import { figureDocument } from "./tui-demo-figure-markup.ts";

const COLS = 160;
const ROWS = 44;
const OUTPUT = resolve("docs/public/tui-demo.svg");
const FIGURES = resolve("docs/components/marketing/tui-mini-figure-frames.json");
const FONTS = resolve("docs/public/fonts");
const SPRITE = resolve("docs/public/tui-figures.svg");

const scene: Scene = { cols: COLS, rows: ROWS, surface: "terminals", focusedPane: "pane.claude" };
const frames: DemoFrame[] = [
  { label: "Home", frame: await renderScene({ ...scene, surface: "home" }) },
  { label: "Terminals", frame: await renderScene(scene) },
  { label: "Commands", frame: await renderScene({ ...scene, paletteOpen: true }) },
];
if (process.argv.includes("--text"))
  for (const { label, frame } of frames)
    process.stdout.write(`--- ${label}\n${frameText(frame)}\n`);
mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, await svgDocument(frames, { cols: COLS, rows: ROWS }, 1));
const figures = await figureDocument();
writeFileSync(FIGURES, `${JSON.stringify(figures.document, null, 2)}\n`);
writeFileSync(SPRITE, figures.sprite);
// The inline figures use the same glyph subset, served once for the page.
mkdirSync(FONTS, { recursive: true });
for (const weight of ["regular", "bold"])
  copyFileSync(
    resolve(FONT_DIR_PATH, `${weight}.woff2`),
    resolve(FONTS, `tui-demo-${weight}.woff2`),
  );
writeFileSync(
  RECORD,
  `${JSON.stringify({ regenerate: "pnpm demo:tui", sources: demoFingerprint() }, null, 2)}\n`,
);
process.stdout.write(
  `Rendered ${OUTPUT} from ${frames.length} production OpenTUI frames and ` +
    `${Object.keys(figures.document.figures).length} landing figures.\n`,
);
