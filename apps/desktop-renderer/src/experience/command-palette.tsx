import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js";

import { DomIcon } from "./dom-icon.tsx";
import type { DomPaletteEntry } from "./dom-shell.ts";

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly entries: readonly DomPaletteEntry[];
  readonly onClose: (source: "keyboard" | "mouse") => void;
  readonly onClosed?: () => void;
  readonly onActivate: (entry: DomPaletteEntry, source: "keyboard" | "mouse") => void;
}

const PALETTE_INPUT_ID = "application-command-palette-input";
const PALETTE_LIST_ID = "application-command-palette-list";

function nextEnabledIndex(
  entries: readonly DomPaletteEntry[],
  current: number,
  direction: 1 | -1,
): number {
  if (entries.length === 0) return -1;
  for (let offset = 1; offset <= entries.length; offset += 1) {
    const index = (current + direction * offset + entries.length) % entries.length;
    if (!entries[index]?.disabledReason) return index;
  }
  return -1;
}

function edgeEnabledIndex(entries: readonly DomPaletteEntry[], fromEnd: boolean): number {
  const indexes = entries.map((_, index) => index);
  if (fromEnd) indexes.reverse();
  return indexes.find((index) => !entries[index]?.disabledReason) ?? -1;
}

export function CommandPalette(props: CommandPaletteProps) {
  const [query, setQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [hoveredIndex, setHoveredIndex] = createSignal<number | null>(null);
  let overlay: HTMLDivElement | undefined;
  let input: HTMLInputElement | undefined;
  let previousFocus: HTMLElement | null = null;

  const filteredEntries = createMemo(() => {
    const needle = query().trim().toLocaleLowerCase();
    return needle
      ? props.entries.filter((entry) => entry.label.toLocaleLowerCase().includes(needle))
      : props.entries;
  });
  const activeEntry = createMemo(() => filteredEntries()[selectedIndex()] ?? null);

  createEffect(
    on(
      () => props.open,
      (open, previousOpen) => {
        if (!overlay) return;
        overlay.inert = !open;
        if (!open) {
          if (previousOpen) {
            queueMicrotask(() => {
              previousFocus?.focus();
              props.onClosed?.();
            });
          }
          return;
        }
        const activeElement = document.activeElement;
        previousFocus =
          activeElement && "focus" in activeElement ? (activeElement as HTMLElement) : null;
        setQuery("");
        setSelectedIndex(edgeEnabledIndex(props.entries, false));
        setHoveredIndex(null);
        queueMicrotask(() => input?.focus());
      },
    ),
  );

  createEffect(
    on(filteredEntries, (entries) => {
      const current = selectedIndex();
      if (current < entries.length && !entries[current]?.disabledReason) return;
      setSelectedIndex(edgeEnabledIndex(entries, false));
    }),
  );

  const handleKeyDown = (event: KeyboardEvent): void => {
    const entries = filteredEntries();
    if (event.key === "Escape") {
      event.preventDefault();
      props.onClose("keyboard");
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      input?.focus();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setHoveredIndex(null);
      setSelectedIndex((current) =>
        nextEnabledIndex(entries, current, event.key === "ArrowDown" ? 1 : -1),
      );
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setHoveredIndex(null);
      setSelectedIndex(edgeEnabledIndex(entries, event.key === "End"));
      return;
    }
    if (event.key === "Enter") {
      const entry = activeEntry();
      if (!entry || entry.disabledReason) return;
      event.preventDefault();
      props.onActivate(entry, "keyboard");
    }
  };

  return (
    <div
      ref={(element) => {
        overlay = element;
      }}
      class="command-palette-overlay"
      classList={{ "command-palette-overlay--open": props.open }}
      aria-hidden={props.open ? "false" : "true"}
      data-overlay-root="true"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose("mouse");
      }}
    >
      <section
        class="command-palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby="application-command-palette-title"
        onKeyDown={handleKeyDown}
      >
        <h2 id="application-command-palette-title" class="sr-only">
          Command palette
        </h2>
        <div class="command-palette__query">
          <DomIcon id="search" usage="action" />
          <input
            ref={(element) => {
              input = element;
            }}
            id={PALETTE_INPUT_ID}
            type="text"
            role="combobox"
            aria-label="Search commands"
            aria-autocomplete="list"
            aria-expanded={props.open}
            aria-controls={PALETTE_LIST_ID}
            aria-activedescendant={
              activeEntry() ? `palette-option-${activeEntry()!.id}` : undefined
            }
            autocomplete="off"
            placeholder="Type a command or surface…"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
          <kbd>Esc</kbd>
        </div>
        <div class="command-palette__rule" />
        <div
          id={PALETTE_LIST_ID}
          class="command-palette__list"
          role="listbox"
          aria-label="Available commands"
        >
          <For each={filteredEntries()}>
            {(entry, index) => (
              <div
                id={`palette-option-${entry.id}`}
                class="command-palette__option"
                classList={{
                  "command-palette__option--selected": selectedIndex() === index(),
                  "command-palette__option--hovered": hoveredIndex() === index(),
                }}
                role="option"
                aria-selected={selectedIndex() === index()}
                aria-disabled={entry.disabledReason !== null}
                title={entry.disabledReason ?? undefined}
                data-surface={entry.id}
                onMouseEnter={() => {
                  setHoveredIndex(index());
                  if (!entry.disabledReason) setSelectedIndex(index());
                }}
                onMouseLeave={() => setHoveredIndex(null)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (!entry.disabledReason) props.onActivate(entry, "mouse");
                }}
              >
                <DomIcon id={entry.icon} usage="action" />
                <span class="command-palette__label">{entry.label}</span>
                <Show when={entry.current}>
                  <span class="command-palette__current">Current</span>
                </Show>
                <Show when={entry.disabledReason}>
                  {(reason) => <span class="command-palette__reason">{reason()}</span>}
                </Show>
                <kbd>{entry.shortcut}</kbd>
              </div>
            )}
          </For>
          <Show when={filteredEntries().length === 0}>
            <p class="command-palette__empty">No matching commands</p>
          </Show>
        </div>
        <footer class="command-palette__footer">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>Esc close</span>
        </footer>
      </section>
    </div>
  );
}
