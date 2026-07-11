/**
 * The one global config — `~/.tmux-ide/config.json` (overridable via
 * `TMUX_IDE_CONFIG`).
 *
 * Everything that used to be hardcoded chrome behaviour lives here: the
 * root-table key binds (`M-p`/`M-k`/`M-m`), the shared THEME TOKENS consumed by
 * BOTH the tmux chrome (status bar / pane chips / actions menu / cheat sheet)
 * AND the OpenTUI widgets, the updater cadence, and the notification/restore/
 * update-check toggles. One palette, one keymap, one file — the foundation for
 * the "one cohesive app" milestone.
 *
 * The tokens are SEMANTIC (accent/muted/fg + per-status colors + glyphs), not
 * per-surface: a single `theme` block drives every surface, so re-theming the
 * whole product is a one-file edit + a re-adopt (no code change).
 *
 * {@link parseAppConfig} is PURE — a deep partial merge over the defaults where
 * any missing or mistyped field falls back to its default and it never throws.
 * {@link loadAppConfig} is the thin io wrapper (missing/malformed file →
 * defaults); {@link getAppConfig} caches that read for the process. The old
 * per-concern readers ({@link ../tui/chrome/notify.ts}, {@link ../restore.ts})
 * now delegate here.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentStatus } from "../tui/detect/classify.ts";

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/**
 * Root-table key binds (tmux key names) for the per-widget PANEL popups —
 * every widget is a floating app dialog one keystroke away, esc to close (the
 * "one-app" milestone). Only widgets that exist AND stand alone are here:
 * `preview` is a companion that renders the explorer's selection (nothing to
 * show on its own) and `setup` is the onboarding wizard, so neither gets a key.
 */
export interface AppPanelKeys {
  /** File explorer panel (default `M-e`). */
  explorer: string;
  /** Git changes panel (default `M-g`). */
  changes: string;
  /** Config editor panel (default `M-,`). */
  config: string;
}

/** Root-table key binds (tmux key names) for the chrome popups + widget panels. */
export interface AppKeys {
  /** Switcher popup (default `M-p`). */
  popup: string;
  /** Home cockpit popup — the full fleet home from any session (default `M-h`). */
  home: string;
  /** Cheat-sheet popup (default `M-k`). */
  cheatsheet: string;
  /** Actions menu (default `M-m`). */
  menu: string;
  /** Sidebar (app nav column) toggle (default `M-b`). */
  sidebar: string;
  /** Per-widget panel popups (default `M-e`/`M-g`/`M-,`). */
  panels: AppPanelKeys;
}

/** Per-agent-status color token (tmux `colourN` / `#rrggbb`). */
export type AppThemeStatus = Record<AgentStatus, string>;

/** The two state glyphs — filled (active/present) and hollow (inactive/quiet). */
export interface AppThemeGlyphs {
  active: string;
  inactive: string;
}

/**
 * The shared palette — semantic tokens, not per-surface styles. Chrome builders
 * and widgets both map these into their own render layer, so the whole product
 * reads as one system.
 */
export interface AppTheme {
  /** Primary/brand accent (default `colour75`). */
  accent: string;
  /** Muted/secondary foreground for dim text (default `colour240`). */
  muted: string;
  /** Default foreground (default `colour250`). */
  fg: string;
  /** Per-status colors (blocked/working/done/idle/unknown). */
  status: AppThemeStatus;
  /** The filled/hollow state glyphs. */
  glyphs: AppThemeGlyphs;
}

/** Chrome updater cadence. */
export interface AppUpdater {
  /** Milliseconds between ticks (default 2000). */
  tickMs: number;
  /** Write a disaster-recovery snapshot every N ticks (default 15). */
  snapshotEvery: number;
}

/** Notification channel toggles. */
export interface AppNotifications {
  toast: boolean;
  macos: boolean;
}

/** Restore behaviour toggles. */
export interface AppRestore {
  resumeAgents: boolean;
}

/** Update-check toggles (consumed later by the update-flow card). */
export interface AppUpdates {
  check: boolean;
}

