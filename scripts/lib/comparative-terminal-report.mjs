const validNumber = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;

// Nearest-rank empirical quantiles: no interpolation or averaging of run quantiles.
function distribution(values) {
  const sorted = values.filter(validNumber).sort((a, b) => a - b);
  const rank = (p) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
  return {
    count: sorted.length,
    p50: rank(0.5),
    p95: rank(0.95),
    p99: sorted.length >= 100 ? rank(0.99) : null,
    max: sorted.at(-1) ?? null,
  };
}

function measured(samples = []) {
  return samples.filter((sample) => !sample.warmup && validNumber(sample.latencyMs));
}

function runDistribution(samples) {
  const values = measured(samples).map((sample) => sample.latencyMs);
  const summary = distribution(values);
  const min = values.length ? Math.min(...values) : null;
  return { ...summary, min, range: min === null ? null : summary.max - min };
}

function resourceSamples(run) {
  return Array.isArray(run.resources) ? run.resources : (run.resources?.samples ?? []);
}

const CPU_LIMITATIONS = [
  "Only processes present at both endpoints contribute; exited or between-sample children are not accounted for. PID reuse cannot be detected.",
  "Sampled CPU seconds are not utilization or wall time; input includes warmups and controller waits.",
];

function phaseCpu(run) {
  const samples = resourceSamples(run);
  return [
    ["input", "before-input", "after-input"],
    ["resize", "after-input", "after-resize"],
  ].map(([phase, beforePhase, afterPhase]) => {
    const beforeMatches = samples.filter((sample) => sample.phase === beforePhase);
    const afterMatches = samples.filter((sample) => sample.phase === afterPhase);
    const before = beforeMatches.length === 1 ? beforeMatches[0] : null;
    const after = afterMatches.length === 1 ? afterMatches[0] : null;
    const limitations = [...CPU_LIMITATIONS];
    if (!before || !after || !Array.isArray(before.processes) || !Array.isArray(after.processes))
      return {
        phase,
        matchedCpuSeconds: null,
        missingPids: [],
        addedPids: [],
        limitations: [...limitations, "Missing or ambiguous phase/process samples."],
      };
    const prior = new Map(before.processes.map((process) => [process.pid, process.cpuSeconds]));
    const next = new Map(after.processes.map((process) => [process.pid, process.cpuSeconds]));
    const missingPids = [...prior.keys()].filter((pid) => !next.has(pid));
    const addedPids = [...next.keys()].filter((pid) => !prior.has(pid));
    const shared = [...prior.keys()].filter((pid) => next.has(pid));
    const invalid =
      !shared.length ||
      prior.size !== before.processes.length ||
      next.size !== after.processes.length ||
      shared.some(
        (pid) =>
          !validNumber(prior.get(pid)) ||
          !validNumber(next.get(pid)) ||
          next.get(pid) < prior.get(pid),
      );
    if (invalid)
      limitations.push(
        "Missing matched processes, duplicate PIDs or invalid/decreasing CPU counters; delta unavailable.",
      );
    if (before.missingRootPids?.length || after.missingRootPids?.length)
      limitations.push("An owned root is missing; accounting is incomplete.");
    if (missingPids.length || addedPids.length)
      limitations.push(
        "Process membership changed; matched delta is partial, not total phase CPU.",
      );
    return {
      phase,
      matchedCpuSeconds: invalid
        ? null
        : shared.reduce((sum, pid) => sum + next.get(pid) - prior.get(pid), 0),
      missingPids,
      addedPids,
      limitations,
    };
  });
}

