#!/usr/bin/env node

/**
 * Bounded daemon soak harness.
 *
 * Usage (Node 22.18+ / 24 — the script imports a `.ts` module):
 *   pnpm build
 *   node packages/daemon/scripts/soak-daemon.mjs --duration 30m --out ./soak-artifacts
 *   node packages/daemon/scripts/soak-daemon.mjs --config soak.json --duration 24h
 *
 * What it does:
 *   1. Creates a private default tmux socket under TMUX_TMPDIR and a
 *      temporary TMUX_IDE_HOME / daemon record dir / registry / settings dir.
 *      Nothing touches the user's tmux server, daemon or ~/.tmux-ide.
 *   2. Starts the selected --cli artifact (checkout bin/cli.js by default): `node <cli> --headless
 *      --json`. Its tmux binary is a counting shim on PATH (TMUX_IDE_TMUX_BIN)
 *      that logs one record per spawn and execs the real tmux, exactly as
 *      `src/lib/__tests__/observer-idle-overhead-live.test.ts` does.
 *   3. Creates N sessions with M stamped panes (`@tmux_ide_adopted`,
 *      `@tmux_ide_pane_id`, `@agent_state`), then runs synthetic churn:
 *      agent-status flips, periodic workspace promotions over HTTP, one
 *      `/ws/events` client that pings every second and reconnects every K
 *      minutes, a `tmux-ide wait agent-status --status done` receipt-waiter
 *      loop, and periodic `send-keys` bursts (which fire the observer's
 *      after-send-keys hook).
 *   4. Every sample interval it records one JSONL line: daemon RSS and CPU
 *      delta (`ps`), open fds (`lsof` / `/proc`), and owner-only diagnostics:
 *      identity, memory bytes, cumulative CPU/event-loop counters, derived
 *      interval rates, and bounded resource counts. Also tmux spawns by
 *      command word, ping RTT and receipt-latency p50/max, observer gap
 *      warnings (tailed from the daemon's `/api/logs/daemon` SSE stream; in
 *      headless mode structured logs live only in that ring buffer), restarts
 *      and failures.
 *   5. At `--duration` (or SIGINT) it evaluates the series with
 *      `src/lib/soak-verdict.ts` (unit-tested), prints a summary, writes
 *      `summary.json` after teardown, exits 1 on FAIL, 2 on INCONCLUSIVE.
 *
 * Session names use the `soak-` prefix rather than `zz-`: the fleet read that
 * `wait agent-status` uses filters `zz-` sessions as development scratch, so a
 * waiter could never resolve against them. Isolation comes from the private
 * socket, not the name.
 */

import { Buffer } from "node:buffer";
import { execFile, execFileSync, spawn } from "node:child_process";
import console from "node:console";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

import { WebSocket } from "ws";

import {
  countSpawnsByCommand,
  DEFAULT_SOAK_THRESHOLDS,
  evaluateSoak,
  formatSoakReport,
  parseDurationMs,
  parsePsTime,
  percentiles,
  soakTrends,
  validSoakAck,
  correlatedPongRtt,
} from "../src/lib/soak-verdict.ts";

import {
  DIAGNOSTICS_MAX_BYTES,
  parseSoakDiagnostics,
  diagnosticsDelta,
} from "../src/lib/soak-diagnostics.ts";

const execFileAsync = promisify(execFile);
const sleeps = new Set();
const sleep = (ms) =>
  new Promise((resolveSleep) => {
    const wake = () => {
      clearTimeout(timer);
      sleeps.delete(wake);
      resolveSleep();
    };
    const timer = setTimeout(wake, ms);
    sleeps.add(wake);
  });
let loops = [];

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");

// ---------------------------------------------------------------------------
// Configuration: defaults < --config JSON < CLI flags.
// ---------------------------------------------------------------------------

const DEFAULTS = {
  cli: join(repoRoot, "bin/cli.js"),
  tmux: null,
  warmup: "5m",
  trailing: "10m",
  ackDeadline: "10s",
  duration: "30m",
  sessions: 4,
  panes: 4,
  flipInterval: "2s",
  promoteInterval: "5m",
  reconnectInterval: "5m",
  waitInterval: "15s",
  waitTimeout: "30s",
  waiterSettle: "1500ms",
  sendBurstInterval: "30s",
  sendBurstCount: 10,
  pingInterval: "1s",
  sampleInterval: "60s",
  sessionPrefix: "soak-",
  out: null,
  keepRoot: false,
  thresholds: { ...DEFAULT_SOAK_THRESHOLDS },
};

