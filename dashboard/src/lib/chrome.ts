/**
 * Chrome layout — Solid port of `dashboard/lib/useChromeLayout.ts`.
 *
 * Tracks which of the three secondary IDE regions are visible: left
 * sidebar (Primary), right inspector (Secondary), bottom panel
 * (Panel). State persists to localStorage so refreshes preserve the
 * user's layout.
 *
 * Module-level Solid signal so every consumer reads the same source
 * of truth. Keybind installer lives here too — same Cmd+B / Cmd+Alt+B
 * (or Cmd+I) / Cmd+J bindings the React app uses, with the same
 * editable-target guard so typing in inputs doesn't collapse panels.
 */

import { createSignal, onCleanup, onMount } from "solid-js";
import { registerKeybinds } from "./keybinds";

export interface ChromeLayoutState {
  leftSidebarOpen: boolean;
  rightInspectorOpen: boolean;
  bottomPanelOpen: boolean;
}

const STORAGE_KEY = "tmux-ide.v2.chrome.v1";

const DEFAULT_STATE: ChromeLayoutState = {
  leftSidebarOpen: true,
  rightInspectorOpen: true,
  bottomPanelOpen: true,
};

function readPersisted(): ChromeLayoutState {
  if (typeof window === "undefined") return DEFAULT_STATE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw) as Partial<ChromeLayoutState>;
    return {
      leftSidebarOpen:
        typeof parsed.leftSidebarOpen === "boolean"
          ? parsed.leftSidebarOpen
          : DEFAULT_STATE.leftSidebarOpen,
      rightInspectorOpen:
        typeof parsed.rightInspectorOpen === "boolean"
          ? parsed.rightInspectorOpen
          : DEFAULT_STATE.rightInspectorOpen,
      bottomPanelOpen:
        typeof parsed.bottomPanelOpen === "boolean"
          ? parsed.bottomPanelOpen
          : DEFAULT_STATE.bottomPanelOpen,
    };
  } catch {
    return DEFAULT_STATE;
  }
}

const [chromeState, setChromeState] = createSignal<ChromeLayoutState>(readPersisted());

function persistAndSet(next: ChromeLayoutState): void {
  setChromeState(next);
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* quota / disabled — fall through silently */
  }
}

export const chrome = chromeState;

export function toggleLeftSidebar(): void {
  persistAndSet({ ...chromeState(), leftSidebarOpen: !chromeState().leftSidebarOpen });
}

export function toggleRightInspector(): void {
  persistAndSet({ ...chromeState(), rightInspectorOpen: !chromeState().rightInspectorOpen });
}

export function toggleBottomPanel(): void {
  persistAndSet({ ...chromeState(), bottomPanelOpen: !chromeState().bottomPanelOpen });
}

export function setLeftSidebarOpen(next: boolean): void {
  persistAndSet({ ...chromeState(), leftSidebarOpen: next });
}

export function setRightInspectorOpen(next: boolean): void {
  persistAndSet({ ...chromeState(), rightInspectorOpen: next });
}

export function setBottomPanelOpen(next: boolean): void {
  persistAndSet({ ...chromeState(), bottomPanelOpen: next });
}

/**
 * Install Cmd+B / Cmd+Alt+B / Cmd+I / Cmd+J keybinds. Call once per
 * mount of the IDE shell; the bindings are registered into the
 * central keybind registry (so the cheat sheet + palette see them)
 * and auto-removed on unmount.
 */
export function useChromeShortcuts(): void {
  onMount(() => {
    const dispose = registerKeybinds(
      {
        id: "chrome.toggle-left-sidebar",
        label: "Toggle primary sidebar",
        group: "Global",
        scope: "global",
        combo: { key: "b" },
        run: () => toggleLeftSidebar(),
      },
      {
        id: "chrome.toggle-right-inspector",
        label: "Toggle secondary sidebar (Inspector)",
        group: "Global",
        scope: "global",
        combo: { key: "i" },
        altCombo: { key: "b", alt: true },
        run: () => toggleRightInspector(),
      },
      {
        id: "chrome.toggle-bottom-panel",
        label: "Toggle bottom panel",
        group: "Global",
        scope: "global",
        combo: { key: "j" },
        run: () => toggleBottomPanel(),
      },
    );
    onCleanup(dispose);
  });
}

/** Test-only: reset state without persistence. */
export function __resetChromeForTests(): void {
  setChromeState(DEFAULT_STATE);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }
}
