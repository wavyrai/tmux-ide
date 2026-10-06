// Freshness record for docs/public/tui-demo.svg.
//
// The demo is rendered from the app's own presentation code, so it goes stale
// whenever that code changes. `pnpm demo:tui` records a hash of every
// presentation file the renderer imports (its import closure, limited to the
// app's UI layer and visual tokens) in tui-demo.sources.json; check:site
// recomputes it and names the files that changed since the last render.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const RECORD = join(repoRoot, "docs/scripts/tui-demo.sources.json");
const ENTRY = "docs/scripts/render-tui-demo.tsx";
const ASSETS = [
  "docs/scripts/tui-demo-font/chars.txt",
  "docs/scripts/tui-demo-font/regular.woff2",
  "docs/scripts/tui-demo-font/bold.woff2",
];
const PRESENTATION = [
  /^docs\/scripts\//u,
  /^packages\/daemon\/src\/tui\/mirror\//u,
  /^packages\/contracts\/src\/(?:visual-[\w-]+|semantic-icons|pane-appearance)\.ts$/u,
];
const IMPORT = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:[^;]*?\s+from\s+)?["']([^"']+)["']/gu;

function resolveImport(from, specifier) {
  let base;
  if (specifier.startsWith(".")) base = resolve(dirname(from), specifier);
  else if (specifier.startsWith("@tmux-ide/")) {
    const [, name, ...rest] = specifier.split("/");
    base = join(repoRoot, "packages", name, "src", rest.join("/") || "index");
  } else return null;
  const stem = base.replace(/\.[cm]?js$/u, "");
  for (const candidate of [
    base,
    `${stem}.ts`,
    `${stem}.tsx`,
    `${stem}.mjs`,
    join(base, "index.ts"),
  ])
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return null;
}

/** Repo-relative presentation files in the renderer's value-import closure. */
export function demoSources() {
  const seen = new Set();
  const stack = [join(repoRoot, ENTRY)];
  while (stack.length > 0) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, typeOnly, specifier] of readFileSync(file, "utf8").matchAll(IMPORT)) {
      if (typeOnly) continue;
      const target = resolveImport(file, specifier);
      if (target) stack.push(target);
    }
  }
  return [
    ...[...seen]
      .map((file) => relative(repoRoot, file))
      .filter((file) => PRESENTATION.some((scope) => scope.test(file))),
    ...ASSETS,
  ].sort();
}

function digest(file) {
  const bytes = readFileSync(join(repoRoot, file));
  // Text is hashed with LF endings so a Windows checkout agrees with CI.
  const content = /\.(?:woff2)$/u.test(file)
    ? bytes
    : bytes.toString("utf8").replaceAll("\r\n", "\n");
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export function demoFingerprint() {
  return Object.fromEntries(demoSources().map((file) => [file, digest(file)]));
}

/** Files whose presentation hash differs from the recorded render. */
export function staleDemoSources() {
  if (!existsSync(RECORD)) return ["(no tui-demo.sources.json recorded)"];
  const recorded = JSON.parse(readFileSync(RECORD, "utf8")).sources ?? {};
  const current = demoFingerprint();
  return [...new Set([...Object.keys(recorded), ...Object.keys(current)])]
    .filter((file) => recorded[file] !== current[file])
    .sort();
}
