/** Opt-in D05 lifecycle acceptance; all roots/servers belong to this invocation. */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { resolveDevelopmentInstance } from "../../packages/daemon/src/lib/development-instance.ts";
import { readDevelopmentBuild } from "../../packages/daemon/src/lib/development-build.ts";
import {
  cleanManagerEnvironment,
  developmentProcessIdentity,
} from "../../packages/daemon/src/lib/development-state.ts";
import { inspectCanonicalDaemonInfoPath } from "../../packages/daemon/src/lib/canonical-daemon.ts";
import {
  captureUnixSocketIdentity,
  revalidateUnixSocketIdentity,
} from "../../packages/daemon/src/lib/unix-socket-authority.ts";
const execute = promisify(execFile);
const [first, second, store] = process.argv.slice(2);
assert(first && second && store);
const instances = [first, second].map((worktree) =>
  resolveDevelopmentInstance({ worktree, store }),
);
const manager = resolve("scripts/development-instance.ts");
const tsx = resolve("node_modules/tsx/dist/cli.mjs");
const env = {
  ...cleanManagerEnvironment(),
  TMUX: "/wrong-socket,1,0",
  TMUX_PANE: "%999",
  TMUX_IDE_RUNTIME_MODE: "production",
  TMUX_IDE_HOME: "/wrong-state",
};
async function cli(index: number, command: string, flags: string[] = []) {
  const selected = flags.includes("--id") ? [] : ["--worktree", instances[index]!.worktree];
  const result = await execute(
    process.execPath,
    [tsx, manager, command, "--store", store!, "--json", ...selected, ...flags],
    { env, timeout: 45000, maxBuffer: 128 * 1024 },
  );
  return JSON.parse(result.stdout);
}
async function wait(check: () => Promise<boolean>, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("D05 acceptance timed out");
}
function info(path: string) {
  const state = inspectCanonicalDaemonInfoPath(path);
  assert.equal(state.status, "valid");
  if (state.status !== "valid") throw new Error("Missing fixture daemon");
  return state.info;
}
const sentinelRoot = mkdtempSync("/private/tmp/ti-d05-sentinel-");
const sentinelState = join(sentinelRoot, "state");
mkdirSync(sentinelState, { mode: 0o700 });
const sentinelSocket = join(sentinelRoot, "tmux.sock");
const secondBuild = readDevelopmentBuild(instances[1]!, {});
const tmux = join(secondBuild.assets, "tmux", `${process.platform}-${process.arch}`, "tmux");
const sentinelHome = join(sentinelRoot, "home");
mkdirSync(sentinelHome, { mode: 0o700 });
const sentinelEnv = {
  ...cleanManagerEnvironment(),
  HOME: sentinelHome,
  TMUX_IDE_RUNTIME_MODE: "test",
  TMUX_IDE_HOME: sentinelState,
  TMUX_IDE_CLEANUP_TOKEN: randomUUID(),
  TMUX_IDE_TMUX_BIN: tmux,
  TMUX_IDE_TMUX_SOCKET_PATH: sentinelSocket,
  TMUX_IDE_DAEMON_INFO_DIR: sentinelState,
  TMUX_IDE_REGISTRY_DIR: sentinelState,
  TMUX_IDE_SETTINGS_DIR: sentinelState,
  TMUX_IDE_CLI: secondBuild.cli,
};
let sentinelChild: ReturnType<typeof spawn> | undefined;
let sentinelIncarnation: string | null = null;
let sentinelIdentity: ReturnType<typeof captureUnixSocketIdentity> | undefined;
let sentinelPid = 0;
let app:
  | {
      write(data: string): void;
      kill(signal?: string): void;
      onData(callback: (data: string) => void): void;
      onExit(callback: () => void): void;
    }
  | undefined;
