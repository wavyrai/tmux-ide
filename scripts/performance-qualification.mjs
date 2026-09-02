#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gitSourceIdentity, validateReferenceReport } from "./lib/performance-reference-report.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = resolve(root, "performance/qualification-baseline.json");
const reportPath = resolve(
  root,
  process.env.TMUX_IDE_QUALIFICATION_REPORT ?? "artifacts/performance-qualification.json",
);
const summaryPath = resolve(
  root,
  process.env.TMUX_IDE_QUALIFICATION_SUMMARY ?? "artifacts/performance-qualification-summary.md",
);
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const source = gitSourceIdentity(root);
const commit = source.commit;
const referenceReport = process.env.TMUX_IDE_REFERENCE_REPORT
  ? validateReferenceReport(
      JSON.parse(readFileSync(resolve(root, process.env.TMUX_IDE_REFERENCE_REPORT), "utf8")),
      source,
    )
  : null;
const portableEvidence = process.env.TMUX_IDE_PORTABLE_EVIDENCE_REPORT
  ? JSON.parse(readFileSync(resolve(root, process.env.TMUX_IDE_PORTABLE_EVIDENCE_REPORT), "utf8"))
  : null;
if (referenceReport && referenceReport.status !== "passed")
  throw new Error(`Explicit reference qualification is ${referenceReport.status}, not passed`);
if (portableEvidence && !["passed", "passed-with-limitations"].includes(portableEvidence.status))
  throw new Error(
    `Explicit portable performance evidence is ${portableEvidence.status}, not passed`,
  );

validateReferenceBudget(baseline.referenceLatencyBudget);
validateReferenceResult(baseline.referenceResult);

const suites = [
  {
    name: "contracts",
    workspace: "@tmux-ide/contracts",
    files: [
      "src/__tests__/performance-qualification.test.ts",
      "src/__tests__/performance-metrics.test.ts",
    ],
    assertions: [
      "qualification traces preserve clock-domain boundaries",
      "local HUD snapshots reject malformed measurements",
    ],
  },
  {
    name: "core",
    workspace: "@tmux-ide/core",
    files: [
      "src/performance-qualification.test.ts",
      "src/performance-metrics.test.ts",
      "src/interaction-receipts.test.ts",
    ],
    assertions: [
      "the exact 60 Hz budget and deterministic percentiles are enforced",
      "2/4/8-client convergence identities and queue bounds are evaluated",
      "authenticated and external interaction projections remain distinct",
    ],
  },
  {
    name: "daemon-runtime",
    workspace: "@tmux-ide/daemon",
    files: [
      "src/terminal/mirror/__tests__/scripted-channel.test.ts",
      "src/terminal/session-runtime/runtime-qualification.test.ts",
      "src/terminal/session-runtime/terminal-replica-performance.test.ts",
      "src/terminal/session-runtime/semantic-mutation-executor.test.ts",
      "src/lib/tmux-external-interaction-observer.test.ts",
    ],
    assertions: [
      "one canonical control lane converges 2/4/8 clients under terminal flood",
      "paste and named-key input retain order",
      "slow and hidden clients remain bounded and recover through reseed",
      "terminal parsing coalesces flood work and remains idle without grid work",
      "semantic mutations reach observed, rejected, or timed-out terminal outcomes",
      "external tmux input cannot forge authenticated source identity",
    ],
  },
  {
    name: "opentui",
    workspace: "@tmux-ide/daemon",
    files: [
      "src/tui/mirror/performance-events.test.ts",
      "src/tui/mirror/features/performance-hud/session.test.ts",
      "src/tui/mirror/runtime/performance-hud-optional-feature.test.ts",
      "src/tui/mirror/semantic-pane-render-source.test.ts",
      "src/tui/mirror/frame-coalescer.test.ts",
      "src/tui/mirror/resize-transaction.test.ts",
      "src/tui/mirror/theme.test.ts",
      "src/tui/mirror/pane-mirror.test.ts",
    ],
    assertions: [
      "the HUD remains demand-loaded and installs no polling loop",
      "terminal delivery metrics publish only after retained state applies",
      "frame requests and pointer-resize floods coalesce before one durable mutation",
      "idle panes do not advance content work",
      "full ANSI, truecolor, and explicit black terminal backgrounds remain protocol-faithful",
    ],
  },
  {
    name: "web",
    workspace: "@tmux-ide/desktop-renderer",
    files: [
      "src/runtime/gui-performance-telemetry.test.ts",
      "src/runtime/gui-performance-hud.test.tsx",
      "src/experience/workspace-tiled-surface.test.tsx",
      "src/terminal/workspace-pane-compositor.test.ts",
      "src/terminal/xterm-renderer.test.ts",
    ],
    assertions: [
      "the HUD remains opt-in and browser-frame work coalesces across panes",
      "drag, swap, and resize floods produce one preview cadence and durable mutation",
      "terminal presentation fanout fences stale work and bounds replay and layout candidates",
      "authenticated pane relationships render without inventing external sources",
      "explicit ANSI colors remain protocol-faithful across themes",
    ],
  },
];

