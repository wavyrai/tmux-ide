/**
 * Assembled-desktop smoke gate.
 *
 * Proves that the BUILT desktop app — packaged main bundle, preload, renderer
 * bundle and the daemon child it spawns — works against a real tmux fleet, in
 * three rungs:
 *
 *   a. fatal-pattern scan   the combined electron stdout/stderr carries no
 *                           missing module, uncaught renderer throw or CSP
 *                           refusal (ELECTRON_ENABLE_LOGGING=1).
 *   b. attachability        a scratch pane reaches
 *                           `attachability.status === "available"` in the
 *                           daemon's own application-shell resource.
 *   c. byte round-trip      a pane-stream lease redeems, seeds, accepts an
 *                           input frame, and echoes the typed bytes back.
 *   d. replay repair        the fleet session is killed and recreated under
 *                           its registered name, re-promoted (outcome
 *                           `replayed`), and its fresh unstamped panes become
 *                           attachable again — the path a long-lived registry
 *                           entry exercises after every tmux server death.
 *
 * Everything it touches is disposable: an isolated tmux socket in a temp dir, a
 * scratch session, temp HOME/registry/settings/daemon-info/user-data, and the
 * one electron process this script spawned. Cleanup runs on every exit path,
 * and only ever kills the socket and PIDs created here.
 */
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { mkdir, mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { WebSocket } from "ws";

import {
  attachabilityReport,
  dominantRefusalReasons,
  pollUntil,
  scanFatalPatterns,
  selectFleetSession,
} from "./smoke-lib.mjs";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "..", "..");
const distDir = join(packageRoot, "dist");

// Wire contract literals. Mirrored from @tmux-ide/contracts (pane-stream.ts);
// an .mjs build script cannot import the package's TypeScript sources, and the
// smoke test must speak the same wire the renderer speaks.
const PANE_STREAM_PROTOCOL_VERSION = 1;
const PANE_STREAM_ISSUE_PATH = "/api/v1/terminal/pane-streams/issue";
const RENDERER_ORIGIN = "tmux-ide://app";

// NOT `zz-`-prefixed: the daemon's own discovery treats `zz-` and `_` prefixes
// as internal scratch and hides them from the fleet, so a `zz-` session could
// never reach the app under test. Isolation comes from the private socket and
// temp state below, and this session lives and dies inside one script run.
const SESSION_NAME = `smoke-zz-${process.pid}`;
const SHORT_TEMP_ROOT = process.platform === "win32" ? tmpdir() : "/tmp";
/** POSIX `sun_path` is 104 bytes on macOS; leave a byte for the terminator. */
const MAX_UNIX_SOCKET_PATH = 103;
const TOTAL_BUDGET_MS = 150_000;
const DAEMON_READY_TIMEOUT_MS = 45_000;
const FLEET_TIMEOUT_MS = 20_000;
const STREAM_TIMEOUT_MS = 30_000;

const cleanups = [];
let electronOutput = "";

function log(message) {
  console.log(`[smoke] ${message}`);
}