let appExited = false;
let moved = false;
const receipt: Record<string, unknown> = {};
async function tmuxRead(socket: string, args: string[]) {
  const result = await execute(tmux, ["-S", socket, "-N", ...args], {
    env: cleanManagerEnvironment(),
    encoding: "utf8",
    timeout: 2000,
  });
  return result.stdout.trim();
}
async function fingerprint(socket: string, daemonPid: number) {
  const identity = captureUnixSocketIdentity(socket);
  const panes = await tmuxRead(socket, [
    "list-panes",
    "-t",
    "shared",
    "-F",
    "#{pane_id}|#{pane_pid}",
  ]);
  return {
    daemonPid,
    incarnation: await developmentProcessIdentity(daemonPid),
    tmuxPid: await tmuxRead(socket, ["display-message", "-p", "#{pid}"]),
    socketDev: identity.dev,
    socketIno: identity.ino,
    panes,
  };
}
try {
  const up = await Promise.all([cli(0, "up"), cli(1, "up")]);
  for (let i = 0; i < 2; i++)
    await tmuxRead(up[i].tmux.socket, [
      "new-session",
      "-d",
      "-s",
      "shared",
      "/bin/sh",
      ";",
      "set-option",
      "-t",
      "shared",
      "@tmux_ide_adopted",
      "1",
    ]);
  await execute(
    tmux,
    ["-S", sentinelSocket, "-f", "/dev/null", "new-session", "-d", "-s", "shared", "/bin/sh"],
    { env: sentinelEnv, timeout: 2000 },
  );
  sentinelIdentity = captureUnixSocketIdentity(sentinelSocket);
  sentinelPid = Number(await tmuxRead(sentinelSocket, ["display-message", "-p", "#{pid}"]));
  sentinelChild = spawn(secondBuild.tools.node, [secondBuild.cli, "--headless", "--json"], {
    cwd: sentinelRoot,
    env: sentinelEnv,
    stdio: "ignore",
  });
  await new Promise<void>((resolve, reject) => {
    sentinelChild!.once("spawn", resolve);
    sentinelChild!.once("error", reject);
  });
  sentinelIncarnation = await developmentProcessIdentity(sentinelChild.pid!);
  await wait(
    async () =>
      inspectCanonicalDaemonInfoPath(join(sentinelState, "daemon.json")).status === "valid",
  );
  const own = await fingerprint(up[0].tmux.socket, up[0].daemon.pid);
  const sibling = await fingerprint(up[1].tmux.socket, up[1].daemon.pid);
  const sentinel = await fingerprint(sentinelSocket, sentinelChild.pid!);
  async function assertProtected() {
    assert.deepEqual(await fingerprint(up[1].tmux.socket, up[1].daemon.pid), sibling);
    assert.deepEqual(await fingerprint(sentinelSocket, sentinelChild!.pid!), sentinel);
  }
  const restarted = await cli(0, "restart");
  assert.equal(restarted.daemon.pid, up[0].daemon.pid);
  assert.notEqual(restarted.daemon.instanceId, up[0].daemon.instanceId);
  assert.deepEqual(await fingerprint(up[0].tmux.socket, restarted.daemon.pid), own);
  await assertProtected();
  receipt.restartPreservedExactProcesses = true;
  const pty = createRequire(secondBuild.cli)("node-pty");
  app = pty.spawn("pnpm", ["--silent", "dev:instance", "app", "--store", store], {
    cwd: first,
    env: { ...env, TERM: "xterm-256color" },
    cols: 100,
    rows: 30,
  });
  let output = "";
  app!.onData((data: string) => {
    output = (output + data).slice(-100000);
  });
  app!.onExit(() => {
    appExited = true;
  });
  await wait(async () => output.length > 2000 && existsSync(join(instances[0]!.root, "apps")));
  await cli(0, "down", ["--daemon-only"]);
  assert.equal(await developmentProcessIdentity(up[0].daemon.pid), null);
  const stopped = await fingerprint(up[0].tmux.socket, up[0].daemon.pid);
  assert.equal(stopped.panes, own.panes);
  assert.equal(stopped.tmuxPid, own.tmuxPid);
  assert.equal(stopped.socketIno, own.socketIno);
  await assert.rejects(cli(0, "reset", ["--yes"]));
  await assertProtected();
  receipt.daemonOnlyPreservedPanesAndAppGate = true;
  const resumed = await cli(0, "up");
  assert.notEqual(resumed.daemon.pid, up[0].daemon.pid);
  assert.equal((await fingerprint(up[0].tmux.socket, resumed.daemon.pid)).panes, own.panes);
  await cli(0, "down");
  await cli(0, "down");
  assert.equal(existsSync(up[0].tmux.socket), false);
  await assert.rejects(cli(0, "reset", ["--yes"]));
  await assertProtected();
  receipt.fullDownPreservedSiblingSentinelAndAppGate = true;
  app!.write("\x11");
  await wait(async () => appExited);
  renameSync(first, `${first}-d05-moved`);
  moved = true;
  const idFlags = ["--id", instances[0]!.id];
  const orphan = await cli(0, "status", idFlags);
  assert.equal(orphan.worktreeState, "missing");
  await cli(0, "reset", [...idFlags, "--yes"]);
  await cli(0, "reset", [...idFlags, "--yes"]);
  assert.equal(existsSync(join(instances[0]!.root, "artifacts")), false);
  await assertProtected();
  receipt.orphanResetVerified = true;
  receipt.sibling = sibling;
  receipt.sentinel = sentinel;
  receipt.own = own;
  receipt.completed = true;
} catch (error) {
  receipt.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  if (app && !appExited) {
    app.write("\x11");
    await wait(async () => appExited).catch(() => app!.kill("SIGTERM"));
  }
  if (moved) renameSync(`${first}-d05-moved`, first);
  const cleanup = await Promise.allSettled([cli(0, "down"), cli(1, "down")]);
  receipt.cleanup = cleanup.map((result) => result.status);
  if (
    sentinelChild?.pid &&
    sentinelIncarnation &&
    (await developmentProcessIdentity(sentinelChild.pid)) === sentinelIncarnation
  ) {
    const record = info(join(sentinelState, "daemon.json"));
    const response = await fetch(`http://127.0.0.1:${record.port}/api/v2/action/daemon.shutdown`, {
      method: "POST",
      headers: { Authorization: `Bearer ${record.authToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expectedInstanceId: record.instanceId }),
      redirect: "error",
      signal: AbortSignal.timeout(2000),
    });
    assert(response.ok);
    await wait(async () => (await developmentProcessIdentity(sentinelChild!.pid!)) === null);
  }
  if (sentinelIdentity && (await developmentProcessIdentity(sentinelPid)) !== null) {
    revalidateUnixSocketIdentity(sentinelIdentity);
    await tmuxRead(sentinelSocket, [
      "if-shell",
      "-F",
      `#{==:#{pid},${sentinelPid}}`,
      "kill-server",
    ]);
    await wait(async () => (await developmentProcessIdentity(sentinelPid)) === null);
  }
  if (sentinelIdentity && existsSync(sentinelSocket))
    rmSync(revalidateUnixSocketIdentity(sentinelIdentity));
  rmSync(sentinelRoot, { recursive: true });
  receipt.ok =
    receipt.completed === true && cleanup.every((result) => result.status === "fulfilled");
  writeFileSync(join(store, "d05-qualification.json"), JSON.stringify(receipt, null, 2));
  if (receipt.completed) assert.equal(receipt.ok, true);
}
