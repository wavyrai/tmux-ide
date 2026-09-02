import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("compact terminal delivery cold process", () => {
  it("adopts a unique-row 132x41 seed and 5000-history patch below the event-loop cap", () => {
    const fixture = fileURLToPath(
      new URL("../test-support/terminal-compact-cold-process.ts", import.meta.url),
    );
    const result = spawnSync(process.execPath, ["--experimental-strip-types", fixture], {
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const measurement = JSON.parse(result.stdout.trim()) as {
      durationMs: number;
      timerDelayMs: number;
      rssBytes: number;
      heapBytes: number;
      revision: number;
      uniqueHistoryRows: number;
      profiles: Array<Record<string, unknown>>;
    };
    expect(measurement).toMatchObject({ revision: 1, uniqueHistoryRows: 5_000 });
    expect(measurement.rssBytes).toBeLessThan(1_073_741_824);
    expect(measurement.heapBytes).toBeLessThan(536_870_912);
    expect(measurement.durationMs).toBeLessThan(30_000);
    expect(measurement.profiles).toHaveLength(2);
    expect(measurement.profiles).toEqual([
      expect.objectContaining({
        expandedRows: 4_137,
        expandedCells: 546_084,
        schemaTraversals: 1,
        hashTraversals: 1,
        applyTraversals: 0,
        trustedAdoption: true,
        retainedSnapshots: 0,
      }),
      expect.objectContaining({
        expandedRows: 904,
        expandedCells: 119_328,
        schemaTraversals: 1,
        hashTraversals: 1,
        applyTraversals: 1,
        trustedAdoption: true,
        retainedSnapshots: 0,
      }),
    ]);
    expect(measurement.timerDelayMs).toBeLessThanOrEqual(33);
  }, 35_000);

  it("bounds an 8MiB max-width high-run compact seed through final hash", () => {
    const fixture = fileURLToPath(
      new URL("../test-support/terminal-compact-max-cold-process.ts", import.meta.url),
    );
    const result = spawnSync(process.execPath, ["--experimental-strip-types", fixture], {
      encoding: "utf8",
      timeout: 35_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const measurement = JSON.parse(result.stdout.trim()) as {
      timerDelayMs: number;
      maxSliceMs: number;
      maxSliceStage: string;
      representationBytes: number;
      denseRepresentationBytes: number;
      denseRejected: boolean;
      rssBytes: number;
      heapBytes: number;
      revision: number;
      hash: string;
    };
    expect(measurement).toMatchObject({ revision: 0, denseRejected: true });
    expect(measurement.hash).toMatch(/^[0-9a-f]{16}$/u);
    expect(measurement.representationBytes).toBeGreaterThan(8 * 1024 * 1024);
    expect(measurement.denseRepresentationBytes).toBeGreaterThan(14 * 1024 * 1024);
    expect(measurement.rssBytes).toBeLessThan(1_073_741_824);
    expect(measurement.heapBytes).toBeLessThan(536_870_912);
    // This max-width stress case also parses and rejects a deliberately dense
    // 15 MB legacy payload. Keep wall-clock scheduler jitter and the measured
    // CPU slice bounded without conflating this adversarial rejection path with
    // the 33 ms interactive budget enforced by performance qualification.
    expect(measurement.timerDelayMs).toBeLessThanOrEqual(60);
    expect(measurement.maxSliceMs).toBeLessThanOrEqual(150);
    expect(measurement.maxSliceStage).not.toBe("");
  }, 40_000);
});
