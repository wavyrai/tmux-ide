import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ThemeConfig } from "../types.ts";
import { shellEscape } from "../lib/shell.ts";
import { resolveTuiLaunch, findCompiledTui, isBunAvailable } from "../tui/compiled.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface WidgetOptions {
  session: string;
  dir: string;
  target: string | null;
  theme: ThemeConfig | null;
}

// The .tsx extension is used at runtime; Bun handles JSX via preload plugin.
// Exactly the widgets that exist — a stale entry here becomes a dead
// `Module not found` pane at launch time.
const WIDGET_ENTRY_POINTS: Record<string, string> = {
  explorer: "explorer/index.tsx",
  changes: "changes/index.tsx",
  preview: "preview/index.tsx",
  setup: "setup/index.tsx",
  config: "config/index.tsx",
  sidebar: "sidebar/index.tsx",
};

/**
 * Resolve a widget entry to an absolute path that works from BOTH runtimes:
 * unbundled (this file lives in packages/daemon/src/widgets — entries are
 * siblings) and the esbuild bundle (import.meta.url collapses to bin/cli.js,
 * so entries live at ../packages/daemon/src/widgets from there). Probing with
 * existsSync keeps one code path honest instead of guessing by environment.
 */
function widgetEntryPath(entry: string): string {
  const sibling = resolve(__dirname, entry);
  if (existsSync(sibling)) return sibling;
  return resolve(__dirname, "../packages/daemon/src/widgets", entry);
}

/**
 * The tmux-ide repo root — where bunfig.toml (the JSX preload) lives. Widgets
 * must be SPAWNED from here regardless of which project they render (the
 * project dir travels via --dir); cd-ing to the project instead crashes bun
 * with "Cannot find module react/jsx-dev-runtime" outside this repo.
 */
const REPO_ROOT = existsSync(resolve(__dirname, "explorer/index.tsx"))
  ? resolve(__dirname, "../../../..") // unbundled: src/widgets → repo root
  : resolve(__dirname, ".."); // bundled: bin → repo root

function widgetArgs(opts: WidgetOptions): string[] {
  const args = [`--session=${opts.session}`, `--dir=${opts.dir}`];
  if (opts.target) args.push(`--target=${opts.target}`);
  if (opts.theme) args.push(`--theme=${JSON.stringify(opts.theme)}`);
  return args;
}

export function resolveWidgetCommand(type: string, opts: WidgetOptions): string {
  const entry = WIDGET_ENTRY_POINTS[type];
  if (!entry) throw new Error(`Unknown widget type: ${type}`);

  const scriptPath = widgetEntryPath(entry);
  const launch = resolveTuiLaunch({
    surface: type,
    scriptPath,
    args: widgetArgs(opts),
    checkoutExists: existsSync(scriptPath),
    bunAvailable: isBunAvailable(),
    compiledBinary: findCompiledTui(),
  });

  if (launch.mode === "unavailable") {
    throw new Error(`Cannot launch ${type} widget: ${launch.reasons.join("; ")}`);
  }

  const escapedArgs = launch.argv.map(shellEscape).join(" ");
  if (launch.mode === "bun") {
    // cd to the tmux-ide REPO root (not the project) so bunfig.toml's JSX
    // preload is found; the project dir rides in via --dir.
    return `cd ${shellEscape(REPO_ROOT)} && bun ${escapedArgs}`;
  }
  // Compiled binary: no bunfig to find (JSX + native dylib are baked in). Run
  // from the pane's dir so a stray repo-root bunfig can't hijack the preload.
  return `cd ${shellEscape(opts.dir)} && ${shellEscape(launch.bin)} ${escapedArgs}`;
}

export interface WidgetSpawnSpec {
  cwd: string;
  cmd: string[];
}

/**
 * Structured form of `resolveWidgetCommand` for direct PTY spawning. Callers
 * that own the cwd separately (e.g. the /ws/pty bridge accepting cwd in its
 * init frame) avoid the shell hop and get exec-style argv.
 */
export function resolveWidgetSpawn(type: string, opts: WidgetOptions): WidgetSpawnSpec {
  const entry = WIDGET_ENTRY_POINTS[type];
  if (!entry) throw new Error(`Unknown widget type: ${type}`);

  const scriptPath = widgetEntryPath(entry);
  const launch = resolveTuiLaunch({
    surface: type,
    scriptPath,
    args: widgetArgs(opts),
    checkoutExists: existsSync(scriptPath),
    bunAvailable: isBunAvailable(),
    compiledBinary: findCompiledTui(),
  });

  if (launch.mode === "unavailable") {
    throw new Error(`Cannot launch ${type} widget: ${launch.reasons.join("; ")}`);
  }
  // Bun spawns from the repo root (bunfig preload); the binary spawns from the
  // pane's dir (self-contained, avoids a stray bunfig preload).
  const cwd = launch.mode === "bun" ? REPO_ROOT : opts.dir;
  return { cwd, cmd: [launch.bin, ...launch.argv] };
}

export const WIDGET_TYPES = Object.keys(WIDGET_ENTRY_POINTS);
