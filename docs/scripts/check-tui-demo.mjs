import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { staleDemoSources } from "./tui-demo-sources.mjs";

const docsDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const svg = readFileSync(resolve(docsDir, "public/tui-demo.svg"), "utf8");
const failures = [];

const stale = staleDemoSources();
if (stale.length > 0)
  failures.push(
    "docs/public/tui-demo.svg is older than the app code it shows. Run `pnpm demo:tui` from " +
      "the repo root and commit docs/public/tui-demo.svg and docs/scripts/tui-demo.sources.json. " +
      `Changed since the last render:\n    ${stale.join("\n    ")}`,
  );
// Loaded as an <img>, the SVG cannot reach page fonts: it must carry its own.
if ((svg.match(/src:url\(data:font\/woff2;base64,/gu) ?? []).length !== 2)
  failures.push("tui-demo.svg must embed its regular and bold demo font subsets");
if (/SFMono|Consolas|Menlo|Liberation Mono/u.test(svg))
  failures.push("tui-demo.svg must not depend on system monospace fonts");
if (!/<title id="t">[^<]+<\/title>/u.test(svg) || !/<desc id="d">[^<]+<\/desc>/u.test(svg))
  failures.push("tui-demo.svg needs an accessible title and description");
if (!/@media \(prefers-reduced-motion:reduce\)/u.test(svg))
  failures.push("tui-demo.svg needs a reduced-motion still frame");

// The hero <Image> reserves the SVG's declared size (no layout shift).
const size = JSON.parse(
  readFileSync(resolve(docsDir, "components/marketing/tui-demo-size.json"), "utf8"),
);
const declared = svg.match(/<svg[^>]*\swidth="([\d.]+)" height="([\d.]+)"/u);
if (
  !declared ||
  size.width !== Math.ceil(Number(declared[1])) ||
  size.height !== Math.ceil(Number(declared[2]))
)
  failures.push(
    "tui-demo-size.json does not match tui-demo.svg's declared size; run `pnpm demo:tui`",
  );

// The landing mini-figures: one sprite, one cursor performance per figure.
const frames = JSON.parse(
  readFileSync(resolve(docsDir, "components/marketing/tui-mini-figure-frames.json"), "utf8"),
);
const sprite = readFileSync(resolve(docsDir, "public/tui-figures.svg"));
const spriteHash = createHash("sha256").update(sprite).digest("hex").slice(0, 10);
if (frames.sprite !== `/tui-figures.svg?v=${spriteHash}`)
  failures.push(
    "tui-mini-figure-frames.json does not match public/tui-figures.svg; run `pnpm demo:tui`",
  );
const variants = Object.keys(frames.figures).sort();
for (const variant of variants)
  for (const state of ["before", "after"])
    if (!sprite.includes(`id="${variant}-${state}"`))
      failures.push(`tui-figures.svg lacks #${variant}-${state}`);
// Each figure says how the reader's "You" cursor performs its action.
for (const [variant, figure] of Object.entries(frames.figures)) {
  const cursor = figure.cursor;
  const point = (p) => Array.isArray(p) && p.length === 2 && p.every((v) => v >= 0 && v <= 100);
  if (
    !cursor ||
    "actor" in cursor ||
    !["click", "drag", "hover"].includes(cursor.kind) ||
    ![cursor.from, cursor.at, cursor.to].every(point)
  )
    failures.push(`${variant} figure needs a "You" cursor path with from/at/to inside the figure`);
}
const icons = readFileSync(resolve(docsDir, "components/icons/sprite.svg"), "utf8");
if (!icons.includes('<symbol id="cursor-arrow"'))
  failures.push("components/icons/sprite.svg lacks the #cursor-arrow symbol the cursors draw");

if (failures.length > 0) {
  console.error(`TUI demo check failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(
  `TUI demo verified: current with the app's presentation code, self-contained glyphs, ${variants.length} figures with cursor paths.`,
);
