/**
 * Settings as COMMANDS (M22.4) — the PURE model behind the app's settings
 * surface. There is NO settings screen: every setting is a palette command
 * executed through the dialog primitives ({@link ./dialog-model.ts} /
 * {@link ./dialog-stack.ts}); this module builds the dialog ITEM LISTS from the
 * real typed config ({@link ../../lib/app-config.ts}) and the real notification
 * prefs ({@link ../chrome/notify.ts}), plus the config PATCHES each choice
 * persists. app.tsx owns the async flows (sequential awaits over the one-shots).
 *
 * Copy is plain language throughout; each dialog's footer says WHERE a change
 * lands ("takes effect immediately" vs "after re-adopt") so non-technicals are
 * never left guessing.
 */
import type { AppConfig, AppConfigPatch, AppKeys } from "../../lib/app-config.ts";
import { parseHHMM, type NotificationPrefs } from "../chrome/notify.ts";
import type { DialogSelectItem } from "./dialog-model.ts";

// ── Command registry (what the palette offers) ───────────────────────────────

export type SettingsCommandId =
  | "settings"
  | "settings-theme"
  | "settings-notifications"
  | "settings-quiet-hours"
  | "settings-updates"
  | "settings-restore"
  | "settings-keys"
  | "settings-reset";

/** The palette entries, one per settings command (+ the umbrella first). The
 *  "Settings" category prefix is how the palette's flat fuzzy list reads as a
 *  category — typing "set" narrows to all of them. */
export const SETTINGS_PALETTE_COMMANDS: ReadonlyArray<{
  id: SettingsCommandId;
  label: string;
}> = [
  { id: "settings", label: "Settings…" },
  { id: "settings-theme", label: "Settings: Accent color" },
  { id: "settings-notifications", label: "Settings: Notifications" },
  { id: "settings-quiet-hours", label: "Settings: Quiet hours" },
  { id: "settings-updates", label: "Settings: Updates & background refresh" },
  { id: "settings-restore", label: "Settings: Crash restore" },
  { id: "settings-keys", label: "Settings: Keyboard shortcuts (view)" },
  { id: "settings-reset", label: "Settings: Reset to defaults" },
];

// ── Where changes land (footer copy) ─────────────────────────────────────────

/** Notifications are read fresh per event — honest "immediately". */
export const HINT_LIVE = "takes effect immediately";
/** The tmux chrome + widget panels read the theme when they (re)build. */
export const HINT_READOPT = "applies after re-adopt — run: tmux-ide adopt <session>";
/** The background chrome loads its config at start. */
export const HINT_CHROME_RESTART = "applies when the background chrome restarts";

// ── Theme presets ────────────────────────────────────────────────────────────

export interface ThemePreset {
  /** The `theme.accent` value persisted (a tmux `colourN` token). */
  accent: string;
  /** Plain name shown in the picker. */
  label: string;
  /** The same color as RGB for the in-dialog swatch / live preview. */
  rgb: [number, number, number];
}

/** Curated accents (default first). RGB values are the xterm-256 values of the
 *  `colourN` tokens, so the in-app preview shows exactly what tmux will. */
export const THEME_PRESETS: readonly ThemePreset[] = [
  { accent: "colour75", label: "Sky blue (default)", rgb: [95, 175, 255] },
  { accent: "colour114", label: "Soft green", rgb: [135, 215, 135] },
  { accent: "colour80", label: "Aqua", rgb: [95, 215, 215] },
  { accent: "colour111", label: "Periwinkle", rgb: [135, 175, 255] },
  { accent: "colour183", label: "Lavender", rgb: [215, 175, 255] },
  { accent: "colour216", label: "Peach", rgb: [255, 175, 135] },
  { accent: "colour221", label: "Amber", rgb: [255, 215, 95] },
  { accent: "colour203", label: "Coral", rgb: [255, 95, 95] },
];

/** PURE — the theme picker rows: every preset (● on the saved accent). A saved
 *  accent that is not a preset (hand-edited config) keeps its place as a
 *  "Custom" first row so the picker never lies about the current value. */