function exists(path) {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** A rung failure that names itself precisely in the exit message. */
class RungFailure extends Error {
  constructor(rung, message) {
    super(message);
    this.rung = rung;
  }
}

async function ensureBuild() {
  const artifacts = [
    join(distDir, "main.cjs"),
    join(distDir, "preload.cjs"),
    join(distDir, "daemon-child.cjs"),
    join(distDir, "renderer", "index.html"),
  ];
  // Build EVERY run by default. A gate over the assembled product is only
  // honest against the current sources: dist/daemon-child.cjs bundles the
  // daemon, so a stale dist silently tests bytes that no longer exist in the
  // tree — a daemon fix can be present in git and absent from the app under
  // test. Opt out only for fast local iteration on the harness itself.
  if (process.env.TMUX_IDE_SMOKE_REUSE_BUILD === "1") {
    const present = await Promise.all(artifacts.map(exists));
    if (present.every(Boolean)) {
      log("TMUX_IDE_SMOKE_REUSE_BUILD=1: reusing the existing dist/ (may be stale)");
      return;
    }
  }
  log("building the desktop app (renderer + shell)");
  await execFileAsync("pnpm", ["--filter", "@tmux-ide/electron-shell", "build"], {
    cwd: repoRoot,
    maxBuffer: 32 * 1024 * 1024,
  });
  const rebuilt = await Promise.all(artifacts.map(exists));
  const missing = artifacts.filter((_path, index) => !rebuilt[index]);
  if (missing.length > 0) {
    throw new Error(`desktop build did not produce: ${missing.join(", ")}`);
  }
}

async function createScratchFleet() {
  // /tmp, not os.tmpdir(): on macOS the per-user temp dir realpaths to a ~56
  // character prefix, and the daemon resolves its pinned tmux socket through
  // realpath before connecting — a longer root pushes the socket past the
  // 104-byte sun_path limit and the daemon child dies in a restart loop.
  const root = await mkdtemp(join(SHORT_TEMP_ROOT, "tmi-smoke-"));
  cleanups.push(async () => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const projectDir = join(root, "project");
  const daemonInfoDir = join(root, "daemon");
  const registryDir = join(root, "registry");
  const settingsDir = join(root, "settings");
  const userData = join(root, "electron-user-data");
  const socketPath = join(root, "t.sock");
  const resolvedSocketLength = realpathSync(root).length + "/t.sock".length;
  if (resolvedSocketLength > MAX_UNIX_SOCKET_PATH) {
    throw new Error(
      `scratch tmux socket path resolves to ${resolvedSocketLength} bytes, over the ` +
        `${MAX_UNIX_SOCKET_PATH}-byte limit — the daemon could not connect to it`,
    );
  }
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(projectDir, { recursive: true }),
    mkdir(daemonInfoDir, { recursive: true, mode: 0o700 }),
    mkdir(registryDir, { recursive: true, mode: 0o700 }),
    mkdir(settingsDir, { recursive: true, mode: 0o700 }),
    mkdir(userData, { recursive: true }),
  ]);

  const tmuxBin = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
  const runTmux = (argv) =>
    execFileSync(tmuxBin, ["-S", socketPath, ...argv], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      env: { TERM: process.env.TERM ?? "xterm-256color", PATH: process.env.PATH ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    }).replace(/(?:\r?\n)+$/u, "");

  // Two single-pane windows of plain interactive sh — panes that exist BEFORE
  // the app starts, exactly like a fleet a user already had running.
  runTmux([
    "-f",
    "/dev/null",
    "new-session",
    "-d",
    "-s",
    SESSION_NAME,
    "-c",
    projectDir,
    "-n",
    "one",
    "exec sh -i",
  ]);
  cleanups.push(async () => {
    await execFileAsync(tmuxBin, ["-S", socketPath, "kill-server"]).catch(() => undefined);
  });
  runTmux([
    "new-window",
    "-d",
    "-t",
    `=${SESSION_NAME}:`,
    "-c",
    projectDir,
    "-n",
    "two",
    "exec sh -i",
  ]);
  // The durable adopt stamp: the fleet catalog enumerates adopted sessions only.
  runTmux(["set-option", "-t", SESSION_NAME, "@tmux_ide_adopted", "1"]);
  const tmuxServerPid = Number(runTmux(["display-message", "-p", "-t", SESSION_NAME, "#{pid}"]));
  if (!Number.isInteger(tmuxServerPid) || tmuxServerPid < 1) {
    throw new Error("scratch tmux server PID is unavailable");
  }
  log(`scratch fleet up: session ${SESSION_NAME} on ${socketPath} (tmux pid ${tmuxServerPid})`);

  return {
    root,
    projectDir,
    daemonInfoDir,
    userData,
    socketPath,
    tmuxBin,
    runTmux,
    environment: {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      // The socket-path authority: the daemon resolves its pinned tmux runner
      // and its mirror control channel from TMUX, and its executable from
      // TMUX_IDE_TMUX_BIN. Both point at this scratch server only.
      TMUX: `${socketPath},${tmuxServerPid},0`,
      TMUX_IDE_TMUX_BIN: tmuxBin,
      TMUX_IDE_DAEMON_INFO_DIR: daemonInfoDir,
      TMUX_IDE_REGISTRY_DIR: registryDir,
      TMUX_IDE_SETTINGS_DIR: settingsDir,
      TMUX_IDE_HOME: join(root, "state"),
      TMUX_IDE_CONFIG: join(root, "state", "config.json"),
    },
  };
}

