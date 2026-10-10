// Source or exact packaged bridge, HTTP issuance, WebSocket redemption and native tmux.
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";
import { listTmuxServers } from "../../../packages/daemon-client/src/tmux-server-client.ts";
import { spawn, execFileSync } from "node:child_process";
import { stopFixtureChild } from "./fixture-child.mjs";
import { writeFile } from "node:fs/promises";
import { dirname, resolve, join, isAbsolute } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
if (process.argv.length !== 3 || !isAbsolute(process.argv[2]))
  throw new Error("Usage: split-gesture-smoke.mjs ABSOLUTE_TMUX_BINARY");
const binary = resolve(process.argv[2]);
const app = process.env.TMUX_GPUI_TEST_APP;
if (app && !isAbsolute(app)) throw new Error("TMUX_GPUI_TEST_APP must be absolute");
const helperNode = app ? join(app, "Contents/Resources/node") : process.execPath;
const helperEntry = app
  ? join(app, "Contents/Resources/bridge/browser.bundle.mjs")
  : resolve("apps/tmux-gpui/bridge/browser.ts");
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
// Fail before creating fixtures if the selected artifact is missing.
const helperIdentity = {
  mode: app ? "packaged-bridge" : "source-bridge",
  nodeSha256: digest(helperNode),
  entrySha256: digest(helperEntry),
};
for (const key of Object.keys(process.env))
  if (key.startsWith("TMUX") || ["NODE_OPTIONS", "NODE_PATH"].includes(key))
    delete process.env[key];
process.env.PATH = dirname(binary) + ":" + process.env.PATH;
delete process.env.TMUX_IDE_NATIVE_OBSERVATION;
const fleet = await createScratchFleet({
  sessions: 1,
  windowsPerSession: 1,
  slug: "split-gesture",
});

const tmux = (...args) =>
  execFileSync(binary, ["-S", fleet.socketPath, ...args], {
    env: { ...process.env, ...fleet.environment },
    encoding: "utf8",
    timeout: 5000,
  }).trim();
let daemon,
  helper,
  diagnostic = "",
  events = [],
  buffer = "";
