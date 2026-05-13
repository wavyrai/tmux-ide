/**
 * Small inline chip rendered inside the composer textarea row when
 * terminal output is attached as context for the next turn. Shows the
 * pane label, optional line-count, optional × remove affordance, and
 * an "expired" state when the attached snapshot is older than the
 * composer's freshness threshold.
 *
 * Pure render — wiring (capture, freshness, removal) is host territory.
 */

import { Show } from "solid-js";

interface TerminalContextInlineChipProps {
  /** "Lead :1.0" / "Tests :1.2" — short pane label. */
  label: string;
  /** Optional tooltip text shown via the native `title` attr. */
  tooltipText?: string;
  /** Optional line count rendered after the label, e.g. "(42 lines)". */
  lineCount?: number;
  /** When true, paints destructive accents to surface "snapshot stale". */
  expired?: boolean;
  /** When provided, renders a × button next to the label. */
  onRemove?: () => void;
}

export function TerminalContextInlineChip(props: TerminalContextInlineChipProps) {
  const baseClass =
    "inline-flex h-5 items-center gap-1 rounded-md border px-1.5 text-[11px] leading-none font-mono";
  const variantClass = () =>
    props.expired
      ? "border-destructive/40 bg-destructive/10 text-destructive-foreground"
      : "border-border bg-[var(--surface)] text-foreground";

  return (
    <span
      data-testid="terminal-context-inline-chip"
      data-terminal-context-expired={props.expired ? "true" : undefined}
      title={props.tooltipText}
      class={`${baseClass} ${variantClass()}`}
    >
      <span aria-hidden="true" class="opacity-70">{">_"}</span>
      <span class="max-w-32 truncate" data-testid="terminal-context-chip-label">
        {props.label}
      </span>
      <Show when={typeof props.lineCount === "number"}>
        <span class="opacity-60" data-testid="terminal-context-chip-lines">
          ({props.lineCount} lines)
        </span>
      </Show>
      <Show when={props.onRemove}>
        <button
          type="button"
          data-testid="terminal-context-chip-remove"
          aria-label="Remove terminal context"
          class="ml-0.5 cursor-pointer rounded-sm px-0.5 opacity-60 hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            props.onRemove?.();
          }}
        >
          ×
        </button>
      </Show>
    </span>
  );
}
