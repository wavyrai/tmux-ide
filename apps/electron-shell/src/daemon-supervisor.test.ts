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
import {
  DesktopDaemonSupervisor,
  type DesktopDaemonSupervisorDependencies,
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

interface HarnessOptions {
  readonly states: readonly DesktopDaemonHostState[];
  readonly canonical: readonly CanonicalDaemonInfoState[];
  readonly child?: FakeChild;
  readonly claimAllowsStartupAttempt?: boolean;
  readonly ownerProvenDead?: boolean;
  readonly startupTimeoutMs?: number;
  readonly onCrash?: (snapshot: ReturnType<DesktopDaemonSupervisor["snapshot"]>) => void;
}

function harness(options: HarnessOptions) {
  const child = options.child ?? new FakeChild(5100);
  let time = 0;
  const inspectCanonical = vi.fn(sequence(options.canonical));
  const ownerProvenDead = vi.fn(async () => options.ownerProvenDead ?? true);
  const spawnChild = vi.fn(() => child as unknown as SpawnedDaemonChild);
  const dependencies: DesktopDaemonSupervisorDependencies = {
    claimAllowsStartupAttempt: () => options.claimAllowsStartupAttempt ?? true,
    inspectCanonical,
    ownerProvenDead,
    spawnChild,
    now: () => time,
    sleep: async (milliseconds) => {
      time += milliseconds;
    },
  };
  const supervisor = new DesktopDaemonSupervisor(
    {
      preflight: preflight(options.states),
      childEntryPath: "/packaged/daemon-child.cjs",
      productVersion: "2.8.0",
      startupTimeoutMs: options.startupTimeoutMs ?? 1_000,
      shutdownTimeoutMs: 10,
      probeTimeoutMs: 10,
      ...(options.onCrash ? { onOwnedDaemonCrash: options.onCrash } : {}),
    },
    dependencies,
  );
  return { supervisor, child, inspectCanonical, ownerProvenDead, spawnChild };
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
  });

  it.each(["record-invalid", "protocol-incompatible", "endpoint-not-loopback"] as const)(
    "fails closed without spawning for %s",
    async (code) => {
      const degraded: DesktopDaemonHostState = {
        status: "degraded",
        code,
        reason: "Canonical authority is not safe to replace.",
      };
      const setup = harness({ states: [degraded], canonical: [] });

      await expect(setup.supervisor.start()).resolves.toEqual(degraded);
      expect(setup.spawnChild).not.toHaveBeenCalled();
    },
  );

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
    expect(setup.supervisor.snapshot()).toMatchObject({
      phase: "unavailable",
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

    const snapshot = setup.supervisor.snapshot();
    expect(snapshot).toMatchObject({
      phase: "crashed",
      daemon: { status: "unavailable", code: "probe-failed" },
      child: {
        exitCode: 17,
        stdoutTruncated: true,
        stderrTruncated: true,
      },
    });
    expect(snapshot.child?.stdout.length).toBeLessThanOrEqual(64 * 1024);
    expect(snapshot.child?.stderr.length).toBeLessThanOrEqual(64 * 1024);
    expect(onCrash).toHaveBeenCalledOnce();
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
        sleep: async () => undefined,
      },
    );

    await expect(supervisor.start()).resolves.toMatchObject({
      status: "unavailable",
      code: "process-not-running",
    });
    expect(supervisor.snapshot()).toMatchObject({
      phase: "unavailable",
      ownedGeneration: null,
    });
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
});