async function launchElectron(fleet) {
  const { default: electronPath } = await import("electron");
  const environment = { ...process.env, ...fleet.environment, ELECTRON_ENABLE_LOGGING: "1" };
  delete environment.TMUX_IDE_RENDERER_URL;
  delete environment.TMUX_IDE_SESSION;
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  delete environment.TMUX_PANE;
  delete environment.TMUX_TMPDIR;

  const child = spawn(electronPath, [".", `--user-data-dir=${fleet.userData}`], {
    cwd: packageRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => (electronOutput += chunk.toString()));
  child.stderr.on("data", (chunk) => (electronOutput += chunk.toString()));
  let exitCode = null;
  child.once("exit", (code) => (exitCode = code));
  cleanups.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await pollUntil({
      probe: () => (child.exitCode !== null || child.signalCode !== null ? true : null),
      detail: "electron shutdown",
      timeoutMs: 8_000,
      intervalMs: 100,
    }).catch(() => child.kill("SIGKILL"));
  });
  log(`launched the built app (electron pid ${child.pid})`);

  const canonical = await pollUntil({
    probe: async () => {
      if (exitCode !== null) {
        throw new Error(`electron exited early (${exitCode})\n${electronOutput}`);
      }
      try {
        const record = JSON.parse(await readFile(join(fleet.daemonInfoDir, "daemon.json"), "utf8"));
        return record?.port && record?.authToken ? record : null;
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        // A partially written record is retried, never fatal.
        if (error instanceof SyntaxError) return null;
        throw error;
      }
    },
    detail: "the desktop daemon child to publish its canonical record",
    timeoutMs: DAEMON_READY_TIMEOUT_MS,
    intervalMs: 150,
  });
  cleanups.push(async () => {
    if (Number.isInteger(canonical.pid) && processIsAlive(canonical.pid)) {
      process.kill(canonical.pid, "SIGTERM");
      await pollUntil({
        probe: () => (processIsAlive(canonical.pid) ? null : true),
        detail: "daemon child shutdown",
        timeoutMs: 5_000,
        intervalMs: 100,
      }).catch(() => process.kill(canonical.pid, "SIGKILL"));
    }
  });
  log(`daemon ready on port ${canonical.port} (pid ${canonical.pid})`);
  return { child, canonical };
}

/**
 * The daemon generation this run is bound to went away mid-run. Raised instead
 * of a bare `fetch failed` so the transcript names the product event — the
 * daemon child died and the supervisor replaced it — rather than the symptom.
 */
class DaemonGenerationLost extends Error {}

function daemonClient(canonical, daemonInfoDir) {
  const base = `http://127.0.0.1:${canonical.port}`;
  const owner = { Authorization: `Bearer ${canonical.authToken}`, Connection: "close" };
  // A connection failure is ambiguous on its own; the canonical record tells us
  // whether the daemon this run started is simply gone, and what replaced it.
  const explainUnreachable = async (error) => {
    let current;
    try {
      current = JSON.parse(await readFile(join(daemonInfoDir, "daemon.json"), "utf8"));
    } catch {
      current = null;
    }
    const died = !processIsAlive(canonical.pid);
    if (!died && current?.pid === canonical.pid) return error;
    const replacement = current
      ? current.pid === canonical.pid
        ? "the same pid republished"
        : `replaced by pid ${current.pid} on port ${current.port}`
      : "no canonical record present";
    return new DaemonGenerationLost(
      `the daemon child this run started (pid ${canonical.pid}, port ${canonical.port}) ` +
        `is gone — ${replacement}`,
    );
  };
  return {
    base,
    async get(path) {
      let response;
      try {
        response = await fetch(`${base}${path}`, { headers: owner });
      } catch (error) {
        throw await explainUnreachable(error);
      }
      const body = await response.json().catch(() => null);
      return { status: response.status, body };
    },
    async post(path, payload, extraHeaders = {}) {
      let response;
      try {
        response = await fetch(`${base}${path}`, {
          method: "POST",
          headers: { ...owner, "Content-Type": "application/json", ...extraHeaders },
          body: JSON.stringify(payload),
        });
      } catch (error) {
        throw await explainUnreachable(error);
      }
      const body = await response.json().catch(() => null);
      return { status: response.status, body };
    },
  };
}

