import { describe, expect, it, vi } from "vitest";
import { DAEMON_WIRE_PROTOCOL_VERSION, type DaemonHealth } from "@tmux-ide/contracts";
import type { CanonicalDaemonInfo } from "../canonical-daemon.ts";
import type { EmbeddedDaemonHandle, EmbeddedDaemonOptions } from "../daemon-embed.ts";
import { runHeadlessDaemon, type HeadlessDaemonDependencies } from "../headless-daemon.ts";

function daemonInfo(overrides: Partial<CanonicalDaemonInfo> = {}): CanonicalDaemonInfo {
  return {
    pid: 321,
    port: 4321,
    protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
    version: "2.8.0",
    startedAt: "2026-07-21T00:00:00.000Z",
    bindHostname: "127.0.0.1",
    authToken: null,
    ...overrides,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createHarness(
  options: {
    info?: CanonicalDaemonInfo | null;
    alive?: boolean;
    health?: DaemonHealth | null;
  } = {},
): {
  deps: HeadlessDaemonDependencies;
  lines: string[];
  signals: Map<NodeJS.Signals, () => void>;
  startOptions: EmbeddedDaemonOptions[];
  clearCount: () => number;
  stop: () => Promise<void>;
} {
  let info = options.info === undefined ? null : options.info;
  let cleared = 0;
  const lines: string[] = [];
  const signals = new Map<NodeJS.Signals, () => void>();
  const startOptions: EmbeddedDaemonOptions[] = [];
  const stopped = deferred();
  const handle: EmbeddedDaemonHandle = {
    port: 4321,
    apiBaseUrl: "http://127.0.0.1:4321",
    wsUrl: "ws://127.0.0.1:4321/ws/events",
    localBypassToken: null,
    activateProject: async () => ({ stop: async () => undefined }),
    stop: async () => stopped.resolve(),
  };
  const deps: HeadlessDaemonDependencies = {
    readCanonicalDaemonInfo: () => info,
    clearCanonicalDaemonInfo: () => {
      cleared += 1;
      info = null;
    },
    isCanonicalDaemonAlive: async () => options.alive ?? false,
    probeCanonicalDaemonHealth: async () =>
      options.health !== undefined
        ? options.health
        : info
          ? {
              ok: true,
              protocolVersion: info.protocolVersion,
              version: info.version,
              uptime: 42,
            }
          : null,
    startEmbeddedDaemon: async (start) => {
      startOptions.push(start);
      info = daemonInfo();
      return handle;
    },
    writeStdout: (line) => lines.push(line),
    onSignal: (signal, listener) => signals.set(signal, listener),
    offSignal: (signal, listener) => {
      if (signals.get(signal) === listener) signals.delete(signal);
    },
  };
  return {
    deps,
    lines,
    signals,
    startOptions,
    clearCount: () => cleared,
    stop: () => handle.stop(),
  };
}

describe("runHeadlessDaemon", () => {
  it("reuses a compatible live canonical daemon without takeover", async () => {
    const harness = createHarness({ info: daemonInfo(), alive: true });

    await expect(runHeadlessDaemon({ json: true }, harness.deps)).resolves.toBe("already-running");

    expect(harness.startOptions).toEqual([]);
    expect(JSON.parse(harness.lines[0]!)).toEqual({
      status: "already-running",
      pid: 321,
      port: 4321,
      apiBaseUrl: "http://127.0.0.1:4321",
    });
  });

  it("clears stale metadata, starts loopback without implicit auth, and stops on SIGTERM", async () => {
    const harness = createHarness({ info: daemonInfo({ pid: 999_999 }), alive: false });
    const running = runHeadlessDaemon({ port: "4321", json: true }, harness.deps);
    await vi.waitFor(() => expect(harness.lines).toHaveLength(1));

    expect(harness.clearCount()).toBe(1);
    expect(harness.startOptions).toEqual([
      { port: 4321, bindHostname: "127.0.0.1", authToken: null, silent: true },
    ]);
    expect(harness.signals.has("SIGINT")).toBe(true);
    harness.signals.get("SIGTERM")?.();

    await expect(running).resolves.toBe("stopped");
    expect(harness.signals.size).toBe(0);
  });

  it("returns when the daemon shutdown path calls the shared handle", async () => {
    const harness = createHarness();
    const running = runHeadlessDaemon({}, harness.deps);
    await vi.waitFor(() => expect(harness.lines).toHaveLength(1));

    await harness.stop();

    await expect(running).resolves.toBe("stopped");
  });

  it("remembers SIGTERM received during startup and cleans up before returning", async () => {
    const harness = createHarness();
    const startGate = deferred();
    const startEmbeddedDaemon = harness.deps.startEmbeddedDaemon;
    const running = runHeadlessDaemon(
      {},
      {
        ...harness.deps,
        startEmbeddedDaemon: async (options) => {
          await startGate.promise;
          return await startEmbeddedDaemon(options);
        },
      },
    );
    await vi.waitFor(() => expect(harness.signals.has("SIGTERM")).toBe(true));

    harness.signals.get("SIGTERM")?.();
    startGate.resolve();

    await expect(running).resolves.toBe("stopped");
    expect(harness.lines).toEqual([]);
    expect(harness.signals.size).toBe(0);
  });

  it("rejects invalid ports before starting", async () => {
    const harness = createHarness();

    await expect(runHeadlessDaemon({ port: "not-a-port" }, harness.deps)).rejects.toMatchObject({
      code: "USAGE",
      exitCode: 2,
    });
    expect(harness.startOptions).toEqual([]);
  });

  it("does not reuse a daemon rejected by protocol compatibility", async () => {
    const harness = createHarness({
      info: daemonInfo({ protocolVersion: 2 }),
      alive: true,
    });

    await expect(runHeadlessDaemon({}, harness.deps)).rejects.toMatchObject({
      code: "DAEMON_PROTOCOL_MISMATCH",
      exitCode: 2,
    });
    expect(harness.clearCount()).toBe(0);
    expect(harness.startOptions).toEqual([]);
  });

  it("does not clear or replace a live owner whose health is unavailable", async () => {
    const harness = createHarness({ info: daemonInfo(), alive: true, health: null });

    await expect(runHeadlessDaemon({}, harness.deps)).rejects.toMatchObject({
      code: "DAEMON_UNHEALTHY",
      exitCode: 1,
    });
    expect(harness.clearCount()).toBe(0);
    expect(harness.startOptions).toEqual([]);
  });

  it("rejects disagreement between discovery and health protocols", async () => {
    const harness = createHarness({
      info: daemonInfo(),
      alive: true,
      health: { ok: true, protocolVersion: 2, version: "2.8.0", uptime: 42 },
    });

    await expect(runHeadlessDaemon({}, harness.deps)).rejects.toMatchObject({
      code: "DAEMON_PROTOCOL_MISMATCH",
      exitCode: 2,
    });
    expect(harness.clearCount()).toBe(0);
    expect(harness.startOptions).toEqual([]);
  });
});
