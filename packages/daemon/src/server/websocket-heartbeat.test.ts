import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  PANE_STREAM_REDEEM_PATH,
  PANE_STREAM_WEBSOCKET_SUBPROTOCOL,
  WEBSOCKET_HEARTBEAT_HEADER,
  formatWebSocketHeartbeatHeader,
} from "@tmux-ide/contracts";
import type { PaneStreamAdmissionCoordinator } from "../terminal/pane-stream/pane-stream-websocket.ts";
import { logger } from "../lib/log.ts";
import { attachPaneStreamWebSocket } from "./pane-stream-upgrade.ts";
import {
  createWebSocketHeartbeat,
  heartbeatPolicyFromEnvironment,
  type HeartbeatSocket,
} from "./websocket-heartbeat.ts";

class FakeSocket extends EventEmitter implements HeartbeatSocket {
  pings = 0;
  terminated = false;
  answers = true;
  ping(): void {
    this.pings += 1;
    if (this.answers) queueMicrotask(() => this.emit("pong"));
  }
  terminate(): void {
    this.terminated = true;
    this.emit("close");
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("websocket heartbeat", () => {
  it("runs one timer for all sockets and none while nothing is watched", async () => {
    vi.useFakeTimers();
    const heartbeat = createWebSocketHeartbeat({ intervalMs: 1_000, missedLimit: 3 });
    expect(heartbeat.ticking).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    const sockets = Array.from({ length: 50 }, () => new FakeSocket());
    for (const socket of sockets) heartbeat.watch(socket, "pane-stream");
    heartbeat.watch(sockets[0]!, "pane-stream"); // watching twice changes nothing
    expect(heartbeat.watched).toBe(50);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sockets.every((socket) => socket.pings === 3 && !socket.terminated)).toBe(true);
    for (const socket of sockets) socket.emit("close");
    expect(heartbeat.watched).toBe(0);
    expect(heartbeat.ticking).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(sockets[0]!.listenerCount("pong") + sockets[0]!.listenerCount("close")).toBe(0);
  });

  it("drops only the peer that answered none of the last pings, and says so", async () => {
    vi.useFakeTimers();
    const warned = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const heartbeat = createWebSocketHeartbeat({ intervalMs: 1_000, missedLimit: 3 });
    const alive = new FakeSocket();
    const dead = new FakeSocket();
    dead.answers = false;
    heartbeat.watch(alive, "ws-events");
    heartbeat.watch(dead, "pane-stream /v2/terminal/pane-streams/redeem");
    await vi.advanceTimersByTimeAsync(3_000);
    // Three unanswered pings are tolerated; the tick after them drops the peer.
    expect(dead.terminated).toBe(false);
    expect(dead.pings).toBe(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(dead.terminated).toBe(true);
    expect(dead.pings).toBe(3);
    expect(alive.terminated).toBe(false);
    expect(heartbeat.watched).toBe(1);
    expect(warned).toHaveBeenCalledExactlyOnceWith(
      "websocket-heartbeat",
      "peer answered no ping; connection dropped",
      {
        connection: "pane-stream /v2/terminal/pane-streams/redeem",
        unansweredPings: 3,
        intervalMs: 1_000,
      },
    );
  });

  it("forgives missed pings as soon as one is answered", async () => {
    vi.useFakeTimers();
    const heartbeat = createWebSocketHeartbeat({ intervalMs: 1_000, missedLimit: 3 });
    const flaky = new FakeSocket();
    flaky.answers = false;
    heartbeat.watch(flaky, "ws-events");
    await vi.advanceTimersByTimeAsync(2_000);
    flaky.answers = true;
    await vi.advanceTimersByTimeAsync(1_000);
    flaky.answers = false;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(flaky.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(flaky.terminated).toBe(true);
  });

  it("takes a shorter interval from the environment only inside the allowed range", () => {
    expect(heartbeatPolicyFromEnvironment({})).toEqual({ intervalMs: 10_000, missedLimit: 3 });
    expect(
      heartbeatPolicyFromEnvironment({ TMUX_IDE_WS_HEARTBEAT_INTERVAL_MS: "500" }).intervalMs,
    ).toBe(500);
    for (const value of ["100", "60001", "abc", "1.5", ""])
      expect(
        heartbeatPolicyFromEnvironment({ TMUX_IDE_WS_HEARTBEAT_INTERVAL_MS: value }).intervalMs,
      ).toBe(10_000);
  });
});

describe("heartbeat on the pane-stream upgrade", () => {
  async function listen(intervalMs: number) {
    const server = createServer();
    const bound: unknown[] = [];
    const coordinator = {
      reserveUpgrade: () => ({
        accepted: true,
        admission: { bind: (socket: unknown) => bound.push(socket), cancelBeforeBind: () => {} },
      }),
      shutdown: async () => undefined,
    };
    const heartbeat = createWebSocketHeartbeat({ intervalMs, missedLimit: 2 });
    const boundary = attachPaneStreamWebSocket(
      server,
      coordinator as unknown as PaneStreamAdmissionCoordinator,
      PANE_STREAM_REDEEM_PATH,
      () => true,
      heartbeat,
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}${PANE_STREAM_REDEEM_PATH}`;
    const connect = (autoPong: boolean) =>
      new WebSocket(url, PANE_STREAM_WEBSOCKET_SUBPROTOCOL, {
        origin: "tmux-ide://opentui",
        autoPong,
      });
    const close = async () => {
      await boundary.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };
    return { heartbeat, connect, close };
  }

  it("advertises the cadence on the 101 response and pings a client that only speaks the old protocol", async () => {
    const h = await listen(40);
    const client = h.connect(true); // an old client: knows nothing, answers by protocol
    try {
      const header = await new Promise<string | undefined>((resolve, reject) => {
        client.once("upgrade", (response) => {
          const value = response.headers[WEBSOCKET_HEARTBEAT_HEADER];
          resolve(Array.isArray(value) ? value[0] : value);
        });
        client.once("error", reject);
      });
      expect(header).toBe(formatWebSocketHeartbeatHeader({ intervalMs: 40, missedLimit: 2 }));
      let pings = 0;
      client.on("ping", () => (pings += 1));
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(pings).toBeGreaterThanOrEqual(4);
      // It answered every ping, so it is still connected well past the limit.
      expect(client.readyState).toBe(WebSocket.OPEN);
      expect(h.heartbeat.watched).toBe(1);
    } finally {
      client.terminate();
      await h.close();
    }
  });

  it("drops a peer that stops answering without closing", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    const h = await listen(40);
    const client = h.connect(false); // half-open: connected, never pongs
    try {
      const closed = new Promise<number>((resolve) =>
        client.once("close", (code) => resolve(code)),
      );
      await new Promise<void>((resolve, reject) => {
        client.once("open", () => resolve());
        client.once("error", reject);
      });
      const started = performance.now();
      expect(await closed).toBe(1006);
      // Two unanswered pings, dropped on the third tick.
      expect(performance.now() - started).toBeLessThan(2_000);
      await vi.waitFor(() => expect(h.heartbeat.watched).toBe(0));
      expect(h.heartbeat.ticking).toBe(false);
    } finally {
      client.terminate();
      await h.close();
    }
  });
});
