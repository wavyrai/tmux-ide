// Opt-in multi-pane transport check against an owned daemon and tmux socket.
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";
import {
  createTmuxServerClient,
  listTmuxServers,
} from "../../../packages/daemon-client/src/tmux-server-client.ts";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const fleet = await createScratchFleet({ sessions: 1, windowsPerSession: 1, slug: "gpui-multi" });
let daemon, helper, client;
const events = [];
let diagnostic = "";
const tmux = (...args) =>
  execFileSync(fleet.environment.TMUX_IDE_TMUX_BIN, ["-S", fleet.socketPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...fleet.environment },
  }).trim();
const wait = async (predicate) => {
  const end = Date.now() + 20000;
  while (!predicate()) {
    if (helper?.exitCode != null) throw new Error("Helper exited: " + diagnostic);
    if (Date.now() > end) throw new Error("Multi-pane deadline: " + diagnostic);
    await new Promise((r) => setTimeout(r, 20));
  }
};
const text = (snapshot) =>
  snapshot.grid.map((r) => r.cells.map((c) => c.grapheme).join("")).join("\n");
try {
  const first = tmux("display-message", "-p", "-t", fleet.sessionNames[0], "#{pane_id}");
  const second = tmux("split-window", "-h", "-P", "-F", "#{pane_id}", "-t", first, "sh -i");
  for (const [pane, marker] of [
    [first, "LEFT_UNIQUE"],
    [second, "RIGHT_UNIQUE"],
  ]) {
    tmux("send-keys", "-t", pane, "-l", `printf '${marker}\\n'`);
    tmux("send-keys", "-t", pane, "Enter");
  }
  daemon = await startDaemon(fleet);
  const options = {
    baseUrl: daemon.baseUrl + "/",
    ownerToken: daemon.record.authToken,
    hostClientId: "gpui-multi-test",
    origin: "tmux-ide://app",
  };
  const { servers } = await listTmuxServers(options);
  const server = servers.find((s) => s.state === "online");
  const scope = { serverId: server.serverId, generation: server.generation };
  client = createTmuxServerClient(options, scope);
  const session = (await client.sessions()).sessions[0];
  const opened = await client.openSession(session.liveSessionId);
  const ids = (await client.inventory(opened.workspaceName)).resource.semanticPaneIds;
  assert.equal(ids.length, 2);
  const config = fleet.root + "/multi.json";
  await writeFile(
    config,
    JSON.stringify({
      baseUrl: options.baseUrl,
      ownerToken: options.ownerToken,
      scope,
      workspaceName: opened.workspaceName,
      liveSessionId: session.liveSessionId,
      semanticPaneId: ids[0],
      visiblePaneIds: ids,
    }),
    { mode: 0o600 },
  );
  helper = spawn(
    process.execPath,
    ["--import", "tsx", resolve("apps/tmux-gpui/bridge/live.ts"), config, "--interactive"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  helper.stderr.on("data", (b) => (diagnostic += b.toString()));
  let buffer = "";
  helper.stdout.on("data", (b) => {
    buffer += b.toString();
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      events.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
    }
  });
  await wait(() => events.at(-1)?.surfaces?.length === 2);
  const seeded = events.at(-1).surfaces;
  const left = seeded.find((s) => text(s.snapshot).includes("LEFT_UNIQUE"));
  const right = seeded.find((s) => text(s.snapshot).includes("RIGHT_UNIQUE"));
  assert.ok(left && right && left.paneId !== right.paneId);
  const untouched = JSON.stringify(right.snapshot);
  tmux("send-keys", "-t", first, "-l", "printf 'LEFT_UPDATED\\n'");
  tmux("send-keys", "-t", first, "Enter");
  await wait(() =>
    events
      .at(-1)
      ?.surfaces?.some(
        (s) => s.paneId === left.paneId && text(s.snapshot).includes("LEFT_UPDATED"),
      ),
  );
  assert.equal(
    JSON.stringify(events.at(-1).surfaces.find((s) => s.paneId === right.paneId).snapshot),
    untouched,
  );
  await daemon.stop();
  daemon = undefined;
  await wait(() => events.at(-1)?.snapshot === null && events.at(-1)?.surfaces?.length === 0);
  console.log(
    JSON.stringify({ passed: true, panes: 2, independentUpdate: true, clearedOnDisconnect: true }),
  );
} finally {
  client?.dispose();
  if (helper && helper.exitCode === null) {
    const done = once(helper, "close");
    helper.kill("SIGTERM");
    await done;
  }
  if (daemon) await daemon.stop();
  await fleet.dispose();
}
