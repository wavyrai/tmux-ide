import process from "node:process";
import console from "node:console";
import { setTimeout } from "node:timers";
import { createBinaryFrameParser, decodeBinaryJson, decodeBinaryImage } from "./binary-framing.ts";
import { decodeBinaryCellPublication } from "./binary-cell-rows.ts";
import { createCompactDeltaStore } from "./compact-delta.ts";
// Opt-in in-window pane reselect proof against an owned daemon and tmux socket:
// the frame stays painted, input is gated until the helper confirms the new
// target, and every admitted keystroke lands in exactly the selected pane.
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";
import { listTmuxServers } from "../../../packages/daemon-client/src/tmux-server-client.ts";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const fleet = await createScratchFleet({
  sessions: 1,
  windowsPerSession: 1,
  slug: "gpui-reselect",
});
let daemon, browser;
let stderr = "";
const events = [];
const binary = process.env.TMUX_IDE_GUI_NATIVE_ENCODING === "binary-rle-v1";
const damage = binary || process.env.TMUX_IDE_GUI_NATIVE_ENCODING === "rle-delta-v1";
const frameStore = createCompactDeltaStore();
let lastWire = null,
  recoveringEpoch = null,
  protocolFailure = null;
let fullFrames = 0,
  deltaFrames = 0,
  resyncPassed = false;
const tmux = (...args) =>
  execFileSync(fleet.environment.TMUX_IDE_TMUX_BIN, ["-S", fleet.socketPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...fleet.environment },
  }).trimEnd();
const until = async (predicate, label) => {
  const end = Date.now() + 20000;
  while (!predicate()) {
    if (protocolFailure) throw protocolFailure;
    if (browser?.exitCode != null) throw new Error("Browser exited: " + stderr);
    if (Date.now() > end) throw new Error(`Reselect deadline (${label}): ` + stderr.slice(-2000));
    await new Promise((r) => setTimeout(r, 10));
  }
};
const send = (command) => browser.stdin.write(JSON.stringify(command) + "\n");
const lines = (pane) =>
  tmux("capture-pane", "-p", "-t", pane)
    .split("\n")
    .map((line) => line.trim());
