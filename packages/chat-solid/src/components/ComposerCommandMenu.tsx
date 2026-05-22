import { createEffect, createSignal, For, onCleanup, Show, type Accessor } from "solid-js";
import type { CommandSearchResult } from "../lib/slashCommandSearch";
import type { AvailableCommand } from "../types";

interface ComposerCommandMenuProps {
  open: Accessor<boolean>;
  results: Accessor<CommandSearchResult[]>;
  highlightedIndex: Accessor<number>;
  onHighlight(index: number): void;
  onSelect(command: AvailableCommand): void;
  anchor: Accessor<HTMLElement | undefined>;
}

function highlightedName(result: CommandSearchResult) {
  const matched = new Set(result.matched);
  return (
    <For each={[...result.command.name]}>
      {(character, index) => (
        <span class={matched.has(index()) ? "font-semibold text-fg" : undefined}>{character}</span>
      )}
    </For>
  );
}

export function ComposerCommandMenu(props: ComposerCommandMenuProps) {
  const [width, setWidth] = createSignal(320);

  createEffect(() => {
    if (!props.open()) return;
    const anchor = props.anchor();
    if (!anchor) return;

    const updateWidth = () => {
      const rect = anchor.getBoundingClientRect();
      setWidth(Math.max(240, Math.min(480, rect.width)));
    };

    updateWidth();
    window.addEventListener("resize", updateWidth);
    onCleanup(() => window.removeEventListener("resize", updateWidth));
  });

  return (
    <Show when={props.open()}>
      <div
        class="absolute bottom-[calc(100%+0.5rem)] left-0 z-30 overflow-hidden rounded-md border border-border bg-surface-elevated text-base shadow-2xl"
        style={{ width: `${width()}px` }}
        role="listbox"
        aria-label="Slash commands"
      >
        <Show
          when={props.results().length > 0}
          fallback={<div class="px-3 py-4 text-center text-dim">No commands found</div>}
        >
          <div class="max-h-64 overflow-y-auto p-1">
            <For each={props.results()}>
              {(result, index) => (
                <button
                  type="button"
                  data-command-index={index()}
                  class={`block w-full cursor-pointer rounded-sm border-0 bg-transparent px-2 py-1.5 text-left text-fg ${
                    props.highlightedIndex() === index() ? "bg-surface-hover" : ""
                  }`}
                  role="option"
                  aria-selected={props.highlightedIndex() === index()}
                  onMouseEnter={() => props.onHighlight(index())}
                  onClick={() => props.onSelect(result.command)}
                >
                  <div class="truncate">{highlightedName(result)}</div>
                  <Show when={result.command.description}>
                    {(description) => (
                      <div class="mt-0.5 truncate text-sm text-dim">{description()}</div>
                    )}
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>
        <div class="border-t border-border-weak px-3 py-1.5 text-sm text-dim">
          ↑↓ navigate · Enter select · Esc close
        </div>
      </div>
    </Show>
  );
}
