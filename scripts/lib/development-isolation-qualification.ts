/** Opt-in D08 native release gate. Arguments MUST name disposable owned worktrees/store. */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { sampleIsolationResources } from "./development-isolation-resources.mjs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { resolveDevelopmentInstance } from "../../packages/daemon/src/lib/development-instance.ts";
import { readDevelopmentBuild } from "../../packages/daemon/src/lib/development-build.ts";
import {
  cleanManagerEnvironment,
  developmentProcessIdentity,
  writeDevelopmentRecord,
} from "../../packages/daemon/src/lib/development-state.ts";
import { inspectCanonicalDaemonInfoPath } from "../../packages/daemon/src/lib/canonical-daemon.ts";
import {
  captureUnixSocketIdentity,
  revalidateUnixSocketIdentity,
} from "../../packages/daemon/src/lib/unix-socket-authority.ts";
const execute = promisify(execFile);
const [first, second, store, ownership] = process.argv.slice(2);
assert(
  first && second && store && ownership === "--yes-owned-fixtures",
  "Usage: development-isolation-qualification.ts <disposable-worktree-a> <long-disposable-worktree-b> <private-store> --yes-owned-fixtures",
);
const instances = [first, second].map((worktree) =>
  resolveDevelopmentInstance({ worktree, store }),
);
assert.notEqual(instances[0]!.id, instances[1]!.id, "Two distinct canonical worktrees required");
// A is deliberately renamed by the orphan test; the manager must remain runnable.
const managerWorktree = instances[1]!.worktree;
const manager = resolve(managerWorktree, "scripts/development-instance.ts");
const tsx = resolve(managerWorktree, "node_modules/tsx/dist/loader.mjs");
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
    [
      "--no-deprecation",
      "--import",
      tsx,
      manager,
      command,
      "--store",
      store!,
      "--json",
      ...selected,
      ...flags,
    ],
    { env, cwd: managerWorktree, timeout: 45000, maxBuffer: 128 * 1024 },
  );
  return JSON.parse(result.stdout);
}
async function wait(check: () => Promise<boolean>, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("D08 native isolation gate timed out");
}
function info(path: string) {
  const state = inspectCanonicalDaemonInfoPath(path);
  assert.equal(state.status, "valid");
  if (state.status !== "valid") throw new Error("Missing fixture daemon");
  return state.info;
}
const sentinelRoot = mkdtempSync(
  process.platform === "darwin" ? "/private/tmp/ti-d08-sentinel-" : "/tmp/ti-d08-sentinel-",
);
const sentinelState = join(sentinelRoot, "state");
mkdirSync(sentinelState, { mode: 0o700 });
const sentinelSocket = join(sentinelRoot, "tmux.sock");
const builds = instances.map((instance) => readDevelopmentBuild(instance, {}));
const secondBuild = builds[1]!;
assert.notEqual(
  builds[0]!.hashes.cli,
  secondBuild.hashes.cli,
  "Gate requires intentionally divergent CLI builds",
);
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
type Client = {
  pid: number;
  write(data: string): void;
  kill(signal?: string): void;
  exited: boolean;
  frame(): string;
  dispose(): void;
};
const clients: Client[] = [];
let moved = false;
const receipt: Record<string, unknown> = {
  version: 1,
  platform: process.platform,
  architecture: process.arch,
  linuxQualified: false,
  artifacts: builds.map(({ generation, source, hashes }) => ({ generation, source, hashes })),
};
const knownPids = new Set<number>();
const streams = new Set<AbortController>();
const resourceSamples: unknown[] = [];
let currentOwnPid = 0;
let currentSiblingPid = 0;
let ownTmuxExpected = true;
const retiredClients = new Set<number>();
let branchChanged = false;
let branchName = "";
const originalHead = (
  await execute("git", ["-C", first, "rev-parse", "HEAD"], {
    env: cleanManagerEnvironment(),
    timeout: 2000,
  })
).stdout.trim();
assert.equal(
  (
    await execute("git", ["-C", first, "branch", "--show-current"], {
      env: cleanManagerEnvironment(),
      timeout: 2000,
    })
  ).stdout.trim(),
  "",
  "Gate expects disposable detached worktrees",
);
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
Object.assign(env, {
  TMUX: `${sentinelSocket},1,0`,
  TMUX_IDE_HOME: sentinelState,
  TMUX_IDE_TMUX_SOCKET_PATH: sentinelSocket,
  TMUX_IDE_DAEMON_INFO_DIR: sentinelState,
  TMUX_IDE_REGISTRY_DIR: sentinelState,
  TMUX_IDE_SETTINGS_DIR: sentinelState,
  TMUX_IDE_CLI: secondBuild.cli,
});
try {
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
  knownPids.add(sentinelChild.pid!);
  knownPids.add(sentinelPid);
  await wait(
    async () =>
      inspectCanonicalDaemonInfoPath(join(sentinelState, "daemon.json")).status === "valid",
  );
  const sentinelBeforeLaunch = await fingerprint(sentinelSocket, sentinelChild!.pid!);
  env.TMUX = `${sentinelSocket},${sentinelPid},0`;
  const up = await Promise.all([cli(0, "up"), cli(1, "up"), cli(0, "up")]);
  assert.equal(up[0].daemon.pid, up[2].daemon.pid);
  currentOwnPid = up[0].daemon.pid;
  currentSiblingPid = up[1].daemon.pid;
  for (const status of up) {
    knownPids.add(status.daemon.pid);
    knownPids.add(status.tmux.pid);
  }
  receipt.concurrentUp = up.slice(0, 2);
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
  const own = await fingerprint(up[0].tmux.socket, up[0].daemon.pid);
  const sibling = await fingerprint(up[1].tmux.socket, up[1].daemon.pid);
  const sentinel = await fingerprint(sentinelSocket, sentinelChild.pid!);
  assert.deepEqual(sentinel, sentinelBeforeLaunch);
  async function assertProtected() {
    assert.deepEqual(await fingerprint(up[1].tmux.socket, up[1].daemon.pid), sibling);
    assert.deepEqual(await fingerprint(sentinelSocket, sentinelChild!.pid!), sentinel);
  }
  const markers = [
    join(instances[0]!.stateHome, "machines.json"),
    join(instances[1]!.stateHome, "machines.json"),
    join(sentinelState, "machines.json"),
  ];
  markers.forEach((path, index) =>
    writeFileSync(path, JSON.stringify({ fixture: index, machines: [] }), { mode: 0o600 }),
  );
  const markerBytes = markers.map((path) => readFileSync(path, "utf8"));
  async function checkpoint(phase: string) {
    await assertProtected();
    markers.forEach((path, index) => {
      if (index > 0) assert(existsSync(path), "Protected machine file disappeared");
      if (existsSync(path)) assert.equal(readFileSync(path, "utf8"), markerBytes[index]);
    });
    const roots = [
      currentOwnPid,
      currentSiblingPid,
      sentinelChild!.pid!,
      sentinelPid,
      up[1].tmux.pid,
    ];
    if (ownTmuxExpected) {
      assert(existsSync(up[0].tmux.socket));
      roots.push(up[0].tmux.pid);
    }
    for (const [index, client] of clients.entries()) {
      if (!retiredClients.has(index)) assert(!client.exited, "Expected live native app exited");
      if (!client.exited) roots.push(client.pid);
    }
    const sample = await sampleIsolationResources(
      [...new Set(roots.filter(Boolean))],
      developmentProcessIdentity,
    );
    for (const child of sample.processes) knownPids.add(child.pid);
    resourceSamples.push({ phase, gateOwnedSubscriptions: streams.size, ...sample });
    return sample;
  }
  await checkpoint("concurrent-up");
  const alias = join(sentinelRoot, "worktree alias with spaces");
  symlinkSync(first, alias);
  assert.equal(resolveDevelopmentInstance({ worktree: alias, store }).id, instances[0]!.id);
  assert(
    instances[1]!.worktree.length >= 100,
    "Second worktree must exercise a long canonical path",
  );
  assert(up[1].tmux.socket.length < 104);
  branchName = `d08-fixture-${randomUUID()}`;
  await execute("git", ["-C", first, "switch", "-c", branchName], {
    env: cleanManagerEnvironment(),
    timeout: 2000,
  });
  branchChanged = true;
  assert.equal((await cli(0, "status")).instance.id, instances[0]!.id);
  assert.equal((await cli(0, "status")).daemon.pid, currentOwnPid);
  receipt.pathAndBranch = {
    aliasIdentityStable: true,
    canonicalPathLength: instances[1]!.worktree.length,
    socketLength: up[1].tmux.socket.length,
    branchIdentityStable: true,
  };
  await checkpoint("branch-and-alias");
  const pty = createRequire(secondBuild.cli)("node-pty");
  const { Terminal } = createRequire(
    new URL("../../packages/daemon/package.json", import.meta.url),
  )("@tmux-ide/xterm-headless");
  for (let index = 0; index < 2; index++) {
    const child = pty.spawn("pnpm", ["--silent", "dev:instance", "app", "--store", store], {
      cwd: instances[index]!.worktree,
      env: { ...env, TERM: "xterm-256color" },
      cols: 100,
      rows: 30,
    });
    const vt = new Terminal({ cols: 100, rows: 30, allowProposedApi: true });
    const client: Client = {
      pid: child.pid,
      exited: false,
      write: (data) => child.write(data),
      kill: (signal) => child.kill(signal),
      frame: () =>
        Array.from(
          { length: 30 },
          (_, row) => vt.buffer.active.getLine(row)?.translateToString(true) ?? "",
        ).join("\n"),
      dispose: () => vt.dispose(),
    };
    clients.push(client);
    knownPids.add(client.pid);
    child.onData((data: string) => vt.write(data));
    child.onExit(() => {
      client.exited = true;
    });
    await wait(async () => {
      assert(!client.exited, "Native app exited");
      return client.frame().includes(`DEV ${instances[index]!.id.slice(4, 10)}`);
    });
    client.write("\x1b[15~");
    await new Promise((resolve) => setTimeout(resolve, 200));
    client.write("shared");
    await wait(async () => client.frame().includes("shared"));
    client.write("\r");
    await tmuxRead(up[index].tmux.socket, [
      "send-keys",
      "-t",
      "shared.0",
      "-l",
      `printf 'd08_open_${index}\\n'`,
    ]);
    await tmuxRead(up[index].tmux.socket, ["send-keys", "-t", "shared.0", "Enter"]);
    await wait(async () => client.frame().includes(`d08_open_${index}`));
  }
  async function input(index: number, marker: string) {
    const client = clients[index]!;
    client.write("\x1b[<0;50;7M\x1b[<0;50;7m");
    await new Promise((resolve) => setTimeout(resolve, 250));
    client.write(`printf '${marker}_\\157k\\n'\r`);
    await wait(async () => {
      assert(!client.exited);
      return client.frame().includes(`${marker}_ok`);
    });
    assert(!clients[1 - index]!.frame().includes(`${marker}_ok`), "Input escaped to sibling");
  }
  await input(0, "d08_a_before");
  await input(1, "d08_b_before");
  const streamBaseline = await checkpoint("before-streams");
  const descriptor = info(join(instances[0]!.stateHome, "daemon.json"));
  for (let round = 0; round < 3; round++) {
    const drains: Promise<unknown>[] = [];
    for (let n = 0; n < 4; n++) {
      const controller = new AbortController();
      streams.add(controller);
      const response = await fetch(`http://127.0.0.1:${descriptor.port}/api/logs/daemon`, {
        headers: { Authorization: `Bearer ${descriptor.authToken}` },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
        redirect: "error",
      });
      assert(response.ok && response.body);
      const reader = response.body.getReader();
      drains.push(
        (async () => {
          try {
            while (!(await reader.read()).done) {
              /* bounded discard, no payload capture */
            }
          } catch {
            /* cancellation expected */
          } finally {
            reader.releaseLock();
            streams.delete(controller);
          }
        })(),
      );
    }
    assert.equal(streams.size, 4);
    await checkpoint(`streams-open-${round}`);
    for (const controller of streams) controller.abort();
    await Promise.all(drains);
    assert.equal(streams.size, 0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const closed = await checkpoint(`streams-closed-${round}`);
    assert(
      closed.fdCounts[currentOwnPid] <= streamBaseline.fdCounts[currentOwnPid] + 8,
      "Stream cancellation must return daemon FDs near baseline",
    );
  }
  receipt.streamCancellation = {
    rounds: 3,
    perRound: 4,
    remaining: streams.size,
    internalListenerCensus: false,
  };
  const beforeCrash = await developmentProcessIdentity(currentOwnPid);
  assert(beforeCrash && beforeCrash === own.incarnation);
  process.kill(currentOwnPid, "SIGKILL");
  await wait(async () => (await developmentProcessIdentity(currentOwnPid)) === null);
  const crashRecovered = await cli(0, "up");
  currentOwnPid = crashRecovered.daemon.pid;
  knownPids.add(currentOwnPid);
  assert.notEqual(currentOwnPid, own.daemonPid);
  const recoveredFingerprint = await fingerprint(up[0].tmux.socket, currentOwnPid);
  assert.equal(recoveredFingerprint.panes, own.panes);
  assert.equal(recoveredFingerprint.socketIno, own.socketIno);
  assert.equal(recoveredFingerprint.tmuxPid, own.tmuxPid);
  receipt.crashRecovery = crashRecovered;
  await tmuxRead(up[0].tmux.socket, [
    "send-keys",
    "-t",
    "shared.0",
    "-l",
    "printf 'd08_crash_delivery\\n'",
  ]);
  await tmuxRead(up[0].tmux.socket, ["send-keys", "-t", "shared.0", "Enter"]);
  await wait(async () => clients[0]!.frame().includes("d08_crash_delivery"));
  await input(0, "d08_after_crash");
  await checkpoint("crash-recovered");
  const restarted = await cli(0, "restart");
  assert.equal(restarted.daemon.pid, currentOwnPid);
  assert.notEqual(restarted.daemon.instanceId, crashRecovered.daemon.instanceId);
  assert.deepEqual(
    await fingerprint(up[0].tmux.socket, restarted.daemon.pid),
    recoveredFingerprint,
  );
  await assertProtected();
  receipt.restartPreservedExactProcesses = true;
  await tmuxRead(up[0].tmux.socket, [
    "send-keys",
    "-t",
    "shared.0",
    "-l",
    "printf 'd08_restart_delivery\\n'",
  ]);
  await tmuxRead(up[0].tmux.socket, ["send-keys", "-t", "shared.0", "Enter"]);
  await wait(async () => clients[0]!.frame().includes("d08_restart_delivery"));
  await input(0, "d08_after_restart");
  await input(1, "d08_sibling_after");
  receipt.frames = clients.map((client, index) => ({
    index,
    instanceId: instances[index]!.id,
    frame: client.frame(),
  }));
  await checkpoint("runtime-restart");
  await cli(0, "down", ["--daemon-only"]);
  assert.equal(await developmentProcessIdentity(currentOwnPid), null);
  currentOwnPid = 0;
  const stopped = await fingerprint(up[0].tmux.socket, up[0].daemon.pid);
  assert.equal(stopped.panes, own.panes);
  assert.equal(stopped.tmuxPid, own.tmuxPid);
  assert.equal(stopped.socketIno, own.socketIno);
  await assert.rejects(cli(0, "reset", ["--yes"]));
  await assertProtected();
  receipt.daemonOnlyPreservedPanesAndAppGate = true;
  await checkpoint("daemon-only-down");
  const ownerPath = join(instances[0]!.root, "owner.json");
  const originalOwner = readFileSync(ownerPath, "utf8");
  const owner = JSON.parse(originalOwner);
  writeDevelopmentRecord(ownerPath, {
    ...owner,
    pid: sentinelChild!.pid!,
    incarnation: "fixture-reused-pid-incarnation",
  });
  try {
    await assert.rejects(cli(0, "down"));
    await assertProtected();
    receipt.reusedPidProtected = true;
  } finally {
    writeFileSync(ownerPath, originalOwner, { mode: 0o600 });
  }
  const lock = join(instances[0]!.root, "locks", "lifecycle");
  mkdirSync(lock, { mode: 0o700 });
  writeDevelopmentRecord(join(lock, "owner.json"), {
    pid: own.daemonPid,
    incarnation: own.incarnation,
    token: randomUUID(),
  });
  const resumed = await cli(0, "up");
  currentOwnPid = resumed.daemon.pid;
  knownPids.add(currentOwnPid);
  receipt.deadLockRecovered = true;
  await checkpoint("dead-lock-recovered");
  assert.notEqual(resumed.daemon.pid, up[0].daemon.pid);
  assert.equal((await fingerprint(up[0].tmux.socket, resumed.daemon.pid)).panes, own.panes);
  await cli(0, "down");
  currentOwnPid = 0;
  ownTmuxExpected = false;
  await cli(0, "down");
  assert.equal(existsSync(up[0].tmux.socket), false);
  await assert.rejects(cli(0, "reset", ["--yes"]));
  await assertProtected();
  receipt.fullDownPreservedSiblingSentinelAndAppGate = true;
  await checkpoint("full-down");
  retiredClients.add(0);
  clients[0]!.write("\x11");
  await wait(async () => clients[0]!.exited);
  renameSync(first, `${first}-d08-moved`);
  moved = true;
  const idFlags = ["--id", instances[0]!.id];
  const orphan = await cli(0, "status", idFlags);
  assert.equal(orphan.worktreeState, "missing");
  await cli(0, "reset", [...idFlags, "--yes"]);
  await cli(0, "reset", [...idFlags, "--yes"]);
  assert.equal(existsSync(join(instances[0]!.root, "artifacts")), false);
  await assertProtected();
  receipt.orphanResetVerified = true;
  await checkpoint("orphan-reset");
  receipt.resources = resourceSamples;
  receipt.sibling = sibling;
  receipt.sentinel = sentinel;
  receipt.own = own;
  receipt.completed = true;
} catch (error) {
  receipt.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  const cleanupErrors: string[] = [];
  const attemptCleanup = async (step: string, action: () => Promise<void>) => {
    try {
      await action();
    } catch {
      cleanupErrors.push(step);
    }
  };
  for (const controller of streams) controller.abort();
  await Promise.allSettled(
    clients.map((client, index) =>
      attemptCleanup(`app-${index}`, async () => {
        if (!client.exited) {
          client.write("\x11");
          await wait(async () => client.exited).catch(() => client.kill("SIGTERM"));
          await wait(async () => client.exited);
        }
        client.dispose();
      }),
    ),
  );
  await attemptCleanup("restore-worktree", async () => {
    if (moved) renameSync(`${first}-d08-moved`, first);
    if (branchChanged) {
      await execute("git", ["-C", first, "switch", "--detach", originalHead], {
        env: cleanManagerEnvironment(),
        timeout: 2000,
      });
      await execute("git", ["-C", first, "branch", "-D", branchName], {
        env: cleanManagerEnvironment(),
        timeout: 2000,
      });
    }
  });
  const cleanup = await Promise.allSettled([cli(0, "down"), cli(1, "down")]);
  receipt.cleanup = cleanup.map((result) => result.status);
  await attemptCleanup("sentinel-daemon", async () => {
    if (
      sentinelChild?.pid &&
      sentinelIncarnation &&
      (await developmentProcessIdentity(sentinelChild.pid)) === sentinelIncarnation
    ) {
      const record = info(join(sentinelState, "daemon.json"));
      const response = await fetch(
        `http://127.0.0.1:${record.port}/api/v2/action/daemon.shutdown`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${record.authToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ expectedInstanceId: record.instanceId }),
          redirect: "error",
          signal: AbortSignal.timeout(2000),
        },
      );
      assert(response.ok);
      await wait(async () => (await developmentProcessIdentity(sentinelChild!.pid!)) === null);
    }
  });
  await attemptCleanup("sentinel-tmux", async () => {
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
  });
  await attemptCleanup("sentinel-state", async () => {
    if (sentinelChild?.pid && (await developmentProcessIdentity(sentinelChild.pid)) !== null)
      throw new Error("Sentinel daemon remains alive or replaced");
    if (sentinelPid && (await developmentProcessIdentity(sentinelPid)) !== null)
      throw new Error("Sentinel remains alive");
    if (sentinelIdentity && existsSync(sentinelSocket))
      rmSync(revalidateUnixSocketIdentity(sentinelIdentity));
    rmSync(sentinelRoot, { recursive: true });
  });
  receipt.cleanupErrors = cleanupErrors;
  receipt.processesGone = (
    await Promise.allSettled([...knownPids].map(developmentProcessIdentity))
  ).every((result) => result.status === "fulfilled" && result.value === null);
  receipt.appsExited = clients.every((client) => client.exited);
  receipt.remainingSubscriptions = streams.size;
  receipt.resources = resourceSamples;
  receipt.ok =
    receipt.completed === true &&
    cleanupErrors.length === 0 &&
    receipt.processesGone &&
    clients.every((client) => client.exited) &&
    streams.size === 0 &&
    cleanup.every((result) => result.status === "fulfilled");
  receipt.linuxQualified = receipt.ok === true && process.platform === "linux";
  receipt.macosQualified = receipt.ok === true && process.platform === "darwin";
  writeFileSync(join(store, "d08-qualification.json"), JSON.stringify(receipt, null, 2));
  if (receipt.completed) assert.equal(receipt.ok, true);
}

process.stdout.write(
  `${JSON.stringify({ ok: receipt.ok, platform: process.platform, receipt: join(store, "d08-qualification.json") })}\n`,
);
