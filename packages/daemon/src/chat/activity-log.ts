/**
 * Activity log — append-only stream of ThreadActivity events partitioned
 * by `threadId` and indexed by a monotonic `sequence` per thread. The
 * sequence is assigned at append time so the dashboard can reconstruct
 * ordering from arbitrary subsets.
 *
 * Each activity carries a `turnId` (or null) so the chat UI can group
 * events under their owning turn. The store provides both flat-by-thread
 * and partition-by-turn views.
 *
 * Schema comes from @tmux-ide/contracts/chat-thread (T070).
 */

import { randomUUID } from "node:crypto";
import type {
  ChatThreadEvent,
  EventId,
  ThreadActivity,
  ThreadActivityTone,
} from "@tmux-ide/contracts";

export interface AppendActivityInput {
  threadId: string;
  tone: ThreadActivityTone;
  kind: string;
  summary: string;
  payload?: unknown;
  turnId?: string | null;
  /** Multi-agent attribution (T078). Tags the activity with the producing Session. */
  sessionId?: string;
  /** Override the auto-generated id (used by tests / replay). */
  id?: EventId;
  /** Override the auto-now timestamp (used by tests). */
  createdAt?: string;
}

export interface ActivityLogQuery {
  threadId: string;
  /** Restrict to a single turn — partition view. */
  turnId?: string;
  /** Multi-agent: restrict to a single Session (T078). */
  sessionId?: string;
  /** Return only events with sequence > sinceSeq. */
  sinceSeq?: number;
}

export interface ActivityLog {
  append(input: AppendActivityInput): ThreadActivity;
  list(query: ActivityLogQuery): ThreadActivity[];
  listByTurn(threadId: string, turnId: string): ThreadActivity[];
  /** Multi-agent: events produced by one Session, ordered by sequence (T078). */
  listBySession(threadId: string, sessionId: string): ThreadActivity[];
  /** Most recently appended activity, or null if the thread has none. */
  latest(threadId: string): ThreadActivity | null;
  /** Clear the log for a thread (used on thread.delete). */
  clear(threadId: string): void;
}

export interface MakeActivityLogOptions {
  now?: () => Date;
  randomId?: () => EventId;
  /** Emit `chat.activity.appended` after each append (opt-in). */
  emit?: (event: ChatThreadEvent) => void;
}

export function makeActivityLog(opts: MakeActivityLogOptions = {}): ActivityLog {
  const now = opts.now ?? (() => new Date());
  const randomId = opts.randomId ?? (() => randomUUID() as EventId);
  const emit = opts.emit ?? (() => undefined);
  const byThread = new Map<string, ThreadActivity[]>();
  const nextSeq = new Map<string, number>();

  function bucket(threadId: string): ThreadActivity[] {
    let b = byThread.get(threadId);
    if (!b) {
      b = [];
      byThread.set(threadId, b);
    }
    return b;
  }

  function takeSequence(threadId: string): number {
    const current = nextSeq.get(threadId) ?? 0;
    nextSeq.set(threadId, current + 1);
    return current;
  }

  return {
    append(input) {
      const activity: ThreadActivity = {
        id: input.id ?? randomId(),
        tone: input.tone,
        kind: input.kind,
        summary: input.summary,
        payload: input.payload ?? null,
        turnId: input.turnId ?? null,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        sequence: takeSequence(input.threadId),
        createdAt: input.createdAt ?? now().toISOString(),
      };
      bucket(input.threadId).push(activity);
      emit({
        type: "chat.activity.appended",
        threadId: input.threadId,
        activity,
        seq: activity.sequence ?? 0,
      });
      return activity;
    },
    list(query) {
      const b = byThread.get(query.threadId);
      if (!b) return [];
      return b.filter((a) => {
        if (query.turnId !== undefined && a.turnId !== query.turnId) return false;
        if (query.sessionId !== undefined && a.sessionId !== query.sessionId) return false;
        if (
          query.sinceSeq !== undefined &&
          (a.sequence === undefined || a.sequence <= query.sinceSeq)
        )
          return false;
        return true;
      });
    },
    listByTurn(threadId, turnId) {
      return this.list({ threadId, turnId });
    },
    listBySession(threadId, sessionId) {
      return this.list({ threadId, sessionId });
    },
    latest(threadId) {
      const b = byThread.get(threadId);
      if (!b || b.length === 0) return null;
      return b[b.length - 1] ?? null;
    },
    clear(threadId) {
      byThread.delete(threadId);
      nextSeq.delete(threadId);
    },
  };
}
