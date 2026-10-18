// Actual source helper + explicit private CLI. Never uses personal daemon discovery.
import assert from "node:assert/strict";
import process from "node:process";
import { Buffer } from "node:buffer";
import { spawn, execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rm,
  copyFile,
  chmod,
  writeFile,
  symlink,
  readFile,
  stat,
  realpath,
} from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { stopFixtureChild } from "./fixture-child.mjs";
const { fetch, AbortSignal } = globalThis;
const cli = process.env.TMUX_GPUI_TEST_CLI;
const output = process.env.TMUX_GPUI_TEST_OUTPUT;
assert.ok(cli && isAbsolute(cli) && (await stat(cli)).isFile(), "Explicit private CLI required");
assert.ok(output && isAbsolute(output), "Explicit private output prefix required");
assert.match(process.version, /^v24\./, "Run with qualified Node 24");
for (const key of Object.keys(process.env)) {
  if (
    key.startsWith("TMUX_IDE_") ||
    ["TMUX", "TMUX_PANE", "TMUX_TMPDIR", "NODE_OPTIONS", "NODE_PATH"].includes(key)
  )
    delete process.env[key];
}
// Unlike createScratchFleet(sessions:0), do not start an _e2e-holder server.
const privateRoot = await realpath(await mkdtemp("/tmp/tmi-empty-setup-"));
const socketName = "nr07-" + privateRoot.split("/").at(-1);
const privateHome = join(privateRoot, "home");
const privateProject = join(privateRoot, "project");
await mkdir(privateHome);
await mkdir(privateProject);
const tmuxBinary = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
function absentServer(error) {
  assert.equal(error.status, 1, "Unexpected tmux process failure");
  assert.match(
    String(error.stderr),
    /no server running|error connecting.*No such file or directory/s,
  );
}
const fleet = {
  root: privateRoot,
  projectDir: privateProject,
  socketPath: join("/private/tmp", `tmux-${process.getuid()}`, socketName),
  environment: {
    HOME: privateHome,
    XDG_CONFIG_HOME: join(privateHome, ".config"),
    XDG_STATE_HOME: join(privateHome, ".state"),
    XDG_CACHE_HOME: join(privateHome, ".cache"),
    TMUX_IDE_HOME: join(privateRoot, "state"),
    TMUX_IDE_SETTINGS_DIR: join(privateRoot, "settings"),
    TMUX_IDE_CONFIG: join(privateRoot, "config.json"),
    TMUX_IDE_TMUX_BIN: tmuxBinary,
  },
  dispose: async () => {
    try {
      execFileSync(tmuxBinary, ["-L", socketName, "kill-server"], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5000,
      });
    } catch (error) {
      absentServer(error);
    }
    let serverRemains = false;
    try {
      execFileSync(tmuxBinary, ["-L", socketName, "list-sessions"], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5000,
      });
      serverRemains = true;
    } catch (error) {
      absentServer(error);
    }
    assert.equal(serverRemains, false, "Owned named server remains after cleanup");
    await rm(privateRoot, { recursive: true, force: true });
  },
};
const home = await realpath(fleet.environment.HOME);
const canonical = join(fleet.root, "canonical");
const recordPath = join(canonical, "daemon.json");
const env = {
  ...process.env,
  ...fleet.environment,
  HOME: home,
  TMUX: "",
  TMPDIR: join(fleet.root, "tmp"),
  TMUX_IDE_DAEMON_INFO_DIR: canonical,
  TMUX_IDE_REGISTRY_DIR: canonical,
  TMUX_IDE_TMUX_SOCKET_NAME: socketName,
};
delete env.TMUX_IDE_TMUX_SOCKET_PATH;
const tmux = (...args) =>
  execFileSync(env.TMUX_IDE_TMUX_BIN, ["-L", socketName, ...args], {
    env,
    encoding: "utf8",
    timeout: 5000,
  });
let browser,
  latest,
  record,
  fatal,
  buffer = "",
  stderr = "",
  closing = false;
const identities = new Set();
const trace = [];
let initialAbsent = false,
  runningObserved = false,
  preserved = false,
  cleanupPassed = false;
