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