/**
 * Rung b — the scratch session becomes an admitted workspace through the
 * product's own promotion action, and the daemon then reports at least one pane
 * as attachable in its application-shell resource.
 */
async function proveAttachability(client) {
  const session = await pollUntil({
    probe: async () => {
      const { status, body } = await client.get("/api/resources/fleet-catalog");
      if (status !== 200) return null;
      return selectFleetSession(body, SESSION_NAME);
    },
    detail: `the scratch session ${SESSION_NAME} in the fleet catalog`,
    timeoutMs: FLEET_TIMEOUT_MS,
    intervalMs: 200,
  });
  log(`fleet catalog sees ${SESSION_NAME} as ${session.sessionId} (${session.paneCount} panes)`);

  const promote = await client.post(
    "/api/v2/action/workspace.promote",
    { sessionId: session.sessionId },
    { "X-Tmux-Ide-Operation-Id": randomUUID() },
  );
  if (promote.status !== 200 || promote.body?.ok !== true) {
    throw new RungFailure(
      "b (attachability)",
      `workspace.promote was refused (HTTP ${promote.status}): ${JSON.stringify(promote.body)}`,
    );
  }
  const workspaceName = promote.body.result?.resource?.workspaceName;
  if (typeof workspaceName !== "string") {
    throw new RungFailure("b (attachability)", "promotion returned no workspace name");
  }
  log(`promoted to workspace ${workspaceName} (outcome ${promote.body.result.outcome})`);

  const report = await assertPanesAttachable(client, "b (attachability)");
  return { workspaceName, paneId: report.available[0], sessionId: session.sessionId };
}

/** The shared attachability assertion: at least one pane must be available. */
async function assertPanesAttachable(client, rung) {
  const shell = await client.get(
    `/api/project/${encodeURIComponent(SESSION_NAME)}/application-shell?version=3`,
  );
  if (shell.status !== 200) {
    throw new RungFailure(
      rung,
      `application-shell resource was unavailable (HTTP ${shell.status})`,
    );
  }
  const report = attachabilityReport(shell.body?.resource?.terminalInventory?.resources);
  if (report.available.length === 0) {
    throw new RungFailure(
      rung,
      `no promoted pane reached attachability "available" — ${report.total} pane(s) refused: ` +
        `${dominantRefusalReasons(report).join(", ")}`,
    );
  }
  log(
    `attachability: ${report.available.length}/${report.total} panes available` +
      (report.unavailable.length > 0
        ? ` (refused: ${dominantRefusalReasons(report).join(", ")})`
        : ""),
  );
  return report;
}

/**
 * Rung d — the registry-replay repair path. The workspace registry is on-disk
 * and keyed by session NAME, so an entry outlives the panes whose stamps die
 * with them; a session recreated under a registered name arrives registered
 * AND unstamped, and promotion's already-registered branch must repair it.
 * This exact branch shipped broken on 2026-08-04: it resolved `replayed`
 * without touching tmux, leaving the whole fleet permanently unattachable —
 * the fresh-promotion rung (b) can never catch that class.
 */
