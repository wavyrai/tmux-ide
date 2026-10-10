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
  const selected = rows[0];
  send({
    type: "open-agent",
    request: 1,
    fromRequest: 0,
    rosterRevision: latest.homeAgents.revision,
    key: selected.key,
  });
  await until(
    () => latest?.request === 1 && latest.inputReady && latest.snapshot,
    "exact agent pane input",
  );
  assert.equal(latest.selectedPane, selected.paneId);
  const firstBefore = run("capture-pane", "-p", "-t", first);
  send({
    type: "input",
    request: 1,
    id: selected.paneId,
    input: { kind: "text", data: "printf '\\nGPUI_AGENT_EXACT_OPEN_OK\\n'\n" },
  });
  await until(
    () =>
      run("capture-pane", "-p", "-t", second)
        .split("\n")
        .some((line) => line.trim() === "GPUI_AGENT_EXACT_OPEN_OK"),
    "input reaches second pane",
  );
  assert.equal(run("capture-pane", "-p", "-t", first), firstBefore);
  send({ type: "home", request: 2 });
  await until(
    () =>
      latest?.request === 2 &&
      latest.homeAgents?.phase === "live" &&
      latest.homeAgents.rows.length === 2,
    "return Home",
  );
  const oldRevision = latest.homeAgents.revision;
  send({
    type: "open-agent",
    request: 3,
    fromRequest: 0,
    rosterRevision: oldRevision,
    key: selected.key,
  });
  await until(() => latest?.request === 3, "stale Home click acknowledged safely");
  assert.equal(latest.inputReady, false);
  assert.equal(latest.snapshot, null);
  send({ type: "home", request: 4 });
  await until(
    () =>
      latest?.request === 4 &&
      latest.homeAgents?.phase === "live" &&
      latest.homeAgents.rows.length === 2,
    "Home recovers after stale action",
  );
  send({ type: "presence", active: false, revision: 1 });
  await until(
    () => latest?.presenceRevision === 1 && latest.homeAgents === null,
    "background retires agent observation",
  );
  send({ type: "presence", active: true, revision: 2 });
  await until(
    () =>
      latest?.presenceRevision === 2 &&
      latest.homeAgents?.phase === "live" &&
      latest.homeAgents.rows.length === 2,
    "foreground renews observation",
  );
  const removed = latest.homeAgents.rows.find((row) => row.paneId === selected.paneId);
  assert.ok(removed);
  const revision = latest.homeAgents.revision;
  run("kill-pane", "-t", second);
  send({
    type: "open-agent",
    request: 5,
    fromRequest: 4,
    rosterRevision: revision,
    key: removed.key,
  });
  await until(
    () => latest?.request === 5 && /unavailable/i.test(latest.status),
    "removed agent pane fails without fallback",
  );
  assert.equal(latest.inputReady, false);
  assert.equal(latest.snapshot, null);
  assert.equal(latest.selectedPane, null);
  assert.equal(protocolError, undefined);
  assert.equal(stderr, "");
  result = {
    passed: true,
    packagedApp: app ?? null,
    supportedAgentStateFixtures: true,
    duplicateNamesDistinct: true,
    attentionFirst: true,
    exactPaneInput: true,
    staleHomeClickRejected: true,
    foregroundObservationRenewed: true,
    removedPaneNoFallback: true,
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
if (failures.length) throw new AggregateError(failures, "Home agent journey failed");
console.log(JSON.stringify(result));
