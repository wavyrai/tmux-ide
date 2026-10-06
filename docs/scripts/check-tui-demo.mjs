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

if (failures.length > 0) {
  console.error(`TUI demo check failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("TUI demo verified: current with the app's presentation code, self-contained glyphs.");
