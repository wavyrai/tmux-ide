/**
 * Chat-thread schemas ported 1:1 from t3code's orchestration schemas.
 *
 * Source: context/t3code/packages/contracts/src/orchestration.ts
 *
 * Conventions:
 *   - The `Orchestration` prefix is dropped from exported names.
 *   - ID schemas are plain `z.string()` (t3 brands them; we don't).
 *   - This module is data-shape only — no daemon wiring, no UI work,
 *     no migration of existing chat/types.ts (T071+).
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// ID schemas — plain z.string() per our convention (no branding).
// ---------------------------------------------------------------------------

export const ThreadIdZ = z.string();
export type ThreadId = z.infer<typeof ThreadIdZ>;

export const TurnIdZ = z.string();
export type TurnId = z.infer<typeof TurnIdZ>;

export const CheckpointRefZ = z.string();
export type CheckpointRef = z.infer<typeof CheckpointRefZ>;

export const MessageIdZ = z.string();
export type MessageId = z.infer<typeof MessageIdZ>;

export const EventIdZ = z.string();
export type EventId = z.infer<typeof EventIdZ>;

export const SessionIdZ = z.string();
export type SessionId = z.infer<typeof SessionIdZ>;

// ---------------------------------------------------------------------------
// Supporting primitives (kept minimal — t3 brands these too; we don't).
// ---------------------------------------------------------------------------

const ProjectIdZ = z.string();
const IsoDateTimeZ = z.string();
const NonNegativeIntZ = z.number().int().nonnegative();
const TrimmedNonEmptyStringZ = z.string().trim().min(1);

const ProposedPlanIdZ = TrimmedNonEmptyStringZ;
export type ProposedPlanId = z.infer<typeof ProposedPlanIdZ>;

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const SessionStatusZ = z.enum([
  "idle",
  "starting",
  "running",
  "ready",
  "interrupted",
  "stopped",
  "error",
]);
export type SessionStatus = z.infer<typeof SessionStatusZ>;

export const CheckpointStatusZ = z.enum(["ready", "missing", "error"]);
export type CheckpointStatus = z.infer<typeof CheckpointStatusZ>;

export const ThreadActivityToneZ = z.enum(["info", "tool", "approval", "error"]);
export type ThreadActivityTone = z.infer<typeof ThreadActivityToneZ>;

export const LatestTurnStateZ = z.enum(["running", "interrupted", "completed", "error"]);
export type LatestTurnState = z.infer<typeof LatestTurnStateZ>;

export const MessageRoleZ = z.enum(["user", "assistant", "system"]);
export type MessageRole = z.infer<typeof MessageRoleZ>;

export const RuntimeModeZ = z.enum(["approval-required", "auto-accept-edits", "full-access"]);
export type RuntimeMode = z.infer<typeof RuntimeModeZ>;
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";

export const InteractionModeZ = z.enum(["default", "plan"]);
export type InteractionMode = z.infer<typeof InteractionModeZ>;
export const DEFAULT_INTERACTION_MODE: InteractionMode = "default";

/**
 * Session role — mirrors the role enum used by ide.yml panes so a chat
 * Session can advertise the same persona contract (lead, teammate,
 * planner, validator, researcher). Used as default-permission and
 * UI-grouping metadata only.
 */
export const SessionRoleZ = z.enum([
  "lead",
  "teammate",
  "planner",
  "validator",
  "researcher",
]);
export type SessionRole = z.infer<typeof SessionRoleZ>;

// ---------------------------------------------------------------------------
// ModelSelection — simplified pragmatic shape (no legacy `provider` decode
// transform; that's a t3-internal concern. Threads reference a configured
// instance by id plus a model slug.)
// ---------------------------------------------------------------------------

export const ModelSelectionZ = z.object({
  instanceId: TrimmedNonEmptyStringZ,
  model: TrimmedNonEmptyStringZ,
  options: z.record(z.string(), z.unknown()).optional(),
});
export type ModelSelection = z.infer<typeof ModelSelectionZ>;

// ---------------------------------------------------------------------------
// Attachments — only image attachments are defined in t3 today.
// ---------------------------------------------------------------------------

