// Connection soak: the app without a window (the ignored Rust test
// `connection_soak`) against an owned scratch daemon and tmux server, with
// faults injected in a loop. Every disconnect, its time to recover, and every
// state that did not recover by itself is recorded and summarised.
//
//   node --import tsx native-connection-soak.mjs ABS_GUI_TEST_BINARY
//
// Environment:
//   SOAK_SECONDS=600          how long to inject faults
//   SOAK_INACTIVE=1           the app window is not the active window
//   SOAK_FAULTS=a,b,c         only these faults (names below), in this order
//   SOAK_SETTLE_MS=12000      wait between faults
//   SOAK_RECOVER_LIMIT_S=60   after this long without recovery it is "stuck"
//   SOAK_CLI=/abs/bin/cli.js  a prebuilt daemon instead of this checkout's. Set
//                             it for runs in parallel: each run without it
//                             rebuilds bin/cli.js, and two builds collide
//   SOAK_MODE=late-daemon     only: start the app before the daemon
//   SOAK_CPU=1                also allow the cpu-starve fault (off by default:
//                             it loads every core of the machine for 8 s)
//   SOAK_REPORT=/abs/file.json  the full report; SOAK_TRANSCRIPT, SOAK_DAEMON_LOG
//
// Isolation: its own HOME, TMUX_IDE_HOME, daemon record, port and tmux socket
// (-S, under the scratch root). It refuses to run on the default tmux socket
// directory or on port 56983, and only signals processes it started.
import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { cpus, homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createScratchFleet } from "../../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../../scripts/lib/product-fixtures/daemon.ts";
import { stopFixtureChild } from "../fixture-child.mjs";
import { summarise, table } from "./native-connection-soak-report.mjs";
const { AbortSignal, Buffer, clearInterval, fetch, setInterval } = globalThis;

const [guiTestBinary] = process.argv.slice(2);
assert(
  guiTestBinary && isAbsolute(guiTestBinary),
  "Usage: node --import tsx native-connection-soak.mjs ABS_GUI_TEST_BINARY",
);
const seconds = Number(process.env.SOAK_SECONDS ?? 600);
const settleMs = Number(process.env.SOAK_SETTLE_MS ?? 12_000);
const inactive = process.env.SOAK_INACTIVE === "1";
const recoverLimit = Number(process.env.SOAK_RECOVER_LIMIT_S ?? 60);