export function themeItems(cfg: AppConfig): DialogSelectItem[] {
  const current = cfg.theme.accent;
  const rows: DialogSelectItem[] = THEME_PRESETS.map((p) => ({
    id: p.accent,
    label: p.label,
    detail: p.accent,
    current: p.accent === current,
    swatch: p.rgb,
  }));
  if (!THEME_PRESETS.some((p) => p.accent === current)) {
    rows.unshift({ id: current, label: "Custom", detail: current, current: true });
  }
  return rows;
}

/** PURE — the RGB swatch for an accent value, when it is a known preset. */
export function presetRgb(accent: string): [number, number, number] | null {
  return THEME_PRESETS.find((p) => p.accent === accent)?.rgb ?? null;
}

/** PURE — the patch persisting a picked accent. */
export function themePatch(accent: string): AppConfigPatch {
  return { theme: { accent } };
}

// ── Notifications ────────────────────────────────────────────────────────────

export type NotificationToggleId = "enabled" | "toast" | "macos" | "onBlocked" | "onDone";

const onOff = (v: boolean) => (v ? "on" : "off");

/** PURE — the notification toggle rows (the REAL fields notify.ts reads: the
 *  typed toast/macos plus the polish-era raw fields), and a quiet-hours row
 *  that descends into its own flow. Enter toggles in place. */
export function notificationItems(prefs: NotificationPrefs): DialogSelectItem[] {
  return [
    { id: "enabled", label: "All notifications", detail: onOff(prefs.enabled) },
    { id: "toast", label: "In-terminal toasts", detail: onOff(prefs.toast) },
    { id: "macos", label: "macOS banners", detail: onOff(prefs.macos) },
    { id: "onBlocked", label: "Alert when an agent needs you", detail: onOff(prefs.onBlocked) },
    { id: "onDone", label: "Alert when an agent finishes", detail: onOff(prefs.onDone) },
    { id: "quietHours", label: "Quiet hours…", detail: quietHoursSummary(prefs) },
  ];
}

/** PURE — flip one notification toggle. */
export function notificationTogglePatch(
  id: NotificationToggleId,
  prefs: NotificationPrefs,
): AppConfigPatch {
  return { notifications: { [id]: !prefs[id] } };
}

/** PURE — "22:00–08:00" or "off". */
export function quietHoursSummary(prefs: NotificationPrefs): string {
  return prefs.quietHours ? `${prefs.quietHours.start}–${prefs.quietHours.end}` : "off";
}

/** PURE — the quiet-hours chooser rows. */
export function quietHoursItems(prefs: NotificationPrefs): DialogSelectItem[] {
  return [
    { id: "off", label: "Off — always notify", current: prefs.quietHours === null },
    {
      id: "window",
      label: "Silence banners during a daily window…",
      detail: prefs.quietHours ? quietHoursSummary(prefs) : undefined,
      current: prefs.quietHours !== null,
    },
  ];
}

/** PURE — HH:MM validation with a plain error. */
export function validateQuietTime(value: string): string | null {
  return parseHHMM(value.trim()) === null ? "Use 24-hour HH:MM — for example 22:00" : null;
}

/** PURE — persist a quiet window (times already validated). */
export function quietHoursPatch(start: string, end: string): AppConfigPatch {
  return { notifications: { quietHours: { start: start.trim(), end: end.trim() } } };
}

/** PURE — remove the quiet window. */
export function quietHoursOffPatch(): AppConfigPatch {
  return { notifications: { quietHours: undefined } };
}

// ── Updates & updater cadence ────────────────────────────────────────────────

/** PURE — the updates dialog rows: the check toggle + the two cadence numbers. */
export function updatesItems(cfg: AppConfig): DialogSelectItem[] {
  return [
    { id: "check", label: "Check for tmux-ide updates", detail: onOff(cfg.updates.check) },
    {
      id: "tickMs",
      label: "Background refresh interval…",
      detail: `${cfg.updater.tickMs} ms`,
    },
    {
      id: "snapshotEvery",
      label: "Save a crash snapshot every…",
      detail: `${cfg.updater.snapshotEvery} refreshes`,
    },
  ];
}

