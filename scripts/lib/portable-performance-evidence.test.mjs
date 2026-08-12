import { describe, expect, it } from "vitest";
import { qualifyMemoryEvidence, qualifyStartupEvidence } from "./portable-performance-evidence.mjs";

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
});
