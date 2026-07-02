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
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentStatus } from "../tui/detect/classify.ts";

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/** Root-table key binds (tmux key names) for the three chrome popups. */
export interface AppKeys {
  /** Switcher popup (default `M-p`). */
  popup: string;
  /** Cheat-sheet popup (default `M-k`). */
  cheatsheet: string;
  /** Actions menu (default `M-m`). */
  menu: string;
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

/** The whole config. */
export interface AppConfig {
  keys: AppKeys;
  theme: AppTheme;
  updater: AppUpdater;
  notifications: AppNotifications;
  restore: AppRestore;
  updates: AppUpdates;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** The built-in config — every field's fallback. */
export const DEFAULT_APP_CONFIG: AppConfig = {
  keys: { popup: "M-p", cheatsheet: "M-k", menu: "M-m" },
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
  const theme = asObject(root.theme);
  const status = asObject(theme.status);
  const glyphs = asObject(theme.glyphs);
  const updater = asObject(root.updater);
  const notifications = asObject(root.notifications);
  const restore = asObject(root.restore);
  const updates = asObject(root.updates);
  return {
    keys: {
      popup: pickString(keys.popup, D.keys.popup),
      cheatsheet: pickString(keys.cheatsheet, D.keys.cheatsheet),
      menu: pickString(keys.menu, D.keys.menu),
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
