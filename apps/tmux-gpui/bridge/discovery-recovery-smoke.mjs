import process from "node:process";
import console from "node:console";
import { Buffer } from "node:buffer";
import { setTimeout } from "node:timers";
// Real isolated discovery recovery: start the browser before the owned daemon. No GUI.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { parseDiagnosticLine, diagnosticStatus } from "./live-diagnostics.ts";
import { stopFixtureChild } from "./fixture-child.mjs";
import { resolve, join, isAbsolute } from "node:path";
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";

const privateCli = process.env.TMUX_GPUI_TEST_CLI;
if (privateCli !== undefined) {
  assert.ok(isAbsolute(privateCli), "TMUX_GPUI_TEST_CLI must be absolute");
  assert.ok((await stat(privateCli)).isFile(), "Private CLI must be a regular file");
  await access(privateCli, constants.R_OK);
}
async function startFixtureDaemon(fleet) {
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
      await new Promise((resolve) => setTimeout(resolve, 20));
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
    assert.ok(
      Date.now() < deadline,
      "Home fixture deadline " +
        JSON.stringify({
          snapshot: !!latest?.snapshot,
          inputReady: latest?.inputReady,
          diagnostics: stderr.split("\n").map(parseDiagnosticLine).filter(Boolean),
          diagnosticStatusVisible: stderr
            .split("\n")
            .map(parseDiagnosticLine)
            .filter(Boolean)
            .some((d) => latest?.status === diagnosticStatus(d)),
        }),
    );
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
  assert.match(latest.status, /Local sessions are not connected yet/);
  assert.match(latest.status, /Use setup or refresh sessions/);
  assert.equal(latest.snapshot, null);
  assert.equal(latest.inputReady, false);
  const connection = latest.connection;
  const before = fleet.captureWindowPanes(fleet.sessionNames[0]);
  daemon = await startFixtureDaemon(fleet);
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
  assert.equal(stderr, "", "No diagnostic is allowed before the controlled daemon stop");
  const firstInstance = daemon.record.instanceId;
  const baselineSequence = latest.sequence;
  await daemon.stop();
  daemon = undefined;
  let shutdownDiagnostic;
  const shutdownDiagnosticLines = (lines) => {
    const recoveryLines = lines.filter((line) => line.startsWith("TMUX_GPUI_RECOVERY "));
    assert.ok(
      recoveryLines.length <= 1 &&
        recoveryLines.every((line) => line === "TMUX_GPUI_RECOVERY transport-closed"),
      "Only the controlled transport closure may start recovery",
    );
    return lines.filter((line) => !line.startsWith("TMUX_GPUI_RECOVERY "));
  };
  await until(() => {
    // Hub retirement can deliver source-closed before the socket closes with 1001.
    // Accept only those two controlled-stop outcomes, retaining first-fault status.
    // Stderr chunks can end midway through a protocol line.
    const lines = stderr
      .slice(0, stderr.lastIndexOf("\n") + 1)
      .split("\n")
      .filter(Boolean);
    const diagnosticLines = shutdownDiagnosticLines(lines);
    const diagnostic =
      diagnosticLines.length === 1 ? parseDiagnosticLine(diagnosticLines[0]) : null;
    const expected =
      diagnostic?.code === "source-closed" ||
      (diagnostic?.code === "transport-closed" && diagnostic.closeCode === 1001);
    if (
      !expected ||
      !(latest?.sequence > baselineSequence) ||
      latest.snapshot !== null ||
      latest.inputReady !== false ||
      latest.status !== diagnosticStatus(diagnostic)
    )
      return false;
    shutdownDiagnostic = diagnostic;
    return true;
  });
  assert.equal(latest.connection, connection);
  daemon = await startFixtureDaemon(fleet);
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
  assert.deepEqual(
    shutdownDiagnosticLines(stderr.trim().split("\n")).map(parseDiagnosticLine),
    [shutdownDiagnostic],
    "Only the controlled daemon-shutdown diagnostic is expected",
  );
  checkFatal();
} catch (error) {
  failures.push(error);
} finally {
  for (const cleanup of [
    () => stopFixtureChild(browser),
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
