/**
 * Solid settings store — Solid port of `dashboard/lib/useSettings.ts`.
 *
 * Module-level signal so every consumer reads the same source. Same
 * localStorage key as the React app (`tmux-ide.settings.v1`) so the
 * user's preferences survive the runtime swap at G16-P4 cutover.
 *
 * `applyTheme()` writes `data-theme` on `<html>`, which the design
 * tokens in `src/styles.css` use to switch palettes. Calling it on
 * load + every patch keeps the cascade in lockstep with the persisted
 * value.
 */

import { createSignal } from "solid-js";

export type ThemeId =
  | "dark"
  | "light"
  | "catppuccin"
  | "dracula"
  | "tokyonight"
  | "solarized-dark"
  | "gruvbox-dark"
  | "gruvbox-light";

export interface Settings {
  themeId: ThemeId;
  terminal: {
    fontSize: number;
    fontFamily: string;
    scrollback: number;
    cursorBlink: boolean;
    renderer: "auto" | "webgl" | "dom";
  };
  sounds: {
    onTaskComplete: boolean;
    onTaskError: boolean;
    onAgentIdle: boolean;
  };
  general: {
    defaultProjectTab:
      | "kanban"
      | "mission"
      | "diffs"
      | "plans"
      | "validation"
      | "metrics"
      | "activity";
    showNotifications: boolean;
    addProjectBaseDirectory: string;
  };
  keybinds: Record<string, string>;
}

export const defaultSettings: Settings = {
  themeId: "dark",
  terminal: {
    fontSize: 11,
    fontFamily: "",
    scrollback: 5000,
    cursorBlink: true,
    renderer: "auto",
  },
  sounds: { onTaskComplete: false, onTaskError: false, onAgentIdle: false },
  general: {
    defaultProjectTab: "kanban",
    showNotifications: true,
    addProjectBaseDirectory: "~/",
  },
  keybinds: {},
};

const STORAGE_KEY = "tmux-ide.settings.v1";

const THEME_IDS: ReadonlyArray<ThemeId> = [
  "dark",
  "light",
  "catppuccin",
  "dracula",
  "tokyonight",
  "solarized-dark",
  "gruvbox-dark",
  "gruvbox-light",
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isThemeId(v: unknown): v is ThemeId {
  return typeof v === "string" && (THEME_IDS as ReadonlyArray<string>).includes(v);
}

function isProjectTab(v: unknown): v is Settings["general"]["defaultProjectTab"] {
  return (
    v === "kanban" ||
    v === "mission" ||
    v === "diffs" ||
    v === "plans" ||
    v === "validation" ||
    v === "metrics" ||
    v === "activity"
  );
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function normalize(value: unknown): Settings {
  if (!isRecord(value)) return defaultSettings;
  const terminal = isRecord(value.terminal) ? value.terminal : {};
  const sounds = isRecord(value.sounds) ? value.sounds : {};
  const general = isRecord(value.general) ? value.general : {};
  const keybinds = isRecord(value.keybinds) ? value.keybinds : {};
  return {
    themeId: isThemeId(value.themeId) ? value.themeId : defaultSettings.themeId,
    terminal: {
      fontSize: clamp(terminal.fontSize, defaultSettings.terminal.fontSize, 8, 32),
      fontFamily:
        typeof terminal.fontFamily === "string"
          ? terminal.fontFamily.trim()
          : defaultSettings.terminal.fontFamily,
      scrollback: clamp(terminal.scrollback, defaultSettings.terminal.scrollback, 1000, 100_000),
      cursorBlink:
        typeof terminal.cursorBlink === "boolean"
          ? terminal.cursorBlink
          : defaultSettings.terminal.cursorBlink,
      renderer:
        terminal.renderer === "webgl" || terminal.renderer === "dom" || terminal.renderer === "auto"
          ? terminal.renderer
          : defaultSettings.terminal.renderer,
    },
    sounds: {
      onTaskComplete:
        typeof sounds.onTaskComplete === "boolean"
          ? sounds.onTaskComplete
          : defaultSettings.sounds.onTaskComplete,
      onTaskError:
        typeof sounds.onTaskError === "boolean"
          ? sounds.onTaskError
          : defaultSettings.sounds.onTaskError,
      onAgentIdle:
        typeof sounds.onAgentIdle === "boolean"
          ? sounds.onAgentIdle
          : defaultSettings.sounds.onAgentIdle,
    },
    general: {
      defaultProjectTab: isProjectTab(general.defaultProjectTab)
        ? general.defaultProjectTab
        : defaultSettings.general.defaultProjectTab,
      showNotifications:
        typeof general.showNotifications === "boolean"
          ? general.showNotifications
          : defaultSettings.general.showNotifications,
      addProjectBaseDirectory:
        typeof general.addProjectBaseDirectory === "string" &&
        general.addProjectBaseDirectory.trim().length > 0
          ? general.addProjectBaseDirectory
          : defaultSettings.general.addProjectBaseDirectory,
    },
    keybinds: Object.fromEntries(
      Object.entries(keybinds).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" && typeof entry[1] === "string",
      ),
    ),
  };
}

function readPersisted(): Settings {
  if (typeof window === "undefined") return defaultSettings;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultSettings;
    return normalize(JSON.parse(raw));
  } catch {
    return defaultSettings;
  }
}

function persist(next: Settings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* quota / disabled */
  }
}

export function applyTheme(themeId: ThemeId): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = themeId;
}

const [settingsSignal, setSettingsSignal] = createSignal<Settings>(readPersisted());

if (typeof document !== "undefined") applyTheme(settingsSignal().themeId);

type SettingsListener = (next: Settings, prev: Settings) => void;
const listeners = new Set<SettingsListener>();

export function onSettingsChange(listener: SettingsListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function write(next: Settings): void {
  const normalized = normalize(next);
  const prev = settingsSignal();
  setSettingsSignal(normalized);
  persist(normalized);
  applyTheme(normalized.themeId);
  for (const fn of listeners) {
    try {
      fn(normalized, prev);
    } catch {
      /* listener errors are isolated */
    }
  }
}

function patch(recipe: (current: Settings) => Settings): void {
  write(recipe(settingsSignal()));
}

export const settings = settingsSignal;

export function getSettingsSnapshot(): Settings {
  return settingsSignal();
}

export function setThemeId(themeId: ThemeId): void {
  patch((current) => ({ ...current, themeId }));
}

export function setTerminal(next: Partial<Settings["terminal"]>): void {
  patch((current) => ({ ...current, terminal: { ...current.terminal, ...next } }));
}

export function setSound(kind: keyof Settings["sounds"], value: boolean): void {
  patch((current) => ({ ...current, sounds: { ...current.sounds, [kind]: value } }));
}

export function setGeneral(next: Partial<Settings["general"]>): void {
  patch((current) => ({ ...current, general: { ...current.general, ...next } }));
}

export function setKeybindOverride(actionId: string, keybind: string): void {
  patch((current) => ({ ...current, keybinds: { ...current.keybinds, [actionId]: keybind } }));
}

export function resetKeybind(actionId: string): void {
  patch((current) => {
    const keybinds = { ...current.keybinds };
    delete keybinds[actionId];
    return { ...current, keybinds };
  });
}

export function resetAllSettings(): void {
  write(defaultSettings);
}

/** Test-only reset; takes an optional override for fixture setups. */
export function __resetSettingsForTests(next?: Partial<Settings>): void {
  write({ ...defaultSettings, ...next });
}
