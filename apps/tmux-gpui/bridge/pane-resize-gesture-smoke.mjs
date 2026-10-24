import process from "node:process";
import console from "node:console";
import { Buffer } from "node:buffer";
import { setTimeout, clearTimeout } from "node:timers";
// Real tmux live-gesture proof, isolated socket/daemon/HOME. No native UI.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { stopFixtureChild } from "./fixture-child.mjs";
import { startNativeJourney } from "./native-journey-fixture.mjs";
import { canonicalDaemonUrl } from "../../../packages/daemon/src/lib/canonical-daemon.ts";
import { resolve, join, isAbsolute } from "node:path";
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";
import { listTmuxServers } from "../../../packages/daemon-client/src/tmux-server-client.ts";
const privateCli = process.env.TMUX_GPUI_TEST_CLI;
if (privateCli !== undefined) {
  assert.ok(isAbsolute(privateCli), "TMUX_GPUI_TEST_CLI must be absolute");
  assert.ok((await stat(privateCli)).isFile(), "Private CLI must be a regular file");
  await access(privateCli, constants.R_OK);
}
async function startFixtureDaemon(fleet) {
  if (privateCli === undefined) return startDaemon(fleet);
  const child = spawn(process.execPath, [privateCli, "--headless"], {
    env: { ...process.env, ...fleet.environment },
    stdio: "ignore",
  });
  let childError;
  child.on("error", (error) => {
    childError = error;
  });
  try {
    const deadline = Date.now() + 45000;
    for (;;) {
      if (childError) throw childError;
      assert.ok(child.exitCode === null && child.signalCode === null, "Private daemon exited");
      assert.ok(Date.now() < deadline, "Private daemon startup deadline");
      let record;
      try {
        record = JSON.parse(await readFile(join(fleet.daemonInfoDir, "daemon.json"), "utf8"));
      } catch {
        /* Await the owned atomic discovery record. */
      }
      if (record?.pid === child.pid && typeof record.authToken === "string" && record.instanceId)
        return {
          record,
          baseUrl: canonicalDaemonUrl("http", record.bindHostname, record.port),
          stop: () => stopFixtureChild(child),
        };
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } catch (error) {
    try {
      await stopFixtureChild(child);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Private daemon startup failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
}
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
let daemon, browser, latest, fatal, result, native;
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
    native?.assertHealthy();
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
const send = (v) => native.send(v);
try {
  const first = tmux("list-panes", "-t", fleet.sessionNames[0], "-F", "#{pane_id}");
  tmux("split-window", "-h", "-t", first, "sh -i");
  daemon = await startFixtureDaemon(fleet);
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
        JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
    } catch (e) {
      fatal ??= e;
    }
  });
  native = startNativeJourney(browser, {
    worker: true,
    onState: (state) => {
      latest = state;
    },
  });
  send({ type: "presence", active: true, revision: 0 });
  await until(() => latest?.sessions?.length === 1, "catalog");
  send({ type: "session", request: 1, id: latest.sessions[0].id });
  await until(() => latest?.request === 1 && latest.panes.length === 2, "panes");
  send({ type: "pane", request: 2, id: latest.panes[0].id });
  const ready = () =>
    latest?.inputReady && latest.snapshot && latest.splitLayout && latest.regions?.length === 2;
  await until(ready, "ready");
  const begin = (axis) => {
    const layout = latest.splitLayout;
    const edge = layout.splits.find((split) => split.axis === axis);
    assert.ok(edge);
    const gesture = randomUUID();
    send({
      type: "split-gesture",
      request: latest.request,
      gesture,
      phase: "begin",
      axis,
      target: {
        window: layout.window,
        layoutId: layout.layoutId,
        splitId: edge.splitId,
        boundary: edge.boundary,
      },
    });
    return gesture;
  };
  const release = (gesture, boundary) =>
    send({ type: "split-gesture", request: latest.request, gesture, phase: "release", boundary });
  const width = () => Number(tmux("display-message", "-p", "-t", first, "#{pane_width}"));
  const original = width();
  const gesture = begin("cols");
  await until(
    () => latest.splitGesture?.gesture === gesture && latest.splitGesture.phase === "dragging",
    "drag begins",
  );
  // The GUI previews movement locally. Canonical geometry changes only on release.
  assert.equal(width(), original);
  release(gesture, original + 6);
  await until(
    () =>
      ready() &&
      latest.splitGesture?.gesture === gesture &&
      latest.splitGesture.phase === "settled" &&
      width() === original + 6,
    "column release exact target",
  );
  const cancelled = begin("cols");
  await until(() => latest.splitGesture?.gesture === cancelled, "next gesture accepted");
  send({ type: "presence", active: false, revision: 1 });
  await until(() => latest.presenceRevision === 1 && !latest.inputReady, "foreground loss");
  release(cancelled, original + 10);
  send({ type: "presence", active: true, revision: 2 });
  await until(() => ready() && latest.presenceRevision === 2, "foreground restored");
  assert.equal(width(), original + 6);
  tmux("select-layout", "-t", first, "even-vertical");
  tmux("set-option", "-w", "-t", first, "pane-border-status", "top");
  const height = () => Number(tmux("display-message", "-p", "-t", first, "#{pane_height}"));
  await until(
    () => ready() && latest.splitLayout.splits.some((split) => split.axis === "rows"),
    "row split layout",
  );
  const originalRows = height();
  const rows = begin("rows");
  await until(
    () => latest.splitGesture?.gesture === rows && latest.splitGesture.phase === "dragging",
    "row drag begins",
  );
  assert.equal(height(), originalRows);
  release(rows, originalRows + 4);
  await until(
    () =>
      ready() &&
      latest.splitGesture?.gesture === rows &&
      latest.splitGesture.phase === "settled" &&
      height() === originalRows + 3,
    "row release excludes status row",
  );
  assert.ok(!JSON.stringify(latest).includes(daemon.record.authToken));
  result = {
    passed: true,
    runtime: app ? "packaged" : "source",
    unchangedGeometryBeforeRelease: true,
    exactFinalTarget: true,
    presenceCancels: true,
    rowsWithStatus: true,
    nativeUi: false,
  };
} catch (e) {
  errors.push(e);
} finally {
  for (const cleanup of [
    () => native?.stop(),
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
