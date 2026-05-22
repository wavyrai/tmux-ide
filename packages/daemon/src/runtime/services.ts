/**
 * G14-T093 — Effect service tags for the daemon's chat persistence pipeline.
 *
 * Schema-at-edge per docs/goal-14-architecture-parity.md §2.2: Effect runs
 * the persistence + reactor + projection layers; HTTP/IPC code keeps using
 * plain TS. These tags describe the daemon-side surfaces only. No tag here
 * is exported across the contracts boundary — the public contract surface
 * (packages/contracts) stays Effect-free.
 *
 * One-shape-per-service:
 *   - ChatEventStoreService — durable append + replay + subscribe
 *   - TurnProjectionService — read model over the event log
 *   - ChatReactorService    — bounded queue for side-effect handlers
 *
 * Each service follows t3's
 *   `apps/server/src/persistence/Services/OrchestrationEventStore.ts` pattern:
 * an `interface FooShape` declaring the typed methods, and a `class Foo
 * extends Context.Tag(...)<Foo, FooShape>` providing the dependency-injection
 * tag. Layers (see `layers.ts`) bind the shapes to concrete implementations.
 */

import { Context, type Effect } from "effect";

import type {
  AppendInput,
  ChatEventStore,
  PersistedChatEvent,
} from "../persistence/chat-event-store.ts";
import type { TurnProjection, TurnRecord } from "../persistence/projections/turn-projection.ts";
import type {
  TurnDiffAggregate,
  TurnDiffEntry,
  TurnDiffProjection,
} from "../persistence/projections/turn-diff-projection.ts";
import type { LatestTurn } from "@tmux-ide/contracts";
import type { Reactor } from "../chat/reactors/reactor.ts";
import type {
  ApprovalVerdict,
  EvaluateInput,
  PermissionRequestEmission,
  ProviderApprovalPolicy,
  ProviderApprovalRules,
} from "../chat/provider-approval-policy.ts";
import type {
  NegotiationResult,
  ProviderCapabilities,
  ProviderCapabilitiesOverride,
  ProviderCapabilitiesStore,
  RequestedFeatures,
} from "../chat/provider-capabilities.ts";
import type { ProviderInstance } from "@tmux-ide/contracts";

import type {
  ApprovalPolicyError,
  ChatEventStoreError,
  ProjectionError,
  ReactorError,
} from "./errors.ts";

// ---------------------------------------------------------------------------
// ChatEventStoreService
// ---------------------------------------------------------------------------

export interface ChatEventStoreServiceShape {
  readonly append: (input: AppendInput) => Effect.Effect<PersistedChatEvent, ChatEventStoreError>;
  readonly readFromSequence: (
    seqExclusive: number,
    limit?: number,
  ) => Effect.Effect<readonly PersistedChatEvent[], ChatEventStoreError>;
  /**
   * Register a synchronous subscriber. The returned `unsubscribe` Effect is
   * resource-safe (always succeeds). Subscriber exceptions are caught
   * inside the event store and never propagate to the append caller.
   */
  readonly subscribe: (
    handler: (event: PersistedChatEvent) => void,
  ) => Effect.Effect<() => void, never>;
  /** Escape hatch: get the underlying plain-TS event store. Use sparingly. */
  readonly raw: ChatEventStore;
}

export class ChatEventStoreService extends Context.Tag(
  "@tmux-ide/daemon/runtime/ChatEventStoreService",
)<ChatEventStoreService, ChatEventStoreServiceShape>() {}

// ---------------------------------------------------------------------------
// TurnProjectionService
// ---------------------------------------------------------------------------

export interface TurnProjectionServiceShape {
  /** Bootstrap from cursor and subscribe to new events. Idempotent. */
  readonly start: Effect.Effect<void, ProjectionError>;
  /** Detach subscription. Read methods still resolve. */
  readonly stop: Effect.Effect<void, never>;
  readonly cursor: Effect.Effect<number, never>;
  readonly latest: (threadId: string) => Effect.Effect<LatestTurn | null, never>;
  readonly list: (threadId: string) => Effect.Effect<readonly TurnRecord[], never>;
  /** Escape hatch — direct access to the plain projection. */
  readonly raw: TurnProjection;
}

export class TurnProjectionService extends Context.Tag(
  "@tmux-ide/daemon/runtime/TurnProjectionService",
)<TurnProjectionService, TurnProjectionServiceShape>() {}

// ---------------------------------------------------------------------------
// TurnDiffProjectionService (G14-T101)
// ---------------------------------------------------------------------------

