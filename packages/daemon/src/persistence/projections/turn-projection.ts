/**
 * G14-T091 — turn projection.
 *
 * Re-implements the in-memory `TurnStore` read surface as a projection
 * rebuilt from the chat event log (T090). On startup the projection
 * loads its `last_applied_sequence` cursor, replays events from the
 * store, and then incrementally consumes new events via subscription.
 *
 * Source events (from `@tmux-ide/contracts` `ChatThreadEvent`):
 *   - chat.turn.started     → insert TurnRecord, state=running
 *   - chat.turn.completed   → transition to "completed"
 *   - chat.turn.aborted     → transition to "interrupted" | "error"
 *   - chat.session.removed  → drop turns for that session (optional, no-op
 *                              for now — single-session legacy threads do
 *                              not emit session events)
 *
 * Acceptance:
 *   - Daemon restart with a populated event log produces the same turn
 *     state observed before restart.
 *   - `cursor()` advances monotonically and equals the sequence of the
 *     last persisted event.
 *   - A subscribed event with sequence != cursor + 1 throws
 *     `ProjectionGapError` (the daemon's reactor isolation will catch +
 *     log + recover by reloading from the event store).
 *
 * NB: `chat.turn.started` carries `sourceProposedPlanRef` but the current
 * contract does not include `sessionId` on turn-lifecycle events. The
 * projection therefore mirrors what the in-memory `turn-store.ts` records
 * today — sessionId stays unset for these events. If a future contract
 * revision adds sessionId to turn events, this projection picks it up
 * automatically.
 */

import type {
  ChatThreadEvent,
  LatestTurn,
  LatestTurnState,
  TurnAbortReason,
} from "@tmux-ide/contracts";
import type {
  ChatEventReader,
  PersistedChatEvent,
  ProjectionCursorStore,
} from "../types.ts";
import { ProjectionGapError } from "../types.ts";

export interface TurnRecord extends LatestTurn {
  threadId: string;
}

export interface TurnProjection {
  /**
   * Bootstrap: replay events from `cursor()` onward via the reader, then
   * subscribe to new events. Idempotent; safe to call once at daemon
   * start.
   */
  start(): void;
  /** Tear down the subscription. Read methods remain queryable. */
  stop(): void;
  /** Current cursor — the highest sequence the projection has applied. */
  cursor(): number;

  // -- read API (matches the relevant subset of `TurnStore`) --
  get(threadId: string, turnId: string): TurnRecord | null;
  list(threadId: string): TurnRecord[];
  /** Returns turns whose sessionId matches; legacy turns (no sessionId) are excluded. */
  listBySession(threadId: string, sessionId: string): TurnRecord[];
  latest(threadId: string): LatestTurn | null;
  latestForSession(threadId: string, sessionId: string): LatestTurn | null;
}

export interface MakeTurnProjectionOptions {
  reader: ChatEventReader;
  cursorStore: ProjectionCursorStore;
  /** Projection name; defaults to "turn". Persisted in `projection_state`. */
  name?: string;
  /** Batch size for the bootstrap replay loop. Defaults to 1000. */
  batchSize?: number;
  /** Logger; defaults to no-op. */
  logger?: (entry: { level: "info" | "warn" | "error"; msg: string }) => void;
}

const DEFAULT_NAME = "turn";
const DEFAULT_BATCH_SIZE = 1000;

const TERMINAL_STATES: ReadonlySet<LatestTurnState> = new Set([
  "completed",
  "interrupted",
  "error",
]);

function isLegalTransition(from: LatestTurnState, to: LatestTurnState): boolean {
  if (from === to) return true;
  if (TERMINAL_STATES.has(from)) return false;
  return TERMINAL_STATES.has(to);
}

const ABORT_TO_STATE: Record<TurnAbortReason, LatestTurnState> = {
  cancelled: "interrupted",
  interrupted: "interrupted",
  error: "error",
};

function stripThreadId(record: TurnRecord): LatestTurn {
  const { threadId: _omit, ...rest } = record;
  void _omit;
  return rest;
}

