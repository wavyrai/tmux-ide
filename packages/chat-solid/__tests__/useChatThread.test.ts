import { createRoot, createSignal, type Accessor } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatThread } from "../src/hooks/useChatThread";
import type { ChatMountOptions } from "../src/types";

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

function panesOk(): Response {
  return new Response(
    JSON.stringify({
      panes: [{ id: "%1", title: "Dev Server", currentCommand: "pnpm" }],
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

async function waitFor(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(assertion()).toBe(true);
}

function threadResult() {
  return {
    thread: {
      id: "thread-1",
      title: "New chat",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      provider: { kind: "claude-code" },
      projectDir: "/Users/thijs/Developer/tmux-ide",
      messages: [],
    },
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

describe("useChatThread attachments", () => {
  const originalFetch = globalThis.fetch;
  const OriginalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = OriginalWebSocket;
  });

  it("adds and removes composer attachments", () => {
    globalThis.fetch = vi.fn(async (url) =>
      String(url).includes("/api/project/") ? panesOk() : actionOk(threadResult()),
    ) as typeof fetch;

    const { chat, dispose } = mountHook();
    chat.addAttachment({
      kind: "terminal",
      paneId: "%1",
      paneTitle: "Dev Server",
      sessionName: "alpha",
    });
    chat.addAttachment({ kind: "file", path: "/tmp/output.log", label: "output.log" });

    expect(chat.attachments()).toHaveLength(2);
    chat.removeAttachment(0);
    expect(chat.attachments()).toEqual([
      { kind: "file", path: "/tmp/output.log", label: "output.log" },
    ]);
    dispose();
  });

  it("captures terminal attachments at send time and clears them after send", async () => {
    const sentBodies: unknown[] = [];
    const captureBodies: unknown[] = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      const href = String(url);
      if (href.includes("/api/project/")) return panesOk();
      if (href.includes("chat.context.captureTerminal")) {
        captureBodies.push(JSON.parse(String(init?.body)));
        return actionOk({
          pane: { id: "%1", title: "Dev Server" },
          content: "server ready\n",
          capturedAt: "2026-01-01T00:00:00.000Z",
        });
      }
      if (href.includes("chat.session.send")) {
        sentBodies.push(JSON.parse(String(init?.body)));
        return actionOk({ accepted: true, promptId: "prompt-1" });
      }
      return actionOk(threadResult());
    }) as typeof fetch;

    const { chat, dispose } = mountHook();
    chat.addAttachment({
      kind: "terminal",
      paneId: "%1",
      paneTitle: "Dev Server",
      sessionName: "alpha",
    });

    await chat.send([{ type: "text", text: "what happened?" }]);
    await waitFor(() => sentBodies.length === 1);

    expect(captureBodies).toEqual([{ sessionName: "alpha", paneId: "%1" }]);
    expect(sentBodies).toEqual([
      {
        threadId: "thread-1",
        content: [
          {
            type: "resource",
            resource: {
              uri: "tmux-pane://alpha/%1",
              text: "server ready\n",
              mimeType: "text/plain",
            },
          },
          { type: "text", text: "what happened?" },
        ],
      },
    ]);
    expect(chat.attachments()).toEqual([]);
    dispose();
  });

  it("restores persisted usage when a thread is opened", async () => {
    globalThis.fetch = vi.fn(async (url, init) => {
      const href = String(url);
      if (href.includes("/api/project/")) return panesOk();
      if (href.includes("chat.thread.usage")) {
        expect(JSON.parse(String(init?.body))).toEqual({ id: "thread-1" });
        return actionOk({
          usage: {
            inputTokens: 12_000,
            outputTokens: 3_000,
            totalCostUsd: 0.0421,
          },
        });
      }
      return actionOk(threadResult());
    }) as typeof fetch;

    const { chat, dispose } = mountHook();

    await waitFor(() => chat.usage()?.totalCostUsd === 0.0421);
    expect(chat.usage()).toEqual({
      inputTokens: 12_000,
      outputTokens: 3_000,
      totalCostUsd: 0.0421,
    });
    dispose();
  });
});
