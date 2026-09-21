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
 *   1. Creates a private tmux server (`-S <tmp>/tmux.sock -f /dev/null`) and a
 *      temporary TMUX_IDE_HOME / daemon record dir / registry / settings dir.
 *      Nothing touches the user's tmux server, daemon or ~/.tmux-ide.
 *   2. Starts the BUILT daemon the installed way: `node bin/cli.js --headless
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
 *      delta (`ps`; the daemon has no heap diagnostics endpoint, so heap is
 *      null), open fds (`lsof` / `/proc`), tmux spawns in the interval by
 *      command word, ping RTT and receipt-latency p50/max, observer gap
 *      warnings (tailed from the daemon's `/api/logs/daemon` SSE stream; in
 *      headless mode structured logs live only in that ring buffer), restarts
 *      and failures.
 *   5. At `--duration` (or SIGINT) it evaluates the series with
 *      `src/lib/soak-verdict.ts` (unit-tested), prints a summary, writes
 *      `summary.json`, tears everything down and exits 1 on FAIL.
 *
 * Session names use the `soak-` prefix rather than `zz-`: the fleet read that
 * `wait agent-status` uses filters `zz-` sessions as development scratch, so a
 * waiter could never resolve against them. Isolation comes from the private
 * socket, not the name.
 */

/* global fetch, AbortController, AbortSignal, TextDecoder */

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
} from "../src/lib/soak-verdict.ts";

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");
const cliPath = join(repoRoot, "bin/cli.js");

// ---------------------------------------------------------------------------
// Configuration: defaults < --config JSON < CLI flags.
// ---------------------------------------------------------------------------

const DEFAULTS = {
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
const ms = {
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

if (!existsSync(cliPath)) {
  console.error(`Built CLI not found at ${cliPath}; run \`pnpm build\` first.`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Private environment.
// ---------------------------------------------------------------------------

const startedAtWall = new Date();
const root = mkdtempSync(join(tmpdir(), "tmux-ide-soak-"));
const outDir = resolve(config.out ?? join(root, "artifacts"));
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
const socketPath = join(root, "tmux.sock");
const shimPath = join(dirs.shim, "tmux");
const spawnLog = join(outDir, "spawns.log");
const samplesPath = join(outDir, "samples.jsonl");
const summaryPath = join(outDir, "summary.json");
const daemonLogPath = join(outDir, "daemon.log");
const daemonEntriesPath = join(outDir, "daemon-entries.jsonl");
const realTmux = realpathSync(execFileSync("which", ["tmux"], { encoding: "utf8" }).trim());

writeFileSync(spawnLog, "");
writeFileSync(
  shimPath,
  [
    "#!/bin/sh",
    `LOG=${JSON.stringify(spawnLog)}`,
    'line=""; for a in "$@"; do line="$line$a\x01"; done',
    'printf "%s\\n" "$line" >> "$LOG"',
    `exec ${JSON.stringify(realTmux)} "$@"`,
    "",
  ].join("\n"),
);
chmodSync(shimPath, 0o755);

