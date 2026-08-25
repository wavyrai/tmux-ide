#!/usr/bin/env node

/**
 * Interactive OpenTUI test-drive harness.
 *
 * Hosts the real tmux-ide app in an internal tmux session so humans and
 * automation can inspect the same renderer without taking over the invoking
 * terminal. The target workspace remains on tmux's default socket; only the
 * `_tmux-ide-testdrive` host is owned by this script.
 */

import { execFile, execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { buildTuiHostPublicationEvidence } from "./lib/tui-host-publication.mjs";
import { runBoundedChildCommand } from "./lib/bounded-child-command.mjs";
import {
  acquireClipboardPaneHook,
  ensureClipboardAcquisitionRollback,
  retireClipboardPaneHook,
} from "./lib/tui-testdrive-clipboard-hook.mjs";
import { classifyProductTuiCommandFailure } from "./lib/product-tui-host-readiness.mjs";
import {
  buildTestdriveExecCommand,
  resolveTestdriveCapabilityEnvironment,
  resolvePublicTestdriveEnvironment,
  resolveTestdriveLaunch,
} from "./lib/tui-testdrive-launch.mjs";
import {
  MAX_CLIPBOARD_BYTES,
  MAX_CLIPBOARD_CALLBACK_ARTIFACTS,
  assessClipboardAutoBufferDelta,
  buildClipboardPaneHookCommand,
  deliverExactHostBytes,
  enforceClipboardCallbackCap,
  executeTestdriveInputOperation,
  fullTerminalCapabilities,
  isClipboardObservationTimeout,
  parseClipboardAutoBufferInventory,
  parseClipboardCallbackState,
  parseTestdriveInputDocument,
  readClipboardAutoBufferInventoryTransactionAsync,
  reapOwnedClipboardCallback,
  settleClipboardObservationAfterRetirement,
  TESTDRIVE_INPUT_OBSERVATION_PREFIX,
  watchClipboardCallbackAbort,
  waitForClipboardObservation,
} from "./lib/tui-testdrive-input.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hostSession = process.env.TMUX_IDE_TESTDRIVE_HOST_SESSION?.trim() || "_tmux-ide-testdrive";
const runtimeDir = resolve(
  process.env.TMUX_IDE_TESTDRIVE_RUNTIME_DIR?.trim() || join(repoRoot, ".tasks", "tui-testdrive"),
);
const stateHome = join(runtimeDir, "home");
const launcherPath = join(runtimeDir, "launch.sh");
const logPath = join(runtimeDir, "stderr.log");
const perfLogPath = join(runtimeDir, "performance.jsonl");
const metadataPath = join(runtimeDir, "state.json");
const clipboardObservationDir = join(runtimeDir, "clipboard-observations");
const testdriveDaemonInfoDir = resolve(
  process.env.TMUX_IDE_TESTDRIVE_DAEMON_INFO_DIR?.trim() || stateHome,
);
const namespaceSocketName = `tmux-ide-testdrive-${process.getuid?.() ?? process.pid}`;
const cleanupToken = `testdrive:cleanup:${process.getuid?.() ?? process.pid}`;
const targetSocketName = process.env.TMUX_IDE_TESTDRIVE_TARGET_SOCKET_NAME?.trim() || null;
const targetSocketPath = process.env.TMUX_IDE_TMUX_SOCKET_PATH?.trim() || null;
const hostSocketPath = process.env.TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH?.trim() || null;
const compiledTui = join(repoRoot, "packages", "daemon", "dist", "tui", "tmux-ide-tui");
const sourceTui = join(repoRoot, "packages", "daemon", "src", "tui", "mirror", "app.tsx");
const execFileAsync = promisify(execFile);

function canonicalDaemonHome() {
  return resolve(
    process.env.TMUX_IDE_TESTDRIVE_CANONICAL_HOME?.trim() ||
      join(process.env.HOME ?? "", ".tmux-ide"),
  );
}

function usage() {
  return `OpenTUI test-drive harness

Usage:
  pnpm tui:testdrive start [--target NAME] [--cols N] [--rows N] [--source] [--debug]
  pnpm tui:testdrive start --public-entry --cwd PATH [--cols N] [--rows N]
  pnpm tui:testdrive restart [start options]
  pnpm tui:testdrive capture [--ansi] [--history N]
  pnpm tui:testdrive publication <chrome|terminal> [--token TEXT] [--generation ID] [--json]
  pnpm tui:testdrive key <tmux-key> [...]
  pnpm tui:testdrive text <literal text>
  pnpm tui:testdrive input '<strict v1 JSON document>'
  pnpm tui:testdrive mouse drag <from-x> <from-y> <to-x> <to-y>
  pnpm tui:testdrive mouse click <x> <y>
  pnpm tui:testdrive mouse <move|down|hold|up> <x> <y>
  pnpm tui:testdrive resize <cols> <rows>
  pnpm tui:testdrive resize-sequence <cols> <rows> [...] [--json]
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
  pnpm tui:testdrive input '{"version":1,"kind":"paste","text":"echo hello"}'
  pnpm tui:testdrive input '{"version":1,"kind":"focus","state":"blur"}'
  pnpm tui:testdrive input '{"version":1,"kind":"application-mouse","action":"click","x":42,"y":8}'
  pnpm tui:testdrive input '{"version":1,"kind":"selection-drag","from":{"x":42,"y":8},"to":{"x":55,"y":8},"contentRect":{"x":40,"y":6,"width":80,"height":24}}'
  pnpm tui:testdrive input '{"version":1,"kind":"copy-capture"}'
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
  return execFileSync("tmux", [...(hostSocketPath ? ["-S", hostSocketPath] : []), ...args], {
    cwd: repoRoot,
    env: { ...process.env, TMUX: "", TMUX_TMPDIR: "" },
    encoding: options.encoding ?? "utf8",
    input: options.input,
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    stdio: options.inherit
      ? "inherit"
      : [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
}

async function tmuxAsync(args, options = {}) {
  const { stdout } = await runBoundedChildCommand({
    executable: "tmux",
    args: [...(hostSocketPath ? ["-S", hostSocketPath] : []), ...args],
    options: {
      cwd: repoRoot,
      env: { ...process.env, TMUX: "", TMUX_TMPDIR: "" },
      encoding: options.encoding ?? "utf8",
      input: options.input,
      maxBuffer: options.maxBuffer,
    },
    timeoutMs: options.timeout,
    signal: options.signal,
    onSpawn: options.onSpawn,
    onSettled: options.onSettled,
    terminationGraceMs: options.terminationGraceMs ?? 250,
  });
  return stdout;
}

function sessionExists(name, timeout) {
  try {
    tmux(["has-session", "-t", `=${name}`], { timeout });
    return true;
  } catch {
    return false;
  }
}

function liveSessions() {
  try {
    return execFileSync(
      "tmux",
      [
        ...(targetSocketPath
          ? ["-S", targetSocketPath]
          : targetSocketName
            ? ["-L", targetSocketName]
            : []),
        "list-sessions",
        "-F",
        "#{session_name}",
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, TMUX: "", TMUX_TMPDIR: "" },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
      .trim()
      .split("\n")
      .map((name) => name.trim())
      .filter((name) => name && !name.startsWith("_") && !name.startsWith("zz-"));
  } catch {
    return [];
  }
}

function parseOptions(args) {
  const options = {
    target: null,
    cols: 160,
    rows: 44,
    source: false,
    debug: false,
    publicEntry: false,
    cwd: null,
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--source") options.source = true;
    else if (arg === "--debug") options.debug = true;
    else if (arg === "--public-entry") options.publicEntry = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--cwd") options.cwd = args[++index] ?? fail("--cwd needs a value");
    else if (arg.startsWith("--cwd=")) options.cwd = arg.slice("--cwd=".length);
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

function injectHostBytes(identity, bytes, timeoutMs = 2_000) {
  const bufferName = `testdrive-input-${process.pid}-${randomUUID()}`;
  // load-buffer/paste-buffer writes the exact byte string to the hosted pane
  // PTY. Unlike send-keys it does not translate key names or reinterpret the
  // payload, so OpenTUI's own parser sees paste/focus/mouse protocols.
  return deliverExactHostBytes({
    identity,
    bytes,
    timeoutMs,
    bufferName,
    runTmux: tmux,
    clock: performance,
  });
}

function parseHostPaneIdentity(output) {
  const [paneId, sessionId, sessionName, rawProcessId, rawCols, rawRows] = output
    .trim()
    .split("\t");
  const processId = Number(rawProcessId);
  const cols = Number(rawCols);
  const rows = Number(rawRows);
  if (!/^%[0-9]+$/u.test(paneId ?? "") || !/^\$[0-9]+$/u.test(sessionId ?? "")) {
    fail("tmux did not resolve an immutable host pane/session identity");
  }
  if (!Number.isInteger(cols) || cols < 1 || !Number.isInteger(rows) || rows < 1) {
    fail("tmux did not resolve valid host pane geometry");
  }
  if (sessionName !== hostSession || !Number.isSafeInteger(processId) || processId < 1) {
    fail("tmux did not resolve the exact host session and process");
  }
  return { paneId, sessionId, sessionName, processId, cols, rows };
}

async function atomicHostPaneIdentity({ timeoutMs = 1_000, signal } = {}) {
  const args = [
    ...(hostSocketPath ? ["-S", hostSocketPath] : []),
    "display-message",
    "-p",
    "-t",
    `=${hostSession}:0.0`,
    "#{pane_id}\t#{session_id}\t#{session_name}\t#{pane_pid}\t#{pane_width}\t#{pane_height}",
  ];
  const { stdout } = await execFileAsync("tmux", args, {
    cwd: repoRoot,
    env: { ...process.env, TMUX: "", TMUX_TMPDIR: "" },
    encoding: "utf8",
    timeout: timeoutMs,
    signal,
    maxBuffer: 4_096,
  });
  return parseHostPaneIdentity(stdout);
}

function resolveHostPaneIdentity(timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  const remaining = () => {
    const value = Math.floor(deadline - performance.now());
    if (value < 1) fail("host pane identity resolution exceeded its absolute deadline");
    return value;
  };
  if (!sessionExists(hostSession, remaining())) fail("The test-drive TUI is not running");
  return parseHostPaneIdentity(
    tmux(
      [
        "display-message",
        "-p",
        "-t",
        `=${hostSession}:0.0`,
        "#{pane_id}\t#{session_id}\t#{session_name}\t#{pane_pid}\t#{pane_width}\t#{pane_height}",
      ],
      { timeout: remaining() },
    ),
  );
}

function verifyHostPaneIdentity(identity, timeoutMs) {
  const current = parseHostPaneIdentity(
    tmux(
      [
        "display-message",
        "-p",
        "-t",
        identity.paneId,
        "#{pane_id}\t#{session_id}\t#{session_name}\t#{pane_pid}\t#{pane_width}\t#{pane_height}",
      ],
      { timeout: timeoutMs },
    ),
  );
  if (
    current.paneId !== identity.paneId ||
    current.sessionId !== identity.sessionId ||
    current.processId !== identity.processId ||
    current.cols !== identity.cols ||
    current.rows !== identity.rows
  ) {
    fail("test-drive host pane identity or geometry changed during input delivery");
  }
}

function sendMouse(type, x, y) {
  const identity = resolveHostPaneIdentity(2_000);
  const geometry = { cols: identity.cols, rows: identity.rows };
  if (!geometry || x >= geometry.cols || y >= geometry.rows) {
    fail(
      `mouse coordinate ${x},${y} is outside host geometry ${geometry?.cols ?? "?"}x${geometry?.rows ?? "?"}`,
    );
  }
  // SGR mouse coordinates are one-based. OpenTUI receives these directly on
  // the hosted pane PTY, exactly as it would from a mouse-capable terminal.
  const suffix = type === "up" ? "m" : "M";
  const buttonCode = type === "drag" ? 32 : type === "move" ? 35 : 0;
  const sequence = `\u001b[<${buttonCode};${x + 1};${y + 1}${suffix}`;
  injectHostBytes(identity, sequence);
  verifyHostPaneIdentity(identity, 2_000);
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

function capture({ ansi = false, history = 0, preserveSpaces = false } = {}) {
  if (!sessionExists(hostSession)) fail("The test-drive TUI is not running");
  const args = ["capture-pane", "-p", "-t", `=${hostSession}:0.0`, "-S", String(-history)];
  if (ansi) args.splice(1, 0, "-e");
  if (preserveSpaces) args.splice(1, 0, "-N");
  return tmux(args).replace(/\n+$/u, "");
}

async function captureEnvelope() {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  const startedAt = performance.now();
  const deadlineMs = 1_500;
  const remaining = () => Math.max(1, Math.floor(deadlineMs - (performance.now() - startedAt)));
  const timer = setTimeout(abort, deadlineMs);
  try {
    const identity = await atomicHostPaneIdentity({
      timeoutMs: Math.min(500, remaining()),
      signal: controller.signal,
    });
    const { stdout } = await execFileAsync(
      "tmux",
      [
        ...(hostSocketPath ? ["-S", hostSocketPath] : []),
        "capture-pane",
        "-N",
        "-e",
        "-p",
        "-t",
        identity.paneId,
        "-S",
        "0",
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, TMUX: "", TMUX_TMPDIR: "" },
        encoding: "utf8",
        timeout: Math.min(750, remaining()),
        signal: controller.signal,
        maxBuffer: 4 * 1_024 * 1_024,
      },
    );
    const current = await atomicHostPaneIdentity({
      timeoutMs: Math.min(500, remaining()),
      signal: controller.signal,
    });
    if (
      current.paneId !== identity.paneId ||
      current.sessionId !== identity.sessionId ||
      current.processId !== identity.processId ||
      current.cols !== identity.cols ||
      current.rows !== identity.rows
    ) {
      fail("test-drive host pane identity changed during framebuffer capture");
    }
    const ansi = stdout.replace(/\n$/u, "");
    return Object.freeze({
      version: 1,
      cols: identity.cols,
      rows: identity.rows,
      hostIdentity: identity,
      ansi,
    });
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGTERM", abort);
    process.removeListener("SIGINT", abort);
  }
}

function readMetadata() {
  try {
    return JSON.parse(readFileSync(metadataPath, "utf8"));
  } catch {
    return null;
  }
}

function readLifecycleTimings(metadata = readMetadata()) {
  let marks = [];
  try {
    marks = readFileSync(perfLogPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    // A missing/partial performance log means the boundary is not observed.
  }
  const elapsed = (phase) => {
    const mark = marks.find((candidate) => candidate?.phase === phase);
    return Number.isFinite(mark?.elapsedMs) ? Math.round(mark.elapsedMs) : null;
  };
  const latestGeneration = marks
    .filter((candidate) => candidate?.phase === "generation-status")
    .at(-1);
  return {
    appChromeFrameMs: elapsed("first-frame") ?? metadata?.appChromeFrameMs ?? null,
    rendererTerminalFrameMs: elapsed("first-terminal-frame"),
    hostChromeFrameMs: elapsed("host-chrome-publication"),
    hostTerminalFrameMs: elapsed("host-terminal-publication"),
    // Compatibility field: once an external host proof exists it becomes the
    // authoritative readiness boundary. Before that, callers may still watch
    // internal progress and then request the host proof explicitly.
    coherentTerminalFrameMs:
      elapsed("host-terminal-publication") ?? elapsed("first-terminal-frame"),
    activeGeneration:
      latestGeneration?.status === "live" && typeof latestGeneration.daemonGeneration === "string"
        ? latestGeneration.daemonGeneration
        : null,
    generationStatus: typeof latestGeneration?.status === "string" ? latestGeneration.status : null,
  };
}

function recordHostPublication({
  kind,
  frame = capture(),
  token = null,
  generation = null,
  elapsedMs = null,
  processId = null,
} = {}) {
  if (kind !== "chrome" && kind !== "terminal") {
    fail("publication kind must be chrome or terminal");
  }
  const metadata = readMetadata();
  const startedAtMs = Date.parse(metadata?.startedAt ?? "");
  const evidence = buildTuiHostPublicationEvidence({
    frame,
    kind,
    token,
    generation,
    processId: processId ?? liveHostProcessPid(),
    elapsedMs:
      elapsedMs ?? (Number.isFinite(startedAtMs) ? Math.max(0, Date.now() - startedAtMs) : null),
  });
  if (!evidence.passed) {
    fail(
      `Host PTY did not publish ${kind} bytes` +
        `${token ? ` containing ${JSON.stringify(token)}` : ""}`,
    );
  }
  appendFileSync(
    perfLogPath,
    `${JSON.stringify({
      ...evidence,
      at: new Date().toISOString(),
      monotonicMicros: Math.floor(performance.now() * 1_000),
      processId: `host-pty:${evidence.processId ?? "unknown"}`,
      clockId: "testdrive-host-observer",
    })}\n`,
  );
  return evidence;
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

function rawClipboardArtifactIds(operationDir) {
  if (!existsSync(operationDir)) return [];
  return [
    ...new Set(
      readdirSync(operationDir)
        .filter((name) => /^(?:buffer[0-9]+|overflow)\.(?:bin|tmp|json)$/u.test(name))
        .map((name) => name.slice(0, name.lastIndexOf("."))),
    ),
  ].sort();
}

function clipboardEventArtifacts(nonce) {
  const operationDir = join(clipboardObservationDir, nonce);
  const artifacts = rawClipboardArtifactIds(operationDir);
  if (artifacts.length > MAX_CLIPBOARD_CALLBACK_ARTIFACTS + 1) {
    fail("clipboard callback artifacts exceeded their hard overflow bound");
  }
  return artifacts;
}

function clipboardAutoBufferInventory(timeoutMs) {
  const bufferLimit = Number(
    tmux(["show-options", "-gv", "buffer-limit"], { timeout: timeoutMs }).trim(),
  );
  let source;
  try {
    source = tmux(["list-buffers", "-F", "#{buffer_name}\t#{buffer_size}\t#{buffer_created}"], {
      timeout: timeoutMs,
    });
  } catch (error) {
    const stderr = String(error?.stderr ?? "");
    if (!/no buffers/iu.test(stderr)) throw error;
    source = "";
  }
  return { source, inventory: parseClipboardAutoBufferInventory(source, bufferLimit) };
}

async function armClipboardObservation(identity, nonce, timeoutMs, cleanupTimeoutMs) {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 5_000 ||
    !Number.isSafeInteger(cleanupTimeoutMs) ||
    cleanupTimeoutMs < 1 ||
    cleanupTimeoutMs > 5_000
  ) {
    fail("clipboard arm budgets are malformed");
  }
  const deadline = performance.now() + timeoutMs;
  const remaining = () => {
    const value = Math.floor(deadline - performance.now());
    if (value < 1) fail("clipboard preflight exceeded its absolute deadline");
    return value;
  };
  let rollbackDeadline = null;
  const rollbackRemaining = () => {
    if (rollbackDeadline === null) rollbackDeadline = performance.now() + cleanupTimeoutMs;
    const value = Math.floor(rollbackDeadline - performance.now());
    if (value < 1) fail("clipboard acquisition rollback exceeded its deadline");
    return value;
  };
  mkdirSync(clipboardObservationDir, { recursive: true, mode: 0o700 });
  chmodSync(clipboardObservationDir, 0o700);
  const operationDir = join(clipboardObservationDir, nonce);
  mkdirSync(operationDir, { recursive: false, mode: 0o700 });
  let callbackControlToken;
  let baseline;
  let hookCommand;
  let hookLease;
  try {
    callbackControlToken = randomUUID();
    baseline = clipboardAutoBufferInventory(remaining());
    hookCommand = buildClipboardPaneHookCommand({
      nodePath: process.execPath,
      scriptPath: fileURLToPath(import.meta.url),
      runtimeDir,
      socketPath: hostSocketPath,
      nonce,
      paneId: identity.paneId,
    });
    hookLease = acquireClipboardPaneHook({
      paneId: identity.paneId,
      ownerToken: nonce,
      command: hookCommand,
      runTmux: tmux,
      remaining,
      cleanupRemaining: rollbackRemaining,
    });
    const armedAtEpochMs = Date.now();
    writeFileSync(
      join(operationDir, "lease.json"),
      `${JSON.stringify({
        version: 1,
        nonce,
        paneId: identity.paneId,
        hookName: hookLease.hookName,
        controlToken: callbackControlToken,
        armedAtEpochMs,
        inventory: baseline.inventory,
        pollTimeoutMs: Math.min(1_000, remaining()),
      })}\n`,
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    let rollbackEvidence = Object.freeze({
      candidateAttempts: 0,
      occupiedCount: 0,
      retirementExact: true,
      retirementStage: "complete",
      retirementElapsedMs: 0,
      finalOwnerAbsent: true,
      finalHookAbsent: true,
    });
    if (hookCommand) {
      try {
        rollbackEvidence = ensureClipboardAcquisitionRollback({
          evidence: error?.clipboardLeaseEvidence,
          paneId: identity.paneId,
          ownerToken: nonce,
          command: hookCommand,
          runTmux: tmux,
          remaining: rollbackRemaining,
        });
      } catch (rollbackError) {
        if (rollbackError?.clipboardLeaseEvidence)
          rollbackEvidence = rollbackError.clipboardLeaseEvidence;
      }
    }
    rmSync(operationDir, { recursive: true, force: true });
    if (error && typeof error === "object") error.clipboardLeaseEvidence = rollbackEvidence;
    throw error;
  }
  let disposed = false;
  const observationStartedAt = performance.now();
  let retainedArtifact = null;
  let retainedClipboard = null;
  let artifactObservedElapsedMs = null;
  let duplicateSettleElapsedMs = null;
  let callbackLastScanElapsedMs = null;
  let callbackEvidence = Object.freeze({
    callbackInvocations: 0,
    callbackStage: "not-invoked",
    callbackOutcome: "pending",
    callbackInventoryPolls: 0,
    callbackHookElapsedMs: null,
    callbackHookEntryLagMs: null,
    callbackInventorySeenElapsedMs: null,
    callbackArtifactPublishedElapsedMs: null,
    callbackPreSaveElapsedMs: null,
    callbackSaveElapsedMs: null,
    callbackSaveOutcome: "not-started",
  });
  let callbackRetirementEvidence = Object.freeze({
    callbackRetirementStage: "not-started",
    callbackRetirementElapsedMs: 0,
    callbackWorkSettled: false,
    callbackLeaseInactive: false,
  });
  const readCallbackEvidence = () => {
    const statePath = join(operationDir, "callback-state.json");
    if (!existsSync(statePath)) return callbackEvidence;
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const parsed = parseClipboardCallbackState(state, { nonce, paneId: identity.paneId });
    callbackEvidence = Object.freeze({
      callbackInvocations: existsSync(join(operationDir, "overflow.json")) ? 2 : 1,
      ...parsed,
    });
    return callbackEvidence;
  };
  const listClipboardArtifacts = () => {
    callbackLastScanElapsedMs = Math.min(
      5_000,
      Math.max(0, Math.round(performance.now() - observationStartedAt)),
    );
    return clipboardEventArtifacts(nonce);
  };
  let retirementEvidence = Object.freeze({
    candidateAttempts: hookLease.candidateAttempts,
    occupiedCount: hookLease.occupiedCount,
    retirementExact: false,
    retirementStage: "not-started",
    retirementElapsedMs: 0,
    finalOwnerAbsent: false,
    finalHookAbsent: false,
  });
  return {
    async wait(waitTimeoutMs) {
      const observed = await waitForClipboardObservation({
        listArtifacts: listClipboardArtifacts,
        readEvent: (artifactId) => {
          const path = join(operationDir, `${artifactId}.json`);
          return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
        },
        expected: { nonce, paneId: identity.paneId },
        clock: performance,
        sleep: delay,
        timeoutMs: waitTimeoutMs,
        quietMs: 0,
      });
      retainedArtifact = observed.artifactId;
      artifactObservedElapsedMs = Math.min(
        5_000,
        Math.max(0, Math.round(performance.now() - observationStartedAt)),
      );
      retainedClipboard = Object.freeze({
        ...observed.clipboard,
        priorCopyCount: baseline.inventory.buffers.length,
        newCopyCount: Math.min(
          baseline.inventory.bufferLimit,
          baseline.inventory.buffers.length + 1,
        ),
        identityExact: true,
      });
      return retainedClipboard;
    },
    evidence() {
      try {
        readCallbackEvidence();
      } catch {
        callbackEvidence = Object.freeze({
          callbackInvocations: 0,
          callbackStage: "not-invoked",
          callbackOutcome: "error",
          callbackInventoryPolls: 0,
          callbackHookElapsedMs: null,
          callbackHookEntryLagMs: null,
          callbackInventorySeenElapsedMs: null,
          callbackArtifactPublishedElapsedMs: null,
          callbackPreSaveElapsedMs: null,
          callbackSaveElapsedMs: null,
          callbackSaveOutcome: "not-started",
        });
      }
      return Object.freeze({
        ...retirementEvidence,
        ...callbackRetirementEvidence,
        ...callbackEvidence,
        artifactObservedElapsedMs,
        duplicateSettleElapsedMs,
        callbackLastScanElapsedMs,
      });
    },
    async dispose(cleanupTimeoutMs) {
      if (disposed) return;
      disposed = true;
      const cleanupDeadline = performance.now() + cleanupTimeoutMs;
      try {
        retirementEvidence = retireClipboardPaneHook({
          paneId: identity.paneId,
          lease: hookLease,
          runTmux: tmux,
          remaining: () => {
            const value = Math.floor(cleanupDeadline - performance.now());
            if (value < 1) fail("clipboard hook retirement exceeded its deadline");
            return value;
          },
        });
      } catch (error) {
        if (error?.clipboardLeaseEvidence) {
          retirementEvidence = error.clipboardLeaseEvidence;
        }
        throw error;
      }
      const callbackLockPath = join(operationDir, "callback.lock");
      const abortPath = join(operationDir, "callback-abort.json");
      const abortTemporaryPath = join(operationDir, "callback-abort.tmp");
      const ackPath = join(operationDir, "callback-abort-ack.json");
      const completePath = join(operationDir, "callback-complete.json");
      const readControlRecord = (path, kind) => {
        if (!existsSync(path)) return null;
        const value = JSON.parse(readFileSync(path, "utf8"));
        if (
          value?.version !== 1 ||
          Object.keys(value).length !== 3 ||
          value.kind !== kind ||
          value.controlToken !== callbackControlToken
        ) {
          fail(`clipboard callback ${kind} identity is malformed`);
        }
        return value;
      };
      if (existsSync(callbackLockPath)) {
        callbackRetirementEvidence = Object.freeze({
          callbackRetirementStage: "not-started",
          callbackRetirementElapsedMs: 0,
          callbackWorkSettled: false,
          callbackLeaseInactive: false,
        });
        try {
          callbackRetirementEvidence = await reapOwnedClipboardCallback({
            isActive: () => readControlRecord(callbackLockPath, "active") !== null,
            requestAbort: async () => {
              writeFileSync(
                abortTemporaryPath,
                `${JSON.stringify({
                  version: 1,
                  kind: "abort",
                  controlToken: callbackControlToken,
                })}\n`,
                { flag: "wx", mode: 0o600 },
              );
              renameSync(abortTemporaryPath, abortPath);
            },
            isAcknowledged: () => readControlRecord(ackPath, "abort-ack") !== null,
            sleep: delay,
            clock: performance,
            timeoutMs: Math.max(1, Math.floor(cleanupDeadline - performance.now())),
          });
        } catch (error) {
          if (error?.clipboardCallbackRetirement) {
            callbackRetirementEvidence = error.clipboardCallbackRetirement;
          }
          try {
            readCallbackEvidence();
          } catch {
            // Preserve the exact cooperative-retirement failure.
          }
          throw error;
        }
        readCallbackEvidence();
      } else if (readControlRecord(completePath, "complete")) {
        callbackRetirementEvidence = Object.freeze({
          callbackRetirementStage: "already-exited",
          callbackRetirementElapsedMs: 0,
          callbackWorkSettled: true,
          callbackLeaseInactive: true,
        });
      }
      readCallbackEvidence();
      if (!retainedArtifact) {
        // A callback already owned by this operation may publish after the
        // work cutoff while the exact hook and cooperative callback are being
        // retired. Sample it once after that retirement, still inside the
        // original total deadline, before removing the private operation dir.
        if (performance.now() >= cleanupDeadline) {
          fail("clipboard final artifact scan exceeded its deadline");
        }
        try {
          const observed = await waitForClipboardObservation({
            listArtifacts: listClipboardArtifacts,
            readEvent: (artifactId) => {
              const path = join(operationDir, `${artifactId}.json`);
              return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
            },
            expected: { nonce, paneId: identity.paneId },
            clock: performance,
            sleep: delay,
            timeoutMs: 0,
            quietMs: 0,
          });
          retainedArtifact = observed.artifactId;
          artifactObservedElapsedMs = Math.min(
            5_000,
            Math.max(0, Math.round(performance.now() - observationStartedAt)),
          );
          retainedClipboard = Object.freeze({
            ...observed.clipboard,
            priorCopyCount: baseline.inventory.buffers.length,
            newCopyCount: Math.min(
              baseline.inventory.bufferLimit,
              baseline.inventory.buffers.length + 1,
            ),
            identityExact: true,
          });
        } catch (error) {
          // Preserve the provisional wait failure when no exact terminal-edge
          // artifact exists. Malformed/duplicate evidence still fails below.
          if (!isClipboardObservationTimeout(error)) throw error;
        }
      }
      if (retainedArtifact) {
        try {
          duplicateSettleElapsedMs = await settleClipboardObservationAfterRetirement({
            listArtifacts: listClipboardArtifacts,
            readCallbackEvidence,
            retainedBufferName: retainedArtifact,
            clock: performance,
            sleep: delay,
            timeoutMs: Math.max(1, Math.floor(cleanupDeadline - performance.now())),
          });
        } finally {
          rmSync(operationDir, { recursive: true, force: true });
        }
        return retainedClipboard;
      }
      // Removing the operation directory fences a queued helper that has not
      // atomically renamed its result yet; it cannot publish after disposal.
      rmSync(operationDir, { recursive: true, force: true });
      return null;
    },
  };
}

function captureHostPane(identity, ansi, timeoutMs) {
  return tmux(["capture-pane", "-p", ...(ansi ? ["-e"] : []), "-t", identity.paneId], {
    timeout: timeoutMs,
  }).replace(/\n+$/u, "");
}

async function executeInputDocument(source) {
  const command = parseTestdriveInputDocument(source);
  return executeTestdriveInputOperation(command, {
    clock: performance,
    sleep: delay,
    nonce: randomUUID,
    resolveIdentity: async (timeoutMs) => resolveHostPaneIdentity(timeoutMs),
    verifyIdentity: async (identity, timeoutMs) => verifyHostPaneIdentity(identity, timeoutMs),
    capabilities: async (_identity, timeoutMs) => ({
      ...fullTerminalCapabilities(),
      clipboardCapture:
        tmux(["show-options", "-gqv", "set-clipboard"], { timeout: timeoutMs }).trim() === "on",
    }),
    inject: async (identity, bytes, timeoutMs) => injectHostBytes(identity, bytes, timeoutMs),
    captureAnsi: async (identity, timeoutMs) => captureHostPane(identity, true, timeoutMs),
    waitForFrame: async (identity, predicate, timeoutMs) => {
      const deadline = performance.now() + timeoutMs;
      while (performance.now() < deadline) {
        const frame = captureHostPane(
          identity,
          false,
          Math.max(1, Math.floor(deadline - performance.now())),
        );
        if (predicate(frame)) return frame;
        await delay(Math.min(10, Math.max(1, deadline - performance.now())));
      }
      fail("Timed out waiting for OpenTUI local select mode evidence");
    },
    armClipboard: armClipboardObservation,
  });
}

async function captureClipboardObservation(args) {
  const [nonce, expectedPaneId, observedPaneId] = args;
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(nonce ?? "")) {
    fail("invalid clipboard operation nonce");
  }
  if (!/^%[0-9]+$/u.test(expectedPaneId ?? "") || observedPaneId !== expectedPaneId) {
    fail("clipboard hook pane identity mismatch");
  }
  mkdirSync(clipboardObservationDir, { recursive: true, mode: 0o700 });
  chmodSync(clipboardObservationDir, 0o700);
  const operationDir = join(clipboardObservationDir, nonce);
  if (!existsSync(operationDir)) fail("clipboard observation lease is no longer active");
  const callbackLock = join(operationDir, "callback.lock");
  const callbackAbort = join(operationDir, "callback-abort.json");
  const callbackAbortAck = join(operationDir, "callback-abort-ack.json");
  const callbackComplete = join(operationDir, "callback-complete.json");
  let lease;
  try {
    lease = JSON.parse(readFileSync(join(operationDir, "lease.json"), "utf8"));
  } catch {
    fail("clipboard observation lease is malformed");
  }
  if (
    lease?.version !== 1 ||
    Object.keys(lease).length !== 8 ||
    ![
      "version",
      "nonce",
      "paneId",
      "hookName",
      "controlToken",
      "armedAtEpochMs",
      "inventory",
      "pollTimeoutMs",
    ].every((key) => key in lease) ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(lease.controlToken ?? "") ||
    !Number.isSafeInteger(lease.armedAtEpochMs) ||
    lease.armedAtEpochMs < 0 ||
    lease.armedAtEpochMs > Date.now()
  ) {
    fail("clipboard observation lease identity is malformed");
  }
  try {
    if (existsSync(callbackComplete)) throw new Error("clipboard callback already completed");
    writeFileSync(
      callbackLock,
      `${JSON.stringify({ version: 1, kind: "active", controlToken: lease.controlToken })}\n`,
      { flag: "wx", mode: 0o600 },
    );
  } catch {
    const overflow = join(operationDir, "overflow.json");
    if (!existsSync(overflow)) {
      writeFileSync(
        overflow,
        `${JSON.stringify({ version: 1, nonce, paneId: observedPaneId, overflow: 2 })}\n`,
        { flag: "wx", mode: 0o600 },
      );
    }
    return;
  }
  const callbackStatePath = join(operationDir, "callback-state.json");
  const callbackStartedAt = performance.now();
  const hookEntryLagMs = Math.min(5_000, Math.max(0, Date.now() - lease.armedAtEpochMs));
  const callbackElapsed = () =>
    Math.min(5_000, Math.max(0, Math.round(performance.now() - callbackStartedAt)));
  let callbackStage = "hook-invoked";
  let inventoryPolls = 0;
  const hookElapsedMs = callbackElapsed();
  let inventorySeenElapsedMs = null;
  let artifactPublishedElapsedMs = null;
  let preSaveElapsedMs = null;
  let saveElapsedMs = null;
  let saveOutcome = "not-started";
  const callbackController = new AbortController();
  const callbackTmuxChildren = new Set();
  const callbackTmux = (args, options) =>
    tmuxAsync(args, {
      ...options,
      onSpawn: (pid) => callbackTmuxChildren.add(pid),
      onSettled: (pid) => callbackTmuxChildren.delete(pid),
      terminationGraceMs: 50,
    });
  let callbackSettled = false;
  let abortAcknowledged = false;
  const controlWatch = watchClipboardCallbackAbort({
    controlToken: lease.controlToken,
    readRequest: () => {
      if (!existsSync(callbackAbort)) return null;
      try {
        return JSON.parse(readFileSync(callbackAbort, "utf8"));
      } catch {
        fail("clipboard callback abort request is malformed");
      }
    },
    abort: () => {
      abortAcknowledged = true;
      callbackController.abort();
    },
    isSettled: () => callbackSettled,
    sleep: delay,
  });
  const publishCallbackState = (outcome = "pending") => {
    const temporary = join(operationDir, "callback-state.tmp");
    writeFileSync(
      temporary,
      `${JSON.stringify({
        version: 1,
        nonce,
        paneId: observedPaneId,
        stage: callbackStage,
        outcome,
        inventoryPolls: Math.min(inventoryPolls, 2_048),
        hookElapsedMs,
        hookEntryLagMs,
        inventorySeenElapsedMs,
        artifactPublishedElapsedMs,
        preSaveElapsedMs,
        saveElapsedMs,
        saveOutcome,
      })}\n`,
      { mode: 0o600 },
    );
    renameSync(temporary, callbackStatePath);
  };
  publishCallbackState();
  try {
    if (
      lease?.version !== 1 ||
      Object.keys(lease).length !== 8 ||
      ![
        "version",
        "nonce",
        "paneId",
        "hookName",
        "controlToken",
        "armedAtEpochMs",
        "inventory",
        "pollTimeoutMs",
      ].every((key) => key in lease) ||
      lease.nonce !== nonce ||
      lease.paneId !== expectedPaneId ||
      !/^pane-set-clipboard\[[0-9]+\]$/u.test(lease.hookName ?? "") ||
      lease.inventory === null ||
      typeof lease.inventory !== "object" ||
      Array.isArray(lease.inventory) ||
      Object.keys(lease.inventory).length !== 3 ||
      !["bufferLimit", "oldestAutoName", "buffers"].every((key) => key in lease.inventory) ||
      !Array.isArray(lease.inventory.buffers) ||
      !Number.isSafeInteger(lease.pollTimeoutMs) ||
      lease.pollTimeoutMs < 1 ||
      lease.pollTimeoutMs > 1_000 ||
      !Number.isSafeInteger(lease.armedAtEpochMs) ||
      lease.armedAtEpochMs < 0 ||
      lease.armedAtEpochMs > Date.now()
    ) {
      fail("clipboard observation lease identity is malformed");
    }
    const baselineParsed = parseClipboardAutoBufferInventory(
      lease.inventory.buffers
        .map((entry) => `${entry?.name}\t${entry?.size}\t${entry?.created}`)
        .join("\n"),
      lease.inventory.bufferLimit,
    );
    if (
      JSON.stringify(baselineParsed.buffers) !== JSON.stringify(lease.inventory.buffers) ||
      (lease.inventory.oldestAutoName === null) !== (baselineParsed.buffers.length === 0) ||
      (lease.inventory.oldestAutoName !== null &&
        !baselineParsed.buffers.some((entry) => entry.name === lease.inventory.oldestAutoName))
    ) {
      fail("clipboard observation lease oldest buffer is malformed");
    }
    const baseline = Object.freeze({
      ...baselineParsed,
      oldestAutoName: lease.inventory.oldestAutoName,
    });
    const deadline = performance.now() + lease.pollTimeoutMs;
    let captured = null;
    callbackStage = "inventory-pending";
    publishCallbackState();
    while (performance.now() + 100 < deadline) {
      inventoryPolls += 1;
      const current = await readClipboardAutoBufferInventoryTransactionAsync({
        runTmux: callbackTmux,
        timeoutMs: Math.max(100, Math.floor(deadline - performance.now())),
        signal: callbackController.signal,
      });
      if (current.inventory.bufferLimit !== baseline.bufferLimit) {
        fail("clipboard buffer-limit changed during observation");
      }
      const assessment = assessClipboardAutoBufferDelta(baseline, current.inventory);
      if (assessment.status === "captured") {
        captured = assessment.buffer;
        callbackStage = "inventory-seen";
        inventorySeenElapsedMs = callbackElapsed();
        publishCallbackState("seen");
        break;
      }
      await delay(Math.min(5, Math.max(1, deadline - performance.now())));
    }
    if (!captured) fail("clipboard automatic buffer did not appear before deadline");
    if (!existsSync(operationDir)) fail("clipboard observation lease retired before capture");
    const capturedPayload = join(operationDir, `${captured.name}.bin`);
    callbackStage = "save-pending";
    preSaveElapsedMs = callbackElapsed();
    saveOutcome = "pending";
    publishCallbackState();
    const afterSave = await readClipboardAutoBufferInventoryTransactionAsync({
      runTmux: callbackTmux,
      timeoutMs: Math.max(1, Math.floor(deadline - performance.now())),
      save: { bufferName: captured.name, path: capturedPayload },
      signal: callbackController.signal,
    });
    saveElapsedMs = Math.max(0, callbackElapsed() - preSaveElapsedMs);
    saveOutcome = "complete";
    const afterSaveAssessment = assessClipboardAutoBufferDelta(baseline, afterSave.inventory);
    if (
      afterSaveAssessment.status !== "captured" ||
      afterSaveAssessment.buffer.name !== captured.name ||
      afterSaveAssessment.buffer.size !== captured.size ||
      afterSaveAssessment.buffer.created !== captured.created
    ) {
      rmSync(capturedPayload, { force: true });
      fail("clipboard automatic buffer changed during capture");
    }
    enforceClipboardCallbackCap(rawClipboardArtifactIds(operationDir));
    const declaredBytes = statSync(capturedPayload).size;
    if (declaredBytes < 1 || declaredBytes > MAX_CLIPBOARD_BYTES)
      fail("clipboard hook payload is empty or over cap");
    const content = readFileSync(capturedPayload);
    rmSync(capturedPayload, { force: true });
    if (content.byteLength !== declaredBytes) fail("clipboard payload changed during hashing");
    const event = {
      version: 1,
      nonce,
      paneId: observedPaneId,
      bufferName: captured.name,
      bytes: declaredBytes,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
    const temporary = join(operationDir, `${captured.name}.tmp`);
    const complete = join(operationDir, `${captured.name}.json`);
    writeFileSync(temporary, `${JSON.stringify(event)}\n`, { flag: "wx", mode: 0o600 });
    if (!existsSync(operationDir)) fail("clipboard observation lease retired before publication");
    renameSync(temporary, complete);
    callbackStage = "artifact-published";
    artifactPublishedElapsedMs = callbackElapsed();
    publishCallbackState("published");
  } catch (error) {
    if (preSaveElapsedMs !== null) {
      saveElapsedMs ??= Math.max(0, callbackElapsed() - preSaveElapsedMs);
      saveOutcome = "error";
    }
    try {
      publishCallbackState("error");
    } catch {
      // The operation may already be retired. The owning input operation still
      // fails closed from the missing artifact and exact retirement evidence.
    }
    throw error;
  } finally {
    callbackSettled = true;
    await controlWatch;
    if (callbackTmuxChildren.size !== 0) {
      fail("clipboard callback child did not settle before callback retirement");
    }
    if (abortAcknowledged) {
      writeFileSync(
        callbackAbortAck,
        `${JSON.stringify({
          version: 1,
          kind: "abort-ack",
          controlToken: lease.controlToken,
        })}\n`,
        { flag: "wx", mode: 0o600 },
      );
    }
    writeFileSync(
      callbackComplete,
      `${JSON.stringify({
        version: 1,
        kind: "complete",
        controlToken: lease.controlToken,
      })}\n`,
      { flag: "wx", mode: 0o600 },
    );
    // This marker transition proves only that callback-owned work and tmux
    // children settled and that the private callback lease is inactive. The
    // outer test-drive process owner proves OS-process absence during global
    // cleanup; this operation never infers it from a file disappearing.
    rmSync(callbackLock, { force: true });
  }
}

function liveHostProcessPid() {
  if (!sessionExists(hostSession)) return null;
  try {
    const value = Number(
      tmux(["display-message", "-p", "-t", `=${hostSession}:0.0`, "#{pane_pid}"]).trim(),
    );
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resizeSequence(args) {
  const json = args.at(-1) === "--json";
  const values = json ? args.slice(0, -1) : args;
  if (values.length < 2 || values.length % 2 !== 0) {
    fail("resize-sequence needs one or more <cols> <rows> pairs");
  }
  if (!sessionExists(hostSession)) fail("The test-drive TUI is not running");
  const samples = [];
  for (let index = 0; index < values.length; index += 2) {
    const cols = numberOption("cols", values[index]);
    const rows = numberOption("rows", values[index + 1]);
    const startedAt = performance.now();
    tmux(["resize-window", "-t", `=${hostSession}`, "-x", String(cols), "-y", String(rows)]);
    const settled = liveHostSize();
    const elapsedMs = Number((performance.now() - startedAt).toFixed(2));
    if (settled?.cols !== cols || settled.rows !== rows) {
      fail(`test-drive resize did not settle at ${cols}x${rows}`);
    }
    samples.push({
      ordinal: index / 2,
      cols,
      rows,
      elapsedMs,
      measurementBoundary: "tmux resize-window through synchronous host-size acknowledgement",
    });
  }
  if (json) process.stdout.write(`${JSON.stringify({ samples }, null, 2)}\n`);
  else {
    process.stdout.write(
      `${samples.map(({ cols, rows, elapsedMs }) => `${cols}x${rows} ${elapsedMs.toFixed(2)}ms`).join("\n")}\n`,
    );
  }
}

function daemonStatus() {
  try {
    const path = join(
      process.env.TMUX_IDE_TESTDRIVE_USE_CANONICAL_DAEMON === "1"
        ? canonicalDaemonHome()
        : stateHome,
      "daemon.json",
    );
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
    return null;
  }
  const ownedProcessPid = liveHostProcessPid();
  try {
    tmux(["send-keys", "-t", `=${hostSession}:0.0`, "C-q"]);
  } catch {
    // The renderer may already be exiting.
  }
  return ownedProcessPid;
}

async function ensureStopped() {
  const ownedProcessPid = stop({ quiet: true });
  for (let attempt = 0; attempt < 20 && sessionExists(hostSession); attempt += 1) {
    await delay(50);
  }
  if (sessionExists(hostSession)) tmux(["kill-session", "-t", `=${hostSession}`]);
  // Ctrl-Q is also the product's deliberate "put away" gesture. The
  // test-drive, however, owns this exact pane process and repeated warm-host
  // samples must not accumulate detached TUI clients. Retire only the PID
  // captured from this owned host pane; never scan or broadly kill TUIs.
  if (ownedProcessPid && processIsAlive(ownedProcessPid)) {
    try {
      process.kill(ownedProcessPid, "SIGTERM");
    } catch {
      // It may exit between the liveness check and signal.
    }
    for (let attempt = 0; attempt < 20 && processIsAlive(ownedProcessPid); attempt += 1) {
      await delay(25);
    }
    if (processIsAlive(ownedProcessPid)) {
      try {
        process.kill(ownedProcessPid, "SIGKILL");
      } catch {
        // It may exit between the liveness check and signal.
      }
    }
  }
}

async function start(args) {
  const options = parseOptions(args);
  if (options.publicEntry && options.target)
    fail("--public-entry cannot be combined with --target");
  const target = options.publicEntry ? null : resolveTarget(options.target);
  const runtime = options.publicEntry ? "public-cli" : options.source ? "source" : "compiled";
  if (!options.publicEntry && !options.source && !existsSync(compiledTui)) {
    fail(`Compiled TUI missing at ${compiledTui}; run pnpm build:tui or pass --source`);
  }
  if (options.source && !existsSync(sourceTui)) fail(`OpenTUI source missing at ${sourceTui}`);
  const launch = resolveTestdriveLaunch({
    publicEntry: options.publicEntry,
    source: options.source,
    target,
    cwd: options.publicEntry ? options.cwd : options.source ? repoRoot : stateHome,
    repoRoot,
    nodeBinary: process.execPath,
    compiledTui,
    sourceTui,
    publicCli: join(repoRoot, "bin", "cli.js"),
  });
  const publicEnvironment = options.publicEntry
    ? resolvePublicTestdriveEnvironment(process.env)
    : null;
  const controlPrivateRoot = targetSocketPath ? dirname(resolve(targetSocketPath)) : null;
  const canonicalDaemon = process.env.TMUX_IDE_TESTDRIVE_USE_CANONICAL_DAEMON === "1";
  const testdriveCapabilityEnvironment = resolveTestdriveCapabilityEnvironment({
    publicEntry: options.publicEntry,
    canonicalDaemon,
    environment: process.env,
    privateRoot: controlPrivateRoot,
    stateHome,
    canonicalHome: canonicalDaemonHome(),
    standaloneRegistryDir: join(runtimeDir, "registry"),
    standaloneDaemonInfoDir: testdriveDaemonInfoDir,
    cleanupToken,
    tmuxSocketName: targetSocketName ?? (targetSocketPath ? null : namespaceSocketName),
    tmuxSocketPath: targetSocketPath,
  });
  const card5ControlRoot = testdriveCapabilityEnvironment.TMUX_IDE_CARD5_HOST_FOCUS_CONTROL_ROOT;
  if (card5ControlRoot) {
    const root = lstatSync(card5ControlRoot);
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      (root.mode & 0o777) !== 0o700 ||
      (typeof process.getuid === "function" && root.uid !== process.getuid())
    )
      fail("Card5 host-focus control root was not private and owned");
  }
  if (!existsSync(launch.cwd)) fail(`test-drive cwd does not exist: ${launch.cwd}`);
  if (
    options.publicEntry &&
    [join(launch.cwd, ".tmux-ide", "workspace.yml"), join(launch.cwd, "ide.yml")].some(existsSync)
  )
    fail("--public-entry cwd must not contain workspace.yml or legacy ide.yml");

  await ensureStopped();
  mkdirSync(stateHome, { recursive: true });
  // canonical-daemon.ts deliberately rejects a daemon record whose parent is
  // accessible by group/others. The test-drive home is normally disposable,
  // so mkdir's umask-derived mode can otherwise make a correctly copied record
  // look absent and leave the TUI in its reconnecting state forever.
  chmodSync(stateHome, 0o700);
  if (process.env.TMUX_IDE_TESTDRIVE_USE_CANONICAL_DAEMON === "1") {
    const canonicalHome = canonicalDaemonHome();
    const daemonInfoPath = join(canonicalHome, "daemon.json");
    if (!options.publicEntry && !existsSync(daemonInfoPath))
      fail(`Canonical daemon info missing at ${daemonInfoPath}`);
  }
  rmSync(logPath, { force: true });
  rmSync(perfLogPath, { force: true });

  const launchEpochMs = Date.now();
  const launchId = randomUUID();
  const environment = [
    `TMUX_IDE_CWD=${shQuote(launch.cwd)}`,
    ...(publicEnvironment
      ? Object.entries(publicEnvironment).map(([key, value]) => `${key}=${shQuote(value)}`)
      : []),
    `TMUX_IDE_CLI=${shQuote(join(repoRoot, "bin", "cli.js"))}`,
    // The targeted TUI is launched inside the private host tmux. Preserve the
    // exact TMUX value injected by that server so host-local clipboard policy
    // configures the host, while semantic target access remains pinned by
    // TMUX_IDE_TMUX_SOCKET_PATH. Public clean-env launches still carry TMUX="".
    `TMUX_IDE_TUI_PERF_LOG=${shQuote(perfLogPath)}`,
    `TMUX_IDE_TUI_LAUNCH_EPOCH_MS=${launchEpochMs}`,
    ...(process.env.TMUX_IDE_PERFORMANCE_TRACE_LOG
      ? [
          `TMUX_IDE_PERFORMANCE_TRACE_LOG=${shQuote(process.env.TMUX_IDE_PERFORMANCE_TRACE_LOG)}`,
          `TMUX_IDE_PERFORMANCE_TRACE_COMMIT=${shQuote(process.env.TMUX_IDE_PERFORMANCE_TRACE_COMMIT ?? "")}`,
          `TMUX_IDE_PERFORMANCE_TRACE_TREE=${shQuote(process.env.TMUX_IDE_PERFORMANCE_TRACE_TREE ?? "")}`,
          `TMUX_IDE_PERFORMANCE_TRACE_DETAIL=${shQuote(process.env.TMUX_IDE_PERFORMANCE_TRACE_DETAIL ?? "1")}`,
          `TMUX_IDE_PERFORMANCE_TRACE_INPUT_ORIGIN=${shQuote(process.env.TMUX_IDE_PERFORMANCE_TRACE_INPUT_ORIGIN ?? "0")}`,
          `TMUX_IDE_PERFORMANCE_TRACE_INPUT_DETAIL=${shQuote(process.env.TMUX_IDE_PERFORMANCE_TRACE_INPUT_DETAIL ?? "0")}`,
        ]
      : []),
    ...Object.entries(testdriveCapabilityEnvironment).map(
      ([key, value]) => `${key}=${shQuote(value)}`,
    ),
    ...(process.env.TMUX_IDE_TESTDRIVE_USE_CANONICAL_DAEMON === "1"
      ? ["TMUX_IDE_TESTDRIVE_USE_CANONICAL_DAEMON=1"]
      : []),
    ...(process.env.TMUX_IDE_ZZ_LOG
      ? [`TMUX_IDE_ZZ_LOG=${shQuote(process.env.TMUX_IDE_ZZ_LOG)}`]
      : []),
    ...(options.debug ? ["TMUX_IDE_MIRROR_DEBUG=1"] : []),
  ];
  const publicExecEnvironment = publicEnvironment
    ? {
        ...publicEnvironment,
        TMUX_IDE_CWD: launch.cwd,
        TMUX_IDE_CLI: join(repoRoot, "bin", "cli.js"),
        TMUX_IDE_TUI_PERF_LOG: perfLogPath,
        TMUX_IDE_TUI_LAUNCH_EPOCH_MS: String(launchEpochMs),
        ...testdriveCapabilityEnvironment,
        ...(process.env.TMUX_IDE_PERFORMANCE_TRACE_LOG
          ? {
              TMUX_IDE_PERFORMANCE_TRACE_LOG: process.env.TMUX_IDE_PERFORMANCE_TRACE_LOG,
              TMUX_IDE_PERFORMANCE_TRACE_COMMIT:
                process.env.TMUX_IDE_PERFORMANCE_TRACE_COMMIT ?? "",
              TMUX_IDE_PERFORMANCE_TRACE_TREE: process.env.TMUX_IDE_PERFORMANCE_TRACE_TREE ?? "",
              TMUX_IDE_PERFORMANCE_TRACE_DETAIL:
                process.env.TMUX_IDE_PERFORMANCE_TRACE_DETAIL ?? "1",
              TMUX_IDE_PERFORMANCE_TRACE_INPUT_ORIGIN:
                process.env.TMUX_IDE_PERFORMANCE_TRACE_INPUT_ORIGIN ?? "0",
              TMUX_IDE_PERFORMANCE_TRACE_INPUT_DETAIL:
                process.env.TMUX_IDE_PERFORMANCE_TRACE_INPUT_DETAIL ?? "0",
            }
          : {}),
        ...(options.debug ? { TMUX_IDE_MIRROR_DEBUG: "1" } : {}),
      }
    : null;
  writeFileSync(
    launcherPath,
    [
      "#!/bin/sh",
      // Bun source mode needs the checkout bunfig preload. The standalone
      // binary must run outside that tree or Bun tries to preload Solid again.
      `cd ${shQuote(launch.cwd)}`,
      ...(publicEnvironment
        ? []
        : [
            "unset TMUX_IDE_RUNTIME_MODE TMUX_IDE_HOME TMUX_IDE_REGISTRY_DIR TMUX_IDE_DAEMON_INFO_DIR TMUX_IDE_CLEANUP_TOKEN TMUX_IDE_TMUX_SOCKET_NAME TMUX_IDE_TMUX_SOCKET_PATH",
          ]),
      ...(publicEnvironment ? [] : [`export ${environment.join(" ")}`]),
      buildTestdriveExecCommand({
        clean: Boolean(publicEnvironment),
        environment: publicExecEnvironment ?? {},
        binary: launch.binary,
        binaryArgs: launch.binaryArgs,
        stderrPath: logPath,
      }),
      "",
    ].join("\n"),
  );
  chmodSync(launcherPath, 0o700);

  const launchStartedAt = performance.now();
  const hostIdentity = parseHostPaneIdentity(
    tmux([
      "new-session",
      "-d",
      "-P",
      "-F",
      "#{pane_id}\t#{session_id}\t#{session_name}\t#{pane_pid}\t#{pane_width}\t#{pane_height}",
      "-s",
      hostSession,
      "-x",
      String(options.cols),
      "-y",
      String(options.rows),
      "-c",
      launch.cwd,
      ...(process.env.TMUX_IDE_PERFORMANCE_TRACE_INPUT_FINGERPRINT_KEY
        ? [
            "-e",
            `TMUX_IDE_PERFORMANCE_TRACE_INPUT_FINGERPRINT_KEY=${process.env.TMUX_IDE_PERFORMANCE_TRACE_INPUT_FINGERPRINT_KEY}`,
          ]
        : []),
      launcherPath,
    ]),
  );
  const processId = hostIdentity.processId;
  const launchReceipt = Object.freeze({
    launchId,
    processId,
    target,
    hostIdentity,
  });
  const metadataBase = {
    hostSession,
    target,
    entry: launch.entry,
    cols: options.cols,
    rows: options.rows,
    runtime,
    debug: options.debug,
    startedAt: new Date().toISOString(),
    launchId,
    processId,
    hostIdentity,
  };
  writeFileSync(
    metadataPath,
    `${JSON.stringify(
      {
        ...metadataBase,
        appChromeFrameMs: null,
        coherentTerminalFrameMs: null,
        firstFrameMs: null,
      },
      null,
      2,
    )}\n`,
  );
  if (options.json) {
    process.stdout.write(`${JSON.stringify(launchReceipt)}\n`);
    return;
  }
  const frame = await waitForFrame((value) => value.includes("tmux-ide"));
  const appChromeFrameMs = performance.now() - launchStartedAt;
  const metadata = {
    ...metadataBase,
    // Keep the two readiness boundaries honest. App chrome is useful but is
    // not evidence that a semantic terminal seed has reached the renderer.
    appChromeFrameMs: Math.round(appChromeFrameMs),
    coherentTerminalFrameMs: null,
    firstFrameMs: Math.round(appChromeFrameMs),
  };
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  const hostPublication = recordHostPublication({
    kind: "chrome",
    frame,
    elapsedMs: appChromeFrameMs,
    processId,
  });

  process.stdout.write(
    `OpenTUI test-drive chrome ready in ${hostPublication.elapsedMs}ms (${runtime}, ${options.cols}x${options.rows}${target ? `, target ${target}` : ""})\n` +
      `Attach: tmux attach -t ${hostSession}\n` +
      `Logs:   ${logPath}\n\n${frame}\n`,
  );
}

async function status(json = false) {
  const metadata = readMetadata();
  let hostIdentity = null;
  let statusObservation = null;
  try {
    hostIdentity = await atomicHostPaneIdentity({ timeoutMs: 1_000 });
  } catch (error) {
    const reason = classifyProductTuiCommandFailure(error);
    const metadataProcessAlive = processIsAlive(metadata?.processId);
    statusObservation = Object.freeze({
      reason:
        !metadataProcessAlive && Number.isSafeInteger(metadata?.processId)
          ? "process-dead"
          : reason === "host-status-timeout" || reason === "aborted"
            ? reason
            : error?.code
              ? "server-gone"
              : "identity-invalid",
      stage: "atomic-host-display",
      metadataPresent: metadata !== null,
      processAlive: metadataProcessAlive,
    });
  }
  const running = hostIdentity !== null;
  const result = hostIdentity
    ? {
        running,
        ...metadata,
        readiness: readLifecycleTimings(metadata),
        cols: hostIdentity.cols,
        rows: hostIdentity.rows,
        hostIdentity,
        daemon: daemonStatus(),
        logPath,
        perfLogPath,
      }
    : {
        running,
        readiness: readLifecycleTimings(metadata),
        statusObservation,
        metadata: {
          present: metadata !== null,
          launchId: metadata?.launchId ?? null,
          processId: metadata?.processId ?? null,
          target: metadata?.target ?? null,
          processAlive: processIsAlive(metadata?.processId),
        },
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
      let json = false;
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] === "--ansi") ansi = true;
        else if (args[index] === "--json") json = true;
        else if (args[index] === "--history") history = numberOption("--history", args[++index]);
        else fail(`Unknown capture option: ${args[index]}`);
      }
      if (json) {
        if (!ansi || history !== 0) fail("capture --json requires --ansi and no history");
        process.stdout.write(`${JSON.stringify(await captureEnvelope())}\n`);
      } else process.stdout.write(`${capture({ ansi, history })}\n`);
      break;
    }
    case "publication": {
      const kind = args[0];
      let token = null;
      let generation = null;
      let json = false;
      let elapsedMs = null;
      for (let index = 1; index < args.length; index += 1) {
        if (args[index] === "--token") token = args[++index] ?? fail("--token needs a value");
        else if (args[index] === "--generation") {
          generation = args[++index] ?? fail("--generation needs a value");
        } else if (args[index] === "--json") json = true;
        else if (args[index] === "--elapsed-ms") {
          const value = Number(args[++index]);
          if (!Number.isFinite(value) || value < 0)
            fail("--elapsed-ms needs a non-negative number");
          elapsedMs = value;
        } else fail(`Unknown publication option: ${args[index]}`);
      }
      const evidence = recordHostPublication({ kind, token, generation, elapsedMs });
      process.stdout.write(json ? `${JSON.stringify(evidence)}\n` : `${evidence.phase}\n`);
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
    case "input": {
      if (args.length !== 1) fail("input needs exactly one strict v1 JSON document");
      const evidence = await executeInputDocument(args[0]);
      process.stdout.write(`${JSON.stringify(evidence)}\n`);
      break;
    }
    case "clipboard-observe":
      if (args.length !== 3) fail("clipboard-observe received malformed hook arguments");
      await captureClipboardObservation(args);
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
    case "resize-sequence":
      resizeSequence(args);
      break;
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
  if (error?.observation) {
    process.stderr.write(
      `${TESTDRIVE_INPUT_OBSERVATION_PREFIX}${JSON.stringify(error.observation)}\n`,
    );
  }
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
