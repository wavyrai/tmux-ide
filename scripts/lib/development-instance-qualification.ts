/** Opt-in D04 acceptance using two explicitly supplied, prepared scratch worktrees. */
import assert from "node:assert/strict";

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDevelopmentInstance } from "../../packages/daemon/src/lib/development-instance.ts";
import {
  readDevelopmentBuild,
  developmentBuildLaunch,
} from "../../packages/daemon/src/lib/development-build.ts";
import { buildDevelopmentInstance } from "../../packages/daemon/src/lib/development-build-manager.ts";
import {
  developmentAppLaunch,
  statusDevelopmentInstance,
  type DevelopmentStatus,
} from "../../packages/daemon/src/lib/development-lifecycle.ts";
import {
  developmentProcessIdentity,
  readDevelopmentOwner,
  readPrivateDevelopmentRecord,
  cleanManagerEnvironment,
} from "../../packages/daemon/src/lib/development-state.ts";
import { inspectCanonicalDaemonInfoPath } from "../../packages/daemon/src/lib/canonical-daemon.ts";
import { revalidateUnixSocketIdentity } from "../../packages/daemon/src/lib/unix-socket-authority.ts";
const execute = promisify(execFile);
const { Terminal } = createRequire(new URL("../../packages/daemon/package.json", import.meta.url))(
  "@tmux-ide/xterm-headless",
);
const [first, second, store, bun] = process.argv.slice(2);
if (!first || !second || !store || !bun)
  throw new Error("Expected two owned scratch worktrees, store, pinned Bun");
