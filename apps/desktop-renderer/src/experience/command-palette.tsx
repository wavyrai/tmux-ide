import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";

import { EmptyState } from "../ui-system/index.ts";
import { DomIcon } from "./dom-icon.tsx";
import type { DomPaletteEntry } from "./dom-shell.ts";

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly entries: readonly DomPaletteEntry[];
  readonly transitionSource?: "keyboard" | "mouse";
  readonly onClose: (source: "keyboard" | "mouse") => void;
  readonly onClosed?: () => void;
  readonly onActivate: (entry: DomPaletteEntry, source: "keyboard" | "mouse") => void;
}

export interface RankedDomPaletteEntry {
  readonly entry: DomPaletteEntry;
  readonly score: number;
}

const PALETTE_INPUT_ID = "application-command-palette-input";
const PALETTE_LIST_ID = "application-command-palette-list";

function normalized(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .trim()
    .toLocaleLowerCase();
}

function subsequencePenalty(candidate: string, query: string): number | null {
  let cursor = 0;
  let penalty = 0;
  for (const character of query) {
    const index = candidate.indexOf(character, cursor);
    if (index < 0) return null;
    penalty += index - cursor;
    cursor = index + 1;
  }
  return penalty;
}

/** Stable, deterministic ranking shared by keyboard and pointer palette views. */
export function scoreDomPaletteEntry(entry: DomPaletteEntry, rawQuery: string): number | null {
  const query = normalized(rawQuery);
  if (!query) return entry.group.order * 1_000 + entry.rank;
  const label = normalized(entry.label);
  const description = normalized(entry.description);
  const keywords = entry.keywords.map(normalized);
  const words = label.split(/\s+/u);

  if (label === query) return 0;
  if (label.startsWith(query)) return 10 + label.length - query.length;
  const wordIndex = words.findIndex((word) => word.startsWith(query));
  if (wordIndex >= 0) return 30 + wordIndex * 4;
  const labelIndex = label.indexOf(query);
  if (labelIndex >= 0) return 50 + labelIndex;
  const keywordIndex = keywords.findIndex((keyword) => keyword.startsWith(query));
  if (keywordIndex >= 0) return 70 + keywordIndex * 3;
  const descriptionIndex = description.indexOf(query);
  if (descriptionIndex >= 0) return 90 + descriptionIndex;
  const penalty = subsequencePenalty(label, query);
  return penalty === null ? null : 130 + penalty;
}

