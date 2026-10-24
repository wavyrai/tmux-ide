import process from "node:process";
import console from "node:console";
import { setTimeout } from "node:timers";
import { startNativeJourney } from "./native-journey-fixture.mjs";
// Real daemon, same long-running browser: missing startup config and failed refresh recovery.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { stopFixtureChild } from "./fixture-child.mjs";
import { writeFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";
import { listTmuxServers } from "../../../packages/daemon-client/src/tmux-server-client.ts";
const fleet = await createScratchFleet({ sessions: 1, windowsPerSession: 1, slug: "gpui-startup" });
let daemon, browser, native, brokerConnection;
const failures = [];
let latest,
  buffer = "",
  stderr = "";
const until = async (predicate) => {
  const deadline = Date.now() + 20000;
  while (!predicate()) {
    native?.assertHealthy();
    if (browser.exitCode !== null || browser.signalCode !== null)
      throw new Error("Browser exited instead of retaining recovery: " + stderr);
    if (Date.now() > deadline) throw new Error("Startup recovery deadline: " + stderr);
    await new Promise((done) => setTimeout(done, 20));
  }
};
try {
  daemon = await startDaemon(
    fleet,
    process.env.TMUX_GPUI_TEST_CLI ? { cliPath: process.env.TMUX_GPUI_TEST_CLI } : undefined,
  );
  const options = {
    baseUrl: daemon.baseUrl + "/",
    ownerToken: daemon.record.authToken,
    hostClientId: "gpui-startup-test",
    origin: "tmux-ide://app",
  };
  const server = (await listTmuxServers(options)).servers.find((s) => s.state === "online");
  assert.ok(server);
  const config = fleet.root + "/not-yet-present.json";
  const host = {
    baseUrl: options.baseUrl,
    ownerToken: options.ownerToken,
    scope: { serverId: server.serverId, generation: server.generation },
  };
  browser = spawn(
    process.execPath,
    ["--import", "tsx", resolve("apps/tmux-gpui/bridge/browser.ts"), config],
    { env: { ...process.env, ...fleet.environment }, stdio: ["pipe", "pipe", "pipe"] },
  );
  browser.stderr.on("data", (b) => {
    stderr = (stderr + b.toString()).slice(-16000);
  });
  browser.stdout.on("data", (b) => {
    buffer += b.toString();
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const publication = JSON.parse(buffer.slice(0, end));
      if (publication.connection) brokerConnection = publication.connection;
      buffer = buffer.slice(end + 1);
    }
  });
  native = startNativeJourney(browser, {
    worker: true,
    onState: (state) => {
      latest = state;
    },
  });
  const send = (value) => native.send(value);
  await until(() => latest?.status.includes("unavailable"));
  assert.equal(latest.snapshot, null);
  assert.equal(latest.inputReady, false);
  const connection = brokerConnection;
  send({ type: "presence", active: true, revision: 1 });
  await writeFile(config, JSON.stringify(host), { mode: 0o600 });
  send({ type: "refresh", request: 1 });
  await until(() => latest?.request === 1 && latest.sessions.length === 1);
  send({ type: "session", request: 2, id: latest.sessions[0].id });
  await until(() => latest?.request === 2 && latest.panes.length > 0);
  const pane = latest.panes[0].id;
  send({ type: "pane", request: 3, id: pane });
  await until(() => latest?.request === 3 && latest.snapshot && latest.inputReady);
  await unlink(config);
  send({ type: "refresh", request: 4 });
  await until(() => latest?.request === 4 && latest.status.includes("unavailable"));
  assert.equal(latest.snapshot, null);
  assert.equal(latest.inputReady, false);
  assert.deepEqual(latest.sessions, []);
  send({
    type: "input",
    request: 3,
    id: pane,
    input: { kind: "text", data: "STALE_STARTUP_INPUT" },
  });
  await writeFile(config, JSON.stringify(host), { mode: 0o600 });
  send({ type: "refresh", request: 5 });
  await until(() => latest?.request === 5 && latest.sessions.length === 1);
  send({ type: "session", request: 6, id: latest.sessions[0].id });
  await until(() => latest?.request === 6 && latest.panes.length > 0);
  send({ type: "pane", request: 7, id: latest.panes[0].id });
  await until(() => latest?.request === 7 && latest.snapshot && latest.inputReady);
  send({
    type: "input",
    request: 7,
    id: latest.selectedPane,
    input: { kind: "text", data: "echo STARTUP_RECOVERED\n" },
  });
  await until(() =>
    fleet
      .captureWindowPanes(fleet.sessionNames[0])
      .split("\n")
      .some((line) => line.trim() === "STARTUP_RECOVERED"),
  );
  assert.ok(!fleet.captureWindowPanes(fleet.sessionNames[0]).includes("STALE_STARTUP_INPUT"));
  assert.equal(brokerConnection, connection);
  assert.ok(!stderr.includes(host.ownerToken));
  console.log(
    JSON.stringify({
      passed: true,
      sameBrowser: true,
      startupRecovery: true,
      repeatedRecovery: true,
      staleInputRejected: true,
    }),
  );
} catch (error) {
  failures.push(error);
} finally {
  for (const cleanup of [
    () => native?.stop(),
    () => stopFixtureChild(browser),
    () => daemon?.stop(),
    () => fleet.dispose(),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
}
if (failures.length) throw new AggregateError(failures, "Native startup recovery fixture failed");