async function proveReplayRepair(client, fleet) {
  // A second, never-adopted session keeps the scratch server (and the daemon's
  // pinned socket) alive while the fleet session is recreated.
  fleet.runTmux(["new-session", "-d", "-s", "keepalive", "-c", fleet.projectDir, "exec sh -i"]);
  fleet.runTmux(["kill-session", "-t", `=${SESSION_NAME}`]);
  fleet.runTmux([
    "new-session",
    "-d",
    "-s",
    SESSION_NAME,
    "-c",
    fleet.projectDir,
    "-n",
    "one",
    "exec sh -i",
  ]);
  fleet.runTmux(["set-option", "-t", SESSION_NAME, "@tmux_ide_adopted", "1"]);
  log(`recreated ${SESSION_NAME} under its registered name (old stamps died with the panes)`);

  // `session.<digest>` is derived from the session NAME (fleet-catalog.ts), so
  // the id survives recreation by design. The new incarnation is told apart by
  // its pane count: the original fleet has two panes, the recreated one has one.
  const session = await pollUntil({
    probe: async () => {
      const { status, body } = await client.get("/api/resources/fleet-catalog");
      if (status !== 200) return null;
      const found = selectFleetSession(body, SESSION_NAME);
      return found && found.paneCount === 1 ? found : null;
    },
    detail: `the recreated single-pane incarnation of ${SESSION_NAME} in the fleet catalog`,
    timeoutMs: FLEET_TIMEOUT_MS,
    intervalMs: 200,
  });

  const promote = await client.post(
    "/api/v2/action/workspace.promote",
    { sessionId: session.sessionId },
    { "X-Tmux-Ide-Operation-Id": randomUUID() },
  );
  if (promote.status !== 200 || promote.body?.ok !== true) {
    throw new RungFailure(
      "d (replay repair)",
      `re-promotion was refused (HTTP ${promote.status}): ${JSON.stringify(promote.body)}`,
    );
  }
  const outcome = promote.body.result?.outcome;
  if (outcome !== "replayed") {
    // If the product stops routing this scenario through the replay branch the
    // rung would silently stop covering the repair path — fail loudly instead.
    throw new RungFailure(
      "d (replay repair)",
      `expected the already-registered promotion outcome "replayed", got "${outcome}"`,
    );
  }
  log(`re-promoted (outcome ${outcome})`);
  await assertPanesAttachable(client, "d (replay repair)");
}

function openPaneStream(descriptor) {
  const socket = new WebSocket(descriptor.webSocketUrl, descriptor.subprotocol, {
    origin: RENDERER_ORIGIN,
  });
  const frames = [];
  socket.on("message", (data) => {
    try {
      frames.push(JSON.parse(String(data)));
    } catch {
      frames.push({ type: "unparseable" });
    }
  });
  const opened = new Promise((resolveOpen, rejectOpen) => {
    socket.once("open", () => resolveOpen());
    socket.once("error", rejectOpen);
  });
  return { socket, frames, opened };
}

