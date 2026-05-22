import { Show, type JSX } from "solid-js";
import { formatTimestamp, type MessageTone } from "./MessagesTimeline.logic";

/**
 * Compact role strip rendered above every transcript row. Replaces
 * the bubble chrome of the previous design with a single-line header:
 *
 *   ▸ You       9:42
 *   ● Claude    9:42  end_turn
 *
 * The role-icon dot is colored by tone (design-token only) so the
 * eye can scan role boundaries without bubbles. Right-aligned slot
 * accepts an inline action cluster (copy button, revert, etc).
 */

interface MessageRoleHeaderProps {
  tone: MessageTone;
  /** Display name. e.g. "You" / provider name / "System". */
  name: string;
  /** ISO timestamp. Optional — falsy hides the time. */
  timestamp?: string | null | undefined;
  /** Optional stop-reason / status pill rendered between name and time. */
  badge?: string | null | undefined;
  /** Right-aligned action cluster (copy, revert). */
  actions?: JSX.Element;
}

const ROLE_GLYPH: Record<MessageTone, string> = {
  user: "▸",
  assistant: "●",
  system: "◆",
  tool: "⚒",
};

const ROLE_COLOR: Record<MessageTone, string> = {
  user: "var(--accent)",
  assistant: "var(--green, var(--accent))",
  system: "var(--fg-muted, var(--fg-secondary))",
  tool: "var(--yellow, var(--accent))",
};

export function MessageRoleHeader(props: MessageRoleHeaderProps) {
  return (
    <header
      data-testid="message-role-header"
      data-tone={props.tone}
      class="mb-1.5 flex items-center gap-2 text-sm text-[var(--fg-muted,var(--fg-secondary))]"
    >
      <span
        aria-hidden="true"
        data-testid="message-role-glyph"
        style={{ color: ROLE_COLOR[props.tone] }}
        class="inline-flex h-4 w-4 shrink-0 items-center justify-center text-base leading-none"
      >
        {ROLE_GLYPH[props.tone]}
      </span>
      <span data-testid="message-role-name" class="font-medium text-[var(--fg)]">
        {props.name}
      </span>
      <Show when={props.badge}>
        {(badge) => (
          <span
            data-testid="message-role-badge"
            class="inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--bg-strong,var(--bg-weak))] px-2 py-0.5 text-xs uppercase tracking-[0.08em] text-[var(--fg-muted,var(--fg-secondary))]"
          >
            {badge().replaceAll("_", " ")}
          </span>
        )}
      </Show>
      <Show when={props.timestamp}>
        {(ts) => (
          <span
            data-testid="message-role-timestamp"
            class="text-xs tabular-nums text-[var(--fg-muted,var(--fg-secondary))]"
          >
            {formatTimestamp(ts())}
          </span>
        )}
      </Show>
      <Show when={props.actions}>
        <span class="flex-1" />
        <span data-testid="message-role-actions" class="flex items-center gap-1">
          {props.actions}
        </span>
      </Show>
    </header>
  );
}
