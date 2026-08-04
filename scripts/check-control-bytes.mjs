/**
 * Repo gate: no raw control bytes in tracked source files.
 *
 * Agents have repeatedly embedded raw NUL/ESC bytes as composite-key
 * separators or fixture content. A staged-DIFF scan cannot catch this:
 * once a file contains a NUL, git classifies it as binary and the diff
 * shows "Binary files differ" with no bytes to scan. So this gate scans
 * the full content of every tracked text source file instead.
 *
 * Allowed: tab (0x09), newline (0x0a), carriage return (0x0d).
 * Everything else in 0x00-0x1f fails the gate with file:line locations.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const TEXT_EXTENSIONS = [
  "*.ts",
  "*.tsx",
  "*.mts",
  "*.cts",
  "*.js",
  "*.jsx",
  "*.mjs",
  "*.cjs",
  "*.json",
  "*.md",
  "*.yml",
  "*.yaml",
  "*.css",
  "*.html",
  "*.sh",
];

const files = execFileSync("git", ["ls-files", "-z", "--", ...TEXT_EXTENSIONS], {
  maxBuffer: 64 * 1024 * 1024,
})
  .toString("utf8")
  .split("\u0000")
  .filter(Boolean);

// eslint-disable-next-line no-control-regex -- matching control bytes is this gate's entire job
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

const failures = [];
for (const file of files) {
  const content = readFileSync(file, "latin1");
  if (!CONTROL.test(content)) continue;
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = CONTROL.exec(lines[index]);
    if (match) {
      const code = match[0].charCodeAt(0).toString(16).padStart(2, "0");
      failures.push(`${file}:${index + 1} contains control byte 0x${code}`);
    }
  }
}

if (failures.length > 0) {
  console.error("[check-control-bytes] FAILED:");
  for (const failure of failures) console.error(`  ${failure}`);
  console.error(
    "[check-control-bytes] replace raw control bytes with escape sequences (e.g. \\u0000).",
  );
  process.exit(1);
}

console.log(`[check-control-bytes] ${files.length} tracked source files clean.`);
