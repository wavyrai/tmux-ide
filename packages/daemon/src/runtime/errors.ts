/**
 * G14-T093 — typed errors for the daemon's Effect runtime layer.
 *
 * Why tagged errors?
 *   - `Effect.Effect<A, E>` makes the error channel a first-class part of
 *     the type. Each tag becomes a value a caller can destructure
 *     (`Effect.catchTag("ChatEventStoreError", …)`) without losing the
 *     `cause`.
 *   - Tags carry a `_tag` discriminator so `Effect.catchTags({...})` exhaustively
 *     matches every known failure mode in one place.
 *   - The underlying plain-TS implementations (T090/T091/T092) throw with
 *     `Error` subclasses; the Layer wrappers catch + re-tag so callers in
 *     Effect-land see structured failures.
 */

import { Data } from "effect";

/** Append/read failure inside the sqlite chat event store. */
export class ChatEventStoreError extends Data.TaggedError("ChatEventStoreError")<{
  readonly operation: "append" | "readFromSequence" | "readByStream" | "subscribe";
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Projection state advanced past a gap or saw an unknown event shape. */
export class ProjectionError extends Data.TaggedError("ProjectionError")<{
  readonly projection: string;
  readonly reason: "gap" | "bootstrap" | "subscribe" | "ingest";
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Reactor lifecycle / drain failure. Per-event failures are isolated and
 *  surface through `chat.reactor.failure` synthetic events instead. */
export class ReactorError extends Data.TaggedError("ReactorError")<{
  readonly reactor: string;
  readonly phase: "start" | "drain" | "dispose";
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Permission-policy evaluation failure (T102). Used when the policy
 * subsystem itself misbehaves (corrupted rules, hot-reload race) — not
 * for "denied" / "needs-confirmation" verdicts, which are first-class
 * values in `ApprovalVerdict`, not errors.
 */
export class ApprovalPolicyError extends Data.TaggedError("ApprovalPolicyError")<{
  readonly operation: "evaluate" | "register" | "resolve";
  readonly message: string;
  readonly cause?: unknown;
}> {}
