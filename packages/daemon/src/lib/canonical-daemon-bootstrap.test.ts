import { describe, expect, it, vi } from "vitest";
import { DAEMON_WIRE_PROTOCOL_VERSION } from "@tmux-ide/contracts";
import type { CanonicalDaemonInfo } from "./canonical-daemon.ts";
import {
  createCanonicalDaemonBootstrapCoordinator,
  ensureCanonicalDaemon,
} from "./canonical-daemon-bootstrap.ts";

const info: CanonicalDaemonInfo = {
  pid: 42,
  port: 6060,
  protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
  productVersion: "2.8.0",
  instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
  startedAt: "2026-08-12T00:00:00.000Z",
  bindHostname: "127.0.0.1",
  authToken: "owner",
};

describe("canonical daemon bootstrap adapter", () => {
  it("reuses a generation only after identity and protocol proof", async () => {
    const spawnOwner = vi.fn(async () => undefined);
    const coordinator = createCanonicalDaemonBootstrapCoordinator(
      { entryPath: "/tmp/cli.js" },
      {
        inspect: () => ({ status: "valid", info, observation: { path: "/tmp/daemon.json" } }),
        alive: async () => true,
        identity: async () => ({
          ok: true,
          pid: info.pid,
          protocolVersion: info.protocolVersion,
          productVersion: info.productVersion,
          instanceId: info.instanceId,
          startedAt: info.startedAt,
        }),
        health: async () => ({
          ok: true,
          protocolVersion: info.protocolVersion,
          productVersion: info.productVersion,
          uptime: 1,
        }),
        spawnOwner,
      },
    );
    await expect(coordinator.ensure()).resolves.toMatchObject({
      candidate: info,
      source: "existing",
    });
    expect(spawnOwner).not.toHaveBeenCalled();
  });

  it("spawns the sole headless owner and waits for publication", async () => {
    let published = false;
    const coordinator = createCanonicalDaemonBootstrapCoordinator(
      { entryPath: "/tmp/cli.js", timeoutMs: 100 },
      {
        inspect: () =>
          published
            ? ({ status: "valid", info, observation: { path: "/tmp/daemon.json" } } as const)
            : ({ status: "missing", observation: { path: "/tmp/daemon.json" } } as const),
        spawnOwner: async () => {
          published = true;
        },
        alive: async () => true,
        identity: async () => ({
          ok: true,
          pid: info.pid,
          protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
          productVersion: "2.8.0",
          instanceId: info.instanceId,
          startedAt: info.startedAt,
        }),
        health: async () => ({
          ok: true,
          protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
          productVersion: "2.8.0",
          uptime: 1,
        }),
      },
    );
    await expect(coordinator.ensure()).resolves.toMatchObject({
      source: "started",
      candidate: info,
    });
  });

  it("retires an exact older protocol owner before spawning the current generation", async () => {
    const events: string[] = [];
    const older = { ...info, protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION - 1 };
    const current = { ...info, pid: 84, instanceId: "1d78b1af-d7b7-4d30-84af-54e337f02b49" };
    let state: "older" | "missing" | "current" = "older";
    const result = await ensureCanonicalDaemon(
      { entryPath: "/tmp/cli.js", timeoutMs: 100 },
      {
        inspect: () =>
          state === "missing"
            ? { status: "missing", observation: { path: "/tmp/daemon.json" } }
            : {
                status: "valid",
                info: state === "older" ? older : current,
                observation: { path: "/tmp/daemon.json" },
              },
        alive: async (candidate) =>
          (state === "older" && candidate.instanceId === older.instanceId) ||
          (state === "current" && candidate.instanceId === current.instanceId),
        identity: async (candidate) => ({
          ok: true,
          pid: candidate.pid,
          protocolVersion: candidate.protocolVersion,
          productVersion: candidate.productVersion,
          instanceId: candidate.instanceId,
          startedAt: candidate.startedAt,
        }),
        health: async (candidate) => ({
          ok: true,
          protocolVersion: candidate.protocolVersion,
          productVersion: candidate.productVersion,
          uptime: 1,
        }),
        shutdownOlderOwner: async (candidate) => {
          expect(candidate).toBe(older);
          events.push("shutdown-older");
          state = "missing";
        },
        spawnOwner: async () => {
          events.push("spawn-current");
          state = "current";
        },
        now: (() => {
          let now = 0;
          return () => now++;
        })(),
        sleep: async () => undefined,
      },
    );
    expect(events).toEqual(["shutdown-older", "spawn-current"]);
    expect(result).toMatchObject({ source: "started", candidate: current });
  });

  it("never lets an older client retire a newer protocol owner", async () => {
    const newer = { ...info, protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION + 1 };
    const shutdownOlderOwner = vi.fn(async () => undefined);
    await expect(
      ensureCanonicalDaemon(
        { entryPath: "/tmp/cli.js", timeoutMs: 100 },
        {
          inspect: () => ({
            status: "valid",
            info: newer,
            observation: { path: "/tmp/daemon.json" },
          }),
          alive: async () => true,
          identity: async () => ({
            ok: true,
            pid: newer.pid,
            protocolVersion: newer.protocolVersion,
            productVersion: newer.productVersion,
            instanceId: newer.instanceId,
            startedAt: newer.startedAt,
          }),
          health: async () => ({
            ok: true,
            protocolVersion: newer.protocolVersion,
            productVersion: newer.productVersion,
            uptime: 1,
          }),
          shutdownOlderOwner,
        },
      ),
    ).rejects.toMatchObject({ code: "incompatible", reason: "protocol-mismatch" });
    expect(shutdownOlderOwner).not.toHaveBeenCalled();
  });

  it("adopts a current generation installed by a concurrent upgrader", async () => {
    const older = { ...info, protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION - 1 };
    const current = { ...info, pid: 84, instanceId: "1d78b1af-d7b7-4d30-84af-54e337f02b49" };
    let inspections = 0;
    const shutdownOlderOwner = vi.fn(async () => undefined);
    const result = await ensureCanonicalDaemon(
      { entryPath: "/tmp/cli.js", timeoutMs: 100 },
      {
        inspect: () => ({
          status: "valid",
          info: inspections++ === 0 ? older : current,
          observation: { path: "/tmp/daemon.json" },
        }),
        alive: async () => true,
        identity: async (candidate) => ({
          ok: true,
          pid: candidate.pid,
          protocolVersion: candidate.protocolVersion,
          productVersion: candidate.productVersion,
          instanceId: candidate.instanceId,
          startedAt: candidate.startedAt,
        }),
        health: async (candidate) => ({
          ok: true,
          protocolVersion: candidate.protocolVersion,
          productVersion: candidate.productVersion,
          uptime: 1,
        }),
        shutdownOlderOwner,
      },
    );

    expect(result).toMatchObject({ source: "existing", candidate: current });
    expect(shutdownOlderOwner).not.toHaveBeenCalled();
  });

  it("starts current after a concurrent upgrader removes the old record", async () => {
    const older = { ...info, protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION - 1 };
    const current = { ...info, pid: 84, instanceId: "1d78b1af-d7b7-4d30-84af-54e337f02b49" };
    let inspections = 0;
    const spawnOwner = vi.fn(async () => undefined);
    const result = await ensureCanonicalDaemon(
      { entryPath: "/tmp/cli.js", timeoutMs: 100 },
      {
        inspect: () => {
          inspections += 1;
          if (inspections === 1) {
            return {
              status: "valid" as const,
              info: older,
              observation: { path: "/tmp/daemon.json" },
            };
          }
          if (inspections <= 3) {
            return { status: "missing" as const, observation: { path: "/tmp/daemon.json" } };
          }
          return {
            status: "valid" as const,
            info: current,
            observation: { path: "/tmp/daemon.json" },
          };
        },
        alive: async () => true,
        identity: async (candidate) => ({
          ok: true,
          pid: candidate.pid,
          protocolVersion: candidate.protocolVersion,
          productVersion: candidate.productVersion,
          instanceId: candidate.instanceId,
          startedAt: candidate.startedAt,
        }),
        health: async (candidate) => ({
          ok: true,
          protocolVersion: candidate.protocolVersion,
          productVersion: candidate.productVersion,
          uptime: 1,
        }),
        spawnOwner,
      },
    );

    expect(result).toMatchObject({ source: "started", candidate: current });
    expect(spawnOwner).toHaveBeenCalledOnce();
  });

  it("converges when a duplicate shutdown loses the exact old owner race", async () => {
    const older = { ...info, protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION - 1 };
    const current = { ...info, pid: 84, instanceId: "1d78b1af-d7b7-4d30-84af-54e337f02b49" };
    let state: "older" | "current" = "older";
    const result = await ensureCanonicalDaemon(
      { entryPath: "/tmp/cli.js", timeoutMs: 100 },
      {
        inspect: () => ({
          status: "valid",
          info: state === "older" ? older : current,
          observation: { path: "/tmp/daemon.json" },
        }),
        alive: async () => true,
        identity: async (candidate) => ({
          ok: true,
          pid: candidate.pid,
          protocolVersion: candidate.protocolVersion,
          productVersion: candidate.productVersion,
          instanceId: candidate.instanceId,
          startedAt: candidate.startedAt,
        }),
        health: async (candidate) => ({
          ok: true,
          protocolVersion: candidate.protocolVersion,
          productVersion: candidate.productVersion,
          uptime: 1,
        }),
        shutdownOlderOwner: async () => {
          state = "current";
          throw new Error("the other upgrader already closed this owner");
        },
      },
    );

    expect(result).toMatchObject({ source: "existing", candidate: current });
  });
});
