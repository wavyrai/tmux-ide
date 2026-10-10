// Real daemon + native browser protocol. Fixture panes self-report through the
// supported @agent_state contract; no external AI harness or native UI is used.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve, join, isAbsolute } from "node:path";
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";
import {
  createTmuxServerClient,
  listTmuxServers,
} from "../../../packages/daemon-client/src/tmux-server-client.ts";
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
const fleet = await createScratchFleet({ sessions: 1, windowsPerSession: 1, slug: "gpui-agents" });
const run = (...args) =>
  execFileSync(fleet.environment.TMUX_IDE_TMUX_BIN, ["-S", fleet.socketPath, ...args], {
    env: { ...process.env, ...fleet.environment },
    encoding: "utf8",
    timeout: 5000,
  }).trimEnd();
let daemon, client, browser, latest, result;
let partial = "",
  stderr = "",
  protocolError;
const failures = [];
async function until(predicate, description) {
  const deadline = Date.now() + 25000;
  while (!predicate()) {
    if (protocolError) throw protocolError;
    if (browser && (browser.exitCode !== null || browser.signalCode !== null))
      throw new Error(`Browser exited: ${stderr}`);
    assert.ok(Date.now() < deadline, `${description}; latest=${JSON.stringify(latest)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
try {
  const first = fleet.initialPanes[0].paneId;
  const second = run(
    "split-window",
    "-h",
    "-d",
    "-P",
    "-F",
    "#{pane_id}",
    "-t",
    first,
    "exec sh -i",
  );
  for (const [pane, state] of [
    [first, "working"],
    [second, "blocked"],
  ]) {
    run(
      "set-option",
      "-p",
      "-t",
      pane,
      "@agent_state",
      `${state}:${Math.floor(Date.now() / 1000)}`,
    );
    run("set-option", "-p", "-t", pane, "@agent_display_name", "Same agent name");
  }
  daemon = await startDaemon(fleet);
  const options = {
    baseUrl: daemon.baseUrl + "/",
    ownerToken: daemon.record.authToken,
    hostClientId: "gpui-agent-proof",
    origin: "tmux-ide://app",
  };
  const descriptor = (await listTmuxServers(options)).servers.find((s) => s.state === "online");
  assert.ok(descriptor);
  const scope = { serverId: descriptor.serverId, generation: descriptor.generation };
  client = createTmuxServerClient(options, scope);
  const session = (await client.sessions()).sessions[0];
  // Explicit registration is fixture setup, never a side effect of observing Home.
  await client.openSession(session.liveSessionId);
  const config = fleet.root + "/host.json";
  await writeFile(
    config,
    JSON.stringify({ baseUrl: options.baseUrl, ownerToken: options.ownerToken, scope }),
    { mode: 0o600 },
  );
  browser = spawn(
    app ? join(app, "Contents/Resources/node") : process.execPath,
    [
      ...(app ? [] : ["--import", "tsx"]),
      app
        ? join(app, "Contents/Resources/bridge/browser.bundle.mjs")
        : resolve("apps/tmux-gpui/bridge/browser.ts"),
      config,
    ],
    {
      env: { ...process.env, ...fleet.environment },
      stdio: ["pipe", "pipe", "pipe"],
      ...(app ? { cwd: fleet.root } : {}),
    },
  );
  browser.on("error", (error) => {
    protocolError = error;
  });
  browser.stdin.on("error", (error) => {
    protocolError = error;
  });
  browser.stderr.on("data", (data) => {
    stderr += data;
    if (stderr.length > 65536) protocolError = new Error("Oversized diagnostics");
  });
  browser.stdout.on("data", (data) => {
    try {
      partial += data;
      let end;
      while ((end = partial.indexOf("\n")) >= 0) {
        assert.ok(end <= 8 * 1024 * 1024);
        latest = JSON.parse(partial.slice(0, end));
        partial = partial.slice(end + 1);
      }
      assert.ok(partial.length <= 8 * 1024 * 1024);
    } catch (error) {
      protocolError = error;
    }
  });
  const send = (command) => browser.stdin.write(JSON.stringify(command) + "\n");
  await until(
    () => latest?.homeAgents?.phase === "live" && latest.homeAgents.rows.length === 2,
    "two Home agent rows",
  );
  assert.equal(latest.request, 0);
  assert.equal(latest.inputReady, false);
  const rows = latest.homeAgents.rows;
  assert.deepEqual(
    rows.map((r) => r.status),
    ["BLOCKED", "WORKING"],
  );
  assert.equal(rows[0].name, rows[1].name);
  assert.notEqual(rows[0].key, rows[1].key);
  assert.notEqual(rows[0].paneId, rows[1].paneId);
  assert.ok(rows.every((row) => row.available));
  const sessionId = rows[0].sessionId;
  send({ type: "session", request: 1, id: sessionId });
  await until(
    () =>
      latest?.request === 1 &&
      latest.workspaceAgents?.phase === "live" &&
      latest.workspaceAgents.rows.length === 2,
    "workspace roster",
  );
  const workspaceRows = latest.workspaceAgents.rows;
  assert.deepEqual(
    workspaceRows.map((row) => row.status),
    ["BLOCKED", "WORKING"],
  );
  assert.equal(workspaceRows[0].name, workspaceRows[1].name);
  await until(
    () =>
      latest.panes.length === 2 &&
      latest.status === "Choose a pane or window" &&
      latest.panes.every((pane) => pane.windowId || pane.window_id),
    "completed initial layout catalog",
  );
  const cachedIds = latest.panes.map((pane) => pane.id);
  const added = run(
    "split-window",
    "-v",
    "-d",
    "-P",
    "-F",
    "#{pane_id}",
    "-t",
    second,
    "exec sh -i",
  );
  run("set-option", "-p", "-t", added, "@agent_state", `working:${Math.floor(Date.now() / 1000)}`);
  run("set-option", "-p", "-t", added, "@agent_display_name", "Added after Workspace selection");
  await until(
    () =>
      latest.workspaceAgents?.phase === "live" &&
      latest.workspaceAgents.rows.some((row) => row.name === "Added after Workspace selection"),
    "new agent appears without reopening workspace",
  );
  const selected = latest.workspaceAgents.rows.find(
    (row) => row.name === "Added after Workspace selection",
  );
  assert.ok(selected.available);
  assert.ok(!cachedIds.includes(selected.paneId));
  assert.ok(!latest.panes.some((pane) => pane.id === selected.paneId));
  send({
    type: "open-workspace-agent",
    request: 2,
    fromRequest: 1,
    rosterRevision: latest.workspaceAgents.revision,
    key: selected.key,
    sessionId,
  });
  await until(
    () => latest?.request === 2 && latest.inputReady && latest.snapshot,
    "workspace exact pane ready",
  );
  assert.equal(latest.selectedPane, selected.paneId);
  const before = run("capture-pane", "-p", "-t", first);
  const secondBefore = run("capture-pane", "-p", "-t", second);
  send({
    type: "input",
    request: 2,
    id: selected.paneId,
    input: { kind: "text", data: "printf '\\nGPUI_WORKSPACE_AGENT_OK\\n'\n" },
  });
  await until(
    () =>
      run("capture-pane", "-p", "-t", added)
        .split("\n")
        .some((line) => line.trim() === "GPUI_WORKSPACE_AGENT_OK"),
    "exact target output",
  );
  assert.equal(run("capture-pane", "-p", "-t", first), before);
  assert.equal(run("capture-pane", "-p", "-t", second), secondBefore);
  await until(() => latest.workspaceAgents?.phase === "live", "fresh roster after pane selection");
  send({ type: "presence", active: false, revision: 1 });
  await until(() => latest.workspaceAgents === null, "background retirement");
  send({ type: "presence", active: true, revision: 2 });
  await until(() => latest.workspaceAgents?.phase === "live", "foreground observation");
  send({
    type: "open-workspace-agent",
    request: 3,
    fromRequest: 2,
    rosterRevision: latest.workspaceAgents.revision,
    key: selected.key,
    sessionId: "live-session." + "f".repeat(20),
  });
  await until(
    () => latest?.request === 3 && /unavailable/i.test(latest.status),
    "foreign selected session refusal",
  );
  assert.equal(latest.snapshot, null);
  assert.equal(latest.inputReady, false);
  assert.equal(latest.selectedPane, null);
  send({ type: "session", request: 4, id: sessionId });
  await until(
    () =>
      latest.request === 4 &&
      latest.status === "Choose a pane or window" &&
      latest.workspaceAgents?.phase === "live",
    "recover completed workspace catalog",
  );
  const removed = latest.workspaceAgents.rows.find((row) => row.paneId === selected.paneId);
  assert.ok(removed?.available);
  const removedRevision = latest.workspaceAgents.revision;
  run("kill-pane", "-t", added);
  send({
    type: "open-workspace-agent",
    request: 5,
    fromRequest: 4,
    rosterRevision: removedRevision,
    key: removed.key,
    sessionId,
  });
  await until(
    () => latest.request === 5 && /unavailable/i.test(latest.status),
    "removed exact target refuses without fallback",
  );
  assert.equal(latest.snapshot, null);
  assert.equal(latest.inputReady, false);
  assert.equal(latest.selectedPane, null);
  assert.equal(protocolError, undefined);
  assert.equal(stderr, "");
  result = {
    passed: true,
    duplicateNamesDistinct: true,
    attentionFirst: true,
    exactPaneInput: true,
    addedAfterSelectionAbsentCachedInventory: true,
    existingPanesUnchanged: true,
    staleSessionRejected: true,
    removedTargetNoFallback: true,
    backgroundRetired: true,
    nativeUi: false,
  };
} catch (error) {
  failures.push(error);
} finally {
  for (const cleanup of [
    () => stopFixtureChild(browser),
    () => client?.dispose(),
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
if (protocolError && !failures.includes(protocolError)) failures.push(protocolError);
if (failures.length) throw new AggregateError(failures, "Workspace agent journey failed");
console.log(JSON.stringify(result));
