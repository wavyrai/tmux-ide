import { access, readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const CLIENT_ROOTS = [
  "apps/desktop-renderer/src",
  "packages/daemon-client/src",
  "packages/sdk/src",
  "packages/daemon/src/tui",
] as const;

const OPENTUI_PRODUCTION_ROOTS = ["packages/daemon/src/tui/mirror/app.tsx"] as const;

const REQUIRED_SEMANTIC_RUNTIME_LANE = [
  "packages/daemon/src/tui/mirror/application-shell-daemon-runtime.ts",
  "packages/daemon/src/tui/mirror/semantic-pane-render-source.ts",
] as const;

const LEGACY_CONTROL_STACK = [
  "packages/daemon/src/tui/mirror/control-client.ts",
  "packages/daemon/src/tui/mirror/session-mirror.ts",
  "packages/daemon/src/tui/mirror/window-size-policy.ts",
] as const;

const DIRECT_LEGACY_AUTHORITY =
  /\bnew\s+(?:SessionMirror|ControlModeClient)\s*\(|\bmirror!?\s*(?:\?\.|\.)\s*(?:command|focus|resize|resizeToFit|sendKey|sendText|sendTextTo|switchWindow)\s*\(/u;
const SECOND_TMUX_CONTROL_CLIENT = /\bspawn\s*\(\s*["']tmux["']\s*,\s*\[[\s\S]{0,240}?["']-C["']/u;
const RAW_WINDOW_SIZE_AUTHORITY =
  /window-size\s+manual|["']window-size["']\s*,\s*["']manual["']|resize-window\s+-[axy]|\.resizeToFit\s*\(/u;
const RAW_FOCUS_AUTHORITY =
  /(?:execFile|spawn|execFileSync)\s*\(\s*["']tmux["'][\s\S]{0,160}?["']select-(?:pane|window)["']/u;

const MIRROR_SERVICE_CONSTRUCTION = /\bnew\s+MirrorService\s*\(/u;
const SESSION_RUNTIME_CONTROL_OWNER = [
  "packages/daemon/src/terminal/session-runtime/registry.ts",
] as const;

const DIRECT_TMUX_BRIDGE_IMPORT = /["']@tmux-ide\/tmux-bridge["']/u;
const M56_6_DELETION_TARGET = [
  "packages/daemon/src/tui/chrome/notify.ts",
  "packages/daemon/src/tui/chrome/sidebar.ts",
  "packages/daemon/src/tui/chrome/snapshot.ts",
  "packages/daemon/src/tui/chrome/statusline.ts",
  "packages/daemon/src/tui/chrome/updater.ts",
  "packages/daemon/src/tui/detect/snapshot.ts",
  "packages/daemon/src/tui/team/index.tsx",
  "packages/daemon/src/tui/team/projects.ts",
  "packages/daemon/src/tui/team/wait.ts",
] as const;

async function sourceFiles(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) result.push(...(await sourceFiles(child)));
    else if (
      [".ts", ".tsx"].includes(extname(entry.name)) &&
      !entry.name.includes(".test.") &&
      !child.includes("/__snapshots__/")
    ) {
      result.push(child);
    }
  }
  return result;
}

async function matches(pattern: RegExp): Promise<string[]> {
  const findings: string[] = [];
  for (const root of CLIENT_ROOTS) {
    for (const file of await sourceFiles(join(REPO, root))) {
      if (pattern.test(await readFile(file, "utf8"))) findings.push(relative(REPO, file));
    }
  }
  return findings.sort();
}

async function matchesUnder(root: string, pattern: RegExp): Promise<string[]> {
  const findings: string[] = [];
  for (const file of await sourceFiles(join(REPO, root))) {
    if (pattern.test(await readFile(file, "utf8"))) findings.push(relative(REPO, file));
  }
  return findings.sort();
}

const LOCAL_MODULE_REFERENCE = /(?:from\s*|import\s*\(\s*|import\s*)["'](\.{1,2}\/[^"']+)["']/gu;

async function firstExisting(candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next TypeScript source spelling.
    }
  }
  return null;
}

async function resolveLocalModule(importer: string, specifier: string): Promise<string | null> {
  const absolute = resolve(dirname(importer), specifier);
  const extension = extname(absolute);
  const withoutJs =
    extension === ".js" || extension === ".jsx" ? absolute.slice(0, -extension.length) : null;
  return firstExisting([
    absolute,
    ...(extension
      ? []
      : [
          `${absolute}.ts`,
          `${absolute}.tsx`,
          join(absolute, "index.ts"),
          join(absolute, "index.tsx"),
        ]),
    ...(withoutJs ? [`${withoutJs}.ts`, `${withoutJs}.tsx`] : []),
  ]);
}

async function productionImportGraph(): Promise<string[]> {
  const pending = OPENTUI_PRODUCTION_ROOTS.map((file) => join(REPO, file));
  const visited = new Set<string>();

  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(LOCAL_MODULE_REFERENCE)) {
      const imported = await resolveLocalModule(file, match[1]!);
      if (imported && imported.startsWith(REPO)) pending.push(imported);
    }
  }

  return [...visited].map((file) => relative(REPO, file)).sort();
}

async function productionMatches(pattern: RegExp): Promise<string[]> {
  const findings: string[] = [];
  for (const file of await productionImportGraph()) {
    const source = await readFile(join(REPO, file), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
    if (pattern.test(code)) findings.push(file);
  }
  return findings.sort();
}

describe("one SessionRuntime import DAG", () => {
  it("allows exactly one production MirrorService construction owner", async () => {
    expect(await matchesUnder("packages/daemon/src", MIRROR_SERVICE_CONSTRUCTION)).toEqual(
      [...SESSION_RUNTIME_CONTROL_OWNER].sort(),
    );
  });

  it("routes the OpenTUI production app through the semantic SessionRuntime lane", async () => {
    const production = await productionImportGraph();
    expect(production).toEqual(expect.arrayContaining([...REQUIRED_SEMANTIC_RUNTIME_LANE]));
  });

  it("deletes the legacy control stack instead of merely leaving it unreachable", async () => {
    const existing: string[] = [];
    for (const file of LEGACY_CONTROL_STACK) {
      try {
        await access(join(REPO, file));
        existing.push(file);
      } catch {
        // Expected: one SessionRuntime owner replaces these files outright.
      }
    }
    expect(existing).toEqual([]);
  });

  it("forbids direct mirror construction, input, focus, command, and geometry authority", async () => {
    expect(await productionMatches(DIRECT_LEGACY_AUTHORITY)).toEqual([]);
  });

  it("forbids a second tmux -C client in the OpenTUI app", async () => {
    expect(await productionMatches(SECOND_TMUX_CONTROL_CLIENT)).toEqual([]);
  });

  it("forbids raw window-size and resize-preview authority in the OpenTUI app", async () => {
    expect(await productionMatches(RAW_WINDOW_SIZE_AUTHORITY)).toEqual([]);
  });

  it("forbids raw tmux pane/window focus mutation in the OpenTUI app", async () => {
    expect(await productionMatches(RAW_FOCUS_AUTHORITY)).toEqual([]);
  });

  it("separately freezes direct tmux command and polling debt for deletion in m56.6", async () => {
    expect(await matches(DIRECT_TMUX_BRIDGE_IMPORT)).toEqual([...M56_6_DELETION_TARGET].sort());
  });
});
