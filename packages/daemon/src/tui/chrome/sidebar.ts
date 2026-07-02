/**
 * The tmux-ide SIDEBAR — the app's persistent nav column.
 *
 * Unlike the widget PANELS (floating popups) this is a real, always-visible
 * tmux pane: a narrow full-height left column that lists the fleet
 * (project → session → window) with live status glyphs and jumps the viewing
 * client anywhere on enter. It's summoned per-session with a toggle key
 * (`keys.sidebar`, default `M-b`) that runs `tmux-ide sidebar-toggle`, so the
 * app column appears wherever you call for it — in ANY adopted session.
 *
 * This module owns the tmux mechanics: the pure toggle-key bind builders (bound
 * server-wide by `adoptSession`, like the other chrome keys) and the io that
 * opens/finds/closes the column pane. The pane is marked with
 * {@link SIDEBAR_PANE_OPTION} so the data layer excludes it from status rollups
 * (see `../team/sessions.ts`) and the chip updater never labels it an agent.
 *
 * The command builders are PURE (tested); the io wrappers are thin.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runTmux } from "@tmux-ide/tmux-bridge";
import type { ThemeConfig } from "../../types.ts";
import { shellEscape } from "../../lib/shell.ts";
import { SIDEBAR_PANE_OPTION } from "../team/sessions.ts";
import { resolveTuiLaunch, findCompiledTui, isBunAvailable } from "../compiled.ts";

export { SIDEBAR_PANE_OPTION };

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the sidebar widget's `.tsx` entry, robust across BOTH run modes. The
 * widget sources ship uncompiled and are spawned by `bun`, so a bundled caller
 * (this module inlined into `bin/cli.js`) must reach them via a bin-anchored
 * path, while a dev caller (this module at `tui/chrome/`) reaches them relatively
 * — the two differ, so we probe candidates and take the first that exists. Falls
 * back to the dev path so the returned command is at least well-formed.
 */
