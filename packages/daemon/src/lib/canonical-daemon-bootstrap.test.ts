import { describe, expect, it, vi } from "vitest";
import type { CanonicalDaemonInfo } from "./canonical-daemon.ts";
import { createCanonicalDaemonBootstrapCoordinator } from "./canonical-daemon-bootstrap.ts";

const info: CanonicalDaemonInfo = {
  pid: 42,
  port: 6060,
  protocolVersion: 1,
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
          protocolVersion: 1,
          productVersion: "2.8.0",
          instanceId: info.instanceId,
          startedAt: info.startedAt,
        }),
        health: async () => ({ ok: true, protocolVersion: 1, productVersion: "2.8.0", uptime: 1 }),
      },
    );
    await expect(coordinator.ensure()).resolves.toMatchObject({
      source: "started",
      candidate: info,
    });
  });
});
