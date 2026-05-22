/**
 * Floating search overlay for a PtyPane (G20-P3).
 *
 * Anchored top-right of the pane. Composed against the hook in
 * `lib/pty/useTerminalSearch.ts` — owns no state of its own beyond
 * the input ref. Keyboard contract:
 *   Enter        → step next
 *   Shift+Enter  → step prev
 *   Escape       → close + return focus to terminal
 */

import { onMount, Show } from "solid-js";
import { ChevronDown, ChevronUp, X } from "lucide-solid";
import type { TerminalSearchHandle } from "@/lib/pty/useTerminalSearch";

interface TerminalSearchOverlayProps {
  handle: TerminalSearchHandle;
}

export function TerminalSearchOverlay(props: TerminalSearchOverlayProps) {
  let inputEl: HTMLInputElement | undefined;

  onMount(() => {
    // rAF-focus so the input lands on top of the focused terminal
    // without a flicker.
    requestAnimationFrame(() => {
      try {
        inputEl?.focus();
        inputEl?.select();
      } catch {
        // ignore — input may have unmounted
      }
    });
  });

  return (
    <Show when={props.handle.open()}>
      <div
        data-testid="terminal-search-overlay"
        class="absolute right-2 top-2 z-20 flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-strong)] px-2 py-1 text-sm shadow-md"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            props.handle.hide();
          }
        }}
      >
        <input
          ref={inputEl}
          data-testid="terminal-search-input"
          type="search"
          placeholder="Find in terminal…"
          value={props.handle.query()}
          onInput={(e) => props.handle.setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              props.handle.step(e.shiftKey ? "prev" : "next");
            }
          }}
          class="h-5 w-44 rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 text-[var(--fg)] focus:outline-none"
        />
        <span
          data-testid="terminal-search-counter"
          class="min-w-12 text-center text-xs tabular-nums text-[var(--dim)]"
        >
          <Show
            when={props.handle.query() && props.handle.matches().length > 0}
            fallback={
              <Show when={props.handle.query()} fallback={<span aria-hidden="true">·</span>}>
                no results
              </Show>
            }
          >
            {props.handle.activeOrdinal()}/{props.handle.matches().length}
          </Show>
        </span>
        <button
          type="button"
          data-testid="terminal-search-prev"
          onClick={() => props.handle.step("prev")}
          aria-label="Previous match"
          disabled={props.handle.matches().length === 0}
          class="inline-flex h-5 w-5 items-center justify-center rounded text-[var(--dim)] hover:bg-[var(--surface-hover,rgba(127,127,127,0.06))] hover:text-[var(--fg)] disabled:opacity-40"
        >
          <ChevronUp size={11} aria-hidden="true" />
        </button>
        <button
          type="button"
          data-testid="terminal-search-next"
          onClick={() => props.handle.step("next")}
          aria-label="Next match"
          disabled={props.handle.matches().length === 0}
          class="inline-flex h-5 w-5 items-center justify-center rounded text-[var(--dim)] hover:bg-[var(--surface-hover,rgba(127,127,127,0.06))] hover:text-[var(--fg)] disabled:opacity-40"
        >
          <ChevronDown size={11} aria-hidden="true" />
        </button>
        <button
          type="button"
          data-testid="terminal-search-close"
          onClick={() => props.handle.hide()}
          aria-label="Close search"
          class="inline-flex h-5 w-5 items-center justify-center rounded text-[var(--dim)] hover:bg-[var(--surface-hover,rgba(127,127,127,0.06))] hover:text-[var(--fg)]"
        >
          <X size={11} aria-hidden="true" />
        </button>
      </div>
    </Show>
  );
}
