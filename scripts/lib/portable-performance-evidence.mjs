import { summarize, theilSenSlope } from "./performance-reference-report.mjs";

export function qualifyStartupEvidence(rawSamples, budgets) {
  const cold = rawSamples.filter(({ class: kind }) => kind === "process-cold");
  const warm = rawSamples.filter(({ class: kind }) => kind === "warm-repeat");
  if (cold.length !== 1 || warm.length < 2)
    throw new TypeError("startup evidence needs one cold and two warm samples");
  const coldSummary = summarize(cold.map(({ firstUsableMs }) => firstUsableMs));
  const warmSummary = summarize(warm.map(({ firstUsableMs }) => firstUsableMs));
  const passed =
    coldSummary.p95 <= budgets.processColdFirstUsableP95Ms &&
    warmSummary.p95 <= budgets.warmFirstUsableP95Ms;
  return {
    status: passed ? "passed" : "failed",
    passed,
    sampleCount: rawSamples.length,
    rawSamples,
    summary: { processColdFirstUsableMs: coldSummary, warmFirstUsableMs: warmSummary },
    budgets,
  };
}

export function qualifyMemoryEvidence(worker, budgets) {
  const rawSamples = worker.samples;
  if (!Array.isArray(rawSamples) || rawSamples.length < 4)
    throw new TypeError("memory evidence needs four samples");
  const rss = rawSamples.map(({ rssBytes }) => rssBytes);
  const heap = rawSamples.map(({ heapUsedBytes }) => heapUsedBytes);
  const summary = {
    rssBytes: summarize(rss),
    heapUsedBytes: summarize(heap),
    rssRobustSlopeBytesPerSample: theilSenSlope(rss),
    heapRobustSlopeBytesPerSample: theilSenSlope(heap),
    rssGrowthBytes: Math.max(...rss) - Math.min(...rss),
    heapGrowthBytes: Math.max(...heap) - Math.min(...heap),
    maxQueueDepth: Math.max(...rawSamples.map(({ queueDepth }) => queueDepth)),
    maxRepresentationCacheBytes: Math.max(
      ...rawSamples.map(({ representationCacheBytes }) => representationCacheBytes),
    ),
    maxRawJournalBytes: Math.max(...rawSamples.map(({ rawJournalBytes }) => rawJournalBytes)),
  };
  const passed =
    rawSamples.length >= budgets.minimumSamples &&
    summary.rssRobustSlopeBytesPerSample <= budgets.rssRobustSlopeBytesPerSample &&
    summary.heapRobustSlopeBytesPerSample <= budgets.heapRobustSlopeBytesPerSample &&
    summary.rssGrowthBytes <= budgets.rssGrowthCeilingBytes &&
    summary.heapGrowthBytes <= budgets.heapGrowthCeilingBytes &&
    summary.maxQueueDepth <= budgets.settledQueueDepth &&
    summary.maxRepresentationCacheBytes <= budgets.representationCacheCeilingBytes &&
    summary.maxRawJournalBytes <= budgets.rawJournalCeilingBytes;
  return {
    status: passed ? "passed" : "failed",
    passed,
    sampleCount: rawSamples.length,
    rawSamples,
    summary,
    budgets,
  };
}