export function rankDomPaletteEntries(
  entries: readonly DomPaletteEntry[],
  query: string,
): readonly RankedDomPaletteEntry[] {
  return entries
    .flatMap((entry) => {
      const score = scoreDomPaletteEntry(entry, query);
      return score === null ? [] : [{ entry, score }];
    })
    .sort(
      (left, right) =>
        left.score - right.score ||
        left.entry.group.order - right.entry.group.order ||
        left.entry.rank - right.entry.rank ||
        left.entry.label.localeCompare(right.entry.label),
    );
}

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
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const options: Array<HTMLElement | undefined> = [];

  const filteredEntries = createMemo(() =>
    rankDomPaletteEntries(props.entries, query()).map(({ entry }) => entry),
  );
  const groupedEntries = createMemo(() => {
    const groups = new Map<
      string,
      { group: DomPaletteEntry["group"]; entries: Array<{ entry: DomPaletteEntry; index: number }> }
    >();
    for (const [index, entry] of filteredEntries().entries()) {
      const group = groups.get(entry.group.id) ?? { group: entry.group, entries: [] };
      group.entries.push({ entry, index });
      groups.set(entry.group.id, group);
    }
    return [...groups.values()].sort((left, right) => left.group.order - right.group.order);
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
            const completeClose = () => {
              closeTimer = undefined;
              if (!props.open) props.onClosed?.();
            };
            if (props.transitionSource === "mouse") {
              closeTimer = setTimeout(completeClose, 100);
            } else {
              queueMicrotask(completeClose);
            }
          }
          return;
        }
        if (closeTimer !== undefined) {
          clearTimeout(closeTimer);
          closeTimer = undefined;
        }
        setQuery("");
        setSelectedIndex(edgeEnabledIndex(props.entries, false));
        setHoveredIndex(null);
        queueMicrotask(() => input?.focus());
      },
    ),
  );

  onCleanup(() => {
    if (closeTimer !== undefined) clearTimeout(closeTimer);
  });

  createEffect(
    on(query, () => {
      setSelectedIndex(edgeEnabledIndex(filteredEntries(), false));
      setHoveredIndex(null);
    }),
  );

  createEffect(() => {
    if (!props.open) return;
    const index = selectedIndex();
    if (index >= 0) options[index]?.scrollIntoView?.({ block: "nearest" });
  });

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
      data-transition-source={props.transitionSource ?? "keyboard"}
      data-state={props.open ? "open" : "closed"}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose("mouse");
      }}
    >
      <section
        class="command-palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby="application-command-palette-title"
        aria-describedby="application-command-palette-description"
        onKeyDown={handleKeyDown}
      >
        <header class="command-palette__header">
          <h2 id="application-command-palette-title">Command menu</h2>
          <p id="application-command-palette-description">
            Navigate the workspace and open workbench tools
          </p>
        </header>
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
            aria-keyshortcuts="ArrowDown ArrowUp Home End Enter Escape"
            autocomplete="off"
            placeholder="Search commands…"
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
          <For each={groupedEntries()}>
            {(group) => (
              <section
                class="command-palette__group"
                role="group"
                aria-labelledby={`palette-group-${group.group.id}`}
              >
                <h3 id={`palette-group-${group.group.id}`}>{group.group.label}</h3>
                <For each={group.entries}>
                  {(item) => {
                    const entry = item.entry;
                    const index = item.index;
                    return (
                      <div
                        ref={(element) => (options[index] = element)}
                        id={`palette-option-${entry.id}`}
                        class="command-palette__option"
                        classList={{
                          "command-palette__option--selected": selectedIndex() === index,
                          "command-palette__option--hovered": hoveredIndex() === index,
                        }}
                        role="option"
                        aria-selected={selectedIndex() === index}
                        aria-disabled={entry.disabledReason !== null}
                        title={entry.disabledReason ?? entry.description}
                        data-surface={entry.id}
                        data-group={entry.group.id}
                        onMouseEnter={() => {
                          setHoveredIndex(index);
                          if (!entry.disabledReason) setSelectedIndex(index);
                        }}
                        onMouseLeave={() => setHoveredIndex(null)}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                          if (!entry.disabledReason) props.onActivate(entry, "mouse");
                        }}
                      >
                        <span class="command-palette__icon" aria-hidden="true">
                          <DomIcon id={entry.icon} usage="action" />
                        </span>
                        <span class="command-palette__copy">
                          <span class="command-palette__label">{entry.label}</span>
                          <small>{entry.disabledReason ?? entry.description}</small>
                        </span>
                        <Show when={entry.current}>
                          <span class="command-palette__current">Current</span>
                        </Show>
                        <kbd>{entry.shortcut}</kbd>
                      </div>
                    );
                  }}
                </For>
              </section>
            )}
          </For>
          <Show when={filteredEntries().length === 0}>
            <EmptyState
              class="command-palette__empty"
              size="compact"
              live="polite"
              icon={<DomIcon id="search" usage="action" />}
              title="No commands found"
              description={
                <>
                  Nothing matches <strong>{query()}</strong>. Try a surface, panel, or tool name.
                </>
              }
            />
          </Show>
        </div>
        <footer class="command-palette__footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> Navigate
          </span>
          <span>
            <kbd>↵</kbd> Open
          </span>
          <span>
            <kbd>Esc</kbd> Close
          </span>
          <span class="command-palette__count">{filteredEntries().length} commands</span>
        </footer>
      </section>
    </div>
  );
}
