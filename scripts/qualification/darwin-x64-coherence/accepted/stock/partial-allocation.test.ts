import assert from "node:assert/strict";
import { test } from "node:test";
import { rmSync } from "node:fs";
import { createScratchFleet } from "./scratch-fleet.ts";
import type { execFileSync } from "node:child_process";

test("postcreation setup failure exposes exact allocation and generation for outer cleanup", async () => {
  let allocation: { root: string; socketPath: string } | undefined;
  let generation: { pid: string; startTime: string } | undefined;
  let returnReached = false,
    retired = false;
  const error = Error("injected setup failure after owned identity publication");
  const executeSync = ((command: string, args: readonly string[]) => {
    if (command === "which") return "/pinned/tmux";
    if (args.includes("new-session")) return "";
    if (args.includes("#{pid}")) return "12345\n";
    if (args.includes("#{start_time}")) return "123456\n";
    throw error;
  }) as typeof execFileSync;
  try {
    await assert.rejects(
      async () => {
        await createScratchFleet(
          {
            sessions: 1,
            windowsPerSession: 1,
            slug: "offline-allocation",
            onAllocated: (v) => {
              allocation = v;
            },
            onServer: async (v) => {
              generation = v;
            },
          },
          { executeSync },
        );
        returnReached = true;
      },
      (e) => e === error,
    );
  } finally {
    // This is the same retained authority delivered to the runner's finally even
    // though createScratchFleet never returned its full handle. No server runs here.
    if (allocation && generation) {
      assert.equal(generation.pid, "12345");
      assert.equal(generation.startTime, "123456");
      assert(allocation.socketPath.startsWith(allocation.root + "/"));
      retired = true;
    }
    if (allocation) rmSync(allocation.root, { recursive: true, force: true });
  }
  assert.equal(returnReached, false);
  assert.equal(retired, true);
});

test("identity callback rejection keeps allocation and prevents any later setup mutation", async () => {
  let allocation: { root: string; socketPath: string } | undefined;
  let seen = 0;
  const error = Error("witness unavailable");
  const executeSync = ((command: string, args: readonly string[]) => {
    if (command === "which") return "/pinned/tmux";
    if (args.includes("new-session")) return "";
    if (args.includes("#{pid}")) return "12345";
    if (args.includes("#{start_time}")) return "123456";
    seen++;
    throw Error("unexpected postidentity mutation");
  }) as typeof execFileSync;
  try {
    await assert.rejects(
      createScratchFleet(
        {
          sessions: 1,
          windowsPerSession: 1,
          slug: "offline-witness",
          onAllocated: (v) => {
            allocation = v;
          },
          onServer: async () => {
            throw error;
          },
        },
        { executeSync },
      ),
      (e) => e === error,
    );
    assert(allocation);
    assert.equal(seen, 0);
  } finally {
    if (allocation) rmSync(allocation.root, { recursive: true, force: true });
  }
});