export function updatesCheckPatch(cfg: AppConfig): AppConfigPatch {
  return { updates: { check: !cfg.updates.check } };
}

/** PURE — 250–60000 ms, whole numbers (guards a config that would spin or
 *  starve the chrome). */
export function validateTickMs(value: string): string | null {
  const n = Number(value.trim());
  if (!Number.isInteger(n) || n < 250 || n > 60_000) {
    return "Use a whole number of milliseconds between 250 and 60000";
  }
  return null;
}

/** PURE — 1–1000 refreshes. */
export function validateSnapshotEvery(value: string): string | null {
  const n = Number(value.trim());
  if (!Number.isInteger(n) || n < 1 || n > 1000) {
    return "Use a whole number between 1 and 1000";
  }
  return null;
}

export function tickMsPatch(value: string): AppConfigPatch {
  return { updater: { tickMs: Number(value.trim()) } };
}

export function snapshotEveryPatch(value: string): AppConfigPatch {
  return { updater: { snapshotEvery: Number(value.trim()) } };
}

// ── Crash restore ────────────────────────────────────────────────────────────

/** PURE — the restore On/Off rows. */
export function restoreItems(cfg: AppConfig): DialogSelectItem[] {
  return [
    {
      id: "on",
      label: "Revive agents automatically",
      detail: "restore resumes claude conversations",
      current: cfg.restore.resumeAgents,
    },
    {
      id: "off",
      label: "Rebuild sessions only",
      detail: "agents stay stopped",
      current: !cfg.restore.resumeAgents,
    },
  ];
}

export function restorePatch(id: string): AppConfigPatch {
  return { restore: { resumeAgents: id === "on" } };
}

// ── Keyboard shortcut viewer (read-only) ─────────────────────────────────────

/** Mirrors {@link ../chrome/statusline.ts}'s prefix-twin derivation — the
 *  letters tmux binds by default (never clobbered) and the documented remaps.
 *  A drift test asserts agreement with `prefixKeyBinds` for the defaults. */
const PREFIX_TAKEN = new Set([..."cdfilmnopqrstwxz"]);
const PREFIX_REMAP: Record<string, string> = { "M-m": "u", "M-p": "j", "M-,": "v" };

/** PURE — the reliable `prefix <letter>` twin for an Alt key, or null when the
 *  letter is taken by a stock tmux bind and has no documented remap. */
export function prefixTwinFor(altKey: string): string | null {
  const remapped = PREFIX_REMAP[altKey];
  if (remapped) return remapped;
  const letter = /^M-([a-z])$/.exec(altKey)?.[1];
  if (!letter || PREFIX_TAKEN.has(letter)) return null;
  return letter;
}

/** THE app-key enumeration — the ONE place the unified app's fixed keys are
 *  listed (M24.4). The keybind viewer's app rows AND the palette's right-aligned
 *  row shortcuts both read this; `paletteAction` is the stable palette action
 *  key ({@link ./palette.ts}'s paletteActionKey) a keycap attaches to. */
const APP_KEY_ROWS: ReadonlyArray<{ label: string; keycap: string; paletteAction?: string }> = [
  { label: "Command palette", keycap: "F5 · ^p" },
  { label: "Home tab", keycap: "F1", paletteAction: "tab:home" },
  { label: "Terminal tab", keycap: "F2", paletteAction: "tab:terminal" },
  { label: "Files tab", keycap: "F3", paletteAction: "tab:files" },
  { label: "Diff tab", keycap: "F4", paletteAction: "tab:diff" },
  { label: "Save file", keycap: "^s", paletteAction: "save" },
  { label: "Back to Home", keycap: "^g" },
  { label: "Toggle editor", keycap: "^e" },
  { label: "Quit / detach", keycap: "^q", paletteAction: "quit" },
];

