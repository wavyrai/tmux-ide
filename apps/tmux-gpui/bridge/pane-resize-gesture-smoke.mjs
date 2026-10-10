// Real tmux live-gesture proof, isolated socket/daemon/HOME. No native UI.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve, join, isAbsolute } from "node:path";
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";
import { listTmuxServers } from "../../../packages/daemon-client/src/tmux-server-client.ts";
const app = process.env.TMUX_GPUI_TEST_APP;
if (app && !isAbsolute(app)) throw new Error("App path must be absolute");
for (const key of Object.keys(process.env))
  if (
    key.startsWith("TMUX_IDE_") ||
    ["TMUX", "TMUX_PANE", "TMUX_TMPDIR", "NODE_OPTIONS", "NODE_PATH"].includes(key)
  )
    delete process.env[key];
const fleet = await createScratchFleet({
  sessions: 1,
  windowsPerSession: 1,
  slug: "gpui-live-drag",
});
let daemon, browser, latest, fatal, result;
let buffer = "",
  stderr = "";
const errors = [];
const tmux = (...args) =>
  execFileSync(fleet.environment.TMUX_IDE_TMUX_BIN, ["-S", fleet.socketPath, ...args], {
    env: { ...process.env, ...fleet.environment },
    encoding: "utf8",
  }).trim();
const until = async (predicate, label) => {
  const end = Date.now() + 25000;
  for (;;) {
    if (fatal) throw fatal;
    if (predicate()) return;
    if (browser && (browser.exitCode !== null || browser.signalCode !== null))
      throw new Error("Browser exited: " + stderr);
    assert.ok(
      Date.now() < end,
      label +
        " deadline; " +
        JSON.stringify({
          status: latest?.status,
          gesture: latest?.resizeGesture,
          ready: latest?.inputReady,
        }),
    );
    await new Promise((r) => setTimeout(r, 20));
  }
};
const send = (v) => browser.stdin.write(JSON.stringify(v) + "\n");
try {
  const first = tmux("list-panes", "-t", fleet.sessionNames[0], "-F", "#{pane_id}");
  tmux("split-window", "-h", "-t", first, "sh -i");
  daemon = await startDaemon(fleet);
  const options = {
    baseUrl: daemon.baseUrl + "/",
    ownerToken: daemon.record.authToken,
    hostClientId: "gpui-live-drag",
    origin: "tmux-ide://app",
  };
  const server = (await listTmuxServers(options)).servers.find((s) => s.state === "online");
  assert.ok(server);
  const config = join(fleet.root, "host.json");
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
  browser.on("error", (e) => (fatal ??= e));
  browser.stdin.on("error", (e) => (fatal ??= e));
  browser.stderr.on("data", (b) => {
    stderr = (stderr + b).slice(-4000);
  });
  browser.stdout.on("data", (b) => {
    try {
      assert.ok(Buffer.byteLength(buffer) + b.length <= 8 * 1024 * 1024, "bounded publication");
      buffer += b;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        latest = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
    } catch (e) {
      fatal ??= e;
    }
  });
  await until(() => latest?.sessions?.length === 1, "catalog");
  send({ type: "session", request: 1, id: latest.sessions[0].id });
  await until(() => latest?.request === 1 && latest.panes.length === 2, "panes");
  send({ type: "pane", request: 2, id: latest.panes[0].id });
  const ready = () =>
    latest?.inputReady && latest.snapshot && latest.resizeToken && latest.regions?.length === 2;
  await until(ready, "ready");
  assert.equal(latest.resizeGestureSupported, true);
  const region = () => latest.regions.find((p) => p.left === 0);
  const width = () => Number(tmux("display-message", "-p", "-t", first, "#{pane_width}"));
  const original = width();
  const key = {
    type: "resize-gesture",
    request: latest.request,
    gesture: randomUUID(),
    id: region().id,
    axis: "cols",
  };
  send({ ...key, phase: "begin", token: latest.resizeToken, cells: original });
  send({ ...key, phase: "move", cells: original + 4 });
  await until(
    () => ready() && width() === original + 4 && region().width === original + 4,
    "real geometry changes before release",
  );
  // Burst while keeping one final explicit release target. No click/terminal input.
  for (let i = 0; i < 40; i++) send({ ...key, phase: "move", cells: original + 2 + (i % 7) });
  send({ ...key, phase: "release", cells: original + 6 });
  await until(
    () =>
      ready() &&
      latest.resizeGesture?.gesture === key.gesture &&
      latest.resizeGesture.phase === "settled" &&
      width() === original + 6 &&
      region().width === original + 6,
    "final release settles exact target",
  );
  const cancel = { ...key, gesture: randomUUID() };
  send({ ...cancel, phase: "begin", token: latest.resizeToken, cells: width() });
  await until(() => latest.resizeGesture?.gesture === cancel.gesture, "next gesture accepted");
  send({ type: "presence", active: false, revision: 1 });
  await until(() => latest.presenceRevision === 1 && !latest.inputReady, "foreground loss");
  send({ ...cancel, phase: "move", cells: original + 10 });
  send({ ...cancel, phase: "release", cells: original + 10 });
  send({ type: "presence", active: true, revision: 2 });
  await until(() => ready() && latest.presenceRevision === 2, "foreground restored");
  assert.equal(width(), original + 6);
  tmux("select-layout", "-t", first, "even-vertical");
  tmux("set-option", "-w", "-t", first, "pane-border-status", "top");
  const height = () => Number(tmux("display-message", "-p", "-t", first, "#{pane_height}"));
  const top = () => latest.regions.find((p) => p.top === 0);
  await until(
    () => ready() && latest.regions.every((p) => p.left === 0) && top().height === height() + 1,
    "horizontal divider with status row",
  );
  const originalRows = height();
  const rows = { ...key, gesture: randomUUID(), id: top().id, axis: "rows" };
  send({ ...rows, phase: "begin", token: latest.resizeToken, cells: top().height });
  send({ ...rows, phase: "move", cells: originalRows + 3 });
  await until(
    () => ready() && height() === originalRows + 2 && top().height === originalRows + 3,
    "row geometry before release excludes status",
  );
  send({ ...rows, phase: "release", cells: originalRows + 4 });
  await until(
    () =>
      ready() &&
      latest.resizeGesture?.gesture === rows.gesture &&
      latest.resizeGesture.phase === "settled" &&
      height() === originalRows + 3 &&
      top().height === originalRows + 4,
    "final row target excludes status",
  );
  assert.ok(!JSON.stringify(latest).includes(daemon.record.authToken));
  result = {
    passed: true,
    runtime: app ? "packaged" : "source",
    beforeReleaseGeometry: true,
    burstFinalTarget: true,
    presenceCancels: true,
    rowsWithStatus: true,
    nativeUi: false,
  };
} catch (e) {
  errors.push(e);
} finally {
  for (const cleanup of [
    async () => {
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
    },
    async () => {
      if (daemon) await daemon.stop();
    },
    () => fleet.dispose(),
  ])
    try {
      await cleanup();
    } catch (e) {
      errors.push(e);
    }
}
if (fatal && !errors.includes(fatal)) errors.push(fatal);
if (errors.length) throw new AggregateError(errors, "Live resize gesture smoke failed");

console.log(JSON.stringify(result));
