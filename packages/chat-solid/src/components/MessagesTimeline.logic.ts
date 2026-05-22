/**
 * Pure helpers for the flat-transcript MessagesTimeline. No Solid, no
 * DOM — everything testable as plain functions.
 *
 * Split out from MessagesTimeline.tsx so the rendering path stays
 * narrow (mostly JSX) and the data-shape rules (terminal-message
 * detection, copy-state, follow-signal, tool-call grouping) can be
 * exercised headlessly.
 */

import type { ChatMessage, MessagesTimelineRow, ToolCallView, WorkLogEntry } from "../types";

export const TIMESTAMP_FMT: Intl.DateTimeFormatOptions = {
  hour: "numeric",
  minute: "2-digit",
};

export function formatTimestamp(iso: string | undefined | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, TIMESTAMP_FMT);
}

/**
 * Stable signature for a timeline row. Cheap to recompute, used as
 * the autoscroll follow-signal (a change here means content shifted
 * enough that we should track the tail).
 */
export function rowSignature(row: MessagesTimelineRow): string {
  if (row.kind === "working") return `${row.id}:working`;
  if (row.kind === "plan") {
    return `${row.id}:plan:${row.entries
      .map((entry) => `${entry.content}:${entry.status}`)
      .join(",")}`;
  }
  if (row.kind === "work") {
    return `${row.id}:work:${row.entries
      .map((entry) => `${entry.id}:${entry.status ?? "completed"}:${entry.label.length}`)
      .join(",")}`;
  }
  const message = row.message;
  if (message.role === "user") {
    return `${row.id}:user:${message.content.length}:${row.revertTurnCount ?? 0}`;
  }
  return `${row.id}:assistant:${row.showCompletionDivider ? "div:" : ""}${message.text.length}:${message.thoughtText?.length ?? 0}:${message.toolCalls
    .map((toolCall) => `${toolCall.toolCallId}:${toolCall.status}:${toolCall.content.length}`)
    .join(",")}:${message.streaming}`;
}

/**
 * Of all assistant messages in the timeline, which ids are the
 * trailing reply per "turn"? The copy button only shows on terminal
 * assistant messages so a multi-chunk turn doesn't get N copy
 * buttons — only one, on the last chunk.
 *
 * A turn is keyed by `turnId` when present (post-T074 wire); we fall
 * back to a per-user-prompt cursor for legacy threads that arrived
 * before turn tracking.
 */
export function deriveTerminalAssistantMessageIds(
  rows: ReadonlyArray<MessagesTimelineRow>,
): ReadonlySet<string> {
  const lastByResponseKey = new Map<string, string>();
  let nullTurnResponseIndex = 0;

  for (const row of rows) {
    if (row.kind !== "message") continue;
    const message = row.message;
    if (message.role === "user") {
      nullTurnResponseIndex += 1;
      continue;
    }
    const turnId = (message as { turnId?: string | null }).turnId ?? null;
    const responseKey = turnId ? `turn:${turnId}` : `unkeyed:${nullTurnResponseIndex}`;
    lastByResponseKey.set(responseKey, message.id);
  }

  return new Set(lastByResponseKey.values());
}

export interface AssistantCopyState {
  text: string | null;
  visible: boolean;
}

/**
 * Decide whether to show the copy button next to an assistant
 * message + the text to copy. We hide while the message is still
 * streaming so the user doesn't grab a partial.
 */
export function resolveAssistantCopyState(input: {
  text: string | null | undefined;
  showCopyButton: boolean;
  streaming: boolean;
}): AssistantCopyState {
  const trimmed = input.text != null ? input.text : "";
  const hasText = trimmed.trim().length > 0;
  return {
    text: hasText ? trimmed : null,
    visible: input.showCopyButton && hasText && !input.streaming,
  };
}

/**
 * Visual role tone for a chat message. Drives the row's left-border
 * accent + the role-header chip background. Tone is the *single*
 * design-token-mapped tag the renderer reads — the flat transcript
 * stays visually quiet because every row uses the same horizontal
 * grid (no bubbles), only the tone strip changes.
 */
export type MessageTone = "user" | "assistant" | "system" | "tool";

export function deriveMessageTone(message: ChatMessage): MessageTone {
  if (message.role === "user") return "user";
  return "assistant";
}

/**
 * Group adjacent same-tool tool calls so the chip header reads
 * "Tool calls (N)" instead of N separate chips. Pure — only depends
 * on the tool-call array.
 */
export interface ToolCallsSummary {
  count: number;
  hasFailure: boolean;
  hasInProgress: boolean;
}

