// Read-only Home prerequisites; session registration is explicit fixture setup.
import assert from "node:assert/strict";
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";
import {
  createTmuxServerClient,
  listTmuxServers,
} from "../../../packages/daemon-client/src/tmux-server-client.ts";
import { projectHomeAgentRows } from "../../../packages/presentation/src/home-agent-roster.ts";
import { createPreviewCatalog } from "./catalog.ts";
import { createHomeAgentObserver } from "./home-agents.ts";
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
  slug: "gpui-roster-read",
});
let daemon, client, catalog, observer, result;
const failures = [];
try {
  daemon = await startDaemon(fleet);
  const options = {
    baseUrl: daemon.baseUrl + "/",
    ownerToken: daemon.record.authToken,
    hostClientId: "gpui-roster-proof",
    origin: "tmux-ide://app",
  };
  const server = (await listTmuxServers(options)).servers.find((s) => s.state === "online");
  assert.ok(server);
  const scope = { serverId: server.serverId, generation: server.generation };
  client = createTmuxServerClient(options, scope);
  catalog = createPreviewCatalog({
    baseUrl: options.baseUrl,
    ownerToken: options.ownerToken,
    scope,
  });
  const initial = await client.sessions();
  assert.equal(initial.sessions.length, 1);
  const session = initial.sessions[0];
  const before = fleet.captureWindowPanes(fleet.sessionNames[0]);
  await assert.rejects(
    client.applicationShell("fixture-unregistered-workspace", session.liveSessionId),
    { code: "request-failed", status: 404 },
  );
  assert.deepEqual(
    await client.sessions(),
    initial,
    "reading missing workspace must not register it",
  );
  // Registration is a separate setup action, never part of Home observation.
  const opened = await client.openSession(session.liveSessionId);
  const registered = await client.sessions();
  const homeSessions = await catalog.homeSessions();
  assert.equal(homeSessions.length, 1);
  const homeSession = homeSessions[0];
  assert.equal(homeSession.workspaceName, opened.workspaceName);
  const controller = new AbortController();
  assert.throws(() =>
    catalog.readHomeShell({ ...homeSession, workspaceName: undefined }, controller.signal),
  );
  assert.throws(() =>
    catalog.readHomeShell(
      { ...homeSession, server: { ...scope, generation: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } },
      controller.signal,
    ),
  );
  const shell = await catalog.readHomeShell(homeSession, controller.signal);
  let complete;
  const observed = new Promise((resolve) => {
    complete = resolve;
  });
  observer = createHomeAgentObserver({
    readShell: (target, signal) => catalog.readHomeShell(target, signal),
    publish: (state) => {
      if (state.loadingSessions === 0) complete(state);
    },
  });
  observer.refresh(homeSessions);
  const observedState = await observed;
  assert.equal(observedState.phase, "live");
  assert.equal(observedState.observedSessions, 1);
  assert.equal(observedState.unavailableSessions, 0);
  assert.equal(shell.server.serverId, server.serverId);
  assert.equal(shell.server.generation, server.generation);
  const rows = projectHomeAgentRows(
    {
      id: session.liveSessionId,
      liveSessionId: session.liveSessionId,
      name: session.sessionName,
      server,
    },
    { resource: shell.resource, daemon: { instanceId: server.generation } },
  );
  assert.ok(
    rows.every(
      (row) =>
        row.liveSessionId === session.liveSessionId && row.daemonInstanceId === server.generation,
    ),
  );
  assert.deepEqual(await client.sessions(), registered);
  assert.equal(fleet.captureWindowPanes(fleet.sessionNames[0]), before);
  result = {
    passed: true,
    missingWorkspaceDoesNotRegister: true,
    explicitSetupRegistration: true,
    authenticatedScopedRead: true,
    catalogObserverRead: true,
    sourceUnchanged: true,
    projectedAgents: rows.length,
    nativeUi: false,
  };
} catch (error) {
  failures.push(error);
} finally {
  for (const cleanup of [
    () => observer?.dispose(),
    () => catalog?.dispose(),
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
if (failures.length) throw new AggregateError(failures, "Home roster read fixture failed");
console.log(JSON.stringify(result));
