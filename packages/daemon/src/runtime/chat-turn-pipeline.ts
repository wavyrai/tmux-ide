/**
 * G14-T093 — end-to-end chat-turn flow expressed as an Effect program.
 *
 * This is the canonical demonstration that the daemon's persistence +
 * reactor + projection layers compose under one runtime. Production
 * callers (HTTP/IPC handlers) `Effect.runPromise` this at the boundary;
 * the program itself doesn't know or care what's calling it.
 *
 * Engineering wins surfaced here:
 *   - Typed dependency graph: requirements (`ChatEventStoreService |
 *     TurnProjectionService | ChatReactorService`) are visible on the
 *     Effect's type, so swapping the live Layer for a test Layer is a
 *     type-checked operation.
 *   - Error channel: every step's failure mode (`ChatEventStoreError`,
 *     `ProjectionError`) is in the second type parameter and reachable
 *     via `Effect.catchTags`. Nothing slips through `try`/`catch`.
 *   - Resource safety: the `ChatTurnPipelineLive` layer is `Layer.scoped`,
 *     so projection subscriptions and reactor disposers are released
 *     deterministically when the program finishes (success OR failure).
 */

import { Effect } from "effect";

import type { ChatThreadEvent, LatestTurn } from "@tmux-ide/contracts";

import type { PersistedChatEvent } from "../persistence/chat-event-store.ts";
import {
  ChatEventStoreService,
  ChatReactorService,
  TurnProjectionService,
} from "./services.ts";
import type { ChatEventStoreError, ProjectionError } from "./errors.ts";

export interface RunChatTurnPipelineInput {
  /**
   * Ordered events to append to the event store. The pipeline waits for
   * the reactor to drain between each append so projection state observed
   * at the end is deterministic.
   */
  events: ReadonlyArray<{
    event: ChatThreadEvent;
    actorKind: "user" | "provider" | "system";
    correlationId?: string;
  }>;
  /** The thread to query at the end. Defaults to the first event's threadId. */
  threadId?: string;
}

export interface RunChatTurnPipelineOutput {
  /** Each appended event in order, decorated with its assigned sequence. */
  appended: readonly PersistedChatEvent[];
  /** The projection's final view of the requested thread's latest turn. */
  latest: LatestTurn | null;
  /** Cursor value after the pipeline completes. */
  cursor: number;
}

/**
 * The end-to-end turn lifecycle program. Requires `ChatEventStoreService`,
 * `TurnProjectionService`, and `ChatReactorService` in the environment.
 */
export const runChatTurnPipeline = (
  input: RunChatTurnPipelineInput,
): Effect.Effect<
  RunChatTurnPipelineOutput,
  ChatEventStoreError | ProjectionError,
  ChatEventStoreService | TurnProjectionService | ChatReactorService
> =>
  Effect.gen(function* () {
    const store = yield* ChatEventStoreService;
    const projection = yield* TurnProjectionService;
    const reactor = yield* ChatReactorService;

    // 1. Bootstrap the projection from the persisted log.
    yield* projection.start;

    // 2. Append + drain in sequence. Draining after each append means the
    //    reactor and projection have both observed the event before we
    //    move on — gives this demo program deterministic ordering. A
    //    production caller usually appends fire-and-forget and relies on
    //    the subscription path.
    const appended: PersistedChatEvent[] = [];
    for (const ev of input.events) {
      const persisted = yield* store.append({
        event: ev.event,
        actorKind: ev.actorKind,
        ...(ev.correlationId ? { correlationId: ev.correlationId } : {}),
      });
      appended.push(persisted);
      yield* reactor.drain.pipe(
        Effect.catchTag("ReactorError", (err) =>
          Effect.die(`reactor drain failed: ${err.message}`),
        ),
      );
    }

    const targetThreadId =
      input.threadId ??
      (input.events.length > 0 ? input.events[0]!.event.threadId : null);

    const latest = targetThreadId
      ? yield* projection.latest(targetThreadId)
      : null;
    const cursor = yield* projection.cursor;

    return { appended, latest, cursor } satisfies RunChatTurnPipelineOutput;
  });
