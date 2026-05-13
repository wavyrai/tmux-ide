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
  send(input: { threadId: string; content: ContentBlock[] }): Promise<{ promptId: string }>;
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
const DEFAULT_TEXT_COALESCE_WINDOW_MS = 30;

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
  ) {
    return makeMessagePipe({
      threadId,
      initialSeq: seq,
      ...(initialUsage ? { initialUsage } : {}),
      store: opts.store,
      busEmit: opts.busEmit,
      persistDebounceMs,
      textCoalesceWindowMs,
      disableCoalescing,
      logger,
    });
  }

  async function spawnCodexLive(threadId: string): Promise<CodexLiveThread> {
    const thread = await opts.store.get(threadId);
    if (!thread) throw new ThreadNotFoundError(threadId);
    if (thread.provider.kind !== "codex") {
      throw new Error(`Expected codex provider on thread ${threadId}`);
    }
    const pipe = makePipeFor(threadId, thread.usage, initialSeq(thread.messages));
    const client = await spawnCodexClient(thread.provider, {
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

  async function spawnAcpLive(threadId: string): Promise<AcpLiveThread> {
    const thread = await opts.store.get(threadId);
    if (!thread) throw new ThreadNotFoundError(threadId);
    const pipe = makePipeFor(threadId, thread.usage, initialSeq(thread.messages));
    const client = await opts.spawnClient(thread.provider, { cwd: thread.projectDir });
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

  async function ensureLive(threadId: string): Promise<LiveThread> {
    const existing = live.get(threadId);
    if (existing) return existing;
    const existingStart = starting.get(threadId);
    if (existingStart) return existingStart;
    const start = (async () => {
      const thread = await opts.store.get(threadId);
      if (!thread) throw new ThreadNotFoundError(threadId);
      return thread.provider.kind === "codex" ? spawnCodexLive(threadId) : spawnAcpLive(threadId);
    })();
    starting.set(threadId, start);
    try {
      return await start;
    } finally {
      starting.delete(threadId);
    }
  }

  return {
    async send(input) {
      const liveThread = await ensureLive(input.threadId);
      const promptId = randomUUID();
      await opts.store.appendMessage(input.threadId, {
        _tag: "UserPrompt",
        id: promptId,
        createdAt: new Date().toISOString(),
        content: input.content,
      });
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
      const liveThread = live.get(threadId);
      if (!liveThread) return;
      permissions.cancelForThread(threadId);
      await liveThread.pipe.forceFlush();
      live.delete(threadId);
      for (const unsub of liveThread.unsubs.splice(0)) {
        try {
          unsub();
        } catch {
          // best effort
        }
      }
      await liveThread.client.close().catch(() => undefined);
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