export function makeTurnProjection(
  opts: MakeTurnProjectionOptions,
): TurnProjection {
  const name = opts.name ?? DEFAULT_NAME;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const log = opts.logger ?? (() => undefined);

  const byThread = new Map<string, Map<string, TurnRecord>>();
  const latestByThread = new Map<string, string>();
  const latestByThreadSession = new Map<string, string>();
  const sessionKey = (threadId: string, sessionId: string): string =>
    `${threadId} ${sessionId}`;

  let cursor = 0;
  let unsubscribe: (() => void) | null = null;
  let started = false;

  function bucket(threadId: string): Map<string, TurnRecord> {
    let b = byThread.get(threadId);
    if (!b) {
      b = new Map();
      byThread.set(threadId, b);
    }
    return b;
  }

  function applyTurnStarted(
    threadId: string,
    turnId: string,
    requestedAt: string,
    sourceProposedPlan: LatestTurn["sourceProposedPlan"] | undefined,
  ): void {
    const b = bucket(threadId);
    if (b.has(turnId)) {
      // Duplicate `chat.turn.started` — projection-side dedup. Keep first.
      log({
        level: "warn",
        msg: `turn projection: duplicate chat.turn.started for ${threadId}/${turnId}; ignoring`,
      });
      return;
    }
    const record: TurnRecord = {
      threadId,
      turnId,
      state: "running",
      requestedAt,
      startedAt: requestedAt,
      completedAt: null,
      assistantMessageId: null,
      ...(sourceProposedPlan ? { sourceProposedPlan } : {}),
    };
    b.set(turnId, record);
    latestByThread.set(threadId, turnId);
  }

  function applyTurnTransition(
    threadId: string,
    turnId: string,
    nextState: LatestTurnState,
    completedAt: string,
    assistantMessageId: string | null | undefined,
  ): void {
    const b = byThread.get(threadId);
    const existing = b?.get(turnId);
    if (!existing) {
      // The projection observed a terminal event before the start event —
      // could happen if the event store was truncated or the contract
      // evolved. Log + skip rather than crash.
      log({
        level: "warn",
        msg: `turn projection: ${nextState} event for unknown turn ${threadId}/${turnId}; skipping`,
      });
      return;
    }
    if (!isLegalTransition(existing.state, nextState)) {
      log({
        level: "warn",
        msg: `turn projection: illegal transition ${existing.state}→${nextState} for ${threadId}/${turnId}; skipping`,
      });
      return;
    }
    const next: TurnRecord = {
      ...existing,
      state: nextState,
      completedAt: TERMINAL_STATES.has(nextState)
        ? completedAt
        : existing.completedAt,
      assistantMessageId:
        assistantMessageId !== undefined
          ? assistantMessageId
          : existing.assistantMessageId,
    };
    b!.set(turnId, next);
  }

  function applySessionRemoved(threadId: string, sessionId: string): void {
    // Drop the per-(thread,session) latest pointer. The turn records
    // themselves remain — they're history.
    latestByThreadSession.delete(sessionKey(threadId, sessionId));
  }

  function project(event: ChatThreadEvent, occurredAt: string): void {
    switch (event.type) {
      case "chat.turn.started":
        applyTurnStarted(
          event.threadId,
          event.turnId,
          event.requestedAt,
          event.sourceProposedPlanRef,
        );
        return;
      case "chat.turn.completed":
        applyTurnTransition(
          event.threadId,
          event.turnId,
          event.state,
          event.completedAt,
          event.assistantMessageId ?? null,
        );
        return;
      case "chat.turn.aborted": {
        const nextState = ABORT_TO_STATE[event.reason];
        applyTurnTransition(
          event.threadId,
          event.turnId,
          nextState,
          occurredAt,
          undefined,
        );
        return;
      }
      case "chat.session.removed":
        applySessionRemoved(event.threadId, event.sessionId);
        return;
      // All other event types are irrelevant to the turn projection.
      default:
        return;
    }
  }

  function ingest(persisted: PersistedChatEvent): void {
    if (persisted.sequence !== cursor + 1) {
      throw new ProjectionGapError(name, cursor + 1, persisted.sequence);
    }
    project(persisted.event, persisted.occurredAt);
    cursor = persisted.sequence;
    opts.cursorStore.save(name, cursor);
  }

  function bootstrap(): void {
    cursor = opts.cursorStore.load(name);
    // Loop in batches to avoid blowing memory on long event logs.
    let batch = opts.reader.readFromSequence(cursor, batchSize);
    while (batch.length > 0) {
      for (const persisted of batch) {
        ingest(persisted);
      }
      batch = opts.reader.readFromSequence(cursor, batchSize);
    }
  }

  return {
    start() {
      if (started) return;
      started = true;
      bootstrap();
      unsubscribe = opts.reader.subscribe((event) => {
        ingest(event);
      });
    },
    stop() {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      started = false;
    },
    cursor() {
      return cursor;
    },
    get(threadId, turnId) {
      return byThread.get(threadId)?.get(turnId) ?? null;
    },
    list(threadId) {
      const b = byThread.get(threadId);
      return b ? [...b.values()] : [];
    },
    listBySession(threadId, sessionId) {
      const b = byThread.get(threadId);
      if (!b) return [];
      return [...b.values()].filter((t) => t.sessionId === sessionId);
    },
    latest(threadId) {
      const turnId = latestByThread.get(threadId);
      if (!turnId) return null;
      const record = byThread.get(threadId)?.get(turnId);
      return record ? stripThreadId(record) : null;
    },
    latestForSession(threadId, sessionId) {
      const turnId = latestByThreadSession.get(sessionKey(threadId, sessionId));
      if (!turnId) return null;
      const record = byThread.get(threadId)?.get(turnId);
      return record ? stripThreadId(record) : null;
    },
  };
}
