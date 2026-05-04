"use client";

import { useSyncExternalStore } from "react";
import { Persist } from "@/lib/persist";
import type { ActivitySection } from "@/lib/useLayoutState";

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
    scrollback: number;
    cursorBlink: boolean;
    /**
     * Renderer choice for the embedded xterm. "auto" picks WebGL on desktop
     * and DOM on iOS / iPadOS where Safari's WebGL has known issues with
     * subpixel positioning + atlas sizing. Force "webgl" for max perf or
     * "dom" if you hit rendering glitches.
     */
    renderer: "auto" | "webgl" | "dom";
  };
  sounds: {
    onTaskComplete: boolean;
    onTaskError: boolean;
    onAgentIdle: boolean;
  };
  general: {
    defaultActivity: ActivitySection;
    defaultProjectTab:
      | "kanban"
      | "mission"
      | "diffs"
      | "plans"
      | "validation"
      | "metrics"
      | "activity";
    showNotifications: boolean;
  };
  keybinds: Record<string, string>;
}

export const defaultSettings: Settings = {
  themeId: "dark",
  terminal: {
    fontSize: 11,
    scrollback: 5000,
    cursorBlink: true,
    renderer: "auto",
  },
  sounds: {
    onTaskComplete: false,
    onTaskError: false,
    onAgentIdle: false,
  },
  general: {
    defaultActivity: "sessions",
    defaultProjectTab: "kanban",
    showNotifications: true,
  },
  keybinds: {},
};

const persist = Persist.global<Settings>("tmux-ide.settings", ["v1"], defaultSettings);
const listeners = new Set<() => void>();
let state = normalizeSettings(persist.read());

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThemeId(value: unknown): value is ThemeId {
  return (
    value === "dark" ||
    value === "light" ||
    value === "catppuccin" ||
    value === "dracula" ||
    value === "tokyonight" ||
    value === "solarized-dark" ||
    value === "gruvbox-dark" ||
    value === "gruvbox-light"
  );
}

function isActivitySection(value: unknown): value is ActivitySection {
  return value === "sessions" || value === "settings" || value === "skills";
}

function isProjectTab(value: unknown): value is Settings["general"]["defaultProjectTab"] {
  return (
    value === "kanban" ||
    value === "mission" ||
    value === "diffs" ||
    value === "plans" ||
    value === "validation" ||
    value === "metrics" ||
    value === "activity"
  );
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function normalizeSettings(value: unknown): Settings {
  if (!isRecord(value)) return defaultSettings;
  const terminal = isRecord(value.terminal) ? value.terminal : {};
  const sounds = isRecord(value.sounds) ? value.sounds : {};
  const general = isRecord(value.general) ? value.general : {};
  const keybinds = isRecord(value.keybinds) ? value.keybinds : {};

  return {
    themeId: isThemeId(value.themeId) ? value.themeId : defaultSettings.themeId,
    terminal: {
      fontSize: clampNumber(terminal.fontSize, defaultSettings.terminal.fontSize, 10, 20),
      scrollback: clampNumber(
        terminal.scrollback,
        defaultSettings.terminal.scrollback,
        1000,
        50000,
      ),
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
      defaultActivity: isActivitySection(general.defaultActivity)
        ? general.defaultActivity
        : defaultSettings.general.defaultActivity,
      defaultProjectTab: isProjectTab(general.defaultProjectTab)
        ? general.defaultProjectTab
        : defaultSettings.general.defaultProjectTab,
      showNotifications:
        typeof general.showNotifications === "boolean"
          ? general.showNotifications
          : defaultSettings.general.showNotifications,
    },
    keybinds: Object.fromEntries(
      Object.entries(keybinds).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" && typeof entry[1] === "string",
      ),
    ),
  };
}

export function applyTheme(themeId: ThemeId): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = themeId;
}

if (typeof document !== "undefined") applyTheme(state.themeId);

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): Settings {
  return state;
}

function write(next: Settings): void {
  state = normalizeSettings(next);
  persist.write(state);
  applyTheme(state.themeId);
  emit();
}

function patch(recipe: (current: Settings) => Settings): void {
  write(recipe(state));
}

export function getSettingsSnapshot(): Settings {
  return state;
}

export function getEffectiveKeybind(actionId: string, fallback?: string): string | undefined {
  return state.keybinds[actionId] ?? fallback;
}

const settingsActions = {
  setThemeId(themeId: ThemeId) {
    patch((current) => ({ ...current, themeId }));
  },
  setTerminal(next: Partial<Settings["terminal"]>) {
    patch((current) => ({
      ...current,
      terminal: normalizeSettings({ ...current, terminal: { ...current.terminal, ...next } })
        .terminal,
    }));
  },
  setSound(kind: keyof Settings["sounds"], value: boolean) {
    patch((current) => ({ ...current, sounds: { ...current.sounds, [kind]: value } }));
  },
  setGeneral(next: Partial<Settings["general"]>) {
    patch((current) => ({ ...current, general: { ...current.general, ...next } }));
  },
  setKeybindOverride(actionId: string, keybind: string) {
    patch((current) => ({ ...current, keybinds: { ...current.keybinds, [actionId]: keybind } }));
  },
  resetKeybind(actionId: string) {
    patch((current) => {
      const keybinds = { ...current.keybinds };
      delete keybinds[actionId];
      return { ...current, keybinds };
    });
  },
  resetAll() {
    write(defaultSettings);
  },
};

export function useSettings(): Settings & {
  setThemeId(themeId: ThemeId): void;
  setTerminal(patch: Partial<Settings["terminal"]>): void;
  setSound(kind: keyof Settings["sounds"], value: boolean): void;
  setGeneral(patch: Partial<Settings["general"]>): void;
  setKeybindOverride(actionId: string, keybind: string): void;
  resetKeybind(actionId: string): void;
  resetAll(): void;
} {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    ...snapshot,
    ...settingsActions,
  };
}

export function __resetSettingsForTests(next?: Partial<Settings>): void {
  state = normalizeSettings({ ...defaultSettings, ...next });
  persist.write(state);
  applyTheme(state.themeId);
  emit();
}
