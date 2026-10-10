// Physical Theme picker -> isolated shared config proof. No OS appearance changes.
// Terminal byte capture is independent of the native input handler/picker code.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { dirname, join, isAbsolute } from "node:path";
import process from "node:process";
import console from "node:console";
import { setTimeout as delay } from "node:timers/promises";
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";
import { stopFixtureChild } from "./fixture-child.mjs";
const appPath = process.env.TMUX_GPUI_TEST_APP;
const directory = process.env.TMUX_GPUI_THEME_DIR;
assert.ok(appPath && isAbsolute(appPath), "Require absolute TMUX_GPUI_TEST_APP");
assert.ok(directory && isAbsolute(directory), "Require new absolute TMUX_GPUI_THEME_DIR");
for (const key of Object.keys(process.env)) {
  if (
    key.startsWith("TMUX_IDE_") ||
    ["TMUX", "TMUX_PANE", "TMUX_TMPDIR", "NODE_OPTIONS", "NODE_PATH"].includes(key)
  )
    delete process.env[key];
}
await mkdir(directory, { mode: 0o700 });
const actualPath = join(directory, "terminal-input.bin");
const producerPath = join(directory, "producer.cjs");
const sentinel = { retained: "native-theme-isolated-sentinel", nested: { value: 42 } };
const producer = `const fs=require('node:fs');
const output=${JSON.stringify(actualPath)};
fs.writeFileSync(output,Buffer.alloc(0),{flag:'wx',mode:0o600});
if(!process.stdin.isTTY) throw new Error('Private pane requires TTY');
process.stdin.setRawMode(true);process.stdin.resume();
let size=0;
process.stdin.on('data',chunk=>{if(size+chunk.length>4096){process.stdin.destroy();return;}fs.appendFileSync(output,chunk);size+=chunk.length;});
process.stdout.write('\\x1b[2J\\x1b[HTHEME_READY: use Theme picker only. Do not type into terminal.\\r\\n');
`;
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
async function assertNoTerminalInput() {
  assert.equal((await stat(actualPath)).size, 0, "Theme picker query/keys reached terminal");
}
async function config() {
  const path = fleet.environment.TMUX_IDE_CONFIG;
  assert.ok((await stat(path)).size <= 65536, "Bounded isolated config");
  const value = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(value.unrelated, sentinel, "Theme save must preserve unrelated config");
  return value;
}
async function wait(predicate, label, allowClosed = false) {
  for (;;) {
    if (fatal) throw fatal;
    if (!allowClosed && app && (app.exitCode !== null || app.signalCode !== null))
      throw new Error("App closed before theme proof");
    const done = await predicate();
    if (fatal) throw fatal;
    if (done) return;
    assert.ok(Date.now() < deadline, `Native theme deadline: ${label}`);
    await delay(40);
  }
}
try {
  await writeFile(producerPath, producer, { flag: "wx", mode: 0o600 });
  fleet = await createScratchFleet({
    sessions: 1,
    windowsPerSession: 1,
    slug: "gpui-native-theme",
  });
  const initial = { theme: { mode: "dark", preset: "" }, unrelated: sentinel };
  await mkdir(dirname(fleet.environment.TMUX_IDE_CONFIG), { recursive: true, mode: 0o700 });
  await writeFile(fleet.environment.TMUX_IDE_CONFIG, JSON.stringify(initial), {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(join(directory, "config-before.json"), JSON.stringify(initial, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  const pane = fleet.initialPanes[0].paneId;
  run("respawn-pane", "-k", "-t", pane, `exec ${quote(process.execPath)} ${quote(producerPath)}`);
  await wait(() => run("capture-pane", "-p", "-t", pane).includes("THEME_READY"), "raw producer");
  const producerPid = run("display-message", "-p", "-t", pane, "#{pane_pid}");
  assert.match(producerPid, /^[1-9][0-9]*$/);
  await assertNoTerminalInput();
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
    "Open the sole session and wait for THEME_READY. Activate the app. Click Theme…, click its search input, type Dracula, then press Enter. Do not type into the terminal.",
  );
  for (const [index, preset] of ["dracula", "nord"].entries()) {
    await wait(async () => {
      await assertNoTerminalInput();
      const current = await config();
      return current.theme?.preset === preset && current.theme?.mode === "dark";
    }, `persisted ${preset}`);
    const saved = await config();
    await writeFile(
      join(directory, `config-${preset}.json`),
      JSON.stringify(saved, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        stage: "theme-persisted",
        preset,
        unrelatedRetained: true,
        terminalInputBytes: 0,
      }),
    );
    if (index === 0)
      console.log(
        "Dracula persisted. In the open Theme picker search input press Cmd-A, type Nord, then press Enter. If picker closed, reopen Theme… first. Capture the visual state as needed.",
      );
  }
  console.log(
    "Nord persisted and picker input stayed out of terminal. Capture Nord if needed, press Escape to close picker, then Cmd-Q to close this owned app.",
  );
  await wait(
    async () => {
      await assertNoTerminalInput();
      return app.exitCode !== null || app.signalCode !== null;
    },
    "operator Cmd-Q",
    true,
  );
  assert.equal((await closed).code, 0, "Clean native close");
  await assertNoTerminalInput();
  assert.equal(run("display-message", "-p", "-t", pane, "#{pane_pid}"), producerPid);
  assert.equal(run("display-message", "-p", "-t", pane, "#{pane_dead}"), "0");
  assert.equal((await config()).theme.preset, "nord");
  await writeFile(
    join(directory, "source-after-close.txt"),
    run("capture-pane", "-p", "-t", pane),
    { flag: "wx", mode: 0o600 },
  );
  result = {
    passed: true,
    physicalNativeThemeSelection: ["dracula", "nord"],
    persistedMode: "dark",
    unrelatedRetained: true,
    terminalInputBytes: 0,
    sourceSurvivesClose: true,
    producerPid,
    osAppearanceChanged: false,
    renderedPixels: "operator evidence required",
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
if (failures.length) throw new AggregateError(failures, "Native theme fixture failed");
console.log(JSON.stringify({ ...result, cleanup: true }));
