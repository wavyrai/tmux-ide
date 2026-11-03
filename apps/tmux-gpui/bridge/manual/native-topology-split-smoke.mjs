// Live: split a pane into the viewed session from outside the app, against an
// owned scratch tmux server and daemon (never the developer's). SMOKE_CLI runs
// another daemon build, e.g. an installed 2.9.15 bin/cli.js.
import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createScratchFleet } from "../../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../../scripts/lib/product-fixtures/daemon.ts";
import { stopFixtureChild } from "../fixture-child.mjs";
const { AbortSignal } = globalThis;

const [guiTestBinary] = process.argv.slice(2);
assert(
  guiTestBinary && isAbsolute(guiTestBinary),
  "Usage: node --import tsx native-topology-split-smoke.mjs ABS_GUI_TEST_BINARY",
);
const fleet = await createScratchFleet({ sessions: 1, windowsPerSession: 1, slug: "topology" });
const signals = join(fleet.root, "signals");
mkdirSync(signals, { recursive: true });
const tmux = (...args) =>
  execFileSync(fleet.environment.TMUX_IDE_TMUX_BIN, ["-S", fleet.socketPath, ...args], {
    env: { ...process.env, ...fleet.environment },
    timeout: 5000,
  });
let daemon, child;
try {
  daemon = await startDaemon(
    fleet,
    process.env.SMOKE_CLI ? { cliPath: process.env.SMOKE_CLI } : {},
  );
  child = spawn(
    guiTestBinary,
    [
      "--ignored",
      "--nocapture",
      "--test-threads=1",
      process.env.SMOKE_TEST ?? "a_pane_split_in_or_closed_from_outside_keeps_the_open_stream",
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
  let split = false;
  let closed = false;
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      output = (output + chunk).slice(-262144);
      if (process.env.SMOKE_TRANSCRIPT) appendFileSync(process.env.SMOKE_TRANSCRIPT, chunk);
      if (!split && output.includes("TOPOLOGY_SPLIT_READY")) {
        split = true;
        // Another tmux client splits the viewed session, as `tmux-ide open` does.
        const pane = fleet.initialPanes.find((p) => p.sessionName === fleet.sessionNames[0]).paneId;
        tmux("split-window", "-h", "-t", pane, "-d");
        writeFileSync(join(signals, "split-done"), String(Date.now()));
      }
      if (output.includes("TOPOLOGY_REPLACE_READY") && !closed) {
        closed = true;
        // Another client splits a new pane in, then kills the selected one.
        const pane = fleet.initialPanes.find((p) => p.sessionName === fleet.sessionNames[0]).paneId;
        tmux("split-window", "-d", "-t", pane, "sh -i");
        tmux("kill-pane", "-t", pane);
        writeFileSync(join(signals, "replace-done"), String(Date.now()));
      }
      if (!closed && output.includes("TOPOLOGY_CLOSE_READY")) {
        closed = true;
        // Another tmux client closes the pane it split in.
        const session = fleet.sessionNames[0];
        const first = fleet.initialPanes.find((p) => p.sessionName === session).paneId;
        const added = tmux("list-panes", "-s", "-t", session, "-F", "#{pane_id}")
          .toString()
          .trim()
          .split("\n")
          .find((pane) => pane !== first);
        if (added) tmux("kill-pane", "-t", added);
        writeFileSync(join(signals, "close-done"), String(Date.now()));
      }
    });
  const [code, signal] = await once(child, "close", { signal: AbortSignal.timeout(180000) });
  const line = output.split("\n").find((l) => l.startsWith("TOPOLOGY_LIVE "));
  console.log(line ? JSON.stringify(JSON.parse(line.slice(14)), null, 1) : output.slice(-4000));
  assert.equal(signal, null);
  assert.equal(code, 0, output.replaceAll(daemon.record.authToken, "[redacted]"));
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
