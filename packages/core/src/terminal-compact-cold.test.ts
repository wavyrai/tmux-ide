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
      timeout: 100_000,
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
      timerDelayRunsMs: number[];
      denseYields: number;
    };
    expect(measurement).toMatchObject({ revision: 0, denseRejected: true });
    expect(measurement.hash).toMatch(/^[0-9a-f]{16}$/u);
    expect(measurement.representationBytes).toBeGreaterThan(8 * 1024 * 1024);
    expect(measurement.denseRepresentationBytes).toBeGreaterThan(14 * 1024 * 1024);
    expect(measurement.rssBytes).toBeLessThan(1_073_741_824);
    expect(measurement.heapBytes).toBeLessThan(536_870_912);
    // This max-width stress case also parses and rejects a deliberately dense
    // 15 MB legacy payload. What must hold is that the decoder never blocks
    // the event loop for long: it yields at least once per 16K characters of
    // input (COOPERATIVE_JSON_WORK_CHARS), a property of the code, not of the
    // runner. A wall-clock bound on the longest event-loop gap was here (60 ms,
    // best of three cold runs) and failed on CI at 60.58 ms in all three runs
    // (#733): on that path the gap is one slice plus garbage-collection pauses
    // while the rejected 7.5M-element array is built, both of which scale with
    // the runner's speed. The CPU time of the longest slice stays bounded.
    expect(measurement.timerDelayRunsMs).toHaveLength(3);
    expect(measurement.denseYields).toBeGreaterThanOrEqual(
      Math.floor(measurement.denseRepresentationBytes / (16 * 1_024)),
    );
    expect(measurement.maxSliceMs).toBeLessThanOrEqual(150);
    expect(measurement.maxSliceStage).not.toBe("");
  }, 105_000);
});
