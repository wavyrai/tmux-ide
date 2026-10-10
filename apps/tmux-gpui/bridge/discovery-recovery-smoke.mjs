// Real isolated discovery recovery: start the browser before the owned daemon. No GUI.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { resolve, join, isAbsolute } from "node:path";
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";

const app = process.env.TMUX_GPUI_TEST_APP;
if (app && !isAbsolute(app)) throw new Error("TMUX_GPUI_TEST_APP must be absolute");

// Save no inherited server/development selectors: every resource below is fixture-owned.
for (const key of Object.keys(process.env))
  if (
    key.startsWith("TMUX_IDE_") ||
    ["TMUX", "TMUX_PANE", "TMUX_TMPDIR", "NODE_OPTIONS", "NODE_PATH"].includes(key)
  )
    delete process.env[key];
const fleet = await createScratchFleet({
  sessions: 1,
  slug: "gpui-discovery-recovery",
  windowsPerSession: 1,
  initialPaneMarker: "RIG_GPUI_HOME_SOURCE",
});
let daemon, browser;
let latest,
  buffer = "",
  stderr = "";
let fatal;
const failures = [];
const checkFatal = () => {
  if (fatal) throw fatal;
};
const until = async (predicate) => {
  const deadline = Date.now() + 20000;
  while (true) {
    checkFatal();
    const ready = predicate();
    checkFatal();
    if (ready) return;
    if (browser && (browser.exitCode !== null || browser.signalCode !== null))
      throw new Error("Home browser exited");
    assert.ok(Date.now() < deadline, "Home fixture deadline");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
try {
  browser = spawn(
    app ? join(app, "Contents/Resources/node") : process.execPath,
    [
      ...(app ? [] : ["--import", "tsx"]),
      app
        ? join(app, "Contents/Resources/bridge/browser.bundle.mjs")
        : resolve("apps/tmux-gpui/bridge/browser.ts"),
      "--local",
    ],
    {
      env: { ...process.env, ...fleet.environment },
      stdio: ["pipe", "pipe", "pipe"],
      ...(app ? { cwd: fleet.root } : {}),
    },
  );
  browser.on("error", (error) => {
    fatal ??= error;
  });
  browser.stdin.on("error", (error) => {
    fatal ??= error;
  });
  browser.stderr.on("data", (data) => {
    if (fatal) return;
    try {
      assert.ok(Buffer.byteLength(stderr) + data.length <= 65536, "stderr limit");
      stderr += data;
    } catch (error) {
      fatal ??= error;
    }
  });
  browser.stdout.on("data", (data) => {
    if (fatal) return;
    try {
      assert.ok(
        Buffer.byteLength(buffer) + data.length <= 8 * 1024 * 1024,
        "publication buffer limit",
      );
      buffer += data;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        latest = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
    } catch (error) {
      fatal ??= error;
    }
  });
  const send = (command) => browser.stdin.write(JSON.stringify(command) + "\n");
  await until(() => latest?.home.phase === "unavailable");
  assert.match(latest.status, /No usable local daemon/);
  assert.match(latest.status, /tmux-ide --headless/);
  assert.equal(latest.snapshot, null);
  assert.equal(latest.inputReady, false);
  const connection = latest.connection;
  const before = fleet.captureWindowPanes(fleet.sessionNames[0]);
  daemon = await startDaemon(fleet);
  send({ type: "refresh", request: 1 });
  await until(() => latest?.request === 1 && latest.home.phase === "live");
  assert.equal(latest.connection, connection);
  assert.equal(latest.sessions.length, 1);
  assert.equal(latest.sessions[0].paneCount, 1);
  assert.equal(latest.snapshot, null);
  assert.equal(latest.inputReady, false);
  assert.equal(fleet.captureWindowPanes(fleet.sessionNames[0]), before);
  assert.ok(!JSON.stringify(latest).includes(daemon.record.authToken));
  const nativePane = fleet.initialPanes[0].paneId;
  const capture = () =>
    execFileSync(
      fleet.environment.TMUX_IDE_TMUX_BIN,
      ["-S", fleet.socketPath, "capture-pane", "-p", "-t", nativePane],
      { env: { ...process.env, ...fleet.environment }, encoding: "utf8", timeout: 5000 },
    );
  async function select(request) {
    const sessionId = latest.sessions[0].id;
    send({ type: "session", request, id: sessionId });
    await until(
      () =>
        latest?.request === request &&
        latest.status === "Choose a pane or window" &&
        latest.panes.length === 1,
    );
    const paneId = latest.panes[0].id;
    send({ type: "pane", request: request + 1, id: paneId });
    await until(
      () =>
        latest?.request === request + 1 &&
        latest.selectedPane === paneId &&
        latest.snapshot &&
        latest.inputReady,
    );
    assert.equal(latest.connection, connection);
    return paneId;
  }
  const marker = randomUUID().replaceAll("-", "");
  const beforeMarker = `BEFORE_${marker}`,
    afterMarker = `AFTER_${marker}`,
    staleMarker = `STALE_${marker}`;
  const firstPane = await select(2);
  send({
    type: "input",
    request: 3,
    id: firstPane,
    input: { kind: "text", data: `printf '\\n${beforeMarker}\\n'\n` },
  });
  await until(() =>
    capture()
      .split("\n")
      .some((line) => line === beforeMarker),
  );
  const firstInstance = daemon.record.instanceId;
  const baselineSequence = latest.sequence;
  await daemon.stop();
  daemon = undefined;
  await until(
    () =>
      latest?.sequence > baselineSequence &&
      latest.snapshot === null &&
      latest.inputReady === false &&
      /unavailable/i.test(latest.status),
  );
  assert.equal(latest.connection, connection);
  daemon = await startDaemon(fleet);
  assert.notEqual(daemon.record.instanceId, firstInstance);
  send({ type: "refresh", request: 4 });
  await until(() => latest?.request === 4 && latest.home.phase === "live");
  const freshPane = await select(5);
  send({
    type: "input",
    request: 3,
    id: firstPane,
    input: { kind: "text", data: `printf '\\n${staleMarker}\\n'\n` },
  });
  send({
    type: "input",
    request: 6,
    id: freshPane,
    input: { kind: "text", data: `printf '\\n${afterMarker}\\n'\n` },
  });
  await until(() =>
    capture()
      .split("\n")
      .some((line) => line === afterMarker),
  );
  assert.ok(!capture().includes(staleMarker), "stale request bytes never reached source");
  assert.equal(latest.connection, connection);
  assert.ok(!JSON.stringify(latest).includes(daemon.record.authToken));
  assert.equal(stderr, "");
  checkFatal();
} catch (error) {
  failures.push(error);
} finally {
  for (const cleanup of [
    async () => {
      if (browser && browser.exitCode === null && browser.signalCode === null) {
        const done = once(browser, "close");
        browser.kill("SIGTERM");
        const timer = setTimeout(() => browser.kill("SIGKILL"), 2000);
        try {
          await done;
        } finally {
          clearTimeout(timer);
        }
      }
    },
    async () => {
      if (daemon) await daemon.stop();
    },
    async () => {
      await fleet.dispose();
    },
  ]) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
}
if (fatal && !failures.includes(fatal)) failures.push(fatal);
if (failures.length) throw new AggregateError(failures, "Discovery recovery smoke failed");
console.log(
  JSON.stringify({
    passed: true,
    runtime: app ? "packaged-node-and-browser" : "source",
    initialMissingDaemonGuidance: true,
    sameBrowserRefreshRecovery: true,
    initialHomeSourceUnchangedWithoutInputAuthority: true,
    ownedDaemonReplacement: true,
    exactInputBeforeAndAfterReplacement: true,
    staleRequestInputRejected: true,
    nativeUi: "not exercised",
  }),
);
