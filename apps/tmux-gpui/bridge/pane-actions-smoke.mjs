// Rename and explicit zoom through the browser bridge on an owned tmux socket.
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";
import { listTmuxServers } from "../../../packages/daemon-client/src/tmux-server-client.ts";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
import { setTimeout, clearTimeout } from "node:timers";

for (const key of Object.keys(process.env)) {
  if (
    key.startsWith("TMUX_IDE_") ||
    ["TMUX", "TMUX_PANE", "TMUX_TMPDIR", "NODE_OPTIONS", "NODE_PATH"].includes(key)
  )
    delete process.env[key];
}
const fleet = await createScratchFleet({ sessions: 1, windowsPerSession: 1, slug: "gpui-actions" });
let daemon, helper, failure;
let diagnostic = "";
const events = [];
const tmux = (...args) =>
  execFileSync(fleet.environment.TMUX_IDE_TMUX_BIN, ["-S", fleet.socketPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...fleet.environment },
  }).trim();
const wait = async (predicate, label) => {
  const end = Date.now() + 30000;
  while (!predicate()) {
    if (helper?.exitCode != null || helper?.signalCode != null)
      throw new Error("Helper exited: " + diagnostic);
    if (Date.now() > end) {
      const event = events.at(-1);
      throw new Error(
        label +
          " deadline: " +
          diagnostic +
          JSON.stringify({
            request: event?.request,
            inputReady: event?.inputReady,
            paneActions: event?.paneActions,
            regions: event?.regions,
            hasSnapshot: !!event?.snapshot,
            status: event?.status,
          }),
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
};
const send = (command) => helper.stdin.write(JSON.stringify(command) + "\n");
const latest = () => events.at(-1);
const ready = () => latest()?.inputReady && latest()?.snapshot && latest()?.paneActions;
let presence = 1;
const barrier = async () => {
  const revision = ++presence;
  send({ type: "presence", active: true, revision });
  await wait(() => latest()?.presenceRevision === revision, "command barrier");
};
try {
  const session = fleet.sessionNames[0];
  const first = tmux("display-message", "-p", "-t", session, "#{pane_id}");
  const second = tmux("split-window", "-h", "-P", "-F", "#{pane_id}", "-t", first, "sh -i");
  daemon = await startDaemon(fleet);
  const options = {
    baseUrl: daemon.baseUrl + "/",
    ownerToken: daemon.record.authToken,
    hostClientId: "gpui-pane-actions-proof",
    origin: "tmux-ide://app",
  };
  const { servers } = await listTmuxServers(options);
  const server = servers.find((s) => s.state === "online");
  assert.ok(server);
  const config = fleet.root + "/actions.json";
  await writeFile(
    config,
    JSON.stringify({
      baseUrl: options.baseUrl,
      ownerToken: options.ownerToken,
      scope: { serverId: server.serverId, generation: server.generation },
    }),
    { mode: 0o600 },
  );
  helper = spawn(
    process.execPath,
    [
      ...(process.env.TMUX_GPUI_TEST_BUNDLE ? [] : ["--import", "tsx"]),
      process.env.TMUX_GPUI_TEST_BUNDLE
        ? resolve(process.env.TMUX_GPUI_TEST_BUNDLE, "browser.bundle.mjs")
        : resolve("apps/tmux-gpui/bridge/browser.ts"),
      config,
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...fleet.environment },
      ...(process.env.TMUX_GPUI_TEST_BUNDLE ? { cwd: fleet.root } : {}),
    },
  );
  helper.stderr.on("data", (b) => (diagnostic = (diagnostic + b).slice(-4000)));
  let buffer = "";
  helper.stdout.on("data", (b) => {
    buffer += b;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      events.push(JSON.parse(buffer.slice(0, end)));
      if (events.length > 500) events.shift();
      buffer = buffer.slice(end + 1);
    }
  });
  await wait(() => latest()?.sessions?.length === 1, "catalog");
  send({ type: "presence", active: true, revision: presence });
  send({ type: "session", request: 1, id: latest().sessions[0].id });
  await wait(() => latest()?.panes?.length === 2, "pane catalog");
  send({ type: "pane", request: 2, id: latest().panes[0].id });
  await wait(ready, "pane actions ready");
  const original = { request: latest().request, ...latest().paneActions };
  const region = latest().regions.find((p) => p.id === original.id);
  const target = region.left === 0 ? first : second;
  const neighbor = target === first ? second : first;
  const neighborName = tmux("display-message", "-p", "-t", neighbor, "#{pane_title}");
  const name = "Native #{pane_id} ✓";
  send({
    type: "pane-action",
    request: original.request,
    id: original.id,
    token: original.token,
    action: "rename",
    name,
  });
  await wait(
    () => ready() && latest().panes.some((p) => p.id === original.id && p.label === name),
    "verified rename publication",
  );
  assert.equal(tmux("display-message", "-p", "-t", target, "#{pane_title}"), name);
  assert.equal(tmux("show-options", "-p", "-v", "-t", target, "@ide_name"), name);
  assert.equal(tmux("display-message", "-p", "-t", neighbor, "#{pane_title}"), neighborName);
  assert.notEqual(latest().paneActions.token, original.token);
  send({
    type: "pane-action",
    request: original.request,
    id: original.id,
    token: original.token,
    action: "rename",
    name: "STALE_MUST_NOT_APPLY",
  });
  await barrier();
  assert.equal(tmux("display-message", "-p", "-t", target, "#{pane_title}"), name);

  const zoom = {
    type: "pane-action",
    request: latest().request,
    id: latest().selectedPane,
    token: latest().paneActions.token,
    action: "zoom",
    desired: "zoomed",
  };
  send(zoom);
  await wait(
    () => ready() && latest().paneActions.zoomed && latest().regions.length === 1,
    "verified zoom",
  );
  assert.equal(tmux("display-message", "-p", "-t", target, "#{window_zoomed_flag}"), "1");
  send(zoom); // A duplicate must never toggle back.
  await barrier();
  assert.equal(tmux("display-message", "-p", "-t", target, "#{window_zoomed_flag}"), "1");
  send({ ...zoom, token: latest().paneActions.token, desired: "unzoomed" });
  await wait(
    () => ready() && !latest().paneActions.zoomed && latest().regions.length === 2,
    "verified restore",
  );
  assert.equal(tmux("display-message", "-p", "-t", target, "#{window_zoomed_flag}"), "0");

  const stale = {
    type: "pane-action",
    request: latest().request,
    id: latest().selectedPane,
    token: latest().paneActions.token,
    action: "rename",
    name: "WRONG_TARGET",
  };
  const other = latest().panes.find((p) => p.id !== stale.id);
  send({ type: "pane", request: latest().request + 1, id: other.id });
  await wait(() => ready() && latest().selectedPane === other.id, "switch pane");
  send(stale);
  await barrier();
  assert.equal(tmux("display-message", "-p", "-t", target, "#{pane_title}"), name);
  assert.equal(tmux("display-message", "-p", "-t", neighbor, "#{pane_title}"), neighborName);
  for (const pane of [first, second]) {
    const content = tmux("capture-pane", "-p", "-t", pane);
    assert.ok(!content.includes("Native #{pane_id}") && !content.includes("WRONG_TARGET"));
  }
  console.log(
    JSON.stringify({
      passed: true,
      realTmux: true,
      runtime: process.env.TMUX_GPUI_TEST_BUNDLE ? "packaged-browser" : "source",
      exactPaneRename: true,
      literalFormatTitle: true,
      staleTokenRejected: true,
      zoom: true,
      duplicateDoesNotToggle: true,
      restore: true,
      staleSelectionRejected: true,
      noShellInput: true,
    }),
  );
} catch (error) {
  failure = error;
} finally {
  const errors = [];
  for (const child of [helper]) {
    if (!child || child.exitCode !== null || child.signalCode !== null) continue;
    let escalation, deadline;
    try {
      const closed = once(child, "close");
      child.kill("SIGTERM");
      escalation = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 2000);
      await Promise.race([
        closed,
        new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error("Child cleanup deadline")), 5000);
        }),
      ]);
    } catch (error) {
      errors.push(error);
    } finally {
      clearTimeout(escalation);
      clearTimeout(deadline);
    }
  }
  try {
    if (daemon) await daemon.stop();
  } catch (error) {
    errors.push(error);
  }
  try {
    await fleet.dispose();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) {
    if (failure) console.error("Additional cleanup failures:", errors);
    else failure = new AggregateError(errors, "Fixture cleanup failed");
  }
}

if (failure) throw failure;
