import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("terminal replica cold Bun process", () => {
  it("applies the first 132x41 last-column patch inside one frame", () => {
    const fixture = fileURLToPath(
      new URL("../test-support/terminal-replica-cold-process.ts", import.meta.url),
    );
    const result = spawnSync("bun", [fixture], { encoding: "utf8", timeout: 10_000 });
    expect(result.status, result.stderr).toBe(0);
    const measurement = JSON.parse(result.stdout.trim()) as {
      durationMs: number;
      profile: {
        reusedAuthenticatedFrameHash: boolean;
        phaseMicros: Record<string, number>;
        counts: Record<string, number>;
      };
    };
    expect(measurement.durationMs).toBeLessThanOrEqual(16.67);
    expect(measurement.profile.reusedAuthenticatedFrameHash).toBe(true);
    expect(measurement.profile.phaseMicros.updateHash).toBe(0);
    expect(measurement.profile.counts).toMatchObject({
      patchedRows: 1,
      validatedCells: 132,
      frozenCells: 132,
      comparedCells: 132,
      rowHashMisses: 1,
    });
  });
});
