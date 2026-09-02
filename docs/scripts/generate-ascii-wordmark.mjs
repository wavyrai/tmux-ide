import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const sourcePath = resolve(
  import.meta.dirname,
  "../../packages/daemon/src/tui/mirror/runtime/application-shell-home.tsx",
);
const outputPath = resolve(import.meta.dirname, "../public/ascii-wordmark.svg");
const source = readFileSync(sourcePath, "utf8");
const match = source.match(/const APPLICATION_HOME_FULL_LOGO = `([\s\S]*?)`;/u);

if (!match) throw new Error(`Could not find APPLICATION_HOME_FULL_LOGO in ${sourcePath}`);

const lines = match[1].split("\n");
const cellWidth = 8.4;
const cellHeight = 18;
const width = Math.max(...lines.map((line) => [...line].length)) * cellWidth;
const height = lines.length * cellHeight;
const escapeXml = (value) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const rows = lines
  .map((line, index) => `<text x="0" y="${index * cellHeight + 14}">${escapeXml(line)}</text>`)
  .join("\n  ");

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title" viewBox="0 0 ${width} ${height}">
  <title id="title">tmux-ide</title>
  <style>
    text { fill: #171717; font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; font-size: 13px; white-space: pre; }
  </style>
  ${rows}
</svg>
`;

writeFileSync(outputPath, svg);
process.stdout.write(`Generated ${outputPath} from the production OpenTUI wordmark\n`);
