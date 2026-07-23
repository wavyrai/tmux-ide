/**
 * Receipt-driven wait: the fallback ladder (unsupported status / no daemon /
 * dead daemon / connect failure / socket drop → null) and the receipt path
 * (match, initial one-shot answer, honest timeout) — all against an injected
 * socket, no daemon.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { CanonicalDaemonInfo } from "@tmux-ide/contracts";
import {
  isReceiptCoveredStatus,
  waitForAgentStatusViaReceipts,
  type ReceiptSocket,
} from "./wait-receipts.ts";

const daemonInfo: CanonicalDaemonInfo = {
  pid: 4242,
  port: 7433,
  protocolVersion: 1,
  productVersion: "2.8.0",
  instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
  startedAt: "2026-07-21T00:00:00.000Z",
  bindHostname: "127.0.0.1",
  authToken: null,
};

class FakeSocket extends EventEmitter implements ReceiptSocket {
  closed = false;
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.emit("open");
  }
  frame(frame: unknown): void {
    this.emit("message", JSON.stringify(frame));
  }
}

function receipt(sessionName: string, toStatus: "done" | "idle") {
  return {
    type: "agent.turn-completed",
    sessionName,
    agentId: null,
    fromStatus: "working",
    toStatus,
    at: "2026-07-23T12:00:00.000Z",
  };
}

/** Let the wait's async preamble (info read, liveness probe) attach listeners. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(overrides: Partial<Parameters<typeof waitForAgentStatusViaReceipts>[2]> = {}) {
  const socket = new FakeSocket();
  const opts = {
    readDaemonInfo: () => daemonInfo,
    probeAlive: async () => true,
    openSocket: () => socket,
    currentStatus: () => null,
    connectTimeoutMs: 50,
    timeoutMs: 200,
    ...overrides,
  };
  return { socket, opts };
}

describe("waitForAgentStatusViaReceipts", () => {
  it("declines non-receipt-covered statuses without touching the daemon", async () => {
    const readDaemonInfo = vi.fn(() => daemonInfo);
    expect(await waitForAgentStatusViaReceipts("s1", "working", { readDaemonInfo })).toBeNull();
    expect(await waitForAgentStatusViaReceipts("s1", "blocked", { readDaemonInfo })).toBeNull();
    expect(readDaemonInfo).not.toHaveBeenCalled();
    expect(isReceiptCoveredStatus("done")).toBe(true);
    expect(isReceiptCoveredStatus("idle")).toBe(true);
    expect(isReceiptCoveredStatus("unknown")).toBe(false);
  });

  it("declines when there is no daemon record or the daemon is dead", async () => {
    expect(
      await waitForAgentStatusViaReceipts("s1", "done", { readDaemonInfo: () => null }),
    ).toBeNull();
    expect(
      await waitForAgentStatusViaReceipts("s1", "done", {
        readDaemonInfo: () => daemonInfo,
        probeAlive: async () => false,
      }),
    ).toBeNull();
  });

  it("resolves ok on the matching receipt and closes the socket", async () => {
    const { socket, opts } = harness();
    const wait = waitForAgentStatusViaReceipts("s1", "done", opts);
    await tick();
    socket.open();
    socket.frame({ type: "pong" }); // unrelated frame — ignored
    socket.frame(receipt("other-session", "done")); // other session — ignored
    socket.frame(receipt("s1", "idle")); // wrong settle status — remembered, not a match
    socket.frame(receipt("s1", "done"));
    expect(await wait).toEqual({ ok: true, session: "s1", want: "done", status: "done" });
    expect(socket.closed).toBe(true);
  });

  it("answers immediately from the one-shot read when the turn already finished", async () => {
    const { socket, opts } = harness({ currentStatus: () => "done" });
    const wait = waitForAgentStatusViaReceipts("s1", "done", opts);
    await tick();
    socket.open();
    expect(await wait).toEqual({ ok: true, session: "s1", want: "done", status: "done" });
  });

  it("returns null when the socket errors or closes before a match", async () => {
    const errored = harness();
    const erroredWait = waitForAgentStatusViaReceipts("s1", "done", errored.opts);
    await tick();
    errored.socket.emit("error", new Error("refused"));
    expect(await erroredWait).toBeNull();

    const dropped = harness();
    const droppedWait = waitForAgentStatusViaReceipts("s1", "done", dropped.opts);
    await tick();
    dropped.socket.open();
    dropped.socket.emit("close");
    expect(await droppedWait).toBeNull();
  });

  it("returns null when the socket never opens within the connect budget", async () => {
    const { opts } = harness({ connectTimeoutMs: 10 });
    expect(await waitForAgentStatusViaReceipts("s1", "done", opts)).toBeNull();
  });

  it("times out honestly — a timeout is an answer, not a fallback", async () => {
    const { socket, opts } = harness({ timeoutMs: 30 });
    const wait = waitForAgentStatusViaReceipts("s1", "done", opts);
    await tick();
    socket.open();
    socket.frame(receipt("s1", "idle")); // observed, but never the wanted status
    expect(await wait).toEqual({
      ok: false,
      session: "s1",
      want: "done",
      status: "idle",
      timedOutAfterMs: 30,
    });
  });
});
