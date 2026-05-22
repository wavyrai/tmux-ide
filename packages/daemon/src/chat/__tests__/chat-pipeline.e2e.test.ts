/**
 * Hermetic end-to-end chat pipeline harness — Step 0 of the t3 chat
 * convergence and the verification gate every later step depends on.
 *
 * What this exercises (REAL, not mocked):
 *   - the daemon command-center booted in-process on an ephemeral port
 *     (`createApp` + `attachWsEvents`), a REAL `ws` client on
 *     `/ws/events`;
 *   - the real action handlers (`chat.thread.create`,
 *     `chat.session.send`);
 *   - the real `ThreadManager` → `message-pipe` → server-side
 *     `ThreadTimeline` materialization → `broadcastChatEvent` path;
 *   - the real wire contract (`ServerFrameSchemaZ` +
 *     `@tmux-ide/contracts` `TimelineRowZ`), asserted on the bytes the
 *     socket actually receives.
 *
 * What is stubbed: ONLY model inference. `ScriptedAcpClient` replaces
 * the spawned claude-code/codex binary — no child process, no auth, no
 * network, no real timers. See `./stub-provider.ts`.
 *
 * Gate semantics:
 *   - Scenarios that reflect *today's correct* server-materialized
 *     behavior assert hard and must stay green.
 *   - The reconnect/resume scenario (audit divergence #2) and the
 *     turn-contract model field (provider-switcher audit) are NOT
 *     implemented yet. Their assertions are REAL and wrapped in
 *     `it.fails(...)`: green today *because the assertion fails*, and
 *     they flip RED the moment Step 2 / Step 3 make them pass — which
 *     is the signal to delete the `.fails` and lock the behavior in.
 *     This is the documented gap, not a silent omission.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRequestListener } from "@hono/node-server";
import WebSocket from "ws";
import { ChatSessionSendInputZ, TimelineRowZ } from "@tmux-ide/contracts";
import { attachWsEvents, createApp } from "../../command-center/server.ts";
import { broadcastChatEvent, _stopSessionsPollerForTests } from "../../command-center/ws-events.ts";
import { _setTmuxRunner } from "../../command-center/discovery.ts";
import { _setExecutor } from "../../widgets/lib/pane-comms.ts";
import { ServerFrameSchemaZ } from "../../schemas/ws-events.ts";
import {
  chatSessionSendHandler,
  chatThreadCreateHandler,
} from "../../command-center/actions/handlers/chat-actions.ts";
import { makeThreadManager, type ThreadManager } from "../thread-manager.ts";
import { makeThreadStore, type ThreadStore } from "../thread-store.ts";
import type { ChatEvent } from "../types.ts";
import {
  ScriptedAcpClient,
  ScriptedCodexClient,
  textChunk,
  thoughtChunk,
  toolCall,
} from "./stub-provider.ts";

// ---------------------------------------------------------------------------
// In-process server + real WS client
// ---------------------------------------------------------------------------

let server: Server;
let wsHandle: { close: () => void };
let baseWsUrl: string;
let restoreTmux: () => void;
let restoreExec: () => void;

const openSockets: WebSocket[] = [];
const tempStoreDirs: string[] = [];

beforeAll(async () => {
  // Keep session discovery hermetic — `hello` on connect calls
  // `discoverSessions()`, which would otherwise shell out to `tmux`.
  restoreTmux = _setTmuxRunner(() => "");
  restoreExec = _setExecutor(() => "");

  const app = createApp();
  server = createServer(getRequestListener(app.fetch));
  wsHandle = attachWsEvents(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("expected AddressInfo");
  baseWsUrl = `ws://127.0.0.1:${addr.port}/ws/events`;
});

afterAll(async () => {
  wsHandle.close();
  _stopSessionsPollerForTests();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  restoreTmux();
  restoreExec();
});

afterEach(async () => {
  for (const sock of openSockets.splice(0)) {
    try {
      sock.close();
    } catch {
      /* ignore */
    }
  }
  for (const dir of tempStoreDirs.splice(0)) {
    // better-sqlite3 occasionally still holds a flush in flight when the
    // ws teardown above resolves; the resulting ENOTEMPTY shows up only
    // on slower CI runners. Retry a few times before failing the test.
    let lastErr: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
    if (lastErr) throw lastErr;
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface WsClient {
  socket: WebSocket;
  received: unknown[];
}

async function connectClient(): Promise<WsClient> {
  const socket = new WebSocket(baseWsUrl);
  openSockets.push(socket);
  const received: unknown[] = [];
  socket.on("message", (data: Buffer) => {
    try {
      received.push(JSON.parse(data.toString("utf-8")));
    } catch {
      /* non-JSON frame — ignore */
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return { socket, received };
}

async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 4000, label = "condition" }: { timeoutMs?: number; label?: string } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

interface AnyFrame {
  type: string;
  [k: string]: unknown;
}

function frames(received: unknown[]): AnyFrame[] {
  return received.filter(
    (f): f is AnyFrame =>
      typeof f === "object" && f !== null && typeof (f as AnyFrame).type === "string",
  );
}

function chatFrames(received: unknown[]): AnyFrame[] {
  return frames(received).filter((f) => f.type.startsWith("chat."));
}

function makeStubbedManager(
  store: ThreadStore,
  stub: ScriptedAcpClient,
  codexStub?: ScriptedCodexClient,
): ThreadManager {
  return makeThreadManager({
    store,
    // The ONLY substitution: model inference. Everything downstream is
    // the real production pipeline.
    spawnClient: async () => stub,
    ...(codexStub ? { spawnCodexClient: async () => codexStub } : {}),
    busEmit: (event: ChatEvent) => broadcastChatEvent(event),
    // Deterministic, no real timers: flush every update eagerly so
    // ordering is exact and we never wait on a coalesce window.
    disableCoalescing: true,
    persistDebounceMs: 0,
    textCoalesceWindowMs: 0,
    permissionTimeoutMs: 1,
  });
}

function freshStore(): ThreadStore {
  const dir = mkdtempSync(join(tmpdir(), "chat-e2e-store-"));
  tempStoreDirs.push(dir);
  return makeThreadStore({ rootDir: dir });
}

/** All `TimelineRow`s seen across every timeline frame, parsed against
 *  the STRICT contract — this is the "fail loudly on drift" gate. */
function assertEveryTimelineRowMatchesContract(received: unknown[]): void {
  for (const f of chatFrames(received)) {
    if (f.type !== "chat.timeline.upsert" && f.type !== "chat.timeline.reset") continue;
    const rows = (f as { rows?: unknown[] }).rows ?? [];
    for (const row of rows) {
      const parsed = TimelineRowZ.safeParse(row);
      if (!parsed.success) {
        throw new Error(
          `TimelineRow drift on ${f.type}: ${JSON.stringify(parsed.error.issues)} — row=${JSON.stringify(row)}`,
        );
      }
    }
  }
}

interface AssistantRow {
  id: string;
  message: {
    role: "assistant";
    text: string;
    thoughtText?: string;
    streaming: boolean;
    completedAt?: string;
    stopReason?: string;
    toolCalls: Array<{ toolCallId: string; title: string }>;
  };
}

function assistantRowsFrom(received: unknown[]): AssistantRow[] {
  const out: AssistantRow[] = [];
  for (const f of chatFrames(received)) {
    if (f.type !== "chat.timeline.upsert" && f.type !== "chat.timeline.reset") continue;
    for (const row of (f as { rows?: AnyFrame[] }).rows ?? []) {
      if (
        row &&
        row.kind === "message" &&
        (row as { message?: { role?: string } }).message?.role === "assistant"
      ) {
        out.push(row as unknown as AssistantRow);
      }
    }
  }
  return out;
}

// ===========================================================================
// 1. Server-materialized pipeline — the contract that must stay green
// ===========================================================================

describe("chat pipeline e2e — server-materialized contract (must stay green)", () => {
  it("materializes user + streamed assistant + tool + thought into ONE message, then stops", async () => {
    const store = freshStore();
    const stub = new ScriptedAcpClient();
    const manager = makeStubbedManager(store, stub);
    const deps = { store, manager, busEmit: (e: ChatEvent) => broadcastChatEvent(e) };

    const client = await connectClient();

    const created = await chatThreadCreateHandler(
      { provider: { kind: "claude-code" }, title: "e2e" },
      deps,
    );
    const threadId = created.thread.id;

    await waitFor(
      () =>
        chatFrames(client.received).some(
          (f) =>
            f.type === "chat.thread.index" &&
            Array.isArray((f as { threads?: { id: string }[] }).threads) &&
            (f as { threads: { id: string }[] }).threads.some((t) => t.id === threadId),
        ),
      { label: "chat.thread.index for new thread" },
    );

    const PROMPT = "ship the harness";
    const sent = await chatSessionSendHandler(
      { threadId, content: [{ type: "text", text: PROMPT }] },
      deps,
    );
    expect(sent.accepted).toBe(true);

    // The user message is materialized + broadcast immediately
    // (chat.timeline.reset from resyncTimeline) — before any agent chunk.
    await waitFor(() => chatFrames(client.received).some((f) => f.type === "chat.timeline.reset"), {
      label: "chat.timeline.reset (user message materialized)",
    });
    const resetFrame = chatFrames(client.received).find((f) => f.type === "chat.timeline.reset")!;
    const resetRows = (resetFrame as { rows: unknown[] }).rows;
    for (const row of resetRows) expect(TimelineRowZ.safeParse(row).success).toBe(true);
    const userRow = resetRows.find(
      (r): r is { message: { role: string; content: { type: string; text: string }[] } } =>
        typeof r === "object" &&
        r !== null &&
        (r as { message?: { role?: string } }).message?.role === "user",
    );
    expect(userRow).toBeTruthy();
    expect(JSON.stringify(userRow!.message.content)).toContain(PROMPT);

    // Drive a deterministic agent turn through the real pipe.
    await stub.awaitPrompt();
    stub.emit(textChunk("Hello "));
    stub.emit(textChunk("world"));
    stub.emit(toolCall({ toolCallId: "tc-1", title: "run tests", kind: "execute" }));
    stub.emit(thoughtChunk("reasoning about the harness"));
    stub.finishPrompt("end_turn");

    // Terminal stop frame arrives.
    await waitFor(
      () =>
        chatFrames(client.received).some(
          (f) => f.type === "chat.thread.stop" && f.promptId === sent.promptId,
        ),
      { label: "chat.thread.stop" },
    );

    // Wait for the post-stop upsert that flips streaming=false.
    await waitFor(
      () => assistantRowsFrom(client.received).some((r) => r.message.streaming === false),
      { label: "final non-streaming assistant row" },
    );

    // --- Frame SHAPE contract (loose ServerFrame union) ---
    for (const f of chatFrames(client.received)) {
      const parsed = ServerFrameSchemaZ.safeParse(f);
      expect(
        parsed.success,
        `ServerFrame drift on ${f.type}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`,
      ).toBe(true);
    }

    // --- TimelineRow SHAPE contract (STRICT — the drift gate) ---
    assertEveryTimelineRowMatchesContract(client.received);

    // --- Server-side reduction: ONE assistant message, not one per chunk ---
    const assistantRows = assistantRowsFrom(client.received);
    expect(assistantRows.length).toBeGreaterThan(0);
    const assistantIds = new Set(assistantRows.map((r) => r.id));
    expect(assistantIds.size).toBe(1);

    // --- Text accumulates across chunks (append-grown, not replaced) ---
    const texts = assistantRows.map((r) => r.message.text);
    expect(texts).toContain("Hello ");
    expect(texts).toContain("Hello world");
    const finalRow = assistantRows.at(-1)!;
    expect(finalRow.message.text).toBe("Hello world");

    // --- Tool-call + thinking materialized onto the same message ---
    expect(finalRow.message.toolCalls.map((t) => t.toolCallId)).toEqual(["tc-1"]);
    expect(finalRow.message.toolCalls[0]!.title).toBe("run tests");
    expect(finalRow.message.thoughtText ?? "").toContain("reasoning about the harness");

    // --- Terminal: not streaming, stop reason recorded ---
    expect(finalRow.message.streaming).toBe(false);
    expect(finalRow.message.stopReason).toBe("end_turn");
    expect(typeof finalRow.message.completedAt).toBe("string");

    const stopFrame = chatFrames(client.received).find((f) => f.type === "chat.thread.stop")!;
    expect(stopFrame.stopReason).toBe("end_turn");
    expect(stopFrame.threadId).toBe(threadId);

    await manager.shutdown();
  });
});

// ===========================================================================
// 2. Reconnect / resume — audit divergence #2 (Step 2 closes this)
// ===========================================================================

describe("chat pipeline e2e — reconnect/resume (Step 2 gate)", () => {
  // STEP 2 (landed): a client that drops mid-turn and reconnects MUST
  // recover the in-flight materialized turn from the socket. On
  // reconnect the client sends `chat.subscribe { threadId, lastSeq }`
  // and the daemon replays the buffered materialized timeline frames
  // it missed (seq > lastSeq), in order, gap-free + dupe-free. This
  // assertion is now hard (`it`, not `it.fails`) and must stay green.
  it("recovers an in-flight turn after a mid-stream socket drop + reconnect", async () => {
    const store = freshStore();
    const stub = new ScriptedAcpClient();
    const manager = makeStubbedManager(store, stub);
    const deps = { store, manager, busEmit: (e: ChatEvent) => broadcastChatEvent(e) };

    const socketA = await connectClient();
    const created = await chatThreadCreateHandler(
      { provider: { kind: "claude-code" }, title: "resume" },
      deps,
    );
    const threadId = created.thread.id;
    const sent = await chatSessionSendHandler(
      { threadId, content: [{ type: "text", text: "stream then drop" }] },
      deps,
    );

    try {
      await stub.awaitPrompt();
      // Stream a chunk so there is genuine in-flight materialized
      // state, but DO NOT finish the turn.
      stub.emit(textChunk("partial in-flight answer"));
      await waitFor(
        () =>
          assistantRowsFrom(socketA.received).some((r) =>
            r.message.text.includes("partial in-flight answer"),
          ),
        { label: "in-flight assistant text on socket A" },
      );

      // Drop the socket mid-turn and reconnect a fresh one.
      socketA.socket.close();
      const socketB = await connectClient();
      await waitFor(() => frames(socketB.received).some((f) => f.type === "hello"), {
        label: "hello on reconnected socket",
      });

      // Resume: the reconnecting client asks for everything it missed
      // (lastSeq 0 ⇒ full replay of the in-flight turn). The daemon
      // replays the buffered materialized frames in order.
      socketB.socket.send(JSON.stringify({ type: "chat.subscribe", threadId, lastSeq: 0 }));

      // The reconnected socket recovers the in-flight turn via replay.
      await waitFor(
        () =>
          assistantRowsFrom(socketB.received).some((r) =>
            r.message.text.includes("partial in-flight answer"),
          ),
        { timeoutMs: 1000, label: "resume: in-flight turn replayed to reconnected socket" },
      );

      // Resume is gap-free + dupe-free: exactly one assistant row id,
      // and the recovered text is the in-flight content (no loss).
      const recovered = assistantRowsFrom(socketB.received);
      expect(new Set(recovered.map((r) => r.id)).size).toBe(1);
      expect(recovered.at(-1)!.message.text).toContain("partial in-flight answer");
    } finally {
      stub.finishPrompt("end_turn");
      await manager.shutdown();
      void sent;
    }
  });
});

// ===========================================================================
// 3. Turn contract — provider/model switcher audit (Step 3 gate)
// ===========================================================================

describe("chat pipeline e2e — chat.session.send contract (Step 3 gate)", () => {
  const validBase = {
    threadId: "thr-1",
    content: [{ type: "text" as const, text: "hi" }],
  };

  it("baseline: ChatSessionSendInputZ accepts {threadId, content}", () => {
    expect(ChatSessionSendInputZ.safeParse(validBase).success).toBe(true);
  });

  // Step 3 (LANDED): ChatSessionSendInputZ now accepts a per-turn
  // `model` + (forward-compat) `providerInstanceId`. The earlier
  // `.fails` wrapper has been removed — this assertion is now a hard
  // gate.
  it("contract: ChatSessionSendInputZ accepts model + providerInstanceId", () => {
    const parsed = ChatSessionSendInputZ.safeParse({
      ...validBase,
      model: "gpt-5-codex",
      providerInstanceId: "codex",
    });
    expect(parsed.success).toBe(true);
  });

  it("daemon applies the per-turn model: persisted on thread.provider AND surfaced to the agent", async () => {
    const store = freshStore();
    const stub = new ScriptedAcpClient();
    const manager = makeStubbedManager(store, stub);
    const deps = { store, manager, busEmit: (e: ChatEvent) => broadcastChatEvent(e) };

    const created = await chatThreadCreateHandler(
      { provider: { kind: "claude-code" }, title: "model-switch" },
      deps,
    );
    const threadId = created.thread.id;

    // Send with an explicit model. The daemon should:
    //   (a) write `model` onto thread.provider before spawning the
    //       live client, and
    //   (b) forward it to the agent on this turn so a downstream
    //       observer (the stub) can confirm dispatch honored it.
    await chatSessionSendHandler(
      {
        threadId,
        content: [{ type: "text", text: "pick a codex model" }],
        model: "claude-sonnet-4-6",
      },
      deps,
    );

    await stub.awaitPrompt();
    expect(stub.lastDispatchedModel).toBe("claude-sonnet-4-6");

    const persisted = await store.get(threadId);
    expect(persisted?.provider.model).toBe("claude-sonnet-4-6");

    stub.finishPrompt("end_turn");
    await manager.shutdown();
  });
});

// ===========================================================================
// 4. Per-turn provider routing — t3-mirror (Step 3b gate)
// ===========================================================================

describe("chat pipeline e2e — per-turn provider routing (Step 3b gate)", () => {
  // (a) contract: ChatSessionSendInputZ accepts the per-turn
  //     provider.kind. The CLIENT writes this synchronously when the
  //     user picks a provider (see chat-solid's activeProviderStore);
  //     the contract is the wire-level proof that the daemon now
  //     consents to per-turn routing without a setProvider round-trip.
  it("contract: ChatSessionSendInputZ accepts provider.kind", () => {
    const parsed = ChatSessionSendInputZ.safeParse({
      threadId: "thr-x",
      content: [{ type: "text" as const, text: "hi" }],
      model: "gpt-5-codex",
      provider: { kind: "codex" },
    });
    expect(parsed.success).toBe(true);
    // Unknown kinds rejected — additive but still strict.
    const bad = ChatSessionSendInputZ.safeParse({
      threadId: "thr-x",
      content: [{ type: "text" as const, text: "hi" }],
      provider: { kind: "magic-llm" },
    });
    expect(bad.success).toBe(false);
  });

  // (b) + (c): a thread persisted on `claude-code` receives a send
  //     overriding `provider.kind: "codex"`. The daemon must spawn
  //     the codex client (NOT the claude-code stub) for THIS turn,
  //     and `thread.provider.kind` must remain `claude-code` —
  //     persistence is the host's fire-and-forget responsibility, not
  //     a side-effect of dispatch.
  it("routes the turn through the per-turn provider.kind without mutating thread.provider", async () => {
    const store = freshStore();
    const acpStub = new ScriptedAcpClient();
    const codexStub = new ScriptedCodexClient();
    const manager = makeStubbedManager(store, acpStub, codexStub);
    const deps = { store, manager, busEmit: (e: ChatEvent) => broadcastChatEvent(e) };

    // Persisted thread is claude-code.
    const created = await chatThreadCreateHandler(
      { provider: { kind: "claude-code" }, title: "step-3b" },
      deps,
    );
    const threadId = created.thread.id;

    // Per-turn override: route through codex with a codex model.
    const sent = await chatSessionSendHandler(
      {
        threadId,
        content: [{ type: "text", text: "switch to codex for this turn" }],
        model: "gpt-5-codex",
        provider: { kind: "codex" },
      },
      deps,
    );

    // The daemon spawned the CODEX stub (not the ACP stub) for this
    // turn and dispatched with the chosen model. The slug landed by
    // sendUserMessage is the alias-normalised one — the legacy
    // `gpt-5-codex` selection resolves server-side to the current
    // canonical `gpt-5.4` (CODEX-FULL #4).
    await waitFor(() => codexStub.sentMessages.length > 0, {
      label: "codex stub received sendUserMessage",
    });
    expect(acpStub.promptRequests.length).toBe(0);
    expect(codexStub.lastDispatchedModel).toBe("gpt-5.4");

    // The turn completes (stub emits turn/completed in a microtask).
    await waitFor(
      () =>
        frames([]).length >= 0 && // touch eslint
        codexStub.sentMessages.length > 0,
      { label: "codex dispatch settled" },
    );

    // The PERSISTED thread.provider is unchanged — Step 3b's
    // contract is "client owns visible provider; persistence is
    // fire-and-forget via chat.thread.setProvider, NOT a side-effect
    // of dispatch".
    const persisted = await store.get(threadId);
    expect(persisted?.provider.kind).toBe("claude-code");

    void sent;
    await manager.shutdown();
  });
});

// ===========================================================================
// 5. CODEX-FULL — per-turn reasoning effort + fast-mode + slug alias
// ===========================================================================

describe("chat pipeline e2e — codex per-turn reasoning effort + fast mode (CODEX-FULL gate)", () => {
  // (a) Contract: the canonical t3 `Array<{id, value}>` shape is
  //     accepted by ChatSessionSendInputZ.
  it("contract: ChatSessionSendInputZ accepts providerOptions", () => {
    const parsed = ChatSessionSendInputZ.safeParse({
      threadId: "thr-effort",
      content: [{ type: "text" as const, text: "hi" }],
      providerOptions: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  // (b) Dispatch wire: when the client supplies reasoningEffort +
  //     fastMode on a Codex turn, the daemon must forward them to
  //     `sendUserMessage` as `effort` + `serviceTier: "fast"` —
  //     mirroring t3's `CodexAdapter.ts:1509-1530`.
  it("forwards reasoningEffort + fastMode to Codex sendUserMessage", async () => {
    const store = freshStore();
    const acpStub = new ScriptedAcpClient();
    const codexStub = new ScriptedCodexClient();
    const manager = makeStubbedManager(store, acpStub, codexStub);
    const deps = { store, manager, busEmit: (e: ChatEvent) => broadcastChatEvent(e) };

    const created = await chatThreadCreateHandler(
      { provider: { kind: "codex", model: "gpt-5.4" }, title: "codex-effort" },
      deps,
    );
    const threadId = created.thread.id;

    await chatSessionSendHandler(
      {
        threadId,
        content: [{ type: "text", text: "think harder" }],
        providerOptions: [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      },
      deps,
    );

    await waitFor(() => codexStub.sentMessages.length > 0, {
      label: "codex stub received sendUserMessage",
    });
    expect(codexStub.lastDispatchedEffort).toBe("high");
    expect(codexStub.lastDispatchedServiceTier).toBe("fast");

    await manager.shutdown();
  });

  // (c) Carry-over: a second send that OMITS providerOptions inherits
  //     the previous selection from the in-memory map. The daemon
  //     doesn't re-prompt the user for the same effort every turn.
  it("carries the last providerOptions forward when the next send omits them", async () => {
    const store = freshStore();
    const acpStub = new ScriptedAcpClient();
    const codexStub = new ScriptedCodexClient();
    const manager = makeStubbedManager(store, acpStub, codexStub);
    const deps = { store, manager, busEmit: (e: ChatEvent) => broadcastChatEvent(e) };

    const created = await chatThreadCreateHandler(
      { provider: { kind: "codex", model: "gpt-5.4" }, title: "codex-carryover" },
      deps,
    );
    const threadId = created.thread.id;

    await chatSessionSendHandler(
      {
        threadId,
        content: [{ type: "text", text: "first turn" }],
        providerOptions: [{ id: "reasoningEffort", value: "xhigh" }],
      },
      deps,
    );
    await waitFor(() => codexStub.sentMessages.length >= 1, {
      label: "codex stub: first sendUserMessage",
    });

    await chatSessionSendHandler(
      { threadId, content: [{ type: "text", text: "second turn — no options" }] },
      deps,
    );
    await waitFor(() => codexStub.sentMessages.length >= 2, {
      label: "codex stub: second sendUserMessage",
    });

    expect(codexStub.lastDispatchedEffort).toBe("xhigh");
    // fastMode was never set → stays unset, not silently "true".
    expect(codexStub.lastDispatchedServiceTier).toBeNull();

    await manager.shutdown();
  });

  // (d) Slug alias: a stale client (or a CLI default) sends a
  //     deprecated slug. The daemon normalises to the canonical one
  //     server-side and dispatches with that — wire stays
  //     forward-compatible (the request shape is unchanged) but the
  //     model that lands on `sendUserMessage` is the renamed one.
  it("aliases a legacy codex slug to the canonical model before dispatch", async () => {
    const store = freshStore();
    const acpStub = new ScriptedAcpClient();
    const codexStub = new ScriptedCodexClient();
    const manager = makeStubbedManager(store, acpStub, codexStub);
    const deps = { store, manager, busEmit: (e: ChatEvent) => broadcastChatEvent(e) };

    const created = await chatThreadCreateHandler(
      { provider: { kind: "codex" }, title: "codex-alias" },
      deps,
    );
    const threadId = created.thread.id;

    await chatSessionSendHandler(
      // Client picks the legacy slug; daemon should swap it for the
      // current canonical (`gpt-5-codex` → `gpt-5.4`).
      { threadId, content: [{ type: "text", text: "alias me" }], model: "gpt-5-codex" },
      deps,
    );

    await waitFor(() => codexStub.sentMessages.length > 0, {
      label: "codex stub received sendUserMessage",
    });
    expect(codexStub.lastDispatchedModel).toBe("gpt-5.4");

    // Persistence reflects the normalised slug (lazy setProvider).
    const persisted = await store.get(threadId);
    expect(persisted?.provider.model).toBe("gpt-5.4");

    await manager.shutdown();
  });

  // (e) Capability surface: ProviderModelInfo carries optional
  //     capabilities — when present, the picker reads it directly.
  //     We assert the contract here so any drift trips this test.
  it("contract: ProviderModelInfoZ accepts the capabilities surface", async () => {
    const { ChatProvidersListResultZ } = await import("@tmux-ide/contracts");
    const parsed = ChatProvidersListResultZ.safeParse({
      providers: [
        {
          kind: "codex",
          name: "Codex",
          description: "Codex app-server proxy",
          available: true,
          models: [
            {
              slug: "gpt-5.4",
              name: "GPT-5.4",
              capabilities: {
                reasoningEfforts: ["low", "medium", "high", "xhigh"],
                defaultReasoningEffort: "medium",
                supportsFastMode: true,
              },
            },
          ],
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });
});
