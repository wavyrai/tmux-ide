/**
 * Hermetic stub ACP provider for the chat e2e harness.
 *
 * This is a fake ACP-shaped agent: it speaks the exact `AcpClient`
 * interface the real `spawnAcpClient` returns, but emits a *scripted,
 * test-driven* sequence of `SessionUpdate`s instead of spawning the
 * claude-code / codex binary. No child process, no auth, no network —
 * only the model inference is replaced. Everything downstream
 * (message-pipe coalescing, server-side `ThreadTimeline`
 * materialization, `broadcastChatEvent` → `/ws/events`) is the real
 * production path.
 *
 * Driving model — fully manual so tests stay deterministic with zero
 * real timers:
 *
 *   const stub = new ScriptedAcpClient();
 *   // ... wire into makeThreadManager({ spawnClient: async () => stub })
 *   await manager.send(...);          // triggers stub.prompt()
 *   await stub.awaitPrompt();         // dispatcher has called prompt()
 *   stub.emit(textChunk("Hello "));   // stream a chunk
 *   stub.emit(textChunk("world"));
 *   stub.emit(toolCall(...));
 *   stub.finishPrompt("end_turn");    // resolves prompt() → chat.thread.stop
 */

import type {
  AcpClient,
  CancelNotification,
  InitializeResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SessionUpdate,
  StopReason,
} from "../../acp/index.ts";
import type {
  CodexAgentEvent,
  CodexClient,
  CodexInitializeResponse,
  InterruptRequest,
  NewConversationRequest,
  NewConversationResponse,
  SendUserMessageRequest,
  SendUserMessageResponse,
} from "../../codex/index.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** ACP `agent_message_chunk` carrying a single text block. */
export function textChunk(text: string, messageId?: string): SessionUpdate {
  return {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
    ...(messageId ? { messageId } : {}),
  } as SessionUpdate;
}

/** ACP `agent_thought_chunk` (server folds into `thoughtText`). */
export function thoughtChunk(text: string): SessionUpdate {
  return {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text },
  } as SessionUpdate;
}

/** ACP `tool_call` (server folds into the assistant row's `toolCalls`). */
export function toolCall(input: {
  toolCallId: string;
  title: string;
  kind?: string;
  status?: "pending" | "in_progress" | "completed" | "failed";
}): SessionUpdate {
  return {
    sessionUpdate: "tool_call",
    toolCallId: input.toolCallId,
    title: input.title,
    ...(input.kind ? { kind: input.kind } : {}),
    status: input.status ?? "completed",
    content: [],
  } as SessionUpdate;
}

export class ScriptedAcpClient implements AcpClient {
  readonly closed = Promise.resolve({ code: 0 as const, signal: null });
  readonly sessionId: string;

  private updateHandler: ((n: SessionNotification) => void) | null = null;
  private activePrompt: Deferred<PromptResponse> | null = null;
  private promptInvoked = deferred<void>();

  readonly promptRequests: PromptRequest[] = [];
  cancelCount = 0;
  closeCount = 0;

  constructor(sessionId = "stub-session-1") {
    this.sessionId = sessionId;
  }

  async initialize(): Promise<InitializeResponse> {
    return { protocolVersion: 1 };
  }

  async newSession(_req: NewSessionRequest): Promise<NewSessionResponse> {
    return { sessionId: this.sessionId };
  }

  async loadSession(_req: LoadSessionRequest): Promise<LoadSessionResponse> {
    return {};
  }

  onSessionUpdate(handler: (n: SessionNotification) => void): () => void {
    this.updateHandler = handler;
    return () => {
      if (this.updateHandler === handler) this.updateHandler = null;
    };
  }

  onPermissionRequest(
    _h: (req: RequestPermissionRequest) => Promise<RequestPermissionResponse>,
  ): () => void {
    return () => {};
  }

  /** Push one ACP session update into the live pipe (synchronous). */
  emit(update: SessionUpdate): void {
    if (!this.updateHandler) {
      throw new Error("ScriptedAcpClient.emit() before onSessionUpdate was wired");
    }
    this.updateHandler({ sessionId: this.sessionId, update });
  }

  prompt(req: PromptRequest): Promise<PromptResponse> {
    this.promptRequests.push(req);
    this.activePrompt = deferred<PromptResponse>();
    this.promptInvoked.resolve();
    return this.activePrompt.promise;
  }

  /**
   * Step 3 gate: which model the daemon applied to this turn. The
   * daemon surfaces the per-turn model via `PromptRequest._meta.model`
   * (real claude-code-acp ignores unknown `_meta` keys; this is the
   * faithful channel that proves the daemon honored the picker).
   */
  get lastDispatchedModel(): string | null {
    const last = this.promptRequests.at(-1);
    if (!last) return null;
    const meta = last._meta as { model?: unknown } | null | undefined;
    return typeof meta?.model === "string" ? meta.model : null;
  }

