import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface Measurement {
  readonly mode: "native" | "ws";
  readonly sampleCount: number;
  readonly fifo: boolean;
  readonly maxBufferedAmount: number;
  readonly finalBufferedAmount: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly blockedIngress: ReadonlyArray<{
    readonly sequence: number;
    readonly blockMs: number;
    readonly ingressMs: number;
  }>;
}

function measure(mode: Measurement["mode"]): Measurement {
  const fixture = fileURLToPath(
    new URL("../test-support/pane-stream-loopback-benchmark.ts", import.meta.url),
  );
  const result = spawnSync("bun", [fixture, mode], { encoding: "utf8", timeout: 15_000 });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim()) as Measurement;
}

describe("Bun pane-stream loopback transports", () => {
  it("compares native WebSocket with ws without changing the production choice", () => {
    const native = measure("native");
    const ws = measure("ws");
    for (const result of [native, ws]) {
      expect(result.sampleCount).toBe(120);
      expect(result.fifo).toBe(true);
      expect(result.finalBufferedAmount).toBe(0);
      expect(result.p95Ms).toBeLessThanOrEqual(16.67);
      expect(result.p99Ms).toBeLessThanOrEqual(33);
      expect(result.blockedIngress).toHaveLength(2);
      expect(result.blockedIngress.map(({ blockMs }) => blockMs)).toEqual([40, 70]);
      expect(result.blockedIngress.every(({ ingressMs }) => ingressMs < 5)).toBe(true);
    }
    // This benchmark is the decision record. Production must not switch merely
    // because one noisy invocation wins by an insignificant fraction.
    expect({ native, ws }).toMatchObject({
      native: { mode: "native" },
      ws: { mode: "ws" },
    });
  });
});
