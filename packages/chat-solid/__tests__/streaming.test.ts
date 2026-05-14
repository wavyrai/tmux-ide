/**
 * Regression: real-time chat streaming (task #103).
 *
 * The bug: chat-solid's bridge pointed `wsUrl` at `/ws/chat`, but the
 * daemon's unified push channel is `/ws/events`. The WebSocket open
 * silently dropped on the floor — the timeline received no
 * `chat.thread.update` frames, so streamed agent_message_chunk updates
 * never appeared. Only the post-stream durable refetch showed text,
 * which arrived all-at-once after the turn completed.
 *
 * These tests pin the wire:
 *   1. useChatThread opens a WebSocket — the bridge's wsUrl is the
 *      one it connects to.
 *   2. A `chat.thread.update` frame appends an AgentUpdate row.
 *   3. Multiple chunks land in arrival order.
 *   4. Frames for other threadIds are ignored.
 */

import { createRoot, createSignal, type Accessor } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatThread } from "../src/hooks/useChatThread";
import type { ChatMountOptions, ThreadMessage } from "../src/types";

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

const originalFetch = globalThis.fetch;
const OriginalWebSocket = globalThis.WebSocket;

describe("useChatThread — real-time streaming wire", () => {
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

  it("appends a chat.thread.update frame to the messages timeline", async () => {
    const { chat, dispose } = mountHook();
    try {
      await waitFor(() => FakeWebSocket.instances.length === 1);
      // Wait for the initial refetch's empty thread to settle so we
      // don't race the WS append against the load.
      await waitFor(() => chat.loading() === false);

      const socket = FakeWebSocket.instances[0]!;
      socket.emit({
        type: "chat.thread.update",
        threadId: "thread-1",
        seq: 1,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello, " },
        },
      });

      await waitFor(() => chat.messages().length === 1);
      const msg = chat.messages()[0] as Extract<ThreadMessage, { _tag: "AgentUpdate" }>;
      expect(msg._tag).toBe("AgentUpdate");
      expect((msg.update as { sessionUpdate: string }).sessionUpdate).toBe("agent_message_chunk");
      expect((msg.update as unknown as { content: { text: string } }).content.text).toBe("Hello, ");
    } finally {
      dispose();
    }
  });

  it("appends multiple streamed chunks in arrival order", async () => {
    const { chat, dispose } = mountHook();
    try {
      await waitFor(() => FakeWebSocket.instances.length === 1);
      await waitFor(() => chat.loading() === false);

      const socket = FakeWebSocket.instances[0]!;
      const chunks = ["Hello, ", "real-time ", "streaming!"];
      chunks.forEach((text, idx) => {
        socket.emit({
          type: "chat.thread.update",
          threadId: "thread-1",
          seq: idx + 1,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          },
        });
      });

      await waitFor(() => chat.messages().length === 3);
      const seenText = chat.messages().map((m) => {
        const update = (m as Extract<ThreadMessage, { _tag: "AgentUpdate" }>).update;
        return (update as { content: { text: string } }).content.text;
      });
      expect(seenText).toEqual(chunks);
    } finally {
      dispose();
    }
  });

  it("ignores chat.thread.update frames for other threads", async () => {
    const { chat, dispose } = mountHook();
    try {
      await waitFor(() => FakeWebSocket.instances.length === 1);
      await waitFor(() => chat.loading() === false);

      const socket = FakeWebSocket.instances[0]!;
      socket.emit({
        type: "chat.thread.update",
        threadId: "OTHER-thread",
        seq: 1,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "wrong thread" },
        },
      });
      // Drive one matching frame to give the hook *something* to do —
      // assert the cross-thread frame did NOT land alongside it.
      socket.emit({
        type: "chat.thread.update",
        threadId: "thread-1",
        seq: 2,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "right thread" },
        },
      });

      await waitFor(() => chat.messages().length === 1);
      const msg = chat.messages()[0] as Extract<ThreadMessage, { _tag: "AgentUpdate" }>;
      expect((msg.update as unknown as { content: { text: string } }).content.text).toBe(
        "right thread",
      );
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

      // Give the event loop a beat in case any handler erroneously
      // pushed something into the store.
      await new Promise((r) => setTimeout(r, 20));
      expect(chat.messages().length).toBe(0);
    } finally {
      dispose();
    }
  });
});
