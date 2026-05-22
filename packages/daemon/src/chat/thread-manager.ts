// Thin facade composing message-pipe + permission-coordinator + ACP/Codex
// client lifecycle. Per-event logic lives in focused modules
// (message-pipe.ts, codex-event-handler.ts, permission-coordinator.ts).

import { randomUUID } from "node:crypto";
import type {
  AcpClient,
  AgentProvider,
  ContentBlock,
  RequestPermissionRequest,
  StopReason,
} from "../acp/index.ts";
import { spawnCodexClient as defaultSpawnCodexClient, type CodexClient } from "../codex/index.ts";
import { createCodexDebugLogger, type CodexDebugLogger } from "../codex/debug-log.ts";
import type { Session, SessionRole } from "@tmux-ide/contracts";
import type { ChatEvent, ChatThreadUsageSummary, ThreadMessage } from "./types.ts";
import type { ThreadStore } from "./thread-store.ts";
import { makeSessionStore, type SessionStore } from "./session-store.ts";
import { extractUsagePatch } from "./usage-extraction.ts";
import {
  codexApplyPatchResponseFromPermission,
  codexApplyPatchToPermission,
} from "./codex-helpers.ts";
import { handleCodexAgentEvent } from "./codex-event-handler.ts";
import {
  InvalidPermissionOptionError,
  PermissionRequestNotFoundError,
} from "./permission-helpers.ts";
import { makePermissionCoordinator, type PermissionCoordinator } from "./permission-coordinator.ts";
import { makeMessagePipe, type MessagePipe } from "./message-pipe.ts";
import {
  dispatchAcpPrompt,
  dispatchCodexPrompt,
  type CodexActivePrompt,
} from "./dispatch-prompt.ts";
import type { ProviderStore } from "./provider-store.ts";
import type { ProviderInstance } from "@tmux-ide/contracts";
import { MODEL_SLUG_ALIASES_BY_KIND } from "./provider-discovery.ts";

/** Per-turn option selection mirror of the contract's
 *  `ProviderOptionSelectionZ`. Only string + boolean values are
 *  recognized today. */
export interface ProviderOptionSelection {
  id: string;
  value: string | boolean;
}

/** Pull the canonical effort/fastMode pair out of a t3-shaped
 *  `Array<{id, value}>`. Unknown ids are ignored. */
function extractKnownOptions(options: ReadonlyArray<ProviderOptionSelection> | undefined): {
  reasoningEffort?: string;
  fastMode?: boolean;
} {
  if (!options) return {};
  const out: { reasoningEffort?: string; fastMode?: boolean } = {};
  for (const sel of options) {
    if (sel.id === "reasoningEffort" && typeof sel.value === "string") {
      out.reasoningEffort = sel.value;
    } else if (sel.id === "fastMode" && typeof sel.value === "boolean") {
      out.fastMode = sel.value;
    }
  }
  return out;
}

/** Server-side normalisation: a stale client or a CLI default may
 *  request a renamed slug. The daemon maps to the canonical one
 *  silently so dispatch still hits a known model. */
function aliasModelSlug(kind: "claude-code" | "codex" | "gemini" | "custom", slug: string): string {
  if (kind !== "claude-code" && kind !== "codex") return slug;
  return MODEL_SLUG_ALIASES_BY_KIND[kind]?.[slug] ?? slug;
}

export { InvalidPermissionOptionError, PermissionRequestNotFoundError };

export interface CreateSessionInput {
  threadId: string;
  provider: AgentProvider;
  role?: SessionRole;
  displayName?: string;
  /** Override the auto-generated session id (mainly for tests). */
  id?: string;
  providerInstanceId?: string;
}

