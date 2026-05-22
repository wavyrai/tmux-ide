import { createEffect, createSignal, For, onCleanup, Show, type Accessor } from "solid-js";
import type { MentionCandidate, MentionSearchResult } from "../lib/mentionSearch";

interface ComposerMentionMenuProps {
  open: Accessor<boolean>;
  results: Accessor<MentionSearchResult[]>;
  highlightedIndex: Accessor<number>;
  onHighlight(index: number): void;
  onSelect(candidate: MentionCandidate): void;
  anchor: Accessor<HTMLElement | undefined>;
}

function highlightedLabel(result: MentionSearchResult) {
  const matched = new Set(result.matched);
  return (
    <For each={[...result.candidate.label]}>
      {(character, index) => (
        <span class={matched.has(index()) ? "font-semibold text-fg" : undefined}>{character}</span>
      )}
    </For>
  );
}

function kindGlyph(kind: MentionCandidate["kind"]): string {
  switch (kind) {
    case "file":
      return "▤";
    case "thread":
      return "❯";
    case "agent":
      return "◐";
    default:
      return "·";
  }
}

export function ComposerMentionMenu(props: ComposerMentionMenuProps) {
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
        aria-label="Mentions"
        data-testid="composer-mention-menu"
      >
        <Show
          when={props.results().length > 0}
          fallback={<div class="px-3 py-4 text-center text-dim">No matches</div>}
        >
          <div class="max-h-64 overflow-y-auto p-1">
            <For each={props.results()}>
              {(result, index) => (
                <button
                  type="button"
                  data-mention-index={index()}
                  data-mention-kind={result.candidate.kind}
                  class={`flex w-full cursor-pointer items-center gap-2 rounded-sm border-0 bg-transparent px-2 py-1.5 text-left text-fg ${
                    props.highlightedIndex() === index() ? "bg-surface-hover" : ""
                  }`}
                  role="option"
                  aria-selected={props.highlightedIndex() === index()}
                  onMouseEnter={() => props.onHighlight(index())}
                  onClick={() => props.onSelect(result.candidate)}
                >
                  <span aria-hidden="true" class="w-4 text-center text-sm text-dim">
                    {kindGlyph(result.candidate.kind)}
                  </span>
                  <span class="min-w-0 flex-1">
                    <div class="truncate">{highlightedLabel(result)}</div>
                    <Show when={result.candidate.hint}>
                      {(hint) => <div class="mt-0.5 truncate text-sm text-dim">{hint()}</div>}
                    </Show>
                  </span>
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
