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
import { ScriptedAcpClient, textChunk, thoughtChunk, toolCall } from "./stub-provider.ts";

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

afterEach(() => {
  for (const sock of openSockets.splice(0)) {
    try {
      sock.close();
    } catch {
      /* ignore */
    }
  }
  for (const dir of tempStoreDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
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

function makeStubbedManager(store: ThreadStore, stub: ScriptedAcpClient): ThreadManager {
  return makeThreadManager({
    store,
    // The ONLY substitution: model inference. Everything downstream is
    // the real production pipeline.
    spawnClient: async () => stub,
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
  // EXPECTED FAIL until Step 2 lands chat-WS resume/replay. The
  // assertion is real: a client that drops mid-turn and reconnects
  // must be able to recover the in-flight materialized turn from the
  // socket. Today `/ws/events` only re-sends `hello` (+ session
  // snapshot on subscribe) — there is NO chat timeline replay, so the
  // reconnected socket never learns the in-flight assistant text and
  // the assertion throws (→ this `it.fails` is green). When Step 2
  // implements replay-from-sequence this assertion passes, `it.fails`
  // turns RED, and that is the signal to delete `.fails` and lock the
  // resume contract in.
  it.fails("recovers an in-flight turn after a mid-stream socket drop + reconnect", async () => {
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

      // The reconnected client must recover the in-flight turn via
      // replay (snapshot / chat.timeline.reset). This is the real
      // gate — it throws today (no replay), passes once Step 2 ships.
      await waitFor(
        () =>
          assistantRowsFrom(socketB.received).some((r) =>
            r.message.text.includes("partial in-flight answer"),
          ),
        { timeoutMs: 1000, label: "resume: in-flight turn replayed to reconnected socket" },
      );
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

  it("documents TODAY's contract: ChatSessionSendInputZ is strict {threadId, content}", () => {
    // Baseline shape is accepted.
    expect(ChatSessionSendInputZ.safeParse(validBase).success).toBe(true);
    // Strict object → an unknown `model` key is rejected today. This
    // is exactly why picking a Codex model is cosmetic-only (see
    // docs/audit-provider-switcher-convergence.md ROOT CAUSE).
    const withModel = ChatSessionSendInputZ.safeParse({ ...validBase, model: "gpt-5-codex" });
    expect(withModel.success).toBe(false);
  });

  // EXPECTED FAIL until Step 3 adds optional `model` /
  // `providerInstanceId` to ChatSessionSendInputZ. The assertion is
  // real; when Step 3 widens the contract this passes, `it.fails`
  // turns RED, and that is the signal to delete `.fails` and require
  // the field end-to-end through dispatch.
  it.fails("Step 3 gate: ChatSessionSendInputZ should accept model + providerInstanceId", () => {
    const parsed = ChatSessionSendInputZ.safeParse({
      ...validBase,
      model: "gpt-5-codex",
      providerInstanceId: "codex",
    });
    expect(parsed.success).toBe(true);
  });
});