/** Concatenated decoded bytes this stream has delivered for one pane. */
function paneText(frames, pane) {
  const chunks = [];
  for (const frame of frames) {
    if (frame.pane !== pane) continue;
    if (frame.type === "seed-batch") {
      chunks.push(Buffer.from(frame.seed, "base64"));
      for (const held of frame.held ?? []) chunks.push(Buffer.from(held, "base64"));
    } else if (frame.type === "output") {
      chunks.push(Buffer.from(frame.data, "base64"));
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Rung c — issue a real interactive pane-stream lease over the daemon's owner
 * endpoint, redeem it on the wire, type a byte, and see it echo back.
 */
async function proveByteRoundTrip(client, canonical, { workspaceName, paneId }) {
  const requestId = randomUUID();
  const issued = await client.post(
    PANE_STREAM_ISSUE_PATH,
    {
      requestId,
      expectedDaemonInstanceId: canonical.instanceId,
      stream: {
        protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
        workspaceName,
        panes: [paneId],
        viewerMode: "interactive",
      },
    },
    {
      Origin: RENDERER_ORIGIN,
      "X-Tmux-Ide-Request-Id": requestId,
      "X-Tmux-Ide-Expected-Daemon-Instance-Id": canonical.instanceId,
    },
  );
  if (issued.body?.status !== "issued") {
    throw new RungFailure(
      "c (byte round-trip)",
      `pane-stream lease was refused: ${JSON.stringify(issued.body)}`,
    );
  }
  const descriptor = issued.body.descriptor;
  const stream = openPaneStream(descriptor);
  cleanups.push(async () => stream.socket.close());
  await stream.opened;
  stream.socket.send(
    JSON.stringify({
      type: "redeem",
      protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
      ticket: descriptor.redemptionTicket,
      requestId,
      daemonInstanceId: canonical.instanceId,
    }),
  );
  await pollUntil({
    probe: () => {
      const error = stream.frames.find((frame) => frame.type === "error");
      if (error) throw new RungFailure("c (byte round-trip)", `stream error: ${error.code}`);
      return stream.frames.some((frame) => frame.type === "seed-batch" && frame.pane === paneId)
        ? true
        : null;
    },
    detail: `the atomic seed batch for ${paneId}`,
    timeoutMs: STREAM_TIMEOUT_MS,
    intervalMs: 50,
  });
  log(`pane-stream seeded ${paneId}`);

  const marker = `SMOKE_${randomUUID().slice(0, 8).toUpperCase()}`;
  stream.socket.send(
    JSON.stringify({ type: "input", kind: "text", pane: paneId, seq: 1, data: `echo ${marker}` }),
  );
  stream.socket.send(
    JSON.stringify({ type: "input", kind: "key", pane: paneId, seq: 2, data: "Enter" }),
  );
  await pollUntil({
    probe: () => {
      const acks = stream.frames
        .filter((frame) => frame.type === "input-ack" && frame.pane === paneId)
        .map((frame) => frame.seq);
      if (!acks.includes(1) || !acks.includes(2)) return null;
      // The marker echoes twice (the shell's own echo of the typed line, then
      // its output); either occurrence proves the bytes made the round trip.
      return paneText(stream.frames, paneId).includes(marker) ? true : null;
    },
    detail: `the typed marker ${marker} to echo back through the pane stream`,
    timeoutMs: STREAM_TIMEOUT_MS,
    intervalMs: 50,
  });
  log(`byte round-trip confirmed: ${marker} echoed back from ${paneId}`);
  stream.socket.close();
}

function proveNoFatalOutput(child) {
  if (child && (child.exitCode !== null || child.signalCode !== null)) {
    throw new RungFailure(
      "a (fatal-pattern scan)",
      `the assembled app exited during the run (code ${child.exitCode}, signal ${child.signalCode})`,
    );
  }
  const findings = scanFatalPatterns(electronOutput);
  if (findings.length > 0) {
    const detail = findings
      .slice(0, 10)
      .map(({ pattern, lineNumber, line }) => `  line ${lineNumber} [${pattern}]: ${line}`)
      .join("\n");
    throw new RungFailure(
      "a (fatal-pattern scan)",
      `the assembled app logged ${findings.length} fatal pattern(s):\n${detail}`,
    );
  }
  log(`fatal-pattern scan clean (${electronOutput.length} bytes of app output)`);
}

async function runCleanups() {
  for (const cleanup of cleanups.reverse()) {
    await cleanup().catch((error) => console.error("[smoke] cleanup step failed", error));
  }
}

/**
 * Run one rung, and make sure whatever escapes it is attributed to that rung —
 * an infrastructure error (a dead daemon, a timed-out poll) is a failure OF the
 * rung that provoked it, not of "setup".
 */
async function runRung(rung, operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof RungFailure) throw error;
    throw new RungFailure(rung, error instanceof Error ? error.message : String(error));
  }
}

async function main() {
  await ensureBuild();
  const fleet = await createScratchFleet();
  const { child, canonical } = await launchElectron(fleet);
  const client = daemonClient(canonical, fleet.daemonInfoDir);
  // Rung a runs first against the startup transcript, and again at the end so a
  // fatal logged DURING the later rungs — or an app that died mid-run — still
  // fails the gate.
  proveNoFatalOutput(child);
  const attached = await runRung("b (attachability)", () => proveAttachability(client));
  await runRung("c (byte round-trip)", () => proveByteRoundTrip(client, canonical, attached));
  await runRung("d (replay repair)", () => proveReplayRepair(client, fleet));
  proveNoFatalOutput(child);
}

const budget = setTimeout(() => {
  console.error(`[smoke] FAILED: exceeded the ${TOTAL_BUDGET_MS}ms total budget`);
  void runCleanups().finally(() => process.exit(1));
}, TOTAL_BUDGET_MS);
budget.unref?.();

let failure = null;
try {
  await main();
  log("PASSED: fatal-pattern scan, attachability, byte round-trip and replay repair all green");
} catch (error) {
  failure = error;
} finally {
  clearTimeout(budget);
  await runCleanups();
}

if (failure) {
  const rung = failure instanceof RungFailure ? failure.rung : "setup";
  const tail = electronOutput.slice(-4000);
  if (tail.length > 0) console.error(`[smoke] last app output:\n${tail}`);
  console.error(`[smoke] FAILED at rung ${rung}: ${failure.message}`);
  process.exit(1);
}
