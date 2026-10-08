import { expect, it } from "vitest";
import { runtimeSoakConfiguration } from "../../../test-support/terminal-runtime-soak-config.ts";

const budgets = {
  rssBytes: 1_073_741_824,
  heapBytes: 536_870_912,
  trailingRssGrowthBytes: 134_217_728,
  trailingHeapGrowthBytes: 67_108_864,
  maxCpuCorePercent: 200,
  deliveryQueueBytes: 67_108_864,
  operationMs: 10_000,
};
const normal = {
  warmupMs: 60_000,
  measuredMs: 300_000,
  trailingMs: 60_000,
  sampleMs: 5000,
  cycleMs: 10_000,
  budgets,
};
it("preserves default and explicit normal configuration and timeout", () => {
  for (const env of [{}, { TMUX_IDE_RUNTIME_SOAK_PROFILE: "normal" }]) {
    const result = runtimeSoakConfiguration(env);
    expect(result).toEqual({ smoke: false, profile: "normal", config: normal });
    expect(Object.isFrozen(result.config)).toBe(true);
    expect(
      result.config.warmupMs + result.config.measuredMs + result.config.trailingMs + 120_000,
    ).toBe(540_000);
  }
});
it("preserves smoke parameters and budgets", () => {
  for (const env of [
    { TMUX_IDE_RUNTIME_SOAK_SMOKE: "1" },
    { TMUX_IDE_RUNTIME_SOAK_SMOKE: "1", TMUX_IDE_RUNTIME_SOAK_PROFILE: "normal" },
  ])
    expect(runtimeSoakConfiguration(env)).toEqual({
      smoke: true,
      profile: "smoke",
      config: {
        ...normal,
        warmupMs: 1000,
        measuredMs: 10_000,
        trailingMs: 1000,
        sampleMs: 1000,
        cycleMs: 2000,
      },
    });
});
it("changes only measured duration for long mode", () => {
  const result = runtimeSoakConfiguration({ TMUX_IDE_RUNTIME_SOAK_PROFILE: "long" });
  expect(result).toEqual({
    smoke: false,
    profile: "long",
    config: { ...normal, measuredMs: 1_800_000 },
  });
  expect(
    result.config.warmupMs + result.config.measuredMs + result.config.trailingMs + 120_000,
  ).toBe(2_040_000);
});
it("rejects unknown profiles including empty and smoke profile strings", () => {
  for (const profile of ["", "smoke", "LONG", "other"])
    expect(() => runtimeSoakConfiguration({ TMUX_IDE_RUNTIME_SOAK_PROFILE: profile })).toThrow(
      "Unknown runtime soak profile",
    );
});
it("rejects long plus smoke before any workload can start", () => {
  expect(() =>
    runtimeSoakConfiguration({
      TMUX_IDE_RUNTIME_SOAK_PROFILE: "long",
      TMUX_IDE_RUNTIME_SOAK_SMOKE: "1",
    }),
  ).toThrow("Long runtime soak profile cannot be combined with smoke mode");
  expect(runtimeSoakConfiguration({ TMUX_IDE_RUNTIME_SOAK_SMOKE: "0" }).config).toEqual(normal);
});
