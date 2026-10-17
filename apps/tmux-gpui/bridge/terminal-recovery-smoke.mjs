import process from "node:process";
import console from "node:console";
// Real private tmux/daemon replacement, retaining the same browser and selected pane.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { readFile, stat, mkdir, writeFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { stopFixtureChild } from "./fixture-child.mjs";

import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  createOwnedSshFixture,
  createMacProcessIdentity,
  ownedProcesses,
} from "../../../scripts/lib/owned-ssh-fixture.mjs";
process.umask(0o077);
const useSsh = process.env.TMUX_GPUI_TEST_SSH === "1";
const allocations = [];
let kernel, ssh, currentInfo, sshRoot;
const tracker = ownedProcesses({
  identify: (pid) => kernel.identify(pid),
  list: async () =>
    execFileSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((line) => {
        const [pid, ppid] = line.trim().split(/\s+/).map(Number);
        return { pid, ppid };
      }),
});
const machineId = randomUUID();
const cli = process.env.TMUX_GPUI_TEST_CLI;
assert.ok(cli && isAbsolute(cli) && (await stat(cli)).isFile(), "Supply an isolated built CLI");
const scratch = await createScratchFleet({
  sessions: 1,
  windowsPerSession: 1,
  slug: "gpui-auto-recovery",
});
const env = { ...process.env };
for (const key of Object.keys(env))
  if (key.startsWith("TMUX_IDE_") || key === "TMUX" || key === "TMUX_TMPDIR") delete env[key];
Object.assign(env, scratch.environment);
env.TMUX_IDE_TMUX_SOCKET_PATH = scratch.socketPath;
delete env.TMUX_PANE;
delete env.NODE_OPTIONS;
delete env.NODE_PATH;
let daemon,
  browser,
  latest,
  buffer = "",
  stderr = "";
