/**
 * Dispatcher entry for the compiled `tmux-ide-tui` binary.
 *
 * `bun build --compile` bundles every TUI surface (the cockpit + widgets) into
 * ONE standalone executable so the OpenTUI/Solid `.tsx` surfaces run on a clean
 * `npm i -g tmux-ide` — no dev checkout, no `bun` runtime, no bunfig preload.
 * The native OpenTUI dylib rides along via Bun's embedded-asset mechanism (the
 * `import ... with { type: "file" }` in @opentui/core-*), and the Solid JSX
 * transform happens at build time via the @opentui/solid bun plugin, so the
 * binary carries only plain JS.
 *
 * Contract: `tmux-ide-tui <surface> [--flags…]`. The first positional selects
 * the surface; the rest are the surface's own args (theme, session, dir, …),
 * exactly as the `bun <entry> …` invocation passed them. We strip the surface
 * token from `process.argv` before importing so each entry's top-level
 * `parseArgs()` sees the same argv it always has.
 *
 * The `import()` calls use LITERAL specifiers on purpose: Bun's bundler only
 * embeds dynamic imports it can resolve statically, and a literal switch keeps
 * exactly one surface's top-level `render()` side effect from firing.
 */

import parserWorkerPath from "tmux-ide:opentui-parser-worker" with { type: "file" };
import treeSitterWasmPath from "tmux-ide:opentui-tree-sitter-wasm" with { type: "file" };
import { existsSync } from "node:fs";

const TREE_SITTER_SMOKE_SURFACE = "__tree-sitter-smoke";

const SURFACES = [
  "team",
  "app",
  "explorer",
  "changes",
  "preview",
  "config",
  "setup",
  "sidebar",
] as const;

type Surface = (typeof SURFACES)[number];

function isSurface(value: string | undefined): value is Surface {
  return value !== undefined && (SURFACES as readonly string[]).includes(value);
}

async function main(): Promise<void> {
  // OpenTUI normally finds parser.worker.js beside its JS module. A standalone
  // Bun executable has no such directory: import.meta.url points into /$bunfs.
  // build-tui embeds a fully bundled worker and its web-tree-sitter wasm as
  // explicit assets; publish the worker path before any OpenTUI surface imports
  // create the singleton TreeSitterClient. The wasm binding is intentionally
  // retained and checked here so Bun cannot tree-shake the worker's sibling.
  if (!existsSync(parserWorkerPath) || !existsSync(treeSitterWasmPath)) {
    throw new Error("tmux-ide-tui: embedded Tree-sitter runtime is incomplete");
  }
  process.env.OTUI_TREE_SITTER_WORKER_PATH ??= parserWorkerPath;

  // Carries process entry time across the lazy surface import. The app's
  // opt-in profiler turns this into phase timings without IO on normal runs.
  process.env.TMUX_IDE_TUI_LAUNCH_EPOCH_MS ??= String(Date.now());
  const surface = process.argv[2];

  // Private release/packaging gate. This exercises the same OpenTUI singleton
  // that Markdown uses, including Worker startup and web-tree-sitter wasm, but
  // mounts no terminal renderer and leaves no alternate-screen state behind.
  if (surface === TREE_SITTER_SMOKE_SURFACE) {
    const { destroyTreeSitterClient, getTreeSitterClient } = await import("@opentui/core");
    const client = getTreeSitterClient();
    await client.initialize();
    const highlighted = await client.highlightOnce("# tmux-ide\n\n**ready**", "markdown");
    if (highlighted.error || !highlighted.highlights?.length) {
      throw new Error(
        `tmux-ide-tui: embedded Markdown parser failed: ${highlighted.error ?? "no highlights"}`,
      );
    }
    await destroyTreeSitterClient();
    process.stdout.write("tree-sitter-worker-ready\n");
    return;
  }

  if (!isSurface(surface)) {
    process.stderr.write(
      `tmux-ide-tui: unknown surface ${surface ? `"${surface}"` : "(none given)"}.\n` +
        `Usage: tmux-ide-tui <${SURFACES.join("|")}> [flags]\n`,
    );
    process.exit(2);
  }

  // Drop the surface token so each entry's `parseArgs()` sees only its flags.
  process.argv.splice(2, 1);

  switch (surface) {
    case "team":
      await import("./team/index.tsx");
      break;
    case "app":
      await import("./mirror/app.tsx");
      break;
    case "explorer":
      await import("../widgets/explorer/index.tsx");
      break;
    case "changes":
      await import("../widgets/changes/index.tsx");
      break;
    case "preview":
      await import("../widgets/preview/index.tsx");
      break;
    case "config":
      await import("../widgets/config/index.tsx");
      break;
    case "setup":
      await import("../widgets/setup/index.tsx");
      break;
    case "sidebar":
      await import("../widgets/sidebar/index.tsx");
      break;
  }
}

void main();