const failures = [];
const deadline = Date.now() + 60000;
async function readRecord() {
  try {
    record = JSON.parse(await readFile(recordPath, "utf8"));
    assert.ok(
      Number.isSafeInteger(record.pid) && record.pid > 1 && typeof record.instanceId === "string",
    );
    identities.add(record.instanceId);
    return record;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function until(predicate) {
  while (!predicate()) {
    if (fatal) throw fatal;
    assert.ok(Date.now() < deadline, "Bounded setup phase timed out");
    await readRecord();
    await delay(20);
  }
}
async function verify(info) {
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(info.bindHostname));
  const host = info.bindHostname === "::1" ? "[::1]" : info.bindHostname;
  const base = `http://${host}:${info.port}`;
  const response = await fetch(`${base}/identity`, {
    redirect: "error",
    signal: AbortSignal.timeout(2000),
  });
  const identity = await response.json();
  assert.equal(identity.instanceId, info.instanceId);
  assert.equal(identity.pid, info.pid);
  assert.equal(identity.startedAt, info.startedAt);
  return base;
}
let socketInitiallyAbsent = false;
try {
  await stat(fleet.socketPath);
} catch (error) {
  assert.equal(error.code, "ENOENT");
  socketInitiallyAbsent = true;
}
assert.ok(socketInitiallyAbsent);
let noServerGuidance = false,
  noCreateAuthority = false,
  localTargetUnavailable = false;
try {
  await mkdir(canonical, { recursive: true, mode: 0o700 });
  await mkdir(env.TMPDIR, { recursive: true });
  const root = join(home, ".local/share/tmux-ide");
  const release = join(root, "releases/install-test");
  const pkg = join(release, "npm/lib/node_modules/tmux-ide");
  const node = join(release, "node/bin/node");
  await mkdir(join(pkg, "bin"), { recursive: true });
  await mkdir(join(release, "node/bin"), { recursive: true });
  await copyFile(process.execPath, node);
  await chmod(node, 0o700);
  await copyFile(cli, join(pkg, "bin/cli.js"));
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "tmux-ide",
      version: "2.9.7",
      type: "module",
      bin: { "tmux-ide": "bin/cli.js" },
    }),
  );
  // Source bundle externals only. This is not an installed-package qualification.
  await symlink(
    fileURLToPath(new URL("../../../node_modules", import.meta.url)),
    join(pkg, "node_modules"),
  );
  await writeFile(join(root, "installer-v1"), "1\n");
  await writeFile(join(release, ".installer-release-v1"), "1\n");
  await symlink(release, join(root, "current"));
  assert.equal(await readRecord(), null);
  initialAbsent = true;
  browser = spawn(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      fileURLToPath(new URL("../../../apps/tmux-gpui/bridge/browser.ts", import.meta.url)),
      "--local",
    ],
    { env, cwd: fleet.projectDir, stdio: ["pipe", "pipe", "pipe"] },
  );
  browser.on("error", () => {
    fatal ??= new Error("Owned browser spawn failed");
  });
  browser.on("exit", () => {
    if (!closing) fatal ??= new Error("Owned browser exited early");
  });
  browser.stdin.on("error", () => {
    if (!closing) fatal ??= new Error("Owned browser input failed");
  });
  browser.stderr.on("data", (data) => {
    stderr = (stderr + data).slice(-32768);
  });
  browser.stdout.setEncoding("utf8");
  browser.stdout.on("data", (data) => {
    try {
      buffer += data;
      assert.ok(Buffer.byteLength(buffer) <= 8 * 1024 * 1024);
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        latest = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        runningObserved ||= latest.localSetup?.phase === "running";
        const entry = {
          request: latest.request,
          home: latest.home?.phase,
          setup: latest.localSetup?.phase ?? null,
          sessions: latest.sessions.length,
          frame: !!latest.snapshot,
          input: latest.inputReady,
        };
        if (JSON.stringify(trace.at(-1)) !== JSON.stringify(entry) && trace.length < 128)
          trace.push(entry);
      }
    } catch {
      fatal ??= new Error("Invalid bounded publication");
    }
  });
  const send = (value) => browser.stdin.write(JSON.stringify(value) + "\n");
  send({ type: "presence", active: true, revision: 1 });
  await until(() => latest?.localSetup?.phase === "available");
  assert.equal(await readRecord(), null, "Offering setup must not start an owner");
  const request = latest.request;
  send({ type: "local-setup", request });
  send({ type: "local-setup", request });
  await until(
    () =>
      runningObserved &&
      latest?.home?.phase === "unavailable" &&
      /no online tmux server/.test(latest.status),
  );
  assert.ok(await readRecord());
  await verify(record);
  noServerGuidance = /Open an ordinary tmux session/.test(latest.status);
  noCreateAuthority = latest.home?.phase !== "live" && latest.selectedServer === null;
  const local = latest.fleet?.groups.find((group) => group.id === "local");
  localTargetUnavailable =
    !local ||
    !local.servers.some(
      (server) => server.state === "online" && server.selection && server.generation,
    );
  assert.ok(noServerGuidance && noCreateAuthority && localTargetUnavailable);
  // Idle operation status is not creation authority. A stale/unsupported raw
  // request must not bootstrap a session behind the unavailable Home state.
  send({ type: "create-session", request: latest.request, name: "must-not-create" });
  await delay(250);
  let sessionsCreated = false;
  try {
    sessionsCreated = tmux("list-sessions", "-F", "#{session_name}").trim().length > 0;
  } catch (error) {
    absentServer(error);
  }
  assert.equal(sessionsCreated, false, "Unavailable Home must reject session creation");
  assert.equal(latest.snapshot, null);
  assert.equal(latest.inputReady, false);
  assert.equal(latest.sessions.length, 0);
  await delay(500);
  await readRecord();
  assert.equal(identities.size, 1);
  preserved = true;
} catch (error) {
  failures.push(error.message);
} finally {
  closing = true;
  try {
    if (browser) await stopFixtureChild(browser);
    const owned = await readRecord();
    if (owned) {
      const base = await verify(owned);
      const response = await fetch(`${base}/api/v2/action/daemon.shutdown`, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", authorization: `Bearer ${owned.authToken}` },
        body: JSON.stringify({
          reason: "private-setup-fixture-cleanup",
          expectedInstanceId: owned.instanceId,
        }),
        signal: AbortSignal.timeout(3000),
      });
      assert.equal(response.status, 200, "Owned shutdown denied");
      const end = Date.now() + 5000;
      while (Date.now() < end) {
        try {
          process.kill(owned.pid, 0);
        } catch (error) {
          if (error.code === "ESRCH") break;
          assert.equal(error.code, "ESRCH");
        }
        await delay(25);
      }
      let alive = true;
      try {
        process.kill(owned.pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") alive = false;
        else assert.equal(error.code, "ESRCH");
      }
      assert.equal(alive, false, "Owned daemon did not exit");
    }
    await fleet.dispose();
    cleanupPassed = true;
  } catch (error) {
    failures.push(`Cleanup: ${error.message}`);
  }
  const result = {
    passed: failures.length === 0,
    node: process.version,
    cliSha256: createHash("sha256")
      .update(await readFile(cli))
      .digest("hex"),
    sourceDependencies: true,
    socketName,
    initialAbsent,
    duplicateClicks: 2,
    runningObserved,
    observedDaemonIdentities: identities.size,
    zeroSessionGapReproduced: preserved,
    socketInitiallyAbsent,
    noServerGuidance,
    noCreateAuthority,
    localTargetUnavailable,
    verifiedDaemonPresent: identities.size === 1,
    cleanupPassed,
    trace,
    failures,
    ...(cleanupPassed ? {} : { retainedPrivateRoot: fleet.root }),
  };
  await writeFile(`${output}.json`, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  await writeFile(`${output}.stderr`, stderr, { mode: 0o600 });
  process.stdout.write(JSON.stringify(result) + "\n");
  if (!result.passed) process.exitCode = 1;
}
