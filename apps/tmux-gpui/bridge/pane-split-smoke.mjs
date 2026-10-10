// Real canonical split mutations on one private session; no native GUI.
// Receipt-driven refresh must preserve source selection and show both new panes.
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
  windowsPerSession: 1,
  slug: "gpui-pane-split",
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
    assert.ok(Date.now() < deadline, `Pane-split deadline: ${latest?.status}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
try {
  daemon = await startDaemon(fleet);
  const options = {
    baseUrl: daemon.baseUrl + "/",
    ownerToken: daemon.record.authToken,
    hostClientId: "gpui-pane-split",
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
  send({ type: "presence", active: true, revision: 1 });
  send({ type: "session", request: 1, id: session });
  await until(() => latest?.request === 1 && latest.sessionCatalogComplete);
  const original = latest.preferredPane;
  assert.ok(original);
  send({ type: "pane", request: 2, id: original });
  await until(() => latest?.inputReady && latest.paneActions);
  const created = [];
  let revision = 1;
  for (const direction of ["right", "down"]) {
    const before = latest.regions.map((region) => region.id);
    const command = {
      type: "pane-action",
      request: 2,
      id: original,
      token: latest.paneActions.token,
      action: "split",
      direction,
    };
    send(command);
    send(command); // Already-consumed capability cannot dispatch a second mutation.
    await until(
      () => latest?.inputReady && latest.paneActions && latest.regions.length === before.length + 1,
    );
    assert.equal(latest.selectedPane, original);
    const added = latest.regions.filter((region) => !before.includes(region.id));
    assert.equal(added.length, 1);
    assert.notEqual(added[0].id, original);
    const source = latest.regions.find((region) => region.id === original);
    assert.ok(
      direction === "right"
        ? added[0].left > source.left && added[0].top === source.top
        : added[0].top > source.top && added[0].left === source.left,
    );
    created.push(added[0].id);
    send(command); // Completed old capability still cannot replay.
    send({ type: "presence", active: true, revision: ++revision });
    await until(() => latest?.presenceRevision === revision);
    assert.equal(
      run("list-panes", "-t", fleet.sessionNames[0], "-F", "#{pane_id}").split("\n").length,
      before.length + 1,
    );
  }
  send({
    type: "pane-action",
    request: 1,
    id: original,
    token: latest.paneActions.token,
    action: "split",
    direction: "right",
  });
  send({ type: "presence", active: true, revision: ++revision });
  await until(() => latest?.presenceRevision === revision);
  assert.equal(latest.regions.length, 3);
  assert.equal(latest.selectedPane, original);
  send({
    type: "input",
    request: 2,
    id: original,
    input: { kind: "resize", data: { cols: 20, rows: 5 } },
  });
  await until(
    () =>
      latest?.inputReady &&
      latest.paneActions &&
      latest.regions.find((region) => region.id === original)?.height === 2,
  );
  const failed = {
    type: "pane-action",
    request: 2,
    id: original,
    token: latest.paneActions.token,
    action: "split",
    direction: "down",
  };
  send(failed);
  await until(() => latest?.status === "Pane action unavailable — reselect pane to retry");
  assert.equal(
    run("list-panes", "-t", fleet.sessionNames[0], "-F", "#{pane_id}").split("\n").length,
    3,
  );
  send(failed);
  send({ type: "presence", active: true, revision: ++revision });
  await until(() => latest?.presenceRevision === revision);
  assert.equal(
    run("list-panes", "-t", fleet.sessionNames[0], "-F", "#{pane_id}").split("\n").length,
    3,
  );
  result = {
    passed: true,
    rightAndDown: true,
    noSpaceFailureNoRetry: true,
    preservesOriginalSelection: true,
    distinctNewPanes: new Set(created).size === 2,
    duplicateAndStaleRefused: true,
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
if (failures.length) throw new AggregateError(failures, "Pane-split fixture failed");
console.log(JSON.stringify({ ...result, cleanup: true }));
