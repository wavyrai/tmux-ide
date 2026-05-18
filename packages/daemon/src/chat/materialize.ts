/**
 * Server-side thread materializer.
 *
 * The canonical reduction of ACP `SessionUpdate` chunks into the
 * rendered transcript now happens HERE, on the daemon, as updates
 * arrive — not on the client. A streaming assistant turn append-grows
 * one message object's `.text` in place; tool calls / thoughts fold
 * into that message's structured fields; a per-message `streaming`
 * flag is keyed to the active prompt. The dashboard / chat-solid
 * render the resulting `TimelineRow[]` directly with zero reduction.
 *
 * This is a faithful port of chat-solid's old `coalesce.ts` +
 * `rowReducer.ts` (now deleted) — the grouping rules (turn boundaries,
 * thought vs text, tool-call merge, plan replace, working-row, revert
 * counts) are identical, just relocated server-side so the recurring
 * "client reduction perturbs reactive state" bug class is gone.
 *
 * The raw event log (`ThreadState.messages`) is untouched — it stays
 * the durable persistence + back-compat surface. This module is a
 * derived projection over it.
 */

import type {
  TimelineRow,
  TimelineMessage,
  TimelineToolCall,
  TimelinePlanEntry,
} from "@tmux-ide/contracts";
import type { ContentBlock, SessionUpdate, StopReason, ThreadMessage } from "./types.ts";

type MessageRow = Extract<TimelineRow, { kind: "message" }>;
type AssistantMessage = Extract<TimelineMessage, { role: "assistant" }>;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function mergeToolCallUpdate(
  toolCalls: TimelineToolCall[],
  update: {
    toolCallId: string;
    title?: string;
    kind?: string;
    status?: TimelineToolCall["status"];
    content?: unknown[];
    rawInput?: unknown;
    rawOutput?: unknown;
  },
): void {
  let toolCall = toolCalls.find((candidate) => candidate.toolCallId === update.toolCallId);
  if (!toolCall) {
    toolCall = {
      toolCallId: update.toolCallId,
      title: update.title ?? update.toolCallId,
      ...(update.kind ? { kind: update.kind } : {}),
      status: update.status ?? "pending",
      content: [],
    };
    toolCalls.push(toolCall);
  }

  if (update.title) toolCall.title = update.title;
  if (update.kind) toolCall.kind = update.kind;
  if (update.status) toolCall.status = update.status;
  if (update.content?.length) toolCall.content = [...toolCall.content, ...update.content];
  if (update.rawInput !== undefined) toolCall.rawInput = update.rawInput;
  if (update.rawOutput !== undefined) toolCall.rawOutput = update.rawOutput;
}

function assistantHasVisibleContent(message: AssistantMessage): boolean {
  return (
    message.text.length > 0 ||
    Boolean(message.thoughtText && message.thoughtText.length > 0) ||
    message.toolCalls.length > 0
  );
}

/**
 * Stamp `revertTurnCount` onto every user-message row in place. A user
 * message is rewindable when at least one more user turn follows it;
 * the count is how many later user turns `editFromTurn` would discard.
 */
function assignRevertTurnCounts(rows: TimelineRow[]): void {
  let trailingUserTurns = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (!row || row.kind !== "message" || row.message.role !== "user") continue;
    if (trailingUserTurns > 0) row.revertTurnCount = trailingUserTurns;
    trailingUserTurns += 1;
  }
}

interface Cursor {
  turnIndex: number;
  currentAssistantRowId: string | null;
  currentPlanRowId: string | null;
  latestUserRowId: string | null;
  activePromptId: string | null;
}

function freshCursor(): Cursor {
  return {
    turnIndex: -1,
    currentAssistantRowId: null,
    currentPlanRowId: null,
    latestUserRowId: null,
    activePromptId: null,
  };
}

/** A delta to broadcast: changed/added rows + the authoritative order. */
export interface TimelineDelta {
  rows: TimelineRow[];
  order: string[];
}

export class ThreadTimeline {
  private rows: TimelineRow[] = [];
  private cursor: Cursor = freshCursor();
  private dirty = new Set<string>();