try {
  const tmuxPanes = [tmux("display-message", "-p", "-t", fleet.sessionNames[0], "#{pane_id}")];
  tmuxPanes.push(tmux("split-window", "-h", "-P", "-F", "#{pane_id}", "-t", tmuxPanes[0], "sh -i"));
  tmuxPanes.push(tmux("split-window", "-v", "-P", "-F", "#{pane_id}", "-t", tmuxPanes[0], "sh -i"));
  for (const pane of tmuxPanes) {
    tmux("send-keys", "-t", pane, "-l", "export PS1='$ '; clear");
    tmux("send-keys", "-t", pane, "Enter");
  }
  daemon = await startDaemon(
    fleet,
    process.env.TMUX_GPUI_TEST_CLI ? { cliPath: process.env.TMUX_GPUI_TEST_CLI } : undefined,
  );
  const options = {
    baseUrl: daemon.baseUrl + "/",
    ownerToken: daemon.record.authToken,
    hostClientId: "gpui-reselect-test",
    origin: "tmux-ide://app",
  };
  const server = (await listTmuxServers(options)).servers.find((s) => s.state === "online");
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
  const bundle = process.env.TMUX_GPUI_TEST_BUNDLE;
  browser = spawn(
    process.execPath,
    [
      ...(bundle ? [] : ["--import", "tsx"]),
      bundle ? resolve(bundle, "browser.bundle.mjs") : resolve("apps/tmux-gpui/bridge/browser.ts"),
      config,
    ],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...fleet.environment } },
  );
  browser.stderr.on("data", (b) => (stderr += b.toString()));
  const acceptEvent = (event) => {
    try {
      if (damage && event.snapshot) {
        const wire = event.snapshot;
        if (recoveringEpoch === wire.epoch) return;
        const candidate = frameStore.prepare(wire);
        candidate.commit();
        if (wire.encoding === "rle-delta-v1") deltaFrames++;
        else fullFrames++;
        lastWire = { ...wire, connection: event.connection, request: event.request };
        event.snapshot = candidate.snapshot;
        if (recoveringEpoch !== null) {
          recoveringEpoch = null;
          resyncPassed = true;
        }
      } else if (damage && !event.kittyImageChunk) frameStore.reset();
      events.push(event);
    } catch (error) {
      protocolFailure = error;
    }
  };
  if (binary) {
    const parser = createBinaryFrameParser(({ type, payload }) => {
      if (type === 1) acceptEvent(decodeBinaryJson(payload));
      else if (type === 2) {
        const { publication, frame } = decodeBinaryCellPublication(payload);
        acceptEvent({ ...publication, snapshot: frame });
      } else {
        decodeBinaryImage(payload);
      }
      return true;
    });
    browser.stdout.on("data", (bytes) => {
      try {
        parser.push(bytes);
      } catch (error) {
        protocolFailure = error;
      }
    });
    browser.stdout.on("end", () => {
      try {
        parser.end();
      } catch (error) {
        protocolFailure = error;
      }
    });
  } else {
    let buffer = "";
    browser.stdout.on("data", (bytes) => {
      buffer += bytes.toString();
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        try {
          acceptEvent(JSON.parse(buffer.slice(0, end)));
        } catch (error) {
          protocolFailure = error;
        }
        buffer = buffer.slice(end + 1);
      }
    });
  }
  await until(() => events.at(-1)?.sessions?.length === 1, "catalog");
  let request = 1;
  send({ type: "session", request, id: events.at(-1).sessions[0].id });
  await until(
    () => events.at(-1)?.request === request && events.at(-1).panes.length === 3,
    "panes",
  );
  const panes = events.at(-1).panes.map((p) => p.id);
  const ready = (id) => {
    const e = events.at(-1);
    return e?.request === request && e.selectedPane === id && e.snapshot && e.inputReady;
  };
  send({ type: "pane", request: ++request, id: panes[0] });
  await until(() => ready(panes[0]), "first pane");
  send({
    type: "input",
    request,
    id: panes[0],
    input: { kind: "resize", data: { cols: 111, rows: 37 } },
  });
  const grid = () =>
    tmux("display-message", "-p", "-t", tmuxPanes[0], "#{window_width}x#{window_height}");
  await until(() => grid() === "111x37", "initial fitted window");
  if (damage) {
    await until(
      () => events.at(-1)?.snapshot?.cols === 111 && events.at(-1)?.snapshot?.rows === 37,
      "coherent fit",
    );
    assert.ok(lastWire);
    recoveringEpoch = lastWire.epoch;
    frameStore.reset(); // exercise receiver state loss without replaying input
    const resync = {
      type: "frame-resync",
      connection: lastWire.connection,
      request,
      epoch: lastWire.epoch,
      baseSeq: 0,
    };
    send(resync);
    send(resync); // stale duplicate must not create a second recovery operation
    await until(() => resyncPassed, "fresh full frame after resync");
  }
  const fitted = tmuxPanes.map((pane) =>
    tmux("display-message", "-p", "-t", pane, "#{pane_width}x#{pane_height}"),
  );
  const assertGeometry = () => {
    assert.equal(grid(), "111x37", "pane selection preserves fitted window dimensions");
    assert.deepEqual(
      tmuxPanes.map((pane) =>
        tmux("display-message", "-p", "-t", pane, "#{pane_width}x#{pane_height}"),
      ),
      fitted,
      "pane selection preserves every split",
    );
  };
  // Map semantic panes to tmux panes through a marker typed into each.
  const owner = new Map();
  let start = events.length;
  let blanked = 0;
  for (const [index, id] of panes.entries()) {
    const previous = request;
    if (index > 0) {
      send({ type: "pane", request: ++request, id });
      // Typed before the helper confirms: discarded, never retargeted.
      send({ type: "input", request, id, input: { kind: "text", data: "EARLY_DROPPED" } });
      // Stale request for the previous pane: discarded.
      send({
        type: "input",
        request: previous,
        id: panes[index - 1],
        input: { kind: "text", data: "STALE_DROPPED" },
      });
      await until(() => ready(id), `select ${index}`);
    }
    assertGeometry();
    const marker = `RESELECT_${index}`;
    send({ type: "input", request, id, input: { kind: "text", data: `echo ${marker}` } });
    send({ type: "input", request, id, input: { kind: "key", data: "Enter" } });
    await until(() => tmuxPanes.some((pane) => lines(pane).includes(marker)), marker);
    const hits = tmuxPanes.filter((pane) => lines(pane).includes(marker));
    assert.equal(hits.length, 1, `${marker} must land in exactly one pane`);
    assert.ok(![...owner.values()].includes(hits[0]), "each semantic pane maps to its own pane");
    owner.set(id, hits[0]);
  }
  blanked += events.slice(start).filter((e) => e.request > 2 && !e.snapshot).length;
  // A burst of reselects ends on the last target; admitted input follows it.
  start = events.length;
  for (const id of [panes[1], panes[2], panes[0], panes[2], panes[1]])
    send({ type: "pane", request: ++request, id });
  await until(() => ready(panes[1]), "burst");
  send({ type: "input", request, id: panes[1], input: { kind: "text", data: "echo BURST_OK" } });
  send({ type: "input", request, id: panes[1], input: { kind: "key", data: "Enter" } });
  await until(() => lines(owner.get(panes[1])).includes("BURST_OK"), "burst input");
  assertGeometry();
  blanked += events.slice(start).filter((e) => !e.snapshot).length;
  for (const [id, pane] of owner) {
    const text = lines(pane);
    assert.ok(!text.some((l) => l.includes("EARLY_DROPPED")), "early input was not admitted");
    assert.ok(!text.some((l) => l.includes("STALE_DROPPED")), "stale input was not admitted");
    if (id !== panes[1]) assert.ok(!text.includes("BURST_OK"), "burst input stayed in its pane");
  }
  assert.equal(blanked, 0, "in-window reselect never drops the painted frame");
  if (protocolFailure) throw protocolFailure;
  if (damage) {
    assert.ok(fullFrames > 0);
    assert.ok(deltaFrames > 0);
    assert.ok(resyncPassed);
  }
  console.log(
    JSON.stringify({
      passed: true,
      panes: 3,
      exactTargets: true,
      gatedEarlyInput: true,
      blanked,
      ...(damage ? { fullFrames, deltaFrames, resyncPassed } : {}),
    }),
  );
} finally {
  if (browser && browser.exitCode === null) {
    const done = once(browser, "close");
    browser.kill("SIGTERM");
    await done;
  }
  if (daemon) await daemon.stop();
  await fleet.dispose();
}
