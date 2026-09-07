import { createServer } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import {
  daemonPortRefusesConnections,
  verifyDaemonRetirement,
} from "../e2e/fixtures/daemon-retirement.ts";

afterEach(() => vi.restoreAllMocks());
const identity = { instanceId: "11111111-1111-4111-8111-111111111111", pid: 12345, port: 12345 };

it("requires both process absence and a refused listener, and rechecks the process", async () => {
  const alive = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true).mockReturnValue(false);
  const refuses = vi.fn(async () => true);
  const receipt = await verifyDaemonRetirement(identity, {
    processAlive: alive,
    portRefusesConnections: refuses,
  });
  expect(refuses).toHaveBeenCalledTimes(2);
  expect(receipt).toMatchObject({
    generation: identity.instanceId,
    pid: identity.pid,
    port: identity.port,
    processAbsent: true,
    connectionRefused: true,
  });
});

it.each(["process", "listener"])("does not certify a surviving %s", async (survivor) => {
  await expect(
    verifyDaemonRetirement(identity, {
      timeoutMs: 40,
      processAlive: () => survivor === "process",
      portRefusesConnections: async () => survivor !== "listener",
    }),
  ).rejects.toThrow("did not retire");
});

it("distinguishes an actual loopback listener from refusal after its closure", async () => {
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener did not bind");
  try {
    expect(await daemonPortRefusesConnections(address.port)).toBe(false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  expect(await daemonPortRefusesConnections(address.port)).toBe(true);
});

it("rejects malformed identities before probing", async () => {
  const alive = vi.fn();
  for (const changed of [{ pid: 0 }, { port: 65536 }, { instanceId: "other" }]) {
    await expect(
      verifyDaemonRetirement({ ...identity, ...changed }, { processAlive: alive }),
    ).rejects.toThrow("invalid");
  }
  expect(alive).not.toHaveBeenCalled();
});
