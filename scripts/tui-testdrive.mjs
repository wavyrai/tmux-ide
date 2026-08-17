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
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
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
import { buildTuiHostPublicationEvidence } from "./lib/tui-host-publication.mjs";
import {
  MAX_CLIPBOARD_BYTES,
  MAX_CLIPBOARD_CALLBACK_ARTIFACTS,
  deliverExactHostBytes,
  enforceClipboardCallbackCap,
  executeTestdriveInputOperation,
  fullTerminalCapabilities,
  parseTestdriveInputDocument,
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
const namespaceSocketName = `tmux-ide-testdrive-${process.getuid?.() ?? process.pid}`;
const cleanupToken = `testdrive:cleanup:${process.getuid?.() ?? process.pid}`;
const targetSocketName = process.env.TMUX_IDE_TESTDRIVE_TARGET_SOCKET_NAME?.trim() || null;
const targetSocketPath = process.env.TMUX_IDE_TMUX_SOCKET_PATH?.trim() || null;
const hostSocketPath = process.env.TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH?.trim() || null;
const compiledTui = join(repoRoot, "packages", "daemon", "dist", "tui", "tmux-ide-tui");
const sourceTui = join(repoRoot, "packages", "daemon", "src", "tui", "mirror", "app.tsx");

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

function injectHostBytes(identity, bytes, timeoutMs = 2_000) {
  const bufferName = `testdrive-input-${process.pid}-${randomUUID()}`;
  // load-buffer/paste-buffer writes the exact byte string to the hosted pane
  // PTY. Unlike send-keys it does not translate key names or reinterpret the
  // payload, so OpenTUI's own parser sees paste/focus/mouse protocols.
  deliverExactHostBytes({
    identity,
    bytes,
    timeoutMs,
    bufferName,
    runTmux: tmux,
    clock: performance,
  });
}

function parseHostPaneIdentity(output) {
  const [paneId, sessionId, rawCols, rawRows] = output.trim().split("\t");
  const cols = Number(rawCols);
  const rows = Number(rawRows);
  if (!/^%[0-9]+$/u.test(paneId ?? "") || !/^\$[0-9]+$/u.test(sessionId ?? "")) {
    fail("tmux did not resolve an immutable host pane/session identity");
  }
  if (!Number.isInteger(cols) || cols < 1 || !Number.isInteger(rows) || rows < 1) {
    fail("tmux did not resolve valid host pane geometry");
  }
  return { paneId, sessionId, cols, rows };
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
        "#{pane_id}\t#{session_id}\t#{pane_width}\t#{pane_height}",
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
        "#{pane_id}\t#{session_id}\t#{pane_width}\t#{pane_height}",
      ],
      { timeout: timeoutMs },
    ),
  );
  if (
    current.paneId !== identity.paneId ||
    current.sessionId !== identity.sessionId ||
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
    processId: liveHostProcessPid(),
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

function clipboardHookName(nonce) {
  const index = Number.parseInt(nonce.replaceAll("-", "").slice(0, 8), 16) % 1_000_000_000;
  return `pane-set-clipboard[${index}]`;
}

function clipboardObserverShell(identity, nonce, hookName) {
  const script = fileURLToPath(import.meta.url);
  return [
    "env",
    ...(hostSocketPath ? [`TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH=${shQuote(hostSocketPath)}`] : []),
    `TMUX_IDE_TESTDRIVE_RUNTIME_DIR=${shQuote(runtimeDir)}`,
    shQuote(process.execPath),
    shQuote(script),
    "clipboard-observe",
    shQuote(nonce),
    shQuote(identity.paneId),
    // q: asks tmux to shell-quote values after format expansion.
    "#{q:pane_id}",
    "#{q:buffer_name}",
    shQuote(hookName),
  ].join(" ");
}

async function armClipboardObservation(identity, nonce, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  const remaining = () => {
    const value = Math.floor(deadline - performance.now());
    if (value < 1) fail("clipboard preflight exceeded its absolute deadline");
    return value;
  };
  mkdirSync(clipboardObservationDir, { recursive: true, mode: 0o700 });
  chmodSync(clipboardObservationDir, 0o700);
  const operationDir = join(clipboardObservationDir, nonce);
  mkdirSync(operationDir, { recursive: false, mode: 0o700 });
  const hookName = clipboardHookName(nonce);
  let existingHook = "";
  try {
    existingHook = tmux(["show-hooks", "-p", "-t", identity.paneId, hookName], {
      timeout: remaining(),
    });
  } catch {
    // An unset indexed hook has no value to show.
  }
  if (existingHook.trim()) {
    rmSync(operationDir, { recursive: true, force: true });
    fail(`clipboard hook slot ${hookName} is already occupied`);
  }
  const hookCommand = [
    `save-buffer -b #{q:buffer_name} ${shQuote(join(operationDir, "#{buffer_name}.bin"))}`,
    `run-shell ${shQuote(clipboardObserverShell(identity, nonce, hookName))}`,
  ].join(" ; ");
  try {
    tmux(["set-hook", "-p", "-t", identity.paneId, hookName, hookCommand], {
      timeout: remaining(),
    });
  } catch (error) {
    rmSync(operationDir, { recursive: true, force: true });
    throw error;
  }
  let disposed = false;
  return {
    async wait(waitTimeoutMs) {
      return waitForClipboardObservation({
        listArtifacts: () => clipboardEventArtifacts(nonce),
        readEvent: (artifactId) => {
          const path = join(operationDir, `${artifactId}.json`);
          return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
        },
        expected: { nonce, paneId: identity.paneId },
        clock: performance,
        sleep: delay,
        timeoutMs: waitTimeoutMs,
      });
    },
    async dispose(cleanupTimeoutMs) {
      if (disposed) return;
      disposed = true;
      try {
        tmux(["set-hook", "-pu", "-t", identity.paneId, hookName], {
          timeout: cleanupTimeoutMs,
        });
      } catch {
        // The pane may have retired; artifact validation below still fails closed.
      }
      if (clipboardEventArtifacts(nonce).length > 1) {
        rmSync(operationDir, { recursive: true, force: true });
        fail("multiple clipboard events arrived before observation disposal");
      }
      // Removing the operation directory fences a queued helper that has not
      // atomically renamed its result yet; it cannot publish after disposal.
      rmSync(operationDir, { recursive: true, force: true });
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

function captureClipboardObservation(args) {
  const [nonce, expectedPaneId, observedPaneId, bufferName, hookName] = args;
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(nonce ?? "")) {
    fail("invalid clipboard operation nonce");
  }
  if (!/^%[0-9]+$/u.test(expectedPaneId ?? "") || observedPaneId !== expectedPaneId) {
    fail("clipboard hook pane identity mismatch");
  }
  if (!/^buffer[0-9]+$/u.test(bufferName ?? "")) fail("clipboard hook buffer is not tmux-owned");
  if (!/^pane-set-clipboard\[[0-9]+\]$/u.test(hookName ?? "")) {
    fail("clipboard hook name is malformed");
  }
  mkdirSync(clipboardObservationDir, { recursive: true, mode: 0o700 });
  chmodSync(clipboardObservationDir, 0o700);
  const operationDir = join(clipboardObservationDir, nonce);
  if (!existsSync(operationDir)) fail("clipboard observation lease is no longer active");
  const capturedPayload = join(operationDir, `${bufferName}.bin`);
  const callbackCount = rawClipboardArtifactIds(operationDir).length;
  if (callbackCount > MAX_CLIPBOARD_CALLBACK_ARTIFACTS) {
    rmSync(capturedPayload, { force: true });
    const overflow = join(operationDir, "overflow.json");
    if (!existsSync(overflow)) {
      writeFileSync(
        overflow,
        `${JSON.stringify({ version: 1, nonce, paneId: observedPaneId, overflow: callbackCount })}\n`,
        { flag: "wx", mode: 0o600 },
      );
    }
    try {
      tmux(["set-hook", "-pu", "-t", expectedPaneId, hookName], { timeout: 250 });
    } catch {
      // The parent disposer will retry bounded cleanup.
    }
    return;
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
    bytes: declaredBytes,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
  const temporary = join(operationDir, `${bufferName}.tmp`);
  const complete = join(operationDir, `${bufferName}.json`);
  writeFileSync(temporary, `${JSON.stringify(event)}\n`, { flag: "wx", mode: 0o600 });
  if (!existsSync(operationDir)) fail("clipboard observation lease retired before publication");
  renameSync(temporary, complete);
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
    const canonicalHome = canonicalDaemonHome();
    const daemonInfoPath = join(canonicalHome, "daemon.json");
    if (!existsSync(daemonInfoPath)) fail(`Canonical daemon info missing at ${daemonInfoPath}`);
  }
  rmSync(logPath, { force: true });
  rmSync(perfLogPath, { force: true });

  const binary = options.source ? "bun" : compiledTui;
  const binaryArgs = options.source
    ? [sourceTui, `--target=${target}`]
    : ["app", `--target=${target}`];
  const launchEpochMs = Date.now();
  const launchId = randomUUID();
  const environment = [
    `TMUX_IDE_CWD=${shQuote(repoRoot)}`,
    `TMUX_IDE_HOME=${shQuote(stateHome)}`,
    ...(process.env.TMUX_IDE_TESTDRIVE_USE_CANONICAL_DAEMON === "1"
      ? [`TMUX_IDE_DAEMON_INFO_DIR=${shQuote(canonicalDaemonHome())}`]
      : [
          "TMUX_IDE_RUNTIME_MODE=testdrive",
          `TMUX_IDE_REGISTRY_DIR=${shQuote(join(runtimeDir, "registry"))}`,
          `TMUX_IDE_DAEMON_INFO_DIR=${shQuote(stateHome)}`,
          `TMUX_IDE_TMUX_SOCKET_NAME=${shQuote(targetSocketName ?? namespaceSocketName)}`,
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
          `TMUX_IDE_PERFORMANCE_TRACE_DETAIL=${shQuote(process.env.TMUX_IDE_PERFORMANCE_TRACE_DETAIL ?? "1")}`,
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
  const appChromeFrameMs = performance.now() - launchStartedAt;
  const processId = liveHostProcessPid();
  if (!processId) fail("OpenTUI host published chrome without an owned process id");
  const metadata = {
    hostSession,
    target,
    cols: options.cols,
    rows: options.rows,
    runtime,
    debug: options.debug,
    startedAt: new Date().toISOString(),
    launchId,
    processId,
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
  });

  process.stdout.write(
    `OpenTUI test-drive chrome ready in ${hostPublication.elapsedMs}ms (${runtime}, ${options.cols}x${options.rows}, target ${target})\n` +
      `Attach: tmux attach -t ${hostSession}\n` +
      `Logs:   ${logPath}\n\n${frame}\n`,
  );
}

async function status(json = false) {
  const running = sessionExists(hostSession);
  const metadata = readMetadata();
  const result = {
    running,
    ...metadata,
    readiness: readLifecycleTimings(metadata),
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
      if (args.length !== 5) fail("clipboard-observe received malformed hook arguments");
      captureClipboardObservation(args);
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
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
