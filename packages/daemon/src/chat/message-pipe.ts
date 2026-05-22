/**
 * Per-thread message pipe — manages the coalescing buffers (persist +
 * text) and per-thread usage state. Each live thread owns one pipe; the
 * thread-manager delegates emit / recordUsage / forceFlush to it instead
 * of tracking timers and pending arrays directly.
 *
 * Coalescing windows:
 *   - persistDebounceMs: how long to wait before flushing buffered agent
 *     updates to the thread store (small batches reduce write amplification).
 *   - textCoalesceWindowMs: how long to merge consecutive text chunks
 *     into a single SessionUpdate (cuts WS chatter).
 *
 * If `disableCoalescing` is true, every emit is flushed eagerly and text
 * buffering is skipped (used by tests that expect exact event ordering).
 */

import { randomUUID } from "node:crypto";
import type { SessionUpdate } from "../acp/index.ts";
import type { ChatEvent, ChatThreadUsageSummary, StopReason, ThreadMessage } from "./types.ts";
import type { ThreadStore } from "./thread-store.ts";
import { mergeUsage, usageChanged, type UsagePatch } from "./usage-extraction.ts";
import { ThreadTimeline } from "./materialize.ts";

export interface MessagePipeOptions {
  threadId: string;
  initialSeq: number;
  initialUsage?: ChatThreadUsageSummary;
  /**
   * Raw event log the thread already has — used to bootstrap the
   * server-side materialized timeline so a reattach / mid-history
   * thread streams into the correct turn.
   */
  initialMessages?: ReadonlyArray<ThreadMessage>;
  store: Pick<ThreadStore, "appendMessages" | "recordUsage">;
  busEmit: (event: ChatEvent) => void;
  persistDebounceMs: number;
  textCoalesceWindowMs: number;
  disableCoalescing: boolean;
  logger: (event: { level: "info" | "warn" | "error"; msg: string; data?: unknown }) => void;
}

interface PendingPersist {
  messages: ThreadMessage[];
  timer: ReturnType<typeof setTimeout> | null;
  chain: Promise<void>;
}

