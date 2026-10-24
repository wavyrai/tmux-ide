import { startNativeJourney } from "./native-journey-fixture.mjs";
// Real scoped pane closure in a private session; no GUI or CLI build.
// Only a fresh canonical surviving active pane may become selected.
import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
import { setTimeout } from "node:timers";
import { execFileSync, spawn } from "node:child_process";
import { access, stat, writeFile, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, join, isAbsolute } from "node:path";
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";

import { listTmuxServers } from "../../../packages/daemon-client/src/tmux-server-client.ts";
import { stopFixtureChild } from "./fixture-child.mjs";
const cli = process.env.TMUX_GPUI_TEST_CLI;
assert.ok(cli && isAbsolute(cli), "Explicit private TMUX_GPUI_TEST_CLI required");
const layout = process.env.TMUX_GPUI_CLOSE_LAYOUT ?? "panes";
assert.ok(["panes", "windows"].includes(layout), "TMUX_GPUI_CLOSE_LAYOUT must be panes or windows");
const app = process.env.TMUX_GPUI_TEST_APP;
if (app !== undefined) {
  assert.ok(isAbsolute(app), "TMUX_GPUI_TEST_APP must be absolute");
  assert.ok((await stat(app)).isDirectory());
  for (const file of ["node", "bridge/browser.bundle.mjs"]) {
    const path = join(app, "Contents/Resources", file);
    assert.ok((await stat(path)).isFile());
    await access(path, file === "node" ? constants.X_OK : constants.R_OK);
  }
}
for (const key of Object.keys(process.env)) {
  if (
    key.startsWith("TMUX_IDE_") ||
    ["TMUX", "TMUX_PANE", "TMUX_TMPDIR", "NODE_OPTIONS", "NODE_PATH"].includes(key)
  )
    delete process.env[key];
}
const fleet = await createScratchFleet({
  sessions: 1,
  windowsPerSession: layout === "windows" ? 2 : 1,
  slug: "gpui-close-pane",
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
    if (predicate()) {
      native?.assertHealthy();
      if (fatal) throw fatal;
      return;
    }
    if (browser && (browser.exitCode !== null || browser.signalCode !== null))
      throw new Error("Browser exited");
    assert.ok(
      Date.now() < deadline,
      `Close-pane deadline: ${JSON.stringify({ status: latest?.status, selectedPane: latest?.selectedPane, panes: latest?.panes, presence: latest?.presenceRevision, hasSnapshot: !!latest?.snapshot, inputReady: latest?.inputReady })}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
try {
  if (layout === "panes") run("split-window", "-h", "-d", "-t", fleet.initialPanes[0].paneId);
  daemon = spawn(process.execPath, [cli, "--headless"], {
    env: { ...process.env, ...fleet.environment },
    stdio: "ignore",
  });
  daemon.on("error", (error) => {
    fatal ??= error;
  });
  let record;
  const deadline = Date.now() + 25000;
  while (!record) {
    native?.assertHealthy();
    if (fatal) throw fatal;
    assert.ok(Date.now() < deadline, "Daemon startup deadline");
    try {
      const value = JSON.parse(await readFile(fleet.daemonInfoDir + "/daemon.json", "utf8"));
      if (value.pid === daemon.pid) record = value;
    } catch {
      // Wait for the owned daemon atomic discovery record.
    }
    if (!record) await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const options = {
    baseUrl: `http://127.0.0.1:${record.port}/`,
    ownerToken: record.authToken,
    hostClientId: "gpui-close-pane",
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
  assert.equal(latest.sessions[0].paneCount, 2);
  send({ type: "presence", active: true, revision: 1 });
  send({ type: "session", request: 1, id: session });
  await until(() => latest?.request === 1 && latest.sessionCatalogComplete);
  const original = latest.preferredPane;
  assert.ok(original);
  send({ type: "pane", request: 2, id: original });
  await until(() => latest?.inputReady && latest.paneActions);
  const sourceRows = () =>
    run(
      "list-panes",
      "-a",
      "-F",
      "#{pane_id}|#{pane_pid}|#{pane_birth_id}|#{@tmux_ide_pane_id}|#{window_id}",
    ).split("\n");
  const before = sourceRows();
  const killed = before.find((row) => row.split("|")[3] === original);
  const sibling = before.find((row) => row.split("|")[3] !== original);
  assert.ok(killed && sibling);
  assert.equal(killed.split("|")[4] === sibling.split("|")[4], layout === "panes");
  const [siblingNative, , , siblingSemantic] = sibling.split("|");
  const command = {
    type: "pane-action",
    request: 2,
    id: original,
    token: latest.paneActions.token,
    action: "close",
  };
  send({ type: "presence", active: false, revision: 2 });
  await until(() => latest?.presenceRevision === 2);
  send(command);
  send({ type: "presence", active: false, revision: 3 });
  await until(() => latest?.presenceRevision === 3);
  assert.deepEqual(sourceRows(), before, "Background close must not delete");
  send({ type: "presence", active: true, revision: 4 });
  await until(() => latest?.presenceRevision === 4 && latest.inputReady && latest.paneActions);
  send(command);
  send({ type: "presence", active: true, revision: 5 });
  await until(() => latest?.presenceRevision === 5 && latest.inputReady && latest.paneActions);
  assert.deepEqual(sourceRows(), before, "Stale token must not delete");
  const close = { ...command, token: latest.paneActions.token };
  send(close);
  send(close);
  await until(
    () => latest?.inputReady && latest.selectedPane === siblingSemantic && latest.paneActions,
  );
  assert.deepEqual(
    sourceRows(),
    [sibling],
    "Only captured pane removed; sibling PID and birth unchanged",
  );
  assert.equal(latest.sessions.find((s) => s.id === session).paneCount, 1);
  const marker = "GPUI_CLOSE_SURVIVOR_INPUT_OK";
  send({
    type: "input",
    request: 2,
    id: siblingSemantic,
    input: { kind: "text", data: "printf '\\n" + marker + "\\n'" },
  });
  send({ type: "input", request: 2, id: siblingSemantic, input: { kind: "key", data: "Enter" } });
  await until(() =>
    run("capture-pane", "-p", "-t", siblingNative)
      .split("\n")
      .some((line) => line.trim() === marker),
  );
  send(close);
  send({ type: "presence", active: true, revision: 6 });
  await until(() => latest?.presenceRevision === 6 && latest.paneActions);
  assert.deepEqual(sourceRows(), [sibling]);
  send({
    type: "pane-action",
    request: 2,
    id: siblingSemantic,
    token: latest.paneActions.token,
    action: "close",
  });
  await until(
    () =>
      latest?.inputReady &&
      latest.selectedPane === siblingSemantic &&
      latest.status === "Pane action was not applied",
  );
  const refusalMarker = "GPUI_CLOSE_REFUSED_INPUT_OK";
  send({
    type: "input",
    request: 2,
    id: siblingSemantic,
    input: { kind: "text", data: "printf '\\n" + refusalMarker + "\\n'" },
  });
  send({ type: "input", request: 2, id: siblingSemantic, input: { kind: "key", data: "Enter" } });
  await until(() =>
    run("capture-pane", "-p", "-t", siblingNative)
      .split("\n")
      .some((line) => line.trim() === refusalMarker),
  );
  assert.deepEqual(sourceRows(), [sibling], "Canonical last-pane refusal preserves the session");
  result = {
    passed: true,
    layout,
    closedWindow: layout === "windows",
    exactPaneRemoved: true,
    canonicalSurvivorSelected: true,
    survivorInput: true,
    siblingIdentityPreserved: true,
    lastPaneRefused: true,
    refusedPaneInput: true,
    duplicateStaleBackgroundRefused: true,
  };
} catch (error) {
  failures.push(error);
  console.error(
    JSON.stringify({
      stage: "native-close-failure",
      diagnostic: native?.diagnostic,
      commands: native?.commands,
      opens: native?.opens,
      states: native?.states.slice(-20).map(
        (event) =>
          event.state && {
            request: event.state.request,
            presence: event.state.presenceRevision,
            ready: event.state.inputReady,
            status: event.state.status,
            selectedPane: event.state.selectedPane,
          },
      ),
      nativePanes: run("list-panes", "-a", "-F", "#{pane_id}|#{@tmux_ide_pane_id}"),
    }),
  );
} finally {
  for (const cleanup of [
    () => native?.stop(),
    () => stopFixtureChild(browser),
    () => daemon && stopFixtureChild(daemon),
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
if (failures.length) throw new AggregateError(failures, "Close-pane fixture failed");
console.log(JSON.stringify({ ...result, cleanup: true }));
