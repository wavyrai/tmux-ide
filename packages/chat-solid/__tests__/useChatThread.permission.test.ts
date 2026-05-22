import { createRoot, createSignal, type Accessor } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatThread } from "../src/hooks/useChatThread";
import type { ChatMountOptions } from "../src/types";

class FakeWebSocket extends EventTarget {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  messageListenerCount = 0;

  constructor(url: string) {
    super();
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  close = vi.fn();
  send = vi.fn();

  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (type === "message") this.messageListenerCount += 1;
    super.addEventListener(type, callback, options);
  }
}

function ok(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function waitFor(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(assertion()).toBe(true);
}

describe("useChatThread permission events", () => {
  const originalFetch = globalThis.fetch;
  const OriginalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    globalThis.fetch = vi.fn(async () =>
      ok({
        thread: {
          id: "thread-1",
          title: "New chat",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          provider: { kind: "claude-code" },
          messages: [],
        },
      }),
    ) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = OriginalWebSocket;
  });

  it("tracks permission requests and clears them on completed tool updates", async () => {
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

    await waitFor(() => (FakeWebSocket.instances[0]?.messageListenerCount ?? 0) > 0);
    FakeWebSocket.instances[0]?.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "chat.permission.request",
          threadId: "thread-1",
          requestId: "request-1",
          toolCall: { toolCallId: "tool-1", title: "Edit file", kind: "edit" },
          options: [{ optionId: "reject_once", name: "Reject once", kind: "reject_once" }],
        }),
      }),
    );

    await waitFor(() => chat.pendingPermission()?.requestId === "request-1");

    FakeWebSocket.instances[0]?.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "chat.thread.update",
          threadId: "thread-1",
          seq: 1,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-1",
            status: "completed",
          },
        }),
      }),
    );

    await waitFor(() => chat.pendingPermission() === null);
    dispose();
  });
});
