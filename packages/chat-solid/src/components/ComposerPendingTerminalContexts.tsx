/**
 * Horizontal strip of staged terminal-context references rendered
 * just above the composer textarea. Each draft becomes a single
 * `TerminalContextInlineChip`; expired drafts surface with the
 * destructive variant and a "remove and re-add" tooltip.
 *
 * Pure render — sourcing and persistence stay with the host (the
 * dashboard owns the draft store; the daemon owns the wire).
 */

import { For, Show, type Accessor, type JSX } from "solid-js";
import {
  formatTerminalContextLabel,
  isTerminalContextExpired,
  type TerminalContextDraft,
} from "../lib/terminalContext";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";

export interface ComposerPendingTerminalContextsProps {
  contexts: Accessor<ReadonlyArray<TerminalContextDraft>>;
  onRemove?: (id: string) => void;
  /** Optional class on the outer wrapper for layout polish. */
  class?: string;
}

export function ComposerPendingTerminalContexts(
  props: ComposerPendingTerminalContextsProps,
): JSX.Element {
  return (
    <Show when={props.contexts().length > 0}>
      <div
        data-testid="composer-pending-terminal-contexts"
        class={`flex flex-wrap gap-1.5 ${props.class ?? ""}`}
      >
        <For each={props.contexts()}>
          {(context) => {
            const label = formatTerminalContextLabel(context);
            const expired = isTerminalContextExpired(context);
            const tooltip = expired
              ? `Terminal context expired. Remove and re-add ${label} to include it in your message.`
              : context.text;
            return (
              <TerminalContextInlineChip
                label={label}
                tooltipText={tooltip}
                expired={expired}
                onRemove={props.onRemove ? () => props.onRemove!(context.id) : undefined}
              />
            );
          }}
        </For>
      </div>
    </Show>
  );
}