/** PURE — palette action key → keycap, derived from {@link APP_KEY_ROWS}. The
 *  palette right-aligns these on rows that have one; app.tsx drops `quit` in
 *  HOSTED mode, where ^q detaches instead. */
export const PALETTE_KEYCAPS: Readonly<Record<string, string>> = Object.fromEntries(
  APP_KEY_ROWS.filter((r) => r.paletteAction).map((r) => [r.paletteAction!, r.keycap]),
);

/** PURE — the read-only shortcut rows: the chrome actions from the LIVE config
 *  (prefix-first, the Alt fast path second — the prefix form is the one that
 *  survives every keyboard protocol) and then the app's fixed keys
 *  ({@link APP_KEY_ROWS}). `superK` appends the kitty-protocol ⌘K fast path to
 *  the palette row — shown only when the renderer actually enables it. */
export function keybindingItems(keys: AppKeys, superK = false): DialogSelectItem[] {
  const chrome: Array<{ label: string; altKey: string }> = [
    { label: "Home cockpit", altKey: keys.home },
    { label: "Session switcher", altKey: keys.popup },
    { label: "Cheat sheet", altKey: keys.cheatsheet },
    { label: "Actions menu", altKey: keys.menu },
    { label: "Sidebar", altKey: keys.sidebar },
    { label: "Explorer panel", altKey: keys.panels.explorer },
    { label: "Git changes panel", altKey: keys.panels.changes },
    { label: "Config panel", altKey: keys.panels.config },
  ];
  const rows: DialogSelectItem[] = chrome.map(({ label, altKey }) => {
    const twin = prefixTwinFor(altKey);
    return {
      id: `chrome:${label}`,
      label,
      detail: twin ? `prefix ${twin} · ${altKey}` : altKey,
    };
  });
  for (const { label, keycap } of APP_KEY_ROWS) {
    const detail = superK && label === "Command palette" ? `${keycap} · ⌘K` : keycap;
    rows.push({ id: `app:${label}`, label, detail });
  }
  return rows;
}

// ── The umbrella + reset ─────────────────────────────────────────────────────

/** PURE — the "Settings…" umbrella rows: one per command, categorized by a
 *  `Category · name` label (flat list, fuzzy-friendly), each showing its
 *  current value as the detail. Reset is the one destructive row. */
export function settingsRootItems(cfg: AppConfig, prefs: NotificationPrefs): DialogSelectItem[] {
  const accent = cfg.theme.accent;
  const preset = THEME_PRESETS.find((p) => p.accent === accent);
  return [
    {
      id: "settings-theme",
      label: "Appearance · Accent color",
      detail: preset?.label.replace(" (default)", "") ?? accent,
    },
    {
      id: "settings-notifications",
      label: "Notifications · Alerts & channels",
      detail: prefs.enabled ? "on" : "off",
    },
    {
      id: "settings-quiet-hours",
      label: "Notifications · Quiet hours",
      detail: quietHoursSummary(prefs),
    },
    {
      id: "settings-updates",
      label: "Updates · Checks & refresh",
      detail: cfg.updates.check ? "checking" : "off",
    },
    {
      id: "settings-restore",
      label: "Sessions · Crash restore",
      detail: cfg.restore.resumeAgents ? "revives agents" : "sessions only",
    },
    { id: "settings-keys", label: "Keyboard · Shortcuts", detail: "view" },
    { id: "settings-reset", label: "Reset · All settings to defaults", danger: true },
  ];
}

/** PURE — the reset patch: DELETE the blocks the settings surface manages so
 *  the parser's defaults take over. Key binds and unknown user fields are
 *  deliberately preserved — reset returns the LOOK and BEHAVIOR to stock
 *  without silently unbinding the user's keys. */
export function resetSettingsPatch(): AppConfigPatch {
  return {
    theme: undefined,
    notifications: undefined,
    updater: undefined,
    updates: undefined,
    restore: undefined,
  };
}
