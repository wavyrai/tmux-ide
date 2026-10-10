// Private real daemon metadata preference and the native follow-up protocol.
// No native window is launched; UI latch coverage lives in Rust headless tests.
import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
import { setTimeout } from "node:timers";
import { execFileSync, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";
import { listTmuxServers } from "../../../packages/daemon-client/src/tmux-server-client.ts";
import { stopFixtureChild } from "./fixture-child.mjs";
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
  slug: "gpui-session-open",
});
const run = (...args) =>
  execFileSync(fleet.environment.TMUX_IDE_TMUX_BIN, ["-S", fleet.socketPath, ...args], {
    env: { ...process.env, ...fleet.environment },
    encoding: "utf8",
    timeout: 5000,
  }).trim();
let daemon, browser, latest, fatal, result;
let buffer = "",
  stderr = "";
const failures = [];
async function until(predicate) {
  const deadline = Date.now() + 25000;
  for (;;) {
    if (fatal) throw fatal;
    if (predicate()) return;
    if (browser && (browser.exitCode !== null || browser.signalCode !== null))
      throw new Error("Browser exited");
    assert.ok(Date.now() < deadline, `Session-open deadline: ${latest?.status}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
try {
  const windows = run("list-windows", "-t", fleet.sessionNames[0], "-F", "#{window_id}").split(
    "\n",
  );
  assert.equal(windows.length, 2);
  run("select-window", "-t", windows[1]);
  const activeRuntime = run("display-message", "-p", "-t", windows[1], "#{pane_id}");
  daemon = await startDaemon(fleet);
  const options = {
    baseUrl: daemon.baseUrl + "/",
    ownerToken: daemon.record.authToken,
    hostClientId: "gpui-session-open",
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
    process.execPath,
    ["--import", "tsx", resolve("apps/tmux-gpui/bridge/browser.ts"), config],
    { env: { ...process.env, ...fleet.environment }, stdio: ["pipe", "pipe", "pipe"] },
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
  browser.stdout.on("data", (chunk) => {
    try {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        assert.ok(end <= 8 * 1024 * 1024);
        latest = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
      assert.ok(buffer.length <= 8 * 1024 * 1024);
    } catch (error) {
      fatal ??= error;
    }
  });
  const send = (command) => browser.stdin.write(JSON.stringify(command) + "\n");
  await until(() => latest?.sessions.length === 1);
  const session = latest.sessions[0].id;
  send({ type: "session", request: 1, id: session });
  await until(() => latest?.request === 1 && latest.status === "Choose a pane or window");
  assert.equal(latest.sessionCatalogComplete, true);
  assert.equal(latest.snapshot, null);
  assert.equal(latest.inputReady, false);
  assert.equal(latest.selectedPane, null);
  const expected = run("show-options", "-p", "-v", "-t", activeRuntime, "@tmux_ide_pane_id");
  assert.ok(expected);
  assert.notEqual(latest.panes[0].id, expected, "active window must not be first inventory choice");
  assert.equal(
    latest.preferredPane,
    expected,
    "metadata must identify authoritative current-window active pane",
  );
  send({ type: "pane", request: 2, id: latest.preferredPane });
  await until(() => latest?.request === 2 && latest.snapshot && latest.inputReady);
  assert.equal(latest.selectedPane, expected);
  assert.equal(latest.preferredPane, null);
  send({ type: "session", request: 3, id: session });
  send({ type: "home", request: 4 });
  await until(
    () => latest?.request === 4 && latest.surface === "home" && latest.home.phase === "live",
  );
  assert.equal(latest.preferredPane, null);
  assert.equal(latest.snapshot, null);
  assert.equal(latest.inputReady, false);
  result = {
    passed: true,
    currentWindowNotFirst: true,
    metadataOnly: true,
    explicitPaneFollowup: true,
    staleSessionRetired: true,
  };
} catch (error) {
  failures.push(error);
} finally {
  for (const cleanup of [
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
if (failures.length) throw new AggregateError(failures, "Session-open fixture failed");
console.log(JSON.stringify({ ...result, cleanup: true }));
