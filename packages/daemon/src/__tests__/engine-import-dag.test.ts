import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The core/adapter direction gate (m47 stage 1).
 *
 * tmux-ide is one engine with heads over it: only the core touches tmux, and
 * the TUI (`src/tui`) and widget (`src/widgets`) surfaces are adapters that
 * render and express intent. Imports therefore flow adapter -> core and never
 * back. This test walks every source file under the engine roots and fails on
 * any import that reaches into an adapter.
 *
 * `KNOWN_INVERSIONS` is an honest ledger of the inversions that predate the
 * gate, not a permission slip: each entry is engine code that still lives under
 * an adapter directory and is scheduled to move. The list may only shrink — a
 * new inversion fails this test, and so does an entry that no longer exists.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");

const ENGINE_ROOTS = ["terminal", "command-center", "lib", "server"] as const;
const ADAPTER_ROOTS = ["tui", "widgets"] as const;

/**
 * Engine modules that still live under `src/tui` or `src/widgets`. Every entry
 * is a file-move away from resolution and is tracked as m47 stage-3 work:
 *
 * - `tui/detect/*` — the two-layer agent-detection engine (authority parse,
 *   process-tree resolution, screen manifests). Pure core; the TUI is one of
 *   several consumers.
 * - `tui/integrations/*` — the agent hook installers. Core lifecycle wiring.
 * - `widgets/lib/pane-comms.ts` — tmux pane enumeration and messaging helpers.
 *   Core tmux access that predates the `terminal/` engine home.
 * - `widgets/resolve.ts` — the one entry that is a true engine -> adapter call:
 *   the HTTP widget-spawn route reaches into the adapter to learn how a widget
 *   pane launches. It resolves by inverting the dependency (the adapter
 *   registers its spawn recipes with the core), not by moving a file.
 */
const KNOWN_INVERSIONS: readonly string[] = [
  "command-center/discovery.ts -> widgets/lib/pane-comms.ts",
  "command-center/filesystem.test.ts -> widgets/lib/pane-comms.ts",
  "command-center/projects.test.ts -> widgets/lib/pane-comms.ts",
  "command-center/resources/application-shell.test.ts -> widgets/lib/pane-comms.ts",
  "command-center/resources/application-shell.ts -> tui/detect/agent-resolution.ts",
  "command-center/resources/application-shell.ts -> tui/detect/classify.ts",
  "command-center/server.ts -> widgets/lib/pane-comms.ts",
  "command-center/server.ts -> widgets/resolve.ts",
  "lib/__tests__/manifest-pack.test.ts -> tui/detect/manifest-loader.ts",
  "lib/agent-discovery.ts -> tui/integrations/claude.ts",
  "lib/agent-discovery.ts -> tui/integrations/opencode.ts",
  "lib/app-config.ts -> tui/detect/classify.ts",
  "lib/manifest-pack.ts -> tui/detect/manifest-loader.ts",
  "lib/manifest-pack.ts -> tui/detect/manifest.ts",
  "terminal/__tests__/agent-status-probe.test.ts -> tui/detect/manifest.ts",
  "terminal/__tests__/agent-status-probe.test.ts -> tui/detect/process-tree.ts",
  "terminal/attachments/agent-status-probe.ts -> tui/detect/classify.ts",
  "terminal/attachments/agent-status-probe.ts -> tui/detect/manifest.ts",
  "terminal/attachments/agent-status-probe.ts -> tui/detect/process-tree.ts",
  "terminal/attachments/agent-status-probe.ts -> tui/detect/snapshot.ts",
  // Temporary test-only differential oracle; production imports remain adapter -> engine.
  "terminal/session-runtime/terminal-replica-shadow-projections.test.ts -> tui/mirror/pane-mirror.ts",
];

function sourceFiles(root: string): string[] {
  const found: string[] = [];
  const pending = [resolve(SRC, root)];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") pending.push(full);
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        found.push(full);
      }
    }
  }
  return found;
}

/** Every import specifier, including `import type` — a type-only reach into an
 *  adapter still encodes the wrong ownership. */
function importSpecifiers(source: string): string[] {
  return [
    ...source.matchAll(/\b(?:from\s+|import\s*\(\s*)["']([^"']+)["']/gu),
    ...source.matchAll(/^\s*import\s*["']([^"']+)["']/gmu),
  ].map((match) => match[1]!);
}

function adapterEdges(): string[] {
  const edges: string[] = [];
  for (const root of ENGINE_ROOTS) {
    for (const file of sourceFiles(root)) {
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        if (!specifier.startsWith(".")) continue;
        const target = relative(SRC, resolve(dirname(file), specifier));
        if (!ADAPTER_ROOTS.some((adapter) => target.startsWith(adapter + "/"))) continue;
        edges.push(`${relative(SRC, file)} -> ${target}`);
      }
    }
  }
  return [...new Set(edges)].sort();
}

describe("engine/adapter import direction", () => {
  it("keeps the engine free of imports from the TUI and widget adapters", () => {
    expect(adapterEdges()).toEqual([...KNOWN_INVERSIONS].sort());
  });

  it("has no protocol library left behind in the TUI adapter", () => {
    const moved = [
      "control.ts",
      "chunk-bytes.ts",
      "input-coalescer.ts",
      "layout-parse.ts",
      "session-descriptor-discovery.ts",
      "workspace-tmux-adapter.ts",
    ];
    const protocol = new Set(readdirSync(resolve(SRC, "terminal/protocol")));
    for (const file of moved) expect(protocol.has(file)).toBe(true);
    const tuiMirror = new Set(readdirSync(resolve(SRC, "tui/mirror")));
    for (const file of moved) expect(tuiMirror.has(file)).toBe(false);
  });
});
