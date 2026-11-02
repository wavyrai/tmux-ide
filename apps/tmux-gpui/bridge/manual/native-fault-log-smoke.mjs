// A forced terminal-source restart must be named in both logs (card #700): the
// app's poll line gives the rejecting check and the daemon's fault reason, and
// the daemon records the same fault for the same pane.
// Owned scratch tmux server (-L) and daemon only; never the developer's.
import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { isAbsolute, join } from "node:path";
import { createScratchFleet } from "../../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../../scripts/lib/product-fixtures/daemon.ts";
import { stopFixtureChild } from "../fixture-child.mjs";
const { AbortSignal } = globalThis;

const [guiTestBinary] = process.argv.slice(2);
assert(
  guiTestBinary && isAbsolute(guiTestBinary),
  "Usage: node --import tsx native-fault-log-smoke.mjs ABS_GUI_TEST_BINARY",
);
const fleet = await createScratchFleet({
  sessions: 1,
  windowsPerSession: 1,
  slug: "fault-log",
  namedSocket: true,
});
const tmux = (...argv) =>
  execFileSync(fleet.environment.TMUX_IDE_TMUX_BIN, ["-S", fleet.socketPath, ...argv], {
    env: { ...process.env, ...fleet.environment },
    encoding: "utf8",
    timeout: 5000,
  }).trim();
let daemon, child;
try {
  daemon = await startDaemon(fleet);
  child = spawn(
    guiTestBinary,
    ["--ignored", "--nocapture", "--test-threads=1", "a_source_restart_is_named_in_the_app_log"],
    {
      env: {
        ...process.env,
        ...fleet.environment,
        TMUX_IDE_TEST_DAEMON_RECORD: join(fleet.daemonInfoDir, "daemon.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  let restarted = null;
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      output = (output + chunk).slice(-16384);
      if (restarted === null && output.includes("FAULT_LOG_READY")) {
        // The daemon's control-mode client is its terminal source. Detaching it
        // ends that source; the daemon restarts it and faults every delivery.
        const clients = tmux("list-clients", "-F", "#{client_control_mode} #{client_name}")
          .split("\n")
          .filter((line) => line.startsWith("1 "))
          .map((line) => line.slice(2));
        assert(clients.length > 0, "no daemon control client on the scratch server");
        for (const name of clients) tmux("detach-client", "-t", name);
        restarted = clients.length;
      }
    });
  const [code, signal] = await once(child, "close", { signal: AbortSignal.timeout(90000) });
  const redact = (text) => text.replaceAll(daemon.record.authToken, "[redacted]");
  assert.equal(signal, null);
  assert.equal(code, 0, redact(output));
  assert.match(output, /1 passed/);
  const appLines = output
    .split("\n")
    .filter((line) => line.includes("tmux-preview: terminal poll interrupted:"));
  const daemonLines = daemon
    .output()
    .split("\n")
    .filter((line) => line.includes('"fault sent to client"'));
  const closeLines = daemon
    .output()
    .split("\n")
    .filter((line) => line.includes('"component":"pane-stream"'));
  console.log(
    JSON.stringify(
      { restartedControlClients: restarted, appLines, daemonLines, closeLines },
      null,
      2,
    ),
  );
  // Each daemon fault names its pane; the app's line for it names the same pane.
  const matched = daemonLines
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.reason === "source-closed")
    .some((entry) =>
      appLines.some((line) =>
        line.includes(`terminal-state:source-closed pane=${entry.pane} fault=source-closed`),
      ),
    );
  assert(matched, "no app line matches a daemon source-closed fault for the same pane");
  assert(closeLines.length > 0, "the daemon logged no stream close");
} finally {
  try {
    await stopFixtureChild(child);
  } finally {
    try {
      await daemon?.stop();
    } finally {
      await fleet.dispose();
    }
  }
}
