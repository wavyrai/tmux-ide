import { startNativeJourney } from "./native-journey-fixture.mjs";
// Real isolated browser helpers, not GUI. Explicit input takeover hands off the
// controller and retires old authority while retaining the last accepted grid.
// See daemon session-runtime/authority-arbiter.ts. No personal daemon/session is used.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import process from "node:process";
import { setTimeout } from "node:timers";
import { spawn } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";
import { stopFixtureChild } from "./fixture-child.mjs";

const app = process.env.TMUX_GPUI_TEST_APP;
if (app && !isAbsolute(app)) throw new Error("TMUX_GPUI_TEST_APP must be absolute");
for (const key of Object.keys(process.env))
  if (
    key.startsWith("TMUX_IDE_") ||
    ["TMUX", "TMUX_PANE", "TMUX_TMPDIR", "NODE_OPTIONS", "NODE_PATH"].includes(key)
  )
    delete process.env[key];
const fleet = await createScratchFleet({
  sessions: 1,
  slug: "gpui-competing-viewers",
  windowsPerSession: 1,
  initialPaneMarker: "RIG_GPUI_PRIVATE_COMPETITION",
});
const viewers = [];
const failures = [];
let daemon,
  result,
  stage = "start";
const grid = () => fleet.windowGrid(fleet.sessionNames[0]);
function check() {
  for (const viewer of viewers) {
    if (viewer.fatal) throw viewer.fatal;
    if (!viewer.closed) viewer.native?.assertHealthy();
    if (!viewer.closed && (viewer.child.exitCode !== null || viewer.child.signalCode !== null))
      throw new Error("Viewer exited unexpectedly");
  }
}
async function until(predicate) {
  const deadline = Date.now() + 20000;
  while (true) {
    check();
    const ready = predicate();
    check();
    if (ready) return;
    assert.ok(Date.now() < deadline, `Deadline: ${stage}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
function launch() {
  const child = spawn(
    app ? join(app, "Contents/Resources/node") : process.execPath,
    [
      ...(app ? [] : ["--import", "tsx"]),
      app
        ? join(app, "Contents/Resources/bridge/browser.bundle.mjs")
        : resolve("apps/tmux-gpui/bridge/browser.ts"),
      "--local",
    ],
    {
      env: { ...process.env, ...fleet.environment },
      stdio: ["pipe", "pipe", "pipe"],
      ...(app ? { cwd: fleet.root } : {}),
    },
  );
  const v = {
    child,
    latest: null,
    buffer: "",
    stderr: "",
    sequence: 0,
    maxBytes: 0,
    fatal: null,
    closed: false,
    request: 0,
    presence: 0,
    pane: null,
  };
  viewers.push(v);
  const fail = (error) => {
    v.fatal ??= error;
  };
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.stderr.on("data", (data) => {
    try {
      assert.ok(Buffer.byteLength(v.stderr) + data.length <= 65536);
      v.stderr += data;
    } catch (error) {
      fail(error);
    }
  });
  v.native = startNativeJourney(child, {
    worker: true,
    onState: (state) => {
      v.latest = state;
      v.sequence++;
      v.maxBytes = Math.max(v.maxBytes, Buffer.byteLength(JSON.stringify(state)));
    },
  });
  v.send = (command) => {
    check();
    v.native.send(command);
  };
  return v;
}
async function select(v) {
  await until(() => v.latest?.home?.phase === "live" && v.latest.sessions.length === 1);
  v.send({ type: "presence", active: true, revision: ++v.presence });
  v.send({ type: "session", request: ++v.request, id: v.latest.sessions[0].id });
  await until(
    () =>
      v.latest?.request === v.request &&
      v.latest.status === "Choose a pane or window" &&
      v.latest.panes.length === 1,
  );
  v.pane = v.latest.panes[0].id;
  v.send({ type: "pane", request: ++v.request, id: v.pane });
  await until(() => v.latest?.request === v.request && v.latest.snapshot && v.latest.inputReady);
}
function resize(v, cols, rows, request = v.request) {
  v.send({ type: "input", request, id: v.pane, input: { kind: "resize", data: { cols, rows } } });
}
async function presence(v, active) {
  v.send({ type: "presence", active, revision: ++v.presence });
  await until(
    () =>
      v.latest?.presenceRevision === v.presence &&
      (active ? v.latest.inputReady : !v.latest.inputReady),
  );
}
async function sized(cols, rows) {
  await until(() => {
    const value = grid();
    return value.cols === cols && value.rows === rows;
  });
}
try {
  const original = fleet.captureWindowPanes(fleet.sessionNames[0]);
  daemon = await startDaemon(fleet);
  const a = launch();
  stage = "first viewer selection";
  await select(a);
  const connectionA = a.native.opens.at(-1).id;
  stage = "first owner viewport";
  resize(a, 93, 29);
  await sized(93, 29);
  const b = launch();
  stage = "contender selection";
  await select(b);
  assert.equal(a.pane, b.pane);
  assert.notEqual(connectionA, b.native.opens.at(-1).id);
  // Explicit input takeover hands off the compatibility controller, which
  // releases the former owner's authority and backgrounds it daemon-side.
  stage = "controller handoff retires former owner";
  await until(() => !a.latest?.inputReady);
  assert.deepEqual(grid(), { cols: 93, rows: 29 });
  resize(a, 64, 21);
  // The ACK fences the retired owner's attempt without changing the last grid.
  await presence(a, false);
  assert.deepEqual(grid(), { cols: 93, rows: 29 });
  stage = "new controller receives viewport authority";
  resize(b, 101, 32);
  await sized(101, 32);
  resize(b, 65, 22, b.request - 1);
  await presence(b, true); // Same-channel ACK fences the stale request.
  assert.deepEqual(grid(), { cols: 101, rows: 32 });
  stage = "background preserves accepted geometry";
  await presence(b, false);
  assert.deepEqual(grid(), { cols: 101, rows: 32 });
  stage = "former viewer reacquires with fresh presence and viewport";
  await presence(a, true);
  resize(a, 97, 31);
  await sized(97, 31);
  stage = "close geometry owner preserves accepted size";
  a.closed = true;
  await a.native.stop();
  await stopFixtureChild(a.child);
  assert.deepEqual(grid(), { cols: 97, rows: 31 });
  stage = "remaining viewer reacquires after close";
  await presence(b, true);
  resize(b, 99, 33);
  await sized(99, 33);
  assert.equal(a.native.opens.at(-1).id, connectionA);
  await presence(b, false);
  assert.deepEqual(grid(), { cols: 99, rows: 33 });
  // No terminal input is sent by this fixture. Resize may reflow the initial screen.
  assert.ok(
    fleet.captureWindowPanes(fleet.sessionNames[0]).includes("RIG_GPUI_PRIVATE_COMPETITION"),
  );
  assert.ok(original.includes("RIG_GPUI_PRIVATE_COMPETITION"));
  check();
  result = {
    passed: true,
    runtime: app ? "packaged" : "source",
    controllerHandoffRetiresPriorAuthority: true,
    backgroundPreservesAcceptedGrid: true,
    ownerClosePreservesAcceptedGrid: true,
    staleRequestViewportIgnored: true,
    remainingViewerReacquiresAfterClose: true,
    distinctConnections: true,
    maxFixtureStateBytes: viewers.map((v) => v.maxBytes),
    nativeUi: false,
  };
} catch (error) {
  console.error(
    JSON.stringify({
      stage,
      grid: grid(),
      viewers: viewers.map((v) => ({
        request: v.latest?.request,
        status: v.latest?.status,
        inputReady: v.latest?.inputReady,
        snapshot: v.latest?.snapshot
          ? { cols: v.latest.snapshot.cols, rows: v.latest.snapshot.rows }
          : null,
        sequence: v.sequence,
      })),
    }),
  );
  failures.push(new Error(`Competing viewers stage: ${stage}`, { cause: error }));
} finally {
  for (const cleanup of [
    ...viewers.map((v) => async () => {
      v.closed = true;
      await v.native?.stop();
      await stopFixtureChild(v.child);
    }),
    async () => {
      if (daemon) await daemon.stop();
    },
    () => fleet.dispose(),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
}
for (const viewer of viewers) if (viewer.fatal) failures.push(viewer.fatal);
if (failures.length) throw new AggregateError(failures, "Competing viewers fixture failed");
console.log(JSON.stringify(result));
