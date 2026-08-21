import { describe, expect, it } from "vitest";
import {
  notMeasuredEvidence,
  qualifyCoherentTerminalEvidence,
  qualifyDeterministicCaptureEvidence,
  qualifyLatencyEvidence,
  qualifyMemoryEvidence,
  qualifyStartupEvidence,
  qualifyTmuxCapabilityEvidence,
} from "./portable-performance-evidence.mjs";

describe("portable performance evidence", () => {
  it("enforces cold and warm budgets independently", () => {
    const result = qualifyStartupEvidence(
      [
        { class: "process-cold", firstUsableMs: 100 },
        { class: "warm-repeat", firstUsableMs: 40 },
        { class: "warm-repeat", firstUsableMs: 50 },
      ],
      { processColdFirstUsableP95Ms: 120, warmFirstUsableP95Ms: 45 },
    );
    expect(result.status).toBe("failed");
    expect(result.summary.warmFirstUsableMs.p95).toBe(50);
  });

  it("uses robust memory slopes plus hard queue/cache ceilings", () => {
    const samples = Array.from({ length: 4 }, (_, ordinal) => ({
      ordinal,
      rssBytes: 1_000 + ordinal * 10,
      heapUsedBytes: 500 + ordinal * 5,
      queueDepth: 0,
      representationCacheBytes: 20,
      rawJournalBytes: 10,
    }));
    const result = qualifyMemoryEvidence(
      { samples },
      {
        minimumSamples: 4,
        rssRobustSlopeBytesPerSample: 10,
        heapRobustSlopeBytesPerSample: 5,
        rssGrowthCeilingBytes: 30,
        heapGrowthCeilingBytes: 15,
        settledQueueDepth: 0,
        representationCacheCeilingBytes: 20,
        rawJournalCeilingBytes: 10,
      },
    );
    expect(result.status).toBe("passed");
  });

  it("enforces responsiveness p95 and hard maximum independently", () => {
    const result = qualifyLatencyEvidence(
      [{ elapsedMs: 10 }, { elapsedMs: 12 }, { elapsedMs: 80 }],
      { minimumSamples: 3, p95Ms: 100, maximumMs: 50 },
    );
    expect(result.status).toBe("failed");
    expect(result.summary.p95).toBe(80);
  });

  it("tracks warm OpenTUI p95 separately from the cold portability ceiling", () => {
    const result = qualifyCoherentTerminalEvidence(
      {
        webColdMs: 900,
        openTuiColdMs: 2_900,
        openTuiWarmSamples: [
          { class: "product-rig-warm", elapsedMs: 1_900 },
          { class: "product-rig-warm", elapsedMs: 2_100 },
          { class: "product-rig-warm", elapsedMs: 3_100 },
        ],
      },
      {
        webTrackedTargetP95Ms: 3_000,
        openTuiTrackedTargetP95Ms: 3_000,
        hardPortabilityCeilingMs: 5_000,
        minimumWarmSamples: 3,
      },
    );
    expect(result.status).toBe("failed");
    expect(result.summary.hardCeilingPassed).toBe(true);
    expect(result.summary.trackedTargetPassed).toBe(false);
  });

  it("does not apply the warm p95 target to a portable cold OpenTUI start", () => {
    const result = qualifyCoherentTerminalEvidence(
      {
        webColdMs: 1_500,
        openTuiColdMs: 3_089,
        openTuiWarmSamples: [
          { class: "product-rig-warm", elapsedMs: 2_389 },
          { class: "product-rig-warm", elapsedMs: 2_197 },
          { class: "product-rig-warm", elapsedMs: 2_240 },
        ],
      },
      {
        webTrackedTargetP95Ms: 3_000,
        openTuiTrackedTargetP95Ms: 3_000,
        hardPortabilityCeilingMs: 5_000,
        minimumWarmSamples: 3,
      },
    );
    expect(result.status).toBe("passed");
    expect(result.summary.openTuiColdMs).toBe(3_089);
    expect(result.summary.openTuiWarmMs.p95).toBe(2_389);
    expect(result.summary.trackedTargetPassed).toBe(true);
    expect(result.summary.hardCeilingPassed).toBe(true);
  });

  it("records but excludes the post-cold process warmup from the steady-warm p95", () => {
    const result = qualifyCoherentTerminalEvidence(
      {
        webColdMs: 1_500,
        openTuiColdMs: 3_162,
        openTuiWarmup: { class: "product-rig-warmup", elapsedMs: 3_009 },
        openTuiWarmSamples: [
          { class: "product-rig-warm", elapsedMs: 2_385 },
          { class: "product-rig-warm", elapsedMs: 2_375 },
          { class: "product-rig-warm", elapsedMs: 2_410 },
        ],
      },
      {
        webTrackedTargetP95Ms: 3_000,
        openTuiTrackedTargetP95Ms: 3_000,
        hardPortabilityCeilingMs: 5_000,
        minimumWarmSamples: 3,
      },
    );
    expect(result.status).toBe("passed");
    expect(result.rawSamples[1]).toEqual({
      class: "product-rig-warmup",
      elapsedMs: 3_009,
    });
    expect(result.summary.openTuiWarmupMs).toBe(3_009);
    expect(result.summary.openTuiWarmMs.p95).toBe(2_410);
  });

  it("requires every deterministic capture pair to have the same digest", () => {
    const result = qualifyDeterministicCaptureEvidence(
      [
        { firstSha256: "a", secondSha256: "a" },
        { firstSha256: "b", secondSha256: "c" },
      ],
      { algorithm: "sha256", minimumPairs: 2 },
    );
    expect(result.status).toBe("failed");
    expect(result.summary.mismatches).toBe(1);
  });

  it("reports the core tmux matrix separately from version-gated capabilities", () => {
    const result = qualifyTmuxCapabilityEvidence(
      {
        version: "tmux 3.1c",
        commands: "attach-session [-rx]\ncapture-pane [-p]\nlist-panes [-a]\n",
        featureProbes: {
          ignoreSizeReadOnly: { status: "rejected", diagnostic: "unsupported-option" },
        },
      },
      {
        minimumVersion: "3.0",
        requiredCommands: ["capture-pane", "list-panes"],
        features: {
          core: { minimumVersion: "3.0", requiredCommands: ["capture-pane"] },
          ignoreSizeReadOnly: { minimumVersion: "3.2", requiredCommands: ["attach-session"] },
        },
      },
    );
    expect(result.status).toBe("passed");
    expect(result.features.core.status).toBe("supported");
    expect(result.features.ignoreSizeReadOnly.status).toBe("unsupported");
  });

  it("does not turn unmeasurable evidence green", () => {
    expect(notMeasuredEvidence("same-clock paint observer unavailable", { p95Ms: 16.67 })).toEqual({
      status: "not-measured",
      reason: "same-clock paint observer unavailable",
      budgets: { p95Ms: 16.67 },
    });
  });
});
