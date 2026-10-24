import { startNativeJourney } from "./native-journey-fixture.mjs";
// Real browser command routing on an explicit private host: editor launch must stay unavailable.
// No native window or editor is launched; source sessions are disposable.
import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
import { setTimeout } from "node:timers";
import { execFileSync, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve, join, isAbsolute } from "node:path";
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";
import { listTmuxServers } from "../../../packages/daemon-client/src/tmux-server-client.ts";
import { stopFixtureChild } from "./fixture-child.mjs";
const app = process.env.TMUX_GPUI_TEST_APP;
if (app && !isAbsolute(app)) throw new Error("TMUX_GPUI_TEST_APP must be absolute");
for (const key of Object.keys(process.env)) {
  if (
    key.startsWith("TMUX_IDE_") ||
    ["TMUX", "TMUX_PANE", "TMUX_TMPDIR", "NODE_OPTIONS", "NODE_PATH"].includes(key)
  )
    delete process.env[key];
}
const fleet = await createScratchFleet({
  sessions: 1,
  windowsPerSession: 2,
  slug: "gpui-editor-action",
});
const run = (...args) =>
  execFileSync(fleet.environment.TMUX_IDE_TMUX_BIN, ["-S", fleet.socketPath, ...args], {
    env: { ...process.env, ...fleet.environment },
    encoding: "utf8",
    timeout: 5000,
  }).trim();
let daemon, browser, native, latest, fatal, result;
let stderr = "";
const failures = [];
async function until(predicate) {
  const deadline = Date.now() + 25000;
  for (;;) {
    native?.assertHealthy();
    if (fatal) throw fatal;
    if (predicate()) return;
    if (browser && (browser.exitCode !== null || browser.signalCode !== null))
      throw new Error("Browser exited");
    assert.ok(Date.now() < deadline, `Editor-action deadline: ${latest?.status}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
try {
  const windows = run("list-windows", "-t", fleet.sessionNames[0], "-F", "#{window_id}").split(
    "\n",
  );
  assert.equal(windows.length, 2);
  run("select-window", "-t", windows[1]);
  let activeRuntime = run("display-message", "-p", "-t", windows[1], "#{pane_id}");
  daemon = await startDaemon(fleet);
  const options = {
    baseUrl: daemon.baseUrl + "/",
    ownerToken: daemon.record.authToken,
    hostClientId: "gpui-editor-action",
    origin: "tmux-ide://app",
  };
  const server = (await listTmuxServers(options)).servers.find((s) => s.state === "online");
  assert.ok(server);
  const config = fleet.root + "/host.json";
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
    app ? join(app, "Contents/Resources/node") : process.execPath,
    app
      ? [join(app, "Contents/Resources/bridge/browser.bundle.mjs"), config]
      : ["--import", "tsx", resolve("apps/tmux-gpui/bridge/browser.ts"), config],
    {
      env: { ...process.env, ...fleet.environment, ...(app ? { PATH: "/usr/bin:/bin" } : {}) },
      ...(app ? { cwd: fleet.root } : {}),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  browser.on("error", (error) => {
    fatal ??= error;
  });
  browser.stdin.on("error", (error) => {
    fatal ??= error;
  });
  browser.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-4096);
  });
  native = startNativeJourney(browser, {
    worker: true,
    onState: (state) => {
      latest = state;
    },
  });
  const send = (command) => native.send(command);
  await until(() => latest?.sessions.length === 1);
  const session = latest.sessions[0].id;
  send({ type: "presence", active: true, revision: 1 });
  send({ type: "session", request: 1, id: session });
  await until(() => latest?.request === 1 && latest.status === "Choose a pane or window");
  assert.equal(latest.sessionCatalogComplete, true);
  assert.equal(latest.snapshot, null);
  assert.equal(latest.inputReady, false);
  assert.equal(latest.selectedPane, null);
  // Native topology is keyed by semantic window identity, not creation order.
  // Select the actual last catalog choice so this scenario is deterministic.
  const expected = latest.panes.at(-1).id;
  const nativeRow = run("list-panes", "-a", "-F", "#{pane_id}|#{@tmux_ide_pane_id}")
    .split("\n")
    .find((row) => row.split("|")[1] === expected);
  assert.ok(nativeRow);
  activeRuntime = nativeRow.split("|")[0];
  send({ type: "home", request: 2 });
  await until(() => latest?.request === 2 && latest.surface === "home");
  run("select-window", "-t", activeRuntime);
  send({ type: "session", request: 3, id: session });
  await until(() => latest?.request === 3 && latest.sessionCatalogComplete);
  assert.ok(expected);
  assert.notEqual(latest.panes[0].id, expected, "active window must not be first inventory choice");
  assert.equal(
    latest.preferredPane,
    expected,
    "metadata must identify authoritative current-window active pane",
  );
  send({ type: "pane", request: 4, id: latest.preferredPane });
  await until(() => latest?.request === 4 && latest.snapshot && latest.inputReady);
  assert.equal(latest.selectedPane, expected);
  assert.equal(latest.preferredPane, null);
  assert.ok(latest.paneActions?.token);
  const action = { type: "open-editor", request: 4, id: expected, token: latest.paneActions.token };
  const before = run("capture-pane", "-p", "-t", activeRuntime);
  send({ ...action, request: 1 });
  send({ type: "presence", active: true, revision: 42 });
  await until(() => latest?.presenceRevision === 42 && latest.inputReady && latest.paneActions);
  action.token = latest.paneActions.token;
  assert.notEqual(latest.status, "Open folder requires verified local daemon discovery");
  send(action);
  await until(() => latest?.status === "Open folder requires verified local daemon discovery");
  assert.equal(latest.selectedPane, expected);
  assert.equal(latest.inputReady, true);
  assert.equal(run("capture-pane", "-p", "-t", activeRuntime), before);
  // Replayed command must not disturb navigation or escalate a private host to local authority.
  send(action);
  send({ type: "home", request: 5 });
  await until(() => latest?.request === 5 && latest.surface === "home");
  result = {
    passed: true,
    runtime: app ? "packaged-node-and-browser" : "source",
    staleEditorRequestIgnored: true,
    explicitHostLaunchUnavailable: true,
    currentSelectionRetained: true,
    noTerminalInput: true,
    navigationAfterReplay: true,
  };
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
if (fatal) failures.push(fatal);
if (failures.length) throw new AggregateError(failures, "Editor-action fixture failed");
console.log(JSON.stringify({ ...result, cleanup: true }));