export function summarizeToolCalls(toolCalls: ReadonlyArray<ToolCallView>): ToolCallsSummary {
  let hasFailure = false;
  let hasInProgress = false;
  for (const call of toolCalls) {
    if (call.status === "failed") hasFailure = true;
    if (call.status === "pending" || call.status === "in_progress") {
      hasInProgress = true;
    }
  }
  return { count: toolCalls.length, hasFailure, hasInProgress };
}

/** Filter helper for tests — keeps only message rows. */
export function messageRows(
  rows: ReadonlyArray<MessagesTimelineRow>,
): Extract<MessagesTimelineRow, { kind: "message" }>[] {
  return rows.filter(
    (row): row is Extract<MessagesTimelineRow, { kind: "message" }> => row.kind === "message",
  );
}

/**
 * Optional pre-grouped row produced by the host. When supplied to
 * `deriveMessagesTimelineRows`, the helper trusts the row's
 * pre-computed identity; adjacent work-entries inside the same
 * group never split across rows.
 *
 * The shape intentionally mirrors `MessagesTimelineRow` so the host
 * can pass either a flat stream of work entries (the helper will
 * collapse adjacent ones) OR pre-grouped rows directly.
 */
export type TimelineSourceEntry =
  | { kind: "message"; id: string; createdAt: string; message: ChatMessage }
  | { kind: "plan"; id: string; createdAt: string; entries: import("../types").PlanEntry[] }
  | {
      kind: "work";
      id: string;
      createdAt: string;
      entry?: WorkLogEntry;
      entries?: ReadonlyArray<WorkLogEntry>;
    };

export interface DeriveMessagesTimelineRowsInput {
  entries: ReadonlyArray<TimelineSourceEntry>;
  /**
   * When set, the `message` row matching this id will render the
   * "Completed turn" divider above it. Typically the host targets
   * the FIRST assistant message of a turn so the divider falls
   * between the turn's tool work and the prose conclusion.
   */
  completionDividerBeforeEntryId?: string | null;
  /**
   * Map of `userMessageId → revertTurnCount`. When the map has an
   * entry for a user message, the renderer surfaces a
   * "Revert N turn(s) from here" button so the user can rewind.
   */
  revertTurnCountByUserMessageId?: ReadonlyMap<string, number>;
  /** When true, append a `working` row at the end of the list. */
  isWorking?: boolean;
  /** ISO timestamp for the working row (renderer reads `createdAt`). */
  activeTurnStartedAt?: string | null;
}

/**
 * Pure host-facing helper that produces the row list rendered by
 * `MessagesTimeline`. Behavior:
 *
 *   - `message` entries pass through, tagged with optional
 *     `showCompletionDivider` + `revertTurnCount`.
 *   - `plan` entries pass through unchanged.
 *   - Adjacent `work` entries collapse into a single `work` row
 *     whose `entries` array concatenates them; the row's `id` is
 *     stable across re-derivations (the first source entry's id).
 *   - When `isWorking` is true, a trailing `working` row is
 *     appended with `createdAt = activeTurnStartedAt ?? ""`.
 *
 * Pure — no Solid, no DOM, no signals. Stable enough to drive an
 * autoscroll signal via `rowSignature`.
 */
export function deriveMessagesTimelineRows(
  input: DeriveMessagesTimelineRowsInput,
): MessagesTimelineRow[] {
  const out: MessagesTimelineRow[] = [];
  const completionTarget = input.completionDividerBeforeEntryId ?? null;
  const revertMap = input.revertTurnCountByUserMessageId;

  for (let index = 0; index < input.entries.length; index += 1) {
    const entry = input.entries[index];
    if (!entry) continue;

    if (entry.kind === "work") {
      const grouped: WorkLogEntry[] = [];
      if (entry.entries) grouped.push(...entry.entries);
      if (entry.entry) grouped.push(entry.entry);
      let cursor = index + 1;
      while (cursor < input.entries.length) {
        const next = input.entries[cursor];
        if (!next || next.kind !== "work") break;
        if (next.entries) grouped.push(...next.entries);
        if (next.entry) grouped.push(next.entry);
        cursor += 1;
      }
      out.push({
        kind: "work",
        id: entry.id,
        createdAt: entry.createdAt,
        entries: grouped,
      });
      index = cursor - 1;
      continue;
    }

    if (entry.kind === "plan") {
      out.push({
        kind: "plan",
        id: entry.id,
        createdAt: entry.createdAt,
        entries: entry.entries,
      });
      continue;
    }

    const message = entry.message;
    const isUser = message.role === "user";
    const isAssistant = message.role === "assistant";
    const showCompletionDivider = isAssistant && completionTarget === entry.id;
    const revertTurnCount = isUser ? revertMap?.get(message.id) : undefined;
    // Find the most recent user message before this row so the
    // divider can show "Completed in Xs" relative to that turn's
    // start. Walk back through the source list — cheap since the
    // chain is bounded by the size of one turn.
    let completionTurnStartedAt: string | undefined;
    if (showCompletionDivider) {
      for (let back = index - 1; back >= 0; back -= 1) {
        const prev = input.entries[back];
        if (prev?.kind !== "message") continue;
        if (prev.message.role === "user") {
          completionTurnStartedAt = prev.message.createdAt;
          break;
        }
      }
    }

    out.push({
      kind: "message",
      id: entry.id,
      createdAt: entry.createdAt,
      message,
      ...(showCompletionDivider ? { showCompletionDivider: true } : {}),
      ...(completionTurnStartedAt ? { completionTurnStartedAt } : {}),
      ...(typeof revertTurnCount === "number" && revertTurnCount > 0 ? { revertTurnCount } : {}),
    });
  }

  if (input.isWorking) {
    out.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt ?? "",
    });
  }

  return out;
}

