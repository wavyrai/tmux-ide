#!/usr/bin/env node

/**
 * Interactive OpenTUI test-drive harness.
 *
 * Hosts the real tmux-ide app in an internal tmux session so humans and
 * automation can inspect the same renderer without taking over the invoking
 * terminal. The target workspace remains on tmux's default socket; only the
 * `_tmux-ide-testdrive` host is owned by this script.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hostSession = "_tmux-ide-testdrive";
const runtimeDir = join(repoRoot, ".tasks", "tui-testdrive");
const stateHome = join(runtimeDir, "home");
const launcherPath = join(runtimeDir, "launch.sh");
const logPath = join(runtimeDir, "stderr.log");
const perfLogPath = join(runtimeDir, "performance.jsonl");
const metadataPath = join(runtimeDir, "state.json");
const namespaceSocketName = `tmux-ide-testdrive-${process.getuid?.() ?? process.pid}`;
const cleanupToken = `testdrive:cleanup:${process.getuid?.() ?? process.pid}`;
const compiledTui = join(repoRoot, "packages", "daemon", "dist", "tui", "tmux-ide-tui");
const sourceTui = join(repoRoot, "packages", "daemon", "src", "tui", "mirror", "app.tsx");

function usage() {
  return `OpenTUI test-drive harness

Usage:
  pnpm tui:testdrive start [--target NAME] [--cols N] [--rows N] [--source] [--debug]
  pnpm tui:testdrive restart [start options]
  pnpm tui:testdrive capture [--ansi] [--history N]
  pnpm tui:testdrive key <tmux-key> [...]
  pnpm tui:testdrive text <literal text>
  pnpm tui:testdrive mouse drag <from-x> <from-y> <to-x> <to-y>
  pnpm tui:testdrive mouse click <x> <y>
  pnpm tui:testdrive mouse <move|down|hold|up> <x> <y>
  pnpm tui:testdrive resize <cols> <rows>
  pnpm tui:testdrive attach
  pnpm tui:testdrive logs
  pnpm tui:testdrive status [--json]
  pnpm tui:testdrive stop
  pnpm tui:testdrive smoke [--target NAME] [--source]

Examples:
  pnpm tui:testdrive start --target new-name --cols 160 --rows 44
  pnpm tui:testdrive capture
  pnpm tui:testdrive key F2
  pnpm tui:testdrive text "echo hello"
  pnpm tui:testdrive key Enter
  pnpm tui:testdrive mouse drag 94 12 104 12
  pnpm tui:testdrive resize 100 30
  pnpm tui:testdrive attach
`;
}

function fail(message) {
  throw new Error(message);
}

function shQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function tmux(args, options = {}) {
  return execFileSync("tmux", args, {
    cwd: repoRoot,
    env: { ...process.env, TMUX: "", TMUX_TMPDIR: "" },
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
}

function sessionExists(name) {
  try {
    tmux(["has-session", "-t", `=${name}`]);
    return true;
  } catch {
    return false;
  }
}

function liveSessions() {
  try {
    return tmux(["list-sessions", "-F", "#{session_name}"])
      .trim()
      .split("\n")
      .map((name) => name.trim())
      .filter((name) => name && !name.startsWith("_") && !name.startsWith("zz-"));
  } catch {
    return [];
  }
}

function parseOptions(args) {
  const options = { target: null, cols: 160, rows: 44, source: false, debug: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--source") options.source = true;
    else if (arg === "--debug") options.debug = true;
    else if (arg === "--target") options.target = args[++index] ?? fail("--target needs a value");
    else if (arg.startsWith("--target=")) options.target = arg.slice("--target=".length);
    else if (arg === "--cols") options.cols = numberOption("--cols", args[++index]);
    else if (arg.startsWith("--cols=")) {
      options.cols = numberOption("--cols", arg.slice("--cols=".length));
    } else if (arg === "--rows") options.rows = numberOption("--rows", args[++index]);
    else if (arg.startsWith("--rows=")) {
      options.rows = numberOption("--rows", arg.slice("--rows=".length));
    } else fail(`Unknown option: ${arg}`);
  }
  if (options.cols < 40 || options.rows < 12) fail("test-drive size must be at least 40x12");
  return options;
}

function numberOption(name, raw) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) fail(`${name} must be a positive integer`);
  return value;
}

function coordinateOption(name, raw) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) fail(`${name} must be a non-negative integer`);
  return value;
}

function sendMouse(type, x, y) {
  if (!sessionExists(hostSession)) fail("The test-drive TUI is not running");
  // SGR mouse coordinates are one-based. OpenTUI receives these directly on
  // the hosted pane PTY, exactly as it would from a mouse-capable terminal.
  const suffix = type === "up" ? "m" : "M";
  const buttonCode = type === "drag" ? 32 : type === "move" ? 35 : 0;
  const sequence = `\u001b[<${buttonCode};${x + 1};${y + 1}${suffix}`;
  tmux(["send-keys", "-t", `=${hostSession}:0.0`, "-l", sequence]);
}

async function mouse(args) {
  const [gesture, ...coordinates] = args;
  if (["move", "down", "hold", "up"].includes(gesture)) {
    const x = coordinateOption("x", coordinates[0]);
    const y = coordinateOption("y", coordinates[1]);
    sendMouse(gesture === "hold" ? "drag" : gesture, x, y);
    return;
  }
  if (gesture === "click") {
    const x = coordinateOption("x", coordinates[0]);
    const y = coordinateOption("y", coordinates[1]);
    sendMouse("down", x, y);
    await delay(20);
    sendMouse("up", x, y);
    return;
  }
  if (gesture === "drag") {
    const fromX = coordinateOption("from-x", coordinates[0]);
    const fromY = coordinateOption("from-y", coordinates[1]);
    const toX = coordinateOption("to-x", coordinates[2]);
    const toY = coordinateOption("to-y", coordinates[3]);
    sendMouse("down", fromX, fromY);
    await delay(20);
    const steps = Math.max(1, Math.min(12, Math.max(Math.abs(toX - fromX), Math.abs(toY - fromY))));
    for (let step = 1; step <= steps; step += 1) {
      const x = Math.round(fromX + ((toX - fromX) * step) / steps);
      const y = Math.round(fromY + ((toY - fromY) * step) / steps);
      sendMouse("drag", x, y);
      await delay(8);
    }
    sendMouse("up", toX, toY);
    return;
  }
  fail(
    "mouse needs `<move|down|hold|up> <x> <y>`, `click <x> <y>`, or `drag <from-x> <from-y> <to-x> <to-y>`",
  );
}

function resolveTarget(requested) {
  const sessions = liveSessions();
  const target = requested ?? sessions[0];
  if (!target) fail("No live workspace session found; pass --target after starting a workspace");
  if (!sessions.includes(target)) {
    fail(
      `Target session ${JSON.stringify(target)} is not live (available: ${sessions.join(", ")})`,
    );
  }
  return target;
}

function capture({ ansi = false, history = 0 } = {}) {
  if (!sessionExists(hostSession)) fail("The test-drive TUI is not running");
  const args = ["capture-pane", "-p", "-t", `=${hostSession}:0.0`, "-S", String(-history)];
  if (ansi) args.splice(1, 0, "-e");
  return tmux(args).replace(/\n+$/u, "");
}

function readMetadata() {
  try {
    return JSON.parse(readFileSync(metadataPath, "utf8"));
  } catch {
    return null;
  }
}

function liveHostSize() {
  if (!sessionExists(hostSession)) return null;
  try {
    const [cols, rows] = tmux([
      "display-message",
      "-p",
      "-t",
      `=${hostSession}:0.0`,
      "#{window_width} #{window_height}",
    ])
      .trim()
      .split(/\s+/u)
      .map(Number);
    return Number.isInteger(cols) && Number.isInteger(rows) ? { cols, rows } : null;
  } catch {
    return null;
  }
}

function daemonStatus() {
  try {
    const path = join(stateHome, "daemon.json");
    const daemon = JSON.parse(readFileSync(path, "utf8"));
    process.kill(daemon.pid, 0);
    return { running: true, pid: daemon.pid, port: daemon.port, instanceId: daemon.instanceId };
  } catch {
    return { running: false };
  }
}

async function waitForFrame(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let frame = "";
  while (Date.now() < deadline) {
    if (!sessionExists(hostSession)) break;
    try {
      frame = capture();
    } catch {
      // The tmux pane can disappear between has-session and capture-pane when
      // the renderer fails during startup. Fall through to the retained log.
      break;
    }
    if (predicate(frame)) return frame;
    await delay(100);
  }
  const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "(no stderr log)";
  fail(`Timed out waiting for the TUI frame\n\n${frame}\n\n--- stderr ---\n${log}`);
}

function frameHasLiveWorkspace(frame) {
  // The canonical daemon projects its readiness fact while standalone mode
  // projects the local `live` notification. Both prove that SessionMirror has
  // completed the same attachment transition. Match a stable prefix because
  // OpenTUI intentionally clips the longer authority fact in compact frames.
  return frame.includes("Live tmux sessi") || frame.includes(" · live · ");
}

function stop({ quiet = false } = {}) {
  if (!sessionExists(hostSession)) {
    if (!quiet) process.stdout.write("OpenTUI test-drive is not running\n");
    return;
  }
  try {
    tmux(["send-keys", "-t", `=${hostSession}:0.0`, "C-q"]);
  } catch {
    // The renderer may already be exiting.
  }
}

async function ensureStopped() {
  stop({ quiet: true });
  for (let attempt = 0; attempt < 20 && sessionExists(hostSession); attempt += 1) {
    await delay(50);
  }
  if (sessionExists(hostSession)) tmux(["kill-session", "-t", `=${hostSession}`]);
}

async function start(args) {
  const options = parseOptions(args);
  const target = resolveTarget(options.target);
  const runtime = options.source ? "source" : "compiled";
  if (!options.source && !existsSync(compiledTui)) {
    fail(`Compiled TUI missing at ${compiledTui}; run pnpm build:tui or pass --source`);
  }
  if (options.source && !existsSync(sourceTui)) fail(`OpenTUI source missing at ${sourceTui}`);

  await ensureStopped();
  mkdirSync(stateHome, { recursive: true });
  // canonical-daemon.ts deliberately rejects a daemon record whose parent is
  // accessible by group/others. The test-drive home is normally disposable,
  // so mkdir's umask-derived mode can otherwise make a correctly copied record
  // look absent and leave the TUI in its reconnecting state forever.
  chmodSync(stateHome, 0o700);
  if (process.env.TMUX_IDE_TESTDRIVE_USE_CANONICAL_DAEMON === "1") {
    const canonicalHome = join(process.env.HOME ?? "", ".tmux-ide");
    const daemonInfoPath = join(canonicalHome, "daemon.json");
    if (!existsSync(daemonInfoPath)) fail(`Canonical daemon info missing at ${daemonInfoPath}`);
    const copiedDaemonInfoPath = join(stateHome, "daemon.json");
    copyFileSync(daemonInfoPath, copiedDaemonInfoPath);
    chmodSync(copiedDaemonInfoPath, 0o600);

    // Keep the copied daemon generation and its durable environment identity
    // coherent. Current OpenTUI routing only needs daemon.json, but carrying
    // the authority bundle prevents future environment-aware clients from
    // silently minting a second identity inside the isolated test home.
    const environmentInfoPath = join(canonicalHome, "environment.json");
    if (existsSync(environmentInfoPath)) {
      const copiedEnvironmentInfoPath = join(stateHome, "environment.json");
      copyFileSync(environmentInfoPath, copiedEnvironmentInfoPath);
      chmodSync(copiedEnvironmentInfoPath, 0o600);
    }
  }
  rmSync(logPath, { force: true });
  rmSync(perfLogPath, { force: true });

  const binary = options.source ? "bun" : compiledTui;
  const binaryArgs = options.source
    ? [sourceTui, `--target=${target}`]
    : ["app", `--target=${target}`];
  const launchEpochMs = Date.now();
  const environment = [
    `TMUX_IDE_CWD=${shQuote(repoRoot)}`,
    `TMUX_IDE_HOME=${shQuote(stateHome)}`,
    ...(process.env.TMUX_IDE_TESTDRIVE_USE_CANONICAL_DAEMON === "1"
      ? []
      : [
          "TMUX_IDE_RUNTIME_MODE=testdrive",
          `TMUX_IDE_REGISTRY_DIR=${shQuote(join(runtimeDir, "registry"))}`,
          `TMUX_IDE_DAEMON_INFO_DIR=${shQuote(stateHome)}`,
          `TMUX_IDE_TMUX_SOCKET_NAME=${shQuote(namespaceSocketName)}`,
          `TMUX_IDE_CLEANUP_TOKEN=${shQuote(cleanupToken)}`,
        ]),
    `TMUX_IDE_CLI=${shQuote(join(repoRoot, "bin", "cli.js"))}`,
    `TMUX_IDE_TUI_PERF_LOG=${shQuote(perfLogPath)}`,
    `TMUX_IDE_TUI_LAUNCH_EPOCH_MS=${launchEpochMs}`,
    ...(process.env.TMUX_IDE_PERFORMANCE_TRACE_LOG
      ? [
          `TMUX_IDE_PERFORMANCE_TRACE_LOG=${shQuote(process.env.TMUX_IDE_PERFORMANCE_TRACE_LOG)}`,
          `TMUX_IDE_PERFORMANCE_TRACE_COMMIT=${shQuote(process.env.TMUX_IDE_PERFORMANCE_TRACE_COMMIT ?? "")}`,
          `TMUX_IDE_PERFORMANCE_TRACE_TREE=${shQuote(process.env.TMUX_IDE_PERFORMANCE_TRACE_TREE ?? "")}`,
        ]
      : []),
    ...(process.env.TMUX_IDE_TESTDRIVE_USE_CANONICAL_DAEMON === "1"
      ? ["TMUX_IDE_TESTDRIVE_USE_CANONICAL_DAEMON=1"]
      : []),
    ...(process.env.TMUX_IDE_ZZ_LOG
      ? [`TMUX_IDE_ZZ_LOG=${shQuote(process.env.TMUX_IDE_ZZ_LOG)}`]
      : []),
    ...(options.debug ? ["TMUX_IDE_MIRROR_DEBUG=1"] : []),
  ];
  writeFileSync(
    launcherPath,
    [
      "#!/bin/sh",
      // Bun source mode needs the checkout bunfig preload. The standalone
      // binary must run outside that tree or Bun tries to preload Solid again.
      `cd ${shQuote(options.source ? repoRoot : stateHome)}`,
      `export ${environment.join(" ")}`,
      `exec ${shQuote(binary)} ${binaryArgs.map(shQuote).join(" ")} 2>>${shQuote(logPath)}`,
      "",
    ].join("\n"),
  );
  chmodSync(launcherPath, 0o700);

  const launchStartedAt = performance.now();
  tmux([
    "new-session",
    "-d",
    "-s",
    hostSession,
    "-x",
    String(options.cols),
    "-y",
    String(options.rows),
    "-c",
    repoRoot,
    launcherPath,
  ]);
  const frame = await waitForFrame((value) => value.includes("tmux-ide"));
  const firstFrameMs = performance.now() - launchStartedAt;
  const metadata = {
    hostSession,
    target,
    cols: options.cols,
    rows: options.rows,
    runtime,
    debug: options.debug,
    startedAt: new Date().toISOString(),
    firstFrameMs: Math.round(firstFrameMs),
  };
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

  process.stdout.write(
    `OpenTUI test-drive ready in ${firstFrameMs.toFixed(0)}ms (${runtime}, ${options.cols}x${options.rows}, target ${target})\n` +
      `Attach: tmux attach -t ${hostSession}\n` +
      `Logs:   ${logPath}\n\n${frame}\n`,
  );
}

async function status(json = false) {
  const running = sessionExists(hostSession);
  const result = {
    running,
    ...readMetadata(),
    ...(running ? liveHostSize() : null),
    daemon: daemonStatus(),
    logPath,
    perfLogPath,
  };
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(
      `${result.running ? "running" : "stopped"}: ${hostSession}\n` +
        `${result.target ? `target: ${result.target}\n` : ""}` +
        `${result.runtime ? `runtime: ${result.runtime}\n` : ""}` +
        `daemon: ${result.daemon.running ? `pid ${result.daemon.pid}, port ${result.daemon.port}` : "stopped"}\n` +
        `logs: ${logPath}\n`,
    );
  }
}

async function smoke(args) {
  const attachBudgetMs = numberOption(
    "TUI_LIVE_ATTACH_BUDGET_MS",
    process.env.TUI_LIVE_ATTACH_BUDGET_MS ?? "10000",
  );
  const resizeBudgetMs = numberOption(
    "TUI_LIVE_RESIZE_BUDGET_MS",
    process.env.TUI_LIVE_RESIZE_BUDGET_MS ?? "1000",
  );
  await start(args);
  try {
    const attachStartedAt = performance.now();
    tmux(["send-keys", "-t", `=${hostSession}:0.0`, "F2"]);
    await waitForFrame(
      (frame) => frame.includes("Terminals") && frameHasLiveWorkspace(frame),
      attachBudgetMs,
    );
    const attachMs = performance.now() - attachStartedAt;
    if (attachMs > attachBudgetMs) fail(`live attach took ${attachMs.toFixed(0)}ms`);
    let maxResizeMs = 0;
    for (const [cols, rows] of [
      [100, 30],
      [160, 44],
      [200, 60],
    ]) {
      const resizeStartedAt = performance.now();
      tmux(["resize-window", "-t", `=${hostSession}`, "-x", String(cols), "-y", String(rows)]);
      const frame = await waitForFrame((value) => {
        const size = liveHostSize();
        return (
          size?.cols === cols &&
          size.rows === rows &&
          value.includes("tmux-ide") &&
          value.includes("Terminals") &&
          value.includes("agents ·") &&
          value.includes("Files") &&
          frameHasLiveWorkspace(value)
        );
      }, resizeBudgetMs);
      if (frame.split("\n").some((line) => line.length > cols * 2)) {
        fail(`${cols}x${rows} frame emitted an implausibly wide row`);
      }
      const resizeMs = performance.now() - resizeStartedAt;
      if (resizeMs > resizeBudgetMs) {
        fail(`${cols}x${rows} resize took ${resizeMs.toFixed(0)}ms (budget ${resizeBudgetMs}ms)`);
      }
      maxResizeMs = Math.max(maxResizeMs, resizeMs);
    }
    process.stdout.write(
      `OpenTUI live smoke passed: attached in ${attachMs.toFixed(0)}ms ` +
        `(budget ${attachBudgetMs}ms), then settled at 100x30, 160x44, and 200x60 ` +
        `in at most ${maxResizeMs.toFixed(0)}ms (budget ${resizeBudgetMs}ms)\n`,
    );
  } finally {
    await ensureStopped();
  }
}

async function main() {
  const [command = "status", ...args] = process.argv.slice(2);
  switch (command) {
    case "start":
    case "restart":
      await start(args);
      break;
    case "capture": {
      let ansi = false;
      let history = 0;
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] === "--ansi") ansi = true;
        else if (args[index] === "--history") history = numberOption("--history", args[++index]);
        else fail(`Unknown capture option: ${args[index]}`);
      }
      process.stdout.write(`${capture({ ansi, history })}\n`);
      break;
    }
    case "key":
      if (args.length === 0) fail("key needs at least one tmux key name");
      tmux(["send-keys", "-t", `=${hostSession}:0.0`, ...args]);
      break;
    case "text":
      if (args.length === 0) fail("text needs literal text to send");
      tmux(["send-keys", "-t", `=${hostSession}:0.0`, "-l", args.join(" ")]);
      break;
    case "mouse":
      await mouse(args);
      break;
    case "resize": {
      const cols = numberOption("cols", args[0]);
      const rows = numberOption("rows", args[1]);
      tmux(["resize-window", "-t", `=${hostSession}`, "-x", String(cols), "-y", String(rows)]);
      break;
    }
    case "attach":
      if (!sessionExists(hostSession)) fail("The test-drive TUI is not running");
      tmux(
        process.env.TMUX
          ? ["switch-client", "-t", `=${hostSession}`]
          : ["attach", "-t", `=${hostSession}`],
        {
          inherit: true,
        },
      );
      break;
    case "logs":
      process.stdout.write(existsSync(logPath) ? readFileSync(logPath, "utf8") : "No log yet\n");
      break;
    case "status":
      await status(args.includes("--json"));
      break;
    case "stop":
      await ensureStopped();
      process.stdout.write("OpenTUI test-drive stopped\n");
      break;
    case "smoke":
      await smoke(args);
      break;
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(usage());
      break;
    default:
      fail(`Unknown command: ${command}\n\n${usage()}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