  /**
   * Rebuild from the raw event log. Settled by default; pass
   * `activePromptId` to re-open the latest turn as the live streaming
   * one (used after a user prompt / truncation so the next agent
   * chunk streams into a fresh assistant row).
   */
  bootstrap(messages: ReadonlyArray<ThreadMessage>, activePromptId?: string): void {
    this.rows = [];
    this.cursor = freshCursor();
    for (const message of messages) {
      if (message._tag === "UserPrompt") {
        this.applyUserPrompt({
          id: message.id,
          content: message.content,
          createdAt: message.createdAt,
        });
      } else {
        this.applyAgentUpdate(message.id, message.createdAt, message.update);
      }
    }
    this.cursor.activePromptId = activePromptId ?? null;
    this.dirty.clear();
  }

  snapshot(): TimelineRow[] {
    return clone(this.rows);
  }

  get activePromptId(): string | null {
    return this.cursor.activePromptId;
  }

  private rowById(id: string | null): MessageRow | null {
    if (!id) return null;
    for (const row of this.rows) {
      if (row.kind === "message" && row.id === id) return row;
    }
    return null;
  }

  private workingId(assistantId: string): string {
    return `${assistantId}:working`;
  }

  private removeWorkingRow(assistantId: string): void {
    const id = this.workingId(assistantId);
    const index = this.rows.findIndex((row) => row.kind === "working" && row.id === id);
    if (index !== -1) {
      this.rows.splice(index, 1);
      this.dirty.add(id);
    }
  }

  private syncStreaming(): void {
    if (!this.cursor.activePromptId) return;
    const row = this.rowById(this.cursor.currentAssistantRowId);
    if (!row || row.message.role !== "assistant") return;
    const assistant = row.message;
    assistant.streaming = true;
    this.dirty.add(row.id);
    if (assistantHasVisibleContent(assistant)) {
      this.removeWorkingRow(assistant.id);
      return;
    }
    const id = this.workingId(assistant.id);
    if (!this.rows.some((candidate) => candidate.kind === "working" && candidate.id === id)) {
      this.rows.push({ kind: "working", id, createdAt: assistant.createdAt });
      this.dirty.add(id);
    }
  }

  private ensureAssistantRow(sourceId: string, createdAt: string): AssistantMessage {
    const existing = this.rowById(this.cursor.currentAssistantRowId);
    if (existing && existing.message.role === "assistant") return existing.message;

    const id = `assistant:${this.cursor.turnIndex < 0 ? "orphan" : this.cursor.turnIndex}:${sourceId}`;
    const message: AssistantMessage = {
      id,
      role: "assistant",
      createdAt,
      streaming: false,
      text: "",
      toolCalls: [],
    };
    this.rows.push({ kind: "message", id, createdAt, message });
    this.cursor.currentAssistantRowId = id;
    this.dirty.add(id);
    return message;
  }

  /**
   * Open a new turn. `activePromptId` ties the live streaming caret to
   * a specific prompt; omitted (bootstrap replay) leaves the turn
   * settled.
   */
  applyUserPrompt(input: {
    id: string;
    content: ReadonlyArray<ContentBlock>;
    createdAt: string;
    activePromptId?: string;
  }): void {
    this.cursor.turnIndex += 1;
    this.cursor.currentAssistantRowId = null;
    this.cursor.currentPlanRowId = null;
    this.cursor.latestUserRowId = input.id;
    this.cursor.activePromptId = input.activePromptId ?? null;
    this.rows.push({
      kind: "message",
      id: input.id,
      createdAt: input.createdAt,
      message: {
        id: input.id,
        role: "user",
        createdAt: input.createdAt,
        content: [...input.content],
      },
    });
    this.dirty.add(input.id);
    assignRevertTurnCounts(this.rows);
  }

