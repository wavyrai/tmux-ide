/**
 * Central global-keybind registry (G16-P4 — Cmd+K palette + cheat sheet).
 *
 * One module-level Solid signal holds every globally-routable keyboard
 * binding the dashboard exposes. The same registry feeds:
 *   - the actual `keydown` dispatcher (mounted once at app root);
 *   - the unified Cmd+K command palette (lists every binding whose
 *     `scope === "global"` so the user can fire it from search);
 *   - the Cmd+/ keyboard-shortcuts overlay (grouped read-only view).
 *
 * Bindings declared with `scope: "terminal"` (etc.) are NOT dispatched
 * by the global listener — the existing per-surface listeners keep
 * owning them. The registry still records them so the shortcut overlay
 * has a single source of truth.
 */

import { createSignal, onCleanup, onMount } from "solid-js";

export type KeybindScope = "global" | "chat" | "terminal" | "editor" | "search";

export interface KeybindCombo {
  /** Lower-case key (e.g. `"k"`, `"p"`, `"/"`). Matched against
   *  `event.key.toLowerCase()`. */
  key: string;
  /** Cmd on Mac, Ctrl on others. Defaults to true — almost every
   *  registered binding needs it. */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export interface KeybindDescriptor {
  /** Stable id. Must be unique across the registry. */
  id: string;
  /** Display label for palette + cheat sheet. */
  label: string;
  /** Cheat-sheet grouping. */
  group: "Global" | "Chat" | "Terminal" | "Editor" | "Search";
  /** Where this binding is dispatched. `"global"` means the registry
   *  fires it; anything else is documentation-only (the per-surface
   *  listener still owns dispatch — the entry just surfaces in the
   *  cheat sheet + palette). */
  scope: KeybindScope;
  /** Primary combo. Optional only for command-palette entries that
   *  exist as discoverable actions without a keyboard shortcut. */
  combo?: KeybindCombo;
  /** Optional alternate combo (e.g. Cmd+Shift+P also opens Cmd+K). */
  altCombo?: KeybindCombo;
  /** Handler the global dispatcher invokes when `scope === "global"`
   *  and the combo matches. Always exposed to the palette as the
   *  primary "activate" action. */
  run: () => void;
  /** Optional predicate gating dispatch. Returning false skips this
   *  binding (the event continues to other listeners). */
  when?: () => boolean;
  /** Hide from the cheat sheet (still callable from the palette).
   *  Useful for command-style entries that aren't strict keybinds. */
  hiddenFromCheatSheet?: boolean;
}

const [bindings, setBindings] = createSignal<readonly KeybindDescriptor[]>([]);

/** Reactive snapshot of every registered binding. */
export const allKeybinds = bindings;

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return navigator.platform.toLowerCase().includes("mac");
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

function comboMatches(combo: KeybindCombo, event: KeyboardEvent): boolean {
  const wantMod = combo.mod !== false;
  const mod = isMacPlatform() ? event.metaKey : event.ctrlKey;
  if (wantMod !== mod) return false;
  if ((combo.shift ?? false) !== event.shiftKey) return false;
  if ((combo.alt ?? false) !== event.altKey) return false;
  return event.key.toLowerCase() === combo.key.toLowerCase();
}

function descriptorMatches(descriptor: KeybindDescriptor, event: KeyboardEvent): boolean {
  if (!descriptor.combo) return false;
  if (comboMatches(descriptor.combo, event)) return true;
  if (descriptor.altCombo && comboMatches(descriptor.altCombo, event)) return true;
  return false;
}

/**
 * Register one or more bindings. Returns a disposer that removes
 * exactly the bindings this call added — safe to call from
 * `onMount` / `createEffect` cleanups. Re-registering with the same
 * `id` replaces the prior entry rather than duplicating it.
 */
export function registerKeybinds(...next: KeybindDescriptor[]): () => void {
  const ids = next.map((b) => b.id);
  setBindings((current) => [...current.filter((b) => !ids.includes(b.id)), ...next]);
  return () => {
    setBindings((current) => current.filter((b) => !ids.includes(b.id)));
  };
}

export function findKeybind(id: string): KeybindDescriptor | null {
  return bindings().find((b) => b.id === id) ?? null;
}

/**
 * Dispatch a synthetic key event against the registry. Returns true
 * when a binding fired (so callers can preventDefault / stopPropagation
 * upstream). Visible to tests so the dispatch path is verifiable
 * without standing up a real `window.keydown`.
 */
export function dispatchKey(event: KeyboardEvent): boolean {
  // Don't fire global bindings while the user is typing in a form
  // field — this is the same guard chrome.ts used. Per-surface
  // listeners are responsible for their own editable-target gating.
  if (isEditableTarget(event.target)) return false;
  for (const descriptor of bindings()) {
    if (descriptor.scope !== "global") continue;
    if (!descriptorMatches(descriptor, event)) continue;
    if (descriptor.when && !descriptor.when()) continue;
    event.preventDefault();
    descriptor.run();
    return true;
  }
  return false;
}

/**
 * Mount the global `keydown` dispatcher. Call once at app root.
 * Automatic cleanup on unmount.
 */
export function useGlobalKeybindDispatcher(): void {
  onMount(() => {
    function onKeyDown(event: KeyboardEvent): void {
      dispatchKey(event);
    }
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });
}

/** Pretty-print a combo for the cheat sheet / palette right-rail. */
export function formatCombo(combo: KeybindCombo | undefined): string {
  if (!combo) return "";
  const mac = isMacPlatform();
  const parts: string[] = [];
  if (combo.mod !== false) parts.push(mac ? "⌘" : "Ctrl");
  if (combo.shift) parts.push(mac ? "⇧" : "Shift");
  if (combo.alt) parts.push(mac ? "⌥" : "Alt");
  parts.push(combo.key.length === 1 ? combo.key.toUpperCase() : combo.key);
  return mac ? parts.join("") : parts.join("+");
}

/** Test-only: reset the registry. */
export function __resetKeybindsForTests(): void {
  setBindings([]);
}