export function sidebarWidgetScript(): string {
  const candidates = [
    resolve(__dirname, "../../widgets/sidebar/index.tsx"),
    resolve(__dirname, "../packages/daemon/src/widgets/sidebar/index.tsx"),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}

/**
 * PURE — the shell command the sidebar pane runs. `cd`s into the project dir
 * first so bun finds `bunfig.toml` (the @opentui/solid JSX preload), then boots
 * the widget with the current session, dir, and (optional) theme. Mirrors
 * `resolveWidgetCommand`'s shape but self-locates the script so it survives the
 * bundle (see {@link sidebarWidgetScript}).
 */
export function sidebarWidgetCommand(
  scriptPath: string,
  session: string,
  dir: string,
  theme: ThemeConfig | null,
): string {
  const args = [`--session=${session}`, `--dir=${dir}`];
  if (theme) args.push(`--theme=${JSON.stringify(theme)}`);

  const launch = resolveTuiLaunch({
    surface: "sidebar",
    scriptPath,
    args,
    checkoutExists: existsSync(scriptPath),
    bunAvailable: isBunAvailable(),
    compiledBinary: findCompiledTui(),
  });
  if (launch.mode === "unavailable") {
    // Keep the pane command well-formed; the pane shows bun's own error. This
    // path only trips on a broken install (no checkout, no bun, no binary).
    return `cd ${shellEscape(dir)} && bun ${shellEscape(scriptPath)} ${args.map(shellEscape).join(" ")}`;
  }

  const escaped = launch.argv.map(shellEscape).join(" ");
  // Both modes cd into the project dir first: bun needs a nearby bunfig only in
  // a checkout (which sits above dir); the binary is self-contained.
  return `cd ${shellEscape(dir)} && ${shellEscape(launch.bin)} ${escaped}`;
}

/**
 * Root-table key that toggles the sidebar: `M-b` (Alt+b). Like the other chrome
 * keys it lives in the ROOT table so it fires without the prefix from any
 * adopted session; Alt-letter keys are low-collision in terminal apps. Default
 * for {@link sidebarToggleBindCommand}; overridable via `keys.sidebar`.
 */
export const SIDEBAR_KEY = "M-b";

/** Default sidebar column width in tmux columns — narrow enough to leave the
 *  work area room, wide enough for a glyph + a truncated name. */
export const DEFAULT_SIDEBAR_WIDTH = 30;

/** Normalized sidebar settings. */
export interface ResolvedSidebar {
  enabled: boolean;
  width: number;
}

/**
 * PURE — normalize the ide.yml `sidebar` sugar (`true` | `{ width }` | `false` |
 * undefined) into `{ enabled, width }`. A missing/invalid width falls back to
 * {@link DEFAULT_SIDEBAR_WIDTH}; width is clamped to a sane floor so a typo can't
 * produce a zero-width column.
 */
export function resolveSidebarConfig(raw: unknown): ResolvedSidebar {
  if (raw === true) return { enabled: true, width: DEFAULT_SIDEBAR_WIDTH };
  if (!raw || typeof raw !== "object") return { enabled: false, width: DEFAULT_SIDEBAR_WIDTH };
  const width = parseSidebarWidth((raw as { width?: unknown }).width);
  return { enabled: true, width };
}

/** PURE — parse a width value (string or number) to a positive int column count,
 *  falling back to the default and flooring at 10. */
export function parseSidebarWidth(value: unknown): number {
  const n =
    typeof value === "number" ? value : typeof value === "string" ? parseInt(value, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SIDEBAR_WIDTH;
  return Math.max(10, Math.floor(n));
}

/**
 * PURE — the tmux argv that binds the sidebar toggle key. `run-shell`
 * format-expands `#{session_name}` into `--session` (bind args themselves do NOT
 * expand; run-shell DOES — the same trick the menu bind uses), so the CLI toggles
 * the column in whichever session the client is viewing. Server-wide root-table
 * bind, mirroring the switcher's M-p — see the note on `unadoptSession`.
 */
export function sidebarToggleBindCommand(
  cli = "tmux-ide sidebar-toggle",
  key = SIDEBAR_KEY,
): string[] {
  return ["bind-key", "-n", key, "run-shell", `${cli} --session '#{session_name}'`];
}

/** PURE — the tmux argv that removes the sidebar toggle binding. */
export function sidebarToggleUnbindCommand(key = SIDEBAR_KEY): string[] {
  return ["unbind-key", "-n", key];
}

/**
 * PURE — the `split-window` argv that opens the sidebar column. `-h -b -f`
 * creates a horizontal split placed BEFORE (left of) the target that spans the
 * FULL window height (`-f`) regardless of which pane is active, `-l <width>`
 * fixes its column width, and `-P -F '#{pane_id}'` prints the new pane id. The
 * trailing `widgetCmd` runs the sidebar widget in the pane.
 */
export function sidebarSplitCommand(
  session: string,
  dir: string,
  width: number,
  widgetCmd: string,
): string[] {
  return [
    "split-window",
    "-P",
    "-F",
    "#{pane_id}",
    "-t",
    session,
    "-h",
    "-b",
    "-f",
    "-l",
    String(width),
    "-c",
    dir,
    widgetCmd,
  ];
}

/**
 * io — the sidebar pane id already open in `session`, or null. Reads the
 * {@link SIDEBAR_PANE_OPTION} marker off each pane so a toggle can find and close
 * an existing column.
 */
export function findSidebarPane(session: string): string | null {
  try {
    const raw = runTmux(
      ["list-panes", "-t", session, "-F", `#{pane_id}\t#{${SIDEBAR_PANE_OPTION}}`],
      { encoding: "utf-8" },
    )
      .toString()
      .trim();
    for (const line of raw.split("\n").filter(Boolean)) {
      const [id = "", flag = ""] = line.split("\t");
      if (flag === "1" && id) return id;
    }
  } catch {
    // no such session / tmux unavailable — treat as "no sidebar"
  }
  return null;
}

/**
 * io — open the sidebar column in `session` on `dir`, mark the pane so the data
 * layer excludes it, title it "sidebar" (the pane-border chip falls back to the
 * title for non-agent panes), and return the new pane id.
 */
export function openSidebarPane(
  session: string,
  dir: string,
  width: number,
  theme: ThemeConfig | null,
): string {
  const widgetCmd = sidebarWidgetCommand(sidebarWidgetScript(), session, dir, theme);
  const paneId = runTmux(sidebarSplitCommand(session, dir, width, widgetCmd), {
    encoding: "utf-8",
  })
    .toString()
    .trim();
  runTmux(["set-option", "-pqt", paneId, SIDEBAR_PANE_OPTION, "1"]);
  runTmux(["select-pane", "-t", paneId, "-T", "sidebar"]);
  return paneId;
}

/** io — close the sidebar column pane. */
export function closeSidebarPane(paneId: string): void {
  runTmux(["kill-pane", "-t", paneId]);
}
