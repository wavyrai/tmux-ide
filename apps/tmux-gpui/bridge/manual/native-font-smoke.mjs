// Physical native font save/restart proof with a private raw PTY leakage oracle.
// Run only with an explicitly selected app. The operator changes fonts, quits, and confirms the restarted UI.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { access, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { constants, writeFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import process from "node:process";
import console from "node:console";
import { setTimeout as delay } from "node:timers/promises";
import { createScratchFleet } from "../../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../../scripts/lib/product-fixtures/daemon.ts";
import { stopFixtureChild } from "../fixture-child.mjs";

const appPath = process.env.TMUX_GPUI_TEST_APP;
const directory = process.env.TMUX_GPUI_FONT_DIR;
assert.ok(appPath && isAbsolute(appPath), "Require absolute TMUX_GPUI_TEST_APP");
assert.ok(directory && isAbsolute(directory), "Require new absolute TMUX_GPUI_FONT_DIR");
const launcher = join(appPath, "Contents/MacOS/tmux-ide-launcher");
assert.ok((await stat(launcher)).isFile(), "App launcher must be a regular file");
await access(launcher, constants.X_OK);
const privateCli = process.env.TMUX_GPUI_TEST_CLI;
if (privateCli !== undefined) {
  assert.ok(isAbsolute(privateCli), "TMUX_GPUI_TEST_CLI must be absolute");
  assert.ok((await stat(privateCli)).isFile(), "Private CLI must be a regular file");
  await access(privateCli, constants.R_OK);
}
let fatal;
const cancel = () => {
  fatal ??= new Error("Native font proof cancelled");
};
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);
async function startFixtureDaemon(fleet) {
  if (fatal) throw fatal;
  if (privateCli === undefined) return startDaemon(fleet);
  const child = spawn(process.execPath, [privateCli, "--headless"], {
    env: { ...process.env, ...fleet.environment },
    stdio: "ignore",
  });
  let childError;
  child.on("error", (error) => {
    childError = error;
  });
  try {
    const deadline = Date.now() + 45000;
    for (;;) {
      if (fatal) throw fatal;
      if (childError) throw childError;
      assert.ok(child.exitCode === null && child.signalCode === null, "Private daemon exited");
      assert.ok(Date.now() < deadline, "Private daemon startup deadline");
      let record;
      try {
        record = JSON.parse(await readFile(join(fleet.daemonInfoDir, "daemon.json"), "utf8"));
      } catch {
        /* Await the owned atomic discovery record. */
      }
      if (record?.pid === child.pid && typeof record.authToken === "string" && record.instanceId)
        return { record, stop: () => stopFixtureChild(child) };
      await delay(20);
    }
  } catch (error) {
    try {
      await stopFixtureChild(child);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Private daemon startup failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
}
const expectedSettings = { version: 1, family: "Menlo", size: 15 };
const confirmation = randomUUID();
const confirmationPath = join(directory, "restored-confirmation.txt");
const actualPath = join(directory, "actual.bin");
const producerPath = join(directory, "producer.cjs");
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
for (const key of Object.keys(process.env)) {
  if (
    key.startsWith("TMUX_IDE_") ||
    [
      "TMUX",
      "TMUX_PANE",
      "TMUX_TMPDIR",
      "NODE_OPTIONS",
      "NODE_PATH",
      "XDG_STATE_HOME",
      "XDG_CACHE_HOME",
    ].includes(key)
  )
    delete process.env[key];
}
// Exclusive mkdir: never reuse or remove caller evidence, including on failure.
await mkdir(directory, { mode: 0o700 });
let fleet, daemon, app, closedResult, result, producerPid;
const failures = [];
const deadline = Date.now() + 240000;
const producer = `const fs = require('node:fs');
const output = ${JSON.stringify(actualPath)};
fs.writeFileSync(output, Buffer.alloc(0), {flag:'wx',mode:0o600});
if (!process.stdin.isTTY) throw new Error('Private pane requires TTY');
process.stdin.setRawMode(true);
process.stdin.resume();
let received = 0;
process.stdin.on('data', chunk => {
  if (received + chunk.length > 4096) { process.exitCode=1; process.stdin.destroy(); return; }
  fs.appendFileSync(output, chunk);
  received += chunk.length;
  process.stdout.write('\\r\\nRECEIVED_BYTES=' + received + '\\r\\n');
});
process.stdout.write('\\x1b[2J\\x1b[HFONT_READY: use F5 font controls; do not type into terminal.\\r\\n');
`;
const run = (...args) =>
  execFileSync(fleet.environment.TMUX_IDE_TMUX_BIN, ["-S", fleet.socketPath, ...args], {
    env: { ...process.env, ...fleet.environment },
    encoding: "utf8",
    timeout: 5000,
  }).trimEnd();
async function wait(predicate, label, allowClosed = false) {
  for (;;) {
    if (fatal) throw fatal;
    if (!allowClosed && app && (app.exitCode !== null || app.signalCode !== null))
      throw new Error("App closed before font proof");
    const done = await predicate();
    if (fatal) throw fatal;
    if (done) return;
    assert.ok(Date.now() < deadline, `Native font deadline: ${label}`);
    await delay(40);
  }
}
async function actual() {
  const info = await stat(actualPath);
  assert.ok(info.isFile() && info.size <= 4096, "Bounded private byte capture");
  return readFile(actualPath);
}
async function settings(path) {
  try {
    const info = await stat(path);
    assert.ok(info.isFile() && info.size <= 8192, "Bounded font settings");
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function launch() {
  if (fatal) throw fatal;
  closedResult = undefined;
  app = spawn(launcher, [], {
    cwd: fleet.root,
    env: { ...process.env, ...fleet.environment, PATH: "/usr/bin:/bin" },
    stdio: ["ignore", "inherit", "inherit"],
  });
  app.on("error", (error) => {
    fatal ??= error;
  });
  app.once("close", (code, signal) => {
    closedResult = { code, signal };
  });
}
async function noLeak() {
  assert.equal((await actual()).length, 0, "Font picker input leaked to the terminal");
}
try {
  if (fatal) throw fatal;
  await writeFile(producerPath, producer, { flag: "wx", mode: 0o600 });
  fleet = await createScratchFleet({ sessions: 1, windowsPerSession: 1, slug: "gpui-native-font" });
  if (fatal) throw fatal;
  const pane = fleet.initialPanes[0].paneId;
  run("respawn-pane", "-k", "-t", pane, `exec ${quote(process.execPath)} ${quote(producerPath)}`);
  await wait(() => run("capture-pane", "-p", "-t", pane).includes("FONT_READY"), "raw producer");
  producerPid = run("display-message", "-p", "-t", pane, "#{pane_pid}");
  assert.match(producerPid, /^[1-9][0-9]*$/);
  const configPath = join(fleet.environment.XDG_CONFIG_HOME, "tmux-ide/gpui-fonts.json");
  assert.equal(await settings(configPath), null, "Font configuration must start fresh");
  await noLeak();
  daemon = await startFixtureDaemon(fleet);
  if (fatal) throw fatal;
  launch();
  console.log(JSON.stringify({ stage: "font-ready", expectedSettings, configPath }));
  console.log(
    "Open the sole session and wait for FONT_READY. Use F5 → Terminal font; select Menlo and adjust size to 15. Do not type into the terminal.",
  );
  await wait(async () => {
    await noLeak();
    const saved = await settings(configPath);
    return saved?.version === 1 && saved.family === "Menlo" && saved.size === 15;
  }, "font settings saved");
  assert.deepEqual(await settings(configPath), expectedSettings);
  await writeFile(join(directory, "saved-settings.json"), JSON.stringify(expectedSettings), {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    "Settings saved with zero terminal input. Quit this owned app using Cmd-Q; the fixture will relaunch it.",
  );
  await wait(
    async () => {
      await noLeak();
      return closedResult !== undefined;
    },
    "first Cmd-Q",
    true,
  );
  assert.equal(closedResult.code, 0, "Clean first native close");
  assert.equal(run("display-message", "-p", "-t", pane, "#{pane_pid}"), producerPid);
  launch();
  console.log(
    JSON.stringify({
      stage: "verify-restored-font",
      confirmationPath,
      confirmation,
      expectedSettings,
    }),
  );
  console.log(
    "Reopen the sole session. Visually inspect the font picker/current size: Menlo, size 15. Only after confirming, write the exact confirmation token above to confirmationPath, then Cmd-Q. This confirmation is operator evidence, not an automated rendering measurement.",
  );
  await wait(async () => {
    await noLeak();
    assert.deepEqual(await settings(configPath), expectedSettings);
    try {
      const info = await stat(confirmationPath);
      assert.ok(info.isFile() && info.size <= 128, "Bounded operator confirmation");
      assert.equal((await readFile(confirmationPath, "utf8")).trim(), confirmation);
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }, "operator restored-font confirmation");
  await wait(
    async () => {
      await noLeak();
      return closedResult !== undefined;
    },
    "second Cmd-Q",
    true,
  );
  assert.equal(closedResult.code, 0, "Clean second native close");
  assert.equal(run("display-message", "-p", "-t", pane, "#{pane_pid}"), producerPid);
  assert.equal(run("display-message", "-p", "-t", pane, "#{pane_dead}"), "0");
  await noLeak();
  assert.deepEqual(await settings(configPath), expectedSettings);
  await writeFile(
    join(directory, "source-after-close.txt"),
    run("capture-pane", "-p", "-t", pane),
    { flag: "wx", mode: 0o600 },
  );
  result = {
    passed: true,
    settings: expectedSettings,
    operatorConfirmedRestoration: true,
    terminalInputBytes: 0,
    sourceSurvivesClose: true,
    producerPid,
  };
} catch (error) {
  failures.push(error);
} finally {
  // Independent cleanup attempts; the private fleet owns and reaps the raw producer.
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
// Commit the small receipt in the same turn as the final cancellation check.
writeFileSync(
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
if (failures.length) throw new AggregateError(failures, "Native font fixture failed");
console.log(JSON.stringify({ ...result, cleanup: true }));
