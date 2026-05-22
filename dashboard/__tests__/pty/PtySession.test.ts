/**
 * PtySession state-machine tests (G20-P2).
 *
 * The session must:
 *   1. Start "disconnected".
 *   2. Transition through "connecting" → "ready" when the WS opens.
 *   3. Land on "exited" when the daemon emits {type:"exit",code}.
 *   4. Surface error messages on {type:"error",message}.
 *   5. Be idempotent on repeated `connect()` calls.
 *   6. Be reusable after `dispose()` — a fresh `connect()` rebuilds.
 *
 * We mock the WebSocket so the test never opens a real socket.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "solid-js";
import { PtySession } from "@/lib/pty/PtySession";
import { _resetSessionPoolForTests } from "@/lib/pty/sessionPool";

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState: number = 0;
  binaryType = "blob";
  url: string;
  onopen: ((this: WebSocket, ev: Event) => unknown) | null = null;
  onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null;
  onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null;
  onerror: ((this: WebSocket, ev: Event) => unknown) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.call(this as unknown as WebSocket, new CloseEvent("close"));
  });
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.call(this as unknown as WebSocket, new Event("open"));
  }
  emit(data: unknown): void {
    this.onmessage?.call(
      this as unknown as WebSocket,
      new MessageEvent("message", { data: data as string }),
    );
  }
}

const OriginalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  _resetSessionPoolForTests();
});

afterEach(() => {
  globalThis.WebSocket = OriginalWebSocket;
});

describe("PtySession", () => {
  it("starts disconnected", () => {
    createRoot((dispose) => {
      const session = new PtySession("test-1");
      expect(session.status()).toBe("disconnected");
      expect(session.pty).toBeNull();
      dispose();
    });
  });

  it("transitions connecting → ready when the WS opens", () => {
    createRoot((dispose) => {
      const session = new PtySession("test-1");
      session.connect({ initialSize: { cols: 80, rows: 24 } });
      expect(session.status()).toBe("connecting");
      expect(FakeWebSocket.instances).toHaveLength(1);
      const ws = FakeWebSocket.instances[0]!;
      ws.open();
      expect(session.status()).toBe("ready");
      // Init frame was sent on open.
      expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"type":"init"'));
      dispose();
    });
  });

  it("lands on exited when the daemon emits an exit frame", () => {
    createRoot((dispose) => {
      const session = new PtySession("test-1");
      session.connect();
      const ws = FakeWebSocket.instances[0]!;
      ws.open();
      ws.emit(JSON.stringify({ type: "exit", code: 0 }));
      expect(session.status()).toBe("exited");
      dispose();
    });
  });

  it("captures error frames in errorMessage()", () => {
    createRoot((dispose) => {
      const session = new PtySession("test-1");
      session.connect();
      const ws = FakeWebSocket.instances[0]!;
      ws.open();
      ws.emit(JSON.stringify({ type: "error", message: "boom" }));
      expect(session.status()).toBe("error");
      expect(session.errorMessage()).toBe("boom");
      dispose();
    });
  });

  it("connect() is idempotent — second call is a no-op", () => {
    createRoot((dispose) => {
      const session = new PtySession("test-1");
      session.connect();
      session.connect();
      expect(FakeWebSocket.instances).toHaveLength(1);
      dispose();
    });
  });

  it("dispose() resets to disconnected and a fresh connect() rebuilds", () => {
    createRoot((dispose) => {
      const session = new PtySession("test-1");
      session.connect();
      const ws = FakeWebSocket.instances[0]!;
      ws.open();
      session.dispose();
      expect(session.status()).toBe("disconnected");
      expect(session.pty).toBeNull();
      session.connect();
      expect(FakeWebSocket.instances).toHaveLength(2);
      dispose();
    });
  });

  it("getLastOptions returns the most recent connect args", () => {
    createRoot((dispose) => {
      const session = new PtySession("test-1");
      session.connect({ cwd: "/tmp", initialSize: { cols: 100, rows: 30 } });
      expect(session.getLastOptions()).toEqual({
        cwd: "/tmp",
        initialSize: { cols: 100, rows: 30 },
      });
      dispose();
    });
  });
});
