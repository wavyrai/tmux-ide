// Real isolated browser helpers, not GUI. Explicit input takeover hands off the
// controller and releases old geometry; sticky geometry applies within eligibility.
// See daemon session-runtime/authority-arbiter.ts. No personal daemon/session is used.
import assert from "node:assert/strict";
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
  child.stdout.on("data", (data) => {
    if (v.fatal) return;
    try {
      assert.ok(Buffer.byteLength(v.buffer) + data.length <= 8 * 1024 * 1024);
      v.buffer += data;
      let end;
      while ((end = v.buffer.indexOf("\n")) >= 0) {
        v.maxBytes = Math.max(v.maxBytes, Buffer.byteLength(v.buffer.slice(0, end)));
        v.latest = JSON.parse(v.buffer.slice(0, end));
        v.sequence++;
        v.buffer = v.buffer.slice(end + 1);
      }
    } catch (error) {
      fail(error);
    }
  });
  v.send = (command) => {
    check();
    assert.ok(child.stdin.writableLength < 65536);
    child.stdin.write(JSON.stringify(command) + "\n");
  };
  return v;
}
async function select(v) {
  await until(() => v.latest?.home?.phase === "live" && v.latest.sessions.length === 1);
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
  const natural = grid();
  const original = fleet.captureWindowPanes(fleet.sessionNames[0]);
  daemon = await startDaemon(fleet);
  const a = launch();
  stage = "first viewer selection";
  await select(a);
  const connectionA = a.latest.connection;
  stage = "first owner viewport";
  resize(a, 93, 29);
  await sized(93, 29);
  const b = launch();
  stage = "contender selection";
  await select(b);
  assert.equal(a.pane, b.pane);
  assert.notEqual(connectionA, b.latest.connection);
  // Explicit input takeover hands off the compatibility controller, which
  // releases the former owner's geometry and backgrounds it daemon-side.
  stage = "controller handoff retires former owner";
  await until(() => !a.latest?.inputReady);
  await until(() => JSON.stringify(grid()) === JSON.stringify(natural));
  resize(a, 64, 21);
  // This ACK releases claims and may restore geometry itself; it proves final
  // restoration, not absence of a transient resize from the preceding attempt.
  await presence(a, false);
  assert.deepEqual(grid(), natural);
  stage = "new controller receives viewport authority";
  resize(b, 101, 32);
  await sized(101, 32);
  resize(b, 65, 22, b.request - 1);
  await presence(b, true); // Same-channel ACK fences the stale request.
  assert.deepEqual(grid(), { cols: 101, rows: 32 });
  stage = "background restores natural geometry";
  await presence(b, false);
  await until(() => JSON.stringify(grid()) === JSON.stringify(natural));
  stage = "former viewer reacquires with fresh presence and viewport";
  await presence(a, true);
  resize(a, 97, 31);
  await sized(97, 31);
  stage = "close geometry owner restores natural size";
  a.closed = true;
  await stopFixtureChild(a.child);
  await until(() => JSON.stringify(grid()) === JSON.stringify(natural));
  stage = "remaining viewer reacquires after close";
  await presence(b, true);
  resize(b, 99, 33);
  await sized(99, 33);
  assert.equal(a.latest.connection, connectionA);
  await presence(b, false);
  await until(() => JSON.stringify(grid()) === JSON.stringify(natural));
  // No terminal input is sent by this fixture. Resize may reflow the initial screen.
  assert.ok(
    fleet.captureWindowPanes(fleet.sessionNames[0]).includes("RIG_GPUI_PRIVATE_COMPETITION"),
  );
  assert.ok(original.includes("RIG_GPUI_PRIVATE_COMPETITION"));
  check();
  result = {
    passed: true,
    runtime: app ? "packaged" : "source",
    controllerHandoffReleasesPriorGeometry: true,
    backgroundRestoresNatural: true,
    staleRequestViewportIgnored: true,
    remainingViewerReacquiresAfterClose: true,
    distinctConnections: true,
    maxPublicationBytes: viewers.map((v) => v.maxBytes),
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
