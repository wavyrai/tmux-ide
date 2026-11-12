import { describe, expect, it } from "vitest";
import { createStopProgress } from "./daemon-stop-progress.ts";

describe("daemon stop progress (#839)", () => {
  it("names the stage a stop is stuck in and how long the finished ones took", async () => {
    let now = 1_000;
    const progress = createStopProgress(() => now);
    expect(progress.snapshot()).toEqual({
      started: false,
      finished: false,
      elapsedMs: 0,
      stage: null,
      stageMs: 0,
      completed: [],
    });
    progress.begin();
    await progress.run("plugins", () => {
      now += 12;
    });
    let release!: () => void;
    const hung = progress.run(
      "interaction-observation",
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    now += 5_000;
    expect(progress.snapshot()).toEqual({
      started: true,
      finished: false,
      elapsedMs: 5_012,
      stage: "interaction-observation",
      stageMs: 5_000,
      completed: [{ stage: "plugins", ms: 12 }],
    });
    release();
    await hung;
    now += 3;
    expect(progress.finish()).toMatchObject({ finished: true, stage: null, elapsedMs: 5_015 });
    now += 500;
    // A finished stop no longer ages.
    expect(progress.snapshot().elapsedMs).toBe(5_015);
  });

  it("records a failing stage and still passes its failure on", async () => {
    const progress = createStopProgress(() => 0);
    progress.begin();
    await expect(
      progress.run("pane-streams", () => {
        throw new Error("boundary refused");
      }),
    ).rejects.toThrow("boundary refused");
    expect(progress.snapshot()).toMatchObject({
      stage: null,
      completed: [{ stage: "pane-streams", ms: 0 }],
    });
  });
});
