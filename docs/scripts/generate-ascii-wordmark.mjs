import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const outputPath = resolve(import.meta.dirname, "../public/ascii-wordmark.svg");
// Marketing keeps its large wordmark; the application's compact Home no longer
// renders it. Do not couple documentation generation to private screen constants.
const lines = `   ░██                                             ░██       ░██
   ░██                                                       ░██
░████████ ░█████████████  ░██    ░██ ░██    ░██    ░██ ░████████  ░███████
   ░██    ░██   ░██   ░██ ░██    ░██  ░██  ░██     ░██░██    ░██ ░██    ░██
   ░██    ░██   ░██   ░██ ░██    ░██   ░█████      ░██░██    ░██ ░█████████
   ░██    ░██   ░██   ░██ ░██   ░███  ░██  ░██     ░██░██   ░███ ░██
    ░████ ░██   ░██   ░██  ░█████░██ ░██    ░██    ░██ ░█████░██  ░███████`.split("\n");
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
process.stdout.write(`Generated ${outputPath} from the docs marketing wordmark\n`);
