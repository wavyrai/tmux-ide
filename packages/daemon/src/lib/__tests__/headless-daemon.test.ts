import { describe, expect, it, vi } from "vitest";
import {
  DAEMON_WIRE_PROTOCOL_VERSION,
  type DaemonHealth,
  type DaemonIdentity,
} from "@tmux-ide/contracts";
import type { CanonicalDaemonInfo, CanonicalDaemonInfoState } from "../canonical-daemon.ts";
import {
  resolveDaemonProductVersion,
  type EmbeddedDaemonHandle,
  type EmbeddedDaemonOptions,
} from "../daemon-embed.ts";
import { runHeadlessDaemon, type HeadlessDaemonDependencies } from "../headless-daemon.ts";

function daemonInfo(overrides: Partial<CanonicalDaemonInfo> = {}): CanonicalDaemonInfo {
  return {
    pid: 321,
    port: 4321,
    protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
    productVersion: "2.8.0",
    instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
    startedAt: "2026-07-21T00:00:00.000Z",
    bindHostname: "127.0.0.1",
    authToken: null,
    ...overrides,
  };
}

function validState(info: CanonicalDaemonInfo): CanonicalDaemonInfoState {
  return {
    status: "valid",
    info,
    observation: { dev: 1, ino: 1, size: 1, mtimeMs: 1 },
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
    state?: CanonicalDaemonInfoState;
    alive?: boolean;
    ownerProvenDead?: boolean;
    health?: DaemonHealth | null;
    identity?: DaemonIdentity | null;
  } = {},
): {
  deps: HeadlessDaemonDependencies;
  lines: string[];
  signals: Map<NodeJS.Signals, () => void>;
  startOptions: EmbeddedDaemonOptions[];
  stop: () => Promise<void>;
} {
  let state: CanonicalDaemonInfoState = options.state ?? { status: "missing" };
  const lines: string[] = [];
  const signals = new Map<NodeJS.Signals, () => void>();
  const startOptions: EmbeddedDaemonOptions[] = [];
  const stopped = deferred();
  const handle: EmbeddedDaemonHandle = {
    instanceId: daemonInfo().instanceId,
    pid: daemonInfo().pid,
    port: 4321,
    apiBaseUrl: "http://127.0.0.1:4321",
    wsUrl: "ws://127.0.0.1:4321/ws/events",
    localBypassToken: null,
    activateProject: async () => ({ stop: async () => undefined }),
    stop: async () => stopped.resolve(),
  };
  const deps: HeadlessDaemonDependencies = {
    inspectCanonicalDaemonInfo: () => state,
    isCanonicalDaemonAlive: async () => options.alive ?? false,
    isCanonicalDaemonRecordOwnerProvenDead: async () => options.ownerProvenDead ?? false,
    probeCanonicalDaemonHealth: async () =>
      options.health !== undefined
        ? options.health
        : state.status === "valid"
          ? {
              ok: true,
              protocolVersion: state.info.protocolVersion,
              productVersion: state.info.productVersion,
              uptime: 42,
            }
          : null,
    probeCanonicalDaemonIdentity: async () =>
      options.identity !== undefined
        ? options.identity
        : state.status === "valid"
          ? {
              ok: true,
              pid: state.info.pid,
              protocolVersion: state.info.protocolVersion,
              productVersion: state.info.productVersion,
              instanceId: state.info.instanceId,
              startedAt: state.info.startedAt,
            }
          : null,
    startEmbeddedDaemon: async (start) => {
      startOptions.push(start);
      state = validState(daemonInfo());
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
    stop: () => handle.stop(),
  };
}

describe("runHeadlessDaemon", () => {
  it("uses a safe product-version fallback when bundled package metadata is unavailable", () => {
    expect(
      resolveDaemonProductVersion(undefined, () => {
        throw new Error("package.json is not bundled");
      }),
    ).toBe("0.0.0");
    expect(resolveDaemonProductVersion(" 2.8.0 ", () => ({ version: "ignored" }))).toBe("2.8.0");
    expect(resolveDaemonProductVersion(undefined, () => ({ version: 42 }))).toBe("0.0.0");
  });

  it("reuses a compatible live canonical daemon without takeover", async () => {
    const harness = createHarness({ state: validState(daemonInfo()), alive: true });

    await expect(runHeadlessDaemon({ json: true }, harness.deps)).resolves.toBe("already-running");

    expect(harness.startOptions).toEqual([]);
    expect(JSON.parse(harness.lines[0]!)).toEqual({
      status: "already-running",
      pid: 321,
      port: 4321,
      apiBaseUrl: "http://127.0.0.1:4321",
    });
  });

  it("leaves stale removal to the claimed starter and stops on SIGTERM", async () => {
    const harness = createHarness({
      state: validState(daemonInfo({ pid: 999_999 })),
      alive: false,
    });
    const running = runHeadlessDaemon({ port: "4321", json: true }, harness.deps);
    await vi.waitFor(() => expect(harness.lines).toHaveLength(1));

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

  it("never reports readiness for a handle whose instance identity differs from daemon.json", async () => {
    const harness = createHarness();
    const start = harness.deps.startEmbeddedDaemon;

    await expect(
      runHeadlessDaemon(
        { json: true },
        {
          ...harness.deps,
          startEmbeddedDaemon: async (options) => ({
            ...(await start(options)),
            instanceId: "76088827-c1f1-4451-bc2e-0a3ae7747434",
          }),
        },
      ),
    ).rejects.toMatchObject({ code: "DAEMON_IDENTITY_MISMATCH" });
    expect(harness.lines).toEqual([]);
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
      state: validState(daemonInfo({ protocolVersion: 2 })),
      alive: true,
    });

    await expect(runHeadlessDaemon({}, harness.deps)).rejects.toMatchObject({
      code: "DAEMON_PROTOCOL_MISMATCH",
      exitCode: 2,
    });
    expect(harness.startOptions).toEqual([]);
  });

  it("treats product-version skew as diagnostic when protocol and instance match", async () => {
    const info = daemonInfo();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const harness = createHarness({
      state: validState(info),
      alive: true,
      identity: {
        ok: true,
        pid: info.pid,
        protocolVersion: info.protocolVersion,
        productVersion: "9.9.9",
        instanceId: info.instanceId,
        startedAt: info.startedAt,
      },
      health: {
        ok: true,
        protocolVersion: info.protocolVersion,
        productVersion: "9.9.9",
        uptime: 42,
      },
    });

    await expect(
      runHeadlessDaemon({ json: true, expectedVersion: "8.8.8" }, harness.deps),
    ).resolves.toBe("already-running");
    expect(harness.startOptions).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not clear or replace a live owner whose health is unavailable", async () => {
    const harness = createHarness({
      state: validState(daemonInfo()),
      alive: true,
      health: null,
    });

    await expect(runHeadlessDaemon({}, harness.deps)).rejects.toMatchObject({
      code: "DAEMON_UNHEALTHY",
      exitCode: 1,
    });
    expect(harness.startOptions).toEqual([]);
  });

  it("rejects disagreement between discovery and health protocols", async () => {
    const harness = createHarness({
      state: validState(daemonInfo()),
      alive: true,
      health: { ok: true, protocolVersion: 2, productVersion: "2.8.0", uptime: 42 },
    });

    await expect(runHeadlessDaemon({}, harness.deps)).rejects.toMatchObject({
      code: "DAEMON_PROTOCOL_MISMATCH",
      exitCode: 2,
    });
    expect(harness.startOptions).toEqual([]);
  });

  it("refuses a live protocol-less canonical record instead of starting a second owner", async () => {
    const harness = createHarness({
      state: {
        status: "invalid",
        reason: "invalid-schema",
        detail: "protocolVersion is required",
        ownerPid: 321,
        observation: { dev: 1, ino: 1, size: 1, mtimeMs: 1 },
      },
      ownerProvenDead: false,
    });

    await expect(runHeadlessDaemon({}, harness.deps)).rejects.toMatchObject({
      code: "DAEMON_INFO_INVALID",
    });
    expect(harness.startOptions).toEqual([]);
  });

  it("allows the claimed starter to replace a securely read record whose owner is dead", async () => {
    const harness = createHarness({
      state: {
        status: "invalid",
        reason: "invalid-schema",
        detail: "legacy record",
        ownerPid: 999_999,
        observation: { dev: 1, ino: 1, size: 1, mtimeMs: 1 },
      },
      ownerProvenDead: true,
    });
    const running = runHeadlessDaemon({}, harness.deps);
    await vi.waitFor(() => expect(harness.lines).toHaveLength(1));
    harness.signals.get("SIGTERM")?.();
    await expect(running).resolves.toBe("stopped");
  });

  it("refuses endpoint identity disagreement before health reuse", async () => {
    const info = daemonInfo();
    const harness = createHarness({
      state: validState(info),
      alive: true,
      identity: {
        ok: true,
        pid: info.pid,
        protocolVersion: info.protocolVersion,
        productVersion: info.productVersion,
        instanceId: "76088827-c1f1-4451-bc2e-0a3ae7747434",
        startedAt: info.startedAt,
      },
    });

    await expect(runHeadlessDaemon({}, harness.deps)).rejects.toMatchObject({
      code: "DAEMON_IDENTITY_MISMATCH",
      exitCode: 2,
    });
    expect(harness.startOptions).toEqual([]);
  });
});
