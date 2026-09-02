#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const output = execFileSync(
  "npm",
  ["pack", "--dry-run", "--json", "--ignore-scripts", "--cache", "/tmp/tmux-ide-npm-cache"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
);
const report = JSON.parse(output)[0];
const files = new Set(report.files.map((entry) => entry.path));
const index = "apps/desktop-renderer/dist/index.html";
if (!files.has(index)) throw new Error(`npm package is missing ${index}`);
const assets = [...files].filter((path) => path.startsWith("apps/desktop-renderer/dist/assets/"));
if (assets.length === 0) throw new Error("npm package has no production Web GUI assets");
if (!files.has("bin/cli.js")) throw new Error("npm package is missing bin/cli.js");
process.stdout.write(
  `[pack-web-check] packaged production Web GUI (${assets.length} assets, ${report.size} bytes)\n`,
);
