/**
 * Server-materialized timeline — client is a pure renderer.
 *
 * The daemon reduces ACP `agent_message_chunk` bursts into the
 * canonical `MessagesTimelineRow[]` and pushes whole-row deltas:
 *
 *   - `chat.timeline.reset`  full replacement (history bootstrap /
 *                            editFromTurn rewind / user prompt).
 *   - `chat.timeline.upsert` incremental: `rows` are the changed/added
 *                            rows, `order` the authoritative id order.
 *
 * The client does NO reduction. This file pins:
 *   1. A `chat.timeline.upsert` populates `chat.rows()`.
 *   2. Re-upserting the same row id append-grows that row's text
 *      (streaming) and the row stays a single message row.
 *   3. Rows whose id is absent from a delta keep object identity
 *      (referential stability → the renderer's per-row memo skips
 *      untouched rows).
 *   4. `chat.timeline.reset` replaces the timeline wholesale.
 *   5. Deltas for other threadIds are ignored.
 *   6. A `chat.thread.update` (raw streaming chunk) performs ZERO
 *      client reduction: it neither grows `chat.messages()` nor adds
 *      a rendered row. The transcript is 100% server-materialized.
 */

import { createRoot, createSignal, type Accessor } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatThread } from "../src/hooks/useChatThread";
import type { ChatMountOptions, MessagesTimelineRow } from "../src/types";

class FakeWebSocket extends EventTarget {
  static instances: FakeWebSocket[] = [];
  readonly url: string;

