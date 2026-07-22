#!/usr/bin/env node

/**
 * Opt-in live stress for ADR-0003.
 *
 * Usage (Node 20+):
 *   node --experimental-strip-types --expose-gc \
 *     packages/daemon/scripts/stress-bounded-pty-input.mjs
 *
 * The PTY child SIGSTOPs before reading. The adapter fills its entire default
 * lifetime budget, then repeatedly refuses more frames. This script never
 * inspects node-pty private fields; it asserts public accounting and a coarse
 * process RSS ceiling. Run it in the macOS/Linux/WSL2 release matrix before
 * enabling native attachment input.
 */

import { setTimeout as delay } from "node:timers/promises";
import { Buffer } from "node:buffer";
import console from "node:console";
import process from "node:process";
import { NodePtyAdapter } from "../src/terminal/NodePtyAdapter.ts";
import { DEFAULT_PTY_INPUT_LIMITS } from "../src/terminal/MonotonicPtyInput.ts";
import { PtyInputRejectedError } from "../src/terminal/PtyAdapter.ts";

if (process.platform === "win32") {
  console.error("Run this inside WSL2; native Windows is outside ADR-0002.");
  process.exit(2);
}
if (typeof globalThis.gc !== "function") {
  console.error("This stress requires --expose-gc.");
  process.exit(2);
}

const RSS_DELTA_LIMIT = 8 * 1024 * 1024;
const adapter = new NodePtyAdapter();
const proc = adapter.spawnSync({
  shell: "/bin/sh",
  args: ["-c", "kill -STOP $$; while :; do sleep 1; done"],
  cwd: process.cwd(),
  cols: 80,
  rows: 24,
  env: { TERM: "xterm-256color", LANG: process.env.LANG },
  encoding: null,
});

function collect() {
  globalThis.gc();
  return process.memoryUsage();
}

try {
  await delay(50);
  const before = collect();
  const frame = Buffer.alloc(DEFAULT_PTY_INPUT_LIMITS.maxFrameBytes, 0x61);
  const acceptedFrameCount =
    DEFAULT_PTY_INPUT_LIMITS.maxAcceptedBytes / DEFAULT_PTY_INPUT_LIMITS.maxFrameBytes;
  if (!Number.isInteger(acceptedFrameCount)) {
    throw new Error("default input bytes must be divisible by default frame bytes");
  }

  for (let index = 0; index < acceptedFrameCount; index += 1) {
    proc.boundedInput.write(frame);
  }
  const full = proc.boundedInput.snapshot();
  if (
    full.state !== "exhausted" ||
    full.acceptedBytes !== DEFAULT_PTY_INPUT_LIMITS.maxAcceptedBytes ||
    full.acceptedFrames !== acceptedFrameCount
  ) {
    throw new Error(`unexpected full-budget snapshot: ${JSON.stringify(full)}`);
  }

  const samples = [];
  let rejectionCount = 0;
  for (let round = 0; round < 8; round += 1) {
    for (let index = 0; index < 512; index += 1) {
      try {
        proc.boundedInput.write(Uint8Array.of(0x62));
      } catch (error) {
        if (!(error instanceof PtyInputRejectedError)) throw error;
        rejectionCount += 1;
      }
    }
    await delay(25);
    samples.push(collect());
  }

  const maxRss = Math.max(...samples.map((sample) => sample.rss));
  const rssDelta = Math.max(0, maxRss - before.rss);
  const result = {
    platform: process.platform,
    arch: process.arch,
    pid: proc.pid,
    limits: DEFAULT_PTY_INPUT_LIMITS,
    rejectionCount,
    before,
    samples,
    rssDelta,
    rssDeltaLimit: RSS_DELTA_LIMIT,
  };
  console.log(JSON.stringify(result, null, 2));
  if (rssDelta > RSS_DELTA_LIMIT) {
    throw new Error(`stalled PTY input RSS delta ${rssDelta} exceeded ${RSS_DELTA_LIMIT}`);
  }
} finally {
  proc.kill("SIGKILL");
}
