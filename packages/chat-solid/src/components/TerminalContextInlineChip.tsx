/**
 * Inline chip for a single terminal-context reference. Used both in
 * the composer's pending-context list and inline inside rendered
 * user messages — the same visual treatment lets the user spot a
 * context regardless of where it surfaces.
 *
 * Expired contexts (no remaining body text) render with the
 * destructive style and a "Remove and re-add" tooltip so the user
 * understands the chip survived but the content didn't.
 *
 * Pure render — no state, no signals. The optional `onRemove`
 * callback adds a small × affordance the host can wire when this
 * chip lives in the composer (the in-message variant omits it).
 */

import type { JSX } from "solid-js";
import { Show } from "solid-js";

export interface TerminalContextInlineChipProps {
  label: string;
  tooltipText: string;
  expired?: boolean;
  onRemove?: () => void;
}

const TERMINAL_ICON_PATH =
  "M2.5 3.5h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Zm1.7 2.4l2.1 2.1-2.1 2.1m3.2.7h3.5";

export function TerminalContextInlineChip(props: TerminalContextInlineChipProps): JSX.Element {
  const variantClass = (): string =>
    props.expired
      ? "border-red/40 bg-red/10 text-red"
      : "border-border-weak bg-surface/60 text-fg-secondary";

  return (
    <span
      data-testid="terminal-context-inline-chip"
      data-expired={props.expired ? "true" : "false"}
      title={props.tooltipText}
      class={
        "inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-sm leading-snug " +
        variantClass()
      }
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d={TERMINAL_ICON_PATH} />
      </svg>
      <span class="min-w-0 truncate font-mono">{props.label}</span>
      <Show when={props.onRemove}>
        {(onRemove) => (
          <button
            type="button"
            data-testid="terminal-context-inline-chip-remove"
            class="ml-0.5 inline-flex shrink-0 cursor-pointer items-center justify-center rounded-sm px-0.5 text-xs opacity-60 hover:opacity-100"
            aria-label="Remove terminal context"
            onClick={(event) => {
              event.stopPropagation();
              onRemove()();
            }}
          >
            ×
          </button>
        )}
      </Show>
    </span>
  );
}
