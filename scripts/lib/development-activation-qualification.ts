/** Opt-in D07 proof: caller supplies two owned source roots and their existing store. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { resolveDevelopmentInstance } from "../../packages/daemon/src/lib/development-instance.ts";
import { readDevelopmentBuild } from "../../packages/daemon/src/lib/development-build.ts";
import { activateDevelopmentInstance } from "../../packages/daemon/src/lib/development-control.ts";
import {
  cleanManagerEnvironment,
  developmentProcessIdentity,
  readDevelopmentActivation,
  readPrivateDevelopmentRecord,
} from "../../packages/daemon/src/lib/development-state.ts";
import { captureUnixSocketIdentity } from "../../packages/daemon/src/lib/unix-socket-authority.ts";
const execute = promisify(execFile);
const [first, second, store, bun] = process.argv.slice(2);
assert(first && second && store && bun);
const instances = [first, second].map((worktree) =>
  resolveDevelopmentInstance({ worktree, store }),
);
const env = {
  ...cleanManagerEnvironment(),
  TMUX: "/wrong,1,0",
  TMUX_PANE: "%999",
  TMUX_IDE_RUNTIME_MODE: "production",
  TMUX_IDE_HOME: "/wrong-state",
};
async function cli(index: number, command: string, flags: string[] = [], recorded = false) {
  const instance = instances[index]!;
  const result = await execute(
    process.execPath,
    [
      "--no-deprecation",
      "--import",
      join(process.cwd(), "node_modules/tsx/dist/loader.mjs"),
      join(process.cwd(), "scripts/development-instance.ts"),
      command,
      ...(recorded ? ["--id", instance.id] : ["--worktree", instance.worktree]),
      "--store",
      store!,
      "--json",
      ...flags,
    ],
    {
      cwd: process.cwd(),
      env,
      timeout: command === "rebuild" ? 300000 : 45000,
      killSignal: "SIGKILL",
      maxBuffer: 256 * 1024,
    },
  );
  return JSON.parse(result.stdout);
}
async function wait(check: () => boolean | Promise<boolean>, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("D07 qualification timed out");
}
async function tmux(index: number, args: string[]) {
  const instance = instances[index]!;
  const record = readPrivateDevelopmentRecord<{ executable: string; socket: { path: string } }>(
    join(instance.root, "tmux.json"),
  );
  assert(record);
  return (
    await execute(record.executable, ["-S", record.socket.path, "-N", ...args], {
      env: cleanManagerEnvironment(),
      encoding: "utf8",
      timeout: 2000,
    })
  ).stdout.trim();
}
async function fingerprint(index: number) {
  const socket = captureUnixSocketIdentity(join(instances[index]!.runtimeDir, "tmux.sock"));
  return {
    server: await tmux(index, ["display-message", "-p", "#{pid}"]),
    socketDev: socket.dev,
    socketIno: socket.ino,
    panes: await tmux(index, ["list-panes", "-t", "shared", "-F", "#{pane_id}|#{pane_pid}"]),
  };
}
const { Terminal } = createRequire(new URL("../../packages/daemon/package.json", import.meta.url))(
  "@tmux-ide/xterm-headless",
);
type Client = {
  index: number;
  exited: boolean;
  frame(): string;
  write(data: string): void;
  kill(signal: string): void;
  dispose(): void;
};
const clients: Client[] = [];
const receipt: Record<string, unknown> = { version: 1 };
let admitted: { daemon: { pid: number; instanceId: string }; tmux: { pid: number } }[] = [];
const daemonPids = new Set<number>();
const changedPath = join(first, "packages/daemon/src/lib/development-owner.ts");
const original = readFileSync(changedPath, "utf8");
async function freshDelivery(marker: string) {
  const start = Date.now();
  await tmux(0, ["send-keys", "-t", "shared.0", "-l", `printf '${marker}\\n'`]);
  await tmux(0, ["send-keys", "-t", "shared.0", "Enter"]);
  await wait(() => clients.slice(0, 2).every((client) => client.frame().includes(marker)));
  receipt[marker] = { observedByExistingClients: 2, milliseconds: Date.now() - start };
}
let moved = false;
try {
  const up = await Promise.all([cli(0, "up"), cli(1, "up")]);
  admitted = up;
  up.forEach((status) => {
    assert.equal(status.state, "ready");
    daemonPids.add(status.daemon.pid);
  });
  receipt.before = up;
  for (let index = 0; index < 2; index++)
    await tmux(index, [
      "new-session",
      "-d",
      "-s",
      "shared",
      "-c",
      instances[index]!.worktree,
      "/bin/sh",
      ";",
      "set-option",
      "-t",
      "shared",
      "@tmux_ide_adopted",
      "1",
    ]);
  const panes = await Promise.all([fingerprint(0), fingerprint(1)]);
  receipt.panes = panes;
  receipt.initialStamps = await tmux(0, [
    "list-panes",
    "-a",
    "-F",
    "#{session_name}|#{pane_id}|#{@tmux_ide_pane_id}|#{@tmux_ide_window_id}",
  ]);
  const pty = createRequire(readDevelopmentBuild(instances[0]!, {}).cli)("node-pty");
  for (const index of [0, 0, 1]) {
    const terminal = pty.spawn("pnpm", ["--silent", "dev:instance", "app", "--store", store!], {
      cwd: instances[index]!.worktree,
      env: { ...env, TERM: "xterm-256color", COLORTERM: "truecolor" },
      cols: 100,
      rows: 32,
    });
    const vt = new Terminal({ cols: 100, rows: 32, allowProposedApi: true });
    const client: Client = {
      index,
      exited: false,
      frame: () =>
        Array.from(
          { length: vt.rows },
          (_, row) => vt.buffer.active.getLine(row)?.translateToString(true) ?? "",
        ).join("\n"),
      write: (data) => terminal.write(data),
      kill: (signal) => terminal.kill(signal),
      dispose: () => vt.dispose(),
    };
    clients.push(client);
    terminal.onData((data: string) => vt.write(data));
    terminal.onExit(() => {
      client.exited = true;
    });
    await wait(() => {
      assert(!client.exited, "Client exited before chrome");
      return client.frame().includes(`DEV ${instances[index]!.id.slice(4, 10)}`);
    });
    terminal.write("\x1b[15~");
    await new Promise((resolve) => setTimeout(resolve, 200));
    terminal.write("shared");
    await wait(() => client.frame().includes("shared"));
    terminal.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  async function input(client: Client, marker: string) {
    // Each client must explicitly acquire pane input authority; another
    // already-open client may own it after its initial focus admission.
    client.write("\x1b[<0;50;7M\x1b[<0;50;7m");
    await new Promise((resolve) => setTimeout(resolve, 250));
    client.write(`printf '${marker}_\\157k\\n'\r`);
    await wait(() => {
      assert(!client.exited, "Existing client exited");
      return client.frame().includes(`${marker}_ok`);
    });
  }
  await input(clients[0]!, "d07_before");
  await input(clients[2]!, "d07_sibling_before");
  const initialDiagnostics = await cli(0, "diagnostics");
  const tuiPids = initialDiagnostics.tui.recordedLaunches
    .map((app: { pid: number }) => app.pid)
    .sort();
  assert.equal(tuiPids.length, 2);

  // Preflight must protect a ready owner when the recorded worktree disappears.
  renameSync(first, `${first}-d07-moved`);
  moved = true;
  try {
    await assert.rejects(
      cli(0, "restart", ["--apply-build"], true),
      (error: unknown) =>
        JSON.parse((error as { stdout: string }).stdout).reason === "identity-unavailable",
    );
  } finally {
    renameSync(`${first}-d07-moved`, first);
    moved = false;
  }
  assert.equal((await cli(0, "status")).daemon.pid, up[0].daemon.pid);
  receipt.missingWorktreeProtected = true;

  const pointer = readFileSync(join(instances[0]!.root, "build.json"), "utf8");
  await assert.rejects(
    cli(0, "rebuild", ["--bun", "/missing-private-fixture-bun"]),
    (error: unknown) => JSON.parse((error as { stdout: string }).stdout).reason === "build-failed",
  );
  assert.equal(readFileSync(join(instances[0]!.root, "build.json"), "utf8"), pointer);
  assert.equal((await cli(0, "status")).daemon.pid, up[0].daemon.pid);
  await input(clients[1]!, "d07_failed_build");
  receipt.failedBuildPreservedRuntime = true;

  assert(original.includes("Managed owner executable is not the selected build"));
  writeFileSync(
    changedPath,
    original.replace(
      "Managed owner executable is not the selected build",
      "Managed owner executable is not the selected immutable build",
    ),
  );
  const rebuilt = await cli(0, "rebuild", ["--bun", bun]);
  receipt.rebuild = rebuilt;
  assert.equal(rebuilt.changed.cli, true);
  assert.notEqual(rebuilt.built.generation, rebuilt.activeBuild.generation);
  assert.equal((await cli(0, "status")).daemon.pid, up[0].daemon.pid);
  const activated = await Promise.all([
    cli(0, "restart", ["--apply-build"]),
    cli(0, "restart", ["--apply-build"]),
  ]);
  assert.equal(activated[0].daemon.pid, activated[1].daemon.pid);
  assert.notEqual(activated[0].daemon.pid, up[0].daemon.pid);
  daemonPids.add(activated[0].daemon.pid);
  assert.equal(await developmentProcessIdentity(up[0].daemon.pid), null);
  assert.equal(activated[0].activeBuild.generation, rebuilt.built.generation);
  assert.equal(activated[0].tmux.generation, up[0].tmux.generation);
  receipt.activated = activated;
  receipt.postActivationStamps = await tmux(0, [
    "list-panes",
    "-a",
    "-F",
    "#{session_name}|#{pane_id}|#{@tmux_ide_pane_id}|#{@tmux_ide_window_id}",
  ]);
  await freshDelivery("d07_activation_delivery");
  await input(clients[0]!, "d07_after_activation");
  await wait(() => clients[1]!.frame().includes("d07_after_activation_ok"));
  await input(clients[1]!, "d07_second_client");
  assert.deepEqual(await fingerprint(0), panes[0]);
  const afterDiagnostics = await cli(0, "diagnostics");
  receipt.afterDiagnostics = afterDiagnostics;
  assert.deepEqual(
    afterDiagnostics.tui.recordedLaunches.map((app: { pid: number }) => app.pid).sort(),
    tuiPids,
  );
  assert(
    afterDiagnostics.tui.recordedLaunches.every(
      (app: { generation: string }) => app.generation === up[0].activeBuild.generation,
    ),
  );
  assert.equal((await cli(1, "status")).daemon.instanceId, up[1].daemon.instanceId);
  assert.deepEqual(await fingerprint(1), panes[1]);

  // Actual authenticated retirement, then a controlled manager failure before replacement.
  await assert.rejects(
    activateDevelopmentInstance(instances[0]!, {
      previous: true,
      afterStop: () => {
        throw new Error("Bearer private-fixture-failure");
      },
    }),
    (error: unknown) => (error as { reason: string }).reason === "activation-failed",
  );
  const failed = readDevelopmentActivation(instances[0]!);
  assert(failed);
  assert.equal(failed.phase, "failed");
  assert.equal(failed.failurePhase, "starting");
  assert.equal(failed.previous!.generation, rebuilt.built.generation);
  assert(!JSON.stringify(failed).includes("private-fixture-failure"));
  receipt.failedActivation = failed;
  assert.equal((await cli(0, "status")).state, "stopped");
  assert.deepEqual(await fingerprint(0), panes[0]);
  const recovered = await cli(0, "restart", ["--apply-build", "--previous"]);
  receipt.recovered = recovered;
  daemonPids.add(recovered.daemon.pid);
  assert.equal(recovered.activeBuild.generation, rebuilt.built.generation);
  assert.equal(recovered.selectedBuild.generation, rebuilt.built.generation);
  await freshDelivery("d07_recovery_delivery");
  await input(clients[1]!, "d07_recovered");
  await wait(() => clients[0]!.frame().includes("d07_recovered_ok"));
  await input(clients[2]!, "d07_sibling_after");
  assert.deepEqual(await fingerprint(0), panes[0]);
  assert.deepEqual(await fingerprint(1), panes[1]);
  assert.equal((await cli(1, "status")).daemon.instanceId, up[1].daemon.instanceId);
  const finalDiagnostics = await cli(0, "diagnostics");
  receipt.finalDiagnostics = finalDiagnostics;
  assert.deepEqual(
    finalDiagnostics.tui.recordedLaunches.map((app: { pid: number }) => app.pid).sort(),
    tuiPids,
  );
  receipt.frames = clients.map((client, ordinal) => ({
    ordinal,
    instanceId: instances[client.index]!.id,
    columns: 100,
    frame: client.frame(),
    inputEcho: true,
  }));
  receipt.completed = true;
} catch (error) {
  receipt.failure = error instanceof Error ? error.message : "Qualification failed";
  receipt.failureFrames = clients.map((client) => ({
    index: client.index,
    exited: client.exited,
    frame: client.frame(),
  }));
  throw error;
} finally {
  if (moved) renameSync(`${first}-d07-moved`, first);
  writeFileSync(changedPath, original);
  for (const client of clients) {
    if (!client.exited) {
      client.write("\x11");
      await wait(() => client.exited, 5000).catch(() => client.kill("SIGTERM"));
    }
    client.dispose();
  }
  const cleanup = await Promise.allSettled([cli(0, "down"), cli(1, "down")]);
  receipt.cleanup = cleanup.map((value) => value.status);
  const pids = [...daemonPids, ...admitted.map((status) => status.tmux.pid)];
  receipt.processesGone = (await Promise.all(pids.map(developmentProcessIdentity))).every(
    (value) => value === null,
  );
  receipt.clientsGone = clients.every((client) => client.exited);
  receipt.ok =
    receipt.completed === true &&
    receipt.processesGone &&
    receipt.clientsGone &&
    cleanup.every((value) => value.status === "fulfilled");
  writeFileSync(join(store, "d07-qualification.json"), JSON.stringify(receipt, null, 2));
  if (receipt.completed) assert.equal(receipt.ok, true, "Owned cleanup must succeed");
}
process.stdout.write(`${JSON.stringify({ ok: receipt.ok })}\n`);
