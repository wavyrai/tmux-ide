import { access, readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OPENTUI_PRODUCTION_ROOT_SOURCES } from "../../test-support/opentui-production-root-manifest.ts";
import { loadLocalSourceImportGraph } from "../../test-support/source-import-graph.ts";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const CLIENT_ROOTS = [
  "apps/desktop-renderer/src",
  "packages/daemon-client/src",
  "packages/sdk/src",
  "packages/daemon/src/tui",
] as const;

const REQUIRED_SEMANTIC_RUNTIME_LANE = [
  "packages/daemon/src/tui/mirror/open-tui-workspace-runtime-port.ts",
  "packages/daemon/src/tui/mirror/semantic-pane-render-source.ts",
  "packages/daemon/src/tui/mirror/runtime/workspace-terminal-fast-lane.ts",
  "packages/daemon/src/tui/mirror/runtime/terminal-fast-lane-renderer-adapter.ts",
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

async function productionImportGraph(): Promise<string[]> {
  return (await loadLocalSourceImportGraph(REPO, OPENTUI_PRODUCTION_ROOT_SOURCES)).files.slice();
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

describe("terminal inventory read boundary", () => {
  it("keeps async discovery separate from synchronous attachment proof and mutation", async () => {
    const source = await readFile(
      join(REPO, "packages/daemon/src/terminal/attachments/native-runtime.ts"),
      "utf8",
    );

    expect(source).toContain("this.runner = pinnedRunner(authority, execute");
    expect(source).toContain("this.readRunner = pinnedReadRunner(authority, executeRead)");
    expect(source).toContain(
      "const executeRead = options.readCommandExecutor ?? defaultReadCommandExecutor",
    );
    expect(source).not.toContain("options.commandExecutor!(executable, argv, readOptions)");
    expect(source).toContain("runner: this.runner");
    expect(source).toContain("this.readRunner,\n      abort.signal");
    const asyncExecutor = source.slice(
      source.indexOf("function defaultReadCommandExecutor"),
      source.indexOf("function pinnedRunner"),
    );
    expect(asyncExecutor).toMatch(/\bexecFile\s*\(/u);
    expect(asyncExecutor).not.toMatch(/\bexecFileSync\s*\(/u);
    expect(source).not.toContain("#inventorySnapshot");
  });
});
