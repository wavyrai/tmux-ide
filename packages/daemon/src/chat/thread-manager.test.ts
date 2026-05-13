import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AcpClient,
  AgentProvider,
  CancelNotification,
  ContentBlock,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "../acp/index.ts";
import type {
  ApplyPatchApprovalRequest,
  ApplyPatchApprovalResponse,
  ChatgptAuthTokensRefreshRequest,
  ChatgptAuthTokensRefreshResponse,
  CodexAgentEvent,
  CodexClient,
  CodexInitializeResponse,
  InterruptRequest,
  NewConversationRequest,
  NewConversationResponse,
  SendUserMessageRequest,
  SendUserMessageResponse,
} from "../codex/index.ts";
import { makeThreadManager, PermissionRequestNotFoundError } from "./thread-manager.ts";
import { makeThreadStore, type ThreadStore } from "./thread-store.ts";
import type { ChatEvent, ThreadIndexEntry, ThreadMessage, ThreadState } from "./types.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(err: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(assertion: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (await assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(await assertion()).toBe(true);
}

class FakeAcpClient implements AcpClient {
  readonly closed = Promise.resolve({ code: 0, signal: null });
  readonly promptDeferreds: Array<Deferred<PromptResponse>> = [];
  initializeCalls = 0;
  newSessionRequests: NewSessionRequest[] = [];
  promptRequests: PromptRequest[] = [];
  cancelRequests: CancelNotification[] = [];
  closeCalls = 0;
  private readonly sessionUpdateHandlers = new Set<(n: SessionNotification) => void>();
  private permissionHandler:
    | ((req: RequestPermissionRequest) => Promise<RequestPermissionResponse>)
    | null = null;

  async initialize(): Promise<InitializeResponse> {
    this.initializeCalls += 1;
    return { protocolVersion: 1 };
  }

  async newSession(req: NewSessionRequest): Promise<NewSessionResponse> {
    this.newSessionRequests.push(req);
    return { sessionId: `session-${this.newSessionRequests.length}` };
  }

  async loadSession(): Promise<never> {
    throw new Error("not used");
  }

  prompt(req: PromptRequest): Promise<PromptResponse> {
    this.promptRequests.push(req);
    const next = deferred<PromptResponse>();
    this.promptDeferreds.push(next);
    return next.promise;
  }

  async cancel(notif: CancelNotification): Promise<void> {
    this.cancelRequests.push(notif);
  }

  onSessionUpdate(handler: (n: SessionNotification) => void): () => void {
    this.sessionUpdateHandlers.add(handler);
    return () => this.sessionUpdateHandlers.delete(handler);
  }

  onPermissionRequest(
    handler: (req: RequestPermissionRequest) => Promise<RequestPermissionResponse>,
  ): () => void {
    this.permissionHandler = handler;
    return () => {
      if (this.permissionHandler === handler) this.permissionHandler = null;
    };
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }

  emitUpdate(update: SessionNotification["update"]): void {
    for (const handler of this.sessionUpdateHandlers) {
      handler({ sessionId: "session-1", update });
    }
  }

  requestPermission(req: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (!this.permissionHandler) throw new Error("permission handler missing");
    return this.permissionHandler(req);
  }
}

class FakeCodexClient implements CodexClient {
  readonly closed = Promise.resolve({ code: 0, signal: null });
  initializeCalls = 0;
  newConversationRequests: NewConversationRequest[] = [];
  sendUserMessageRequests: SendUserMessageRequest[] = [];
  interruptRequests: InterruptRequest[] = [];
  closeCalls = 0;
  private readonly agentEventHandlers = new Set<(event: CodexAgentEvent) => void>();
  private applyPatchApprovalHandler:
    | ((req: ApplyPatchApprovalRequest) => Promise<ApplyPatchApprovalResponse>)
    | null = null;
  private tokenRefreshHandler:
    | ((req: ChatgptAuthTokensRefreshRequest) => Promise<ChatgptAuthTokensRefreshResponse>)
    | null = null;

  async initialize(): Promise<CodexInitializeResponse> {
    this.initializeCalls += 1;
    return {
      codexHome: "/tmp/codex-home",
      platformFamily: "unix",
      platformOs: "macos",
      userAgent: "fake-codex",
    };
  }