/** First-run welcome toggles. */
export interface AppWelcome {
  /**
   * Whether the first-run welcome card may show (default true). Set false to
   * suppress it independently of the `~/.tmux-ide/welcomed` marker file (which
   * records that it has already been shown once).
   */
  show: boolean;
}

/** Agent-integration auto-discovery config. */
export interface AppIntegrations {
  /**
   * Whether the first-adopt integration OFFER may show (default true). Set false
   * to suppress the one-time "claude detected — install the integration?" popup
   * independently of the `<home>/integration-offered` marker (which records that
   * it has already been shown once).
   */
  offer: boolean;
}

/** The unified-app front-door decision (M22.6). */
export interface AppApp {
  /**
   * Whether bare `tmux-ide` (no ide.yml here, no `--team`) launches the unified
   * app (`tmux-ide app`) instead of the classic team cockpit. Default false —
   * the flip is opt-in until the default-entry decision is made. `tmux-ide team`
   * (the explicit cockpit) and a project's `ide.yml` auto-launch are unaffected.
   */
  frontDoor: boolean;
  /**
   * Whether `tmux-ide app` runs HOSTED by default (M23.2): the app lives in an
   * internal `_tmux-ide-app` tmux session and the invoking terminal attaches to
   * it, so the cockpit survives the terminal and reattaches from anywhere (^q
   * detaches instead of quitting). Default false — the same behavior as the
   * explicit `--detachable` flag; `--detachable`/`--hosted` still force it on a
   * single run.
   */
  detachable: boolean;
  /**
   * When a plain left drag on an app-mouse pane SELECTS locally instead of
   * forwarding to the pane's app (M24.2). "agents" (default): panes our own
   * detection matches to a fleet agent entry select; other app-mouse panes
   * (vim/htop) forward. "always": every app-mouse pane selects on drag.
   * "never": every app-mouse pane forwards (the pre-M24.2 behavior). A genuine
   * click (press+release in one cell) is still forwarded on select-default
   * panes; shift inverts a pane's default; the right-click pane menu overrides
   * per pane for the session.
   */
  dragSelect: "agents" | "always" | "never";
  /**
   * Where a Terminal-surface "New agent" spawn starts (M24.1): `"pane"`
   * (default) inherits the FOCUSED pane's current working directory —
   * `#{pane_current_path}`, so the agent lands where you are — while
   * `"session"` keeps the session/project directory. Home/sidebar spawns
   * always use the session/project dir (no focused pane exists there).
   */
  newAgentCwd: NewAgentCwd;
  /**
   * Whether the unified app enables the kitty keyboard protocol on its host
   * terminal (M24.4). On (default), kitty-capable terminals deliver ⌘-modified
   * keys — ⌘K opens the command palette — and disambiguated escapes; the app
   * re-encodes every key for the mirrored panes either way, and terminals
   * without the protocol ignore the request entirely. Off restores the legacy
   * key encoding for hosts where the protocol misbehaves.
   */
  kittyKeys: boolean;
}

/** The two Terminal-spawn cwd policies (see {@link AppApp.newAgentCwd}). */
export type NewAgentCwd = "pane" | "session";

/** Worktree flow config (`tmux-ide worktree`). */
export interface AppWorktrees {
  /**
   * Base directory for worktree checkouts. Empty (default) → a sibling
   * `<repo>-worktrees` dir next to each repo. A non-empty value overrides that
   * base; a relative path is resolved against the repo.
   */
  dir: string;
}