const failures = [];
let fatal = null;
let cleanupErrors = 0;
const proof = {
  binarySha256: digest(binary),
  helper: helperIdentity,
  cleanup: false,
};
const latest = () => events.at(-1);
const wait = async (test, label) => {
  const end = Date.now() + 20000;
  for (;;) {
    if (fatal) throw fatal;
    if (test()) return;
    if (helper?.exitCode != null || helper?.signalCode) throw Error("Helper exit " + diagnostic);
    if (Date.now() > end)
      throw Error(
        label +
          ": " +
          diagnostic +
          " " +
          JSON.stringify({
            status: latest()?.status,
            split: latest()?.splitLayout,
            gesture: latest()?.splitGesture,
            inputReady: latest()?.inputReady,
          }),
      );
    await delay(20);
  }
};
try {
  assert.equal(fleet.environment.TMUX_IDE_TMUX_BIN, binary);
  const session = fleet.sessionNames[0];
  tmux("split-window", "-h", "-d", "-t", session, "sh -i");
  daemon = await startDaemon(fleet);
  const options = {
    baseUrl: daemon.baseUrl + "/",
    ownerToken: daemon.record.authToken,
    hostClientId: "split-gesture-test",
    origin: "tmux-ide://app",
  };
  const { servers } = await listTmuxServers(options);
  const server = servers.find((s) => s.state === "online");
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
  helper = spawn(
    helperNode,
    app ? [helperEntry, config] : ["--import", "tsx", helperEntry, config],
    {
      cwd: app ? fleet.root : process.cwd(),
      env: { ...process.env, ...fleet.environment },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  helper.on("error", (error) => {
    fatal = error;
  });
  helper.stdin.on("error", (error) => {
    fatal = error;
  });
  helper.stderr.on("data", (b) => (diagnostic = (diagnostic + b).slice(-4000)));
  helper.stdout.on("data", (b) => {
    try {
      buffer += b;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        if (end > 8 * 1024 * 1024) throw Error("oversized browser publication");
        events = [JSON.parse(buffer.slice(0, end))];
        buffer = buffer.slice(end + 1);
      }
      if (buffer.length > 8 * 1024 * 1024) throw Error("unbounded browser buffer");
    } catch (error) {
      fatal = error;
    }
  });
  const send = (command) => helper.stdin.write(JSON.stringify(command) + "\n");
  await wait(() => latest()?.sessions?.length, "sessions");
  send({ type: "session", request: 1, id: latest().sessions[0].id });
  await wait(() => latest()?.panes?.length === 2, "panes");
  send({ type: "pane", request: 2, id: latest().panes[0].id });
  await wait(
    () => latest()?.inputReady && latest()?.splitLayout?.splits?.length === 1,
    "canonical split",
  );
  const resource = latest().splitLayout;
  const split = resource.splits[0];
  const request = latest().request;
  const gesture = randomUUID();
  const target = {
    window: resource.window,
    layoutId: resource.layoutId,
    splitId: split.splitId,
    boundary: split.boundary,
  };
  const identities = () =>
    tmux("list-panes", "-t", session, "-F", "#{pane_id}:#{pane_birth_id}:#{pane_pid}");
  const before = identities();
  send({ type: "split-gesture", phase: "begin", request, gesture, target, axis: split.axis });
  send({ type: "split-gesture", phase: "move", request, gesture, boundary: split.boundary + 3 });
  await wait(
    () =>
      latest()?.splitGesture?.gesture === gesture &&
      (latest().splitGesture.phase === "failed" ||
        (latest().splitGesture.phase === "dragging" &&
          latest().splitGesture.boundary === split.boundary + 3)),
    "movement before release",
  );
  assert.equal(latest().splitGesture.phase, "dragging");
  assert.equal(
    Number(tmux("display-message", "-p", "-t", session + ":0.0", "#{pane_width}")),
    split.boundary + 3,
  );
  proof.movedBeforeRelease = true;
  send({ type: "split-gesture", phase: "move", request, gesture, boundary: split.boundary + 6 });
  send({ type: "split-gesture", phase: "release", request, gesture, boundary: split.boundary + 9 });
  await wait(
    () =>
      latest()?.splitGesture?.gesture === gesture &&
      ["settled", "failed"].includes(latest().splitGesture.phase),
    "gesture settle",
  );
  assert.equal(latest().splitGesture.phase, "settled");
  assert.equal(latest().splitGesture.boundary, split.boundary + 9);
  assert.equal(identities(), before);
  assert.equal(
    latest().splitLayout.splits.find((s) => s.splitId === latest().splitGesture.target.splitId)
      ?.boundary,
    split.boundary + 9,
  );
  proof.boundary = latest().splitGesture.boundary;
  proof.paneIdentitiesStable = true;
  proof.phase = "settled";
  await wait(() => latest()?.inputReady, "post-activation input ready");
  const selectedRuntime = tmux(
    "list-panes",
    "-t",
    session,
    "-F",
    "#{pane_id}\t#{@tmux_ide_pane_id}",
  )
    .split("\n")
    .map((line) => line.split("\t"))
    .find((row) => row[1] === latest().selectedPane)?.[0];
  assert.ok(selectedRuntime);
  const marker = "LAZY_" + randomUUID().replaceAll("-", "").slice(0, 16);
  send({
    type: "input",
    request,
    id: latest().selectedPane,
    input: { kind: "text", data: "echo " + marker + "\n" },
  });
  await wait(
    () =>
      tmux("capture-pane", "-p", "-t", selectedRuntime)
        .split("\n")
        .some((line) => line.trim() === marker),
    "same-viewer input after activation",
  );
  proof.sameViewerPostActivationInput = true;
} catch (error) {
  failures.push(error);
} finally {
  for (const cleanup of [
    () => stopFixtureChild(helper),
    () => daemon?.stop(),
    () => fleet.dispose(),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors++;
      failures.push(error);
    }
  }
  if (fatal && !failures.includes(fatal)) failures.push(fatal);
  proof.cleanup = cleanupErrors === 0;
  console.log(JSON.stringify(proof, null, 2));
}
if (failures.length) throw new AggregateError(failures, "Split gesture smoke failed");