const baseEnv = { ...process.env };
delete baseEnv.TMUX_IDE_SESSION;
delete baseEnv.TMUX_IDE_TMUX_BIN;
Object.assign(baseEnv, {
  HOME: dirs.home,
  NO_COLOR: "1",
  TMUX: `${socketPath},${process.pid},0`,
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
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).replace(/(?:\r?\n)+$/u, "");
const tmuxAsync = async (argv) => {
  const { stdout } = await execFileAsync(realTmux, ["-S", socketPath, ...argv], {
    cwd: root,
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
let daemonRestarts = 0;
let daemonExited = null;
let stopping = false;
const children = new Set();

// ---------------------------------------------------------------------------
// Daemon lifecycle.
// ---------------------------------------------------------------------------

let daemon = null;
let daemonInfo = null;
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
// Backfill on reconnect is de-duplicated by entry identity.
// ---------------------------------------------------------------------------

const GAP_MESSAGE = "Interaction observation gap";
const seenLogKeys = new Set();
const seenLogOrder = [];
let logTailAbort = null;
let logEntriesSinceSample = 0;
let logWarningsSinceSample = 0;
let logTailReconnects = 0;
let logTailBookmarks = 0;

function noteLogEntry(entry) {
  const key = `${entry.ts} ${entry.component} ${entry.msg} ${JSON.stringify(entry.data ?? null)}`;
  if (seenLogKeys.has(key)) return;
  seenLogKeys.add(key);
  seenLogOrder.push(key);
  while (seenLogOrder.length > 4_000) seenLogKeys.delete(seenLogOrder.shift());
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
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          let event = "message";
          const dataLines = [];
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
          }
          if (event === "bookmark") logTailBookmarks += 1;
          if (event !== "entry" || dataLines.length === 0) continue;
          try {
            noteLogEntry(JSON.parse(dataLines.join("\n")));
          } catch {
            // malformed frame; skip
          }
        }
      }
    } catch (error) {
      if (!stopping && !controller.signal.aborted)
        log(`log tail dropped: ${String(error).slice(0, 120)}`);
    }
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
    while (!daemonExited) await sleep(50);
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
    } catch {
      interval.flipFailures += 1;
    }
    await sleep(ms.flip);
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
      await sleep(ms.wait);
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
      await Promise.all(target.panes.map((paneId) => stamp(paneId, "done")));
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
      interval.receipts.push(result.at - flippedAt);
    } else if (stopping) {
      // Teardown killed the waiter; not a daemon failure.
    } else {
      interval.receiptFailures += 1;
      log(
        `receipt waiter failed: code ${result.code} total ${result.at - spawnedAt}ms flipped ${flippedAt === null ? "never" : `${result.at - flippedAt}ms before exit`} ${stderr.trim().slice(0, 200)}`,
      );
    }
    await sleep(ms.wait);
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
      interval.promotions.push({ session: session.name, ms: Math.round(elapsedMs), outcome });
    } else {
      interval.promotionFailures += 1;
      log(
        `promotion of ${session.name} failed: HTTP ${response.status} ${JSON.stringify(envelope).slice(0, 200)}`,
      );
    }
  } catch (error) {
    interval.promotionFailures += 1;
    log(`promotion of ${session.name} threw: ${String(error).slice(0, 200)}`);
  }
}

async function promotionLoop() {
  let cursor = 0;
  await sleep(10_000);
  while (!stopping) {
    await promoteOnce(sessions[cursor % sessions.length]);
    cursor += 1;
    await sleep(ms.promote);
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
      } catch {
        interval.sendFailures += 1;
      }
    }
    interval.sendBursts += 1;
    await sleep(ms.sendBurst);
  }
}

// ---------------------------------------------------------------------------
// Events client: hello → subscribe → interests-ack, then one ping in flight.
// ---------------------------------------------------------------------------

class EventsClient {
  socket = null;
  ready = false;
  scheduledClose = false;
  pingWaiter = null;
  pingTimer = null;
  reconnectTimer = null;
  connectedAt = 0;