export interface ThreadManager {
  send(input: {
    threadId: string;
    content: ContentBlock[];
    /**
     * Per-turn model override (superset pattern, see
     * docs/learn-from-superset.md §2). Applied to the thread's
     * provider record BEFORE the live client is spawned, so a fresh
     * session is bound to the new model. When the live client is
     * already up under a different model, it is torn down so the next
     * send re-spawns with the new selection. Omit to use whatever
     * model is currently persisted on the thread.
     */
    model?: string;
    /**
     * Per-turn driver kind override (Step 3b). When supplied, the
     * daemon dispatches THIS turn through this kind regardless of
     * `thread.provider.kind`. A live client bound to a different
     * kind is disposed and respawned. The persisted thread.provider
     * is NOT mutated here — that's the host's fire-and-forget
     * `chat.thread.setProvider` responsibility.
     */
    providerKind?: "claude-code" | "codex" | "gemini" | "custom";
    /**
     * Per-turn provider options (Codex reasoning effort + fast-mode).
     * Canonical t3 array shape — see
     * `packages/contracts/src/actions-contract.ts`
     * `ProviderOptionSelectionZ`. The daemon remembers the last set per
     * thread so a subsequent send that omits `providerOptions`
     * inherits the previous selection.
     */
    providerOptions?: ReadonlyArray<ProviderOptionSelection>;
  }): Promise<{ promptId: string }>;
  cancel(input: { threadId: string }): Promise<void>;
  respondPermission(input: {
    threadId: string;
    requestId: string;
    optionId: string;
  }): Promise<{ responded: true }>;
  /**
   * Mark the thread as reverted to a checkpoint. Emits
   * `chat.thread.reverted`. The git mechanism that actually rewinds the
   * working tree lives in checkpoint-engine (T073/T075); this method
   * exists so the dashboard sees the broadcast immediately after the
   * engine finishes.
   */
  revert(input: { threadId: string; toCheckpointRef: string }): Promise<void>;
  /**
   * Multi-agent (T078): register a new Session on a Thread. A Thread can
   * host any number of concurrent Sessions; each has its own provider,
   * runtimeMode, activeTurnId, and (optionally) role. Returns the
   * registered Session record. Emits `chat.session.added`.
   */
  createSession(input: CreateSessionInput): Session;
  /** Multi-agent (T078): drop a Session and emit `chat.session.removed`. */
  removeSession(input: { threadId: string; sessionId: string }): Session | null;
  /** Multi-agent (T078): read-only view of all sessions on a Thread. */
  listSessions(threadId: string): Session[];
  /**
   * Tear down the live ACP/Codex client for a thread so the next
   * `send` re-spawns. No-op when the thread has no live session.
   * Used by `chat.thread.setProvider` after the store flips the
   * provider — the existing client is bound to the old provider and
   * must not be reused.
   */
  disposeLive(threadId: string): Promise<void>;
  /**
   * T080: Resolve the ProviderInstance that backs a Thread. Returns `null`
   * when the thread predates the migration (no `providerInstanceId`) or the
   * referenced provider has been removed from the store. The shape returned
   * is the full `ProviderInstance` — caller is responsible for redacting
   * secrets before it crosses the wire.
   */
  getResolvedProvider(threadId: string): Promise<ProviderInstance | null>;
  shutdown(): Promise<void>;
}

export interface MakeThreadManagerOptions {
  store: ThreadStore;
  spawnClient: (provider: AgentProvider, opts: { cwd?: string }) => Promise<AcpClient>;
  spawnCodexClient?: (
    provider: { kind: "codex"; binary?: string },
    opts: { cwd?: string; logger?: CodexDebugLogger },
  ) => Promise<CodexClient>;
  busEmit: (event: ChatEvent) => void;
  /** Optional injection point (tests); defaults to a fresh in-memory store. */
  sessionStore?: SessionStore;
  /**
   * T080: Optional `ProviderStore` used to resolve a `ProviderInstance`
   * from a thread's `providerInstanceId`. When omitted, `getResolvedProvider`
   * always returns `null` — back-compat for callers that haven't migrated.
   */
  providerStore?: ProviderStore;
  permissionTimeoutMs?: number;
  persistDebounceMs?: number;
  textCoalesceWindowMs?: number;
  disableCoalescing?: boolean;
  logger?: (event: { level: "info" | "warn" | "error"; msg: string; data?: unknown }) => void;
}

interface LiveThreadBase {
  pipe: MessagePipe;
  unsubs: Array<() => void>;
}

interface AcpLiveThread extends LiveThreadBase {
  kind: "acp";
  client: AcpClient;
  sessionId: string;
}

interface CodexLiveThread extends LiveThreadBase {
  kind: "codex";
  client: CodexClient;
  threadId: string;
  activePrompt: CodexActivePrompt | null;
}

type LiveThread = AcpLiveThread | CodexLiveThread;

