/**
 * Receipt-driven wait: the fallback ladder (unsupported status / no daemon /
 * dead daemon / connect failure / socket drop → null) and the receipt path
 * (match, initial one-shot answer, honest timeout) — all against an injected
 * socket, no daemon.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { rollupStatus } from "./sessions.ts";
import type { AgentStatus } from "../detect/classify.ts";
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
  sent: unknown[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.emit("open");
    this.handshake();
  }
  handshake(): void {
    const { protocolVersion, productVersion, instanceId, startedAt } = daemonInfo;
    this.frame({
      type: "hello",
      daemon: { protocolVersion, productVersion, instanceId, startedAt },
      sessions: [],
    });
    this.frame({
      type: "resource.interests-ack",
      interestRevision: 1,
      sequence: 0,
      unavailableInterests: [],
    });
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

  it("waits for hello, explicitly subscribes, and reads only after the matching install barrier", async () => {
    const currentStatus = vi.fn(() => "done" as const);
    const { socket, opts } = harness({ currentStatus });
    const wait = waitForAgentStatusViaReceipts("s1", "done", opts);
    await tick();
    socket.emit("open");
    socket.frame(receipt("s1", "done"));
    expect(socket.sent).toEqual([]);
    expect(currentStatus).not.toHaveBeenCalled();
    const { protocolVersion, productVersion, instanceId, startedAt } = daemonInfo;
    socket.frame({
      type: "hello",
      daemon: { protocolVersion, productVersion, instanceId, startedAt },
      sessions: [],
    });
    expect(socket.sent).toEqual([
      {
        type: "subscribe",
        sessions: [],
        legacyEvents: true,
        interests: [{ resource: "fleet-catalog", workspaceName: null }],
        interestRevision: 1,
      },
    ]);
    socket.frame({
      type: "resource.interests-ack",
      interestRevision: 2,
      sequence: 0,
      unavailableInterests: [],
    });
    expect(currentStatus).not.toHaveBeenCalled();
    socket.frame({
      type: "resource.interests-ack",
      interestRevision: 1,
      sequence: 0,
      unavailableInterests: [],
    });
    expect(await wait).toMatchObject({ ok: true, status: "done" });
    expect(currentStatus).toHaveBeenCalledTimes(1);
    expect(socket.closed).toBe(true);
  });

  it.each(["incompatible", "unavailable", "protocol-error", "send-error"])(
    "falls back and closes on %s handshake",
    async (failure) => {
      const { socket, opts } = harness();
      const wait = waitForAgentStatusViaReceipts("s1", "done", opts);
      await tick();
      if (failure === "send-error")
        socket.send = () => {
          throw new Error("closed");
        };
      const { protocolVersion, productVersion, instanceId, startedAt } = daemonInfo;
      socket.frame({
        type: "hello",
        daemon: {
          protocolVersion: failure === "incompatible" ? 999 : protocolVersion,
          productVersion,
          instanceId,
          startedAt,
        },
        sessions: [],
      });
      if (failure === "unavailable")
        socket.frame({
          type: "resource.interests-ack",
          interestRevision: 1,
          sequence: 0,
          unavailableInterests: [{ resource: "fleet-catalog", workspaceName: null }],
        });
      if (failure === "protocol-error")
        socket.frame({ type: "protocol.error", code: "invalid-frame", message: "unsupported" });
      expect(await wait).toBeNull();
      expect(socket.closed).toBe(true);
    },
  );

  it("bounds an open socket without hello or acknowledgement", async () => {
    const { socket, opts } = harness({ connectTimeoutMs: 10 });
    const wait = waitForAgentStatusViaReceipts("s1", "done", opts);
    await tick();
    socket.emit("open");
    expect(await wait).toBeNull();
    expect(socket.closed).toBe(true);
  });

  it("includes probe and handshake time in the overall deadline", async () => {
    vi.useFakeTimers();
    try {
      const { socket, opts } = harness({
        timeoutMs: 100,
        connectTimeoutMs: 200,
        probeAlive: () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 30)),
      });
      const wait = waitForAgentStatusViaReceipts("s1", "done", opts);
      await vi.advanceTimersByTimeAsync(80);
      socket.open();
      await vi.advanceTimersByTimeAsync(20);
      expect(await wait).toMatchObject({ ok: false, timedOutAfterMs: 100 });
      expect(socket.closed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a stalled liveness probe without opening a socket", async () => {
    const openSocket = vi.fn();
    const result = await waitForAgentStatusViaReceipts("s1", "done", {
      readDaemonInfo: () => daemonInfo,
      timeoutMs: 10,
      probeAlive: () => new Promise<boolean>(() => {}),
      openSocket,
    });
    expect(result).toMatchObject({ ok: false, timedOutAfterMs: 10 });
    expect(openSocket).not.toHaveBeenCalled();
  });

  it("resolves ok on the matching receipt and closes the socket", async () => {
    let status: AgentStatus = "working";
    const { socket, opts } = harness({ currentStatus: () => status });
    const wait = waitForAgentStatusViaReceipts("s1", "done", opts);
    await tick();
    socket.open();
    socket.frame({ type: "pong" }); // unrelated frame — ignored
    socket.frame(receipt("other-session", "done")); // other session — ignored
    socket.frame(receipt("s1", "idle")); // a hint to re-read aggregate status, not an answer
    status = "done";
    socket.frame(receipt("s1", "done"));
    expect(await wait).toEqual({ ok: true, session: "s1", want: "done", status: "done" });
    expect(socket.closed).toBe(true);
  });

  it.each(["working", "blocked"] as const)(
    "does not settle when one agent finishes while another remains %s",
    async (other) => {
      const states: AgentStatus[] = ["working", other];
      const currentStatus = vi.fn(() => rollupStatus(states));
      const { socket, opts } = harness({ currentStatus, timeoutMs: 30 });
      const wait = waitForAgentStatusViaReceipts("s1", "done", opts);
      await tick();
      socket.open();
      states[0] = "done";
      socket.frame(receipt("s1", "done"));
      socket.frame({ type: "agent-status.changed", sessionName: "s1" });
      await tick();
      expect(socket.closed).toBe(false);
      expect(currentStatus).toHaveBeenCalledTimes(2); // open + coalesced hints
      expect(await wait).toEqual({
        ok: false,
        session: "s1",
        want: "done",
        status: other,
        timedOutAfterMs: 30,
      });
      expect(socket.closed).toBe(true);
    },
  );

  it("rechecks aggregate status for invalidation without requiring a completion receipt", async () => {
    let status: AgentStatus = "blocked";
    const currentStatus = vi.fn(() => status);
    const { socket, opts } = harness({ currentStatus });
    const wait = waitForAgentStatusViaReceipts("s1", "idle", opts);
    await tick();
    socket.open();
    socket.frame({ type: "agent-status.changed", sessionName: "other" });
    await tick();
    expect(currentStatus).toHaveBeenCalledTimes(1);
    status = "idle";
    socket.frame({ type: "agent-status.changed", sessionName: "s1" });
    expect(await wait).toEqual({ ok: true, session: "s1", want: "idle", status: "idle" });
  });

  it("does not read queued hints after socket closure", async () => {
    const currentStatus = vi.fn(() => "working" as const);
    const { socket, opts } = harness({ currentStatus });
    const wait = waitForAgentStatusViaReceipts("s1", "done", opts);
    await tick();
    socket.open();
    socket.frame(receipt("s1", "done"));
    socket.emit("close");
    expect(await wait).toBeNull();
    await tick();
    expect(currentStatus).toHaveBeenCalledTimes(1);
  });

  it("falls back when aggregate status cannot be read instead of trusting a receipt", async () => {
    const currentStatus = vi.fn(() => "working" as const);
    const { socket, opts } = harness({ currentStatus });
    const wait = waitForAgentStatusViaReceipts("s1", "done", opts);
    await tick();
    socket.open();
    currentStatus.mockImplementation(() => {
      throw new Error("unavailable");
    });
    socket.frame(receipt("s1", "done"));
    expect(await wait).toBeNull();
    expect(socket.closed).toBe(true);
  });

  it("keeps the original deadline despite repeated hints and cancels queued reads", async () => {
    vi.useFakeTimers();
    try {
      const currentStatus = vi.fn(() => null);
      const { socket, opts } = harness({ currentStatus, timeoutMs: 100 });
      const wait = waitForAgentStatusViaReceipts("s1", "done", opts);
      await vi.advanceTimersByTimeAsync(0);
      socket.open();
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(20);
        socket.frame(receipt("s1", "done"));
      }
      await vi.advanceTimersByTimeAsync(19);
      expect(socket.closed).toBe(false);
      socket.frame(receipt("s1", "done"));
      await vi.advanceTimersByTimeAsync(1);
      expect(await wait).toEqual({
        ok: false,
        session: "s1",
        want: "done",
        status: null,
        timedOutAfterMs: 100,
      });
      const reads = currentStatus.mock.calls.length;
      socket.frame(receipt("s1", "done"));
      await vi.runAllTimersAsync();
      expect(currentStatus).toHaveBeenCalledTimes(reads);
      expect(vi.getTimerCount()).toBe(0);
      expect(socket.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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
    const { socket, opts } = harness({ timeoutMs: 30, currentStatus: () => "idle" });
    const wait = waitForAgentStatusViaReceipts("s1", "done", opts);
    await tick();
    socket.open();
    socket.frame(receipt("s1", "idle")); // aggregate read stays idle, never the wanted status
    expect(await wait).toEqual({
      ok: false,
      session: "s1",
      want: "done",
      status: "idle",
      timedOutAfterMs: 30,
    });
  });
});
