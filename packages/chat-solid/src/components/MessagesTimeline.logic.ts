/**
 * Pure helpers for the flat-transcript MessagesTimeline. No Solid, no
 * DOM — everything testable as plain functions.
 *
 * Split out from MessagesTimeline.tsx so the rendering path stays
 * narrow (mostly JSX) and the data-shape rules (terminal-message
 * detection, copy-state, follow-signal, tool-call grouping) can be
 * exercised headlessly.
 */

import type { ChatMessage, MessagesTimelineRow, ToolCallView } from "../types";

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
  const message = row.message;
  if (message.role === "user") {
    return `${row.id}:user:${message.content.length}`;
  }
  return `${row.id}:assistant:${message.text.length}:${message.thoughtText?.length ?? 0}:${message.toolCalls
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
