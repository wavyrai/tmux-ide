import { beforeEach, expect, it, vi } from "vitest";
import type { ScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";

const owned = vi.hoisted(() => ({
  stop: vi.fn(),
  poll: vi.fn(),
}));
vi.mock("node:child_process", () => ({
  execFile: (_file: unknown, _args: unknown, _options: unknown, callback: (error: null) => void) =>
    callback(null),
}));
vi.mock("../../../scripts/lib/product-fixtures/harness-process.ts", () => ({
  spawnHarnessChild: () => ({ child: { pid: 1234 }, output: () => "", stop: owned.stop }),
  pollUntil: owned.poll,
  processIsAlive: () => false,
}));
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";

const fleet = { environment: {}, daemonInfoDir: "/owned-fixture" } as ScratchFleet;
beforeEach(() => {
  owned.stop.mockReset();
  owned.poll.mockReset();
});
it("retires the retained harness when startup fails before returning ownership", async () => {
  const startup = new Error("readiness failed");
  owned.poll.mockRejectedValue(startup);
  owned.stop.mockResolvedValue(undefined);
  await expect(startDaemon(fleet)).rejects.toBe(startup);
  expect(owned.stop).toHaveBeenCalledOnce();
});
it("preserves startup and cleanup errors in order", async () => {
  const startup = new Error("readiness failed");
  const cleanup = new Error("retirement failed");
  owned.poll.mockRejectedValue(startup);
  owned.stop.mockRejectedValue(cleanup);
  const result = await startDaemon(fleet).catch((error: unknown) => error);
  expect(result).toBeInstanceOf(AggregateError);
  expect((result as AggregateError).errors).toEqual([startup, cleanup]);
});
