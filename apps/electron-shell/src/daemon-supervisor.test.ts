import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import {
  DAEMON_WIRE_PROTOCOL_VERSION,
  type CanonicalDaemonInfo,
  type DesktopDaemonHostState,
} from "@tmux-ide/contracts";
import { describe, expect, it, vi } from "vitest";

import type { CanonicalDaemonInfoState } from "../../../packages/daemon/src/canonical.ts";
import type { DaemonPreflight } from "./daemon-preflight.ts";
import type { DaemonRestartPolicy } from "./daemon-supervision-policy.ts";
import {
  DesktopDaemonSupervisor,
  type DesktopDaemonSupervisorDependencies,
  type DesktopDaemonSupervisorSnapshot,
  type SpawnedDaemonChild,
} from "./daemon-supervisor.ts";

const externalInfo: CanonicalDaemonInfo = {
  pid: 4100,
  port: 6060,
  protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
  productVersion: "2.8.0",
  instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
  startedAt: "2026-07-21T00:00:00.000Z",
  bindHostname: "127.0.0.1",
  authToken: "main-process-only",
};

const OWNED_GENERATION_ID = "0ae9c910-676b-4df0-9596-c8d9010de70a";
const STALE_SUCCESSOR_ID = "a81fe0bf-7722-4b1c-a7a0-a5ca047c3249";
const CRASHING_GENERATION_ID = "e15fa07d-f844-403c-88d1-446d796c87c9";
const RESTARTED_GENERATION_ID = "5b7a2f9c-4bfa-4a5b-9a83-2f6ce55f2a10";
const ONE_GENERATION_ID = "af5dc811-363e-4fc9-8a9f-11652caa3ded";

const connected = (info: CanonicalDaemonInfo): DesktopDaemonHostState => ({
  status: "connected",
  descriptor: {
    apiBaseUrl: `http://127.0.0.1:${info.port}`,
    protocolVersion: info.protocolVersion,
    productVersion: info.productVersion,
    instanceId: info.instanceId,
    startedAt: info.startedAt,
  },
});

const missing: DesktopDaemonHostState = {
  status: "unavailable",
  code: "record-missing",
  reason: "No canonical daemon record exists.",
};

const stale: DesktopDaemonHostState = {
  status: "unavailable",
  code: "process-not-running",
  reason: "The canonical daemon process is dead.",
};

const valid = (info: CanonicalDaemonInfo): CanonicalDaemonInfoState => ({
  status: "valid",
  info,
  observation: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
});

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
    this.emit("exit", null, signal);
    return true;
  });

  constructor(readonly pid: number) {
    super();
  }
}

