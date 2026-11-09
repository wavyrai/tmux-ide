// Live harness for Home's reconnect (Rust: home_reconnect_live_tests). Run with
// Node 24 --import tsx from the repository root:
//   node --import tsx apps/tmux-gpui/scripts/home-reconnect-live.mjs <test-binary> <scenario>
// Scenarios: restart, stop, freeze, proof-fails, incompatible.
// Everything is private: a scratch tmux server on its own -S socket, a scratch
// daemon with its own HOME, and a fake daemon on loopback for the last two.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";

const [binary, scenario] = process.argv.slice(2);
const scenarios = ["restart", "stop", "freeze", "proof-fails", "incompatible"];
if (!binary || !scenarios.includes(scenario))
  throw Error(`usage: <binary> <${scenarios.join("|")}>`);
for (const key of Object.keys(process.env))
  if (
    key.startsWith("TMUX_IDE_") ||
    ["TMUX", "TMUX_PANE", "TMUX_TMPDIR", "NODE_OPTIONS", "NODE_PATH"].includes(key)
  )
    delete process.env[key];
const fleet = await createScratchFleet({ sessions: 1, windowsPerSession: 1, slug: "home-rc" });
if (!fleet.socketPath || fleet.socketPath.includes("/tmux-501/"))
  throw Error("refusing a shared tmux socket");
const signals = mkdtempSync(join(tmpdir(), "home-rc-signals-"));
const signal = (name) => writeFileSync(join(signals, name), "");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const record = join(fleet.daemonInfoDir, "daemon.json");
let daemon = await startDaemon(fleet);
let fake = null;
const credentialsSeen = [];
/** A loopback HTTP server standing in for a daemon; it records any credential. */
async function startFake(identity) {
  const server = createServer((request, response) => {
    if (request.headers.authorization) credentialsSeen.push(request.url);
    if (request.url === "/identity") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(identity));
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return server;
}
/** Replace the private record atomically, keeping its owner-only mode. */
function writeRecord(value) {
  const next = `${record}.next`;
  writeFileSync(next, JSON.stringify(value), { mode: 0o600 });
  chmodSync(next, 0o600);
  renameSync(next, record);
}
async function disturb() {
  signal("disturbed");
  const real = JSON.parse(readFileSync(record, "utf8"));
  if (scenario === "restart") {
    await daemon.stop();
    daemon = await startDaemon(fleet);
  } else if (scenario === "stop") {
    await daemon.stop();
    await wait(15000);
    daemon = await startDaemon(fleet);
  } else if (scenario === "freeze") {
    process.kill(daemon.record.pid, "SIGSTOP");
    await wait(50000);
    process.kill(daemon.record.pid, "SIGCONT");
  } else {
    // The record points at a live process that is not this daemon.
    await daemon.stop();
    const incompatible = scenario === "incompatible";
    const claimed = {
      ...real,
      pid: process.pid,
      protocolVersion: incompatible ? 3 : real.protocolVersion,
    };
    fake = await startFake({
      ok: true,
      pid: process.pid,
      protocolVersion: claimed.protocolVersion,
      productVersion: "0.0.0-fake",
      instanceId: incompatible ? real.instanceId : "ffffffff-ffff-4fff-8fff-ffffffffffff",
      startedAt: real.startedAt,
      environmentId: real.environmentId ?? null,
    });
    writeRecord({ ...claimed, port: fake.address().port });
    if (incompatible) return; // Home should stop with a reason; nothing to restore.
    await wait(8000);
    fake.close();
    fake = null;
    // The fake record names a live process; a new daemon would refuse to take it over.
    unlinkSync(record);
    daemon = await startDaemon(fleet);
  }
  signal("restored");
}
const child = spawn(
  binary,
  ["home_keeps_its_list_and_reconnects", "--ignored", "--nocapture", "--test-threads=1"],
  {
    env: {
      ...process.env,
      ...fleet.environment,
      TMUX_IDE_TEST_DAEMON_RECORD: record,
      TMUX_IDE_TEST_SIGNAL_DIR: signals,
      TMUX_IDE_TEST_EXPECT: scenario === "incompatible" ? "fault" : "recover",
    },
    stdio: ["ignore", "inherit", "pipe"],
  },
);
let disturbing = null;
child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
  if (!disturbing && String(chunk).includes("HOME_READY")) disturbing = wait(1000).then(disturb);
});
let code;
try {
  code = await new Promise((r) => child.on("close", r));
  await disturbing;
} catch (error) {
  console.error(error);
  code = 1;
} finally {
  fake?.close();
  try {
    await daemon.stop();
  } catch {
    // Already stopped.
  }
  await fleet.dispose();
  rmSync(signals, { recursive: true, force: true });
}
const result = { scenario, testExit: code, credentialsSentToFake: credentialsSeen.length };
console.log(JSON.stringify(result));
process.exit(code === 0 && credentialsSeen.length === 0 ? 0 : 1);