const ownerHome = homedir();
const scratch = await createScratchFleet({ sessions: 2, windowsPerSession: 1, slug: "soak" });
const socket = realpathSync(scratch.socketPath);
assert(!/^(\/private)?\/tmp\/tmux-\d+\//u.test(socket), `refusing tmux socket ${socket}`);
assert.notEqual(scratch.environment.HOME, ownerHome, "refusing the owner's HOME");
const signals = join(scratch.root, "signals");
await mkdir(signals, { recursive: true });

// The daemon's tmux, wrapped: while `slow-probe` exists, the probe the daemon
// runs before it lists servers answers after 2 s instead of at once. That is
// what a loaded machine does to it, and what made the daemon rebuild the
// server owner and close every stream with 1001 "daemon-shutdown".
const realTmux = scratch.environment.TMUX_IDE_TMUX_BIN;
const slowTmux = join(scratch.root, "tmux-slow");
await writeFile(
  slowTmux,
  `#!/bin/sh\nif [ -e '${signals}/slow-probe' ]; then\n  case "$*" in *socket_path*) sleep 2 ;; esac\nfi\nexec '${realTmux}' "$@"\n`,
);
await chmod(slowTmux, 0o755);
const fleet = {
  ...scratch,
  environment: { ...scratch.environment, TMUX_IDE_TMUX_BIN: slowTmux, TMUX_TMPDIR: scratch.root },
};
const tmux = (...argv) =>
  execFileSync(realTmux, ["-S", scratch.socketPath, ...argv], {
    env: { ...process.env, ...scratch.environment },
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const tmuxQuiet = (...argv) => {
  try {
    return tmux(...argv);
  } catch {
    return "";
  }
};

const daemonOptions = process.env.SOAK_CLI ? { cliPath: process.env.SOAK_CLI } : {};
let daemon = null;
const startOwnDaemon = async () => {
  daemon = await startDaemon(fleet, daemonOptions);
  assert.notEqual(daemon.record.port, 56983, "refusing the owner's daemon port");
  return daemon;
};
const api = async (path) => {
  try {
    const response = await fetch(`${daemon.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${daemon.record.authToken}` },
      signal: AbortSignal.timeout(5000),
    });
    return response.status;
  } catch {
    return 0;
  }
};

const events = [];
let openSession = null;
let child = null;
let sessionSeq = 0;
const ensureSessions = () => {
  const names = tmuxQuiet("list-sessions", "-F", "#{session_name}").split("\n").filter(Boolean);
  for (let have = names.length; have < 2; have += 1) {
    sessionSeq += 1;
    tmuxQuiet(
      "new-session",
      "-d",
      "-s",
      `soak-${sessionSeq}`,
      "-c",
      scratch.projectDir,
      "exec sh -i",
    );
    tmuxQuiet("set-option", "-t", `soak-${sessionSeq}`, "@tmux_ide_adopted", "1");
  }
};

// Each fault returns what it did, for the log.
const faults = {
  // The owner's case, three times as on 12 Nov: the daemon stays up on the
  // same port and closes every stream of the server.
  "owner-rebuild": async () => {
    const statuses = [];
    for (let round = 0; round < 3; round += 1) {
      await writeFile(join(signals, "slow-probe"), "");
      statuses.push(await api("/api/v1/tmux-servers"));
      await sleep(1500);
      await rm(join(signals, "slow-probe"), { force: true });
      await sleep(8000);
    }
    return `probe slowed 3 times; list answered ${statuses.join(",")}`;
  },
  // The probe keeps failing for 20 s: the server stays offline in the catalog.
  "owner-offline-20s": async () => {
    await writeFile(join(signals, "slow-probe"), "");
    const status = await api("/api/v1/tmux-servers");
    await sleep(20_000);
    await rm(join(signals, "slow-probe"), { force: true });
    return `probe slow for 20 s; list answered ${status}`;
  },
  "stream-detach": async () => {
    const clients = tmuxQuiet("list-clients", "-F", "#{client_control_mode} #{client_name}")
      .split("\n")
      .filter((line) => line.startsWith("1 "))
      .map((line) => line.slice(2));
    for (const name of clients) tmuxQuiet("detach-client", "-t", name);
    return `detached ${clients.length} control client(s)`;
  },
  "daemon-restart": async () => {
    const before = daemon.record;
    await daemon.stop();
    await startOwnDaemon();
    return `restarted: port ${before.port} -> ${daemon.record.port}`;
  },
  // No clean exit, a stale record, and a pause as before launchd restarts it.
  "daemon-kill": async () => {
    const before = daemon.record;
    process.kill(before.pid, "SIGKILL");
    await sleep(3000);
    await daemon.stop().catch(() => undefined);
    await startOwnDaemon();
    return `killed ${before.pid}; back after 3 s on port ${daemon.record.port}`;
  },
  "daemon-freeze": async () => {
    const pid = daemon.record.pid;
    process.kill(pid, "SIGSTOP");
    await sleep(10_000);
    process.kill(pid, "SIGCONT");
    return `SIGSTOP ${pid} for 10 s`;
  },
  // Long enough for the events socket's 45 s silence deadline.
  "daemon-freeze-50s": async () => {
    const pid = daemon.record.pid;
    process.kill(pid, "SIGSTOP");
    await sleep(50_000);
    process.kill(pid, "SIGCONT");
    return `SIGSTOP ${pid} for 50 s`;
  },
  "session-churn": async () => {
    sessionSeq += 1;
    const name = `churn-${sessionSeq}`;
    tmuxQuiet("new-session", "-d", "-s", name, "-c", scratch.projectDir, "exec sh -i");
    await sleep(2000);
    tmuxQuiet("kill-session", "-t", `=${name}`);
    return `created and killed ${name}`;
  },
  "pane-split": async () => {
    if (!openSession) return "no open session known";
    tmuxQuiet("split-window", "-d", "-t", `=${openSession}:`, "exec sh -i");
    await sleep(3000);
    const panes = tmuxQuiet("list-panes", "-t", `=${openSession}:`, "-F", "#{pane_id}").split("\n");
    if (panes.length > 1) tmuxQuiet("kill-pane", "-t", panes.at(-1));
    return `split ${openSession}, then closed the new pane`;
  },
  // The session really ends: the app should say so and show the list.
  "session-kill-open": async () => {
    if (!openSession) return "no open session known";
    const name = openSession;
    tmuxQuiet("kill-session", "-t", `=${name}`);
    ensureSessions();
    return `killed the open session ${name}`;
  },
  "tmux-kill-server": async () => {
    tmuxQuiet("kill-server");
    await sleep(2000);
    ensureSessions();
    return "killed the tmux server; new server with 2 sessions after 2 s";
  },
  "cpu-starve": async () => {
    const hogs = cpus().map(() => spawn("/usr/bin/yes", [], { stdio: "ignore" }));
    await sleep(8000);
    for (const hog of hogs) hog.kill("SIGKILL");
    return `${hogs.length} busy processes for 8 s`;
  },
};
const expectedEnd = new Set(["session-kill-open", "tmux-kill-server"]);
const defaultOrder = [
  "owner-rebuild",
  "stream-detach",
  "daemon-restart",
  "session-churn",
  "owner-offline-20s",
  "daemon-freeze",
  "pane-split",
  "daemon-kill",
  "session-kill-open",
  "tmux-kill-server",
  "daemon-freeze-50s",
];
const order = (process.env.SOAK_FAULTS?.split(",") ?? defaultOrder).filter(
  (name) => name in faults && (name !== "cpu-starve" || process.env.SOAK_CPU === "1"),
);
assert(order.length > 0, "no known fault selected");

const injected = [];
let beat = 0;
let beating = null;
// SOAK_MODE=late-daemon: the app starts first, the daemon 3 s after the app
// reported that it is missing. Home must load without any command.
if (process.env.SOAK_MODE === "late-daemon") {
  try {
    child = spawn(
      guiTestBinary,
      [
        "--ignored",
        "--nocapture",
        "--test-threads=1",
        "home_loads_when_the_daemon_starts_after_the_app",
      ],
      {
        env: {
          ...process.env,
          ...scratch.environment,
          TMUX_IDE_TEST_DAEMON_RECORD: join(scratch.daemonInfoDir, "daemon.json"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => (output += chunk));
    const exited = once(child, "close", { signal: AbortSignal.timeout(180_000) });
    while (!output.includes("LATE_DAEMON_READY")) {
      assert(child.exitCode === null, `the app test exited early:\n${output.slice(-2000)}`);
      await sleep(100);
    }
    await sleep(3000);
    const startedAt = Date.now();
    await startOwnDaemon();
    const readyAfter = Date.now() - startedAt;
    const [code] = await exited;
    const loaded = /LATE_DAEMON_LOADED (\d+)/u.exec(output);
    console.log(
      JSON.stringify({
        mode: "late-daemon",
        exit: code,
        daemonReadyMs: readyAfter,
        homeLoadedMsAfterMissing: loaded ? Number(loaded[1]) : null,
      }),
    );
    assert.equal(code, 0, output.slice(-3000));
  } finally {
    try {
      await stopFixtureChild(child);
    } finally {
      try {
        await daemon?.stop();
      } finally {
        await scratch.dispose();
      }
    }
  }
  process.exit(0);
}
try {
  await startOwnDaemon();
  child = spawn(
    guiTestBinary,
    ["--ignored", "--nocapture", "--test-threads=1", "connection_soak"],
    {
      env: {
        ...process.env,
        ...scratch.environment,
        TMUX_IDE_TEST_DAEMON_RECORD: join(scratch.daemonInfoDir, "daemon.json"),
        TMUX_IDE_TEST_SIGNAL_DIR: signals,
        TMUX_IDE_SOAK_INACTIVE: inactive ? "1" : "",
        TMUX_IDE_SOAK_RECOVER_LIMIT_S: String(recoverLimit),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const transcript = [];
  let buffered = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      transcript.push(chunk);
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const at = line.indexOf("SOAK_EVENT ");
        if (at < 0) continue;
        try {
          const event = JSON.parse(line.slice(at + 11));
          events.push(event);
          if (event.session) openSession = event.session;
          if (event.event !== "ready" && process.env.SOAK_QUIET !== "1")
            console.error(`[soak] ${event.event} ${event.fault ?? ""} ${event.ms ?? ""}`);
        } catch {
          /* A torn line; the transcript keeps it. */
        }
      }
    });
  const exited = once(child, "close");
  const deadline = Date.now() + 90_000;
  while (!events.some((event) => event.event === "ready")) {
    assert(child.exitCode === null, "the app test exited before it connected");
    assert(Date.now() < deadline, "the app never connected");
    await sleep(200);
  }
  if (inactive)
    beating = setInterval(() => {
      beat += 1;
      for (const name of tmuxQuiet("list-sessions", "-F", "#{session_name}").split("\n"))
        if (name) tmuxQuiet("send-keys", "-t", `=${name}:`, `printf 'beat-%s\\n' ${beat}`, "Enter");
    }, 1000);
  await sleep(inactive ? 4000 : 6000);

  const end = Date.now() + seconds * 1000;
  for (let index = 0; Date.now() < end && child.exitCode === null; index += 1) {
    const name = order[index % order.length];
    const tag = `${name}#${index + 1}`;
    await writeFile(join(signals, "fault"), tag);
    await writeFile(join(signals, "busy"), tag);
    const at = Date.now();
    let did;
    try {
      did = await faults[name]();
    } catch (error) {
      did = `fault failed: ${error.message}`;
    }
    await rm(join(signals, "busy"), { force: true });
    injected.push({ tag, name, at, did, expectedEnd: expectedEnd.has(name) });
    console.error(`[soak] injected ${tag}: ${did}`);
    await sleep(settleMs);
    // Do not start the next fault on top of an unfinished recovery, up to the limit.
    const patience = Date.now() + (recoverLimit * 3 + 30) * 1000;
    while (Date.now() < patience && child.exitCode === null) {
      const last = events.findLast((event) => ["down", "up"].includes(event.event));
      if (!last || last.event === "up") break;
      await sleep(500);
    }
    await writeFile(join(signals, "fault"), "idle");
    await sleep(1500);
  }
  await writeFile(join(signals, "stop"), "");
  const [code, signal] = await Promise.race([exited, sleep(30_000).then(() => ["timeout", null])]);
  if (process.env.SOAK_TRANSCRIPT)
    await writeFile(
      process.env.SOAK_TRANSCRIPT,
      Buffer.concat(transcript).toString().replaceAll(daemon.record.authToken, "[redacted]"),
    );
  if (process.env.SOAK_DAEMON_LOG)
    await writeFile(
      process.env.SOAK_DAEMON_LOG,
      daemon.output().replaceAll(daemon.record.authToken, "[redacted]"),
    );
  const report = summarise({ events, injected, inactive, seconds, exit: { code, signal } });
  if (process.env.SOAK_REPORT)
    await writeFile(
      process.env.SOAK_REPORT,
      JSON.stringify({ ...report, events, injected }, null, 2),
    );
  console.log(table(report));
  console.log(JSON.stringify(report.totals));
  assert.equal(code, 0, "the app test did not exit cleanly");
  assert.equal(report.totals.stuck, 0, "a state did not recover by itself");
  assert.equal(report.totals.silentKeyLoss, 0, "typed keys were lost without a notice");
  assert.equal(report.totals.unexpectedEnds, 0, "a session was reported ended that was not");
} finally {
  if (beating) clearInterval(beating);
  try {
    await stopFixtureChild(child);
  } finally {
    try {
      if (existsSync(join(signals, "slow-probe"))) await rm(join(signals, "slow-probe"));
      await daemon?.stop();
    } finally {
      await scratch.dispose();
    }
  }
}