export function summarizeComparativeTerminalReport(report) {
  const runs = report.runs ?? [];
  const targets = [
    ...new Set([...(report.options?.targets ?? []), ...runs.map((run) => run.target)]),
  ];
  return targets.map((target) => {
    const own = runs.filter((run) => run.target === target);
    const successful = own.filter((run) => run.status === "passed");
    const resources = successful.flatMap((run) =>
      Array.isArray(run.resources) ? run.resources : (run.resources?.samples ?? []),
    );
    return {
      target,
      attempted: own.length,
      succeeded: successful.length,
      passed: successful.length,
      failed: own.length - successful.length,
      inputDenominator: own.some((run) => run.inputDenominator)
        ? own.reduce(
            (sum, run) => {
              for (const key of ["attempted", "succeeded", "failed"])
                sum[key] += run.inputDenominator?.[key] ?? 0;
              return sum;
            },
            { attempted: 0, succeeded: 0, failed: 0 },
          )
        : null,
      echo: distribution(
        successful.flatMap((run) => measured(run.samples).map((s) => s.latencyMs)),
      ),
      resize: distribution(
        successful.flatMap((run) => measured(run.resizeSamples).map((s) => s.latencyMs)),
      ),
      startup: distribution(successful.map((run) => run.startupMs)),
      resources: {
        rssKiB: distribution(resources.map((sample) => sample.rssKiB)),
        lastRssKiB: resources.filter((sample) => validNumber(sample.rssKiB)).at(-1)?.rssKiB ?? null,
        incompleteSamples: resources.filter((sample) => sample.missingRootPids?.length).length,
        limitations: [...new Set(resources.flatMap((sample) => sample.limitations ?? []))],
      },
      runs: own.map((run) => ({
        status: run.status,
        originalOracleStatus: run.originalOracleStatus ?? run.status,
        traceEvidence: run.traceEvidence ?? null,
        inputDenominator: run.inputDenominator ?? null,
        echo: runDistribution(run.samples),
        resize: runDistribution(run.resizeSamples),
        phaseCpu: phaseCpu(run),
        echoSamples: measured(run.samples).length,
        warmups: (run.samples ?? []).filter((sample) => sample.warmup).length,
        resizeSamples: measured(run.resizeSamples).length,
        startupMs: validNumber(run.startupMs) ? run.startupMs : null,
        error:
          run.error ??
          run.traceEvidence?.error ??
          (run.cleanupFailed ? "Owned process cleanup failed" : null),
      })),
    };
  });
}

const cell = (value) =>
  String(value)
    .replaceAll("|", "\\|")
    .replace(/[\r\n]+/g, " ");
const number = (value) => (value === null ? "—" : value.toFixed(2));
const row = (items) => `| ${items.map(cell).join(" | ")} |`;

