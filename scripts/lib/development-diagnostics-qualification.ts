/** Opt-in D06 acceptance. Supplied roots/store must belong to the caller. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDevelopmentInstance } from "../../packages/daemon/src/lib/development-instance.ts";
import { readDevelopmentBuild } from "../../packages/daemon/src/lib/development-build.ts";
import {
  cleanManagerEnvironment,
  developmentProcessIdentity,
} from "../../packages/daemon/src/lib/development-state.ts";
const execute = promisify(execFile);
const [first, second, store] = process.argv.slice(2);
assert(first && second && store);
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
async function cli(index: number, command: string) {
  const root = instances[index]!.worktree;
  const result = await execute(
    process.execPath,
    [
      "--no-deprecation",
      "--import",
      join(root, "node_modules/tsx/dist/loader.mjs"),
      join(root, "scripts/development-instance.ts"),
      command,
      "--store",
      store!,
      "--json",
    ],
    { cwd: root, env, timeout: 45000, killSignal: "SIGKILL", maxBuffer: 256 * 1024 },
  );
  return JSON.parse(result.stdout);
}
async function waitFor(check: () => boolean, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("D06 qualification timeout");
}
const { Terminal } = createRequire(new URL("../../packages/daemon/package.json", import.meta.url))(
  "@tmux-ide/xterm-headless",
);
const apps: { kill: (signal?: string) => void }[] = [];
const receipt: Record<string, unknown> = { version: 1 };
let admitted: { daemon: { pid: number; instanceId: string }; tmux: { pid: number } }[] = [];
try {
  const up = await Promise.all([cli(0, "up"), cli(1, "up")]);
  up.forEach((status) => assert.equal(status.state, "ready"));
  assert.notEqual(up[0].daemon.pid, up[1].daemon.pid);
  receipt.up = up;
  admitted = up;
  for (const [index, instance] of instances.entries()) {
    const build = readDevelopmentBuild(instance, {});
    await execute(
      join(build.assets, "tmux", `${process.platform}-${process.arch}`, "tmux"),
      [
        "-S",
        join(instance.runtimeDir, "tmux.sock"),
        "new-session",
        "-d",
        "-s",
        `d06-${index}`,
        "-c",
        instance.worktree,
        "/bin/sh",
        ";",
        "set-option",
        "-t",
        `d06-${index}`,
        "@tmux_ide_adopted",
        "1",
      ],
      { env: cleanManagerEnvironment(), timeout: 2000 },
    );
  }
  const pty = createRequire(readDevelopmentBuild(instances[0]!, {}).cli)("node-pty");
  receipt.frames = await Promise.all(
    instances.map(async (instance, index) => {
      const terminal = pty.spawn("pnpm", ["--silent", "dev:instance", "app", "--store", store!], {
        cwd: instance.worktree,
        env: { ...env, TERM: "xterm-256color", COLORTERM: "truecolor" },
        cols: index === 0 ? 80 : 120,
        rows: 32,
      });
      apps.push(terminal);
      const vt = new Terminal({ cols: index === 0 ? 80 : 120, rows: 32, allowProposedApi: true });
      const frame = () =>
        Array.from(
          { length: vt.rows },
          (_, row) => vt.buffer.active.getLine(row)?.translateToString(true) ?? "",
        ).join("\n");
      let exited = false;
      terminal.onData((data: string) => vt.write(data));
      terminal.onExit(() => {
        exited = true;
      });
      const badge = `DEV ${instance.id.slice(4, 10)}`;
      await waitFor(() => {
        assert(!exited, "App exited before DEV chrome");
        return frame().includes(badge);
      });
      terminal.write("\x1b[15~");
      await new Promise((resolve) => setTimeout(resolve, 200));
      terminal.write(`d06-${index}`);
      await waitFor(() => frame().includes(`d06-${index}`));
      terminal.write("\r");
      await new Promise((resolve) => setTimeout(resolve, 500));
      terminal.write("printf 'd06_input_\\157k\\n'\r");
      await waitFor(() => frame().includes("d06_input_ok"));
      const visible = frame();
      assert(visible.includes(badge));
      assert(!visible.includes(`d06-${1 - index}`));
      const diagnostics = await cli(index, "diagnostics");
      assert.equal(diagnostics.instance.id, instance.id);
      assert.equal(diagnostics.active.sourceStale, false);
      assert.equal(diagnostics.selected.sourceStale, false);
      assert.equal(diagnostics.daemon.runtimeGeneration, up[index].daemon.instanceId);
      assert(
        diagnostics.tui.recordedLaunches.some(
          (app: { generation: string }) => app.generation === diagnostics.active.generation,
        ),
      );
      const logs = await cli(index, "logs");
      assert.equal(logs.instanceId, instance.id);
      assert.equal(logs.rawMessagesIncluded, false);
      terminal.write("\x11");
      await waitFor(() => exited, 5000);
      vt.dispose();
      return {
        instanceId: instance.id,
        columns: index === 0 ? 80 : 120,
        frame: visible,
        diagnostics,
        logs,
        inputEcho: true,
      };
    }),
  );
  const sourcePath = join(instances[0]!.worktree, "package.json");
  const original = readFileSync(sourcePath);
  try {
    writeFileSync(sourcePath, Buffer.concat([original, Buffer.from("\n")]));
    const changed = await cli(0, "diagnostics");
    assert.equal(changed.active.sourceStale, true);
    assert.equal(changed.selected.sourceStale, true);
    assert.equal(changed.daemon.runtimeGeneration, admitted[0]!.daemon.instanceId);
    receipt.changedSource = changed;
  } finally {
    writeFileSync(sourcePath, original);
  }
  receipt.completed = true;
} catch (error) {
  receipt.failure = error instanceof Error ? error.message : "Qualification failed";
  throw error;
} finally {
  apps.forEach((app) => {
    try {
      app.kill("SIGTERM");
    } catch {
      /* exited */
    }
  });
  const cleanup = await Promise.allSettled([cli(0, "down"), cli(1, "down")]);
  receipt.cleanup = cleanup.map((result) => result.status);
  const ownedPids = admitted.flatMap((status) => [status.daemon.pid, status.tmux.pid]);
  receipt.processesGone = (
    await Promise.all(ownedPids.map((pid: number) => developmentProcessIdentity(pid)))
  ).every((value) => value === null);
  receipt.ok =
    receipt.completed === true &&
    cleanup.every((result) => result.status === "fulfilled") &&
    receipt.processesGone;
  writeFileSync(join(store, "d06-qualification.json"), JSON.stringify(receipt, null, 2));
  if (receipt.completed) assert.equal(receipt.ok, true, "Owned cleanup must succeed");
}
process.stdout.write(`${JSON.stringify({ ok: receipt.ok })}\n`);