interface PendingTextChunk {
  sessionUpdate: "agent_message_chunk" | "agent_thought_chunk";
  text: string;
  messageId?: string | null;
  meta?: Record<string, unknown> | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface MessagePipe {
  emit(update: SessionUpdate): void;
  recordUsage(patch: UsagePatch | null): void;
  forceFlush(): Promise<void>;
  /**
   * Re-materialize the timeline from the authoritative event log and
   * open `activePromptId` as the live streaming turn. Called by
   * `ThreadManager.send` after the user prompt is persisted — a full
   * rebuild here keeps the projection correct after a truncation
   * (editFromTurn) and is cheap (send is rare). Broadcasts
   * `chat.timeline.reset`.
   */
  resyncTimeline(messages: ReadonlyArray<ThreadMessage>, activePromptId: string): void;
  /**
   * Close the active turn's streaming row and broadcast the delta.
   * Called from prompt dispatch alongside `chat.thread.stop`.
   */
  finishTimeline(promptId: string, stopReason: StopReason): void;
}

export function makeMessagePipe(opts: MessagePipeOptions): MessagePipe {
  const { threadId, store, busEmit, logger } = opts;
  let seq = opts.initialSeq;
  let usage: ChatThreadUsageSummary | undefined = opts.initialUsage;
  const persist: PendingPersist = { messages: [], timer: null, chain: Promise.resolve() };
  let pendingText: PendingTextChunk | null = null;

  // Server-side materialized projection. Bootstrapped from the thread's
  // existing log so a reattach streams into the right turn. Each
  // emitted (coalesced) update folds in here and a whole-row upsert
  // delta is broadcast — the client renders it with zero reduction.
  const timeline = new ThreadTimeline();
  timeline.bootstrap(opts.initialMessages ?? []);

  function broadcastTimelineUpsert(): void {
    const delta = timeline.drainDelta();
    if (delta.rows.length === 0) return;
    busEmit({ type: "chat.timeline.upsert", threadId, rows: delta.rows, order: delta.order });
  }

  function schedulePersist(): void {
    if (persist.timer) clearTimeout(persist.timer);
    persist.timer = setTimeout(() => {
      persist.timer = null;
      void flushPersist();
    }, opts.persistDebounceMs);
    persist.timer.unref?.();
  }

  function queuePersist(update: SessionUpdate): void {
    persist.messages.push({
      _tag: "AgentUpdate",
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      update,
    });
    schedulePersist();
  }

  async function flushPersist(): Promise<void> {
    if (persist.timer) {
      clearTimeout(persist.timer);
      persist.timer = null;
    }
    const batch = persist.messages.splice(0);
    if (batch.length === 0) {
      await persist.chain;
      return;
    }
    const run = persist.chain
      .then(() => store.appendMessages(threadId, batch))
      .catch((err) => {
        logger({
          level: "warn",
          msg: "Failed to persist ACP session updates",
          data: { threadId, error: (err as Error).message ?? String(err) },
        });
      });
    persist.chain = run;
    await run;
  }

  function emitUpdate(update: SessionUpdate): void {
    seq += 1;
    busEmit({ type: "chat.thread.update", threadId, update, seq });
    queuePersist(update);
    // Fold the same coalesced update into the materialized timeline
    // and broadcast the whole-row delta. `agent-update:<seq>` mirrors
    // the synthetic source id the old client reducer used so assistant
    // row ids stay stable within a turn.
    timeline.applyAgentUpdate(`agent-update:${seq}`, new Date().toISOString(), update);
    broadcastTimelineUpsert();
  }

  function textChunkKind(
    update: SessionUpdate,
  ): "agent_message_chunk" | "agent_thought_chunk" | null {
    if (
      update.sessionUpdate === "agent_message_chunk" &&
      typeof update.content === "object" &&
      update.content !== null &&
      update.content.type === "text"
    ) {
      return "agent_message_chunk";
    }
    if (
      update.sessionUpdate === "agent_thought_chunk" &&
      typeof update.content === "object" &&
      update.content !== null &&
      update.content.type === "text"
    ) {
      return "agent_thought_chunk";
    }
    return null;
  }

  function flushText(): void {
    const pending = pendingText;
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    pendingText = null;
    const update: SessionUpdate = {
      sessionUpdate: pending.sessionUpdate,
      content: { type: "text", text: pending.text },
      ...(pending.messageId ? { messageId: pending.messageId } : {}),
      ...(pending.meta !== undefined ? { _meta: pending.meta } : {}),
    };
    emitUpdate(update);
  }

  function scheduleTextFlush(pending: PendingTextChunk): void {
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      pending.timer = null;
      flushText();
    }, opts.textCoalesceWindowMs);
    pending.timer.unref?.();
  }

  function bufferText(
    update: SessionUpdate,
    kind: "agent_message_chunk" | "agent_thought_chunk",
  ): void {
    const content = update.content as { type: "text"; text: string };
    const messageId =
      typeof update.messageId === "string" || update.messageId === null
        ? update.messageId
        : undefined;
    const meta =
      typeof update._meta === "object" || update._meta === null ? update._meta : undefined;
    if (pendingText && pendingText.sessionUpdate !== kind) flushText();
    const pending: PendingTextChunk = pendingText ?? {
      sessionUpdate: kind,
      text: "",
      messageId,
      meta,
      timer: null,
    };
    pending.text += content.text;
    pending.messageId = pending.messageId ?? messageId;
    pending.meta = pending.meta ?? meta;
    pendingText = pending;
    scheduleTextFlush(pending);
  }

  return {
    emit(update) {
      if (opts.disableCoalescing) {
        emitUpdate(update);
        return;
      }
      const kind = textChunkKind(update);
      if (!kind) {
        flushText();
        emitUpdate(update);
        return;
      }
      bufferText(update, kind);
    },
    recordUsage(patch) {
      if (!patch) return;
      const next = mergeUsage(usage, patch);
      if (!usageChanged(usage, next)) return;
      usage = next;
      busEmit({ type: "chat.thread.usage", threadId, usage: next });
      void store.recordUsage(threadId, next).catch((err) => {
        logger({
          level: "warn",
          msg: "Failed to persist chat thread usage",
          data: { threadId, error: (err as Error).message ?? String(err) },
        });
      });
    },
    async forceFlush() {
      flushText();
      await flushPersist();
    },
    resyncTimeline(messages, activePromptId) {
      timeline.bootstrap(messages, activePromptId);
      busEmit({ type: "chat.timeline.reset", threadId, rows: timeline.snapshot() });
    },
    finishTimeline(promptId, stopReason) {
      timeline.finish(promptId, stopReason, new Date().toISOString());
      broadcastTimelineUpsert();
    },
  };
}