  constructor(url: string) {
    super();
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  close = vi.fn();
  send = vi.fn();
}

function actionOk(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function plansOk(): Response {
  return new Response(JSON.stringify({ plans: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function panesOk(): Response {
  return new Response(JSON.stringify({ panes: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function threadResult(timeline: MessagesTimelineRow[] = []) {
  return {
    thread: {
      id: "thread-1",
      title: "Streaming",
      createdAt: "2026-05-14T10:00:00.000Z",
      updatedAt: "2026-05-14T10:00:00.000Z",
      provider: { kind: "claude-code" },
      messages: [],
    },
    timeline,
  };
}

function mountHook() {
  let chat!: ReturnType<typeof useChatThread>;
  let dispose!: () => void;
  createRoot((rootDispose) => {
    dispose = rootDispose;
    const [options] = createSignal<ChatMountOptions>({
      threadId: "thread-1",
      sessionName: "alpha",
      apiBaseUrl: "http://127.0.0.1:6060",
      wsUrl: "ws://127.0.0.1:6060/ws/events",
      bearerToken: null,
    });
    chat = useChatThread(options as Accessor<ChatMountOptions>);
  });
  return { chat, dispose };
}

async function waitFor(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
  expect(assertion()).toBe(true);
}

function pushMessage(socket: FakeWebSocket, payload: unknown): void {
  socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
}

function userRow(id: string, text: string): MessagesTimelineRow {
  return {
    kind: "message",
    id,
    createdAt: "2026-05-14T10:00:00.000Z",
    message: {
      id,
      role: "user",
      createdAt: "2026-05-14T10:00:00.000Z",
      content: [{ type: "text", text }],
    },
  };
}

function assistantRow(id: string, text: string, streaming: boolean): MessagesTimelineRow {
  return {
    kind: "message",
    id,
    createdAt: "2026-05-14T10:00:05.000Z",
    message: {
      id,
      role: "assistant",
      createdAt: "2026-05-14T10:00:05.000Z",
      streaming,
      text,
      toolCalls: [],
    },
  };
}

function upsert(rows: MessagesTimelineRow[], order: string[], threadId = "thread-1") {
  return { type: "chat.timeline.upsert" as const, threadId, rows, order };
}

describe("useChatThread — server-materialized timeline", () => {
  const originalFetch = globalThis.fetch;
  const OriginalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    globalThis.fetch = vi.fn(async (url) => {
      const s = String(url);
      if (s.includes("/plans")) return plansOk();
      if (s.includes("/panes")) return panesOk();
      return actionOk(threadResult());
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = OriginalWebSocket;
  });

  it("renders a chat.timeline.upsert delta directly", async () => {
    const { chat, dispose } = mountHook();
    await waitFor(() => FakeWebSocket.instances.length > 0);
    const socket = FakeWebSocket.instances[0]!;
    await waitFor(() => chat.thread() !== null);

    pushMessage(
      socket,
      upsert([userRow("u1", "hello"), assistantRow("a1", "Hi", true)], ["u1", "a1"]),
    );

    await waitFor(() => chat.rows().length === 2);
    const rows = chat.rows();
    expect(rows.map((r) => r.id)).toEqual(["u1", "a1"]);
    const assistant = rows[1]!;
    expect(assistant.kind).toBe("message");
    if (assistant.kind === "message" && assistant.message.role === "assistant") {
      expect(assistant.message.text).toBe("Hi");
      expect(assistant.message.streaming).toBe(true);
    }
    dispose();
  });

  it("append-grows the streaming row across upserts (daemon already coalesced)", async () => {
    const { chat, dispose } = mountHook();
    await waitFor(() => FakeWebSocket.instances.length > 0);
    const socket = FakeWebSocket.instances[0]!;
    await waitFor(() => chat.thread() !== null);

    pushMessage(socket, upsert([userRow("u1", "go")], ["u1"]));
    // The daemon sends the whole row each burst with cumulative text.
    for (const text of ["chunk-0 ", "chunk-0 chunk-1 ", "chunk-0 chunk-1 chunk-2"]) {
      pushMessage(socket, upsert([assistantRow("a1", text, true)], ["u1", "a1"]));
    }

    await waitFor(() => chat.rows().length === 2);
    const messageRows = chat
      .rows()
      .filter((row): row is Extract<typeof row, { kind: "message" }> => row.kind === "message");
    expect(messageRows).toHaveLength(2);
    const assistant = messageRows[1]!.message;
    expect(assistant.role).toBe("assistant");
    if (assistant.role === "assistant") {
      expect(assistant.text).toBe("chunk-0 chunk-1 chunk-2");
    }
    dispose();
  });

  it("preserves object identity for rows absent from a delta", async () => {
    const { chat, dispose } = mountHook();
    await waitFor(() => FakeWebSocket.instances.length > 0);
    const socket = FakeWebSocket.instances[0]!;
    await waitFor(() => chat.thread() !== null);

    pushMessage(
      socket,
      upsert([userRow("u1", "hello"), assistantRow("a1", "Hi", true)], ["u1", "a1"]),
    );
    await waitFor(() => chat.rows().length === 2);
    const userBefore = chat.rows()[0]!;

    // Stream only the assistant row — `u1` is absent from `rows`.
    pushMessage(socket, upsert([assistantRow("a1", "Hi there", true)], ["u1", "a1"]));
    await waitFor(() => {
      const r = chat.rows()[1];
      return (
        r?.kind === "message" && r.message.role === "assistant" && r.message.text === "Hi there"
      );
    });

    // Same reference → the renderer's per-row memo skips this subtree.
    expect(chat.rows()[0]).toBe(userBefore);
    dispose();
  });

  it("replaces the timeline wholesale on chat.timeline.reset", async () => {
    const { chat, dispose } = mountHook();
    await waitFor(() => FakeWebSocket.instances.length > 0);
    const socket = FakeWebSocket.instances[0]!;
    await waitFor(() => chat.thread() !== null);

    pushMessage(
      socket,
      upsert([userRow("u1", "first"), assistantRow("a1", "reply", false)], ["u1", "a1"]),
    );
    await waitFor(() => chat.rows().length === 2);

    pushMessage(socket, {
      type: "chat.timeline.reset",
      threadId: "thread-1",
      rows: [userRow("u2", "edited")],
    });
    await waitFor(() => chat.rows().length === 1);
    expect(chat.rows().map((r) => r.id)).toEqual(["u2"]);
    dispose();
  });

  it("ignores timeline deltas for other threads", async () => {
    const { chat, dispose } = mountHook();
    await waitFor(() => FakeWebSocket.instances.length > 0);
    const socket = FakeWebSocket.instances[0]!;
    await waitFor(() => chat.thread() !== null);

    pushMessage(socket, upsert([userRow("x", "wrong thread")], ["x"], "OTHER"));
    pushMessage(socket, upsert([userRow("u1", "right thread")], ["u1"]));

    await waitFor(() => chat.rows().length === 1);
    expect(chat.rows()[0]!.id).toBe("u1");
    dispose();
  });

  it("performs zero client reduction on chat.thread.update (pure renderer)", async () => {
    const { chat, dispose } = mountHook();
    await waitFor(() => FakeWebSocket.instances.length > 0);
    const socket = FakeWebSocket.instances[0]!;
    await waitFor(() => chat.thread() !== null);

    // A raw streaming chunk frame must NOT be folded into anything
    // client-side: the daemon already materialized the transcript and
    // ships it via `chat.timeline.*`. `chat.thread.update` now carries
    // only control signals (commands / mode / tool-call status).
    pushMessage(socket, {
      type: "chat.thread.update",
      threadId: "thread-1",
      seq: 1,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "raw" } },
    });

    // Give any errant handler a beat to (not) mutate state.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(chat.messages().length).toBe(0);
    expect(chat.rows().length).toBe(0);
    dispose();
  });
});
