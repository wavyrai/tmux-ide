// Sustained correctness, not a benchmark or native heap/GPU qualification.
// Fixed 2000 ASCII lines over 200 producer ticks; bounded latest-only evidence.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { stopFixtureChild } from "./fixture-child.mjs";
import { resolve, join, isAbsolute } from "node:path";
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";

const app = process.env.TMUX_GPUI_TEST_APP;
if (app && !isAbsolute(app)) throw new Error("TMUX_GPUI_TEST_APP must be absolute");

// Save no inherited server/development selectors: every resource below is fixture-owned.
for (const key of Object.keys(process.env))
  if (
    key.startsWith("TMUX_IDE_") ||
    ["TMUX", "TMUX_PANE", "TMUX_TMPDIR", "NODE_OPTIONS", "NODE_PATH"].includes(key)
  )
    delete process.env[key];
const fleet = await createScratchFleet({
  sessions: 1,
  slug: "gpui-sustained",
  windowsPerSession: 1,
  initialPaneMarker: "RIG_GPUI_HOME_SOURCE",
});
let daemon, browser;
let latest,
  buffer = "",
  stderr = "";
let fatal;
const failures = [];
let publications = 0,
  maxPublicationBytes = 0,
  highestFloodLine = -1,
  floodProgressUpdates = 0,
  result;