const scenarioDefinitions = [
  scenario(
    "input-and-paste",
    ["daemon-runtime"],
    ["raw pasted text precedes the named Enter key on the single control lane"],
  ),
  scenario(
    "pty-flood-and-alternate-screen",
    ["daemon-runtime"],
    [
      "500 streamed writes plus alternate-screen transitions converge",
      "10,000 same-turn chunks coalesce into one parse and one dirty row",
    ],
  ),
  scenario(
    "resize-flood",
    ["opentui", "web"],
    [
      "1,000 OpenTUI pointer moves stay local and submit once",
      "web pointer floods coalesce to one preview frame and one durable resize",
    ],
  ),
  scenario(
    "drag-split-and-move",
    ["daemon-runtime", "web"],
    [
      "structural intents share one ordered semantic mutation lane",
      "web pane dragging commits one canonical swap and adopts tmux confirmation",
    ],
  ),
  scenario(
    "two-four-eight-clients",
    ["core", "daemon-runtime"],
    ["2, 4, and 8 clients converge on generation, incarnation, revision, and state hash"],
  ),
  scenario(
    "slow-and-hidden-clients",
    ["core", "daemon-runtime"],
    ["slow and hidden delivery stays bounded and reconverges after visibility resumes"],
  ),
  scenario(
    "drop-socket-crash-and-generation",
    ["daemon-runtime", "web"],
    ["NACK reseed, control exit, daemon generation rollover, and web reconnect are bounded"],
  ),
  scenario(
    "authenticated-and-external-interactions",
    ["core", "daemon-runtime", "web"],
    ["authenticated sends/reads retain source identity while external tmux traffic does not"],
  ),
  scenario(
    "themes-and-terminal-colors",
    ["opentui", "web"],
    ["both adapters preserve the complete ANSI palette, truecolor, and explicit backgrounds"],
  ),
  scenario(
    "bounded-queues-and-idle-work",
    ["core", "daemon-runtime", "opentui"],
    ["bounded queues, parser coalescing, and zero idle terminal grid work are asserted"],
  ),
  scenario(
    "mutation-terminal-outcomes",
    ["core", "daemon-runtime", "opentui"],
    ["accepted mutations terminate as observed, rejected, or timed-out without duplicate settle"],
  ),
  {
    id: "cold-and-warm-startup",
    coverage: portableEvidence
      ? "measured-portable"
      : referenceReport
        ? "measured-reference-only"
        : "not-covered",
    suites: [],
    assertions: [],
    reason: portableEvidence
      ? `Isolated startup measurement is ${portableEvidence.measurements.startup.status}.`
      : referenceReport
        ? `Reference startup measurement is ${referenceReport.measurements.startup.status}; portable CI does not infer it.`
        : "No deterministic portable test currently measures cold and warm startup through first paint.",
  },
  {
    id: "reference-input-to-paint-latency",
    coverage:
      referenceReport?.measurements.inputToPaint.status === "passed"
        ? "measured-reference-only"
        : "not-measured",
    suites: [],
    assertions: [],
    reason: referenceReport
      ? `Reference input-to-paint measurement is ${referenceReport.measurements.inputToPaint.status}; portable CI does not infer it.`
      : "The portable gate validates the budget evaluator but does not measure wall-clock UI latency.",
  },
  {
    id: "process-memory-slope",
    coverage:
      portableEvidence?.measurements.memory.status === "passed"
        ? "measured-portable"
        : referenceReport?.measurements.memory.status === "passed"
          ? "measured-reference-only"
          : "not-measured",
    suites: [],
    assertions: [],
    reason: portableEvidence
      ? `Isolated process-memory measurement is ${portableEvidence.measurements.memory.status}.`
      : referenceReport
        ? `Reference memory measurement is ${referenceReport.measurements.memory.status}; portable CI does not infer it.`
        : "Portable tests prove bounded queues and caches, but do not claim deterministic RSS or heap slope.",
  },
  {
    id: "coherent-terminal-frame",
    coverage:
      portableEvidence?.measurements.coherentTerminalFrame.status === "passed"
        ? "measured-portable"
        : "not-measured",
    suites: [],
    assertions: [],
    reason: portableEvidence
      ? `Portable coherent-terminal evidence is ${portableEvidence.measurements.coherentTerminalFrame.status}.`
      : "No explicit ProductTestRig state was supplied to the portable evidence run.",
  },
  {
    id: "portable-resize-and-drag-responsiveness",
    coverage:
      portableEvidence?.measurements.resizeResponsiveness.status === "passed"
        ? "partially-measured-portable"
        : "not-measured",
    suites: ["opentui", "web"],
    assertions: ["resize geometry settles within a portable command budget"],
    reason: portableEvidence
      ? `Resize is ${portableEvidence.measurements.resizeResponsiveness.status}; drag is ${portableEvidence.measurements.dragResponsiveness.status}.`
      : "Contract tests cover coalescing, but no portable latency artifact was supplied.",
  },
  {
    id: "deterministic-visual-captures",
    coverage:
      portableEvidence?.measurements.visualDeterminism.status === "passed"
        ? "measured-portable"
        : "not-measured",
    suites: ["opentui"],
    assertions: ["two idle captures of one mounted document have identical SHA-256 digests"],
    reason: portableEvidence
      ? `Portable capture determinism is ${portableEvidence.measurements.visualDeterminism.status}.`
      : "Renderer snapshots are deterministic in tests, but no live capture digest artifact was supplied.",
  },
  {
    id: "supported-tmux-capability-matrix",
    coverage:
      portableEvidence?.measurements.tmuxSupport.status === "passed"
        ? "measured-portable"
        : "not-measured",
    suites: [],
    assertions: [],
    reason: portableEvidence
      ? `Installed tmux capability matrix is ${portableEvidence.measurements.tmuxSupport.status}.`
      : "No portable tmux capability observation was supplied.",
  },
];

