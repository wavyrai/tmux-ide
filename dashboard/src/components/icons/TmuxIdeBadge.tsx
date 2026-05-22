/**
 * tmux-ide identity mark — surfaced on the terminal row that hosts
 * the tmux-ide session itself, so the user can tell "this is the
 * pane running the multiplexer" apart from ordinary terminals.
 *
 * Rendered inline in `TerminalSurface`'s vertical rail in place of
 * the generic running-bullet. Sized to match a single-line label.
 */

import type { JSX } from "solid-js";

interface TmuxIdeBadgeProps {
  /** Optional Tailwind size override; defaults to a 12px square. */
  class?: string;
  /** Hover tooltip. */
  title?: string;
}

export function TmuxIdeBadge(props: TmuxIdeBadgeProps): JSX.Element {
  return (
    <span
      data-testid="tmux-ide-self-badge"
      aria-hidden="true"
      title={props.title ?? "tmux-ide host session"}
      class={
        "mr-1 inline-flex h-3 w-3 items-center justify-center rounded-sm bg-[var(--accent)] text-[var(--bg-strong)] " +
        (props.class ?? "")
      }
    >
      <svg
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="h-2.5 w-2.5"
      >
        {/* Stylized "T·I" mark — two vertical strokes (the tmux split)
            inside a rounded box footprint. */}
        <path d="M2.5 3 L9.5 3" />
        <path d="M4.25 3 L4.25 9" />
        <path d="M7.75 3 L7.75 9" />
      </svg>
    </span>
  );
}
