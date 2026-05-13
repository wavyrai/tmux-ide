/**
 * Solid hook for the terminal-search overlay (G20-P3).
 *
 * Composes the pure engine with the live xterm Terminal:
 *   - `open()` enables the overlay.
 *   - Query change re-collects matches, drives
 *     `terminal.select(col, row, length)` + `terminal.scrollToLine(row
 *     - rows/2)` to center the first hit.
 *   - `step("next" / "prev")` cycles via
 *     `getNextTerminalSearchIndex`.
 *   - `close()` clears the xterm selection and runs `onCloseFocus()`
 *     so focus returns to the terminal.
 */

import { createSignal } from "solid-js";
import type { Terminal as XTerm } from "@xterm/xterm";
import {
  collectTerminalSearchMatches,
  getNextTerminalSearchIndex,
  type TerminalSearchBufferLike,
  type TerminalSearchMatch,
} from "./terminalSearch";

export interface UseTerminalSearchArgs {
  /** Accessor for the live xterm Terminal. Returns null when the
   *  surface hasn't constructed an xterm yet (cold tab). */
  getTerminal: () => XTerm | null;
  /** Called when the overlay closes — caller refocuses the terminal. */
  onCloseFocus?: () => void;
}

export function useTerminalSearch(args: UseTerminalSearchArgs) {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [matches, setMatches] = createSignal<TerminalSearchMatch[]>([]);
  const [activeIndex, setActiveIndex] = createSignal(-1);

  function readBuffer(): TerminalSearchBufferLike | null {
    const term = args.getTerminal();
    if (!term) return null;
    const buffer = term.buffer.active;
    return {
      length: buffer.length,
      getLine: (i) => buffer.getLine(i) ?? undefined,
    };
  }

  function applyMatch(match: TerminalSearchMatch | null): void {
    const term = args.getTerminal();
    if (!term) return;
    if (!match) {
      try {
        term.clearSelection();
      } catch {
        // ignore — disposed terminal
      }
      return;
    }
    try {
      term.select(match.col, match.row, match.length);
      const center = match.row - Math.floor(term.rows / 2);
      term.scrollToLine(Math.max(0, center));
    } catch {
      // ignore — disposed / mid-resize
    }
  }

  function run(direction: "next" | "prev", { reset }: { reset: boolean }): void {
    const buf = readBuffer();
    if (!buf) {
      setMatches([]);
      setActiveIndex(-1);
      return;
    }
    const next = collectTerminalSearchMatches(buf, query());
    setMatches(next);
    if (next.length === 0) {
      setActiveIndex(-1);
      applyMatch(null);
      return;
    }
    const anchor = reset ? null : (activeIndex() >= 0 ? next[activeIndex()] ?? null : null);
    const idx = getNextTerminalSearchIndex(next, anchor, direction);
    setActiveIndex(idx);
    applyMatch(next[idx] ?? null);
  }

  return {
    open,
    query,
    matches,
    activeIndex,
    /** 1-based "N of M" — UI-friendly. Returns 0 when no active match. */
    activeOrdinal: () => (activeIndex() < 0 ? 0 : activeIndex() + 1),
    setQuery: (next: string) => {
      setQuery(next);
      run("next", { reset: true });
    },
    step: (direction: "next" | "prev") => run(direction, { reset: false }),
    show: () => {
      setOpen(true);
      // Re-run against the live buffer when reopening — the buffer
      // may have grown since the last close.
      run("next", { reset: true });
    },
    hide: () => {
      setOpen(false);
      applyMatch(null);
      setMatches([]);
      setActiveIndex(-1);
      args.onCloseFocus?.();
    },
  };
}

export type TerminalSearchHandle = ReturnType<typeof useTerminalSearch>;
