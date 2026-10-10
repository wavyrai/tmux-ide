// Real isolated Home/workspace roundtrip. No GUI or personal tmux server access.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";
import { listTmuxServers } from "../../../packages/daemon-client/src/tmux-server-client.ts";

// Save no inherited server/development selectors: every resource below is fixture-owned.
for (const key of Object.keys(process.env))
  if (key.startsWith("TMUX_IDE_") || ["TMUX", "TMUX_PANE", "TMUX_TMPDIR"].includes(key))
    delete process.env[key];
const fleet = await createScratchFleet({
  sessions: 1,
  slug: "gpui-home",
  windowsPerSession: 1,
  initialPaneMarker: "RIG_GPUI_HOME_SOURCE",
});
let daemon, browser;
let latest,
  buffer = "",
  stderr = "";
const events = [];
const until = async (predicate) => {
  const deadline = Date.now() + 20000;
  while (!predicate()) {
    if (browser && (browser.exitCode !== null || browser.signalCode !== null))
      throw new Error("Home browser exited");
    assert.ok(Date.now() < deadline, "Home fixture deadline");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
try {
  daemon = await startDaemon(fleet);
  const options = {
    baseUrl: daemon.baseUrl + "/",
    ownerToken: daemon.record.authToken,
    hostClientId: "gpui-home-test",
    origin: "tmux-ide://app",
  };
  const { servers } = await listTmuxServers(options);
  const server = servers.find((server) => server.state === "online");
  assert.ok(server);
  const config = fleet.root + "/home-host.json";
  await writeFile(
    config,
    JSON.stringify({
      baseUrl: options.baseUrl,
      ownerToken: options.ownerToken,
      scope: { serverId: server.serverId, generation: server.generation },
    }),
    { mode: 0o600 },
  );
  browser = spawn(
    process.execPath,
    ["--import", "tsx", resolve("apps/tmux-gpui/bridge/browser.ts"), config],
    { env: { ...process.env, ...fleet.environment }, stdio: ["pipe", "pipe", "pipe"] },
  );
  browser.stderr.on("data", (data) => {
    stderr += data;
    assert.ok(stderr.length < 65536);
  });
  browser.stdout.on("data", (data) => {
    buffer += data;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      latest = JSON.parse(buffer.slice(0, end));
      events.push(latest);
      buffer = buffer.slice(end + 1);
    }
    assert.ok(buffer.length <= 8 * 1024 * 1024);
  });
  const send = (command) => browser.stdin.write(JSON.stringify(command) + "\n");
  await until(() => latest?.surface === "home" && latest.home.phase === "live");
  assert.equal(latest.sessions.length, 1);
  assert.equal(latest.snapshot, null);
  assert.equal(latest.inputReady, false);
  assert.equal(latest.selectedSession, null);
  const session = latest.sessions[0].id;
  const connection = latest.connection;
  const naturalGrid = fleet.windowGrid(fleet.sessionNames[0]);
  send({ type: "session", request: 1, id: session });
  await until(() => latest?.request === 1 && latest.panes.length > 0);
  assert.equal(latest.surface, "workspace");
  const pane = latest.panes[0].id;
  send({ type: "pane", request: 2, id: pane });
  await until(() => latest?.request === 2 && latest.inputReady && latest.snapshot);
  send({
    type: "input",
    request: 2,
    id: pane,
    input: { kind: "resize", data: { cols: 91, rows: 27 } },
  });
  await until(() => fleet.windowGrid(fleet.sessionNames[0]).cols === 91);
  send({ type: "home", request: 3 });
  await until(() => latest?.request === 3 && latest.home.phase === "live");
  assert.equal(latest.surface, "home");
  assert.equal(latest.selectedSession, null);
  assert.equal(latest.selectedPane, null);
  assert.deepEqual(latest.panes, []);
  assert.equal(latest.snapshot, null);
  assert.equal(latest.inputReady, false);
  assert.deepEqual(latest.regions, []);
  assert.equal(latest.copyRegion, null);
  await until(
    () => JSON.stringify(fleet.windowGrid(fleet.sessionNames[0])) === JSON.stringify(naturalGrid),
  );
  const before = fleet.captureWindowPanes(fleet.sessionNames[0]);
  for (const request of [2, 3])
    send({
      type: "input",
      request,
      id: pane,
      input: { kind: "text", data: "HOME_MUST_NOT_REACH_SOURCE\n" },
    });
  // Ordered publication is a fence after both rejected inputs, not a timing guess.
  const sequence = latest.sequence;
  send({ type: "presence", active: true, revision: 1 });
  await until(() => latest.sequence > sequence);
  assert.equal(latest.inputReady, false);
  assert.equal(fleet.captureWindowPanes(fleet.sessionNames[0]), before);
  assert.deepEqual(
    latest.sessions.map((item) => item.id),
    [session],
  );
  send({ type: "session", request: 4, id: session });
  await until(() => latest?.request === 4 && latest.panes.length > 0);
  send({ type: "pane", request: 5, id: pane });
  await until(() => latest?.request === 5 && latest.inputReady && latest.snapshot);
  assert.equal(latest.connection, connection);
  send({
    type: "input",
    request: 5,
    id: pane,
    input: { kind: "text", data: "printf '\\nGPUI_HOME_RETURN_OK\\n'\n" },
  });
  await until(() =>
    fleet
      .captureWindowPanes(fleet.sessionNames[0])
      .split("\n")
      .some((line) => line.trim() === "GPUI_HOME_RETURN_OK"),
  );
  assert.ok(
    events
      .filter((event) => event.request === 3)
      .every((event) => !event.snapshot && !event.inputReady && event.selectedPane === null),
  );
  assert.equal(stderr, "");
  console.log(
    JSON.stringify({
      passed: true,
      homeWorkspaceHome: true,
      sourceSurvives: true,
      geometryClaimReleased: true,
      staleInputRejected: true,
      sameProcessRecovery: true,
      nativeUi: "not exercised",
    }),
  );
} finally {
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
  if (daemon) await daemon.stop();
  await fleet.dispose();
}