const CHAT_ATTACHMENT_ID_MAX_CHARS = 128;
export const PROVIDER_SEND_TURN_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export const ChatImageAttachmentZ = z.object({
  type: z.literal("image"),
  id: TrimmedNonEmptyStringZ.max(CHAT_ATTACHMENT_ID_MAX_CHARS).regex(/^[a-z0-9_-]+$/i),
  name: TrimmedNonEmptyStringZ.max(255),
  mimeType: TrimmedNonEmptyStringZ.max(100).regex(/^image\//i),
  sizeBytes: NonNegativeIntZ.max(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES),
});
export type ChatImageAttachment = z.infer<typeof ChatImageAttachmentZ>;

export const ChatAttachmentZ = z.discriminatedUnion("type", [ChatImageAttachmentZ]);
export type ChatAttachment = z.infer<typeof ChatAttachmentZ>;

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

export const MessageZ = z.object({
  id: MessageIdZ,
  role: MessageRoleZ,
  text: z.string(),
  attachments: z.array(ChatAttachmentZ).optional(),
  turnId: TurnIdZ.nullable(),
  streaming: z.boolean(),
  createdAt: IsoDateTimeZ,
  updatedAt: IsoDateTimeZ,
});
export type Message = z.infer<typeof MessageZ>;

// ---------------------------------------------------------------------------
// ProposedPlan
// ---------------------------------------------------------------------------

export const ProposedPlanRejectionZ = z.object({
  at: IsoDateTimeZ,
  reason: z.string().optional(),
});
export type ProposedPlanRejection = z.infer<typeof ProposedPlanRejectionZ>;

export const ProposedPlanZ = z.object({
  id: ProposedPlanIdZ,
  turnId: TurnIdZ.nullable(),
  planMarkdown: TrimmedNonEmptyStringZ,
  implementedAt: IsoDateTimeZ.nullable().default(null),
  implementationThreadId: ThreadIdZ.nullable().default(null),
  rejected: ProposedPlanRejectionZ.optional(),
  createdAt: IsoDateTimeZ,
  updatedAt: IsoDateTimeZ,
});
export type ProposedPlan = z.infer<typeof ProposedPlanZ>;

const SourceProposedPlanReferenceZ = z.object({
  threadId: ThreadIdZ,
  planId: ProposedPlanIdZ,
});
export type SourceProposedPlanReference = z.infer<typeof SourceProposedPlanReferenceZ>;

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/**
 * Session — one provider instance within a Thread. A Thread can host
 * multiple Sessions; each Session has its own provider, runtimeMode,
 * activeTurnId, and (optionally) role/displayName for UI grouping.
 *
 * Back-compat: `id` is optional so wire shapes from before T078 (which
 * modelled a single implicit session) still parse. Code that creates
 * new sessions should always assign a non-empty id.
 */
export const SessionZ = z.object({
  id: SessionIdZ.optional(),
  threadId: ThreadIdZ,
  status: SessionStatusZ,
  providerName: TrimmedNonEmptyStringZ.nullable(),
  providerInstanceId: TrimmedNonEmptyStringZ.optional(),
  runtimeMode: RuntimeModeZ.default(DEFAULT_RUNTIME_MODE),
  role: SessionRoleZ.optional(),
  displayName: TrimmedNonEmptyStringZ.optional(),
  activeTurnId: TurnIdZ.nullable(),
  lastError: TrimmedNonEmptyStringZ.nullable(),
  updatedAt: IsoDateTimeZ,
});
export type Session = z.infer<typeof SessionZ>;

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

export const CheckpointFileZ = z.object({
  path: TrimmedNonEmptyStringZ,
  kind: TrimmedNonEmptyStringZ,
  additions: NonNegativeIntZ,
  deletions: NonNegativeIntZ,
});
export type CheckpointFile = z.infer<typeof CheckpointFileZ>;

export const CheckpointSummaryZ = z.object({
  turnId: TurnIdZ,
  checkpointTurnCount: NonNegativeIntZ,
  checkpointRef: CheckpointRefZ,
  status: CheckpointStatusZ,
  files: z.array(CheckpointFileZ),
  assistantMessageId: MessageIdZ.nullable(),
  completedAt: IsoDateTimeZ,
});
export type CheckpointSummary = z.infer<typeof CheckpointSummaryZ>;

// ---------------------------------------------------------------------------
// ThreadActivity
// ---------------------------------------------------------------------------

export const ThreadActivityZ = z.object({
  id: EventIdZ,
  tone: ThreadActivityToneZ,
  kind: TrimmedNonEmptyStringZ,
  summary: TrimmedNonEmptyStringZ,
  payload: z.unknown(),
  turnId: TurnIdZ.nullable(),
  /**
   * Multi-agent attribution: when a Thread hosts multiple Sessions, the
   * activity stream is interleaved by `sequence` but each entry carries
   * the Session that produced it so the dashboard can render lanes /
   * color-coded chips per agent. Optional for back-compat with single
   * session threads from before T078.
   */
  sessionId: SessionIdZ.optional(),
  sequence: NonNegativeIntZ.optional(),
  createdAt: IsoDateTimeZ,
});
export type ThreadActivity = z.infer<typeof ThreadActivityZ>;

// ---------------------------------------------------------------------------
// LatestTurn
// ---------------------------------------------------------------------------

export const LatestTurnZ = z.object({
  turnId: TurnIdZ,
  state: LatestTurnStateZ,
  requestedAt: IsoDateTimeZ,
  startedAt: IsoDateTimeZ.nullable(),
  completedAt: IsoDateTimeZ.nullable(),
  assistantMessageId: MessageIdZ.nullable(),
  /** Owning session when the Thread has multi-agent sessions (T078). */
  sessionId: SessionIdZ.optional(),
  sourceProposedPlan: SourceProposedPlanReferenceZ.optional(),
});
export type LatestTurn = z.infer<typeof LatestTurnZ>;

// ---------------------------------------------------------------------------
// Thread — top-level aggregate
// ---------------------------------------------------------------------------

export const ThreadZ = z.object({
  id: ThreadIdZ,
  projectId: ProjectIdZ,
  title: TrimmedNonEmptyStringZ,
  modelSelection: ModelSelectionZ,
  runtimeMode: RuntimeModeZ,
  interactionMode: InteractionModeZ.default(DEFAULT_INTERACTION_MODE),
  branch: TrimmedNonEmptyStringZ.nullable(),
  worktreePath: TrimmedNonEmptyStringZ.nullable(),
  latestTurn: LatestTurnZ.nullable(),
  createdAt: IsoDateTimeZ,
  updatedAt: IsoDateTimeZ,
  archivedAt: IsoDateTimeZ.nullable().default(null),
  deletedAt: IsoDateTimeZ.nullable(),
  messages: z.array(MessageZ),
  proposedPlans: z.array(ProposedPlanZ).default([]),
  activities: z.array(ThreadActivityZ),
  checkpoints: z.array(CheckpointSummaryZ),
  /**
   * @deprecated since T078 — prefer `sessions[]`. Retained so legacy
   * single-session wire shapes still parse; the canonical multi-agent
   * representation is the `sessions` array below. Consumers that only
   * need a single session can read `sessions[0]` (the compat shim).
   */
  session: SessionZ.nullable(),
  /**
   * Multi-agent (T078): a Thread can host multiple concurrent Sessions,
   * each backed by its own provider/runtimeMode/activeTurnId. Default is
   * empty so previously-persisted Threads continue to round-trip; new
   * Threads should always populate at least one Session.
   */
  sessions: z.array(SessionZ).default([]),
});
export type Thread = z.infer<typeof ThreadZ>;

// ---------------------------------------------------------------------------
// t3-style chat thread events (T074). These are the additive next-gen
// broadcasts that mirror t3's orchestration/providerRuntime event taxonomy
// (ThreadActivityAppendedPayload, TurnStartedPayload, etc).
//
// They live alongside (not replacing) the daemon's legacy chat.thread.*
// events. The daemon emits BOTH for one release; consumers migrate at their
// own pace; T080 flips the kill switch on the old shapes.
//
// Naming: `chat.<aggregate>.<verb>` so the event-type literal is identical
// to a t3 event you would see on its orchestration stream — the schema and
// the wire literal are the canonical surface, not a translation thereof.
// ---------------------------------------------------------------------------

export const TurnAbortReasonZ = z.enum(["cancelled", "interrupted", "error"]);
export type TurnAbortReason = z.infer<typeof TurnAbortReasonZ>;

export const ThreadActivityAppendedEventZ = z.object({
  type: z.literal("chat.activity.appended"),
  threadId: ThreadIdZ,
  activity: ThreadActivityZ,
  seq: NonNegativeIntZ,
});
export type ThreadActivityAppendedEvent = z.infer<typeof ThreadActivityAppendedEventZ>;

export const TurnStartedEventZ = z.object({
  type: z.literal("chat.turn.started"),
  threadId: ThreadIdZ,
  turnId: TurnIdZ,
  requestedAt: IsoDateTimeZ,
  sourceProposedPlanRef: SourceProposedPlanReferenceZ.optional(),
});
export type TurnStartedEvent = z.infer<typeof TurnStartedEventZ>;

export const TurnCompletedEventZ = z.object({
  type: z.literal("chat.turn.completed"),
  threadId: ThreadIdZ,
  turnId: TurnIdZ,
  state: LatestTurnStateZ,
  completedAt: IsoDateTimeZ,
  assistantMessageId: MessageIdZ.optional(),
});
export type TurnCompletedEvent = z.infer<typeof TurnCompletedEventZ>;

export const TurnAbortedEventZ = z.object({
  type: z.literal("chat.turn.aborted"),
  threadId: ThreadIdZ,
  turnId: TurnIdZ,
  reason: TurnAbortReasonZ,
});
export type TurnAbortedEvent = z.infer<typeof TurnAbortedEventZ>;

export const PlanUpsertedEventZ = z.object({
  type: z.literal("chat.plan.upserted"),
  threadId: ThreadIdZ,
  plan: ProposedPlanZ,
});
export type PlanUpsertedEvent = z.infer<typeof PlanUpsertedEventZ>;

export const CheckpointCreatedEventZ = z.object({
  type: z.literal("chat.checkpoint.created"),
  threadId: ThreadIdZ,
  checkpoint: CheckpointSummaryZ,
});
export type CheckpointCreatedEvent = z.infer<typeof CheckpointCreatedEventZ>;

export const ThreadRevertedEventZ = z.object({
  type: z.literal("chat.thread.reverted"),
  threadId: ThreadIdZ,
  toCheckpointRef: CheckpointRefZ,
});
export type ThreadRevertedEvent = z.infer<typeof ThreadRevertedEventZ>;

// ---------------------------------------------------------------------------
// Multi-agent session events (T078). A Thread can host multiple Sessions;
// each Session can be added/removed at runtime and has its own status that
// transitions independently of any sibling sessions.
// ---------------------------------------------------------------------------

export const SessionAddedEventZ = z.object({
  type: z.literal("chat.session.added"),
  threadId: ThreadIdZ,
  session: SessionZ,
});
export type SessionAddedEvent = z.infer<typeof SessionAddedEventZ>;

export const SessionRemovedEventZ = z.object({
  type: z.literal("chat.session.removed"),
  threadId: ThreadIdZ,
  sessionId: SessionIdZ,
});
export type SessionRemovedEvent = z.infer<typeof SessionRemovedEventZ>;

export const SessionStatusChangedEventZ = z.object({
  type: z.literal("chat.session.status-changed"),
  threadId: ThreadIdZ,
  sessionId: SessionIdZ,
  status: SessionStatusZ,
  lastError: TrimmedNonEmptyStringZ.nullable().optional(),
  activeTurnId: TurnIdZ.nullable().optional(),
});
export type SessionStatusChangedEvent = z.infer<typeof SessionStatusChangedEventZ>;

/** Discriminated union of all t3-style chat thread events. */
export const ChatThreadEventZ = z.discriminatedUnion("type", [
  ThreadActivityAppendedEventZ,
  TurnStartedEventZ,
  TurnCompletedEventZ,
  TurnAbortedEventZ,
  PlanUpsertedEventZ,
  CheckpointCreatedEventZ,
  ThreadRevertedEventZ,
  SessionAddedEventZ,
  SessionRemovedEventZ,
  SessionStatusChangedEventZ,
]);
export type ChatThreadEvent = z.infer<typeof ChatThreadEventZ>;

/** String literals for the new t3-style chat thread event types. */
export const CHAT_THREAD_EVENT_TYPES = [
  "chat.activity.appended",
  "chat.turn.started",
  "chat.turn.completed",
  "chat.turn.aborted",
  "chat.plan.upserted",
  "chat.checkpoint.created",
  "chat.thread.reverted",
  "chat.session.added",
  "chat.session.removed",
  "chat.session.status-changed",
] as const;
export type ChatThreadEventType = (typeof CHAT_THREAD_EVENT_TYPES)[number];

// ---------------------------------------------------------------------------
// T079: Provider abstraction. Today's daemon only knows the two
// ACP-discoverable providers (claude-code, codex). The provider-registry
// (packages/daemon/src/chat/provider-registry.ts) layers a kind-discriminated
// adapter surface on top so the chat surface can target Anthropic / OpenAI /
// local Ollama / local LM Studio / arbitrary ACP without bespoke wiring
// inside thread-manager.
//
// These types are additive — Thread.provider keeps its legacy AgentProvider
// shape until T080 flips it over. ProviderInstance is the next-gen shape
// that backs a Thread once the daemon-side migration lands.
// ---------------------------------------------------------------------------

export const ProviderKindZ = z.enum([
  "anthropic",
  "openai",
  "local-ollama",
  "local-lmstudio",
  "generic-acp",
]);
export type ProviderKind = z.infer<typeof ProviderKindZ>;

export const ProviderInstanceIdZ = TrimmedNonEmptyStringZ.regex(/^[a-z0-9_-]+$/i);
export type ProviderInstanceId = z.infer<typeof ProviderInstanceIdZ>;

const NonEmptyTokenZ = TrimmedNonEmptyStringZ;

export const AnthropicProviderConfigZ = z.object({
  kind: z.literal("anthropic"),
  apiKey: NonEmptyTokenZ,
  model: NonEmptyTokenZ,
  baseUrl: NonEmptyTokenZ.optional(),
});
export type AnthropicProviderConfig = z.infer<typeof AnthropicProviderConfigZ>;

export const OpenAIProviderConfigZ = z.object({
  kind: z.literal("openai"),
  apiKey: NonEmptyTokenZ,
  model: NonEmptyTokenZ,
  baseUrl: NonEmptyTokenZ.optional(),
  organization: NonEmptyTokenZ.optional(),
});
export type OpenAIProviderConfig = z.infer<typeof OpenAIProviderConfigZ>;

export const LocalOllamaProviderConfigZ = z.object({
  kind: z.literal("local-ollama"),
  baseUrl: NonEmptyTokenZ.default("http://127.0.0.1:11434"),
  model: NonEmptyTokenZ,
});
export type LocalOllamaProviderConfig = z.infer<typeof LocalOllamaProviderConfigZ>;

export const LocalLmStudioProviderConfigZ = z.object({
  kind: z.literal("local-lmstudio"),
  baseUrl: NonEmptyTokenZ.default("http://127.0.0.1:1234/v1"),
  model: NonEmptyTokenZ,
  apiKey: NonEmptyTokenZ.optional(), // LM Studio accepts any value but the field is required for some clients.
});
export type LocalLmStudioProviderConfig = z.infer<typeof LocalLmStudioProviderConfigZ>;

export const GenericAcpProviderConfigZ = z.object({
  kind: z.literal("generic-acp"),
  /** Path to the ACP-speaking binary. */
  binary: NonEmptyTokenZ,
  /** Extra args appended to the binary on spawn. */
  args: z.array(NonEmptyTokenZ).default([]),
});
export type GenericAcpProviderConfig = z.infer<typeof GenericAcpProviderConfigZ>;

export const ProviderConfigZ = z.discriminatedUnion("kind", [
  AnthropicProviderConfigZ,
  OpenAIProviderConfigZ,
  LocalOllamaProviderConfigZ,
  LocalLmStudioProviderConfigZ,
  GenericAcpProviderConfigZ,
]);
export type ProviderConfig = z.infer<typeof ProviderConfigZ>;

export const ProviderInstanceZ = z.object({
  id: ProviderInstanceIdZ,
  kind: ProviderKindZ,
  displayName: TrimmedNonEmptyStringZ,
  config: ProviderConfigZ,
  createdAt: IsoDateTimeZ.optional(),
});
export type ProviderInstance = z.infer<typeof ProviderInstanceZ>;

export const ProvidersFileZ = z.object({
  version: z.literal(1),
  providers: z.array(ProviderInstanceZ),
});
export type ProvidersFile = z.infer<typeof ProvidersFileZ>;

export const PROVIDER_KINDS = [
  "anthropic",
  "openai",
  "local-ollama",
  "local-lmstudio",
  "generic-acp",
] as const;

/**
 * Public-facing snapshot — config redacted so secrets never cross the wire.
 * Always send this from the daemon to the dashboard; never `ProviderInstance`.
 */
export const ProviderInstanceSummaryZ = z.object({
  id: ProviderInstanceIdZ,
  kind: ProviderKindZ,
  displayName: TrimmedNonEmptyStringZ,
  model: TrimmedNonEmptyStringZ.optional(),
  baseUrl: TrimmedNonEmptyStringZ.optional(),
  hasApiKey: z.boolean(),
  createdAt: IsoDateTimeZ.optional(),
});
export type ProviderInstanceSummary = z.infer<typeof ProviderInstanceSummaryZ>;

/** Per-provider token-usage accounting, attributed per-turn or per-thread. */
export const ProviderTokenUsageZ = z.object({
  providerInstanceId: ProviderInstanceIdZ,
  inputTokens: NonNegativeIntZ.default(0),
  outputTokens: NonNegativeIntZ.default(0),
  totalCostUsd: z.number().nonnegative().optional(),
});
export type ProviderTokenUsage = z.infer<typeof ProviderTokenUsageZ>;