let phase = "startup";
const until = async (predicate) => {
  const deadline = Date.now() + 45000;
  while (!(await predicate())) {
    assert.ok(
      Date.now() < deadline,
      `Recovery deadline; phase=${phase}; status=${latest?.status}; diagnostics=${stderr}`,
    );
    await delay(25);
  }
};
const start = async () => {
  daemon = spawn(process.execPath, [cli, "--headless"], {
    env,
    cwd: scratch.root,
    stdio: "ignore",
  });
  await until(async () => {
    assert.equal(daemon.exitCode, null, "private daemon exited");
    try {
      return (
        JSON.parse(await readFile(join(scratch.daemonInfoDir, "daemon.json"), "utf8")).pid ===
        daemon.pid
      );
    } catch {
      return false;
    }
  });
  currentInfo = JSON.parse(await readFile(join(scratch.daemonInfoDir, "daemon.json"), "utf8"));
};
const send = (value) => browser.stdin.write(JSON.stringify(value) + "\n");
try {
  await start();
  const browserEnv = { ...env };
  if (useSsh) {
    sshRoot = await mkdtemp(join(await realpath(tmpdir()), "gpui-ssh-"));
    kernel = await createMacProcessIdentity({
      parent: sshRoot,
      onAllocated: (a) => allocations.push(a),
    });
    ssh = await createOwnedSshFixture({
      parent: sshRoot,
      node: process.execPath,
      targetPort: currentInfo.port,
      processes: tracker,
      handshake: async () =>
        currentInfo
          ? { version: 1, daemon: currentInfo }
          : { version: 1, error: { code: "daemon-missing" } },
      onAllocated: (a) => allocations.push(a),
    });
    const client = join(scratch.root, "client");
    const bin = join(client, "bin");
    await mkdir(bin, { recursive: true, mode: 0o700 });
    await writeFile(join(bin, "ssh"), `#!/bin/sh\nexec /usr/bin/ssh -F '${ssh.config}' "$@"\n`, {
      mode: 0o700,
    });
    await writeFile(
      join(client, "machines.json"),
      JSON.stringify({
        version: 1,
        machines: [{ id: machineId, label: "Owned SSH", sshTarget: "target", enabled: true }],
      }),
      { mode: 0o600 },
    );
    Object.assign(browserEnv, {
      PATH: bin + ":" + env.PATH,
      TMUX_IDE_HOME: client,
      TMUX_IDE_REGISTRY_DIR: client,
      TMUX_IDE_DAEMON_INFO_DIR: client,
    });
  }
  browser = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      resolve(process.env.TMUX_GPUI_TEST_BROWSER ?? "apps/tmux-gpui/bridge/browser.ts"),
      "--local",
    ],
    {
      env: browserEnv,
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  browser.stderr.on("data", (b) => {
    stderr = (stderr + b.toString()).slice(-8000);
  });
  browser.stdout.on("data", (b) => {
    buffer += b.toString();
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      latest = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
    }
  });
  await until(() =>
    latest?.fleet?.groups.some(
      (g) =>
        g.id === (useSsh ? machineId : "local") &&
        g.sessions.some((s) => s.name === scratch.sessionNames[0] && s.selection),
    ),
  );
  const session = latest.fleet.groups
    .find((g) => g.id === (useSsh ? machineId : "local"))
    .sessions.find((s) => s.name === scratch.sessionNames[0]);
  assert.ok(session?.selection, "Only the owned scratch session may be selected");
  send({ type: "fleet-session", request: 1, selection: session.selection });
  await until(() => latest?.request === 1 && latest?.panes.length);
  const pane = latest.panes[0].id;
  send({ type: "pane", request: 2, id: pane });
  await until(() => latest?.request === 2 && latest.snapshot && latest.inputReady);
  const sessionId = latest.selectedSession;
  const tabId = latest.sessionTabs?.active;
  assert.ok(tabId, "Initial retained tab admitted");
  phase = "retirement";
  await stopFixtureChild(daemon);
  daemon = undefined;
  currentInfo = null;
  await until(() => !latest.snapshot && !latest.inputReady);
  // Disconnected input must be discarded, never replayed into fresh authority.
  send({
    type: "input",
    request: 2,
    id: pane,
    input: { kind: "text", data: "echo MUST_NOT_REPLAY_1702" },
  });
  send({ type: "input", request: 2, id: pane, input: { kind: "key", data: "Enter" } });
  // No refresh or reselect is sent during recovery.
  phase = "restart";
  await start();
  if (ssh) await ssh.refreshTargetPort(currentInfo.port);
  phase = "automatic restoration";
  await until(() => latest?.snapshot && latest.inputReady && latest.selectedPane === pane);
  assert.equal(latest.selectedSession, sessionId);
  assert.equal(latest.request, 2);
  await until(() => latest.sessionTabs?.rows.some((row) => row.id === tabId && row.available));
  assert.equal(latest.sessionTabs.active, tabId);
  phase = "restored input";
  console.log(
    JSON.stringify({
      phase,
      grid: scratch.windowGrid(scratch.sessionNames[0]),
      snapshot: { cols: latest.snapshot.cols, rows: latest.snapshot.rows },
    }),
  );
  send({
    type: "input",
    request: 2,
    id: pane,
    input: { kind: "text", data: "echo RECOVERY_LIVE_OK\n" },
  });
  send({ type: "input", request: 2, id: pane, input: { kind: "key", data: "Enter" } });
  await until(() =>
    scratch
      .capturePane(scratch.sessionNames[0])
      .split("\n")
      .some((line) => line.trim() === "RECOVERY_LIVE_OK"),
  );
  assert.ok(
    !scratch.capturePane(scratch.sessionNames[0]).includes("MUST_NOT_REPLAY_1702"),
    "Interrupted input must not replay",
  );
  phase = "navigation cancels recovery";
  await stopFixtureChild(daemon);
  daemon = undefined;
  currentInfo = null;
  await until(() => !latest.snapshot && !latest.inputReady);
  send({ type: "home", request: 3 });
  await until(() => latest.request === 3 && latest.surface === "home");
  await start();
  if (ssh) await ssh.refreshTargetPort(currentInfo.port);
  await delay(2500);
  assert.equal(latest.surface, "home");
  assert.equal(latest.request, 3);
  assert.equal(latest.snapshot, null);
  assert.equal(latest.inputReady, false);
  console.log(
    JSON.stringify({
      passed: true,
      sameBrowser: true,
      samePane: true,
      automaticRecovery: true,
      realSsh: useSsh,
    }),
  );
} catch (error) {
  console.error(JSON.stringify(allocations.map((a) => a.diagnostics?.())));
  throw error;
} finally {
  const cleanup = await Promise.allSettled([stopFixtureChild(browser), stopFixtureChild(daemon)]);
  await tracker.dispose();
  for (const allocation of allocations.reverse()) await allocation.disposeFiles();
  if (sshRoot) await rm(sshRoot, { recursive: true, force: true });
  await scratch.dispose();
  const failures = cleanup.filter((result) => result.status === "rejected");
  if (failures.length) {
    console.error("Owned fixture cleanup failed");
    process.exitCode = 1;
  }
}