const results = [];
let failed = false;
for (const suite of suites) {
  const args = ["--filter", suite.workspace, "exec", "vitest", "run", ...suite.files];
  const started = performance.now();
  const result = spawnSync("pnpm", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  const durationMs = Number((performance.now() - started).toFixed(2));
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  const status = result.status === 0 ? "passed" : "failed";
  results.push({
    name: suite.name,
    workspace: suite.workspace,
    files: suite.files,
    assertions: suite.assertions,
    durationMs,
    status,
    exitCode: result.status ?? 1,
  });
  if (result.status !== 0) failed = true;
}

const byName = new Map(results.map((result) => [result.name, result]));
const scenarioEvidence = scenarioDefinitions.map((definition) => {
  const executions = definition.suites.map((suiteName) => {
    const result = byName.get(suiteName);
    if (!result) throw new Error(`Unknown qualification suite ${suiteName}`);
    return {
      suite: suiteName,
      status: result.status,
      durationMs: result.durationMs,
      files: result.files,
    };
  });
  const executionFailed = executions.some(({ status }) => status !== "passed");
  return {
    ...definition,
    status:
      definition.coverage === "covered"
        ? executionFailed
          ? "failed"
          : "passed"
        : definition.coverage,
    executions,
  };
});

const measuredStages = referenceReport?.measurements.inputToPaint.summary?.stages ?? {};
const stageTimings = Object.fromEntries(
  ["input", "tmux", "parse", "reduce", "transport", "paint"].map((stage) => [
    stage,
    measuredStages[stage]
      ? { status: "measured-reference-only", summary: measuredStages[stage] }
      : {
          status: "not-measured",
          reason:
            "Portable CI validates trace contracts but does not collect production-path stage samples.",
        },
  ]),
);

const report = {
  version: 2,
  generatedAt: new Date().toISOString(),
  commit,
  portableGate: {
    status: failed ? "failed" : "passed",
    suites: results,
    scenarios: scenarioEvidence,
    stageTimings,
  },
  referenceLatency: {
    budget: baseline.referenceLatencyBudget,
    result: baseline.referenceResult,
    status:
      baseline.referenceResult === null
        ? "not-measured"
        : baseline.referenceResult.commit !== commit
          ? "stale-commit"
          : baseline.referenceResult.observedP95Ms <= baseline.referenceLatencyBudget.p95Ms
            ? "passed"
            : "failed",
  },
  referenceQualification: referenceReport,
  portableEvidence,
  limitations: [
    "Suite wall durations are runner diagnostics, not UI latency measurements.",
    referenceReport
      ? "Reference-host measurements remain distinct from portable CI and are never generalized to other hosts."
      : portableEvidence
        ? "Headless startup measures first mounted application frame; visible terminal first-frame and input-to-paint remain reference-only."
        : "Cold/warm startup, production stage timings, and process-memory slope remain explicitly unmeasured.",
    "Whether this workflow is required by repository branch protection is external to this artifact.",
  ],
};

mkdirSync(dirname(reportPath), { recursive: true });
mkdirSync(dirname(summaryPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(summaryPath, markdownSummary(report));
process.stdout.write(`\nqualification report: ${reportPath}\n`);
process.stdout.write(`qualification summary: ${summaryPath}\n`);
process.exitCode = failed ? 1 : 0;

function scenario(id, suites, assertions) {
  return { id, coverage: "covered", suites, assertions, reason: null };
}

function validateReferenceBudget(budget) {
  if (typeof budget !== "object" || budget === null || Array.isArray(budget))
    throw new TypeError("referenceLatencyBudget must be an object");
  if (typeof budget.metric !== "string" || budget.metric.length === 0)
    throw new TypeError("referenceLatencyBudget.metric must be a non-empty string");
  if (!Number.isFinite(budget.p95Ms) || budget.p95Ms <= 0)
    throw new TypeError("referenceLatencyBudget.p95Ms must be finite and positive");
  if (budget.comparison !== "less-than-or-equal")
    throw new TypeError("referenceLatencyBudget.comparison must be less-than-or-equal");
  if (typeof budget.clockRule !== "string" || budget.clockRule.length === 0)
    throw new TypeError("referenceLatencyBudget.clockRule must be a non-empty string");
}

function validateReferenceResult(result) {
  if (result === null) return;
  if (typeof result !== "object" || Array.isArray(result))
    throw new TypeError("referenceResult must be null or an object");
  for (const field of ["host", "commit", "measuredAt"])
    if (typeof result[field] !== "string" || result[field].length === 0)
      throw new TypeError(`referenceResult.${field} must be a non-empty string`);
  if (!/^[0-9a-f]{40}$/u.test(result.commit))
    throw new TypeError("referenceResult.commit must be a full lowercase git commit");
  if (Number.isNaN(Date.parse(result.measuredAt)))
    throw new TypeError("referenceResult.measuredAt must be an ISO-8601 timestamp");
  if (!Number.isSafeInteger(result.samples) || result.samples <= 0)
    throw new TypeError("referenceResult.samples must be a positive integer");
  if (!Number.isFinite(result.observedP95Ms) || result.observedP95Ms < 0)
    throw new TypeError("referenceResult.observedP95Ms must be finite and non-negative");
}

function markdownSummary(value) {
  const lines = [
    "## Performance qualification",
    "",
    `Portable gate: **${value.portableGate.status}**`,
    "",
    "| Suite | Status | Duration | Files |",
    "| --- | --- | ---: | ---: |",
    ...value.portableGate.suites.map(
      (suite) =>
        `| ${suite.name} | ${suite.status} | ${suite.durationMs.toFixed(2)} ms | ${suite.files.length} |`,
    ),
    "",
    "| Scenario | Evidence |",
    "| --- | --- |",
    ...value.portableGate.scenarios.map((item) => `| ${item.id} | ${item.status} |`),
    "",
    "Stage timings are **not measured** by portable CI. Suite durations are not treated as UI latency.",
    "",
    `Reference input-to-paint p95 budget: **<= ${value.referenceLatency.budget.p95Ms} ms**.`,
    value.referenceLatency.result === null
      ? "Reference measurement: **not recorded**."
      : `Reference measurement: **${value.referenceLatency.result.observedP95Ms} ms p95** (${value.referenceLatency.result.samples} samples, ${value.referenceLatency.status}).`,
    value.referenceQualification
      ? `Explicit reference artifact: **${value.referenceQualification.status}** (${value.referenceQualification.provenance.cpuModel}).`
      : "Explicit reference artifact: **not provided**.",
    value.portableEvidence
      ? `Isolated executable evidence: **${value.portableEvidence.status}** (startup ${value.portableEvidence.measurements.startup.status}; memory ${value.portableEvidence.measurements.memory.status}; input-to-paint ${value.portableEvidence.measurements.inputToPaint.status}).`
      : "Isolated executable evidence: **not provided**.",
    "",
  ];
  return `${lines.join("\n")}\n`;
}
