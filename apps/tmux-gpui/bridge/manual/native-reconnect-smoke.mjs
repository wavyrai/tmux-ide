// Card #702: under the ignored Rust reconnect test, end the owned daemon's
// terminal source, freeze the daemon for 10 s, resume it, then restart it. The
// app must keep the frame on screen throughout and accept typing after each
// step. Owned scratch tmux server (-L) and daemon only; never the developer's.
import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createScratchFleet } from "../../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../../scripts/lib/product-fixtures/daemon.ts";
import { stopFixtureChild } from "../fixture-child.mjs";
const { AbortSignal, Buffer } = globalThis;

const [guiTestBinary] = process.argv.slice(2);
assert(
  guiTestBinary && isAbsolute(guiTestBinary),
  "Usage: node --import tsx native-reconnect-smoke.mjs ABS_GUI_TEST_BINARY",
);
const fleet = await createScratchFleet({
  sessions: 1,
  windowsPerSession: 1,
  slug: "reconnect",
  namedSocket: true,
});
const signals = join(fleet.root, "signals");
await mkdir(signals, { recursive: true });
let daemon, child;
const steps = [];
try {
  daemon = await startDaemon(fleet);
  child = spawn(
    guiTestBinary,
    [
      "--ignored",
      "--nocapture",
      "--test-threads=1",
      "a_lost_stream_rebinds_keeping_the_frame_and_typing_works_after",
    ],
    {
      env: {
        ...process.env,
        ...fleet.environment,
        TMUX_IDE_TEST_DAEMON_RECORD: join(fleet.daemonInfoDir, "daemon.json"),
        TMUX_IDE_TEST_SIGNAL_DIR: signals,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  const transcript = [];
  let dropping = null;
  let stopping = null;
  let restarting = null;
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      transcript.push(chunk);
      output = (output + chunk).slice(-65536);
      if (dropping === null && output.includes("RECONNECT_DROP_READY")) {
        // The daemon's control-mode client is its terminal source.
        dropping = true;
        const tmux = (...argv) =>
          execFileSync(fleet.environment.TMUX_IDE_TMUX_BIN, ["-S", fleet.socketPath, ...argv], {
            env: { ...process.env, ...fleet.environment },
            encoding: "utf8",
            timeout: 5000,
          }).trim();
        const clients = tmux("list-clients", "-F", "#{client_control_mode} #{client_name}")
          .split("\n")
          .filter((line) => line.startsWith("1 "))
          .map((line) => line.slice(2));
        for (const name of clients) tmux("detach-client", "-t", name);
        steps.push(`detached ${clients.length} control client(s)`);
      }
      if (stopping === null && output.includes("RECONNECT_STOP_READY")) {
        stopping = (async () => {
          // SMOKE_SKIP_STOP=1 runs the restart straight after the rebind.
          if (process.env.SMOKE_SKIP_STOP === "1") {
            steps.push("freeze skipped");
            await writeFile(join(signals, "stop-done"), "");
            return;
          }
          const pid = daemon.record.pid;
          process.kill(pid, "SIGSTOP");
          steps.push(`SIGSTOP ${pid}`);
          await sleep(10_000);
          process.kill(pid, "SIGCONT");
          steps.push(`SIGCONT ${pid}`);
          await writeFile(join(signals, "stop-done"), "");
        })();
      }
      if (restarting === null && output.includes("RECONNECT_RESTART_READY")) {
        restarting = (async () => {
          await stopping;
          const old = daemon.record.instanceId;
          await daemon.stop();
          daemon = await startDaemon(fleet);
          steps.push(`restarted ${old} -> ${daemon.record.instanceId}`);
          await writeFile(join(signals, "restart-done"), "");
        })();
      }
    });
  const [code, signal] = await once(child, "close", { signal: AbortSignal.timeout(240000) });
  // Optional full transcript for diagnosis; the record's token is redacted below.
  if (process.env.SMOKE_TRANSCRIPT)
    await writeFile(
      process.env.SMOKE_TRANSCRIPT,
      Buffer.concat(transcript).toString().replaceAll(daemon.record.authToken, "[redacted]"),
    );
  await stopping;
  await restarting;
  const redact = (text) => text.replaceAll(daemon.record.authToken, "[redacted]");
  const live = output.split("\n").find((line) => line.startsWith("RECONNECT_LIVE "));
  const appLines = output
    .split("\n")
    .filter((line) => line.startsWith("tmux-preview:") || line.startsWith("tmux-ide:"));
  if (process.env.SMOKE_DAEMON_LOG)
    await writeFile(
      process.env.SMOKE_DAEMON_LOG,
      daemon.output().replaceAll(daemon.record.authToken, "[redacted]"),
    );
  // Where typed lines landed: in the shell, as tmux captures it.
  const pane = fleet.capturePane(fleet.sessionNames[0]);
  const landed = ["one", "rebound", "two", "three"].filter((m) => pane.includes(`typed-${m}`));
  console.log(
    JSON.stringify({ steps, appLines, landed, live: live && JSON.parse(live.slice(15)) }, null, 2),
  );
  assert.equal(signal, null);
  assert.equal(code, 0, redact(output));
  assert.match(output, /1 passed/);
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
