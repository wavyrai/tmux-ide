/**
 * Keyboard-shortcuts cheat sheet (G16-P4).
 *
 * Read-only overlay listing every entry from the keybind registry,
 * grouped by `descriptor.group`. Opened with Cmd+/ or from the
 * palette ("Show keyboard shortcuts"). Esc / backdrop click closes.
 */

import { createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { allKeybinds, formatCombo, type KeybindDescriptor } from "@/lib/keybinds";

const GROUP_ORDER: KeybindDescriptor["group"][] = [
  "Global",
  "Chat",
  "Terminal",
  "Editor",
  "Search",
];

const [open, setOpen] = createSignal(false);

export function openKeyboardShortcuts(): void {
  setOpen(true);
}

export function closeKeyboardShortcuts(): void {
  setOpen(false);
}

export function KeyboardShortcuts(): JSX.Element {
  const grouped = createMemo(() => {
    const map = new Map<KeybindDescriptor["group"], KeybindDescriptor[]>();
    for (const binding of allKeybinds()) {
      if (binding.hiddenFromCheatSheet) continue;
      if (!binding.combo && !binding.altCombo) continue;
      const arr = map.get(binding.group) ?? [];
      arr.push(binding);
      map.set(binding.group, arr);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.label.localeCompare(b.label));
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({
      group: g,
      bindings: map.get(g)!,
    }));
  });

  function onWindowKey(event: KeyboardEvent): void {
    if (!open()) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeKeyboardShortcuts();
    }
  }

  onMount(() => window.addEventListener("keydown", onWindowKey));
  onCleanup(() => window.removeEventListener("keydown", onWindowKey));

  return (
    <Show when={open()}>
      <Portal>
        <div
          data-testid="keyboard-shortcuts-backdrop"
          class="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[8vh]"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeKeyboardShortcuts();
          }}
        >
          <div
            role="dialog"
            aria-label="Keyboard shortcuts"
            data-testid="keyboard-shortcuts"
            class="flex w-[680px] max-w-[92vw] max-h-[80vh] flex-col overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-strong)] shadow-2xl"
          >
            <div class="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
              <span class="text-[13px] font-medium text-[var(--fg)]">Keyboard shortcuts</span>
              <button
                type="button"
                data-testid="keyboard-shortcuts-close"
                class="text-[11px] text-[var(--dim)] hover:text-[var(--fg)]"
                onClick={() => closeKeyboardShortcuts()}
              >
                Esc
              </button>
            </div>
            <div class="min-h-0 flex-1 overflow-y-auto px-3 py-2">
              <For each={grouped()}>
                {(entry) => (
                  <section class="mb-4 last:mb-0">
                    <h3 class="mb-1 text-[10px] uppercase tracking-wider text-[var(--dim)]">
                      {entry.group}
                    </h3>
                    <ul class="grid grid-cols-1 gap-y-0.5">
                      <For each={entry.bindings}>
                        {(binding) => (
                          <li
                            data-testid={`keyboard-shortcut-${binding.id}`}
                            class="flex items-center justify-between gap-3 rounded px-2 py-1 hover:bg-[var(--surface-hover)]"
                          >
                            <span class="truncate text-[12px] text-[var(--fg)]">
                              {binding.label}
                            </span>
                            <span class="font-mono text-[11px] text-[var(--dim)]">
                              {formatCombo(binding.combo)}
                              <Show when={binding.altCombo}>
                                {(() => {
                                  const c = binding.altCombo;
                                  return c ? `  ·  ${formatCombo(c)}` : null;
                                })()}
                              </Show>
                            </span>
                          </li>
                        )}
                      </For>
                    </ul>
                  </section>
                )}
              </For>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  );
}