  async newConversation(req: NewConversationRequest): Promise<NewConversationResponse> {
    this.newConversationRequests.push(req);
    return {
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      cwd: req.cwd ?? "/tmp",
      model: "gpt-5.2",
      modelProvider: "openai",
      sandbox: { mode: "workspace-write" },
      thread: { id: `codex-thread-${this.newConversationRequests.length}` },
    };
  }

  async sendUserMessage(req: SendUserMessageRequest): Promise<SendUserMessageResponse> {
    this.sendUserMessageRequests.push(req);
    return { turn: { id: `turn-${this.sendUserMessageRequests.length}`, status: "inProgress" } };
  }

  async interrupt(req: InterruptRequest): Promise<void> {
    this.interruptRequests.push(req);
  }

  onAgentEvent(handler: (event: CodexAgentEvent) => void): () => void {
    this.agentEventHandlers.add(handler);
    return () => this.agentEventHandlers.delete(handler);
  }

  onApplyPatchApproval(
    handler: (req: ApplyPatchApprovalRequest) => Promise<ApplyPatchApprovalResponse>,
  ): () => void {
    this.applyPatchApprovalHandler = handler;
    return () => {
      if (this.applyPatchApprovalHandler === handler) this.applyPatchApprovalHandler = null;
    };
  }

  onChatgptTokenRefresh(
    handler: (req: ChatgptAuthTokensRefreshRequest) => Promise<ChatgptAuthTokensRefreshResponse>,
  ): () => void {
    this.tokenRefreshHandler = handler;
    return () => {
      if (this.tokenRefreshHandler === handler) this.tokenRefreshHandler = null;
    };
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }

  emitAgentEvent(event: CodexAgentEvent): void {
    for (const handler of this.agentEventHandlers) handler(event);
  }

  requestApplyPatch(req: ApplyPatchApprovalRequest): Promise<ApplyPatchApprovalResponse> {
    if (!this.applyPatchApprovalHandler) throw new Error("apply patch handler missing");
    return this.applyPatchApprovalHandler(req);
  }

  requestTokenRefresh(
    req: ChatgptAuthTokensRefreshRequest,
  ): Promise<ChatgptAuthTokensRefreshResponse> {
    if (!this.tokenRefreshHandler) throw new Error("token refresh handler missing");
    return this.tokenRefreshHandler(req);
  }
}

const provider: AgentProvider = { kind: "claude-code" };
const content: ContentBlock[] = [{ type: "text", text: "hello" }];

let rootDir = "";
let store: ThreadStore;
let events: ChatEvent[];
let clients: FakeAcpClient[];
let codexClients: FakeCodexClient[];

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "tmux-ide-chat-manager-"));
  store = makeThreadStore({ rootDir });
  events = [];
  clients = [];
  codexClients = [];
});