/**
 * Maximum number of grouped entries to render expanded by default
 * inside a `work` row. Past this, the renderer collapses the tail
 * behind a "+N more" cap. Matches the host-side default — overridable
 * via prop if a host wants a denser view.
 */
export const MAX_VISIBLE_WORK_ENTRIES = 6;

/**
 * Identify the entry id that should carry the "this turn is
 * complete" divider when the host doesn't supply one explicitly.
 *
 * The rule: a turn is a span starting at a user message and ending
 * at the LAST non-streaming assistant message before the next user
 * message (or the end of the list). The divider sits on that final
 * assistant message so it visually separates a finished turn from
 * whatever is currently pending below it.
 *
 * Returns `null` when no turn is closed (e.g. the assistant is
 * still streaming the only response, or the thread is empty).
 *
 * Stable + pure — call from the host's row derivation so the
 * divider sticks on the last completed turn even as the user keeps
 * scrolling and the streaming row moves around below it.
 */
export function findActiveCompletionDividerEntryId(
  entries: ReadonlyArray<TimelineSourceEntry>,
): string | null {
  let last: string | null = null;
  for (const entry of entries) {
    if (entry.kind !== "message") continue;
    const message = entry.message;
    if (message.role !== "assistant") continue;
    if (message.streaming) continue;
    last = entry.id;
  }
  return last;
}

/**
 * Format the elapsed duration between a user message and its
 * closing assistant message, surfaced inside the completion
 * divider chrome ("Completed in 3.2s" / "Completed in 12m").
 *
 * Both inputs are ISO timestamps. Negative or NaN spans return
 * `null` so the renderer falls back to the bare "Completed turn"
 * label.
 */
export function formatTurnDuration(startIso: string, endIso: string): string | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const ms = end - start;
  if (ms < 0) return null;
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/**
 * Map of user-message id → "this turn would revert N turns" count.
 * Counts every completed assistant turn AFTER each user message,
 * so the rightmost user message gets 0 (no reverts available),
 * and the topmost gets N (every turn below it).
 *
 * Pure helper for hosts that want the "Revert N turns" button on
 * every user message without tracking the counts themselves.
 */
export function deriveRevertTurnCounts(
  entries: ReadonlyArray<TimelineSourceEntry>,
): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  const userIdsInOrder: string[] = [];
  for (const entry of entries) {
    if (entry.kind !== "message") continue;
    const message = entry.message;
    if (message.role === "user") {
      userIdsInOrder.push(message.id);
    }
    if (message.role === "assistant" && !message.streaming) {
      // Roll up: every prior user message gains one revertable turn,
      // EXCEPT the most recent user message (its own turn is the one
      // we're crediting — reverting from it would be a self-loop).
      for (let i = 0; i < userIdsInOrder.length - 1; i += 1) {
        const userId = userIdsInOrder[i]!;
        out.set(userId, (out.get(userId) ?? 0) + 1);
      }
    }
  }
  // We never enter zero entries in the first place — callers can
  // assume every key has count >= 1.
  return out;
}

/**
 * Visible / overflow split for a `work` row's entries. The
 * `overflowCount` is what the renderer puts behind the "+N more"
 * affordance.
 */
export function splitWorkEntries(
  entries: ReadonlyArray<WorkLogEntry>,
  max: number = MAX_VISIBLE_WORK_ENTRIES,
): { visible: ReadonlyArray<WorkLogEntry>; overflowCount: number } {
  if (entries.length <= max) {
    return { visible: entries, overflowCount: 0 };
  }
  return {
    visible: entries.slice(0, max),
    overflowCount: entries.length - max,
  };
}