function sequence<T>(values: readonly T[]): () => T {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

function preflight(states: readonly DesktopDaemonHostState[]): DaemonPreflight {
  const next = sequence(states);
  return { probe: vi.fn(async () => next()) };
}

/** A backoff wait that only stopOwned()'s cancellation can release. */
const parkedForever = (): Promise<void> => new Promise<void>(() => undefined);

interface HarnessOptions {
  readonly states: readonly DesktopDaemonHostState[];
  readonly canonical: readonly CanonicalDaemonInfoState[];
  readonly child?: FakeChild;
  readonly children?: readonly FakeChild[];
  readonly claimAllowsStartupAttempt?: boolean;
  readonly ownerProvenDead?: boolean;
  readonly startupTimeoutMs?: number;
  readonly restartPolicy?: Partial<DaemonRestartPolicy>;
  /**
   * By default restart backoff waits park until quit so settled tests stay
   * deterministic; restart-focused tests let the loop progress instantly.
   */
  readonly parkBackoff?: boolean;
  readonly onCrash?: (snapshot: DesktopDaemonSupervisorSnapshot) => void;
  readonly onSupervisedChange?: (snapshot: DesktopDaemonSupervisorSnapshot) => void;
}

function harness(options: HarnessOptions) {
  const children = options.children ?? [options.child ?? new FakeChild(5100)];
  const parkBackoff = options.parkBackoff ?? true;
  let time = 0;
  let spawnIndex = 0;
  const sleeps: number[] = [];
  const probe = preflight(options.states);
  const inspectCanonical = vi.fn(sequence(options.canonical));
  const ownerProvenDead = vi.fn(async () => options.ownerProvenDead ?? true);
  const spawnChild = vi.fn(
    () => children[Math.min(spawnIndex++, children.length - 1)] as unknown as SpawnedDaemonChild,
  );
  const dependencies: DesktopDaemonSupervisorDependencies = {
    claimAllowsStartupAttempt: () => options.claimAllowsStartupAttempt ?? true,
    inspectCanonical,
    ownerProvenDead,
    spawnChild,
    now: () => time,
    sleep: (milliseconds) => {
      sleeps.push(milliseconds);
      time += milliseconds;
      if (milliseconds >= 500) {
        if (parkBackoff) return parkedForever();
        // Yield a macrotask so an ongoing retry loop cannot starve timers.
        return new Promise((resolve) => setTimeout(resolve, 0));
      }
      return Promise.resolve();
    },
    // Deterministic jitter midpoint: computed delays equal their base value.
    random: () => 0.5,
  };
  const supervisor = new DesktopDaemonSupervisor(
    {
      preflight: probe,
      childEntryPath: "/packaged/daemon-child.cjs",
      productVersion: "2.8.0",
      startupTimeoutMs: options.startupTimeoutMs ?? 1_000,
      shutdownTimeoutMs: 10,
      probeTimeoutMs: 10,
      ...(options.restartPolicy ? { restartPolicy: options.restartPolicy } : {}),
      ...(options.onCrash ? { onOwnedDaemonCrash: options.onCrash } : {}),
      ...(options.onSupervisedChange
        ? { onSupervisedDaemonStateChanged: options.onSupervisedChange }
        : {}),
    },
    dependencies,
  );
  return {
    supervisor,
    child: children[0]!,
    children,
    sleeps,
    probe,
    inspectCanonical,
    ownerProvenDead,
    spawnChild,
  };
}

describe("Electron canonical daemon supervisor", () => {
  it("attaches to a verified external daemon and never spawns or signals it", async () => {
    const setup = harness({ states: [connected(externalInfo)], canonical: [] });

    await expect(setup.supervisor.start()).resolves.toEqual(connected(externalInfo));
    await setup.supervisor.stopOwned();

    expect(setup.spawnChild).not.toHaveBeenCalled();
    expect(setup.child.kill).not.toHaveBeenCalled();
    expect(setup.supervisor.snapshot()).toMatchObject({
      phase: "stopped",
      ownedGeneration: null,
    });
  });

  it("spawns from a securely missing record and records the exact child generation", async () => {
    const ownedInfo = { ...externalInfo, pid: 5100, instanceId: OWNED_GENERATION_ID };
    const setup = harness({
      states: [missing, connected(ownedInfo)],
      canonical: [{ status: "missing" }, valid(ownedInfo)],
    });

    await expect(setup.supervisor.start()).resolves.toEqual(connected(ownedInfo));

    expect(setup.spawnChild).toHaveBeenCalledWith("/packaged/daemon-child.cjs", "2.8.0");
    expect(setup.supervisor.snapshot()).toMatchObject({
      phase: "owned",
      ownedGeneration: {
        pid: 5100,
        instanceId: OWNED_GENERATION_ID,
        startedAt: ownedInfo.startedAt,
      },
      supervision: { consecutiveFailures: 0, consecutiveFatalFailures: 0, fatalReason: null },
    });

    await setup.supervisor.stopOwned();
    expect(setup.child.kill).toHaveBeenCalledOnce();
    expect(setup.child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("replaces a valid stale record only after its exact owner is proven dead", async () => {
    const ownedInfo = { ...externalInfo, pid: 5100, instanceId: STALE_SUCCESSOR_ID };
    const setup = harness({
      states: [stale, connected(ownedInfo)],
      canonical: [valid(externalInfo), valid(ownedInfo)],
      ownerProvenDead: true,
    });

    await expect(setup.supervisor.start()).resolves.toEqual(connected(ownedInfo));
    expect(setup.ownerProvenDead).toHaveBeenCalledOnce();
    expect(setup.supervisor.snapshot().phase).toBe("owned");
  });

  it("does not spawn when stale-owner liveness is unknown", async () => {
    const setup = harness({
      states: [stale, stale],
      canonical: [valid(externalInfo)],
      ownerProvenDead: false,
    });

    await expect(setup.supervisor.start()).resolves.toEqual(stale);
    expect(setup.spawnChild).not.toHaveBeenCalled();
    // The failure is transient, so the supervisor keeps a bounded retry
    // pending rather than giving up; quit cancels it.
    expect(setup.supervisor.snapshot().phase).toBe("restarting");
    await setup.supervisor.stopOwned();
    expect(setup.spawnChild).not.toHaveBeenCalled();
  });

  it("does not spawn while a startup claim is live, unknown, or malformed", async () => {
    const setup = harness({
      states: [missing, missing],
      canonical: [],
      claimAllowsStartupAttempt: false,
    });

    await expect(setup.supervisor.start()).resolves.toEqual(missing);
    expect(setup.inspectCanonical).not.toHaveBeenCalled();
    expect(setup.spawnChild).not.toHaveBeenCalled();
    await setup.supervisor.stopOwned();
  });

  it.each([
    ["record-invalid", "record-invalid"],
    ["protocol-incompatible", "protocol-incompatible"],
    ["endpoint-not-loopback", "endpoint-not-loopback"],
  ] as const)(
    "halts with a typed reason instead of retrying %s forever",
    async (code, fatalReason) => {
      const degraded: DesktopDaemonHostState = {
        status: "degraded",
        code,
        reason: "Canonical authority is not safe to replace.",
      };
      const onSupervisedChange = vi.fn();
      const setup = harness({
        states: [degraded],
        canonical: [],
        parkBackoff: false,
        onSupervisedChange,
      });

      await expect(setup.supervisor.start()).resolves.toEqual(degraded);
      await vi.waitFor(() => expect(setup.supervisor.snapshot().phase).toBe("halted"));

      expect(setup.spawnChild).not.toHaveBeenCalled();
      expect(setup.probe.probe).toHaveBeenCalledTimes(3);
      expect(setup.supervisor.snapshot()).toMatchObject({
        phase: "halted",
        daemon: { status: "degraded", code: "supervisor-halted" },
        supervision: { consecutiveFatalFailures: 3, fatalReason },
      });
      const halted = setup.supervisor.snapshot().daemon;
      expect(halted?.status === "degraded" && halted.reason).toContain(fatalReason);
      expect(halted?.status === "degraded" && halted.reason).toContain(
        "Canonical authority is not safe to replace.",
      );
      expect(onSupervisedChange).toHaveBeenCalled();
      expect(onSupervisedChange.mock.calls.at(-1)?.[0]).toMatchObject({ phase: "halted" });

      // Halted is terminal: no further probes or restart attempts happen.
      await Promise.resolve();
      await Promise.resolve();
      expect(setup.probe.probe).toHaveBeenCalledTimes(3);
      await setup.supervisor.stopOwned();
    },
  );

  it("keeps retrying transient failures with growing bounded backoff and never halts", async () => {
    const ownedInfo = { ...externalInfo, pid: 5100, instanceId: CRASHING_GENERATION_ID };
    const setup = harness({
      states: [missing, connected(ownedInfo), stale],
      canonical: [{ status: "missing" }, valid(ownedInfo), valid(ownedInfo)],
      ownerProvenDead: false,
      parkBackoff: false,
    });

    await expect(setup.supervisor.start()).resolves.toEqual(connected(ownedInfo));
    setup.child.emit("exit", 11, null);

    await vi.waitFor(() => {
      expect(setup.sleeps.filter((ms) => ms >= 500).length).toBeGreaterThanOrEqual(3);
    });
    await setup.supervisor.stopOwned();

    const backoffs = setup.sleeps.filter((ms) => ms >= 500);
    expect(backoffs.slice(0, 3)).toEqual([500, 1_000, 2_000]);
    expect(setup.spawnChild).toHaveBeenCalledOnce();
    expect(setup.supervisor.snapshot().supervision).toMatchObject({
      consecutiveFatalFailures: 0,
      fatalReason: null,
    });
  });

  it("restarts an owned daemon after a crash and owns the replacement generation", async () => {
    const crashed = { ...externalInfo, pid: 5100, instanceId: CRASHING_GENERATION_ID };
    const restarted = { ...externalInfo, pid: 5200, instanceId: RESTARTED_GENERATION_ID };
    const onCrash = vi.fn();
    const onSupervisedChange = vi.fn();
    const setup = harness({
      states: [missing, connected(crashed), stale, connected(restarted)],
      canonical: [{ status: "missing" }, valid(crashed), valid(crashed), valid(restarted)],
      children: [new FakeChild(5100), new FakeChild(5200)],
      ownerProvenDead: true,
      parkBackoff: false,
      onCrash,
      onSupervisedChange,
    });

    await expect(setup.supervisor.start()).resolves.toEqual(connected(crashed));
    setup.children[0]!.emit("exit", null, "SIGKILL");

    expect(onCrash).toHaveBeenCalledOnce();
    expect(onCrash.mock.calls[0]?.[0]).toMatchObject({ phase: "crashed" });

    await vi.waitFor(() => {
      expect(setup.supervisor.snapshot()).toMatchObject({
        phase: "owned",
        ownedGeneration: { pid: 5200, instanceId: RESTARTED_GENERATION_ID },
      });
    });
    expect(setup.sleeps).toContain(500);
    expect(setup.spawnChild).toHaveBeenCalledTimes(2);
    expect(setup.supervisor.snapshot().supervision).toMatchObject({
      consecutiveFailures: 0,
      consecutiveFatalFailures: 0,
      fatalReason: null,
    });
    expect(onSupervisedChange.mock.calls.at(-1)?.[0]).toMatchObject({ phase: "owned" });

    await setup.supervisor.stopOwned();
    expect(setup.children[1]!.kill).toHaveBeenCalledWith("SIGTERM");
    expect(setup.children[0]!.kill).not.toHaveBeenCalled();
  });

  it("cancels a pending restart backoff on quit without spawning again", async () => {
    const ownedInfo = { ...externalInfo, pid: 5100, instanceId: OWNED_GENERATION_ID };
    const setup = harness({
      states: [missing, connected(ownedInfo)],
      canonical: [{ status: "missing" }, valid(ownedInfo)],
    });

    await expect(setup.supervisor.start()).resolves.toEqual(connected(ownedInfo));
    setup.child.emit("exit", 3, null);
    expect(setup.supervisor.snapshot().phase).toBe("restarting");

    await setup.supervisor.stopOwned();

    expect(setup.spawnChild).toHaveBeenCalledOnce();
    expect(setup.supervisor.snapshot()).toMatchObject({ phase: "stopped", ownedGeneration: null });
  });

  it("re-runs secure preflight instead of spawning when authority appears in the race window", async () => {
    const setup = harness({
      states: [missing, connected(externalInfo)],
      canonical: [valid(externalInfo)],
    });

    await expect(setup.supervisor.start()).resolves.toEqual(connected(externalInfo));
    expect(setup.spawnChild).not.toHaveBeenCalled();
    expect(setup.supervisor.snapshot().phase).toBe("attached");
  });

  it("attaches to a canonical race winner but stops only its own losing child", async () => {
    const setup = harness({
      states: [missing, connected(externalInfo)],
      canonical: [{ status: "missing" }, valid(externalInfo)],
    });

    await expect(setup.supervisor.start()).resolves.toEqual(connected(externalInfo));
    expect(setup.supervisor.snapshot().ownedGeneration).toBeNull();
    expect(setup.child.kill).toHaveBeenCalledWith("SIGTERM");
    await setup.supervisor.stopOwned();
    expect(setup.child.kill).toHaveBeenCalledOnce();
  });

  it("bounds startup with backoff and terminates only the spawned child on timeout", async () => {
    const setup = harness({
      states: [missing],
      canonical: [{ status: "missing" }],
      startupTimeoutMs: 50,
    });

    await expect(setup.supervisor.start()).resolves.toMatchObject({
      status: "unavailable",
      code: "probe-timeout",
    });
    expect(setup.child.kill).toHaveBeenCalledWith("SIGTERM");
    // A readiness timeout is transient: a bounded retry is pending, not a
    // permanent unavailable verdict.
    expect(setup.supervisor.snapshot().phase).toBe("restarting");
    await setup.supervisor.stopOwned();
    expect(setup.supervisor.snapshot()).toMatchObject({
      phase: "stopped",
      ownedGeneration: null,
    });
  });

  it("captures bounded child diagnostics and publishes an explicit owned-daemon crash state", async () => {
    const onCrash = vi.fn();
    const ownedInfo = { ...externalInfo, pid: 5100, instanceId: CRASHING_GENERATION_ID };
    const setup = harness({
      states: [missing, connected(ownedInfo)],
      canonical: [{ status: "missing" }, valid(ownedInfo)],
      onCrash,
    });
    await setup.supervisor.start();
    setup.child.stdout.write(Buffer.alloc(70 * 1024, "o"));
    setup.child.stderr.write(Buffer.alloc(70 * 1024, "e"));

    setup.child.emit("exit", 17, null);

    expect(onCrash).toHaveBeenCalledOnce();
    const crashSnapshot = onCrash.mock.calls[0]?.[0] as DesktopDaemonSupervisorSnapshot;
    expect(crashSnapshot).toMatchObject({
      phase: "crashed",
      daemon: { status: "unavailable", code: "probe-failed" },
      child: {
        exitCode: 17,
        stdoutTruncated: true,
        stderrTruncated: true,
      },
    });
    expect(crashSnapshot.child?.stdout.length).toBeLessThanOrEqual(64 * 1024);
    expect(crashSnapshot.child?.stderr.length).toBeLessThanOrEqual(64 * 1024);
    // After publishing the crash the supervisor immediately schedules the
    // bounded restart rather than staying in a dead-end state.
    expect(setup.supervisor.snapshot()).toMatchObject({
      phase: "restarting",
      daemon: { status: "unavailable", code: "probe-failed" },
    });
    await setup.supervisor.stopOwned();
  });

  it("does not claim ownership when the child exits inside the readiness handoff", async () => {
    const child = new FakeChild(5100);
    const ownedInfo = { ...externalInfo, pid: 5100, instanceId: OWNED_GENERATION_ID };
    let inspection = 0;
    const supervisor = new DesktopDaemonSupervisor(
      {
        preflight: preflight([missing, connected(ownedInfo)]),
        childEntryPath: "/packaged/daemon-child.cjs",
        productVersion: "2.8.0",
        probeTimeoutMs: 10,
      },
      {
        claimAllowsStartupAttempt: () => true,
        inspectCanonical: () => {
          inspection += 1;
          if (inspection === 1) return { status: "missing" };
          child.emit("exit", 1, null);
          return valid(ownedInfo);
        },
        ownerProvenDead: async () => true,
        spawnChild: () => child as unknown as SpawnedDaemonChild,
        now: () => 0,
        sleep: (ms) => (ms >= 500 ? parkedForever() : Promise.resolve()),
        random: () => 0.5,
      },
    );

    await expect(supervisor.start()).resolves.toMatchObject({
      status: "unavailable",
      code: "process-not-running",
    });
    expect(supervisor.snapshot()).toMatchObject({
      phase: "restarting",
      ownedGeneration: null,
    });
    await supervisor.stopOwned();
  });

  it("cancels and stops the exact spawned child when quit wins the ownership handoff", async () => {
    const child = new FakeChild(5100);
    const ownedInfo = { ...externalInfo, pid: 5100, instanceId: OWNED_GENERATION_ID };
    let releaseReadiness!: (state: DesktopDaemonHostState) => void;
    const readiness = new Promise<DesktopDaemonHostState>((resolve) => {
      releaseReadiness = resolve;
    });
    const daemonPreflight: DaemonPreflight = {
      probe: vi
        .fn<() => Promise<DesktopDaemonHostState>>()
        .mockResolvedValueOnce(missing)
        .mockImplementationOnce(() => readiness),
    };
    const supervisor = new DesktopDaemonSupervisor(
      {
        preflight: daemonPreflight,
        childEntryPath: "/packaged/daemon-child.cjs",
        productVersion: "2.8.0",
        probeTimeoutMs: 10_000,
        shutdownTimeoutMs: 10,
      },
      {
        claimAllowsStartupAttempt: () => true,
        inspectCanonical: sequence([{ status: "missing" }, valid(ownedInfo)]),
        ownerProvenDead: async () => true,
        spawnChild: () => child as unknown as SpawnedDaemonChild,
        now: () => 0,
        sleep: async () => undefined,
        random: () => 0.5,
      },
    );

    const starting = supervisor.start();
    await vi.waitFor(() => expect(daemonPreflight.probe).toHaveBeenCalledTimes(2));
    expect(supervisor.snapshot()).toMatchObject({ phase: "starting", ownedGeneration: null });

    const stopping = supervisor.stopOwned();
    releaseReadiness(connected(ownedInfo));
    await Promise.all([starting, stopping]);

    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(supervisor.snapshot()).toMatchObject({ phase: "stopped", ownedGeneration: null });
  });

  it("never starts after shutdown was requested before startup", async () => {
    const setup = harness({ states: [missing], canonical: [{ status: "missing" }] });

    await setup.supervisor.stopOwned();
    await setup.supervisor.start();

    expect(setup.spawnChild).not.toHaveBeenCalled();
    expect(setup.supervisor.snapshot()).toMatchObject({ phase: "stopped", ownedGeneration: null });
  });

  it("deduplicates concurrent start and quit calls", async () => {
    const ownedInfo = { ...externalInfo, pid: 5100, instanceId: ONE_GENERATION_ID };
    const setup = harness({
      states: [missing, connected(ownedInfo)],
      canonical: [{ status: "missing" }, valid(ownedInfo)],
    });

    const first = setup.supervisor.start();
    const second = setup.supervisor.start();
    expect(first).toBe(second);
    await first;
    await Promise.all([setup.supervisor.stopOwned(), setup.supervisor.stopOwned()]);

    expect(setup.spawnChild).toHaveBeenCalledOnce();
    expect(setup.child.kill).toHaveBeenCalledOnce();
  });

  it("classifies a structural child exit as fatal and halts at the ceiling", async () => {
    // Every attempt spawns a child that exits with the structural code 2
    // during the readiness barrier (protocol/identity refusal in the child).
    const children = [new FakeChild(5100), new FakeChild(5101), new FakeChild(5102)];
    let spawnIndex = 0;
    const probe = preflight([missing]);
    const supervisor = new DesktopDaemonSupervisor(
      {
        preflight: probe,
        childEntryPath: "/packaged/daemon-child.cjs",
        productVersion: "2.8.0",
        startupTimeoutMs: 1_000,
        shutdownTimeoutMs: 10,
        probeTimeoutMs: 10,
      },
      {
        claimAllowsStartupAttempt: () => true,
        inspectCanonical: () => ({ status: "missing" }),
        ownerProvenDead: async () => true,
        spawnChild: () => {
          const child = children[Math.min(spawnIndex++, children.length - 1)]!;
          queueMicrotask(() => child.emit("exit", 2, null));
          return child as unknown as SpawnedDaemonChild;
        },
        now: () => 0,
        sleep: async () => undefined,
        random: () => 0.5,
      },
    );

    await supervisor.start();
    await vi.waitFor(() => expect(supervisor.snapshot().phase).toBe("halted"));

    expect(spawnIndex).toBe(3);
    expect(supervisor.snapshot()).toMatchObject({
      phase: "halted",
      daemon: { status: "degraded", code: "supervisor-halted" },
      supervision: { consecutiveFatalFailures: 3, fatalReason: "child-fatal-exit" },
    });
    await supervisor.stopOwned();
  });
});
