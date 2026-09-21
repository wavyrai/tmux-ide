#!/usr/bin/env node
/**
 * Installed-artifact latency and fairness qualification.
 *
 * Builds and packs the release tarball the way `pnpm pack` produces it,
 * installs it into a private npm prefix, runs the INSTALLED `tmux-ide
 * --headless` daemon against a private tmux server under a temporary state
 * root, and measures on that daemon:
 *
 *   a. agent status latency — stamp flip → `agent.turn-completed` receipt on a
 *      sole `/ws/events` client, and stamp flip → the installed
 *      `tmux-ide wait agent-status … --status done` process exiting;
 *   b. fairness — an events client's ping round-trip while a 16-pane session
 *      is promoted, and while eight stamped panes flip status every 200 ms;
 *   c. idle cost — tmux child spawns per minute (counted by a PATH shim the
 *      daemon resolves `tmux` through) and daemon CPU seconds over a window
 *      with no clients and with one idle subscriber.
 *
 * Emits one JSON document on stdout (and to `--out <file>` when given). The
 * thresholds are advisory unless `--assert` is passed: they bound the
 * watcher cadence (2 s ticks) and the source-level results this stage
 * qualifies, not a tight SLO.
 *
 * Every tmux session lives on a private socket under a private TMUX_TMPDIR
 * (measured sessions are `qual-` named because the CLI filters `zz-` names as
 * internal); nothing touches the caller's tmux, daemon or ~/.tmux-ide.
 *
 *   node packages/daemon/scripts/qualify-installed-latency.mjs [--runs 5]
 *     [--idle-seconds 180] [--storm-seconds 10] [--tarball <path>] [--out <file>]
 *     [--assert]
 */
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WebSocket } from "ws";

import {
  capturePackedInstallEnvironment,
  privatePackedInstallEnvironment,
} from "../../../scripts/lib/packed-install-environment.mjs";

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
  return value;
};
const RUNS = Number(option("runs", "5"));
const IDLE_SECONDS = Number(option("idle-seconds", "180"));
const STORM_SECONDS = Number(option("storm-seconds", "10"));
const EXISTING_TARBALL = option("tarball", null);
const OUT_PATH = option("out", null);
const ASSERT = args.includes("--assert");
if (!Number.isInteger(RUNS) || RUNS < 1) throw new Error("--runs must be a positive integer");

/** The daemon fleet-facts observer samples agent stamps on this cadence. */
const OBSERVER_TICK_MS = 2_000;

/** Advisory bounds (enforced only with --assert). */
const THRESHOLDS = {
  // Two watcher ticks; beyond that the push path regressed to poll-shaped.
  receiptLatencyMaxMs: 5_000,
  // Receipt path + aggregate re-read + process exit; generous over the receipt bound.
  waitCliLatencyMaxMs: 8_000,
  // Source-level bound is 100 ms in-process; the installed bundle over loopback gets headroom.
  promotionPingMaxMs: 250,
  stormPingMaxMs: 250,
  // Source-level: 0.1/s with no clients, 1.05/s with one legacy subscriber.
  idleSpawnsPerMinuteNoClients: 20,
  idleSpawnsPerMinuteOneSubscriber: 80,
};

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------
const repoRoot = realpathSync(fileURLToPath(new URL("../../..", import.meta.url)));
const tmpRoot = mkdtempSync(join(tmpdir(), "tmux-ide-qual-latency-"));
// tmux's AF_UNIX path ceiling is ~104 bytes on macOS; keep the socket root short.
const tmuxTmpDir = mkdtempSync("/tmp/tiq-");
chmodSync(tmuxTmpDir, 0o700);
const tarballDir = join(tmpRoot, "tarballs");
const projectDir = join(tmpRoot, "project");
const homeDir = join(tmpRoot, "home");
const stateHome = join(homeDir, ".tmux-ide");
const shimDir = join(tmpRoot, "shim");
const shimPath = join(shimDir, "tmux");
const spawnLog = join(tmpRoot, "spawns.log");
// The private server sits at the DEFAULT socket location under the private
// TMUX_TMPDIR. The daemon honours TMUX_IDE_TMUX_SOCKET_PATH (set to the same
// path), but the installed CLI's session reads (`wait`, `team`) address the
// default socket outside development mode, so the two must coincide.
const socketDir = join(tmuxTmpDir, `tmux-${process.getuid()}`);
const socketPath = join(socketDir, "default");
for (const dir of [tarballDir, projectDir, homeDir, stateHome, shimDir, socketDir]) {
  mkdirSync(dir, { recursive: true });
}
chmodSync(stateHome, 0o700);
chmodSync(socketDir, 0o700);