  connect() {
    const url = `${daemonInfo.apiBaseUrl.replace(/^http/u, "ws")}/ws/events`;
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${daemonInfo.authToken}` },
    });
    this.socket = socket;
    this.ready = false;
    this.connectedAt = performance.now();
    socket.on("message", (data) => this.onMessage(data));
    socket.on("error", (error) => {
      if (!stopping) log(`events client error: ${String(error).slice(0, 200)}`);
    });
    socket.on("close", () => this.onClose(socket));
  }

  onMessage(data) {
    let frame;
    try {
      frame = JSON.parse(String(data));
    } catch {
      return;
    }
    interval.wsFrames[frame.type] = (interval.wsFrames[frame.type] ?? 0) + 1;
    if (frame.type === "pong") {
      if (this.pingWaiter) {
        const waiter = this.pingWaiter;
        this.pingWaiter = null;
        waiter();
      }
      return;
    }
    if (frame.type === "hello") {
      this.socket.send(
        JSON.stringify({
          type: "subscribe",
          sessions: [],
          legacyEvents: true,
          interests: [{ resource: "fleet-catalog", workspaceName: null }],
          interestRevision: 1,
        }),
      );
      return;
    }
    if (frame.type === "resource.interests-ack" && !this.ready) {
      this.ready = true;
      interval.reconnectToReadyMs.push(performance.now() - this.connectedAt);
      this.startPinging();
      return;
    }
    if (frame.type === "snapshot-required") {
      interval.journalGaps += 1;
      log(`events client received snapshot-required (${frame.reason})`);
    }
  }

  startPinging() {
    const socket = this.socket;
    const loop = async () => {
      while (!stopping && this.socket === socket && socket.readyState === WebSocket.OPEN) {
        const sentAt = performance.now();
        const pong = new Promise((resolvePong) => {
          this.pingWaiter = resolvePong;
        });
        const timeout = sleep(10_000).then(() => "timeout");
        try {
          socket.send(JSON.stringify({ type: "ping" }));
        } catch {
          break;
        }
        const outcome = await Promise.race([pong, timeout]);
        if (outcome === "timeout") {
          this.pingWaiter = null;
          log("ping round-trip exceeded 10s");
          interval.pings.push(10_000);
        } else {
          interval.pings.push(performance.now() - sentAt);
        }
        await sleep(ms.ping);
      }
    };
    void loop();
  }

  onClose(socket) {
    if (this.socket !== socket) return;
    this.socket = null;
    this.ready = false;
    this.pingWaiter = null;
    if (stopping) return;
    if (this.scheduledClose) {
      this.scheduledClose = false;
      this.connect();
    } else {
      interval.unexpectedDisconnects += 1;
      log("events client dropped unexpectedly; reconnecting in 1s");
      this.reconnectTimer = setTimeout(() => this.connect(), 1_000);
    }
  }

  scheduledReconnect() {
    if (!this.socket) return;
    interval.scheduledReconnects += 1;
    this.scheduledClose = true;
    this.socket.close();
  }

  stop() {
    clearTimeout(this.reconnectTimer);
    this.scheduledClose = true;
    try {
      this.socket?.close();
    } catch {
      // gone
    }
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
    interval.healthMs.push(performance.now() - startedAt);
  } catch {
    interval.healthFailures += 1;
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

async function collectSample() {
  const now = Date.now();
  const record = readDaemonRecord();
  if (record && (record.pid !== daemonInfo.pid || record.instanceId !== daemonInfo.instanceId)) {
    daemonRestarts += 1;
    log(
      `DAEMON RECORD CHANGED: pid ${daemonInfo.pid} → ${record.pid}, instance ${daemonInfo.instanceId} → ${record.instanceId}`,
    );
    daemonInfo = { ...daemonInfo, pid: record.pid, instanceId: record.instanceId };
  }
  await probeHealth();
  const [stats, fds] = await Promise.all([processStats(daemonInfo.pid), openFds(daemonInfo.pid)]);
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
    heapUsedBytes: null,
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
      log(`sample failed: ${String(error).slice(0, 200)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Teardown.
// ---------------------------------------------------------------------------

let cleanedUp = false;
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
  if (!config.keepRoot) rmSync(root, { recursive: true, force: true });
}

async function finish(reason) {
  if (stopping) return;
  stopping = true;
  log(`stopping (${reason})`);
  // A final partial-interval sample only when at least half an interval elapsed
  // and the sampler is not already taking one.
  if (sampleInFlight) {
    await sampleInFlight.catch(() => undefined);
  } else if (Date.now() - lastSampleAt >= ms.sample / 2) {
    try {
      await takeSample();
    } catch (error) {
      log(`final sample failed: ${String(error).slice(0, 200)}`);
    }
  }
  const result = evaluateSoak(samples, config.thresholds);
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
  const stopRequestedAt = Date.now();
  await stopDaemon();
  const summary = {
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
  process.exit(result.verdict === "fail" ? 1 : 0);
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
  const loops = [
    flipLoop(),
    receiptWaiterLoop(),
    promotionLoop(),
    sendBurstLoop(),
    reconnectLoop(),
    samplerLoop(),
  ];
  for (const loop of loops)
    void loop.catch((error) => log(`loop failed: ${String(error).slice(0, 300)}`));
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
  process.exit(2);
}
