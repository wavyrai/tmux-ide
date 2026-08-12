#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = resolve(root, "performance/qualification-baseline.json");
const reportPath = resolve(
  root,
  process.env.TMUX_IDE_QUALIFICATION_REPORT ?? "artifacts/performance-qualification.json",
);
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));

const suites = [
  [
    "contracts",
    [
      "--filter",
      "@tmux-ide/contracts",
      "exec",
      "vitest",
      "run",
      "src/__tests__/performance-qualification.test.ts",
      "src/__tests__/performance-metrics.test.ts",
    ],
  ],
  [
    "core",
    [
      "--filter",
      "@tmux-ide/core",
      "exec",
      "vitest",
      "run",
      "src/performance-qualification.test.ts",
      "src/performance-metrics.test.ts",
    ],
  ],
  [
    "daemon",
    [
      "--filter",
      "@tmux-ide/daemon",
      "exec",
      "vitest",
      "run",
      "src/terminal/mirror/__tests__/scripted-channel.test.ts",
      "src/terminal/session-runtime/runtime-qualification.test.ts",
    ],
  ],
  [
    "web",
    [
      "--filter",
      "@tmux-ide/desktop-renderer",
      "exec",
      "vitest",
      "run",
      "src/runtime/gui-performance-telemetry.test.ts",
      "src/runtime/gui-performance-hud.test.tsx",
    ],
  ],
];

const results = [];
let failed = false;
for (const [name, args] of suites) {
  const started = performance.now();
  const result = spawnSync("pnpm", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  const durationMs = Number((performance.now() - started).toFixed(2));
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  results.push({ name, durationMs, status: result.status ?? 1 });
  if (result.status !== 0) failed = true;
}

const report = {
  version: 1,
  generatedAt: new Date().toISOString(),
  portableGate: {
    status: failed ? "failed" : "passed",
    suites: results,
    invariants: baseline.portableInvariants,
    stageCoverage: ["input", "tmux", "parse", "reduce", "transport", "paint"],
  },
  referenceLatency: baseline.referenceLatency,
  note: "Portable CI validates deterministic semantics and bounds. Wall-clock p95 is qualified only on the pinned reference host and is never inferred from CI suite duration.",
};
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`\nqualification report: ${reportPath}\n`);
process.exitCode = failed ? 1 : 0;