/** The whole config. */
export interface AppConfig {
  keys: AppKeys;
  theme: AppTheme;
  updater: AppUpdater;
  notifications: AppNotifications;
  restore: AppRestore;
  updates: AppUpdates;
  welcome: AppWelcome;
  integrations: AppIntegrations;
  worktrees: AppWorktrees;
  app: AppApp;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** The built-in config — every field's fallback. */
export const DEFAULT_APP_CONFIG: AppConfig = {
  keys: {
    popup: "M-p",
    home: "M-h",
    cheatsheet: "M-k",
    menu: "M-m",
    sidebar: "M-b",
    panels: { explorer: "M-e", changes: "M-g", config: "M-," },
  },
  theme: {
    accent: "colour75",
    muted: "colour240",
    fg: "colour250",
    status: {
      blocked: "colour203",
      working: "colour221",
      done: "colour111",
      idle: "colour114",
      unknown: "colour244",
    },
    glyphs: { active: "●", inactive: "○" },
  },
  updater: { tickMs: 2000, snapshotEvery: 15 },
  notifications: { toast: true, macos: false },
  restore: { resumeAgents: false },
  updates: { check: true },
  welcome: { show: true },
  integrations: { offer: true },
  worktrees: { dir: "" },
  app: {
    frontDoor: false,
    detachable: false,
    dragSelect: "agents",
    newAgentCwd: "pane",
    kittyKeys: true,
  },
};

/** The default theme tokens — the fallback threaded into the pure builders. */
export const DEFAULT_THEME: AppTheme = DEFAULT_APP_CONFIG.theme;

/** The default key binds — the fallback for the bind command builders. */
export const DEFAULT_KEYS: AppKeys = DEFAULT_APP_CONFIG.keys;

// ---------------------------------------------------------------------------
// Pure parse (deep partial merge over defaults)
// ---------------------------------------------------------------------------

/** A plain object, or `{}` for anything that isn't one (arrays included). */
function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A non-empty string, else the default. */
function pickString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/** A boolean, else the default. */
function pickBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** A positive integer, else the default. */
function pickPosInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

/** One of the allowed literals, else the default. */
function pickChoice<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/**
 * PURE — merge an unknown (typically parsed JSON) over {@link DEFAULT_APP_CONFIG}.
 * Every block/leaf is validated independently: a missing or mistyped field falls
 * back to its default, so partial and garbage configs both resolve to a complete,
 * well-typed {@link AppConfig}. Never throws.
 */
export function parseAppConfig(input: unknown): AppConfig {
  const D = DEFAULT_APP_CONFIG;
  const root = asObject(input);
  const keys = asObject(root.keys);
  const panels = asObject(keys.panels);
  const theme = asObject(root.theme);
  const status = asObject(theme.status);
  const glyphs = asObject(theme.glyphs);
  const updater = asObject(root.updater);
  const notifications = asObject(root.notifications);
  const restore = asObject(root.restore);
  const updates = asObject(root.updates);
  const welcome = asObject(root.welcome);
  const integrations = asObject(root.integrations);
  const worktrees = asObject(root.worktrees);
  const app = asObject(root.app);
  return {
    keys: {
      popup: pickString(keys.popup, D.keys.popup),
      home: pickString(keys.home, D.keys.home),
      cheatsheet: pickString(keys.cheatsheet, D.keys.cheatsheet),
      menu: pickString(keys.menu, D.keys.menu),
      sidebar: pickString(keys.sidebar, D.keys.sidebar),
      panels: {
        explorer: pickString(panels.explorer, D.keys.panels.explorer),
        changes: pickString(panels.changes, D.keys.panels.changes),
        config: pickString(panels.config, D.keys.panels.config),
      },
    },
    theme: {
      accent: pickString(theme.accent, D.theme.accent),
      muted: pickString(theme.muted, D.theme.muted),
      fg: pickString(theme.fg, D.theme.fg),
      status: {
        blocked: pickString(status.blocked, D.theme.status.blocked),
        working: pickString(status.working, D.theme.status.working),
        done: pickString(status.done, D.theme.status.done),
        idle: pickString(status.idle, D.theme.status.idle),
        unknown: pickString(status.unknown, D.theme.status.unknown),
      },
      glyphs: {
        active: pickString(glyphs.active, D.theme.glyphs.active),
        inactive: pickString(glyphs.inactive, D.theme.glyphs.inactive),
      },
    },
    updater: {
      tickMs: pickPosInt(updater.tickMs, D.updater.tickMs),
      snapshotEvery: pickPosInt(updater.snapshotEvery, D.updater.snapshotEvery),
    },
    notifications: {
      toast: pickBool(notifications.toast, D.notifications.toast),
      macos: pickBool(notifications.macos, D.notifications.macos),
    },
    restore: { resumeAgents: pickBool(restore.resumeAgents, D.restore.resumeAgents) },
    updates: { check: pickBool(updates.check, D.updates.check) },
    welcome: { show: pickBool(welcome.show, D.welcome.show) },
    integrations: { offer: pickBool(integrations.offer, D.integrations.offer) },
    worktrees: { dir: pickString(worktrees.dir, D.worktrees.dir) },
    app: {
      frontDoor: pickBool(app.frontDoor, D.app.frontDoor),
      detachable: pickBool(app.detachable, D.app.detachable),
      dragSelect: pickChoice(app.dragSelect, ["agents", "always", "never"], D.app.dragSelect),
      newAgentCwd: pickChoice(app.newAgentCwd, ["pane", "session"], D.app.newAgentCwd),
      kittyKeys: pickBool(app.kittyKeys, D.app.kittyKeys),
    },
  };
}

// ---------------------------------------------------------------------------
// io
// ---------------------------------------------------------------------------

/**
 * Absolute path to the config file: `TMUX_IDE_CONFIG` when set (tests / per-run
 * overrides), else `~/.tmux-ide/config.json`.
 */
export function appConfigPath(): string {
  return process.env.TMUX_IDE_CONFIG ?? join(homedir(), ".tmux-ide", "config.json");
}

/**
 * io — read + parse the config. A missing or malformed file resolves to the full
 * defaults ({@link parseAppConfig} never throws). Reads fresh each call; use
 * {@link getAppConfig} for the cached per-process read.
 */
export function loadAppConfig(): AppConfig {
  const path = appConfigPath();
  if (!existsSync(path)) return parseAppConfig(undefined);
  try {
    return parseAppConfig(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    // malformed file — full defaults
    return parseAppConfig(undefined);
  }
}

let cached: AppConfig | null = null;

/**
 * The process-cached config. Resolved once on first use — config changes take
 * effect on the next process (e.g. a re-adopt spawns fresh CLI invocations), so
 * caching is safe and keeps the hot updater tick from re-reading the file.
 */
export function getAppConfig(): AppConfig {
  if (!cached) cached = loadAppConfig();
  return cached;
}

/** Drop the cache so the next {@link getAppConfig} re-reads. Test-only. */
export function _resetForTests(): void {
  cached = null;
}

// ---------------------------------------------------------------------------
// Writes (M22.4 — the settings surface persists through here)
// ---------------------------------------------------------------------------

/**
 * io — the RAW parsed config file as the user wrote it (`{}` when missing or
 * malformed). Writers merge over THIS, not over {@link parseAppConfig}'s output:
 * round-tripping through the parser would materialize every default into the
 * hand-editable file and silently DROP fields the typed shape doesn't model yet
 * (e.g. the notification polish fields `notifications.enabled` /
 * `notifications.quietHours` that {@link ../tui/chrome/notify.ts} reads raw).
 */
export function loadRawAppConfig(): Record<string, unknown> {
  const path = appConfigPath();
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** A partial config write: plain objects merge recursively, scalars/arrays
 *  replace, and an explicit `undefined` DELETES the key (how "reset to
 *  defaults" removes a block so the parser's defaults take over). */
export type AppConfigPatch = { [key: string]: unknown };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * PURE — merge `patch` into `raw` without touching either input. Objects merge
 * key-by-key (recursively), anything else replaces, and a key whose patch value
 * is `undefined` is REMOVED from the result. Unknown user fields survive — the
 * merge only visits keys the patch names.
 */
export function mergeConfigPatch(
  raw: Record<string, unknown>,
  patch: AppConfigPatch,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete out[key];
    } else if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = mergeConfigPatch(out[key] as Record<string, unknown>, value as AppConfigPatch);
    } else if (isPlainObject(value)) {
      out[key] = mergeConfigPatch({}, value as AppConfigPatch);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * io — apply a patch to the config file ATOMICALLY (temp + rename, the same
 * discipline as the editor save): read raw → {@link mergeConfigPatch} → write.
 * Busts the {@link getAppConfig} process cache and returns the new parsed
 * config. Honors `TMUX_IDE_CONFIG`, so tests never touch the real file.
 */
export function updateAppConfig(patch: AppConfigPatch): AppConfig {
  const path = appConfigPath();
  const merged = mergeConfigPatch(loadRawAppConfig(), patch);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
  renameSync(tmp, path);
  cached = null;
  return parseAppConfig(merged);
}