  /** Fold one ACP session update into the transcript. */
  applyAgentUpdate(sourceId: string, createdAt: string, update: SessionUpdate): void {
    const assistant = this.ensureAssistantRow(sourceId, createdAt);
    const assistantRowId = this.cursor.currentAssistantRowId;

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const content = (update as { content?: ContentBlock }).content;
        if (content && content.type === "text") assistant.text += content.text;
        if (assistantRowId) this.dirty.add(assistantRowId);
        break;
      }
      case "agent_thought_chunk": {
        const content = (update as { content?: ContentBlock }).content;
        if (content && content.type === "text") {
          assistant.thoughtText = `${assistant.thoughtText ?? ""}${content.text}`;
        }
        if (assistantRowId) this.dirty.add(assistantRowId);
        break;
      }
      case "user_message_chunk": {
        const content = (update as { content?: ContentBlock }).content;
        const userRow = this.rowById(this.cursor.latestUserRowId);
        if (content && userRow && userRow.message.role === "user") {
          userRow.message.content = [...userRow.message.content, content];
          this.dirty.add(userRow.id);
        }
        break;
      }
      case "tool_call": {
        const u = update as {
          toolCallId: string;
          title: string;
          kind?: string;
          status?: TimelineToolCall["status"];
          content?: unknown[];
          rawInput?: unknown;
          rawOutput?: unknown;
        };
        assistant.toolCalls.push({
          toolCallId: u.toolCallId,
          title: u.title,
          ...(u.kind ? { kind: u.kind } : {}),
          status: u.status ?? "pending",
          content: [...(u.content ?? [])],
          ...(u.rawInput !== undefined ? { rawInput: u.rawInput } : {}),
          ...(u.rawOutput !== undefined ? { rawOutput: u.rawOutput } : {}),
        });
        if (assistantRowId) this.dirty.add(assistantRowId);
        break;
      }
      case "tool_call_update": {
        const u = update as {
          toolCallId: string;
          title?: string | null;
          kind?: string | null;
          status?: TimelineToolCall["status"] | null;
          content?: unknown[] | null;
          rawInput?: unknown;
          rawOutput?: unknown;
        };
        mergeToolCallUpdate(assistant.toolCalls, {
          toolCallId: u.toolCallId,
          title: u.title ?? undefined,
          kind: u.kind ?? undefined,
          status: u.status ?? undefined,
          content: u.content ?? undefined,
          rawInput: u.rawInput,
          rawOutput: u.rawOutput,
        });
        if (assistantRowId) this.dirty.add(assistantRowId);
        break;
      }
      case "plan": {
        const rawEntries =
          (update as unknown as { entries?: ReadonlyArray<TimelinePlanEntry> }).entries ?? [];
        const entries = rawEntries.map((entry) => ({
          content: entry.content,
          ...(entry.status ? { status: entry.status } : {}),
          ...(entry.priority ? { priority: entry.priority } : {}),
        }));
        const planId = this.cursor.currentPlanRowId ?? `plan:${sourceId}`;
        const planRow: Extract<TimelineRow, { kind: "plan" }> = {
          kind: "plan",
          id: planId,
          createdAt,
          entries,
        };
        if (this.cursor.currentPlanRowId) {
          const index = this.rows.findIndex((row) => row.id === this.cursor.currentPlanRowId);
          if (index !== -1) this.rows[index] = planRow;
        } else {
          this.cursor.currentPlanRowId = planId;
          this.rows.push(planRow);
        }
        this.dirty.add(planId);
        break;
      }
      case "available_commands_update":
      case "current_mode_update":
        break;
      default:
        break;
    }

    this.syncStreaming();
  }

  /**
   * Close the active turn's streaming row. Idempotent: a second call
   * (real stop after an optimistic cancel) is a no-op once the active
   * prompt is cleared.
   */
  finish(promptId: string | null, stopReason: StopReason, completedAt: string): void {
    if (this.cursor.activePromptId && promptId && this.cursor.activePromptId !== promptId) return;
    const row = this.rowById(this.cursor.currentAssistantRowId);
    if (row && row.message.role === "assistant") {
      const assistant = row.message;
      assistant.streaming = false;
      assistant.stopReason = stopReason;
      assistant.completedAt = completedAt;
      this.dirty.add(row.id);
      this.removeWorkingRow(assistant.id);
    }
    this.cursor.activePromptId = null;
  }

  /** Drain the pending delta (changed rows + authoritative order). */
  drainDelta(): TimelineDelta {
    const order = this.rows.map((row) => row.id);
    const present = new Map(this.rows.map((row) => [row.id, row]));
    const rows: TimelineRow[] = [];
    for (const id of this.dirty) {
      const row = present.get(id);
      if (row) rows.push(clone(row));
    }
    this.dirty.clear();
    return { rows, order };
  }
}

/** Pure full rebuild — used by `chat.thread.get` bootstrap. */
export function materializeRows(messages: ReadonlyArray<ThreadMessage>): TimelineRow[] {
  const timeline = new ThreadTimeline();
  timeline.bootstrap(messages);
  return timeline.snapshot();
}