afterEach(async () => {
  clients.forEach((client) =>
    client.promptDeferreds.forEach((next) => next.resolve({ stopReason: "cancelled" })),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  rmSync(rootDir, { recursive: true, force: true });
});

function makeManager(permissionTimeoutMs = 5) {
  return makeThreadManager({
    store,
    permissionTimeoutMs,
    persistDebounceMs: 1,
    textCoalesceWindowMs: 1,
    spawnClient: async () => {
      const client = new FakeAcpClient();
      clients.push(client);
      return client;
    },
    spawnCodexClient: async () => {
      const client = new FakeCodexClient();
      codexClients.push(client);
      return client;
    },
    busEmit: (event) => events.push(event),
  });
}

function textUpdate(text: string): SessionNotification["update"] {
  return {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
    messageId: "msg-1",
  };
}

function permissionRequest(): RequestPermissionRequest {
  return {
    sessionId: "session-1",
    toolCall: {
      toolCallId: "tool-1",
      title: "Edit file",
      kind: "edit",
      status: "pending",
    },
    options: [
      { optionId: "allow_once", name: "Allow", kind: "allow_once" },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" },
    ],
  };
}

async function flushCoalesceWindow(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("makeThreadManager", () => {
  it("spawns and initializes an ACP session on first send", async () => {
    const thread = await store.create({ provider, projectDir: "/tmp/project" });
    const manager = makeManager();

    const result = await manager.send({ threadId: thread.id, content });

    expect(result.promptId).toBeTruthy();
    expect(clients).toHaveLength(1);
    expect(clients[0]?.initializeCalls).toBe(1);
    expect(clients[0]?.newSessionRequests).toEqual([{ cwd: "/tmp/project", mcpServers: [] }]);
    expect(clients[0]?.promptRequests).toEqual([{ sessionId: "session-1", prompt: content }]);
    expect((await store.get(thread.id))?.acpSessionId).toBe("session-1");
    clients[0]?.promptDeferreds[0]?.resolve({ stopReason: "end_turn" });
  });

  it("reuses a live client on subsequent sends", async () => {
    const thread = await store.create({ provider });
    const manager = makeManager();

    await manager.send({ threadId: thread.id, content });
    await manager.send({ threadId: thread.id, content: [{ type: "text", text: "again" }] });

    expect(clients).toHaveLength(1);
    expect(clients[0]?.promptRequests).toHaveLength(2);
    clients[0]?.promptDeferreds.forEach((next) => next.resolve({ stopReason: "end_turn" }));
  });

  it("emits and persists streamed session updates", async () => {
    const thread = await store.create({ provider });
    const manager = makeManager();
    await manager.send({ threadId: thread.id, content });

    clients[0]?.emitUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "answer" },
      messageId: "msg-1",
    });
    await flushCoalesceWindow();

    await waitFor(async () => (await store.get(thread.id))?.messages.length === 2);

    expect(events).toContainEqual({
      type: "chat.thread.update",
      threadId: thread.id,
      seq: 1,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "answer" },
        messageId: "msg-1",
      },
    });
    clients[0]?.promptDeferreds[0]?.resolve({ stopReason: "end_turn" });
  });

  it("coalesces a tight burst of text chunks into one emitted update", async () => {
    const thread = await store.create({ provider });
    const manager = makeManager();
    await manager.send({ threadId: thread.id, content });

    for (let i = 0; i < 100; i += 1) {
      clients[0]?.emitUpdate(textUpdate(String(i % 10)));
    }

    expect(events.filter((event) => event.type === "chat.thread.update")).toHaveLength(0);
    await flushCoalesceWindow();

    const updates = events.filter((event) => event.type === "chat.thread.update");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      type: "chat.thread.update",
      threadId: thread.id,
      seq: 1,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: Array.from({ length: 100 }, (_, i) => String(i % 10)).join(""),
        },
      },
    });
    clients[0]?.promptDeferreds[0]?.resolve({ stopReason: "end_turn" });
  });

  it("flushes pending text before non-text updates and preserves order", async () => {
    const thread = await store.create({ provider });
    const manager = makeManager();
    await manager.send({ threadId: thread.id, content });

    clients[0]?.emitUpdate(textUpdate("a"));
    clients[0]?.emitUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Read package.json",
      status: "pending",
    });
    clients[0]?.emitUpdate(textUpdate("b"));
    await flushCoalesceWindow();

    const updates = events.filter((event) => event.type === "chat.thread.update");
    expect(updates).toHaveLength(3);
    expect(updates.map((event) => event.update.sessionUpdate)).toEqual([
      "agent_message_chunk",
      "tool_call",
      "agent_message_chunk",
    ]);
    expect(updates[0]).toMatchObject({ update: { content: { type: "text", text: "a" } } });
    expect(updates[2]).toMatchObject({ update: { content: { type: "text", text: "b" } } });
    clients[0]?.promptDeferreds[0]?.resolve({ stopReason: "end_turn" });
  });

  it("flushes pending text before emitting stop", async () => {
    const thread = await store.create({ provider });
    const manager = makeManager();
    const { promptId } = await manager.send({ threadId: thread.id, content });

    clients[0]?.emitUpdate(textUpdate("answer"));
    clients[0]?.promptDeferreds[0]?.resolve({ stopReason: "end_turn" });

    await waitFor(() =>
      events.some((event) => event.type === "chat.thread.stop" && event.promptId === promptId),
    );
    const updateIndex = events.findIndex((event) => event.type === "chat.thread.update");
    const stopIndex = events.findIndex((event) => event.type === "chat.thread.stop");
    expect(updateIndex).toBeGreaterThanOrEqual(0);
    expect(stopIndex).toBeGreaterThan(updateIndex);
    expect((await store.get(thread.id))?.messages).toHaveLength(2);
  });

  it("persists a coalesced N-chunk burst with one appendMessages call", async () => {
    const appendCalls: Array<{ id: string; messages: ThreadMessage[] }> = [];
    const state: ThreadState = {
      id: "thread-1",
      title: "New chat",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      provider,
      messages: [],
    };
    const entry: ThreadIndexEntry = {
      id: state.id,
      title: state.title,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      providerKind: "claude-code",
      messageCount: 0,
    };
    const fakeStore: ThreadStore = {
      async list() {
        return [entry];
      },
      async get() {
        return structuredClone(state);
      },
      async create() {
        return structuredClone(state);
      },
      async rename() {
        return entry;
      },
      async setProvider() {
        return entry;
      },
      async delete() {
        return;
      },
      async appendMessage(_id, msg) {
        state.messages.push(msg);
      },
      async appendMessages(id, messages) {
        appendCalls.push({ id, messages });
        state.messages.push(...messages);
      },
      async recordAcpSessionId(_id, acpSessionId) {
        state.acpSessionId = acpSessionId;
      },
      async recordUsage(_id, usage) {
        state.usage = usage;
      },
      async recordStopReason(_id, reason) {
        entry.lastStopReason = reason;
      },
    };
    store = fakeStore;
    const manager = makeManager();
    await manager.send({ threadId: state.id, content });

    for (let i = 0; i < 20; i += 1) clients[0]?.emitUpdate(textUpdate("x"));
    await flushCoalesceWindow();
    await waitFor(() => appendCalls.length === 1);

    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0]?.messages).toHaveLength(1);
    expect(appendCalls[0]?.messages[0]).toMatchObject({
      _tag: "AgentUpdate",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "x".repeat(20) },
      },
    });
    clients[0]?.promptDeferreds[0]?.resolve({ stopReason: "end_turn" });
  });

  it("extracts Anthropic-style ACP usage metadata and emits cumulative usage", async () => {
    const thread = await store.create({ provider });
    const manager = makeManager();
    await manager.send({ threadId: thread.id, content });

    clients[0]?.emitUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "answer" },
      messageId: "msg-1",
      _meta: {
        usage: {
          input_tokens: 120,
          output_tokens: 30,
          cache_read_input_tokens: 8,
          cache_creation_input_tokens: 4,
        },
      },
    });

    await waitFor(() => events.some((event) => event.type === "chat.thread.usage"));

    expect(events.find((event) => event.type === "chat.thread.usage")).toEqual({
      type: "chat.thread.usage",
      threadId: thread.id,
      usage: {
        inputTokens: 120,
        outputTokens: 30,
        cacheReadTokens: 8,
        cacheWriteTokens: 4,
      },
    });
    await waitFor(async () => (await store.get(thread.id))?.usage?.inputTokens === 120);
    clients[0]?.promptDeferreds[0]?.resolve({ stopReason: "end_turn" });
  });

  it("extracts Codex turn completion token usage and emits cumulative usage", async () => {
    const thread = await store.create({ provider: { kind: "codex" } });
    const manager = makeManager();
    await manager.send({ threadId: thread.id, content });

    codexClients[0]?.emitAgentEvent({
      method: "turn/completed",
      params: {
        threadId: "codex-thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          tokenUsage: {
            modelContextWindow: 200_000,
            total: {
              inputTokens: 1000,
              outputTokens: 250,
              cachedInputTokens: 75,
              reasoningOutputTokens: 25,
              totalTokens: 1350,
            },
            last: {
              inputTokens: 1000,
              outputTokens: 250,
              cachedInputTokens: 75,
              reasoningOutputTokens: 25,
              totalTokens: 1350,
            },
          },
        },
      },
    });

    await waitFor(() => events.some((event) => event.type === "chat.thread.usage"));

    expect(events.find((event) => event.type === "chat.thread.usage")).toEqual({
      type: "chat.thread.usage",
      threadId: thread.id,
      usage: {
        inputTokens: 1000,
        outputTokens: 250,
        cacheReadTokens: 75,
        contextWindowMaxTokens: 200_000,
        contextWindowUsedTokens: 1350,
      },
    });
    await waitFor(
      async () => (await store.get(thread.id))?.usage?.contextWindowMaxTokens === 200_000,
    );
  });

  it("emits permission requests and defaults to reject_once after timeout", async () => {
    const thread = await store.create({ provider });
    const manager = makeManager(1);
    await manager.send({ threadId: thread.id, content });

    const response = await clients[0]?.requestPermission(permissionRequest());

    expect(response).toEqual({ outcome: { outcome: "selected", optionId: "reject_once" } });
    expect(events.find((event) => event.type === "chat.permission.request")).toMatchObject({
      type: "chat.permission.request",
      threadId: thread.id,
      toolCall: { toolCallId: "tool-1", title: "Edit file" },
    });
    clients[0]?.promptDeferreds[0]?.resolve({ stopReason: "end_turn" });
  });

  it("resolves a pending permission when respondPermission receives a valid option", async () => {
    const thread = await store.create({ provider });
    const manager = makeManager(1_000);
    await manager.send({ threadId: thread.id, content });

    const responsePromise = clients[0]?.requestPermission(permissionRequest());
    await waitFor(() => events.some((event) => event.type === "chat.permission.request"));
    const requestEvent = events.find((event) => event.type === "chat.permission.request");
    if (requestEvent?.type !== "chat.permission.request") throw new Error("missing request event");

    await expect(
      manager.respondPermission({
        threadId: thread.id,
        requestId: requestEvent.requestId,
        optionId: "allow_once",
      }),
    ).resolves.toEqual({ responded: true });
    await expect(responsePromise).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "allow_once" },
    });
    clients[0]?.promptDeferreds[0]?.resolve({ stopReason: "end_turn" });
  });

  it("throws PermissionRequestNotFoundError for an unknown permission request", async () => {
    const thread = await store.create({ provider });
    const manager = makeManager();

    await expect(
      manager.respondPermission({
        threadId: thread.id,
        requestId: "missing",
        optionId: "allow_once",
      }),
    ).rejects.toBeInstanceOf(PermissionRequestNotFoundError);
  });

  it("throws PermissionRequestNotFoundError after permission timeout", async () => {
    const thread = await store.create({ provider });
    const manager = makeManager(1);
    await manager.send({ threadId: thread.id, content });

    const response = await clients[0]?.requestPermission(permissionRequest());
    const requestEvent = events.find((event) => event.type === "chat.permission.request");
    if (requestEvent?.type !== "chat.permission.request") throw new Error("missing request event");

    expect(response).toEqual({ outcome: { outcome: "selected", optionId: "reject_once" } });
    await expect(
      manager.respondPermission({
        threadId: thread.id,
        requestId: requestEvent.requestId,
        optionId: "allow_once",
      }),
    ).rejects.toBeInstanceOf(PermissionRequestNotFoundError);
    clients[0]?.promptDeferreds[0]?.resolve({ stopReason: "end_turn" });
  });

  it("emits stop and records the stop reason when prompt resolves", async () => {
    const thread = await store.create({ provider });
    const manager = makeManager();
    const { promptId } = await manager.send({ threadId: thread.id, content });

    clients[0]?.promptDeferreds[0]?.resolve({ stopReason: "max_tokens" });

    await waitFor(() =>
      events.some(
        (event) =>
          event.type === "chat.thread.stop" &&
          event.threadId === thread.id &&
          event.promptId === promptId &&
          event.stopReason === "max_tokens",
      ),
    );
    await waitFor(async () => (await store.list())[0]?.lastStopReason === "max_tokens");
  });

  it("sends Codex prompts as text input items", async () => {
    const thread = await store.create({
      provider: { kind: "codex" },
      projectDir: "/tmp/project",
    });
    const manager = makeManager();

    await manager.send({ threadId: thread.id, content });

    expect(codexClients).toHaveLength(1);
    expect(codexClients[0]?.initializeCalls).toBe(1);
    expect(codexClients[0]?.newConversationRequests).toEqual([{ cwd: "/tmp/project" }]);
    expect(codexClients[0]?.sendUserMessageRequests).toEqual([
      {
        threadId: "codex-thread-1",
        input: [{ type: "text", text: "hello" }],
      },
    ]);
  });

  it("translates Codex agent message deltas into ACP-shaped updates", async () => {
    const thread = await store.create({ provider: { kind: "codex" } });
    const manager = makeManager();
    await manager.send({ threadId: thread.id, content });

    codexClients[0]?.emitAgentEvent({
      method: "item/agentMessage/delta",
      params: {
        delta: "answer",
        itemId: "item-1",
        threadId: "codex-thread-1",
        turnId: "turn-1",
      },
    });
    await flushCoalesceWindow();

    expect(events).toContainEqual({
      type: "chat.thread.update",
      threadId: thread.id,
      seq: 1,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "answer" },
        messageId: "item-1",
        _meta: { provider: "codex", threadId: "codex-thread-1", turnId: "turn-1" },
      },
    });
  });

  it("translates Codex applyPatchApproval requests through the permission pipeline", async () => {
    const thread = await store.create({ provider: { kind: "codex" } });
    const manager = makeManager(1_000);
    await manager.send({ threadId: thread.id, content });

    const responsePromise = codexClients[0]?.requestApplyPatch({
      callId: "call-1",
      conversationId: "codex-thread-1",
      fileChanges: {
        "/tmp/app.ts": { type: "add", content: "hello" },
      },
      reason: "Patch app.ts",
    });
    await waitFor(() => events.some((event) => event.type === "chat.permission.request"));
    const requestEvent = events.find((event) => event.type === "chat.permission.request");
    if (requestEvent?.type !== "chat.permission.request") throw new Error("missing request event");

    expect(requestEvent).toMatchObject({
      type: "chat.permission.request",
      threadId: thread.id,
      toolCall: {
        toolCallId: "call-1",
        title: "Patch app.ts",
        kind: "edit",
        status: "pending",
      },
      options: [
        { optionId: "allow_once", kind: "allow_once" },
        { optionId: "allow_always", kind: "allow_always" },
        { optionId: "reject_once", kind: "reject_once" },
      ],
    });

    await manager.respondPermission({
      threadId: thread.id,
      requestId: requestEvent.requestId,
      optionId: "allow_once",
    });
    await expect(responsePromise).resolves.toEqual({ decision: "approved" });
  });

  it("resolves Codex turns on completion and cancel calls interrupt", async () => {
    const thread = await store.create({ provider: { kind: "codex" } });
    const manager = makeManager();
    const { promptId } = await manager.send({ threadId: thread.id, content });

    await manager.cancel({ threadId: thread.id });
    expect(codexClients[0]?.interruptRequests).toEqual([
      { threadId: "codex-thread-1", turnId: "turn-1" },
    ]);

    codexClients[0]?.emitAgentEvent({
      method: "turn/completed",
      params: {
        threadId: "codex-thread-1",
        turn: { id: "turn-1", status: "completed" },
      },
    });

    await waitFor(() =>
      events.some(
        (event) =>
          event.type === "chat.thread.stop" &&
          event.threadId === thread.id &&
          event.promptId === promptId &&
          event.stopReason === "cancelled",
      ),
    );
  });

  it("closes Codex clients on shutdown", async () => {
    const first = await store.create({ provider: { kind: "codex" } });
    const second = await store.create({ provider: { kind: "codex" } });
    const manager = makeManager();

    await manager.send({ threadId: first.id, content });
    await manager.send({ threadId: second.id, content });
    await manager.shutdown();

    expect(codexClients).toHaveLength(2);
    expect(codexClients.map((client) => client.closeCalls)).toEqual([1, 1]);
  });

  it("cancels a live session and closes clients on shutdown", async () => {
    const first = await store.create({ provider });
    const second = await store.create({ provider });
    const manager = makeManager();

    await manager.send({ threadId: first.id, content });
    await manager.send({ threadId: second.id, content });
    await manager.cancel({ threadId: first.id });
    await manager.cancel({ threadId: "missing" });
    await manager.shutdown();

    expect(clients).toHaveLength(2);
    expect(clients[0]?.cancelRequests).toEqual([{ sessionId: "session-1" }]);
    expect(clients.map((client) => client.closeCalls)).toEqual([1, 1]);
    clients.forEach((client) =>
      client.promptDeferreds.forEach((next) => next.resolve({ stopReason: "cancelled" })),
    );
  });
});
