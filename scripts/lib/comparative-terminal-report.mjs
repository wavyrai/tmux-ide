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
      passed: successful.length,
      failed: own.length - successful.length,
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
        echoSamples: measured(run.samples).length,
        warmups: (run.samples ?? []).filter((sample) => sample.warmup).length,
        resizeSamples: measured(run.resizeSamples).length,
        startupMs: validNumber(run.startupMs) ? run.startupMs : null,
        error: run.error ?? (run.cleanupFailed ? "Owned process cleanup failed" : null),
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
    "Latencies measure terminal parser observation, not physical display refresh or perceived scrolling smoothness. Sequential acknowledged echoes do not measure maximum throughput or establish an overall winner.",
    "",
    "Quantiles use pooled raw, non-warmup samples from passed runs only (nearest rank). Runs are repeated observations, not independent hardware trials. p99 is shown only with at least 100 samples and is descriptive, not a tail-latency guarantee.",
    "",
    "## Echo latency (ms)",
    "",
    row(["Target", "Passed / failed runs", "Samples", "p50", "p95", "p99 (descriptive)"]),
    "| --- | --- | --- | --- | --- | --- |",
    ...targets.map((target) =>
      row([
        target.target,
        `${target.passed} / ${target.failed}`,
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