export interface TurnDiffProjectionServiceShape {
  readonly start: Effect.Effect<void, ProjectionError>;
  readonly stop: Effect.Effect<void, never>;
  readonly cursor: Effect.Effect<number, never>;
  readonly listForTurn: (turnId: string) => Effect.Effect<readonly TurnDiffEntry[], never>;
  readonly listForThread: (
    threadId: string,
  ) => Effect.Effect<Readonly<Record<string, readonly TurnDiffEntry[]>>, never>;
  readonly aggregateForThread: (threadId: string) => Effect.Effect<TurnDiffAggregate, never>;
  /** Escape hatch — direct access to the plain projection. */
  readonly raw: TurnDiffProjection;
}

export class TurnDiffProjectionService extends Context.Tag(
  "@tmux-ide/daemon/runtime/TurnDiffProjectionService",
)<TurnDiffProjectionService, TurnDiffProjectionServiceShape>() {}

// ---------------------------------------------------------------------------
// ChatReactorService
// ---------------------------------------------------------------------------

export interface ChatReactorServiceShape {
  readonly start: Effect.Effect<void, ReactorError>;
  /** Drains the queue + halts further processing. */
  readonly dispose: Effect.Effect<void, ReactorError>;
  /** Wait until the queue is empty and no event is in-flight. */
  readonly drain: Effect.Effect<void, ReactorError>;
  /** Push an event into the reactor's queue. Returns immediately. */
  readonly enqueue: (event: PersistedChatEvent) => Effect.Effect<void, never>;
  /** Escape hatch — direct access to the underlying reactor. */
  readonly raw: Reactor<PersistedChatEvent>;
}

// ---------------------------------------------------------------------------
// ProviderApprovalPolicyService (G14-T12 / T102)
// ---------------------------------------------------------------------------

export interface ProviderApprovalPolicyServiceShape {
  /** Resolve the verdict for a tool call. Side-effect inside the
   *  underlying policy fires the permission-request emission callback
   *  when the verdict is `needs-confirmation`. */
  readonly evaluate: (input: EvaluateInput) => Effect.Effect<ApprovalVerdict, ApprovalPolicyError>;
  /** Hot-update a provider's rules. Last-write-wins. */
  readonly register: (
    provider: string,
    rules: ProviderApprovalRules,
  ) => Effect.Effect<void, ApprovalPolicyError>;
  /** Read rules for inspection (debug endpoint, tests). */
  readonly getRules: (provider: string) => Effect.Effect<ProviderApprovalRules | null, never>;
  /** Resolve a pending prompt — used by the WS path when the operator
   *  clicks an approve/deny button in the chat UI. */
  readonly resolvePrompt: (
    promptId: string,
    decision: "approve" | "deny",
    reason?: string,
  ) => Effect.Effect<boolean, ApprovalPolicyError>;
  /** Snapshot of currently-pending prompts. */
  readonly pendingPrompts: Effect.Effect<readonly PermissionRequestEmission[], never>;
  /** Escape hatch — direct access to the plain policy. */
  readonly raw: ProviderApprovalPolicy;
}

export class ProviderApprovalPolicyService extends Context.Tag(
  "@tmux-ide/daemon/runtime/ProviderApprovalPolicyService",
)<ProviderApprovalPolicyService, ProviderApprovalPolicyServiceShape>() {}

// ---------------------------------------------------------------------------
// ProviderCapabilitiesService (G14-T13 / T103)
// ---------------------------------------------------------------------------

export interface ProviderCapabilitiesServiceShape {
  /** Resolve capabilities for a provider instance (built-in defaults merged with override). */
  readonly forInstance: (
    instance: Pick<ProviderInstance, "id" | "kind">,
  ) => Effect.Effect<ProviderCapabilities, never>;
  /** Hot-update a per-instance override. Operators flip toggles in the
   *  Provider Settings UI; last-write-wins. */
  readonly setOverride: (
    id: string,
    override: ProviderCapabilitiesOverride,
  ) => Effect.Effect<void, never>;
  readonly clearOverride: (id: string) => Effect.Effect<boolean, never>;
  readonly getOverride: (id: string) => Effect.Effect<ProviderCapabilitiesOverride | null, never>;
  /** Negotiate a request against the provider's capabilities — returns the
   *  granted feature set + a list of downgrades the UI should surface. */
  readonly negotiate: (
    instance: Pick<ProviderInstance, "id" | "kind">,
    requested: RequestedFeatures,
  ) => Effect.Effect<NegotiationResult, never>;
  /** Escape hatch — direct access to the plain store. */
  readonly raw: ProviderCapabilitiesStore;
}

export class ProviderCapabilitiesService extends Context.Tag(
  "@tmux-ide/daemon/runtime/ProviderCapabilitiesService",
)<ProviderCapabilitiesService, ProviderCapabilitiesServiceShape>() {}

// ---------------------------------------------------------------------------

export class ChatReactorService extends Context.Tag("@tmux-ide/daemon/runtime/ChatReactorService")<
  ChatReactorService,
  ChatReactorServiceShape
>() {}