  /** CODEX-FULL gate: per-turn reasoning-effort the daemon forwarded
   *  through the ACP `_meta` channel. Null when none was applied. */
  get lastDispatchedReasoningEffort(): string | null {
    const last = this.promptRequests.at(-1);
    if (!last) return null;
    const meta = last._meta as { reasoningEffort?: unknown } | null | undefined;
    return typeof meta?.reasoningEffort === "string" ? meta.reasoningEffort : null;
  }

  /** CODEX-FULL gate: per-turn fast-mode flag forwarded on `_meta`. */
  get lastDispatchedFastMode(): boolean {
    const last = this.promptRequests.at(-1);
    if (!last) return false;
    const meta = last._meta as { fastMode?: unknown } | null | undefined;
    return meta?.fastMode === true;
  }

  /** Resolves once the dispatcher has actually called `prompt()`. */
  awaitPrompt(): Promise<void> {
    return this.promptInvoked.promise;
  }

  /** Resolve the in-flight `prompt()` — drives `chat.thread.stop`. */
  finishPrompt(stopReason: StopReason = "end_turn"): void {
    if (!this.activePrompt) throw new Error("finishPrompt() with no active prompt");
    const pending = this.activePrompt;
    this.activePrompt = null;
    this.promptInvoked = deferred<void>();
    pending.resolve({ stopReason });
  }

  async cancel(_n: CancelNotification): Promise<void> {
    this.cancelCount += 1;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

/**
 * Hermetic Codex client stub mirroring `ScriptedAcpClient`. Drives
 * the Codex dispatch path (`sendUserMessage` + `onAgentEvent`) so the
 * Step 3b harness can assert the daemon spawned codex for a turn
 * whose `provider.kind` override differs from the thread's persisted
 * provider.
 */
export class ScriptedCodexClient implements CodexClient {
  readonly closed = Promise.resolve({ code: 0 as const, signal: null });
  readonly codexThreadId: string;

  private agentEventHandlers = new Set<(event: CodexAgentEvent) => void>();
  readonly sentMessages: SendUserMessageRequest[] = [];
  readonly newConversations: NewConversationRequest[] = [];
  closeCount = 0;
  interruptCount = 0;

  constructor(codexThreadId = "stub-codex-thread-1") {
    this.codexThreadId = codexThreadId;
  }

  async initialize(): Promise<CodexInitializeResponse> {
    return {
      codexHome: "/tmp/stub-codex",
      platformFamily: "stub",
      platformOs: "stub",
      userAgent: "stub-codex-client/0.0.0",
    };
  }

  async newConversation(req: NewConversationRequest): Promise<NewConversationResponse> {
    this.newConversations.push(req);
    return {
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      cwd: req.cwd ?? "/tmp",
      model: req.model ?? "gpt-5-codex",
      modelProvider: req.modelProvider ?? "openai",
      sandbox: "workspace-write",
      thread: { id: this.codexThreadId },
    };
  }

  async sendUserMessage(req: SendUserMessageRequest): Promise<SendUserMessageResponse> {
    this.sentMessages.push(req);
    const turnId = `stub-turn-${this.sentMessages.length}`;
    // Fire-and-forget a terminal completion so the dispatcher resolves
    // and the harness can observe `chat.thread.stop`. The shape mirrors
    // codex's real `turn/completed` notification — see
    // packages/daemon/src/chat/codex-event-handler.ts.
    queueMicrotask(() => {
      const event: CodexAgentEvent = {
        method: "turn/completed",
        params: {
          threadId: this.codexThreadId,
          turn: { id: turnId, status: "completed" },
        },
      } as CodexAgentEvent;
      for (const handler of this.agentEventHandlers) handler(event);
    });
    return { turn: { id: turnId, status: "completed" } };
  }

  async interrupt(_req: InterruptRequest): Promise<void> {
    this.interruptCount += 1;
  }

  onAgentEvent(handler: (event: CodexAgentEvent) => void): () => void {
    this.agentEventHandlers.add(handler);
    return () => this.agentEventHandlers.delete(handler);
  }

  onApplyPatchApproval(): () => void {
    return () => {};
  }

  onChatgptTokenRefresh(): () => void {
    return () => {};
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }

  /** Last `{kind, model}` pair the daemon dispatched through Codex. */
  get lastDispatchedModel(): string | null {
    const last = this.sentMessages.at(-1);
    return last?.model ?? null;
  }

  /** CODEX-FULL gate: per-turn reasoning effort forwarded to Codex
   *  as `effort` on `sendUserMessage`. */
  get lastDispatchedEffort(): string | null {
    const last = this.sentMessages.at(-1);
    return last?.effort ?? null;
  }

  /** CODEX-FULL gate: per-turn fast-mode forwarded as `serviceTier:
   *  "fast"` on `sendUserMessage`. */
  get lastDispatchedServiceTier(): string | null {
    const last = this.sentMessages.at(-1);
    return last?.serviceTier ?? null;
  }
}
