#!/usr/bin/env node
/**
 * Read every package's `coverage/coverage-summary.json` (vitest's
 * `json-summary` reporter) and emit a single GitHub-flavored markdown
 * table to stdout. CI pipes the output into `$GITHUB_STEP_SUMMARY` so
 * the result lands on the PR's checks page without needing a bot
 * comment.
 *
 * No dependencies — runs under the same Node the CI step bootstrapped.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

const PACKAGES = [
  { name: "daemon", dir: "packages/daemon", target: 70 },
  { name: "chat-solid", dir: "packages/chat-solid", target: 80 },
  { name: "v2-solid-widgets", dir: "packages/v2-solid-widgets", target: 80 },
  { name: "dashboard", dir: "dashboard", target: 60 },
];

function readSummary(pkgDir) {
  const path = join(ROOT, pkgDir, "coverage", "coverage-summary.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function pct(n) {
  if (typeof n !== "number" || Number.isNaN(n)) return "—";
  return `${n.toFixed(1)}%`;
}

function badge(actualPct, targetPct) {
  if (typeof actualPct !== "number") return "❔";
  if (actualPct >= targetPct) return "✅";
  if (actualPct >= targetPct - 5) return "🟡";
  return "🔻";
}

function row(pkg, summary) {
  if (!summary || !summary.total) {
    return `| **${pkg.name}** | _no report_ | — | — | — | — | — |`;
  }
  const t = summary.total;
  const lines = t.lines?.pct;
  const stmts = t.statements?.pct;
  const funcs = t.functions?.pct;
  const branches = t.branches?.pct;
  return `| **${pkg.name}** | ${badge(lines, pkg.target)} ${pct(lines)} / ${pkg.target}% | ${pct(stmts)} | ${pct(funcs)} | ${pct(branches)} | _see HTML artifact_ |`;
}

const rows = PACKAGES.map((pkg) => row(pkg, readSummary(pkg.dir)));

const out = [
  "## 📊 Vitest coverage",
  "",
  "Per-package coverage, scoped to the files exercised by each test harness.",
  "Lines column shows actual / target; ✅ = at-or-above target, 🟡 = within 5 pts, 🔻 = below floor.",
  "",
  "| Package | Lines | Statements | Functions | Branches | Notes |",
  "|---|---|---|---|---|---|",
  ...rows,
  "",
  "<sub>HTML reports uploaded as the `coverage-html` artifact.</sub>",
];

process.stdout.write(out.join("\n") + "\n");
