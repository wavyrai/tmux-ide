/**
 * Regression: real-time chat streaming (task #103) — pure-renderer era.
 *
 * The original bug: chat-solid's bridge pointed `wsUrl` at `/ws/chat`,
 * but the daemon's unified push channel is `/ws/events`. The WebSocket
 * open silently dropped on the floor, so streamed updates never
 * appeared until the post-stream durable refetch.
 *
 * Step 1 of the t3 convergence moved ALL reduction server-side: the
 * daemon materializes the canonical transcript and ships whole-row
 * `chat.timeline.*` frames; the client renders them with ZERO
 * reduction. These tests pin the wire under that contract:
 *   1. useChatThread opens a WebSocket at the configured URL.
 *   2. A `chat.timeline.upsert` populates the rendered transcript
 *      (the #103 regression, reframed: a misrouted socket → no rows).
 *   3. A raw `chat.thread.update` chunk performs ZERO client reduction
 *      (neither `chat.messages()` nor `chat.rows()` grows).
 *   4. Frames for other threadIds are ignored.
 *   5. Non-chat frames on the unified channel are dropped.
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
  /** Drive a frame down to the hook's message handler. */
  emit(payload: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
  }
}

function actionOk(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function emptyThread(id = "thread-1") {
  return {
    thread: {
      id,
      title: "New chat",
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
      provider: { kind: "claude-code" },
      projectDir: "/Users/thijs/Developer/tmux-ide",
      messages: [],
    },
    timeline: [],
  };
}

function panesOk() {
  return new Response(JSON.stringify({ panes: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function waitFor(assertion: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(assertion()).toBe(true);
}

function mountHook(wsUrl = "ws://127.0.0.1:6060/ws/events") {
  let chat!: ReturnType<typeof useChatThread>;
  let dispose!: () => void;
  createRoot((rootDispose) => {
    dispose = rootDispose;
    const [options] = createSignal<ChatMountOptions>({
      threadId: "thread-1",
      sessionName: "alpha",
      apiBaseUrl: "http://127.0.0.1:6060",
      wsUrl,
      bearerToken: null,
    });
    chat = useChatThread(options as Accessor<ChatMountOptions>);
  });
  return { chat, dispose };
}

function assistantRow(id: string, text: string, streaming: boolean): MessagesTimelineRow {
  return {
    kind: "message",
    id,
    createdAt: "2026-05-13T00:00:05.000Z",
    message: {
      id,
      role: "assistant",
      createdAt: "2026-05-13T00:00:05.000Z",
      streaming,
      text,
      toolCalls: [],
    },
  };
}

function upsert(rows: MessagesTimelineRow[], order: string[], threadId = "thread-1") {
  return { type: "chat.timeline.upsert" as const, threadId, rows, order };
}

const originalFetch = globalThis.fetch;
const OriginalWebSocket = globalThis.WebSocket;

describe("useChatThread — real-time streaming wire (pure renderer)", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    globalThis.fetch = vi.fn(async (url) =>
      String(url).includes("/api/project/") ? panesOk() : actionOk(emptyThread()),
    ) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = OriginalWebSocket;
  });

  it("opens a WebSocket at the configured URL on mount", async () => {
    const { dispose } = mountHook("ws://127.0.0.1:6060/ws/events");
    try {
      await waitFor(() => FakeWebSocket.instances.length === 1);
      expect(FakeWebSocket.instances[0]!.url).toMatch(/\/ws\/events(\?|$)/);
    } finally {
      dispose();
    }
  });

  it("renders the server-materialized transcript from chat.timeline.upsert", async () => {
    const { chat, dispose } = mountHook();
    try {
      await waitFor(() => FakeWebSocket.instances.length === 1);
      await waitFor(() => chat.loading() === false);

      const socket = FakeWebSocket.instances[0]!;
      // The daemon ships whole rows with cumulative text — the client
      // just mirrors them by id in the authoritative server order.
      for (const text of ["Hello, ", "Hello, real-time ", "Hello, real-time streaming!"]) {
        socket.emit(upsert([assistantRow("a1", text, true)], ["a1"]));
      }

      await waitFor(() => chat.rows().length === 1);
      const row = chat.rows()[0]!;
      expect(row.kind).toBe("message");
      if (row.kind === "message" && row.message.role === "assistant") {
        expect(row.message.text).toBe("Hello, real-time streaming!");
      }
    } finally {
      dispose();
    }
  });

  it("performs zero client reduction on a raw chat.thread.update chunk", async () => {
    const { chat, dispose } = mountHook();
    try {
      await waitFor(() => FakeWebSocket.instances.length === 1);
      await waitFor(() => chat.loading() === false);

      const socket = FakeWebSocket.instances[0]!;
      // A raw streaming chunk must NOT be folded into the raw log or
      // synthesized into a render row — the daemon already materialized
      // the transcript and ships it via chat.timeline.*.
      socket.emit({
        type: "chat.thread.update",
        threadId: "thread-1",
        seq: 1,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "raw" } },
      });

      await new Promise((r) => setTimeout(r, 20));
      expect(chat.messages().length).toBe(0);
      expect(chat.rows().length).toBe(0);
    } finally {
      dispose();
    }
  });

  it("ignores chat.timeline frames for other threads", async () => {
    const { chat, dispose } = mountHook();
    try {
      await waitFor(() => FakeWebSocket.instances.length === 1);
      await waitFor(() => chat.loading() === false);

      const socket = FakeWebSocket.instances[0]!;
      socket.emit(upsert([assistantRow("x", "wrong thread", false)], ["x"], "OTHER-thread"));
      socket.emit(upsert([assistantRow("a1", "right thread", false)], ["a1"]));

      await waitFor(() => chat.rows().length === 1);
      expect(chat.rows()[0]!.id).toBe("a1");
    } finally {
      dispose();
    }
  });

  it("drops non-chat frames riding the unified /ws/events channel", async () => {
    const { chat, dispose } = mountHook();
    try {
      await waitFor(() => FakeWebSocket.instances.length === 1);
      await waitFor(() => chat.loading() === false);

      const socket = FakeWebSocket.instances[0]!;
      // task/mission/pong frames also flow on /ws/events — these must
      // never end up in the chat timeline.
      socket.emit({ type: "pong" });
      socket.emit({ type: "task.changed", sessionName: "alpha", taskId: "t-1" });
      socket.emit({ type: "sessions.changed" });

      await new Promise((r) => setTimeout(r, 20));
      expect(chat.rows().length).toBe(0);
      expect(chat.messages().length).toBe(0);
    } finally {
      dispose();
    }
  });
});
