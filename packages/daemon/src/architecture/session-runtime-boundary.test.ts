import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const CLIENT_ROOTS = [
  "apps/desktop-renderer/src",
  "packages/daemon-client/src",
  "packages/sdk/src",
  "packages/daemon/src/tui",
] as const;

const DIRECT_CONTROL_CONSTRUCTION = /\bnew\s+(?:SessionMirror|ControlModeClient)\s*\(/u;
const M56_4_DELETION_TARGET = [
  "packages/daemon/src/tui/mirror/app.tsx",
  "packages/daemon/src/tui/mirror/session-mirror.ts",
] as const;

const CONTROL_OWNERSHIP_IMPORT =
  /(?:from\s+|import\s*\(\s*)["'][^"']*(?:session-mirror|control-client|terminal\/mirror\/(?:mirror-service|control-channel|session-channel)|terminal\/pane-stream\/runtime)\.ts["']/u;
const M56_4_DEPENDENCY_DELETION_TARGET = [
  "packages/daemon/src/tui/mirror/app.tsx",
  "packages/daemon/src/tui/mirror/pane-frame-state.ts",
  "packages/daemon/src/tui/mirror/pane-surface.tsx",
  "packages/daemon/src/tui/mirror/session-mirror.ts",
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

describe("one SessionRuntime import DAG", () => {
  it("freezes the two actual direct control owners for deletion in m56.4", async () => {
    expect(await matches(DIRECT_CONTROL_CONSTRUCTION)).toEqual([...M56_4_DELETION_TARGET].sort());
  });

  it("freezes every client dependency on control ownership for deletion in m56.4", async () => {
    expect(await matches(CONTROL_OWNERSHIP_IMPORT)).toEqual(
      [...M56_4_DEPENDENCY_DELETION_TARGET].sort(),
    );
  });

  it("separately freezes direct tmux command and polling debt for deletion in m56.6", async () => {
    expect(await matches(DIRECT_TMUX_BRIDGE_IMPORT)).toEqual([...M56_6_DELETION_TARGET].sort());
  });
});