const realTmux = realpathSync(
  execFileSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).trim(),
);
const nodeDir = dirname(process.execPath);
writeFileSync(
  shimPath,
  [
    "#!/bin/sh",
    `LOG=${JSON.stringify(spawnLog)}`,
    // One record per spawn; a raw 0x01 byte separates arguments.
    'line=""; for a in "$@"; do line="$line$a\x01"; done',
    'printf "%s\\n" "$line" >> "$LOG"',
    `exec ${JSON.stringify(realTmux)} "$@"`,
    "",
  ].join("\n"),
);
chmodSync(shimPath, 0o755);
writeFileSync(spawnLog, "");

const capturedEnvironment = capturePackedInstallEnvironment(process.env);
const privateEnvironment = privatePackedInstallEnvironment(capturedEnvironment, {
  home: homeDir,
  cache: join(tmpRoot, "npm-cache"),
});
/** Environment for every installed-CLI process: private HOME/state, private tmux, shimmed PATH. */
const installedEnvironment = (extraPathEntries = []) => ({
  ...privateEnvironment,
  HOME: homeDir,
  TMUX: "",
  TMUX_TMPDIR: tmuxTmpDir,
  TMUX_IDE_TMUX_SOCKET_PATH: socketPath,
  TMUX_IDE_HOME: stateHome,
  TMUX_IDE_TMUX_BIN: shimPath,
  NODE_PATH: "",
  NODE_OPTIONS: "",
  BUN_INSTALL: "",
  PATH: [shimDir, ...extraPathEntries, nodeDir, dirname(realTmux), "/usr/bin", "/bin"]
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .join(":"),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const tmux = (argv) =>
  execFileSync(realTmux, ["-S", socketPath, ...argv], {
    cwd: tmpRoot,
    encoding: "utf8",
    env: { ...installedEnvironment(), TMUX_TMPDIR: tmuxTmpDir },
    stdio: ["ignore", "pipe", "pipe"],
  }).replace(/(?:\r?\n)+$/u, "");
const tmuxAsync = (argv) =>
  execFileAsync(realTmux, ["-S", socketPath, ...argv], {
    cwd: tmpRoot,
    encoding: "utf8",
    env: { ...installedEnvironment(), TMUX_TMPDIR: tmuxTmpDir },
  });
const runSync = (file, argv, options = {}) => {
  const result = spawnSync(file, argv, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${file} ${argv.join(" ")} exited ${result.status}:\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
};
const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const stats = (values) => {
  if (values.length === 0) return { n: 0, median: null, max: null, min: null, p95: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const round = (v) => Number(v.toFixed(2));
  return {
    n: sorted.length,
    median: round(median),
    max: round(sorted[sorted.length - 1]),
    min: round(sorted[0]),
    p95: round(at(0.95)),
  };
};
const nowStamp = () => Math.floor(Date.now() / 1000);
const fleetSessionIdForName = (name) =>
  `session.${createHash("sha256").update(name).digest("hex").slice(0, 20)}`;

/** Parse `ps -o time=` output (`[[hh:]mm:]ss[.cc]`) into seconds. */
const parsePsTime = (text) => {
  const parts = text.trim().split(":").map(Number);
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return seconds;
};
const daemonCpuSeconds = (pid) =>
  parsePsTime(execFileSync("ps", ["-p", String(pid), "-o", "time="], { encoding: "utf8" }));

/** Tmux spawn counts by top-level command since the log was last reset. */
const readSpawns = () => {
  let raw;
  try {
    raw = readFileSync(spawnLog, "utf8");
  } catch {
    return {};
  }
  const counts = {};
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const words = line.split("");
    let index = 0;
    while (index < words.length && words[index].startsWith("-")) {
      index += words[index] === "-u" || words[index] === "-C" ? 1 : 2;
    }
    const command = words[index] ?? "(none)";
    counts[command] = (counts[command] ?? 0) + 1;
  }
  return counts;
};
const resetSpawns = () => writeFileSync(spawnLog, "");
const totalSpawns = (bySource) => Object.values(bySource).reduce((sum, n) => sum + n, 0);

// ---------------------------------------------------------------------------
// Events client
// ---------------------------------------------------------------------------
class EventsClient {
  constructor(url, token) {
    this.frames = [];
    this.waiters = new Set();
    this.socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    this.closed = new Promise((resolve) => this.socket.once("close", () => resolve()));
    this.socket.on("message", (data) => {
      let frame;
      try {
        frame = JSON.parse(String(data));
      } catch {
        return;
      }
      frame.receivedAt = performance.now();
      this.frames.push(frame);
      for (const notify of [...this.waiters]) notify();
    });
    this.socket.on("error", () => undefined);
  }
  async open(timeoutMs = 10_000) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("events socket open timed out")), timeoutMs);
      this.socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    await this.waitFor((frame) => frame.type === "hello", timeoutMs);
  }
  /** Subscribe the way a fleet TUI does: legacy agent events plus the fleet catalog. */
  async subscribeFleet(revision = 1, timeoutMs = 10_000) {
    this.socket.send(
      JSON.stringify({
        type: "subscribe",
        sessions: [],
        legacyEvents: true,
        interests: [{ resource: "fleet-catalog", workspaceName: null }],
        interestRevision: revision,
      }),
    );
    await this.waitFor(
      (frame) => frame.type === "resource.interests-ack" && frame.interestRevision === revision,
      timeoutMs,
    );
  }
  waitFor(predicate, timeoutMs, fromIndex = 0) {
    return new Promise((resolve, reject) => {
      const check = () => {
        const found = this.frames.slice(fromIndex).find(predicate);
        if (!found) return;
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve(found);
      };
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for frame`));
      }, timeoutMs);
      this.waiters.add(check);
      check();
    });
  }
  async ping(timeoutMs = 30_000) {
    const from = this.frames.length;
    const sentAt = performance.now();
    this.socket.send(JSON.stringify({ type: "ping" }));
    await this.waitFor((frame) => frame.type === "pong", timeoutMs, from);
    return performance.now() - sentAt;
  }
  /** Loop ping → pong with one probe in flight until stopped; returns the round-trips. */
  startPingLoop(gapMs = 2) {
    const roundTrips = [];
    let running = true;
    const done = (async () => {
      while (running) {
        roundTrips.push(await this.ping());
        await sleep(gapMs);
      }
    })();
    return {
      roundTrips,
      stop: async () => {
        running = false;
        await done;
      },
    };
  }
  async close() {
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    )
      this.socket.close();
    await Promise.race([this.closed, sleep(2_000)]);
  }
}

// ---------------------------------------------------------------------------
// Cleanup (always runs)
// ---------------------------------------------------------------------------
const cleanup = { daemonExited: null, tmuxServerGone: null, tmpRemoved: null };

let daemonPid = null;
const daemonOutput = [];
const openClients = new Set();
let cleaned = false;
async function cleanUp() {
  if (cleaned) return;
  cleaned = true;
  for (const client of openClients) await client.close().catch(() => undefined);
  if (daemonPid) {
    const alive = () => {
      try {
        process.kill(daemonPid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      process.kill(daemonPid, "SIGTERM");
    } catch {
      /* already gone */
    }
    const deadline = Date.now() + 8_000;
    while (alive() && Date.now() < deadline) await sleep(100);
    if (alive()) {
      try {
        process.kill(daemonPid, "SIGKILL");
      } catch {
        /* gone between checks */
      }
      await sleep(300);
    }
    cleanup.daemonExited = !alive();
  }
  spawnSync(realTmux, ["-S", socketPath, "kill-server"], { stdio: "ignore" });
  const socketDeadline = Date.now() + 5_000;
  while (existsSync(socketPath) && Date.now() < socketDeadline) await sleep(100);
  // Processes still naming our private socket after kill-server are the
  // daemon's own tmux clients (nothing else knows the path). Record them —
  // a client that outlives the daemon can resurrect the server — then retire
  // them and the server they may have recreated.
  const stragglers = listSocketProcesses();
  cleanup.stragglersAfterKillServer = stragglers;
  if (stragglers.length > 0) {
    for (const { pid } of stragglers) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
    await sleep(300);
    spawnSync(realTmux, ["-S", socketPath, "kill-server"], { stdio: "ignore" });
    const retryDeadline = Date.now() + 5_000;
    while (existsSync(socketPath) && Date.now() < retryDeadline) await sleep(100);
  }
  // tmux may leave the socket file behind after the server exits; the process
  // set is the authority, the file goes with the directory below.
  cleanup.tmuxServerGone = listSocketProcesses().length === 0;
  cleanup.socketFileRemained = existsSync(socketPath);
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(tmuxTmpDir, { recursive: true, force: true });
  cleanup.tmpRemoved = !existsSync(tmpRoot) && !existsSync(tmuxTmpDir);
}
/** Live processes whose command line names the private tmux socket. */
const listSocketProcesses = () => {
  const out = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout ?? "";
  return out
    .split("\n")
    .filter((line) => line.includes(socketPath))
    .map((line) => {
      const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
      return match ? { pid: Number(match[1]), command: match[2] } : null;
    })
    .filter(Boolean);
};
const cleanUpSync = () => {
  // Best effort on an abrupt exit: the async path cannot run here.
  if (daemonPid) {
    try {
      process.kill(daemonPid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  spawnSync(realTmux, ["-S", socketPath, "kill-server"], { stdio: "ignore" });
};
process.on("exit", cleanUpSync);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void cleanUp().finally(() => process.exit(130));
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const report = {
  ok: false,
  startedAt: new Date().toISOString(),
  parameters: { runs: RUNS, idleSeconds: IDLE_SECONDS, stormSeconds: STORM_SECONDS },
  thresholds: THRESHOLDS,
  artifact: {},
  scenarios: {},
  violations: [],
  cleanup,
};

try {
  // -- Artifact identity -----------------------------------------------------
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const commit = runSync("git", ["rev-parse", "HEAD"]).stdout.trim();
  const sourceState = runSync("git", [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]).stdout.trim();
  let tarball = EXISTING_TARBALL;
  if (!tarball) {
    process.stderr.write("[qualify] pnpm build:cli + pnpm pack\n");
    runSync("pnpm", ["build:cli"], { stdio: ["ignore", "ignore", "inherit"] });
    runSync("pnpm", ["pack", "--pack-destination", tarballDir], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    const name = readdirSync(tarballDir).find(
      (f) => f.startsWith("tmux-ide-") && f.endsWith(".tgz"),
    );
    if (!name) throw new Error("pnpm pack produced no tmux-ide-*.tgz");
    tarball = join(tarballDir, name);
  }
  report.artifact = {
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    commit,
    sourceState: sourceState ? "dirty" : "clean",
    dirtyPaths: sourceState ? sourceState.split("\n") : [],
    tarball: tarball.split("/").pop(),
    tarballSha256: sha256File(tarball),
    node: process.version,
    npm: runSync("npm", ["--version"]).stdout.trim(),
    tmux: runSync(realTmux, ["-V"]).stdout.trim(),
    platform: `${process.platform}-${process.arch}`,
  };

  // -- Install into a private prefix ----------------------------------------
  process.stderr.write("[qualify] npm install (private prefix)\n");
  runSync("npm", ["init", "-y"], { cwd: projectDir, env: privateEnvironment });
  runSync("npm", ["install", "--no-audit", "--no-fund", tarball], {
    cwd: projectDir,
    env: { ...privateEnvironment, PATH: process.env.PATH },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const installedCli = join(projectDir, "node_modules", ".bin", "tmux-ide");
  const versionStartedAt = performance.now();
  report.artifact.installedVersion = runSync(installedCli, ["--version"], {
    cwd: projectDir,
    env: installedEnvironment(),
  }).stdout.trim();
  report.artifact.cliVersionWallMs = Number((performance.now() - versionStartedAt).toFixed(1));

  // -- Private tmux server + installed headless daemon ----------------------
  tmux(["-f", "/dev/null", "new-session", "-d", "-s", "zz-qual-keeper", "exec sleep 7200"]);
  process.stderr.write("[qualify] starting installed headless daemon\n");
  const daemonChild = spawn(installedCli, ["--headless", "--json"], {
    cwd: projectDir,
    env: installedEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  daemonChild.stdout.on("data", (chunk) => daemonOutput.push(chunk.toString()));
  daemonChild.stderr.on("data", (chunk) => daemonOutput.push(chunk.toString()));
  const infoPath = join(stateHome, "daemon.json");
  const infoDeadline = Date.now() + 20_000;
  while (!existsSync(infoPath) && Date.now() < infoDeadline) await sleep(100);
  if (!existsSync(infoPath)) {
    throw new Error(`installed daemon wrote no daemon.json:\n${daemonOutput.join("")}`);
  }
  const info = JSON.parse(readFileSync(infoPath, "utf8"));
  daemonPid = info.pid;
  if (daemonPid !== daemonChild.pid) {
    throw new Error(`daemon.json pid ${daemonPid} is not the spawned CLI ${daemonChild.pid}`);
  }
  const host = info.bindHostname ?? "127.0.0.1";
  const apiBase = `http://${host}:${info.port}`;
  const wsUrl = `ws://${host}:${info.port}/ws/events`;
  const token = info.authToken;
  const health = await fetch(`${apiBase}/health`);
  if (!health.ok) throw new Error(`health returned ${health.status}`);
  report.artifact.daemon = {
    pid: daemonPid,
    port: info.port,
    productVersion: info.productVersion,
    protocolVersion: info.protocolVersion,
    launcher: info.launcher ?? null,
  };
  // Let startup work (hook install, registry load, catalog priming) settle.
  await sleep(3_000);

  const newClient = async () => {
    const client = new EventsClient(wsUrl, token);
    openClients.add(client);
    await client.open();
    return client;
  };
  const dropClient = async (client) => {
    await client.close();
    openClients.delete(client);
  };
  const stampedSession = (name, panes) => {
    const paneIds = [];
    const first = tmux([
      "new-session",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-s",
      name,
      "-c",
      projectDir,
      "-n",
      "agent",
      "exec sleep 7200",
    ]);
    paneIds.push(first);
    for (let i = 1; i < panes; i += 1) {
      paneIds.push(
        tmux([
          "split-window",
          "-d",
          "-P",
          "-F",
          "#{pane_id}",
          "-t",
          `${name}:0`,
          "-c",
          projectDir,
          "exec sleep 7200",
        ]),
      );
      tmux(["select-layout", "-t", `${name}:0`, "tiled"]);
    }
    for (const paneId of paneIds) {
      const stamp = `pane.qual.${randomUUID().replace(/-/gu, "").slice(0, 20)}`;
      tmux(["set-option", "-p", "-t", paneId, "@tmux_ide_pane_id", stamp]);
      tmux(["set-option", "-p", "-t", paneId, "@agent_state", `working:${nowStamp()}`]);
    }
    tmux(["set-option", "-t", name, "@tmux_ide_adopted", "1"]);
    return paneIds;
  };

  // =========================================================================
  // a. Agent status latency
  // =========================================================================
  process.stderr.write("[qualify] a. agent status latency\n");
  // Measured sessions are `qual-` (not `zz-`): the CLI's session read filters
  // `zz-`/`_` names as internal, so `wait agent-status` could never see them.
  // Isolation comes from the private socket, not the name.
  const latencySession = `qual-lat-${randomUUID().slice(0, 8)}`;
  const [latencyPane] = stampedSession(latencySession, 1);
  // Visibility check: the installed CLI's own session read must see the same
  // server the daemon observes, or `wait agent-status` can only time out.
  const teamJson = runSync(installedCli, ["team", "--json"], {
    cwd: projectDir,
    env: installedEnvironment(),
  }).stdout;
  let teamSessions = [];
  try {
    const parsed = JSON.parse(teamJson);
    teamSessions = (parsed.projects ?? []).flatMap((project) =>
      (project.sessions ?? []).map((session) => session.name),
    );
  } catch {
    teamSessions = [`unparsed: ${teamJson.slice(0, 200)}`];
  }
  report.artifact.cliTeamSessions = teamSessions;
  if (!teamSessions.includes(latencySession)) {
    throw new Error(
      `installed CLI does not see ${latencySession}: ${JSON.stringify(teamSessions)}`,
    );
  }

  // (i) sole events client: flip → agent.turn-completed receipt.
  const receiptRuns = [];
  {
    const client = await newClient();
    await client.subscribeFleet();
    for (let run = 0; run < RUNS; run += 1) {
      // Re-arm: the receipt is a working→done transition, so the daemon must
      // have observed `working` first. The pane starts as working (baselined
      // at subscribe); after a run it is done, and the coarse invalidation
      // proves the daemon saw it return to working.
      if (run > 0) {
        const armFrom = client.frames.length;
        tmux(["set-option", "-p", "-t", latencyPane, "@agent_state", `working:${nowStamp()}`]);
        await client.waitFor(
          (f) => f.type === "agent-status.changed" && f.sessionName === latencySession,
          15_000,
          armFrom,
        );
      }
      // The arming invalidation arrives on an observer tick, so a fixed delay
      // here would flip at one fixed phase of the 2 s cadence; spread the flip
      // uniformly across a tick to sample the real latency distribution.
      const armDelayMs = Math.round(250 + Math.random() * OBSERVER_TICK_MS);
      await sleep(armDelayMs);
      const from = client.frames.length;
      const beforeFlip = performance.now();
      tmux(["set-option", "-p", "-t", latencyPane, "@agent_state", `done:${nowStamp()}`]);
      const flipVisibleAt = performance.now();
      const receipt = await client.waitFor(
        (f) => f.type === "agent.turn-completed" && f.sessionName === latencySession,
        20_000,
        from,
      );
      receiptRuns.push({
        run: run + 1,
        armDelayMs,
        setOptionMs: Number((flipVisibleAt - beforeFlip).toFixed(2)),
        latencyMs: Number((receipt.receivedAt - flipVisibleAt).toFixed(2)),
        toStatus: receipt.toStatus,
      });
      process.stderr.write(
        `[qualify]   receipt run ${run + 1}: ${receiptRuns.at(-1).latencyMs} ms\n`,
      );
    }
    await dropClient(client);
  }

  // (ii) sole `tmux-ide wait agent-status` process: flip → process exit.
  const waitRuns = [];
  const baseSettleMs = Math.max(2_500, Math.round(report.artifact.cliVersionWallMs * 4));
  for (let run = 0; run < RUNS; run += 1) {
    // Same phase spreading as the receipt runs: the wait process baselines the
    // observer when it subscribes, so vary the settle across one tick.
    const settleMs = baseSettleMs + Math.round(Math.random() * OBSERVER_TICK_MS);
    tmux(["set-option", "-p", "-t", latencyPane, "@agent_state", `working:${nowStamp()}`]);
    await sleep(300);
    const spawnedAt = performance.now();
    const waiter = spawn(
      installedCli,
      ["wait", "agent-status", latencySession, "--status", "done", "--timeout", "30000", "--json"],
      { cwd: projectDir, env: installedEnvironment(), stdio: ["ignore", "pipe", "pipe"] },
    );
    const output = { stdout: "", stderr: "" };
    waiter.stdout.on("data", (c) => (output.stdout += c.toString()));
    waiter.stderr.on("data", (c) => (output.stderr += c.toString()));
    const exited = new Promise((resolve) => waiter.once("exit", (code) => resolve(code)));
    // No readiness signal exists from the wait process; give it a settle that
    // covers CLI startup, connect, subscribe and its initial aggregate read.
    await sleep(settleMs);
    const beforeFlip = performance.now();
    tmux(["set-option", "-p", "-t", latencyPane, "@agent_state", `done:${nowStamp()}`]);
    const flipVisibleAt = performance.now();
    const code = await exited;
    const exitedAt = performance.now();
    waitRuns.push({
      run: run + 1,
      exitCode: code,
      settleMs,
      setOptionMs: Number((flipVisibleAt - beforeFlip).toFixed(2)),
      latencyMs: Number((exitedAt - flipVisibleAt).toFixed(2)),
      fromSpawnMs: Number((exitedAt - spawnedAt).toFixed(2)),
      stdout: output.stdout.trim(),
      stderr: output.stderr.trim(),
    });
    process.stderr.write(
      `[qualify]   wait run ${run + 1}: exit ${code}, ${waitRuns.at(-1).latencyMs} ms\n`,
    );
  }
  report.scenarios.agentStatusLatency = {
    method:
      "One stamped pane in an adopted session on the private server. (i) A sole /ws/events client subscribed with legacyEvents + fleet-catalog interest; per run the pane is re-armed to working (confirmed by agent-status.changed), a random delay within one observer tick elapses, then it is flipped to done with `tmux set-option -p`; latency = receipt frame arrival − set-option exit. (ii) No other client; the installed `tmux-ide wait agent-status <s> --status done` is spawned, allowed a settle (base + a random fraction of one 2 s observer tick, so flips sample every phase), then the pane is flipped; latency = process exit − set-option exit.",
    receipt: { runs: receiptRuns, latencyMs: stats(receiptRuns.map((r) => r.latencyMs)) },
    waitCli: {
      baseSettleMs,
      runs: waitRuns,
      latencyMs: stats(waitRuns.map((r) => r.latencyMs)),
      fromSpawnMs: stats(waitRuns.map((r) => r.fromSpawnMs)),
      allExitedZero: waitRuns.every((r) => r.exitCode === 0),
    },
  };

  // =========================================================================
  // b. Fairness
  // =========================================================================
  process.stderr.write("[qualify] b. fairness: 16-pane promotion\n");
  const promotionRuns = [];
  for (let run = 0; run < RUNS; run += 1) {
    const session = `qual-promo-${run + 1}-${randomUUID().slice(0, 6)}`;
    tmux(["new-session", "-d", "-s", session, "-c", projectDir, "-n", "w0", "exec sleep 7200"]);
    for (let w = 1; w < 4; w += 1) {
      tmux([
        "new-window",
        "-d",
        "-t",
        `${session}:`,
        "-c",
        projectDir,
        "-n",
        `w${w}`,
        "exec sleep 7200",
      ]);
    }
    for (const windowId of tmux(["list-windows", "-t", session, "-F", "#{window_id}"]).split(
      "\n",
    )) {
      for (let p = 1; p < 4; p += 1) {
        tmux(["split-window", "-d", "-t", windowId, "-c", projectDir, "exec sleep 7200"]);
      }
    }
    const paneCount = tmux(["list-panes", "-s", "-t", session, "-F", "#{pane_id}"]).split(
      "\n",
    ).length;
    const client = await newClient();
    await client.subscribeFleet();
    const loop = client.startPingLoop();
    await sleep(1_000);
    const idleRoundTrips = loop.roundTrips.splice(0);
    const promotionStartedAt = performance.now();
    const response = await fetch(`${apiBase}/api/v2/action/workspace.promote`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Tmux-Ide-Operation-Id": randomUUID(),
        Connection: "close",
      },
      body: JSON.stringify({ sessionId: fleetSessionIdForName(session) }),
    });
    const promotionMs = performance.now() - promotionStartedAt;
    const envelope = await response.json().catch(() => ({}));
    await sleep(100);
    const duringRoundTrips = loop.roundTrips.splice(0);
    await loop.stop();
    await dropClient(client);
    tmux(["kill-session", "-t", session]);
    promotionRuns.push({
      run: run + 1,
      panes: paneCount,
      httpStatus: response.status,
      outcome: envelope?.result?.outcome ?? null,
      envelope: envelope?.result?.outcome === "promoted" ? undefined : envelope,
      promotionMs: Number(promotionMs.toFixed(1)),
      idlePingMs: stats(idleRoundTrips),
      duringPingMs: stats(duringRoundTrips),
    });
    process.stderr.write(
      `[qualify]   promotion run ${run + 1}: ${promotionRuns.at(-1).outcome} in ${promotionRuns.at(-1).promotionMs} ms, ping max ${promotionRuns.at(-1).duringPingMs.max} ms (idle max ${promotionRuns.at(-1).idlePingMs.max})\n`,
    );
    await sleep(1_000);
  }

  process.stderr.write("[qualify] b. fairness: 8-pane flip storm\n");
  const stormSession = `qual-storm-${randomUUID().slice(0, 8)}`;
  const stormPanes = stampedSession(stormSession, 8);
  const stormRuns = [];
  for (let run = 0; run < RUNS; run += 1) {
    const client = await newClient();
    await client.subscribeFleet();
    const loop = client.startPingLoop();
    await sleep(1_000);
    const idleRoundTrips = loop.roundTrips.splice(0);
    const receiptsFrom = client.frames.length;
    let flips = 0;
    let phase = 0;
    let storming = true;
    const storm = (async () => {
      while (storming) {
        const tickStartedAt = performance.now();
        phase = 1 - phase;
        const status = phase ? "done" : "working";
        const argv = [];
        stormPanes.forEach((paneId, index) => {
          if (index > 0) argv.push(";");
          argv.push("set-option", "-p", "-t", paneId, "@agent_state", `${status}:${nowStamp()}`);
        });
        await tmuxAsync(argv);
        flips += stormPanes.length;
        // Mean 200 ms with ±100 ms jitter: an exact 200 ms cadence (400 ms
        // period) is phase-locked to the observer's 2 s sampling and would
        // present the same state at every sample.
        const tickMs = 100 + Math.random() * 200;
        await sleep(Math.max(0, tickMs - (performance.now() - tickStartedAt)));
      }
    })();
    await sleep(STORM_SECONDS * 1_000);
    storming = false;
    await storm;
    const duringRoundTrips = loop.roundTrips.splice(0);
    await loop.stop();
    const stormFrames = client.frames.slice(receiptsFrom);
    const receipts = stormFrames.filter(
      (f) => f.type === "agent.turn-completed" && f.sessionName === stormSession,
    ).length;
    const invalidations = stormFrames.filter(
      (f) => f.type === "agent-status.changed" && f.sessionName === stormSession,
    ).length;
    await dropClient(client);
    stormRuns.push({
      run: run + 1,
      panes: stormPanes.length,
      flips,
      receipts,
      invalidations,
      idlePingMs: stats(idleRoundTrips),
      duringPingMs: stats(duringRoundTrips),
    });
    process.stderr.write(
      `[qualify]   storm run ${run + 1}: ${flips} flips, ${receipts} receipts, ping max ${stormRuns.at(-1).duringPingMs.max} ms\n`,
    );
    await sleep(1_000);
  }
  report.scenarios.fairness = {
    method:
      "One /ws/events client (subscribed with legacyEvents + fleet-catalog interest) loops ping→pong with one probe in flight and a 2 ms gap. Promotion: a fresh 16-pane (4 windows × 4 panes) session is promoted via POST /api/v2/action/workspace.promote; round-trips are split into the 1 s idle baseline and the promotion window. Storm: 8 stamped panes in an adopted session alternate working/done every 200 ms ±100 ms jitter (one chained tmux client per tick; an exact cadence is phase-locked to the 2 s observer sampling) for the storm window.",
    promotion: {
      runs: promotionRuns,
      promotionMs: stats(promotionRuns.map((r) => r.promotionMs)),
      duringPingMaxMs: stats(promotionRuns.map((r) => r.duringPingMs.max)),
      duringPingMedianMs: stats(promotionRuns.map((r) => r.duringPingMs.median)),
      idlePingMaxMs: stats(promotionRuns.map((r) => r.idlePingMs.max)),
      allPromoted: promotionRuns.every((r) => r.outcome === "promoted"),
    },
    storm: {
      seconds: STORM_SECONDS,
      runs: stormRuns,
      duringPingMaxMs: stats(stormRuns.map((r) => r.duringPingMs.max)),
      duringPingMedianMs: stats(stormRuns.map((r) => r.duringPingMs.median)),
      idlePingMaxMs: stats(stormRuns.map((r) => r.idlePingMs.max)),
    },
  };

  // =========================================================================
  // c. Idle cost
  // =========================================================================
  const measureIdle = async (label) => {
    resetSpawns();
    const cpuBefore = daemonCpuSeconds(daemonPid);
    const startedAt = Date.now();
    await sleep(IDLE_SECONDS * 1_000);
    const elapsedS = (Date.now() - startedAt) / 1_000;
    const cpuAfter = daemonCpuSeconds(daemonPid);
    const bySource = readSpawns();
    const spawns = totalSpawns(bySource);
    return {
      label,
      elapsedSeconds: Number(elapsedS.toFixed(1)),
      spawns,
      spawnsPerMinute: Number(((spawns / elapsedS) * 60).toFixed(2)),
      bySource,
      daemonCpuSeconds: Number((cpuAfter - cpuBefore).toFixed(2)),
    };
  };
  process.stderr.write(`[qualify] c. idle: no clients (${IDLE_SECONDS}s)\n`);
  await sleep(2_000);
  const idleNoClients = await measureIdle("no-clients");
  process.stderr.write(
    `[qualify]   ${idleNoClients.spawns} spawns (${idleNoClients.spawnsPerMinute}/min), ${idleNoClients.daemonCpuSeconds} cpu-s\n`,
  );
  process.stderr.write(`[qualify] c. idle: one idle subscriber (${IDLE_SECONDS}s)\n`);
  const idleSubscriber = await newClient();
  await idleSubscriber.subscribeFleet();
  await sleep(2_000);
  const idleOneSubscriber = await measureIdle("one-idle-subscriber");
  idleOneSubscriber.framesReceived = idleSubscriber.frames.length;
  await dropClient(idleSubscriber);
  process.stderr.write(
    `[qualify]   ${idleOneSubscriber.spawns} spawns (${idleOneSubscriber.spawnsPerMinute}/min), ${idleOneSubscriber.daemonCpuSeconds} cpu-s\n`,
  );
  report.scenarios.idleCost = {
    method:
      "Every tmux child the daemon spawns goes through a PATH shim (the installed daemon resolves `tmux` via PATH; TMUX_IDE_TMUX_BIN also points at the shim) that appends one record per spawn. Daemon CPU is the daemon process's own `ps -o time` delta (children's CPU excluded). Fleet during the windows: keeper session, the 1-pane and 8-pane adopted stamped sessions.",
    windowSeconds: IDLE_SECONDS,
    noClients: idleNoClients,
    oneIdleSubscriber: idleOneSubscriber,
  };

  // -- Advisory thresholds ---------------------------------------------------
  const check = (name, value, limit, ok) => {
    if (!ok) report.violations.push({ name, value, limit });
  };
  const a = report.scenarios.agentStatusLatency;
  check(
    "receiptLatencyMaxMs",
    a.receipt.latencyMs.max,
    THRESHOLDS.receiptLatencyMaxMs,
    a.receipt.latencyMs.max < THRESHOLDS.receiptLatencyMaxMs,
  );
  check(
    "waitCliLatencyMaxMs",
    a.waitCli.latencyMs.max,
    THRESHOLDS.waitCliLatencyMaxMs,
    a.waitCli.latencyMs.max < THRESHOLDS.waitCliLatencyMaxMs,
  );
  check("waitCliAllExitedZero", a.waitCli.allExitedZero, true, a.waitCli.allExitedZero);
  const b = report.scenarios.fairness;
  check(
    "promotionPingMaxMs",
    b.promotion.duringPingMaxMs.max,
    THRESHOLDS.promotionPingMaxMs,
    b.promotion.duringPingMaxMs.max < THRESHOLDS.promotionPingMaxMs,
  );
  check("allPromoted", b.promotion.allPromoted, true, b.promotion.allPromoted);
  check(
    "stormPingMaxMs",
    b.storm.duringPingMaxMs.max,
    THRESHOLDS.stormPingMaxMs,
    b.storm.duringPingMaxMs.max < THRESHOLDS.stormPingMaxMs,
  );
  const c = report.scenarios.idleCost;
  check(
    "idleSpawnsPerMinuteNoClients",
    c.noClients.spawnsPerMinute,
    THRESHOLDS.idleSpawnsPerMinuteNoClients,
    c.noClients.spawnsPerMinute <= THRESHOLDS.idleSpawnsPerMinuteNoClients,
  );
  check(
    "idleSpawnsPerMinuteOneSubscriber",
    c.oneIdleSubscriber.spawnsPerMinute,
    THRESHOLDS.idleSpawnsPerMinuteOneSubscriber,
    c.oneIdleSubscriber.spawnsPerMinute <= THRESHOLDS.idleSpawnsPerMinuteOneSubscriber,
  );
  report.ok = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
} finally {
  cleanup.daemonTmuxChildrenBeforeStop = listSocketProcesses().filter((p) => p.pid !== daemonPid);
  await cleanUp();
  report.daemonLogTail = daemonOutput.join("").slice(-4_000);
}
report.finishedAt = new Date().toISOString();
const json = JSON.stringify(report, null, 2);
if (OUT_PATH) writeFileSync(OUT_PATH, `${json}\n`);
process.stdout.write(`${json}\n`);
if (!report.ok) process.exit(1);
if (ASSERT && report.violations.length > 0) process.exit(2);