export function renderComparativeTerminalReport(report) {
  const targets = summarizeComparativeTerminalReport(report);
  const lines = [
    "# Comparative terminal benchmark",
    "",
    `Scenario: ${cell(report.scenario ?? "unspecified")}.`,
    "",
    "Latencies measure PTY-consumed output at terminal parser observation, not physical display refresh or perceived scrolling smoothness. Sequential acknowledged echoes do not measure maximum throughput or establish an overall winner.",
    "",
    "Quantiles use pooled raw, non-warmup samples from passed runs only (nearest rank). Runs are repeated observations, not independent hardware trials. p99 is shown only with at least 100 samples and is descriptive, not a tail-latency guarantee.",
    "",
    "Run denominators below count recorded attempts, including failures. Legacy interaction attempts/timeouts are not recorded individually; fixed typing scenarios retain every offered attempt in JSON; partial completed samples are not an attempted-interaction denominator. Missing targets have zero recorded attempts. This endpoint is separate from the 16.67ms client framebuffer-consumption budget.",
    "",
    ...targets
      .filter((target) => target.inputDenominator)
      .map(
        (target) =>
          `${target.target} measured input attempts / succeeded / failed: ${target.inputDenominator.attempted} / ${target.inputDenominator.succeeded} / ${target.inputDenominator.failed}. Missing/coalesced coherent witnesses remain failures.`,
      ),
    "",
    "## Echo latency (ms)",
    "",
    row([
      "Target",
      "Attempted / succeeded / failed runs",
      "Samples",
      "p50",
      "p95",
      "p99 (descriptive)",
    ]),
    "| --- | --- | --- | --- | --- | --- |",
    ...targets.map((target) =>
      row([
        target.target,
        `${target.attempted} / ${target.succeeded} / ${target.failed}`,
        target.echo.count,
        number(target.echo.p50),
        number(target.echo.p95),
        number(target.echo.p99),
      ]),
    ),
    "",
    "## Startup (ms; separate measurement)",
    "",
    "Startup includes adapter provisioning and differs between targets; it is not an equivalent cold-attach comparison. Small run counts make startup quantiles descriptive only.",
    "",
    row(["Target", "Runs", "p50", "p95"]),
    "| --- | --- | --- | --- |",
    ...targets.map((target) =>
      row([
        target.target,
        target.startup.count,
        number(target.startup.p50),
        number(target.startup.p95),
      ]),
    ),
  ];
  if (targets.some((target) => target.resize.count)) {
    lines.push(
      "",
      "## Resize observation latency (ms)",
      "",
      "Resize completion means the expected content geometry reached the parser; this does not qualify whole-frame coherence.",
      "",
      row(["Target", "Samples", "p50", "p95", "p99 (descriptive)"]),
      "| --- | --- | --- | --- | --- |",
      ...targets.map((target) =>
        row([
          target.target,
          target.resize.count,
          number(target.resize.p50),
          number(target.resize.p95),
          number(target.resize.p99),
        ]),
      ),
    );
  }
  if (targets.some((target) => target.resources.rssKiB.count)) {
    lines.push(
      "",
      "## Sampled process resources",
      "",
      "Only passed-run resource samples are summarized. RSS is sampled, not an allocation count or guaranteed peak; summed process RSS can double-count shared pages. CPU seconds are cumulative process counters retained in raw evidence, not percentages or a throughput score. Last RSS is the last sample from the last passed run. Missing root processes can undercount RSS; compare only matching collector scopes.",
      "",
      row(["Target", "RSS samples", "Max RSS (MiB)", "Last RSS (MiB)", "Incomplete samples"]),
      "| --- | --- | --- | --- | --- |",
      ...targets.map((target) => {
        const { rssKiB, lastRssKiB, incompleteSamples } = target.resources;
        return row([
          target.target,
          rssKiB.count,
          number(rssKiB.max === null ? null : rssKiB.max / 1024),
          number(lastRssKiB === null ? null : lastRssKiB / 1024),
          incompleteSamples,
        ]);
      }),
    );
  }
  for (const target of targets) {
    for (const limitation of target.resources.limitations)
      lines.push(`- ${cell(target.target)} resource collector: ${cell(limitation)}`);
  }
  lines.push(
    "",
    "## Per-run outcomes",
    "",
    "Partial samples from failed runs are retained below for diagnosis and excluded from successful-run quantiles.",
    "",
  );
  lines.push(
    row(["Target", "Run", "Status", "Measured echoes", "Warmups", "Resizes", "Error"]),
    "| --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const target of targets) {
    target.runs.forEach((run, index) =>
      lines.push(
        row([
          target.target,
          index + 1,
          run.status,
          run.echoSamples,
          run.warmups,
          run.resizeSamples,
          run.error ?? "—",
        ]),
      ),
    );
  }
  lines.push(
    "",
    "## Per-run latency spread and phase CPU",
    "",
    "Medians use nearest rank; spread is min–max and range, in ms. Failed-run partial observations remain diagnostic only. CPU deltas cover matched live processes, not total workload CPU.",
    "",
    CPU_LIMITATIONS.join(" "),
    "",
    row([
      "Target",
      "Run",
      "Status",
      "Echo median / min / max / range",
      "Resize median / min / max / range",
      "Input matched CPU (s)",
      "Resize matched CPU (s)",
    ]),
    "| --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const target of targets)
    target.runs.forEach((run, index) => {
      const spread = (summary) =>
        [summary.p50, summary.min, summary.max, summary.range].map(number).join(" / ");
      lines.push(
        row([
          target.target,
          index + 1,
          run.status,
          spread(run.echo),
          spread(run.resize),
          ...run.phaseCpu.map((phase) => number(phase.matchedCpuSeconds)),
        ]),
      );
    });
  for (const target of targets)
    target.runs.forEach((run, index) => {
      for (const phase of run.phaseCpu) {
        const observations = phase.limitations.filter((item) => !CPU_LIMITATIONS.includes(item));
        if (observations.length || phase.missingPids.length || phase.addedPids.length)
          lines.push(
            `- ${cell(target.target)} run ${index + 1} ${phase.phase}: missing PIDs [${phase.missingPids.join(", ")}]; added PIDs [${phase.addedPids.join(", ")}]. ${cell(observations.join(" "))}`,
          );
      }
    });
  if (report.limitations?.length)
    lines.push(
      "",
      "## Recorded limitations",
      "",
      ...report.limitations.map((limitation) => `- ${cell(limitation)}`),
    );
  lines.push(
    "",
    "Exact artifacts, run ordering, raw timestamps, process ownership and cleanup evidence remain in the accompanying report.json.",
    "",
  );
  return lines.join("\n");
}
