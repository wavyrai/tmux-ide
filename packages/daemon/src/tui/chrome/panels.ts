/**
 * The tmux-ide widget PANELS — every widget is a floating app dialog.
 *
 * The one-app milestone: instead of living as dedicated tmux panes, each widget
 * opens as a `display-popup -E` over your work, one root-table keystroke away,
 * esc/q to close (the popup exits when the widget process does). This mirrors the
 * chrome popups (switcher `M-p` / cheat sheet `M-k`) but points each key at
 * `tmux-ide popup <widget>`, which execs the bun widget synchronously inside the
 * popup's PTY (see the `popup` case in bin/cli.ts).
 *
 * {@link PANEL_POPUPS} is the single source of truth — the widget name (the
 * `tmux-ide popup <widget>` arg AND the `keys.panels.<widget>` config key), a
 * menu label, and per-widget popup sizing. The status bar's adopt binds one key
 * per entry, the cheat sheet lists them, and the actions menu opens them — all
 * derived from this list so they never drift.
 *
 * Only widgets that EXIST and stand alone are here: `preview` renders whatever
 * the explorer selected (via a shared `@preview_file` tmux option — nothing to
 * show on its own) and `setup` is the onboarding wizard, so neither is a panel.
 * `tasks`/`warroom`/`costs` were removed in the v2.6.0 front-end trim.
 *
 * Every builder here is PURE (tested); the io (running the popup) is the CLI's.
 */
import type { AppPanelKeys } from "../../lib/app-config.ts";

/** A widget that can float as a panel popup. */
export interface PanelPopup {
  /** Widget name — the `tmux-ide popup <widget>` arg + `keys.panels` field. */
  widget: "explorer" | "changes" | "config";
  /** Human label for the actions menu row. */
  label: string;
  /**
   * `display-popup` size tokens (tmux `-w`/`-h`). Sized per widget: the explorer
   * is a tall, narrower file column; changes is a wide diff surface; config is a
   * roomy tree editor. All large — a panel floats OVER your work, so it should
   * dominate while open, then vanish on esc.
   */
  width: string;
  height: string;
}

/**
 * The panel registry — the widgets bound as floating popups, in menu order.
 * Keys are configurable via `~/.tmux-ide/config.json` (`keys.panels.*`); the
 * defaults live in {@link ../../lib/app-config.ts}. Sizing is fixed here (tuned,
 * not configurable — a deliberate scope line).
 */
export const PANEL_POPUPS: PanelPopup[] = [
  { widget: "explorer", label: "⊞ Files", width: "60%", height: "85%" },
  { widget: "changes", label: "± Changes", width: "85%", height: "90%" },
  { widget: "config", label: "⚙ Config", width: "80%", height: "85%" },
];

/** The widget names that `tmux-ide popup <widget>` accepts (the panel set). */
export const POPUP_WIDGETS: string[] = PANEL_POPUPS.map((p) => p.widget);

/** The CLI invocation a panel popup runs (`tmux-ide popup <widget>`). */
export function panelPopupCli(widget: string): string {
  return `tmux-ide popup ${widget}`;
}

/**
 * The configured root-table key for a panel. `AppPanelKeys` fields are named
 * for the widgets, so this is a typed lookup — the panel registry and the config
 * shape stay in lockstep.
 */
export function panelKey(panel: PanelPopup, keys: AppPanelKeys): string {
  return keys[panel.widget];
}

/**
 * PURE — the `display-popup` command STRING that floats a panel (shared by the
 * actions menu's Panels rows, so a menu pick opens an identical popup to the
 * key bind). `-d '#{pane_current_path}'` opens the widget on the pane's cwd, so
 * the explorer/changes/config land on the project you're looking at.
 */
export function panelPopupCommand(panel: PanelPopup, cli = panelPopupCli(panel.widget)): string {
  return `display-popup -E -d '#{pane_current_path}' -w ${panel.width} -h ${panel.height} "${cli}"`;
}

/**
 * PURE — the tmux argv that binds a panel's root-table key to its
 * `display-popup`. Server-wide root-table bind (tmux has no per-session
 * bind-key), mirroring the switcher's popup key — see the note on
 * `unadoptSession`. Idempotent: re-binding a key overwrites it.
 */
export function panelPopupBindCommand(
  panel: PanelPopup,
  key: string,
  cli = panelPopupCli(panel.widget),
): string[] {
  return [
    "bind-key",
    "-n",
    key,
    "display-popup",
    "-E",
    "-d",
    "#{pane_current_path}",
    "-w",
    panel.width,
    "-h",
    panel.height,
    cli,
  ];
}

/** PURE — the tmux argv that removes a panel's key binding. */
export function panelPopupUnbindCommand(key: string): string[] {
  return ["unbind-key", "-n", key];
}
