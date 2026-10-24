import process from "node:process";
import console from "node:console";
import { setTimeout } from "node:timers";
// Real daemon + production Rust worker: input/viewport ownership across focus changes.
// This is a transport correctness test, not physical GUI or latency qualification.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";
import { listTmuxServers } from "../../../packages/daemon-client/src/tmux-server-client.ts";
import { startNativeJourney } from "./native-journey-fixture.mjs";
import { stopFixtureChild } from "./fixture-child.mjs";

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
  slug: "gpui-native-viewport",
});
let daemon, browser, native, latest, fatal;
const failures = [];
const until = async (predicate, label) => {
  const deadline = Date.now() + 25000;
  while (true) {
    if (fatal) throw fatal;
    native?.assertHealthy();
    if (predicate()) return;
    assert(
      Date.now() < deadline,
      `${label}: ${JSON.stringify({ request: latest?.request, ready: latest?.inputReady, presence: latest?.presenceRevision, cols: latest?.snapshot?.cols, rows: latest?.snapshot?.rows })}`,
    );
    await new Promise((done) => setTimeout(done, 20));
  }
};
try {
  daemon = await startDaemon(
    fleet,
    process.env.TMUX_GPUI_TEST_CLI ? { cliPath: process.env.TMUX_GPUI_TEST_CLI } : undefined,
  );
  const options = {
    baseUrl: daemon.baseUrl + "/",
    ownerToken: daemon.record.authToken,
    hostClientId: "native-viewport-proof",
    origin: "tmux-ide://app",
  };
  const server = (await listTmuxServers(options)).servers.find((value) => value.state === "online");
  assert(server);
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
    process.execPath,
    ["--import", "tsx", resolve("apps/tmux-gpui/bridge/browser.ts"), config],
    { env: { ...process.env, ...fleet.environment }, stdio: ["pipe", "pipe", "pipe"] },
  );
  browser.on("error", (error) => {
    fatal ??= error;
  });
  browser.stdin.on("error", (error) => {
    fatal ??= error;
  });
  browser.stderr.resume();
  native = startNativeJourney(browser, {
    worker: true,
    onState: (state) => {
      latest = state;
    },
  });
  const send = (command) => native.send(command);
  await until(() => latest?.sessions.length === 1, "Home");
  send({ type: "presence", active: true, revision: 1 });
  send({ type: "session", request: 1, id: latest.sessions[0].id });
  await until(() => latest?.request === 1 && latest.sessionCatalogComplete, "Catalog");
  const pane = latest.preferredPane;
  assert(pane);
  send({ type: "pane", request: 2, id: pane });
  await until(() => latest?.request === 2 && latest.inputReady, "Selected");
  const inputTarget = latest.inputTargets.find((target) => target.id === pane)?.token;
  assert(inputTarget, "Selected pane must expose a native input token");
  const input = (kind, data, request = 2) =>
    send({ type: "input", request, id: pane, inputTarget, input: { kind, data } });
  const grid = () => fleet.windowGrid(fleet.sessionNames[0]);
  const output = () =>
    fleet
      .captureWindowPanes(fleet.sessionNames[0])
      .split("\n")
      .map((line) => line.trim());
  input("resize", { cols: 91, rows: 27 });
  for (const character of "printf '\\nRESIZE_TYPING_OK\\n'") input("text", character);
  input("key", "Enter");
  await until(
    () => grid().cols === 91 && grid().rows === 27 && output().includes("RESIZE_TYPING_OK"),
    "Resize and queued typing",
  );
  input("resize", { cols: 97, rows: 31 });
  input("paste", "printf '\\nPASTE_RESIZE_OK\\n' #" + "x".repeat(3000));
  input("key", "Enter");
  await until(
    () => grid().cols === 97 && grid().rows === 31 && output().includes("PASTE_RESIZE_OK"),
    "Resize and chunked paste",
  );
  for (let n = 0; n < 20; n++) input("resize", { cols: 92 + n, rows: 28 + n });
  await until(
    () => grid().cols === 111 && grid().rows === 47 && latest.inputReady,
    "Coalesced final resize",
  );
  send({ type: "presence", active: false, revision: 2 });
  await until(() => latest?.presenceRevision === 2 && !latest.inputReady, "Blur");
  const background = grid();
  assert.deepEqual(background, { cols: 111, rows: 47 });
  input("text", "BACKGROUND_MUST_NOT_ARRIVE");
  input("resize", { cols: 60, rows: 20 });
  send({ type: "presence", active: false, revision: 3 });
  await until(() => latest?.presenceRevision === 3, "Background command barrier");
  assert.deepEqual(grid(), background);
  send({ type: "presence", active: true, revision: 4 });
  await until(() => latest?.presenceRevision === 4 && latest.inputReady, "Refocus");
  assert.deepEqual(grid(), background);
  input("resize", { cols: 95, rows: 30 });
  input("text", "printf '\\nREFOCUS_TYPING_OK\\n'");
  input("key", "Enter");
  await until(
    () => grid().cols === 95 && grid().rows === 30 && output().includes("REFOCUS_TYPING_OK"),
    "Refocused geometry and typing",
  );
  assert(!output().some((line) => line.includes("BACKGROUND_MUST_NOT_ARRIVE")));
  console.log(
    JSON.stringify({
      passed: true,
      productionRustWorker: true,
      resizeWithQueuedTyping: true,
      chunkedPasteWithResize: true,
      coalescedFinalGeometry: true,
      blurPreservesGeometry: true,
      backgroundInputRefused: true,
      refocusRestoresInput: true,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      fixtureOutput: fleet.captureWindowPanes(fleet.sessionNames[0]),
      commands: native?.commands,
      diagnostic: native?.diagnostic,
    }),
  );
  failures.push(error);
} finally {
  for (const cleanup of [
    () => native?.stop(),
    () => stopFixtureChild(browser),
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
if (failures.length) throw new AggregateError(failures, "Native viewport fixture failed");