const checkFatal = () => {
  if (fatal) throw fatal;
};
const until = async (predicate) => {
  const deadline = Date.now() + 20000;
  while (true) {
    checkFatal();
    const ready = predicate();
    checkFatal();
    if (ready) return;
    if (browser && (browser.exitCode !== null || browser.signalCode !== null))
      throw new Error("Home browser exited");
    assert.ok(Date.now() < deadline, "Home fixture deadline");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
try {
  browser = spawn(
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
  browser.on("error", (error) => {
    fatal ??= error;
  });
  browser.stdin.on("error", (error) => {
    fatal ??= error;
  });
  browser.stderr.on("data", (data) => {
    if (fatal) return;
    try {
      assert.ok(Buffer.byteLength(stderr) + data.length <= 65536, "stderr limit");
      stderr += data;
    } catch (error) {
      fatal ??= error;
    }
  });
  browser.stdout.on("data", (data) => {
    if (fatal) return;
    try {
      assert.ok(
        Buffer.byteLength(buffer) + data.length <= 8 * 1024 * 1024,
        "publication buffer limit",
      );
      buffer += data;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        maxPublicationBytes = Math.max(
          maxPublicationBytes,
          Buffer.byteLength(buffer.slice(0, end)),
        );
        publications++;
        latest = JSON.parse(buffer.slice(0, end));
        const text =
          latest.snapshot?.grid
            .map((row) => row.cells.map((cell) => cell.grapheme).join(""))
            .join("\n") ?? "";
        if (!text.includes("FINAL_")) {
          const lines = [...text.matchAll(/FLOOD_(\d{4})_/g)].map((match) => Number(match[1]));
          const next = Math.max(highestFloodLine, ...lines);
          if (next > highestFloodLine) {
            highestFloodLine = next;
            floodProgressUpdates++;
          }
        }
        buffer = buffer.slice(end + 1);
      }
    } catch (error) {
      fatal ??= error;
    }
  });
  const send = (command) => browser.stdin.write(JSON.stringify(command) + "\n");
  await until(() => latest?.home.phase === "unavailable");
  assert.match(latest.status, /No usable local daemon/);
  assert.match(latest.status, /tmux-ide --headless/);
  assert.equal(latest.snapshot, null);
  assert.equal(latest.inputReady, false);
  const connection = latest.connection;
  const before = fleet.captureWindowPanes(fleet.sessionNames[0]);
  daemon = await startDaemon(fleet);
  send({ type: "refresh", request: 1 });
  await until(() => latest?.request === 1 && latest.home.phase === "live");
  assert.equal(latest.connection, connection);
  assert.equal(latest.sessions.length, 1);
  assert.equal(latest.sessions[0].paneCount, 1);
  assert.equal(latest.snapshot, null);
  assert.equal(latest.inputReady, false);
  assert.equal(fleet.captureWindowPanes(fleet.sessionNames[0]), before);
  assert.ok(!JSON.stringify(latest).includes(daemon.record.authToken));
  const nativePane = fleet.initialPanes[0].paneId;
  const capture = () =>
    execFileSync(
      fleet.environment.TMUX_IDE_TMUX_BIN,
      ["-S", fleet.socketPath, "capture-pane", "-p", "-t", nativePane],
      { env: { ...process.env, ...fleet.environment }, encoding: "utf8", timeout: 5000 },
    );
  async function select(request) {
    const sessionId = latest.sessions[0].id;
    send({ type: "session", request, id: sessionId });
    await until(
      () =>
        latest?.request === request &&
        latest.status === "Choose a pane or window" &&
        latest.panes.length === 1,
    );
    const paneId = latest.panes[0].id;
    send({ type: "pane", request: request + 1, id: paneId });
    await until(
      () =>
        latest?.request === request + 1 &&
        latest.selectedPane === paneId &&
        latest.snapshot &&
        latest.inputReady,
    );
    assert.equal(latest.connection, connection);
    return paneId;
  }
  const pane = await select(2);
  const marker = randomUUID().replaceAll("-", "");
  const finalMarker = `FINAL_${marker}`,
    inputMarker = `INPUT_${marker}`;
  const producer = join(fleet.root, "bounded-producer.mjs");
  await writeFile(
    producer,
    `let tick=0; const timer=setInterval(()=>{let out='';for(let i=0;i<10;i++)out+='FLOOD_'+String(tick*10+i).padStart(4,'0')+'_'+'x'.repeat(40)+'\\n';process.stdout.write(out);if(++tick===200){clearInterval(timer);process.stdout.write(${JSON.stringify(finalMarker)}+'\\n');}},50);`,
    { mode: 0o600 },
  );
  const quote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const node = app ? join(app, "Contents/Resources/node") : process.execPath;
  const beforePublications = publications;
  send({
    type: "input",
    request: 3,
    id: pane,
    input: { kind: "text", data: `${quote(node)} ${quote(producer)}\n` },
  });
  await until(() =>
    capture()
      .split("\n")
      .some((line) => line === finalMarker),
  );
  const projected = () => {
    const r = latest.copyRegion;
    if (!latest.snapshot || !r) return null;
    return latest.snapshot.grid.slice(r.top, r.top + r.height).map((row) =>
      row.cells
        .slice(r.left, r.left + r.width)
        .map((cell) => cell.grapheme)
        .join("")
        .trimEnd(),
    );
  };
  const sourceRows = () =>
    capture()
      .replace(/\n$/, "")
      .split("\n")
      .map((row) => row.trimEnd());
  await until(() => JSON.stringify(projected()) === JSON.stringify(sourceRows()));
  assert.ok(publications > beforePublications + 1);
  assert.ok(floodProgressUpdates > 1, "distinct intermediate terminal flood progress");
  send({
    type: "input",
    request: 3,
    id: pane,
    input: { kind: "text", data: `printf '\\n${inputMarker}\\n'\n` },
  });
  await until(() => sourceRows().some((row) => row === inputMarker));
  await until(() => JSON.stringify(projected()) === JSON.stringify(sourceRows()));
  const baseline = latest.sequence;
  await daemon.stop();
  daemon = undefined;
  await until(() => latest.sequence > baseline && latest.snapshot === null && !latest.inputReady);
  assert.equal(latest.connection, connection);
  assert.equal(stderr, "");
  checkFatal();
  result = {
    passed: true,
    runtime: app ? "packaged-node-browser-live" : "source",
    producerLines: 2000,
    producerTicks: 200,
    intervalMs: 50,
    publications,
    maxPublicationBytes,
    floodProgressUpdates,
    finalTextCellsMatchTmux: true,
    responsiveInputAfterFlood: true,
    disconnectCleared: true,
    retainedEvidence: "latest publication and scalar counters only",
    nativeUi: false,
    resourceScope:
      "publication cap checked under drained output; no forced backpressure, process RSS or native heap bound claimed",
  };
} catch (error) {
  failures.push(error);
} finally {
  for (const cleanup of [
    () => stopFixtureChild(browser),
    async () => {
      if (daemon) await daemon.stop();
    },
    async () => {
      await fleet.dispose();
    },
  ]) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
}
if (fatal && !failures.includes(fatal)) failures.push(fatal);
if (failures.length) throw new AggregateError(failures, "Sustained output smoke failed");
console.log(JSON.stringify(result));
