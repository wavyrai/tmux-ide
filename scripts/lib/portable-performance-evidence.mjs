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
    summary.rssBytes.max <= budgets.rssAbsoluteCeilingBytes &&
    summary.heapUsedBytes.max <= budgets.heapAbsoluteCeilingBytes &&
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

export function qualifyLatencyEvidence(rawSamples, budgets) {
  if (!Array.isArray(rawSamples) || rawSamples.length < budgets.minimumSamples)
    throw new TypeError(`latency evidence needs ${budgets.minimumSamples} samples`);
  const values = rawSamples.map(({ elapsedMs }) => elapsedMs);
  const summary = summarize(values);
  const passed = summary.p95 <= budgets.p95Ms && summary.max <= budgets.maximumMs;
  return {
    status: passed ? "passed" : "failed",
    passed,
    sampleCount: rawSamples.length,
    rawSamples,
    summary,
    budgets,
  };
}

export function qualifyCoherentTerminalEvidence(observation, budgets) {
  const warm = observation.openTuiWarmSamples;
  if (!Array.isArray(warm) || warm.length < budgets.minimumWarmSamples)
    throw new TypeError(
      `coherent terminal evidence needs ${budgets.minimumWarmSamples} warm samples`,
    );
  const warmSummary = summarize(warm.map(({ elapsedMs }) => elapsedMs));
  const trackedTargetPassed =
    observation.webColdMs <= budgets.webTrackedTargetP95Ms &&
    warmSummary.p95 <= budgets.openTuiTrackedTargetP95Ms &&
    warmSummary.max <= budgets.openTuiTrackedTargetP95Ms;
  const hardCeilingPassed =
    observation.webColdMs <= budgets.hardPortabilityCeilingMs &&
    observation.openTuiColdMs <= budgets.hardPortabilityCeilingMs &&
    warmSummary.max <= budgets.hardPortabilityCeilingMs;
  const passed = trackedTargetPassed && hardCeilingPassed;
  const warmup = observation.openTuiWarmup;
  return {
    status: passed ? "passed" : "failed",
    passed,
    sampleCount: warm.length + 1 + (warmup ? 1 : 0),
    rawSamples: [
      {
        class: "product-rig-cold",
        webMs: observation.webColdMs,
        openTuiMs: observation.openTuiColdMs,
      },
      ...(warmup ? [warmup] : []),
      ...warm,
    ],
    summary: {
      webColdMs: observation.webColdMs,
      openTuiColdMs: observation.openTuiColdMs,
      openTuiWarmupMs: warmup?.elapsedMs ?? null,
      openTuiWarmMs: warmSummary,
      trackedTargetPassed,
      hardCeilingPassed,
    },
    budgets,
  };
}

export function qualifyDeterministicCaptureEvidence(rawSamples, budgets) {
  if (!Array.isArray(rawSamples) || rawSamples.length < budgets.minimumPairs)
    throw new TypeError(`capture evidence needs ${budgets.minimumPairs} pairs`);
  const mismatches = rawSamples.filter(({ firstSha256, secondSha256 }) => {
    return firstSha256 !== secondSha256;
  });
  const passed = mismatches.length === 0;
  return {
    status: passed ? "passed" : "failed",
    passed,
    sampleCount: rawSamples.length,
    rawSamples,
    summary: {
      matchingPairs: rawSamples.length - mismatches.length,
      mismatches: mismatches.length,
    },
    budgets,
  };
}

export function qualifyTmuxCapabilityEvidence(observation, support) {
  const version = parseTmuxVersion(observation.version);
  const availableCommands = new Set(parseTmuxCommands(observation.commands));
  const missingCommands = support.requiredCommands.filter(
    (command) => !availableCommands.has(command),
  );
  const versionSupported =
    compareTmuxVersions(version, parseTmuxVersion(support.minimumVersion)) >= 0;
  const features = Object.fromEntries(
    Object.entries(support.features).map(([name, requirement]) => {
      const minimumVersion = parseTmuxVersion(requirement.minimumVersion);
      const missing = (requirement.requiredCommands ?? []).filter(
        (command) => !availableCommands.has(command),
      );
      const probe = requirement.probe ? observation.featureProbes?.[name] : null;
      const probePassed = !requirement.probe || probe?.status === "accepted";
      const supported =
        compareTmuxVersions(version, minimumVersion) >= 0 && missing.length === 0 && probePassed;
      return [
        name,
        {
          status: supported ? "supported" : "unsupported",
          minimumVersion: requirement.minimumVersion,
          missingCommands: missing,
          probe: probe ?? null,
          reason: supported
            ? null
            : `requires tmux >= ${requirement.minimumVersion}${missing.length ? ` and commands ${missing.join(", ")}` : ""}${probePassed ? "" : " and an accepted installed flag probe"}`,
        },
      ];
    }),
  );
  const passed = versionSupported && missingCommands.length === 0;
  return {
    status: passed ? "passed" : "failed",
    passed,
    observedVersion: observation.version.trim(),
    parsedVersion: `${version.major}.${version.minor}${version.suffix}`,
    minimumVersion: support.minimumVersion,
    missingCommands,
    features,
  };
}

export function notMeasuredEvidence(reason, budgets) {
  if (typeof reason !== "string" || reason.length === 0)
    throw new TypeError("not-measured evidence needs a reason");
  return { status: "not-measured", reason, budgets };
}

function parseTmuxCommands(output) {
  if (typeof output !== "string") throw new TypeError("tmux commands must be text");
  return output
    .split("\n")
    .map((line) => line.trim().match(/^([a-z][a-z-]*)/u)?.[1] ?? null)
    .filter(Boolean);
}

function parseTmuxVersion(value) {
  if (typeof value !== "string") throw new TypeError("tmux version must be text");
  const match = value.trim().match(/^(?:tmux\s+)?(\d+)\.(\d+)([a-z]*)$/u);
  if (!match) throw new TypeError(`unsupported tmux version format: ${value}`);
  return { major: Number(match[1]), minor: Number(match[2]), suffix: match[3] ?? "" };
}

function compareTmuxVersions(left, right) {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.suffix.localeCompare(right.suffix);
}