const DEFAULT_PERMISSION_TIMEOUT_MS = 60_000;
const DEFAULT_PERSIST_DEBOUNCE_MS = 750;
// ~1 animation frame. The client used to need a wide window to
// amortize its O(N) per-token rebuild; the persistent rowStore +
// incremental reducer removed that cost, so tighten the window to
// near-frame latency for token-by-token streaming.
const DEFAULT_TEXT_COALESCE_WINDOW_MS = 16;

export class ThreadNotFoundError extends Error {
  readonly threadId: string;

  constructor(threadId: string) {
    super(`Thread ${threadId} not found`);
    this.name = "ThreadNotFoundError";
    this.threadId = threadId;
  }
}

function initialSeq(messages: ThreadMessage[]): number {
  return messages.filter((msg) => msg._tag === "AgentUpdate").length;
}

function resolveCodexPrompt(
  liveThread: CodexLiveThread,
  stopReason: StopReason,
  turnId?: string,
): void {
  const active = liveThread.activePrompt;
  if (!active) return;
  if (turnId && active.turnId && active.turnId !== turnId) return;
  liveThread.activePrompt = null;
  active.resolve(stopReason);
}

export function makeThreadManager(opts: MakeThreadManagerOptions): ThreadManager {
  const live = new Map<string, LiveThread>();
  const starting = new Map<string, Promise<LiveThread>>();
  /**
   * Per-thread last-used provider options. Daemon-lifetime only —
   * deliberately not persisted across daemon restarts so an
   * inadvertently-set xhigh effort doesn't outlive the session.
   * Cleared on `disposeLive` so a re-spawned thread starts from the
   * model's `defaultReasoningEffort` again.
   */
  const lastProviderOptions = new Map<string, ProviderOptionSelection[]>();
  const logger = opts.logger ?? (() => undefined);
  const permissionTimeoutMs = opts.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
  const persistDebounceMs = opts.persistDebounceMs ?? DEFAULT_PERSIST_DEBOUNCE_MS;
  const textCoalesceWindowMs = opts.textCoalesceWindowMs ?? DEFAULT_TEXT_COALESCE_WINDOW_MS;
  const disableCoalescing = opts.disableCoalescing ?? false;
  const spawnCodexClient =
    opts.spawnCodexClient ??
    ((
      provider: { kind: "codex"; binary?: string },
      spawnOpts: { cwd?: string; logger?: CodexDebugLogger },
    ) => defaultSpawnCodexClient({ provider, cwd: spawnOpts.cwd, logger: spawnOpts.logger }));

  // Multi-agent (T078): one in-memory record per Session on each Thread.
  const sessionStore: SessionStore =
    opts.sessionStore ??
    makeSessionStore({
      emit: (event) => opts.busEmit(event),
    });

  const permissions: PermissionCoordinator = makePermissionCoordinator({
    busEmit: opts.busEmit,
    permissionTimeoutMs,
    beforeEmit: async (threadId) => {
      const liveThread = live.get(threadId);
      if (liveThread) await liveThread.pipe.forceFlush();
    },
  });

  function makePipeFor(
    threadId: string,
    initialUsage: ChatThreadUsageSummary | undefined,
    seq: number,
    initialMessages: ThreadMessage[],
  ) {
    return makeMessagePipe({
      threadId,
      initialSeq: seq,
      ...(initialUsage ? { initialUsage } : {}),
      initialMessages,
      store: opts.store,
      busEmit: opts.busEmit,
      persistDebounceMs,
      textCoalesceWindowMs,
      disableCoalescing,
      logger,
    });
  }

  async function spawnCodexLive(
    threadId: string,
    effectiveProvider?: AgentProvider,
  ): Promise<CodexLiveThread> {
    const thread = await opts.store.get(threadId);
    if (!thread) throw new ThreadNotFoundError(threadId);
    const provider = effectiveProvider ?? thread.provider;
    if (provider.kind !== "codex") {
      throw new Error(`Expected codex provider on thread ${threadId}`);
    }
    const pipe = makePipeFor(threadId, thread.usage, initialSeq(thread.messages), thread.messages);
    const client = await spawnCodexClient(provider, {
      cwd: thread.projectDir,
      logger: createCodexDebugLogger(threadId),
    });
    await client.initialize();
    const liveThread: CodexLiveThread = {
      kind: "codex",
      client,
      threadId,
      pipe,
      unsubs: [],
      activePrompt: null,
    };
    liveThread.unsubs.push(
      client.onAgentEvent((event) =>
        handleCodexAgentEvent(event, {
          sessionId: liveThread.threadId,
          emitUpdate: (update) => pipe.emit(update),
          recordUsage: (patch) => pipe.recordUsage(patch),
          resolveActivePrompt: (stopReason, turnId) =>
            resolveCodexPrompt(liveThread, stopReason, turnId),
        }),
      ),
    );
    liveThread.unsubs.push(
      client.onApplyPatchApproval(async (req) =>
        codexApplyPatchResponseFromPermission(
          await permissions.request(
            threadId,
            codexApplyPatchToPermission(liveThread.threadId, req),
          ),
        ),
      ),
    );
    liveThread.unsubs.push(
      client.onChatgptTokenRefresh(async (req) => {
        logger({
          level: "warn",
          msg: "Codex ChatGPT token refresh requested but auth refresh is not implemented",
          data: { threadId, previousAccountId: req.previousAccountId ?? null },
        });
        return { accessToken: "", chatgptAccountId: "", chatgptPlanType: null };
      }),
    );
    live.set(threadId, liveThread);
    try {
      const conversation = await client.newConversation({
        cwd: thread.projectDir ?? process.cwd(),
        ...(provider.model ? { model: provider.model } : {}),
      });
      liveThread.threadId = conversation.thread.id;
      return liveThread;
    } catch (err) {
      live.delete(threadId);
      for (const unsub of liveThread.unsubs.splice(0)) unsub();
      await client.close().catch(() => undefined);
      throw err;
    }
  }

  async function spawnAcpLive(
    threadId: string,
    effectiveProvider?: AgentProvider,
  ): Promise<AcpLiveThread> {
    const thread = await opts.store.get(threadId);
    if (!thread) throw new ThreadNotFoundError(threadId);
    const provider = effectiveProvider ?? thread.provider;
    const pipe = makePipeFor(threadId, thread.usage, initialSeq(thread.messages), thread.messages);
    const client = await opts.spawnClient(provider, { cwd: thread.projectDir });
    await client.initialize();
    const session = await client.newSession({
      cwd: thread.projectDir ?? process.cwd(),
      mcpServers: [],
    });
    await opts.store.recordAcpSessionId(threadId, session.sessionId);
    const liveThread: AcpLiveThread = {
      kind: "acp",
      client,
      sessionId: session.sessionId,
      pipe,
      unsubs: [],
    };
    liveThread.unsubs.push(
      client.onSessionUpdate((n) => {
        pipe.recordUsage(extractUsagePatch(n.update));
        pipe.emit(n.update);
      }),
    );
    liveThread.unsubs.push(
      client.onPermissionRequest((req: RequestPermissionRequest) =>
        permissions.request(threadId, req),
      ),
    );
    live.set(threadId, liveThread);
    return liveThread;
  }

  async function disposeLiveImmediate(threadId: string): Promise<void> {
    const existing = live.get(threadId);
    if (!existing) return;
    permissions.cancelForThread(threadId);
    await existing.pipe.forceFlush();
    live.delete(threadId);
    lastProviderOptions.delete(threadId);
    for (const unsub of existing.unsubs.splice(0)) {
      try {
        unsub();
      } catch {
        // best effort
      }
    }
    await existing.client.close().catch(() => undefined);
  }

  async function ensureLive(
    threadId: string,
    effectiveProvider?: AgentProvider,
  ): Promise<LiveThread> {
    // Resolve the per-turn target kind. Step 3b: this may differ from
    // thread.provider.kind — the client owns the visible provider and
    // routes turns through whichever kind the user picked, without
    // mutating the persisted thread.provider on the send path.
    let target = effectiveProvider;
    if (!target) {
      const thread = await opts.store.get(threadId);
      if (!thread) throw new ThreadNotFoundError(threadId);
      target = thread.provider;
    }
    const targetIsCodex = target.kind === "codex";

    const existing = live.get(threadId);
    if (existing) {
      const existingIsCodex = existing.kind === "codex";
      if (existingIsCodex === targetIsCodex) return existing;
      // Kind override mismatches the running client — tear it down so
      // we respawn under the new kind. Any in-flight permission /
      // pipe state is flushed first.
      await disposeLiveImmediate(threadId);
    }

    const existingStart = starting.get(threadId);
    if (existingStart) return existingStart;
    const start = (async () =>
      targetIsCodex ? spawnCodexLive(threadId, target) : spawnAcpLive(threadId, target))();
    starting.set(threadId, start);
    try {
      return await start;
    } finally {
      starting.delete(threadId);
    }
  }

  return {
    async send(input) {
      const stored = await opts.store.get(input.threadId);
      if (!stored) throw new ThreadNotFoundError(input.threadId);

      // Compute the per-turn effective provider (Step 3b — t3-mirror):
      //   - `providerKind` override → route through that kind for THIS
      //     turn, regardless of thread.provider.kind. Persistence is
      //     the client's fire-and-forget responsibility (see
      //     `chat.thread.setProvider`).
      //   - `model` override → route this turn with that model, AND
      //     lazily persist on the matching-kind path so a reload uses
      //     it as the default (kept from Step 3).
      const overrideKind = input.providerKind;
      const persistedKind = stored.provider.kind;
      const sameKind = !overrideKind || overrideKind === persistedKind;

      // Server-side slug normalisation (CODEX-FULL #4 / t3
      // `MODEL_SLUG_ALIASES_BY_PROVIDER`). A stale client or a CLI
      // default may pass a renamed slug — alias to the canonical one
      // so dispatch hits a known model. Applied only when both kind +
      // slug are present so we don't mis-alias the `claude-code`
      // selection through the codex table.
      const aliasKind = overrideKind ?? persistedKind;
      const normalizedInputModel = input.model ? aliasModelSlug(aliasKind, input.model) : undefined;

      // Lazy model persistence — only when we're acting on the
      // persisted-kind side. A kind override is treated as
      // visible-only (per Step 3b design) and does NOT mutate
      // thread.provider here.
      if (normalizedInputModel && sameKind && stored.provider.model !== normalizedInputModel) {
        await opts.store.setProvider(input.threadId, {
          ...stored.provider,
          model: normalizedInputModel,
        });
      }

      // Refreshed thread (post any setProvider).
      const thread = (await opts.store.get(input.threadId)) ?? stored;
      const effectiveKind = overrideKind ?? thread.provider.kind;
      const effectiveModel = normalizedInputModel ?? thread.provider.model;

      const effectiveProvider: AgentProvider =
        effectiveKind === thread.provider.kind
          ? { ...thread.provider, ...(effectiveModel ? { model: effectiveModel } : {}) }
          : effectiveKind === "custom"
            ? thread.provider // kind=custom override has no shape to synthesize → fall back
            : { kind: effectiveKind, ...(effectiveModel ? { model: effectiveModel } : {}) };

      const liveThread = await ensureLive(input.threadId, effectiveProvider);
      const promptId = randomUUID();
      await opts.store.appendMessage(input.threadId, {
        _tag: "UserPrompt",
        id: promptId,
        createdAt: new Date().toISOString(),
        content: input.content,
      });
      // Re-materialize from the authoritative (post-append, possibly
      // post-truncation) log and open this prompt as the live turn.
      // Broadcasts `chat.timeline.reset` so the client shows the user
      // row immediately; agent chunks stream in incrementally after.
      const persisted = await opts.store.get(input.threadId);
      // Per-turn dispatch model = the effective model we just resolved
      // (input.model wins; otherwise persisted thread.provider.model).
      const dispatchModel = effectiveModel;

      // Per-turn provider options resolve as: explicit input wins,
      // otherwise the in-memory last-used carry-over. When neither
      // exists we forward nothing and Codex applies the model's own
      // `defaultReasoningEffort`. Save the explicit selection back so
      // the next omit-args send inherits it.
      const effectiveOptions: ReadonlyArray<ProviderOptionSelection> | undefined =
        input.providerOptions ?? lastProviderOptions.get(input.threadId);
      if (input.providerOptions) {
        lastProviderOptions.set(input.threadId, [...input.providerOptions]);
      }
      const known = extractKnownOptions(effectiveOptions);

      liveThread.pipe.resyncTimeline(persisted?.messages ?? [], promptId);
      if (liveThread.kind === "codex") {
        void dispatchCodexPrompt({
          threadId: input.threadId,
          codexThreadId: liveThread.threadId,
          pipe: liveThread.pipe,
          client: liveThread.client,
          busEmit: opts.busEmit,
          store: opts.store,
          logger,
          bindActivePrompt: (active) => {
            liveThread.activePrompt = active;
          },
          readActivePrompt: () => liveThread.activePrompt,
          promptId,
          content: input.content,
          ...(dispatchModel ? { model: dispatchModel } : {}),
          ...(known.reasoningEffort ? { reasoningEffort: known.reasoningEffort } : {}),
          ...(known.fastMode ? { fastMode: known.fastMode } : {}),
        });
      } else {
        void dispatchAcpPrompt({
          threadId: input.threadId,
          sessionId: liveThread.sessionId,
          pipe: liveThread.pipe,
          client: liveThread.client,
          busEmit: opts.busEmit,
          store: opts.store,
          logger,
          ...(dispatchModel ? { model: dispatchModel } : {}),
          ...(known.reasoningEffort ? { reasoningEffort: known.reasoningEffort } : {}),
          ...(known.fastMode ? { fastMode: known.fastMode } : {}),
          promptId,
          content: input.content,
        });
      }
      return { promptId };
    },
    async cancel(input) {
      permissions.cancelForThread(input.threadId);
      const liveThread = live.get(input.threadId);
      if (!liveThread) return;
      await liveThread.pipe.forceFlush();
      if (liveThread.kind === "codex") {
        const turnId = liveThread.activePrompt?.turnId;
        if (turnId) {
          await liveThread.client.interrupt({ threadId: liveThread.threadId, turnId });
        }
        resolveCodexPrompt(liveThread, "cancelled");
        return;
      }
      await liveThread.client.cancel({ sessionId: liveThread.sessionId });
    },
    async respondPermission(input) {
      if (!permissions.isKnown(input.threadId, input.requestId)) {
        throw new PermissionRequestNotFoundError(input.threadId, input.requestId);
      }
      const thread = await opts.store.get(input.threadId);
      if (!thread) throw new ThreadNotFoundError(input.threadId);
      permissions.respond(input.threadId, input.requestId, input.optionId);
      return { responded: true };
    },
    async revert(input) {
      opts.busEmit({
        type: "chat.thread.reverted",
        threadId: input.threadId,
        toCheckpointRef: input.toCheckpointRef,
      });
    },
    createSession(input) {
      return sessionStore.add({
        threadId: input.threadId,
        ...(input.id ? { id: input.id } : {}),
        providerName: input.provider.kind,
        ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
        ...(input.role ? { role: input.role } : {}),
        ...(input.displayName ? { displayName: input.displayName } : {}),
        status: "idle",
      });
    },
    removeSession(input) {
      return sessionStore.remove(input.threadId, input.sessionId);
    },
    listSessions(threadId) {
      return sessionStore.list(threadId);
    },
    async getResolvedProvider(threadId) {
      if (!opts.providerStore) return null;
      const thread = await opts.store.get(threadId);
      if (!thread) return null;
      const instanceId = thread.providerInstanceId;
      // Fall back to the first session's providerInstanceId (multi-agent
      // threads carry the reference on the Session, not the Thread root).
      const sessionInstanceId = instanceId
        ? null
        : (sessionStore.list(threadId).find((s) => s.providerInstanceId)?.providerInstanceId ??
          null);
      const id = instanceId ?? sessionInstanceId;
      if (!id) return null;
      return opts.providerStore.get(id);
    },
    async disposeLive(threadId) {
      await disposeLiveImmediate(threadId);
    },
    async shutdown() {
      const closing = [...live.entries()].map(async ([threadId, liveThread]) => {
        permissions.cancelForThread(threadId);
        await liveThread.pipe.forceFlush();
        live.delete(threadId);
        for (const unsub of liveThread.unsubs.splice(0)) {
          try {
            unsub();
          } catch {
            // best effort during daemon shutdown
          }
        }
        await liveThread.client.close();
      });
      await Promise.allSettled(closing);
      permissions.cancelAll();
    },
  };
}
