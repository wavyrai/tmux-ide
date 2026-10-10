// Physical native menu -> daemon split proof against a creation-owned tmux server.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import process from "node:process";
import console from "node:console";
import { setTimeout as delay } from "node:timers/promises";
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";
import { stopFixtureChild } from "./fixture-child.mjs";
const appPath = process.env.TMUX_GPUI_TEST_APP;
const directory = process.env.TMUX_GPUI_SPLIT_DIR;
assert.ok(appPath && isAbsolute(appPath), "Require absolute TMUX_GPUI_TEST_APP");
assert.ok(directory && isAbsolute(directory), "Require fresh absolute TMUX_GPUI_SPLIT_DIR");
for (const key of Object.keys(process.env)) {
  if (
    key.startsWith("TMUX_IDE_") ||
    ["TMUX", "TMUX_PANE", "TMUX_TMPDIR", "NODE_OPTIONS", "NODE_PATH"].includes(key)
  )
    delete process.env[key];
}
await mkdir(directory, { mode: 0o700 });
const inputPath = join(directory, "terminal-input.bin");
const producerPath = join(directory, "producer.cjs");
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
let fleet, daemon, app, closed, fatal, result;
const failures = [];
const deadline = Date.now() + 240000;
const run = (...args) =>
  execFileSync(fleet.environment.TMUX_IDE_TMUX_BIN, ["-S", fleet.socketPath, ...args], {
    env: { ...process.env, ...fleet.environment },
    encoding: "utf8",
    timeout: 5000,
  }).trimEnd();
const panes = () =>
  run(
    "list-panes",
    "-t",
    fleet.sessionNames[0],
    "-F",
    "#{pane_id}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}|#{pane_pid}|#{pane_dead}",
  )
    .split("\n")
    .map((line) => {
      const [id, left, top, width, height, pid, dead] = line.split("|");
      return {
        id,
        left: Number(left),
        top: Number(top),
        width: Number(width),
        height: Number(height),
        pid,
        dead,
      };
    });
async function noInput() {
  assert.equal((await stat(inputPath)).size, 0, "Menu input leaked to original terminal");
}
async function wait(predicate, label, allowClosed = false) {
  for (;;) {
    if (fatal) throw fatal;
    if (!allowClosed && app && (app.exitCode !== null || app.signalCode !== null))
      throw new Error("App closed before split proof");
    if (await predicate()) return;
    assert.ok(Date.now() < deadline, `Physical split deadline: ${label}`);
    await delay(40);
  }
}
try {
  await writeFile(
    producerPath,
    `const fs=require('node:fs');
const out=${JSON.stringify(inputPath)};
fs.writeFileSync(out,Buffer.alloc(0),{flag:'wx',mode:0o600});
if(!process.stdin.isTTY) throw new Error('Requires private TTY');
process.stdin.setRawMode(true);process.stdin.resume();let count=0;
process.stdin.on('data',b=>{if(count+b.length>4096){process.stdin.destroy();return;}fs.appendFileSync(out,b);count+=b.length;});
process.stdout.write('\\x1b[2J\\x1b[HSPLIT_SOURCE: use Actions only; do not type.\\r\\n');
`,
    { flag: "wx", mode: 0o600 },
  );
  fleet = await createScratchFleet({
    sessions: 1,
    windowsPerSession: 1,
    slug: "gpui-native-split",
  });
  const original = fleet.initialPanes[0].paneId;
  run(
    "respawn-pane",
    "-k",
    "-t",
    original,
    `exec ${quote(process.execPath)} ${quote(producerPath)}`,
  );
  await wait(
    () => run("capture-pane", "-p", "-t", original).includes("SPLIT_SOURCE"),
    "producer ready",
  );
  const originalPid = panes().find((p) => p.id === original).pid;
  await noInput();
  daemon = await startDaemon(fleet);
  app = spawn(join(appPath, "Contents/MacOS/tmux-ide-launcher"), [], {
    cwd: fleet.root,
    env: { ...process.env, ...fleet.environment, PATH: "/usr/bin:/bin" },
    stdio: ["ignore", "inherit", "inherit"],
  });
  app.on("error", (error) => {
    fatal ??= error;
  });
  closed = new Promise((resolve) => app.once("close", (code, signal) => resolve({ code, signal })));
  console.log(
    "Open the sole session, wait Keyboard ready/SPLIT_SOURCE, then Actions -> Split pane right. Do not type into terminals.",
  );
  const created = [];
  for (const [index, direction] of ["right", "down"].entries()) {
    await wait(async () => {
      await noInput();
      const count = panes().length;
      assert.ok(count <= index + 2, "Unexpected extra split");
      return count === index + 2;
    }, direction);
    const current = panes(),
      source = current.find((p) => p.id === original);
    const added = current.filter((p) => p.id !== original && !created.includes(p.id));
    assert.equal(added.length, 1);
    assert.equal(source.pid, originalPid);
    assert.ok(
      direction === "right"
        ? added[0].left > source.left && added[0].top === source.top
        : added[0].top > source.top && added[0].left === source.left,
    );
    created.push(added[0].id);
    await writeFile(
      join(directory, `panes-${direction}.json`),
      JSON.stringify(current, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        stage: "split-verified",
        direction,
        original,
        created: added[0].id,
        terminalInputBytes: 0,
      }),
    );
    if (index === 0)
      console.log(
        "Wait for coherent two-pane layout/Keyboard ready. Original SPLIT_SOURCE must remain selected. Actions -> Split pane down.",
      );
  }
  console.log(
    "Both directions verified. Observe coherent three-pane layout with original selected, then Cmd-Q.",
  );
  await wait(
    async () => {
      await noInput();
      return app.exitCode !== null || app.signalCode !== null;
    },
    "Cmd-Q",
    true,
  );
  assert.equal((await closed).code, 0);
  await noInput();
  const after = panes();
  assert.equal(after.length, 3);
  assert.equal(after.find((p) => p.id === original).pid, originalPid);
  assert.ok(after.every((p) => p.dead === "0"));
  result = {
    passed: true,
    rightAndDown: true,
    terminalInputBytes: 0,
    originalPid,
    sourceSurvivesClose: true,
    nativeLayoutAndSelection: "operator observation required",
  };
} catch (error) {
  failures.push(error);
} finally {
  for (const cleanup of [
    () => stopFixtureChild(app),
    () => daemon?.stop(),
    () => fleet?.dispose(),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
}
if (fatal) failures.push(fatal);
await writeFile(
  join(directory, "receipt.json"),
  JSON.stringify(
    failures.length
      ? { passed: false, failureCount: failures.length }
      : { ...result, cleanup: true },
    null,
    2,
  ) + "\n",
  { flag: "wx", mode: 0o600 },
);
if (failures.length) throw new AggregateError(failures, "Physical native split failed");
console.log(JSON.stringify({ ...result, cleanup: true }));