const instances = [first, second].map((worktree) =>
  resolveDevelopmentInstance({ worktree, store }),
);
const environment = {
  ...cleanManagerEnvironment(),
  TMUX: "/not-selected,1,0",
  TMUX_PANE: "%999",
  TMUX_IDE_HOME: "/not-selected",
  TMUX_IDE_RUNTIME_MODE: "production",
};
async function cli(index: number, command: string) {
  const root = instances[index]!.worktree;
  const result = await execute(
    process.execPath,
    [
      join(root, "node_modules/tsx/dist/cli.mjs"),
      join(root, "scripts/development-instance.ts"),
      command,
      "--store",
      store!,
      "--json",
    ],
    {
      cwd: root,
      env: environment,
      encoding: "utf8",
      timeout: 45000,
      killSignal: "SIGKILL",
      maxBuffer: 256 * 1024,
    },
  );
  return JSON.parse(result.stdout) as DevelopmentStatus;
}
function info(index: number) {
  const state = inspectCanonicalDaemonInfoPath(join(instances[index]!.stateHome, "daemon.json"));
  assert.equal(state.status, "valid");
  if (state.status !== "valid") throw new Error("missing daemon");
  return state.info;
}
async function action(index: number, action: string) {
  const state = info(index);
  const response = await fetch(`http://127.0.0.1:${state.port}/api/v2/action/${action}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${state.authToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expectedInstanceId: state.instanceId }),
    redirect: "error",
    signal: AbortSignal.timeout(2000),
  });
  assert.equal(response.ok, true);
}
async function waitFor(check: () => Promise<boolean>, limit = 10000) {
  const until = Date.now() + limit;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Qualification condition timed out");
}
async function cleanup(index: number) {
  const instance = instances[index]!;
  const owner = readDevelopmentOwner(instance);
  if (owner && (await developmentProcessIdentity(owner.pid)) === owner.incarnation) {
    await action(index, "daemon.shutdown");
    await waitFor(async () => (await developmentProcessIdentity(owner.pid)) === null);
  }
  const tmux = readPrivateDevelopmentRecord<{
    pid: number;
    incarnation: string;
    executable: string;
    socket: { path: string; dev: number; ino: number; mtimeNs: string; birthtimeNs: string };
    capability: string;
  }>(join(instance.root, "tmux.json"));
  if (tmux && (await developmentProcessIdentity(tmux.pid)) === tmux.incarnation) {
    const socket = revalidateUnixSocketIdentity({
      ...tmux.socket,
      mtimeNs: BigInt(tmux.socket.mtimeNs),
      birthtimeNs: BigInt(tmux.socket.birthtimeNs),
    });
    const { stdout } = await execute(
      tmux.executable,
      ["-S", socket, "display-message", "-p", "#{pid}|#{@tmux_ide_development_owner}"],
      { env: cleanManagerEnvironment(), encoding: "utf8", timeout: 2000 },
    );
    assert.equal(stdout.trim(), `${tmux.pid}|${tmux.capability}`);
    await execute(tmux.executable, ["-S", socket, "kill-server"], {
      env: cleanManagerEnvironment(),
      timeout: 2000,
    });
    await waitFor(async () => (await developmentProcessIdentity(tmux.pid)) === null);
  }
  if (owner) assert.equal(await developmentProcessIdentity(owner.pid), null);
  if (tmux) {
    assert.equal(await developmentProcessIdentity(tmux.pid), null);
    if (existsSync(tmux.socket.path)) {
      const stale = revalidateUnixSocketIdentity({
        ...tmux.socket,
        mtimeNs: BigInt(tmux.socket.mtimeNs),
        birthtimeNs: BigInt(tmux.socket.birthtimeNs),
      });
      unlinkSync(stale);
    }
    assert.equal(existsSync(tmux.socket.path), false);
  }
}
// This harness exclusively owns the supplied scratch instances, including a prior probe run.
for (let index = 0; index < 2; index++) await cleanup(index);
const apps: { kill: (signal?: string) => void; write: (data: string) => void }[] = [];
const receipts: Record<string, unknown> = {};
try {
  const upOutcomes = await Promise.allSettled([
    cli(0, "up"),
    cli(0, "up"),
    cli(1, "up"),
    cli(1, "up"),
  ]);
  const up = upOutcomes.map((outcome) => {
    if (outcome.status === "rejected") throw outcome.reason;
    return outcome.value;
  });
  assert.equal(up[0]!.state, "ready");
  assert.equal(up[2]!.state, "ready");
  assert.equal(up[0]!.daemon!.pid, up[1]!.daemon!.pid);
  assert.equal(up[2]!.daemon!.pid, up[3]!.daemon!.pid);
  assert.notEqual(up[0]!.daemon!.pid, up[2]!.daemon!.pid);
  assert.notEqual(up[0]!.tmux!.socket, up[2]!.tmux!.socket);
  receipts.concurrentUp = up;
  // These are fresh CLI processes after all short up processes have exited.
  assert.equal((await cli(0, "status")).daemon!.pid, up[0]!.daemon!.pid);
  assert.equal((await cli(1, "status")).daemon!.pid, up[2]!.daemon!.pid);
  for (let index = 0; index < 2; index++) {
    const instance = instances[index]!;
    const build = readDevelopmentBuild(instance, {});
    const name = index === 0 ? "d04-a" : "d04-b";
    await execute(
      join(build.assets, "tmux", `${process.platform}-${process.arch}`, "tmux"),
      [
        "-S",
        join(instance.runtimeDir, "tmux.sock"),
        "new-session",
        "-d",
        "-s",
        name,
        "-c",
        instance.worktree,
        "/bin/sh",
        ";",
        "set-option",
        "-t",
        name,
        "@tmux_ide_adopted",
        "1",
      ],
      { env: cleanManagerEnvironment(), timeout: 2000 },
    );
    await waitFor(async () => {
      const state = info(index);
      const response = await fetch(`http://127.0.0.1:${state.port}/api/resources/fleet-catalog`, {
        headers: { Authorization: `Bearer ${state.authToken}` },
        signal: AbortSignal.timeout(2000),
      });
      const text = await response.text();
      return text.includes(name) && !text.includes(index === 0 ? "d04-b" : "d04-a");
    });
  }
  receipts.disjointCatalogs = true;
  // Replay the consumed hidden entry using its original private admission. It
  // must fail without changing the healthy owner's record or process.
  const originalOwner = readDevelopmentOwner(instances[0]!)!;
  const admitted = await developmentAppLaunch(instances[0]!);
  const admittedBuild = readDevelopmentBuild(instances[0]!, admitted.env);
  await assert.rejects(
    execute(admittedBuild.tools.node, [admittedBuild.cli, "--development-owner"], {
      cwd: instances[0]!.root,
      env: { ...admitted.env, TMUX_IDE_DEVELOPMENT_ATTEMPT: originalOwner.attempt },
      timeout: 5000,
      maxBuffer: 64 * 1024,
    }),
  );
  assert.deepEqual(readDevelopmentOwner(instances[0]!), originalOwner);
  assert.equal((await cli(0, "status")).state, "ready");
  receipts.duplicateOwnerReplayRejected = true;
  const active = up[0]!.activeBuild!.generation;
  const replacement = await buildDevelopmentInstance(instances[0]!, { bun });
  const retained = await cli(0, "up");
  assert.equal(retained.activeBuild!.generation, active);
  assert.equal(retained.selectedBuild!.generation, replacement.generation);
  assert.equal(retained.daemon!.pid, up[0]!.daemon!.pid);
  const app = await developmentAppLaunch(instances[0]!);
  assert.equal(app.env.TMUX_IDE_DEVELOPMENT_BUILD, active);
  assert.equal(app.env.HOME, process.env.HOME);
  assert.equal(app.env.TMUX, undefined);
  receipts.activeBuildRetained = true;
  const oldUuid = info(0).instanceId;
  await action(0, "daemon.restart");
  await waitFor(async () => {
    const status = await statusDevelopmentInstance(instances[0]!);
    return status.state === "ready" && status.daemon!.instanceId !== oldUuid;
  });
  const reset = await cli(0, "up");
  assert.equal(reset.daemon!.pid, up[0]!.daemon!.pid);
  assert.equal(reset.activeBuild!.generation, active);
  receipts.runtimeResetRetainedProcess = true;
  const pty = createRequire(
    readDevelopmentBuild(
      instances[0]!,
      developmentBuildLaunch(readDevelopmentBuild(instances[0]!, {})).environment,
    ).cli,
  )("node-pty");
  const rendered = await Promise.all(
    instances.map(async (instance, index) => {
      const terminal = pty.spawn("pnpm", ["--silent", "dev:instance", "app", "--store", store!], {
        cwd: instance.worktree,
        env: { ...environment, TERM: "xterm-256color", COLORTERM: "truecolor" },
        cols: 110,
        rows: 32,
      });
      apps.push(terminal);
      const vt = new Terminal({ cols: 110, rows: 32, allowProposedApi: true });
      const frame = () =>
        Array.from(
          { length: vt.rows },
          (_, row) => vt.buffer.active.getLine(row)?.translateToString(true) ?? "",
        ).join("\n");
      const expected = index === 0 ? "d04-a" : "d04-b";
      const sibling = index === 0 ? "d04-b" : "d04-a";
      let output = "";
      let exited = false;
      terminal.onData((data: string) => {
        output = (output + data).slice(-256 * 1024);
        vt.write(data);
      });
      terminal.onExit(() => {
        exited = true;
      });
      await waitFor(async () => {
        if (exited) throw new Error(`App ${index} exited before rendering: ${output.slice(-1500)}`);
        return output.includes("\x1b[") && output.length > 2000;
      }, 15000);
      terminal.write("\x1b[15~");
      await new Promise((resolve) => setTimeout(resolve, 200));
      terminal.write(expected);
      await waitFor(async () => frame().includes(expected));
      assert.equal(frame().includes(sibling), false);
      terminal.write("\r");
      await new Promise((resolve) => setTimeout(resolve, 500));
      terminal.write("printf 'd04_input_\\157k\\n'\r");
      await waitFor(async () => frame().includes("d04_input_ok"), 10000);
      const visible = frame();
      terminal.write("\x11");
      await waitFor(async () => exited, 5000);
      vt.dispose();
      return {
        index,
        renderedBytes: output.length,
        expectedSession: expected,
        inputEcho: true,
        frame: visible,
      };
    }),
  );
  receipts.apps = rendered;
  assert.equal((await cli(0, "status")).state, "ready");
  assert.equal((await cli(1, "status")).state, "ready");
  receipts.completed = true;
} catch (error) {
  receipts.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  for (const app of apps)
    try {
      app.kill("SIGTERM");
    } catch {
      /* Already exited app is safe. */
    }
  const cleaned = await Promise.allSettled([cleanup(0), cleanup(1)]);
  receipts.cleanup = cleaned.map((result) => result.status);
  receipts.ok =
    receipts.completed === true && cleaned.every((result) => result.status === "fulfilled");
  writeFileSync(join(store, "d04-qualification.json"), JSON.stringify(receipts, null, 2));
  if (receipts.completed) assert.equal(receipts.ok, true, "Owned cleanup must succeed");
}
process.stdout.write(`${JSON.stringify(receipts, null, 2)}\n`);
