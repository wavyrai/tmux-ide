// Pure configuration for the opt-in runtime qualification fixture.
// One-pane and 15-pane qualification remain separate cohorts.
export function runtimeSoakConfiguration(env: {
  readonly TMUX_IDE_RUNTIME_SOAK_PROFILE?: string;
  readonly TMUX_IDE_RUNTIME_SOAK_SMOKE?: string;
}) {
  const smoke = env.TMUX_IDE_RUNTIME_SOAK_SMOKE === "1";
  const requestedProfile = env.TMUX_IDE_RUNTIME_SOAK_PROFILE ?? "normal";
  if (requestedProfile !== "normal" && requestedProfile !== "long")
    throw new Error("Unknown runtime soak profile");
  if (smoke && requestedProfile === "long")
    throw new Error("Long runtime soak profile cannot be combined with smoke mode");
  const profile = smoke ? "smoke" : requestedProfile;
  const config = Object.freeze({
    warmupMs: smoke ? 1000 : 60_000,
    measuredMs: smoke ? 10_000 : profile === "long" ? 1_800_000 : 300_000,
    trailingMs: smoke ? 1000 : 60_000,
    sampleMs: smoke ? 1000 : 5000,
    cycleMs: smoke ? 2000 : 10_000,
    budgets: {
      rssBytes: 1024 ** 3,
      heapBytes: 512 * 1024 ** 2,
      trailingRssGrowthBytes: 128 * 1024 ** 2,
      trailingHeapGrowthBytes: 64 * 1024 ** 2,
      maxCpuCorePercent: 200,
      deliveryQueueBytes: 64 * 1024 ** 2,
      operationMs: 10_000,
    },
  });
  return { smoke, profile, config };
}
