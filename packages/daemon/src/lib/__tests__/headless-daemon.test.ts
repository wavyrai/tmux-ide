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
import {
  SIGNAL_STOP_DEADLINE_MS,
  SIGNAL_STOP_MAX_MS,
  SIGNAL_STOP_TIMEOUT_EXIT_CODE,
  runHeadlessDaemon,
  type HeadlessDaemonDependencies,
} from "../headless-daemon.ts";
import { _resetLogStateForTests, logger, structuredLogStream } from "../log.ts";

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
  it("cancels replacement recovery when shutdown is requested during retirement", async () => {
    const harness = createHarness();
    const start = harness.deps.startEmbeddedDaemon;
    const retired = deferred();
    let stopping = false;
    const running = runHeadlessDaemon(
      {},
      {
        ...harness.deps,
        startEmbeddedDaemon: async (options) => ({
          ...(await start(options)),
          tmuxAuthorityReplaced: async () => true,
          stop: async () => {
            stopping = true;
            await retired.promise;
          },
        }),
      },
    );
    await vi.waitFor(() => expect(stopping).toBe(true), { timeout: 2_000 });
    harness.signals.get("SIGTERM")?.();
    retired.resolve();
    await expect(running).resolves.toBe("stopped");
    expect(harness.startOptions).toHaveLength(1);
    expect(harness.signals.size).toBe(0);
  });

  it("retires the complete old generation before restarting for a replaced tmux authority", async () => {
    const harness = createHarness();
    const start = harness.deps.startEmbeddedDaemon;
    const events: string[] = [];
    let starts = 0;
    const retired = deferred();
    const running = runHeadlessDaemon(
      {},
      {
        ...harness.deps,
        startEmbeddedDaemon: async (options) => {
          const generation = ++starts;
          events.push(`start-${generation}`);
          const handle = await start(options);
          return {
            ...handle,
            tmuxAuthorityReplaced: async () => generation === 1,
            stop: async () => {
              events.push(`stop-${generation}`);
              if (generation === 1) await retired.promise;
            },
          };
        },
      },
    );
    await vi.waitFor(() => expect(events).toContain("stop-1"), { timeout: 2_000 });
    expect(starts).toBe(1);
    retired.resolve();
    await vi.waitFor(() => expect(starts).toBe(2));
    expect(events.slice(0, 3)).toEqual(["start-1", "stop-1", "start-2"]);
    expect(harness.startOptions[0]?.restoreTmuxWorkspaces).toBeUndefined();
    expect(harness.startOptions[1]?.restoreTmuxWorkspaces).toBe(true);
    harness.signals.get("SIGTERM")?.();
    await expect(running).resolves.toBe("stopped");
    expect(events.at(-1)).toBe("stop-2");
    expect(harness.signals.size).toBe(0);
  });

  it.each(["settings", "runtime"] as const)(
    "keeps %s restarts and later tmux recovery under the same lifecycle owner",
    async (kind) => {
      const harness = createHarness();
      const start = harness.deps.startEmbeddedDaemon;
      const retired = deferred();
      const events: string[] = [];
      let starts = 0;
      const running = runHeadlessDaemon(
        {},
        {
          ...harness.deps,
          startEmbeddedDaemon: async (options) => {
            const generation = ++starts;
            events.push(`start-${generation}`);
            const handle = await start(options);
            return {
              ...handle,
              tmuxAuthorityReplaced: async () => generation === 2,
              stop: async () => {
                events.push(`stop-${generation}`);
                if (generation === 1) await retired.promise;
              },
            };
          },
        },
      );
      try {
        await vi.waitFor(() => expect(harness.lines).toHaveLength(1));
        expect(harness.startOptions[0]?.requestRestart).toBeTypeOf("function");
        const restarting = harness.startOptions[0]!.requestRestart!({
          ...(kind === "runtime" ? { kind: "runtime" as const } : { enabled: true }),
          bindHostname: "0.0.0.0",
          token: "test-remote-token",
          port: 4321,
        });
        await vi.waitFor(() => expect(events).toContain("stop-1"));
        expect(starts).toBe(1);
        retired.resolve();
        await restarting;
        await vi.waitFor(() => expect(starts).toBe(3), { timeout: 2500 });
        expect(events.slice(0, 5)).toEqual(["start-1", "stop-1", "start-2", "stop-2", "start-3"]);
        for (const options of harness.startOptions.slice(1)) {
          expect(options).toMatchObject({
            port: 4321,
            bindHostname: "0.0.0.0",
            authToken: "test-remote-token",
            restoreTmuxWorkspaces: true,
          });
        }
      } finally {
        retired.resolve();
        harness.signals.get("SIGTERM")?.();
        await running;
      }
      expect(events.at(-1)).toBe("stop-3");
      expect(harness.signals.size).toBe(0);
    },
  );

  it("ignores a deferred runtime restart after the foreground owner was stopped", async () => {
    const harness = createHarness();
    const running = runHeadlessDaemon({}, harness.deps);
    await vi.waitFor(() => expect(harness.lines).toHaveLength(1));
    const deferredRestart = harness.startOptions[0]!.requestRestart!;
    harness.signals.get("SIGTERM")?.();
    await expect(running).resolves.toBe("stopped");
    await deferredRestart({
      kind: "runtime",
      bindHostname: "0.0.0.0",
      token: "retained-token",
      port: 4321,
    });
    expect(harness.startOptions).toHaveLength(1);
  });

  it.each(["signal", "failure"] as const)(
    "does not restart after settings retirement ends in %s",
    async (outcome) => {
      const harness = createHarness();
      const start = harness.deps.startEmbeddedDaemon;
      const retired = deferred();
      let stops = 0;
      const running = runHeadlessDaemon(
        {},
        {
          ...harness.deps,
          startEmbeddedDaemon: async (options) => ({
            ...(await start(options)),
            stop: async () => {
              stops++;
              await retired.promise;
              if (outcome === "failure") throw new Error("retirement failed");
            },
          }),
        },
      );
      const settled = running.then(
        (result) => result,
        (error: Error) => error.message,
      );
      await vi.waitFor(() => expect(harness.lines).toHaveLength(1));
      const request = { enabled: false, bindHostname: "127.0.0.1" as const, token: null };
      const retiring = harness.startOptions[0]!.requestRestart!(request).catch(
        (error: Error) => error.message,
      );
      await vi.waitFor(() => expect(stops).toBe(1));
      await harness.startOptions[0]!.requestRestart!(request);
      expect(stops).toBe(1);
      if (outcome === "signal") harness.signals.get("SIGTERM")?.();
      retired.resolve();
      await retiring;
      expect(await settled).toBe(outcome === "signal" ? "stopped" : "retirement failed");
      expect(harness.startOptions).toHaveLength(1);
      expect(harness.signals.size).toBe(0);
    },
  );

  it("uses a safe product-version fallback when bundled package metadata is unavailable", () => {
    expect(
      resolveDaemonProductVersion(undefined, () => {
        throw new Error("package.json is not bundled");
      }),
    ).toBe("0.0.0");
    expect(resolveDaemonProductVersion(" 2.8.0 ", () => ({ version: "ignored" }))).toBe("2.8.0");
    expect(resolveDaemonProductVersion(undefined, () => ({ version: 42 }))).toBe("0.0.0");
  });

  it("publishes managed ownership only after this process becomes ready", async () => {
    const harness = createHarness();
    const onOwnedReady = vi.fn();
    const running = runHeadlessDaemon({ json: true, onOwnedReady }, harness.deps);
    await vi.waitFor(() => expect(onOwnedReady).toHaveBeenCalledOnce());
    expect(onOwnedReady.mock.calls[0]![0]).toMatchObject({ pid: daemonInfo().pid });
    await harness.stop();
    await running;
  });

  it("reuses a compatible live canonical daemon without takeover", async () => {
    const harness = createHarness({ state: validState(daemonInfo()), alive: true });

    const onOwnedReady = vi.fn();
    await expect(runHeadlessDaemon({ json: true, onOwnedReady }, harness.deps)).resolves.toBe(
      "already-running",
    );
    expect(onOwnedReady).not.toHaveBeenCalled();

    expect(harness.startOptions).toEqual([]);
    expect(JSON.parse(harness.lines[0]!)).toEqual({
      status: "already-running",
      pid: 321,
      port: 4321,
      apiBaseUrl: "http://127.0.0.1:4321",
    });
  });

  it("waits for a freshly published canonical daemon to become attachable", async () => {
    const info = daemonInfo({ startedAt: new Date().toISOString() });
    const harness = createHarness({ state: validState(info), alive: true });
    const probeIdentity = harness.deps.probeCanonicalDaemonIdentity;
    let attempts = 0;

    await expect(
      runHeadlessDaemon(
        { json: true },
        {
          ...harness.deps,
          probeCanonicalDaemonIdentity: async (candidate) => {
            attempts += 1;
            if (attempts < 3) return null;
            return await probeIdentity(candidate);
          },
        },
      ),
    ).resolves.toBe("already-running");

    expect(attempts).toBe(3);
    expect(harness.startOptions).toEqual([]);
    expect(JSON.parse(harness.lines[0]!)).toMatchObject({
      status: "already-running",
      pid: info.pid,
    });
  });

  it("keeps its elected generation through a transient self-probe failure", async () => {
    const harness = createHarness();
    const probeIdentity = harness.deps.probeCanonicalDaemonIdentity;
    let attempts = 0;
    const running = runHeadlessDaemon(
      { json: true },
      {
        ...harness.deps,
        probeCanonicalDaemonIdentity: async (candidate) => {
          attempts += 1;
          if (attempts < 3) return null;
          return await probeIdentity(candidate);
        },
      },
    );

    await vi.waitFor(() => expect(harness.lines).toHaveLength(1));
    expect(attempts).toBe(3);
    expect(harness.startOptions).toHaveLength(1);
    expect(JSON.parse(harness.lines[0]!)).toMatchObject({ status: "ready", pid: 321 });

    harness.signals.get("SIGTERM")?.();
    await expect(running).resolves.toBe("stopped");
  });

  it("leaves stale removal to the claimed starter and stops on SIGTERM", async () => {
    const harness = createHarness({
      state: validState(daemonInfo({ pid: 999_999 })),
      alive: false,
    });
    const running = runHeadlessDaemon({ port: "4321", json: true }, harness.deps);
    await vi.waitFor(() => expect(harness.lines).toHaveLength(1));

    expect(harness.startOptions).toEqual([
      {
        launcher: "headless",
        plugins: true,
        port: 4321,
        bindHostname: "127.0.0.1",
        authToken: null,
        localBypassToken: expect.any(String),
        requestRestart: expect.any(Function),
        silent: true,
      },
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

  it("mints the bypass token in-process and never writes it to stdout", async () => {
    // The Electron supervisor consumes this stdout contract: the child mints
    // its own credentials and publishes them only via the owner-only daemon
    // record, so nothing secret may appear on the readiness line either.
    const harness = createHarness();
    const running = runHeadlessDaemon({ json: true }, harness.deps);
    await vi.waitFor(() => expect(harness.lines).toHaveLength(1));

    const mintedToken = harness.startOptions[0]?.localBypassToken;
    expect(typeof mintedToken).toBe("string");
    expect((mintedToken as string).length).toBeGreaterThanOrEqual(32);
    expect(Object.keys(JSON.parse(harness.lines[0]!)).sort()).toEqual([
      "apiBaseUrl",
      "pid",
      "port",
      "status",
    ]);
    for (const line of harness.lines) {
      expect(line).not.toContain(mintedToken as string);
      expect(line.toLowerCase()).not.toContain("token");
    }

    harness.signals.get("SIGTERM")?.();
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
      state: validState(daemonInfo({ protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION + 1 })),
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
      health: {
        ok: true,
        protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION + 1,
        productVersion: "2.8.0",
        uptime: 42,
      },
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

// #839: a signalled owner must end, even when its teardown never does.
describe("bounded stop on a signal", () => {
  const never = new Promise<void>(() => {});
  const stuck = {
    started: true,
    finished: false,
    elapsedMs: 40,
    stage: "interaction-observation",
    stageMs: 39,
    completed: [{ stage: "plugins", ms: 1 }],
    openSteps: [{ step: "default-owner:interaction-observation", ms: 39 }],
    stepsSettled: 4,
  };
  function bounded(deadlineMs = 40) {
    const harness = createHarness();
    const exit = vi.fn<(code: number) => void>();
    const abandon = vi.fn();
    const errors = vi.spyOn(logger, "error").mockImplementation(() => {});
    return {
      harness,
      exit,
      abandon,
      errors,
      deps: { ...harness.deps, exit, signalStopDeadlineMs: deadlineMs },
    };
  }

  it("has a deadline shorter than the 20 s a supervisor or the smoke step waits", () => {
    expect(SIGNAL_STOP_DEADLINE_MS).toBeGreaterThanOrEqual(5_000);
    expect(SIGNAL_STOP_DEADLINE_MS).toBeLessThan(20_000);
    // Under the 30 s that the launchd and systemd units allow before killing.
    expect(SIGNAL_STOP_MAX_MS).toBeGreaterThan(SIGNAL_STOP_DEADLINE_MS);
    expect(SIGNAL_STOP_MAX_MS).toBeLessThan(30_000);
    expect(SIGNAL_STOP_TIMEOUT_EXIT_CODE).not.toBe(0);
  });

  it("exits non-zero and says what was open when the first generation's stop never resolves", async () => {
    const f = bounded();
    const start = f.harness.deps.startEmbeddedDaemon;
    const running = runHeadlessDaemon(
      {},
      {
        ...f.deps,
        startEmbeddedDaemon: async (options) => ({
          ...(await start(options)),
          stop: () => never,
          stopDiagnostics: () => stuck,
          abandon: f.abandon,
        }),
      },
    );
    try {
      await vi.waitFor(() => expect(f.harness.lines).toHaveLength(1));
      f.harness.signals.get("SIGTERM")?.();
      expect(f.exit).not.toHaveBeenCalled();
      await expect(running).rejects.toMatchObject({
        code: "DAEMON_STOP_TIMEOUT",
        exitCode: SIGNAL_STOP_TIMEOUT_EXIT_CODE,
      });
      expect(f.exit).toHaveBeenCalledExactlyOnceWith(SIGNAL_STOP_TIMEOUT_EXIT_CODE);
      // daemon.json and the claim are withdrawn before the exit, not left stale.
      expect(f.abandon).toHaveBeenCalledTimes(1);
      expect(f.abandon.mock.invocationCallOrder[0]).toBeLessThan(
        f.exit.mock.invocationCallOrder[0]!,
      );
      expect(f.errors).toHaveBeenCalledExactlyOnceWith(
        "daemon-lifecycle",
        "stop missed the signal deadline; exiting anyway",
        expect.objectContaining({
          signal: "SIGTERM",
          deadlineMs: 40,
          generation: 1,
          startReason: "initial",
          phase: "stopping",
          stuckStage: "interaction-observation",
          stuckStageMs: 39,
          openSteps: [{ step: "default-owner:interaction-observation", ms: 39 }],
          stepsSettled: 4,
          completedStages: [{ stage: "plugins", ms: 1 }],
        }),
      );
      expect(f.harness.signals.size).toBe(0);
    } finally {
      f.errors.mockRestore();
    }
  });

  it("bounds the stop of a restart generation after the tmux server was replaced", async () => {
    const f = bounded();
    const start = f.harness.deps.startEmbeddedDaemon;
    let starts = 0;
    const abandoned: number[] = [];
    const running = runHeadlessDaemon(
      {},
      {
        ...f.deps,
        startEmbeddedDaemon: async (options) => {
          const generation = ++starts;
          return {
            ...(await start(options)),
            tmuxAuthorityReplaced: async () => generation === 1,
            stop: () => (generation === 1 ? Promise.resolve() : never),
            stopDiagnostics: () => stuck,
            abandon: () => void abandoned.push(generation),
          };
        },
      },
    );
    try {
      // The 1 s authority poll retires generation 1; generation 2 becomes ready.
      await vi.waitFor(() => expect(f.harness.lines).toHaveLength(2), { timeout: 3_000 });
      expect(starts).toBe(2);
      f.harness.signals.get("SIGTERM")?.();
      await expect(running).rejects.toMatchObject({ code: "DAEMON_STOP_TIMEOUT" });
      expect(f.exit).toHaveBeenCalledExactlyOnceWith(SIGNAL_STOP_TIMEOUT_EXIT_CODE);
      expect(abandoned).toEqual([2]);
      expect(f.errors).toHaveBeenCalledExactlyOnceWith(
        "daemon-lifecycle",
        expect.any(String),
        expect.objectContaining({
          generation: 2,
          startReason: "tmux-authority-replaced",
          phase: "stopping",
        }),
      );
      expect(f.harness.signals.size).toBe(0);
    } finally {
      f.errors.mockRestore();
    }
  });

  it("bounds a signal that arrives while a generation is still starting", async () => {
    const f = bounded();
    const running = runHeadlessDaemon({}, { ...f.deps, startEmbeddedDaemon: () => never as never });
    try {
      await vi.waitFor(() => expect(f.harness.signals.has("SIGINT")).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 5));
      f.harness.signals.get("SIGINT")?.();
      await expect(running).rejects.toMatchObject({ code: "DAEMON_STOP_TIMEOUT" });
      expect(f.exit).toHaveBeenCalledExactlyOnceWith(SIGNAL_STOP_TIMEOUT_EXIT_CODE);
      expect(f.errors).toHaveBeenCalledExactlyOnceWith(
        "daemon-lifecycle",
        expect.any(String),
        expect.objectContaining({ signal: "SIGINT", phase: "starting", stuckStage: null }),
      );
    } finally {
      f.errors.mockRestore();
    }
  });

  // Review B2 (D3): repeating the signal must not buy a hung teardown more time.
  it("keeps the first deadline when the signal is sent again and again", async () => {
    const f = bounded(80);
    const start = f.harness.deps.startEmbeddedDaemon;
    const running = runHeadlessDaemon(
      {},
      {
        ...f.deps,
        startEmbeddedDaemon: async (options) => ({
          ...(await start(options)),
          stop: () => never,
          stopDiagnostics: () => stuck,
          abandon: f.abandon,
        }),
      },
    );
    try {
      await vi.waitFor(() => expect(f.harness.lines).toHaveLength(1));
      const signalled = performance.now();
      f.harness.signals.get("SIGTERM")?.();
      const repeating = setInterval(() => {
        f.harness.signals.get("SIGTERM")?.();
        f.harness.signals.get("SIGINT")?.();
      }, 20);
      try {
        await expect(running).rejects.toMatchObject({ code: "DAEMON_STOP_TIMEOUT" });
      } finally {
        clearInterval(repeating);
      }
      // One 80 ms window from the FIRST signal; a re-armed timer would never fire here.
      expect(performance.now() - signalled).toBeLessThan(400);
      expect(f.exit).toHaveBeenCalledExactlyOnceWith(SIGNAL_STOP_TIMEOUT_EXIT_CODE);
      expect(f.errors).toHaveBeenCalledExactlyOnceWith(
        "daemon-lifecycle",
        expect.any(String),
        expect.objectContaining({ signal: "SIGTERM" }),
      );
    } finally {
      f.errors.mockRestore();
    }
  });

  // Review N1: a slow teardown that keeps settling steps is not a hang.
  it("renews the deadline while teardown steps keep settling, and lets that stop finish", async () => {
    const f = bounded(40);
    const start = f.harness.deps.startEmbeddedDaemon;
    let settled = 0;
    const running = runHeadlessDaemon(
      {},
      {
        ...f.deps,
        signalStopMaxMs: 2_000,
        startEmbeddedDaemon: async (options) => ({
          ...(await start(options)),
          // Four deadline windows long, one step settling every 20 ms.
          stop: async () => {
            for (let i = 0; i < 8; i += 1) {
              await new Promise((resolve) => setTimeout(resolve, 20));
              settled += 1;
            }
          },
          stopDiagnostics: () => ({ ...stuck, stepsSettled: settled }),
          abandon: f.abandon,
        }),
      },
    );
    try {
      await vi.waitFor(() => expect(f.harness.lines).toHaveLength(1));
      f.harness.signals.get("SIGTERM")?.();
      await expect(running).resolves.toBe("stopped");
      expect(settled).toBe(8);
      expect(f.exit).not.toHaveBeenCalled();
      expect(f.abandon).not.toHaveBeenCalled();
    } finally {
      f.errors.mockRestore();
    }
  });

  // Review N9: early progress must not double the wait for a teardown that then hangs.
  it("counts the deadline from the last step that settled, not from a fixed look", async () => {
    const f = bounded(120);
    const start = f.harness.deps.startEmbeddedDaemon;
    let settled = 0;
    const running = runHeadlessDaemon(
      {},
      {
        ...f.deps,
        signalStopMaxMs: 5_000,
        startEmbeddedDaemon: async (options) => ({
          ...(await start(options)),
          // The first stages finish at once, as in a real stop; then it hangs.
          stop: () => {
            setTimeout(() => (settled = 3), 20);
            return never;
          },
          stopDiagnostics: () => ({ ...stuck, stepsSettled: settled }),
          abandon: f.abandon,
        }),
      },
    );
    try {
      await vi.waitFor(() => expect(f.harness.lines).toHaveLength(1));
      const signalled = performance.now();
      f.harness.signals.get("SIGTERM")?.();
      await expect(running).rejects.toMatchObject({ code: "DAEMON_STOP_TIMEOUT" });
      const waited = performance.now() - signalled;
      // 120 ms after the progress at 20 ms; a fixed look every 120 ms would exit at 240.
      expect(waited).toBeGreaterThanOrEqual(120);
      expect(waited).toBeLessThan(210);
      expect(f.errors).toHaveBeenCalledExactlyOnceWith(
        "daemon-lifecycle",
        expect.any(String),
        expect.objectContaining({ deadlineMs: 120, maxMs: 5_000, stepsSettled: 3 }),
      );
    } finally {
      f.errors.mockRestore();
    }
  });

  it("caps a stop that keeps moving but never ends at the total bound", async () => {
    const f = bounded(40);
    const start = f.harness.deps.startEmbeddedDaemon;
    let settled = 0;
    const ticking = setInterval(() => (settled += 1), 10);
    const startedAt = performance.now();
    const running = runHeadlessDaemon(
      {},
      {
        ...f.deps,
        signalStopMaxMs: 130,
        startEmbeddedDaemon: async (options) => ({
          ...(await start(options)),
          stop: () => never,
          stopDiagnostics: () => ({ ...stuck, stepsSettled: settled }),
          abandon: f.abandon,
        }),
      },
    );
    try {
      await vi.waitFor(() => expect(f.harness.lines).toHaveLength(1));
      const signalled = performance.now();
      f.harness.signals.get("SIGTERM")?.();
      await expect(running).rejects.toMatchObject({ code: "DAEMON_STOP_TIMEOUT" });
      // It keeps moving, so only the total bound ends it: at 130 ms, not earlier.
      const waited = performance.now() - signalled;
      expect(waited).toBeGreaterThanOrEqual(125);
      expect(waited).toBeLessThan(1_000);
      expect(f.exit).toHaveBeenCalledExactlyOnceWith(SIGNAL_STOP_TIMEOUT_EXIT_CODE);
      expect(f.errors).toHaveBeenCalledExactlyOnceWith(
        "daemon-lifecycle",
        expect.any(String),
        expect.objectContaining({ deadlineMs: 40, maxMs: 130 }),
      );
      expect(startedAt).toBeLessThan(signalled);
    } finally {
      clearInterval(ticking);
      f.errors.mockRestore();
    }
  });

  it("lets a normal stop drain: no forced exit, no abandon, and the timer is gone afterwards", async () => {
    const f = bounded(60);
    const start = f.harness.deps.startEmbeddedDaemon;
    let drained = false;
    const running = runHeadlessDaemon(
      {},
      {
        ...f.deps,
        startEmbeddedDaemon: async (options) => ({
          ...(await start(options)),
          stop: async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            drained = true;
          },
          abandon: f.abandon,
        }),
      },
    );
    try {
      await vi.waitFor(() => expect(f.harness.lines).toHaveLength(1));
      f.harness.signals.get("SIGTERM")?.();
      await expect(running).resolves.toBe("stopped");
      expect(drained).toBe(true);
      // Well past the deadline: a cleared timer cannot fire late.
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(f.exit).not.toHaveBeenCalled();
      expect(f.abandon).not.toHaveBeenCalled();
      expect(f.errors).not.toHaveBeenCalled();
      expect(f.harness.signals.size).toBe(0);
    } finally {
      f.errors.mockRestore();
    }
  });
});

// #840: a generation that restarts in place is not a daemon shutdown.
describe("what a retiring generation tells its streams", () => {
  it("marks a tmux-authority restart as restarting and a signalled stop as a shutdown", async () => {
    const harness = createHarness();
    const start = harness.deps.startEmbeddedDaemon;
    const stops: unknown[] = [];
    let starts = 0;
    const running = runHeadlessDaemon(
      {},
      {
        ...harness.deps,
        startEmbeddedDaemon: async (options) => {
          const generation = ++starts;
          return {
            ...(await start(options)),
            tmuxAuthorityReplaced: async () => generation === 1,
            stop: async (stopOptions) => void stops.push(stopOptions),
          };
        },
      },
    );
    await vi.waitFor(() => expect(harness.lines).toHaveLength(2), { timeout: 3_000 });
    expect(stops).toEqual([{ restarting: true }]);
    harness.signals.get("SIGTERM")?.();
    await expect(running).resolves.toBe("stopped");
    expect(stops).toEqual([{ restarting: true }, undefined]);
  });

  it("does not call a restart interrupted by a signal a restart", async () => {
    const harness = createHarness();
    const start = harness.deps.startEmbeddedDaemon;
    const stops: unknown[] = [];
    const running = runHeadlessDaemon(
      {},
      {
        ...harness.deps,
        startEmbeddedDaemon: async (options) => ({
          ...(await start(options)),
          stop: async (stopOptions) => void stops.push(stopOptions),
        }),
      },
    );
    await vi.waitFor(() => expect(harness.lines).toHaveLength(1));
    harness.signals.get("SIGTERM")?.();
    await expect(running).resolves.toBe("stopped");
    expect(stops).toEqual([undefined]);
    expect(harness.startOptions).toHaveLength(1);
  });
});

// Bug sweep, section A: the port changed on an in-place restart, and a restart whose stop hung waited for ever.
describe("a restart in place", () => {
  const never = new Promise<void>(() => {});

  it("serves the next generation on the port the previous one had", async () => {
    const harness = createHarness();
    const start = harness.deps.startEmbeddedDaemon;
    let starts = 0;
    const running = runHeadlessDaemon(
      {},
      {
        ...harness.deps,
        startEmbeddedDaemon: async (options) => {
          const generation = ++starts;
          return { ...(await start(options)), tmuxAuthorityReplaced: async () => generation === 1 };
        },
      },
    );
    await vi.waitFor(() => expect(harness.lines).toHaveLength(2), { timeout: 3_000 });
    // Nobody asked for a port the first time; the second generation asks for the first one's.
    expect(harness.startOptions.map((options) => options.port)).toEqual([undefined, 4321]);
    harness.signals.get("SIGTERM")?.();
    await expect(running).resolves.toBe("stopped");
  });

  it("falls back to a free port when the previous one cannot be had again", async () => {
    const harness = createHarness();
    const start = harness.deps.startEmbeddedDaemon;
    const warned = vi.spyOn(logger, "warn").mockImplementation(() => {});
    let starts = 0;
    const running = runHeadlessDaemon(
      {},
      {
        ...harness.deps,
        startEmbeddedDaemon: async (options) => {
          const attempt = ++starts;
          if (attempt === 2) {
            harness.startOptions.push(options);
            throw Object.assign(new Error("listen EADDRINUSE 127.0.0.1:4321"), {
              code: "EADDRINUSE",
            });
          }
          return { ...(await start(options)), tmuxAuthorityReplaced: async () => attempt === 1 };
        },
      },
    );
    try {
      await vi.waitFor(() => expect(harness.lines).toHaveLength(2), { timeout: 3_000 });
      expect(harness.startOptions.map((options) => options.port)).toEqual([
        undefined,
        4321,
        undefined,
      ]);
      expect(warned).toHaveBeenCalledWith(
        "daemon-lifecycle",
        "could not keep the previous port; picking a free one",
        expect.objectContaining({ port: 4321, error: expect.stringContaining("EADDRINUSE") }),
      );
      harness.signals.get("SIGTERM")?.();
      await expect(running).resolves.toBe("stopped");
    } finally {
      warned.mockRestore();
    }
  });

  it("does not retry a port the caller asked for", async () => {
    const harness = createHarness();
    const failure = Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
    await expect(
      runHeadlessDaemon(
        { port: "4999" },
        {
          ...harness.deps,
          startEmbeddedDaemon: async (options) => {
            harness.startOptions.push(options);
            throw failure;
          },
        },
      ),
    ).rejects.toBe(failure);
    expect(harness.startOptions.map((options) => options.port)).toEqual([4999]);
  });

  it("ends the process when the old generation's teardown hangs, instead of serving nothing for ever", async () => {
    const harness = createHarness();
    const start = harness.deps.startEmbeddedDaemon;
    const exit = vi.fn<(code: number) => void>();
    const abandon = vi.fn();
    const errors = vi.spyOn(logger, "error").mockImplementation(() => {});
    const running = runHeadlessDaemon(
      {},
      {
        ...harness.deps,
        exit,
        signalStopDeadlineMs: 60,
        startEmbeddedDaemon: async (options) => ({
          ...(await start(options)),
          tmuxAuthorityReplaced: async () => true,
          stop: () => never,
          abandon,
        }),
      },
    );
    try {
      // No signal is ever sent: the 1 s authority poll starts the restart, and its stop hangs.
      await expect(running).rejects.toMatchObject({ code: "DAEMON_STOP_TIMEOUT" });
      expect(exit).toHaveBeenCalledExactlyOnceWith(SIGNAL_STOP_TIMEOUT_EXIT_CODE);
      expect(abandon).toHaveBeenCalledTimes(1);
      expect(errors).toHaveBeenCalledExactlyOnceWith(
        "daemon-lifecycle",
        expect.any(String),
        expect.objectContaining({
          signal: "restart",
          trigger: "tmux-authority-replaced",
          generation: 1,
          phase: "stopping",
        }),
      );
      expect(harness.startOptions).toHaveLength(1);
    } finally {
      errors.mockRestore();
    }
  });
});

describe("stdout of --headless --json", () => {
  it("is reserved for the status document: log records move to stderr only with --json", async () => {
    _resetLogStateForTests();
    try {
      const plain = createHarness();
      const first = runHeadlessDaemon({}, plain.deps);
      await vi.waitFor(() => expect(plain.lines).toHaveLength(1));
      expect(structuredLogStream()).toBe("stdout");
      plain.signals.get("SIGTERM")?.();
      await first;

      const json = createHarness();
      const second = runHeadlessDaemon({ json: true }, json.deps);
      await vi.waitFor(() => expect(json.lines).toHaveLength(1));
      expect(structuredLogStream()).toBe("stderr");
      expect(JSON.parse(json.lines[0]!)).toMatchObject({ status: "ready" });
      json.signals.get("SIGTERM")?.();
      await second;
    } finally {
      _resetLogStateForTests();
    }
  });
});

describe("supervised foreground generation handoff", () => {
  it.each(["runtime", "tmux", "failed-stop"])(
    "passes exact predecessor only after successful %s retirement",
    async (kind) => {
      const h = createHarness();
      const starts: EmbeddedDaemonOptions[] = [];
      let state: CanonicalDaemonInfoState = {
        status: "reserved",
        reservation: {
          kind: "supervised-reservation",
          version: 1,
          supervisionId: "fixture",
          reservationId: "11111111-1111-4111-8111-111111111111",
          reservedAt: "2026-09-17T00:00:00.000Z",
        },
        reason: "supervised-reservation",
        detail: "reserved",
        ownerPid: null,
        observation: { dev: 1, ino: 1, size: 1, mtimeMs: 1 },
      };
      let first: CanonicalDaemonInfoState | undefined;
      const retirement = deferred();
      let stopping = false;
      const deps: HeadlessDaemonDependencies = {
        ...h.deps,
        inspectCanonicalDaemonInfo: () => state,
        isCanonicalDaemonAlive: async () => true,
        probeCanonicalDaemonHealth: async () =>
          state.status === "valid"
            ? {
                ok: true,
                protocolVersion: state.info.protocolVersion,
                productVersion: state.info.productVersion,
                uptime: 1,
              }
            : null,
        probeCanonicalDaemonIdentity: async () =>
          state.status === "valid" ? { ok: true, ...state.info } : null,
        startEmbeddedDaemon: async (options) => {
          starts.push(options);
          const n = starts.length;
          const base = await h.deps.startEmbeddedDaemon(options);
          const info = daemonInfo({
            pid: process.pid,
            supervisionId: "fixture",
            instanceId:
              n === 1
                ? "11111111-1111-4111-8111-111111111111"
                : "22222222-2222-4222-8222-222222222222",
          });
          state = validState(info);
          if (n === 1) first = structuredClone(state);
          return {
            ...base,
            pid: info.pid,
            instanceId: info.instanceId,
            tmuxAuthorityReplaced: async () => kind === "tmux" && n === 1,
            stop: async () => {
              if (n === 1) {
                stopping = true;
                await retirement.promise;
                if (kind === "failed-stop") throw new Error("owned-stop-failed");
              }
            },
          };
        },
      };
      const running = runHeadlessDaemon({ supervisionId: "fixture" }, deps);
      void running.catch(() => undefined);
      try {
        await vi.waitFor(() => expect(h.lines).toHaveLength(1));
        expect(starts[0]!.predecessor).toBeUndefined();
        const request =
          kind !== "tmux"
            ? starts[0]!.requestRestart!({
                kind: "runtime",
                bindHostname: "127.0.0.1",
                token: null,
                port: 4321,
              })
            : Promise.resolve();
        await vi.waitFor(() => expect(stopping).toBe(true), { timeout: 2000 });
        expect(starts).toHaveLength(1);
        retirement.resolve();
        if (kind === "failed-stop") {
          await expect(request).rejects.toThrow("owned-stop-failed");
          await expect(running).rejects.toThrow("owned-stop-failed");
          expect(starts).toHaveLength(1);
          return;
        }
        await request;
        await vi.waitFor(() => expect(h.lines).toHaveLength(2));
        expect(starts[1]!.predecessor).toEqual(first);
        expect(starts[1]!.supervisionId).toBe("fixture");
      } finally {
        retirement.resolve();
        h.signals.get("SIGTERM")?.();
        if (kind === "failed-stop") await running.catch(() => undefined);
        else await running;
      }
    },
  );
  it("missing or mismatched reservation refuses before embedded startup", async () => {
    for (const state of [
      { status: "missing" as const },
      validState(daemonInfo({ supervisionId: "other" })),
    ]) {
      const h = createHarness({ state });
      await expect(runHeadlessDaemon({ supervisionId: "fixture" }, h.deps)).rejects.toMatchObject({
        code: "DAEMON_SUPERVISOR_RESERVATION_REQUIRED",
      });
      expect(h.startOptions).toHaveLength(0);
    }
  });
});
