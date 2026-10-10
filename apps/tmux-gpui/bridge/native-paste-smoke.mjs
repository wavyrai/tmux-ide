// Physical clipboard -> native GPUI -> daemon -> private raw PTY byte proof.
// Run only with an explicitly selected app. The operator performs the paste.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import process from "node:process";
import console from "node:console";
import { setTimeout as delay } from "node:timers/promises";
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";
import { stopFixtureChild } from "./fixture-child.mjs";

const appPath = process.env.TMUX_GPUI_TEST_APP;
const directory = process.env.TMUX_GPUI_PASTE_DIR;
assert.ok(appPath && isAbsolute(appPath), "Require absolute TMUX_GPUI_TEST_APP");
assert.ok(directory && isAbsolute(directory), "Require new absolute TMUX_GPUI_PASTE_DIR");
const payload = "PASTE_界_e\u0301_🙂\nSECOND_LINE";
const expected = Buffer.from("\x1b[200~" + payload + "\x1b[201~", "utf8");
const actualPath = join(directory, "actual.bin");
const producerPath = join(directory, "producer.cjs");
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const key of Object.keys(process.env)) {
  if (
    key.startsWith("TMUX_IDE_") ||
    ["TMUX", "TMUX_PANE", "TMUX_TMPDIR", "NODE_OPTIONS", "NODE_PATH"].includes(key)
  )
    delete process.env[key];
}
// Exclusive mkdir: never reuse or remove caller evidence, including on failure.
await mkdir(directory, { mode: 0o700 });
let fleet, daemon, app, closed, fatal, result, producerPid;
const failures = [];
const deadline = Date.now() + 180000;
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
process.stdout.write('\\x1b[?2004h\\x1b[2J\\x1b[HPASTE_READY: click ready terminal, paste once; no Return.\\r\\n');
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
      throw new Error("App closed before paste proof");
    const done = await predicate();
    if (fatal) throw fatal;
    if (done) return;
    assert.ok(Date.now() < deadline, `Native paste deadline: ${label}`);
    await delay(40);
  }
}
async function actual() {
  const info = await stat(actualPath);
  assert.ok(info.isFile() && info.size <= 4096, "Bounded private byte capture");
  return readFile(actualPath);
}
try {
  await writeFile(join(directory, "payload.txt"), payload, { flag: "wx", mode: 0o600 });
  await writeFile(join(directory, "expected.bin"), expected, { flag: "wx", mode: 0o600 });
  await writeFile(producerPath, producer, { flag: "wx", mode: 0o600 });
  fleet = await createScratchFleet({
    sessions: 1,
    windowsPerSession: 1,
    slug: "gpui-native-paste",
  });
  const pane = fleet.initialPanes[0].paneId;
  run("respawn-pane", "-k", "-t", pane, `exec ${quote(process.execPath)} ${quote(producerPath)}`);
  await wait(
    () => run("display-message", "-p", "-t", pane, "#{bracket_paste_flag}") === "1",
    "producer bracketed mode",
  );
  assert.ok(run("capture-pane", "-p", "-t", pane).includes("PASTE_READY"));
  producerPid = run("display-message", "-p", "-t", pane, "#{pane_pid}");
  assert.match(producerPid, /^[1-9][0-9]*$/);
  assert.equal((await actual()).length, 0);
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
    JSON.stringify({
      stage: "paste-ready",
      payload,
      payloadFile: join(directory, "payload.txt"),
      expectedBytes: expected.length,
      expectedHex: expected.toString("hex"),
    }),
  );
  console.log(
    "Open the sole session, wait Keyboard ready, activate/click its terminal, then paste payload.txt exactly once. Do not press Return.",
  );
  await wait(async () => {
    const bytes = await actual();
    assert.ok(bytes.length <= expected.length, "Unexpected extra input bytes");
    assert.ok(expected.subarray(0, bytes.length).equals(bytes), "Paste byte prefix differs");
    return bytes.equals(expected);
  }, "exact physical paste");
  assert.equal(run("display-message", "-p", "-t", pane, "#{bracket_paste_flag}"), "1");
  console.log("Exact bracketed Unicode/multiline bytes received. Close this owned app with Cmd-Q.");
  await wait(() => app.exitCode !== null || app.signalCode !== null, "operator Cmd-Q", true);
  assert.equal((await closed).code, 0, "Clean native close");
  assert.equal(run("display-message", "-p", "-t", pane, "#{pane_pid}"), producerPid);
  assert.equal(run("display-message", "-p", "-t", pane, "#{pane_dead}"), "0");
  assert.deepEqual(await actual(), expected, "No delayed input after paste or native close");
  await writeFile(
    join(directory, "source-after-close.txt"),
    run("capture-pane", "-p", "-t", pane),
    { flag: "wx", mode: 0o600 },
  );
  result = {
    passed: true,
    physicalNativePaste: true,
    bracketPasteFlag: 1,
    exactBytes: expected.length,
    sha256: digest(expected),
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
await writeFile(
  join(directory, "receipt.json"),
  JSON.stringify(
    failures.length
      ? { passed: false, failureCount: failures.length, expectedSha256: digest(expected) }
      : { ...result, cleanup: true },
    null,
    2,
  ) + "\n",
  { flag: "wx", mode: 0o600 },
);
if (failures.length) throw new AggregateError(failures, "Native paste fixture failed");
console.log(JSON.stringify({ ...result, cleanup: true }));
