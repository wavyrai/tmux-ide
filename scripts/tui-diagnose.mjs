#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { analyzeTuiDiagnostic } from "./lib/tui-diagnostics.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = join(root, ".tasks", "tui-testdrive");
const artifactDir = join(root, ".tasks", "tui-diagnostics", "latest");
const daemonInfoPath = join(process.env.HOME ?? "", ".tmux-ide", "daemon.json");
const testdrive = join(root, "scripts", "tui-testdrive.mjs");

function parseOptions(argv) {
  const options = { target: null, cols: 160, rows: 50, keep: false, build: true, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--target") options.target = argv[++index] ?? null;
    else if (value?.startsWith("--target=")) options.target = value.slice(9);
    else if (value === "--cols") options.cols = Number(argv[++index]);
    else if (value === "--rows") options.rows = Number(argv[++index]);
    else if (value === "--keep") options.keep = true;
    else if (value === "--no-build") options.build = false;
    else if (value === "--json") options.json = true;
    else throw new Error(`Unknown option: ${value}`);
  }
  if (!Number.isInteger(options.cols) || options.cols < 40) throw new Error("--cols must be >= 40");
  if (!Number.isInteger(options.rows) || options.rows < 12) throw new Error("--rows must be >= 12");
  return options;
}

function command(file, args, options = {}) {
  return execFileSync(file, args, {
    cwd: root,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    stdio: options.quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
  });
}

function tmux(args) {
  return command("tmux", args, { env: { TMUX: "", TMUX_PANE: "" }, quiet: true });
}

function resolveTarget(requested) {
  const sessions = tmux(["list-sessions", "-F", "#{session_name}"])
    .trim()
    .split("\n")
    .filter((name) => name && !name.startsWith("_") && !name.startsWith("zz-"));
  const target = requested ?? sessions[0];
  if (!target || !sessions.includes(target))
    throw new Error(`No live target ${JSON.stringify(target)} (available: ${sessions.join(", ")})`);
  return target;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readTimeline() {
  const path = join(runtimeDir, "performance.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitForTerminalFrame(timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const timeline = readTimeline();
    if (timeline.some((entry) => entry?.phase === "first-terminal-frame")) return timeline;
    if (existsSync(join(runtimeDir, "stderr.log"))) {
      const stderr = readFileSync(join(runtimeDir, "stderr.log"), "utf8");
      if (stderr.trim()) throw new Error(`OpenTUI failed during startup:\n${stderr}`);
    }
    await delay(100);
  }
  throw new Error("Timed out before the first coherent terminal frame");
}

async function daemonJson(daemon, path) {
  const response = await fetch(`http://${daemon.bindHostname}:${daemon.port}${path}`, {
    headers: { Authorization: `Bearer ${daemon.authToken}` },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return body;
}

function paneTruth(target) {
  const records = tmux([
    "list-panes",
    "-s",
    "-t",
    `=${target}`,
    "-F",
    "#{pane_id}\t#{window_id}\t#{window_name}\t#{window_active}\t#{pane_active}\t#{pane_width}\t#{pane_height}",
  ])
    .trim()
    .split("\n")
    .filter(Boolean);
  return records.map((record) => {
    const [paneId, windowId, windowName, windowActive, paneActive, width, height] =
      record.split("\t");
    return {
      paneId,
      windowId,
      windowName,
      windowActive: windowActive === "1",
      paneActive: paneActive === "1",
      width: Number(width),
      height: Number(height),
      capture: tmux(["capture-pane", "-p", "-J", "-t", paneId, "-S", "-40"]).replace(/\n+$/u, ""),
    };
  });
}

function writeArtifact(name, value) {
  const path = join(artifactDir, name);
  writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  return path;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const target = resolveTarget(options.target);
  if (!existsSync(daemonInfoPath)) throw new Error("Canonical daemon is not running");
  if (options.build) command("pnpm", ["build:tui"], { quiet: true });
  rmSync(artifactDir, { recursive: true, force: true });
  mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  chmodSync(artifactDir, 0o700);
  const env = { TMUX_IDE_TESTDRIVE_USE_CANONICAL_DAEMON: "1" };
  try {
    command(
      process.execPath,
      [
        testdrive,
        "restart",
        "--target",
        target,
        "--cols",
        String(options.cols),
        "--rows",
        String(options.rows),
      ],
      { env, quiet: true },
    );
    const timeline = await waitForTerminalFrame();
    await delay(100);
    const frame = command(process.execPath, [testdrive, "capture"], { env, quiet: true });
    const daemon = readJson(daemonInfoPath);
    const [health, identity, catalog, applicationShell] = await Promise.all([
      daemonJson(daemon, "/health"),
      daemonJson(daemon, "/identity"),
      daemonJson(daemon, "/api/resources/workspace-catalog?version=2"),
      daemonJson(daemon, `/api/project/${encodeURIComponent(target)}/application-shell?version=3`),
    ]);
    const panes = paneTruth(target);
    const analysis = analyzeTuiDiagnostic({
      target,
      daemon,
      health,
      identity,
      catalog,
      applicationShell,
      panes,
      frame,
      timeline,
    });
    const report = {
      version: 1,
      measuredAt: new Date().toISOString(),
      target,
      viewport: { cols: options.cols, rows: options.rows },
      daemon: {
        pid: daemon.pid,
        port: daemon.port,
        instanceId: daemon.instanceId,
        productVersion: daemon.productVersion,
      },
      ...analysis,
      artifacts: {
        frame: "frame.txt",
        timeline: "timeline.jsonl",
        stderr: "stderr.log",
        tmuxTruth: "tmux-truth.json",
        catalog: "catalog.json",
        applicationShell: "application-shell.json",
      },
    };
    writeArtifact("frame.txt", frame);
    writeArtifact(
      "timeline.jsonl",
      timeline.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    );
    writeArtifact("tmux-truth.json", panes);
    writeArtifact("catalog.json", catalog);
    writeArtifact("application-shell.json", applicationShell);
    if (existsSync(join(runtimeDir, "stderr.log"))) {
      cpSync(join(runtimeDir, "stderr.log"), join(artifactDir, "stderr.log"));
      chmodSync(join(artifactDir, "stderr.log"), 0o600);
    } else writeArtifact("stderr.log", "");
    const reportPath = writeArtifact("report.json", report);
    if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else {
      process.stdout.write(
        `${report.passed ? "PASS" : "FAIL"} OpenTUI diagnostic for ${target}\n` +
          report.checks
            .map((check) => `${check.passed ? "✓" : "✗"} ${check.id}: ${check.detail}`)
            .join("\n") +
          `\nReport: ${reportPath}\n`,
      );
    }
    if (!report.passed) process.exitCode = 1;
  } finally {
    if (!options.keep) command(process.execPath, [testdrive, "stop"], { env, quiet: true });
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