const { values: flags } = parseArgs({
  options: {
    cli: { type: "string" },
    tmux: { type: "string" },
    config: { type: "string" },
    duration: { type: "string" },
    sessions: { type: "string" },
    panes: { type: "string" },
    "flip-interval": { type: "string" },
    "promote-interval": { type: "string" },
    "reconnect-interval": { type: "string" },
    "wait-interval": { type: "string" },
    "wait-timeout": { type: "string" },
    "waiter-settle": { type: "string" },
    "send-burst-interval": { type: "string" },
    "send-burst-count": { type: "string" },
    "ping-interval": { type: "string" },
    "sample-interval": { type: "string" },
    "session-prefix": { type: "string" },
    out: { type: "string" },
    "keep-root": { type: "boolean" },
    "max-rss-growth-mib-per-hour": { type: "string" },
    "max-fd-drift": { type: "string" },
    "max-ping-rtt-p50-ms": { type: "string" },
    "max-receipt-latency-p50-ms": { type: "string" },
    "max-observer-gap-warnings": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
});

if (flags.help) {
  process.stdout.write(
    [
      "soak-daemon.mjs — bounded daemon soak against a private tmux server",
      "",
      "  --cli <installed/bin/cli.js>    explicit artifact (default checkout bin/cli.js)",
      "  --tmux <binary>                explicit native tmux binary",
      "  --config <file.json>           JSON config (same keys as the flags, camelCase; `thresholds` object)",
      "  --duration 30m                 run length (ms|s|m|h|d)",
      "  --sessions 4 --panes 4         fleet shape (the last session is the receipt-waiter target)",
      "  --flip-interval 2s             agent-status flip cadence (round-robin over the other sessions)",
      "  --promote-interval 5m          workspace.promote cadence over HTTP",
      "  --reconnect-interval 5m        events-client scheduled reconnect cadence",
      "  --wait-interval 15s            receipt-waiter cadence; --wait-timeout 30s; --waiter-settle 1500ms",
      "  --send-burst-interval 30s      --send-burst-count 10",
      "  --ping-interval 1s             events-client ping cadence",
      "  --sample-interval 60s          JSONL sample cadence",
      "  --out <dir>                    artifact dir (samples.jsonl, summary.json, daemon.log, spawns.log)",
      "  --keep-root                    keep the temp root after the run",
      "  --max-rss-growth-mib-per-hour, --max-fd-drift, --max-ping-rtt-p50-ms,",
      "  --max-receipt-latency-p50-ms, --max-observer-gap-warnings   threshold overrides",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

function loadConfig() {
  const config = { ...DEFAULTS, thresholds: { ...DEFAULTS.thresholds } };
  if (flags.config) {
    const raw = JSON.parse(readFileSync(resolve(flags.config), "utf8"));
    for (const [key, value] of Object.entries(raw)) {
      if (key === "thresholds") Object.assign(config.thresholds, value);
      else if (key in config) config[key] = value;
      else throw new Error(`Unknown config key: ${key}`);
    }
  }
  const flagMap = {
    cli: "cli",
    tmux: "tmux",
    duration: "duration",
    sessions: "sessions",
    panes: "panes",
    "flip-interval": "flipInterval",
    "promote-interval": "promoteInterval",
    "reconnect-interval": "reconnectInterval",
    "wait-interval": "waitInterval",
    "wait-timeout": "waitTimeout",
    "waiter-settle": "waiterSettle",
    "send-burst-interval": "sendBurstInterval",
    "send-burst-count": "sendBurstCount",
    "ping-interval": "pingInterval",
    "sample-interval": "sampleInterval",
    "session-prefix": "sessionPrefix",
    out: "out",
    "keep-root": "keepRoot",
  };
  for (const [flag, key] of Object.entries(flagMap)) {
    if (flags[flag] !== undefined) config[key] = flags[flag];
  }
  const thresholdFlags = {
    "max-rss-growth-mib-per-hour": "maxRssGrowthMiBPerHour",
    "max-fd-drift": "maxFdDrift",
    "max-ping-rtt-p50-ms": "maxPingRttP50Ms",
    "max-receipt-latency-p50-ms": "maxReceiptLatencyP50Ms",
    "max-observer-gap-warnings": "maxObserverGapWarnings",
  };
  for (const [flag, key] of Object.entries(thresholdFlags)) {
    if (flags[flag] !== undefined) config.thresholds[key] = Number(flags[flag]);
  }
  config.sessions = Number(config.sessions);
  config.panes = Number(config.panes);
  config.sendBurstCount = Number(config.sendBurstCount);
  if (!Number.isInteger(config.sessions) || config.sessions < 1)
    throw new Error("--sessions must be >= 1");
  if (!Number.isInteger(config.panes) || config.panes < 1) throw new Error("--panes must be >= 1");
  return config;
}

const config = loadConfig();
const cliPath = realpathSync(resolve(config.cli));
const cliHash = () => createHash("sha256").update(readFileSync(cliPath)).digest("hex");
const cliStartSha256 = cliHash();
const harnessSha256 = createHash("sha256")
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .digest("hex");
let cliPackage = null;
try {
  const pkg = JSON.parse(readFileSync(join(dirname(cliPath), "..", "package.json"), "utf8"));
  cliPackage = { name: pkg.name, version: pkg.version };
} catch {
  /* isolated bundle */
}
const ms = {
  warmup: parseDurationMs(config.warmup),
  trailing: parseDurationMs(config.trailing),
  ackDeadline: parseDurationMs(config.ackDeadline),
  duration: parseDurationMs(config.duration),
  flip: parseDurationMs(config.flipInterval),
  promote: parseDurationMs(config.promoteInterval),
  reconnect: parseDurationMs(config.reconnectInterval),
  wait: parseDurationMs(config.waitInterval),
  waitTimeout: parseDurationMs(config.waitTimeout),
  waiterSettle: parseDurationMs(config.waiterSettle),
  sendBurst: parseDurationMs(config.sendBurstInterval),
  ping: parseDurationMs(config.pingInterval),
  sample: parseDurationMs(config.sampleInterval),
};

for (const [key, value] of Object.entries(ms))
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid duration ${key}`);
if (!existsSync(cliPath)) {
  console.error(`Built CLI not found at ${cliPath}; run \`pnpm build\` first.`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Private environment.
// ---------------------------------------------------------------------------

const startedAtWall = new Date();
const root = mkdtempSync(join(tmpdir(), "tmux-ide-soak-"));
const outDir = resolve(config.out ?? mkdtempSync(join(tmpdir(), "tmux-ide-soak-artifacts-")));
mkdirSync(outDir, { recursive: true });
const dirs = {
  project: join(root, "project"),
  shim: join(root, "bin"),
  home: join(root, "home"),
  ideHome: join(root, "ide-home"),
  daemon: join(root, "daemon"),
  registry: join(root, "registry"),
  settings: join(root, "settings"),
  claude: join(root, "claude"),
};
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
const tmuxTmpDir = mkdtempSync("/tmp/tis-");
const socketDir = join(tmuxTmpDir, `tmux-${process.getuid()}`);
mkdirSync(socketDir, { mode: 0o700 });
const socketPath = join(socketDir, "default");
const shimPath = join(dirs.shim, "tmux");
const spawnLog = join(outDir, "spawns.log");
const samplesPath = join(outDir, "samples.jsonl");
const summaryPath = join(outDir, "summary.json");
const daemonLogPath = join(outDir, "daemon.log");
const daemonEntriesPath = join(outDir, "daemon-entries.jsonl");
const realTmux = realpathSync(
  config.tmux ?? execFileSync("which", ["tmux"], { encoding: "utf8" }).trim(),
);

const shellQuote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
writeFileSync(spawnLog, "");
writeFileSync(
  shimPath,
  [
    "#!/bin/sh",
    `LOG=${shellQuote(spawnLog)}`,
    'line=""; for a in "$@"; do line="$line$a\x01"; done',
    'printf "%s\\n" "$line" >> "$LOG"',
    `exec ${shellQuote(realTmux)} "$@"`,
    "",
  ].join("\n"),
);
chmodSync(shimPath, 0o755);

const baseEnv = { ...process.env };
for (const key of Object.keys(baseEnv))
  if (
    key.startsWith("TMUX_IDE_") ||
    key.startsWith("PILOTTY_") ||
    ["TMUX", "TMUX_PANE", "NODE_OPTIONS", "NODE_PATH"].includes(key)
  )
    delete baseEnv[key];
delete baseEnv.TMUX_IDE_SESSION;
delete baseEnv.TMUX_IDE_TMUX_BIN;
Object.assign(baseEnv, {
  HOME: dirs.home,
  NO_COLOR: "1",
  TMUX: "",
  TMUX_TMPDIR: tmuxTmpDir,
  TMUX_IDE_TMUX_SOCKET_PATH: socketPath,
  TMUX_IDE_HOME: dirs.ideHome,
  TMUX_IDE_CONFIG: join(root, "config.json"),
  TMUX_IDE_DAEMON_INFO_DIR: dirs.daemon,
  TMUX_IDE_REGISTRY_DIR: dirs.registry,
  TMUX_IDE_SETTINGS_DIR: dirs.settings,
  TMUX_IDE_CLAUDE_SETTINGS: join(dirs.claude, "settings.json"),
  TMUX_IDE_CLAUDE_DIR: dirs.claude,
});
/** The daemon spawns tmux through the counting shim. */
const daemonEnv = {
  ...baseEnv,
  PATH: `${dirs.shim}:${baseEnv.PATH ?? ""}`,
  TMUX_IDE_TMUX_BIN: shimPath,
};
/** Harness-driven CLI children use the real tmux so only daemon spawns are counted. */
const clientEnv = { ...baseEnv, TMUX_IDE_TMUX_BIN: realTmux };

const tmux = (argv) =>
  execFileSync(realTmux, ["-S", socketPath, ...argv], {
    cwd: root,
    env: clientEnv,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).replace(/(?:\r?\n)+$/u, "");
const tmuxAsync = async (argv) => {
  const { stdout } = await execFileAsync(realTmux, ["-S", socketPath, ...argv], {
    cwd: root,
    env: clientEnv,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return stdout.replace(/(?:\r?\n)+$/u, "");
};

const log = (line) =>
  process.stdout.write(`[soak ${new Date().toISOString().slice(11, 19)}] ${line}\n`);

// ---------------------------------------------------------------------------
// Counters shared by the churn loops and the sampler.
// ---------------------------------------------------------------------------

const interval = {
  pings: [],
  receipts: [],
  receiptFailures: 0,
  unexpectedDisconnects: 0,
  scheduledReconnects: 0,
  reconnectToReadyMs: [],
  wsFrames: {},
  journalGaps: 0,
  flips: 0,
  flipFailures: 0,
  promotions: [],
  promotionFailures: 0,
  sendBursts: 0,
  sendKeys: 0,
  sendFailures: 0,
  healthMs: [],
  healthFailures: 0,
};
const resetInterval = () => {
  interval.pings = [];
  interval.receipts = [];
  interval.receiptFailures = 0;
  interval.unexpectedDisconnects = 0;
  interval.scheduledReconnects = 0;
  interval.reconnectToReadyMs = [];
  interval.wsFrames = {};
  interval.journalGaps = 0;
  interval.flips = 0;
  interval.flipFailures = 0;
  interval.promotions = [];
  interval.promotionFailures = 0;
  interval.sendBursts = 0;
  interval.sendKeys = 0;
  interval.sendFailures = 0;
  interval.healthMs = [];
  interval.healthFailures = 0;
};
const runFailures = {
  health: 0,
  flip: 0,
  promotion: 0,
  send: 0,
  receipt: 0,
  daemonMissing: 0,
  daemonExit: 0,
  ack: 0,
  pingDeadline: 0,
  loop: 0,
  sample: 0,
  artifactChanged: 0,
};
const runLoads = { flips: 0, promotions: 0, sends: 0, receipts: 0 };
let ackAttempts = 0;
let ackSuccesses = 0;
let sampleFailures = 0;
let droppedObservations = 0;
function recordObservation(array, value) {
  if (array.length < 4096) array.push(value);
  else droppedObservations += 1;
}
let daemonRestarts = 0;
let daemonExited = null;
let stopping = false;
const children = new Set();

// ---------------------------------------------------------------------------
// Daemon lifecycle.
// ---------------------------------------------------------------------------

let daemon = null;
let daemonInfo = null;
let previousDiagnostics = null;
const daemonLogStream = createWriteStream(daemonLogPath, { flags: "a" });
let gapWarningsSinceSample = 0;
let gapWarningsTotal = 0;

function scanDaemonLine(line) {
  if (line.includes("Interaction observation gap")) {
    gapWarningsSinceSample += 1;
    gapWarningsTotal += 1;
  }
}

function startDaemon() {
  return new Promise((resolveReady, reject) => {
    const child = spawn(process.execPath, [cliPath, "--headless", "--json"], {
      cwd: dirs.project,
      env: daemonEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    daemon = child;
    let ready = false;
    let stdoutBuffer = "";
    let stderrBuffer = "";
    const timer = setTimeout(() => {
      if (!ready) reject(new Error(`daemon did not report ready within 60s\n${stderrBuffer}`));
    }, 60_000);
    child.stdout.on("data", (chunk) => {
      daemonLogStream.write(chunk);
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        scanDaemonLine(line);
        if (!ready && line.startsWith("{")) {
          try {
            const parsed = JSON.parse(line);
            if (parsed.status === "ready" || parsed.status === "already-running") {
              ready = true;
              clearTimeout(timer);
              resolveReady(parsed);
            }
          } catch {
            // structured log line, not the status line
          }
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      daemonLogStream.write(chunk);
      stderrBuffer += chunk.toString("utf8");
      const lines = stderrBuffer.split("\n");
      stderrBuffer = lines.pop() ?? "";
      for (const line of lines) scanDaemonLine(line);
    });
    child.once("exit", (code, signal) => {
      daemonExited = { code, signal, at: Date.now() };
      if (!stopping) {
        daemonRestarts += 1;
        runFailures.daemonExit += 1;
        log(`DAEMON EXITED unexpectedly (code ${code}, signal ${signal})`);
      }
      if (!ready) {
        clearTimeout(timer);
        reject(
          new Error(`daemon exited before ready (code ${code}, signal ${signal})\n${stderrBuffer}`),
        );
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Structured log tail. In headless mode the daemon's structured logger only
// keeps an in-process ring buffer (its stdout carries just the ready line), so
// observer gap warnings are read from the `/api/logs/daemon` SSE stream.
// Entries lack durable identities: retain duplicates, and treat reconnect coverage as inconclusive.
// ---------------------------------------------------------------------------

const GAP_MESSAGE = "Interaction observation gap";

let logTailAbort = null;
let logEntriesSinceSample = 0;
let logWarningsSinceSample = 0;
let logTailReconnects = 0;
let logTailBookmarks = 0;
let logGapFrames = 0;
let logMalformedFrames = 0;
let lastLogFrameAt = null;
let logConnected = false;
const logConnections = [];
const boundedError = (error) => ({
  name: String(error?.name ?? "").slice(0, 80),
  message: String(error?.message ?? error).slice(0, 240),
  cause: {
    name: String(error?.cause?.name ?? "").slice(0, 80),
    code: String(error?.cause?.code ?? "").slice(0, 80),
  },
});

function noteLogEntry(entry) {
  logEntriesSinceSample += 1;
  if (entry.level === "warn" || entry.level === "error") logWarningsSinceSample += 1;
  if (typeof entry.msg === "string" && entry.msg.includes(GAP_MESSAGE)) {
    gapWarningsSinceSample += 1;
    gapWarningsTotal += 1;
    log(`observer gap warning: ${JSON.stringify(entry.data ?? {}).slice(0, 200)}`);
  }
  appendFileSync(daemonEntriesPath, `${JSON.stringify(entry)}\n`);
}

async function tailDaemonLogs() {
  while (!stopping) {
    const controller = new AbortController();
    logTailAbort = controller;
    const connection = {
      startedAt: Date.now(),
      endedAt: null,
      lastFrameAt: null,
      frames: 0,
      outcome: null,
    };
    try {
      const response = await fetch(`${daemonInfo.apiBaseUrl}/api/logs/daemon`, {
        headers: { Authorization: `Bearer ${daemonInfo.authToken}`, Accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (response.status !== 200 || !response.body) throw new Error(`HTTP ${response.status}`);
      if (logTailReconnects === 0)
        log(
          `log tail connected (HTTP ${response.status}, ${response.headers.get("content-type")})`,
        );
      logConnected = true;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          connection.outcome = "eof";
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 2 * 1024 * 1024) throw new Error("SSE frame buffer exceeded 2MiB");
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          lastLogFrameAt = Date.now();
          connection.lastFrameAt = lastLogFrameAt;
          connection.frames += 1;
          let event = "message";
          const dataLines = [];
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
          }
          if (event === "gap") logGapFrames += 1;
          if (event === "bookmark") logTailBookmarks += 1;
          if (event !== "entry" || dataLines.length === 0) continue;
          try {
            noteLogEntry(JSON.parse(dataLines.join("\n")));
          } catch {
            logMalformedFrames += 1;
          }
        }
      }
    } catch (error) {
      connection.outcome = controller.signal.aborted ? "harness-abort" : "exception";
      connection.error = boundedError(error);
      if (!stopping) log(`log tail dropped: ${JSON.stringify(connection.error)}`);
    }
    logConnected = false;
    connection.endedAt = Date.now();
    appendFileSync(join(outDir, "log-connections.jsonl"), `${JSON.stringify(connection)}\n`);
    logConnections.push(connection);
    if (logConnections.length > 32) logConnections.shift();
    if (stopping) break;
    logTailReconnects += 1;
    await sleep(1_000);
  }
}

function readDaemonRecord() {
  try {
    return JSON.parse(readFileSync(join(dirs.daemon, "daemon.json"), "utf8"));
  } catch {
    return null;
  }
}

async function stopDaemon() {
  if (!daemon || daemonExited) return;
  daemon.kill("SIGTERM");
  const deadline = Date.now() + 15_000;
  while (!daemonExited && Date.now() < deadline) await sleep(100);
  if (!daemonExited) {
    daemon.kill("SIGKILL");
    const killDeadline = Date.now() + 2_000;
    while (!daemonExited && Date.now() < killDeadline) await sleep(50);
  }
}

// ---------------------------------------------------------------------------
// Fleet setup.
// ---------------------------------------------------------------------------

/** Mirrors fleetSessionIdForName in command-center/resources/fleet-catalog.ts. */
const fleetSessionId = (name) =>
  `session.${createHash("sha256").update(name).digest("hex").slice(0, 20)}`;

const sessions = [];

function createFleet() {
  for (let index = 0; index < config.sessions; index += 1) {
    const name = `${config.sessionPrefix}${index}`;
    const first = tmux([
      "new-session",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-x",
      "220",
      "-y",
      "60",
      "-s",
      name,
      "-c",
      dirs.project,
      "-n",
      "w0",
      "exec sleep 2147483",
    ]);
    const panes = [first];
    for (let pane = 1; pane < config.panes; pane += 1) {
      panes.push(
        tmux([
          "split-window",
          "-d",
          "-P",
          "-F",
          "#{pane_id}",
          "-t",
          `${name}:w0`,
          "-c",
          dirs.project,
          "exec sleep 2147483",
        ]),
      );
      tmux(["select-layout", "-t", `${name}:w0`, "tiled"]);
    }
    for (const paneId of panes) {
      tmux([
        "set-option",
        "-p",
        "-t",
        paneId,
        "@tmux_ide_pane_id",
        `pane.soak.${randomUUID().replace(/-/gu, "").slice(0, 20)}`,
      ]);
      tmux([
        "set-option",
        "-p",
        "-t",
        paneId,
        "@agent_state",
        `done:${Math.floor(Date.now() / 1000)}`,
      ]);
    }
    tmux(["set-option", "-t", name, "@tmux_ide_adopted", "1"]);
    sessions.push({ name, panes, state: "done" });
  }
}

// ---------------------------------------------------------------------------
// Churn loops.
// ---------------------------------------------------------------------------

const stamp = (paneId, state) =>
  tmuxAsync([
    "set-option",
    "-p",
    "-t",
    paneId,
    "@agent_state",
    `${state}:${Math.floor(Date.now() / 1000)}`,
  ]);

async function flipLoop() {
  const targets = sessions.length > 1 ? sessions.slice(0, -1) : sessions;
  const panes = targets.flatMap((session) =>
    session.panes.map((paneId) => ({ paneId, state: "done" })),
  );
  let cursor = 0;
  while (!stopping) {
    const pane = panes[cursor % panes.length];
    cursor += 1;
    pane.state = pane.state === "working" ? "done" : "working";
    try {
      await stamp(pane.paneId, pane.state);
      interval.flips += 1;
      runLoads.flips += 1;
    } catch {
      interval.flipFailures += 1;
      runFailures.flip += 1;
    }
    if (!stopping) await sleep(ms.flip);
  }
}

async function receiptWaiterLoop() {
  if (sessions.length === 0) return;
  const target = sessions[sessions.length - 1];
  await sleep(5_000);
  while (!stopping) {
    try {
      await Promise.all(target.panes.map((paneId) => stamp(paneId, "working")));
    } catch {
      interval.receiptFailures += 1;
      runFailures.receipt += 1;
      if (!stopping) await sleep(ms.wait);
      continue;
    }
    const spawnedAt = Date.now();
    const child = spawn(
      process.execPath,
      [
        cliPath,
        "wait",
        "agent-status",
        target.name,
        "--status",
        "done",
        "--timeout",
        String(ms.waitTimeout),
        "--json",
      ],
      { cwd: dirs.project, env: clientEnv, stdio: ["ignore", "pipe", "pipe"] },
    );
    children.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    const exited = new Promise((resolveExit) =>
      child.once("close", (code) => resolveExit({ code, at: Date.now() })),
    );
    await sleep(ms.waiterSettle);
    let flippedAt = null;
    try {
      if (!stopping) await Promise.all(target.panes.map((paneId) => stamp(paneId, "done")));
      flippedAt = Date.now();
    } catch {
      // the waiter will time out; counted below
    }
    const result = await exited;
    children.delete(child);
    const ok = (() => {
      try {
        return result.code === 0 && JSON.parse(stdout.trim().split("\n").pop() ?? "{}").ok === true;
      } catch {
        return false;
      }
    })();
    if (ok && flippedAt !== null && result.at >= flippedAt) {
      recordObservation(interval.receipts, result.at - flippedAt);
      runLoads.receipts += 1;
    } else if (stopping) {
      // Teardown killed the waiter; not a daemon failure.
    } else {
      interval.receiptFailures += 1;
      runFailures.receipt += 1;
      log(
        `receipt waiter failed: code ${result.code} total ${result.at - spawnedAt}ms flipped ${flippedAt === null ? "never" : `${result.at - flippedAt}ms before exit`} ${stderr.trim().slice(0, 200)}`,
      );
    }
    if (!stopping) await sleep(ms.wait);
  }
}

async function promoteOnce(session) {
  const startedAt = performance.now();
  try {
    const response = await fetch(`${daemonInfo.apiBaseUrl}/api/v2/action/workspace.promote`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${daemonInfo.authToken}`,
        "Content-Type": "application/json",
        "X-Tmux-Ide-Operation-Id": randomUUID(),
        Connection: "close",
      },
      body: JSON.stringify({ sessionId: fleetSessionId(session.name) }),
      signal: AbortSignal.timeout(30_000),
    });
    const elapsedMs = performance.now() - startedAt;
    const envelope = await response.json().catch(() => ({}));
    const outcome = envelope?.result?.outcome ?? envelope?.error?.code ?? envelope?.error ?? null;
    if (response.status === 200 && envelope.ok === true) {
      runLoads.promotions += 1;
      recordObservation(interval.promotions, {
        session: session.name,
        ms: Math.round(elapsedMs),
        outcome,
      });
    } else {
      interval.promotionFailures += 1;
      runFailures.promotion += 1;
      log(
        `promotion of ${session.name} failed: HTTP ${response.status} ${JSON.stringify(envelope).slice(0, 200)}`,
      );
    }
  } catch (error) {
    interval.promotionFailures += 1;
    runFailures.promotion += 1;
    log(`promotion of ${session.name} threw: ${String(error).slice(0, 200)}`);
  }
}

async function promotionLoop() {
  let cursor = 0;
  await sleep(10_000);
  while (!stopping) {
    await promoteOnce(sessions[cursor % sessions.length]);
    cursor += 1;
    if (!stopping) await sleep(ms.promote);
  }
}

async function sendBurstLoop() {
  const panes = sessions.flatMap((session) => session.panes);
  let cursor = 0;
  let burst = 0;
  await sleep(ms.sendBurst);
  while (!stopping) {
    burst += 1;
    for (let index = 0; index < config.sendBurstCount && !stopping; index += 1) {
      const paneId = panes[cursor % panes.length];
      cursor += 1;
      try {
        await tmuxAsync(["send-keys", "-t", paneId, `soak burst ${burst} key ${index}`]);
        interval.sendKeys += 1;
        runLoads.sends += 1;
      } catch {
        interval.sendFailures += 1;
        runFailures.send += 1;
      }
    }
    interval.sendBursts += 1;
    if (!stopping) await sleep(ms.sendBurst);
  }
}

// ---------------------------------------------------------------------------
// Events client: hello → subscribe → interests-ack, then one ping in flight.
// ---------------------------------------------------------------------------

class EventsClient {
  socket = null;
  attempt = null;
  reconnectTimer = null;
  probe = null;
  pingTimer = null;
  ready = false;

  connect() {
    if (stopping) return;
    const socket = new WebSocket(`${daemonInfo.apiBaseUrl.replace(/^http/u, "ws")}/ws/events`, {
      headers: { Authorization: `Bearer ${daemonInfo.authToken}` },
      handshakeTimeout: ms.ackDeadline,
    });
    const attempt = {
      number: ++ackAttempts,
      startedAt: performance.now(),
      openedAt: null,
      helloAt: null,
      subscribedAt: null,
      settled: false,
      scheduled: false,
    };
    this.socket = socket;
    this.attempt = attempt;
    this.ready = false;
    const settle = (outcome) => {
      if (attempt.settled) return;
      attempt.settled = true;
      clearTimeout(attempt.timer);
      if (outcome === "ack") ackSuccesses += 1;
      else if (outcome !== "teardown-before-ack") runFailures.ack += 1;
      const endedAt = performance.now();
      appendFileSync(
        join(outDir, "reconnects.jsonl"),
        `${JSON.stringify({
          number: attempt.number,
          outcome,
          connectToOpenMs: attempt.openedAt === null ? null : attempt.openedAt - attempt.startedAt,
          openToHelloMs: attempt.helloAt === null ? null : attempt.helloAt - attempt.openedAt,
          subscribeToAckMs: outcome === "ack" ? endedAt - attempt.subscribedAt : null,
          totalMs: endedAt - attempt.startedAt,
        })}\n`,
      );
    };
    attempt.settle = settle;
    attempt.timer = setTimeout(() => {
      settle("deadline");
      socket.terminate();
    }, ms.ackDeadline);
    socket.on("open", () => {
      attempt.openedAt = performance.now();
    });
    socket.on("message", (data) => {
      if (this.socket !== socket) return;
      let frame;
      try {
        frame = JSON.parse(String(data));
      } catch {
        return;
      }
      interval.wsFrames[frame.type] = (interval.wsFrames[frame.type] ?? 0) + 1;
      if (frame.type === "hello" && attempt.helloAt === null) {
        attempt.helloAt = performance.now();
        attempt.subscribedAt = performance.now();
        socket.send(
          JSON.stringify({
            type: "subscribe",
            sessions: [],
            legacyEvents: true,
            interests: [{ resource: "fleet-catalog", workspaceName: null }],
            interestRevision: attempt.number,
          }),
        );
      } else if (frame.type === "resource.interests-ack" && !attempt.settled) {
        if (attempt.subscribedAt === null || !validSoakAck(frame, attempt.number)) {
          settle("invalid-ack");
          socket.terminate();
          return;
        }
        settle("ack");
        this.ready = true;
        recordObservation(interval.reconnectToReadyMs, performance.now() - attempt.startedAt);
        this.ping(socket);
      } else if (frame.type === "snapshot-required") interval.journalGaps += 1;
    });
    socket.on("pong", (payload) => {
      const probe = this.probe;
      if (!probe || probe.socket !== socket) return;
      const rtt = correlatedPongRtt(probe, payload.toString(), performance.now());
      if (rtt === null) return;
      clearTimeout(probe.timer);
      recordObservation(interval.pings, rtt);
      this.probe = null;
      this.pingTimer = setTimeout(() => this.ping(socket), ms.ping);
    });
    socket.on("error", (error) => {
      if (!stopping) log(`events error: ${JSON.stringify(boundedError(error))}`);
    });
    socket.on("close", () => {
      settle(stopping ? "teardown-before-ack" : "closed-before-ack");
      if (this.socket !== socket) return;
      clearTimeout(this.pingTimer);
      if (this.probe) {
        clearTimeout(this.probe.timer);
        this.probe = null;
      }
      this.socket = null;
      this.ready = false;
      if (stopping) return;
      if (!attempt.scheduled) interval.unexpectedDisconnects += 1;
      this.reconnectTimer = setTimeout(() => this.connect(), attempt.scheduled ? 0 : 1_000);
    });
  }

  ping(socket) {
    if (stopping || this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
    const probe = { id: randomUUID(), socket, at: performance.now() };
    this.probe = probe;
    probe.timer = setTimeout(() => {
      runFailures.pingDeadline += 1;
      this.probe = null;
      socket.terminate();
    }, 10_000);
    // RFC 6455 control pong echoes our payload; unsolicited application pongs cannot satisfy it.
    socket.ping(probe.id);
  }

  scheduledReconnect() {
    if (!this.socket || !this.ready) return;
    // Avoid cancelling an in-flight probe; next loop iteration can reconnect.
    if (this.probe) return;
    interval.scheduledReconnects += 1;
    this.attempt.scheduled = true;
    this.socket.terminate();
  }

  stop() {
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.pingTimer);
    if (this.probe) {
      clearTimeout(this.probe.timer);
      this.probe = null;
    }
    this.attempt?.settle("teardown-before-ack");
    this.socket?.terminate();
  }
}

const events = new EventsClient();

async function reconnectLoop() {
  while (!stopping) {
    await sleep(ms.reconnect);
    if (!stopping) events.scheduledReconnect();
  }
}

// ---------------------------------------------------------------------------
// Sampler.
// ---------------------------------------------------------------------------

const samples = [];
let spawnLogOffset = 0;
let lastCpuSeconds = null;
let lastSampleAt = 0;
let soakStartedAt = 0;

function readNewSpawnRecords() {
  const size = statSync(spawnLog).size;
  if (size <= spawnLogOffset) return [];
  const fd = openSync(spawnLog, "r");
  try {
    const buffer = Buffer.alloc(size - spawnLogOffset);
    readSync(fd, buffer, 0, buffer.length, spawnLogOffset);
    spawnLogOffset = size;
    return buffer
      .toString("utf8")
      .split("\n")
      .filter((line) => line.length > 0);
  } finally {
    closeSync(fd);
  }
}

async function processStats(pid) {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "rss=,time=", "-p", String(pid)], {
      encoding: "utf8",
    });
    const [rss, time] = stdout.trim().split(/\s+/u);
    return { rssKiB: Number(rss), cpuSeconds: parsePsTime(time ?? "") };
  } catch {
    return { rssKiB: null, cpuSeconds: null };
  }
}

async function openFds(pid) {
  if (process.platform === "linux") {
    try {
      return readdirSync(`/proc/${pid}/fd`).length;
    } catch {
      return null;
    }
  }
  try {
    const { stdout } = await execFileAsync("lsof", ["-p", String(pid), "-n", "-P"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return Math.max(0, stdout.split("\n").filter((line) => line.length > 0).length - 1);
  } catch {
    return null;
  }
}

async function probeHealth() {
  const startedAt = performance.now();
  try {
    const response = await fetch(`${daemonInfo.apiBaseUrl}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
    await response.json();
    recordObservation(interval.healthMs, performance.now() - startedAt);
  } catch {
    interval.healthFailures += 1;
    runFailures.health += 1;
  }
}

let sampleInFlight = null;
function takeSample() {
  if (sampleInFlight) return sampleInFlight;
  sampleInFlight = collectSample().finally(() => {
    sampleInFlight = null;
  });
  return sampleInFlight;
}

async function collectDiagnostics() {
  try {
    const response = await fetch(`${daemonInfo.apiBaseUrl}/api/diagnostics`, {
      headers: { Authorization: `Bearer ${daemonInfo.authToken}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      return parseSoakDiagnostics(null, response.status, daemonInfo);
    }
    const reader = response.body?.getReader();
    if (!reader) return { status: "missing", sample: null };
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > DIAGNOSTICS_MAX_BYTES) {
        await reader.cancel();
        return { status: "malformed", sample: null };
      }
      chunks.push(value);
    }
    return parseSoakDiagnostics(Buffer.concat(chunks).toString("utf8"), 200, daemonInfo);
  } catch {
    return { status: "transport-error", sample: null };
  }
}

async function collectSample() {
  const now = Date.now();
  const record = readDaemonRecord();
  if (!record) runFailures.daemonMissing += 1;
  if (record && (record.pid !== daemonInfo.pid || record.instanceId !== daemonInfo.instanceId)) {
    daemonRestarts += 1;
    log(
      `DAEMON RECORD CHANGED: pid ${daemonInfo.pid} → ${record.pid}, instance ${daemonInfo.instanceId} → ${record.instanceId}`,
    );
    // Keep original identity/PID pinned: replacement must never become the baseline.
  }
  await probeHealth();
  const [stats, fds, diagnostics] = await Promise.all([
    processStats(daemonInfo.pid),
    openFds(daemonInfo.pid),
    collectDiagnostics(),
  ]);
  const diagnosticDelta = diagnostics.sample
    ? diagnosticsDelta(previousDiagnostics, diagnostics.sample)
    : null;
  // A failed sample breaks adjacent-interval coverage; do not bridge telemetry holes.
  previousDiagnostics = diagnostics.sample;
  const spawnRecords = readNewSpawnRecords();
  const spawnsByCommand = countSpawnsByCommand(spawnRecords);
  const cpuDelta =
    stats.cpuSeconds === null || lastCpuSeconds === null ? null : stats.cpuSeconds - lastCpuSeconds;
  lastCpuSeconds = stats.cpuSeconds;
  const gaps = gapWarningsSinceSample;
  gapWarningsSinceSample = 0;
  const logCounts = { entries: logEntriesSinceSample, warnings: logWarningsSinceSample };
  logEntriesSinceSample = 0;
  logWarningsSinceSample = 0;
  const sample = {
    at: now,
    iso: new Date(now).toISOString(),
    elapsedSeconds: Math.round((now - soakStartedAt) / 1000),
    intervalSeconds: Math.round((now - lastSampleAt) / 1000),
    rssKiB: stats.rssKiB,
    heapUsedBytes: diagnostics.sample?.memory.heapUsed ?? null,
    diagnostics,
    diagnosticDelta,
    cpuSeconds: stats.cpuSeconds,
    cpuDeltaSeconds: cpuDelta,
    openFds: fds,
    tmuxSpawns: spawnRecords.length,
    tmuxSpawnsByCommand: spawnsByCommand,
    pingRttMs: percentiles(interval.pings),
    receiptLatencyMs: percentiles(interval.receipts),
    receiptFailures: interval.receiptFailures,
    observerGapWarnings: gaps + interval.journalGaps,
    observerGapWarningsFromLog: gaps,
    logEntries: logCounts.entries,
    logWarnings: logCounts.warnings,
    logTailReconnects,
    logTailBookmarks,
    journalGapFrames: interval.journalGaps,
    daemonRestarts,
    daemonExited,
    unexpectedDisconnects: interval.unexpectedDisconnects,
    scheduledReconnects: interval.scheduledReconnects,
    reconnectToReadyMs: percentiles(interval.reconnectToReadyMs),
    wsFrames: interval.wsFrames,
    flips: interval.flips,
    flipFailures: interval.flipFailures,
    promotions: interval.promotions,
    promotionFailures: interval.promotionFailures,
    sendBursts: interval.sendBursts,
    sendKeys: interval.sendKeys,
    sendFailures: interval.sendFailures,
    healthMs: percentiles(interval.healthMs),
    healthFailures: interval.healthFailures,
  };
  lastSampleAt = now;
  resetInterval();
  samples.push(sample);
  appendFileSync(samplesPath, `${JSON.stringify(sample)}\n`);
  const rssMiB = sample.rssKiB === null ? "n/a" : (sample.rssKiB / 1024).toFixed(1);
  log(
    `t+${sample.elapsedSeconds}s rss ${rssMiB} MiB cpu +${cpuDelta === null ? "n/a" : cpuDelta.toFixed(2)}s fds ${fds ?? "n/a"} spawns ${sample.tmuxSpawns} ` +
      `ping p50 ${sample.pingRttMs.p50?.toFixed(2) ?? "n/a"}/max ${sample.pingRttMs.max?.toFixed(1) ?? "n/a"} ` +
      `receipt p50 ${sample.receiptLatencyMs.p50 ?? "n/a"}/max ${sample.receiptLatencyMs.max ?? "n/a"} (n ${sample.receiptLatencyMs.count}, fail ${sample.receiptFailures}) ` +
      `gaps ${sample.observerGapWarnings} log ${sample.logEntries}/${sample.logWarnings}w flips ${sample.flips} promos ${sample.promotions.length}/${sample.promotionFailures} drops ${sample.unexpectedDisconnects} restarts ${daemonRestarts}`,
  );
}

async function samplerLoop() {
  while (!stopping) {
    await sleep(ms.sample);
    if (stopping) break;
    try {
      await takeSample();
    } catch (error) {
      sampleFailures += 1;
      runFailures.sample += 1;
      log(`sample failed: ${String(error).slice(0, 200)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Teardown.
// ---------------------------------------------------------------------------

let cleanedUp = false;
const cleanupOutcome = { serverStopped: false, rootRemoved: false };
let sentinelVerified = false;
async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  stopping = true;
  events.stop();
  logTailAbort?.abort();
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  await stopDaemon();
  daemonLogStream.end();
  try {
    execFileSync(realTmux, ["-S", socketPath, "kill-server"], { stdio: "ignore" });
  } catch {
    // server already gone
  }
  try {
    tmux(["list-sessions"]);
  } catch {
    cleanupOutcome.serverStopped = true;
  }
  rmSync(tmuxTmpDir, { recursive: true, force: true });
  if (!config.keepRoot) rmSync(root, { recursive: true, force: true });
  cleanupOutcome.rootRemoved = config.keepRoot || !existsSync(root);
}

async function finish(reason) {
  if (stopping) return;
  stopping = true;
  for (const wake of sleeps) wake();
  log(`stopping (${reason})`);
  if (sampleInFlight)
    await sampleInFlight.catch(() => {
      sampleFailures += 1;
    });
  const observedSeconds = (Date.now() - soakStartedAt) / 1000;
  const logCoverageComplete =
    logConnected &&
    logTailBookmarks > 0 &&
    logTailReconnects === 0 &&
    logGapFrames === 0 &&
    logMalformedFrames === 0;
  // Stop the daemon before writing the summary so its exit (D3: clean SIGTERM
  // shutdown) is part of the record.
  events.stop();
  logTailAbort?.abort();
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  await Promise.allSettled(loops);
  try {
    await takeSample();
  } catch {
    sampleFailures += 1;
    runFailures.sample += 1;
  }
  const stopRequestedAt = Date.now();
  await stopDaemon();
  const recordRetired = readDaemonRecord() === null;
  await cleanup();
  const cliEndSha256 = cliHash();
  if (cliEndSha256 !== cliStartSha256) runFailures.artifactChanged += 1;
  const evidence = {
    requestedSeconds: ms.duration / 1000,
    observedSeconds,
    completed: reason === "duration elapsed",
    failures: runFailures,
    loadCompleted: Object.values(runLoads).every((count) => count > 0),
    telemetryComplete:
      droppedObservations === 0 &&
      sampleFailures === 0 &&
      samples.length >= Math.floor(ms.duration / ms.sample) &&
      samples.every(
        (sample, index) => index === 0 || sample.intervalSeconds <= (ms.sample / 1000) * 1.5,
      ),
    logCoverageComplete,
    reconnectAttempts: ackAttempts,
    reconnectAcknowledged: ackSuccesses,
    shutdownClean:
      daemonExited?.code === 0 &&
      daemonExited.signal === null &&
      daemonExited.at >= stopRequestedAt &&
      daemonExited.at - stopRequestedAt <= 15_000,
    recordRetired,
    cleanupComplete: cleanupOutcome.serverStopped && cleanupOutcome.rootRemoved,
    resourceTrendPolicyComplete: false,
    warmupSeconds: ms.warmup / 1000,
    trailingSeconds: ms.trailing / 1000,
  };
  const result = evaluateSoak(samples, config.thresholds, evidence);
  const summary = {
    evidence,
    runLoads,
    droppedObservations,
    cleanup: cleanupOutcome,
    qualificationScope: "measured harness checks only; full daemon readiness remains incomplete",
    unsupportedEvidence: [
      "heap/resource/CPU/spawn trend acceptance policy awaiting calibration and review",
      "runtime resource types are not an application-owned retained-resource census",
      "CPU/spawn slopes descriptive; acceptance policy not yet declared",
    ],
    trends: soakTrends(samples, evidence.warmupSeconds, evidence.trailingSeconds),
    latencyMethod:
      "WebSocket transport control ping/pong (not semantic handler latency), unique echoed payload; merged log histogram p50 upper bound (<=5% or 1ms below overflow bucket, overflow uses observed max), exact max",
    logCoverage: {
      logTailReconnects,
      logTailBookmarks,
      logGapFrames,
      logMalformedFrames,
      lastLogFrameAt,
      recentConnections: logConnections,
    },
    artifact: {
      cli: cliPath,
      startSha256: cliStartSha256,
      endSha256: cliEndSha256,
      harnessSha256,
      package: cliPackage,
      socketPath,
      sentinelVerified,
    },
    harness: "packages/daemon/scripts/soak-daemon.mjs",
    startedAt: startedAtWall.toISOString(),
    finishedAt: new Date().toISOString(),
    reason,
    command: process.argv.slice(1).join(" "),
    config: { ...config, resolvedMs: ms },
    daemon: {
      pid: daemonInfo?.pid ?? null,
      instanceId: daemonInfo?.instanceId ?? null,
      productVersion: daemonInfo?.productVersion ?? null,
      protocolVersion: daemonInfo?.protocolVersion ?? null,
      exited: daemonExited,
      stopMs: daemonExited ? daemonExited.at - stopRequestedAt : null,
    },
    tmux: {
      binary: realTmux,
      version: execFileSync(realTmux, ["-V"], { encoding: "utf8" }).trim(),
    },
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    gapWarningsTotal,
    artifacts: {
      samples: samplesPath,
      daemonLog: daemonLogPath,
      daemonEntries: daemonEntriesPath,
      spawnLog,
    },
    verdict: result.verdict,
    checks: result.checks,
    summary: result.summary,
  };
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`\n${formatSoakReport(result)}\n\nartifacts: ${outDir}\n`);
  await cleanup();
  process.exit(result.verdict === "pass" ? 0 : result.verdict === "fail" ? 1 : 2);
}

process.on("SIGINT", () => void finish("SIGINT"));
process.on("SIGTERM", () => void finish("SIGTERM"));

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

try {
  log(`root ${root}`);
  log(`artifacts ${outDir}`);
  tmux([
    "-f",
    "/dev/null",
    "new-session",
    "-d",
    "-x",
    "220",
    "-y",
    "60",
    "-s",
    `${config.sessionPrefix}keeper`,
    "-c",
    dirs.project,
    "exec sleep 2147483",
  ]);
  log(
    `private tmux server ${socketPath} (${execFileSync(realTmux, ["-V"], { encoding: "utf8" }).trim()})`,
  );

  const ready = await startDaemon();
  const record = readDaemonRecord();
  if (!record || record.pid !== ready.pid)
    throw new Error("daemon.json does not match the ready line");
  daemonInfo = { ...record, apiBaseUrl: ready.apiBaseUrl };
  log(
    `daemon pid ${record.pid} port ${record.port} instance ${record.instanceId} version ${record.productVersion}`,
  );
  void tailDaemonLogs();
  await sleep(3_000);

  createFleet();
  const team = JSON.parse(
    execFileSync(process.execPath, [cliPath, "team", "--json"], {
      cwd: dirs.project,
      env: clientEnv,
      encoding: "utf8",
      timeout: 15_000,
    }),
  );
  const names = (team.projects ?? []).flatMap((project) =>
    (project.sessions ?? []).map((session) => session.name),
  );
  const daemonSessions = await fetch(`${daemonInfo.apiBaseUrl}/api/resources/fleet-catalog`, {
    headers: { Authorization: `Bearer ${daemonInfo.authToken}` },
    signal: AbortSignal.timeout(5_000),
  }).then((response) => response.json());
  const sentinel = sessions[0].name;
  writeFileSync(
    join(outDir, "sentinel.json"),
    JSON.stringify({ expected: sentinel, team: names, daemon: daemonSessions }, null, 2),
  );
  if (!names.includes(sentinel) || !JSON.stringify(daemonSessions).includes(`"${sentinel}"`))
    throw new Error("daemon/CLI private sentinel mismatch");
  sentinelVerified = true;
  log(
    `fleet: ${config.sessions} sessions × ${config.panes} panes (${sessions.map((s) => s.name).join(", ")})`,
  );

  soakStartedAt = Date.now();
  lastSampleAt = soakStartedAt;
  lastCpuSeconds = (await processStats(daemonInfo.pid)).cpuSeconds;
  readNewSpawnRecords(); // discard setup-time spawns
  gapWarningsSinceSample = 0;
  gapWarningsTotal = 0;
  logEntriesSinceSample = 0;
  logWarningsSinceSample = 0;

  events.connect();
  loops = [
    flipLoop(),
    receiptWaiterLoop(),
    promotionLoop(),
    sendBurstLoop(),
    reconnectLoop(),
    samplerLoop(),
  ];
  for (const loop of loops)
    void loop.catch((error) => {
      runFailures.loop += 1;
      log(`loop failed: ${String(error).slice(0, 300)}`);
    });
  log(
    `churn: flip ${config.flipInterval}, promote ${config.promoteInterval}, reconnect ${config.reconnectInterval}, wait ${config.waitInterval}, ` +
      `send-keys ${config.sendBurstCount}×/${config.sendBurstInterval}, sample ${config.sampleInterval}, duration ${config.duration}`,
  );
  await sleep(ms.duration);
  await finish("duration elapsed");
} catch (error) {
  console.error(
    `soak failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  await cleanup();
  writeFileSync(
    summaryPath,
    `${JSON.stringify({ verdict: "inconclusive", reason: "setup-or-harness-error", error: boundedError(error), cleanup: cleanupOutcome, cli: cliPath, startSha256: cliStartSha256 }, null, 2)}\n`,
  );
  process.exit(2);
}
