import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
} from "../../codex/index.ts";
import { CodexAgentEventZ } from "../../codex/index.ts";
import { makeThreadManager } from "../thread-manager.ts";
import { makeThreadStore, type ThreadStore } from "../thread-store.ts";
import type { ChatEvent } from "../types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "../../codex/__fixtures__");
const fixtureNames = ["turn-pong.ndjson", "turn-2plus2.ndjson", "turn-ls-tmp.ndjson"];

interface ReplayFixture {
  events: CodexAgentEvent[];
  threadId: string;
  turnId: string;
  textChunkCount: number;
}

async function waitFor(
  assertion: () => boolean | Promise<boolean>,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(await assertion()).toBe(true);
}

function loadFixture(name: string): ReplayFixture {
  const rawFrames = readFileSync(join(fixturesDir, name), "utf-8")
    .trim()
    .split(/\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
  const events = rawFrames.flatMap((frame) => {
    const parsed = CodexAgentEventZ.safeParse(frame);
    return parsed.success ? [parsed.data] : [];
  });
  const turnStarted = events.find((event) => event.method === "turn/started");
  if (!turnStarted || turnStarted.method !== "turn/started") {
    throw new Error(`Fixture ${name} has no turn/started event`);
  }
  return {
    events,
    threadId: turnStarted.params.threadId,
    turnId: turnStarted.params.turn.id,
    textChunkCount: events.filter((event) => event.method === "item/agentMessage/delta").length,
  };
}

function finalAgentMessageOnly(fixture: ReplayFixture): ReplayFixture {
  const index = fixture.events.findIndex(
    (event) =>
      event.method === "item/completed" &&
      event.params.item.type === "agentMessage" &&
      event.params.item.phase === "final_answer",
  );
  if (index === -1) throw new Error("fixture has no final_answer agentMessage completion");
  return {
    ...fixture,
    events: fixture.events.slice(0, index + 1),
  };
}

class ReplayCodexClient implements CodexClient {
  readonly closed = Promise.resolve({ code: 0, signal: null });
  readonly sendUserMessageRequests: SendUserMessageRequest[] = [];
  closeCalls = 0;
  private readonly agentEventHandlers = new Set<(event: CodexAgentEvent) => void>();

  constructor(private readonly fixture: ReplayFixture) {}

  async initialize(): Promise<CodexInitializeResponse> {
    return {
      codexHome: "/tmp/codex-home",
      platformFamily: "unix",
      platformOs: "macos",
      userAgent: "fixture-codex",
    };
  }

  async newConversation(_req: NewConversationRequest): Promise<NewConversationResponse> {
    return {
      approvalPolicy: "never",
      approvalsReviewer: "user",
      cwd: "/tmp",
      model: "gpt-5.2",
      modelProvider: "openai",
      sandbox: { mode: "danger-full-access" },
      thread: { id: this.fixture.threadId },
    };
  }

  async sendUserMessage(req: SendUserMessageRequest): Promise<SendUserMessageResponse> {
    this.sendUserMessageRequests.push(req);
    return { turn: { id: this.fixture.turnId, status: "inProgress" } };
  }

  async interrupt(_req: InterruptRequest): Promise<void> {
    return;
  }

  onAgentEvent(handler: (event: CodexAgentEvent) => void): () => void {
    this.agentEventHandlers.add(handler);
    return () => this.agentEventHandlers.delete(handler);
  }

  onApplyPatchApproval(
    _handler: (req: ApplyPatchApprovalRequest) => Promise<ApplyPatchApprovalResponse>,
  ): () => void {
    return () => undefined;
  }

  onChatgptTokenRefresh(
    _handler: (req: ChatgptAuthTokensRefreshRequest) => Promise<ChatgptAuthTokensRefreshResponse>,
  ): () => void {
    return () => undefined;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }

  replay(): void {
    for (const event of this.fixture.events) {
      for (const handler of this.agentEventHandlers) handler(event);
    }
  }
}

let rootDir = "";

afterEach(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true });
  rootDir = "";
});

async function runFixture(fixture: ReplayFixture): Promise<{
  events: ChatEvent[];
  store: ThreadStore;
  threadId: string;
  client: ReplayCodexClient;
}> {
  rootDir = mkdtempSync(join(tmpdir(), "tmux-ide-codex-stop-"));
  const store = makeThreadStore({ rootDir });
  const events: ChatEvent[] = [];
  const client = new ReplayCodexClient(fixture);
  const manager = makeThreadManager({
    store,
    spawnClient: async () => {
      throw new Error("ACP client is not used");
    },
    spawnCodexClient: async () => client,
    busEmit: (event) => events.push(event),
    disableCoalescing: true,
    persistDebounceMs: 1,
    textCoalesceWindowMs: 1,
  });
  const thread = await store.create({ provider: { kind: "codex" } });
  await manager.send({ threadId: thread.id, content: [{ type: "text", text: "fixture prompt" }] });
  client.replay();
  return { events, store, threadId: thread.id, client };
}

describe("Codex stop reliability fixtures", () => {
  for (const fixtureName of fixtureNames) {
    it(`emits stop and persists messages for ${fixtureName}`, async () => {
      const fixture = loadFixture(fixtureName);
      const result = await runFixture(fixture);

      await waitFor(
        () =>
          result.events.some(
            (event) => event.type === "chat.thread.stop" && event.stopReason === "end_turn",
          ),
        100,
      );

      expect(result.events.filter((event) => event.type === "chat.thread.update")).toHaveLength(
        fixture.textChunkCount +
          fixture.events.filter((event) => event.method === "item/completed").length -
          fixture.events.filter(
            (event) =>
              event.method === "item/completed" &&
              (event.params.item.type === "userMessage" ||
                event.params.item.type === "agentMessage" ||
                event.params.item.type === "agentReasoning"),
          ).length,
      );
      const agentTextUpdates = result.events.filter(
        (event) =>
          event.type === "chat.thread.update" &&
          event.update.sessionUpdate === "agent_message_chunk",
      );
      expect(agentTextUpdates).toHaveLength(fixture.textChunkCount);
      await waitFor(async () => (await result.store.list())[0]?.lastStopReason === "end_turn");
      const thread = await result.store.get(result.threadId);
      expect(thread?.messages.filter((message) => message._tag === "AgentUpdate")).toHaveLength(
        result.events.filter((event) => event.type === "chat.thread.update").length,
      );
    });
  }

  it("treats captured final_answer agentMessage completion as a stop signal without turn/completed", async () => {
    const fixture = finalAgentMessageOnly(loadFixture("turn-pong.ndjson"));
    const result = await runFixture(fixture);

    await waitFor(
      () =>
        result.events.some(
          (event) => event.type === "chat.thread.stop" && event.stopReason === "end_turn",
        ),
      100,
    );
    expect(result.events.filter((event) => event.type === "chat.thread.stop")).toHaveLength(1);
    await waitFor(async () => (await result.store.list())[0]?.lastStopReason === "end_turn");
  });
});
