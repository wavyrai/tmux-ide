import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "../src";

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

describe("mount", () => {
  const originalFetch = globalThis.fetch;
  const OriginalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            result: {
              thread: {
                id: "thread-1",
                title: "New chat",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
                provider: { kind: "claude-code" },
                messages: [],
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    ) as typeof fetch;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = OriginalWebSocket;
    document.body.innerHTML = "";
  });

  it("renders into a container and cleans up", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);

    const handle = mount(container, {
      threadId: "thread-1",
      sessionName: "alpha",
      apiBaseUrl: "http://127.0.0.1:6060",
      wsUrl: "ws://127.0.0.1:6060/ws/events",
      bearerToken: "tok",
    });

    await Promise.resolve();
    expect(container.classList.contains("chat-solid-root")).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalled();
    expect(FakeWebSocket.instances[0]?.url).toContain("token=tok");

    handle.setThreadId("thread-2");
    handle.unmount();
    expect(container.classList.contains("chat-solid-root")).toBe(false);
  });
});
