// Live (#806): a session of 30 panes over two windows (20 and 10) against an
// owned scratch tmux server and daemon (never the developer's). The daemon
// must be a release with window-scoped streams (productVersion >= 2.9.26):
// pass its bin/cli.js as SMOKE_CLI.
//
//   SMOKE_CLI=/abs/bin/cli.js node --import tsx native-window-streams-smoke.mjs ABS_GUI_TEST_BINARY
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
  "Usage: node --import tsx native-window-streams-smoke.mjs ABS_GUI_TEST_BINARY",
);
assert(process.env.SMOKE_CLI && isAbsolute(process.env.SMOKE_CLI), "Set SMOKE_CLI");
const fleet = await createScratchFleet({ sessions: 1, windowsPerSession: 2, slug: "windows" });
const signals = join(fleet.root, "signals");
mkdirSync(signals, { recursive: true });
const tmux = (...args) =>
  execFileSync(fleet.environment.TMUX_IDE_TMUX_BIN, ["-S", fleet.socketPath, ...args], {
    env: { ...process.env, ...fleet.environment },
    timeout: 5000,
  }).toString();
const session = fleet.sessionNames[0];
const grow = (window, panes) => {
  const target = `=${session}:=${window}`;
  tmux("set-option", "-w", "-t", target, "window-size", "manual");
  tmux("resize-window", "-t", target, "-x", "320", "-y", "120");
  for (let i = 1; i < panes; i += 1) {
    tmux("split-window", "-d", "-t", target, "sh -i");
    tmux("select-layout", "-t", target, "tiled");
  }
};
let daemon, child;
try {
  grow("one", 20);
  grow("two", 10);
  tmux("select-window", "-t", `=${session}:=one`);
  const count = tmux("list-panes", "-s", "-t", `=${session}`, "-F", "#{pane_id}")
    .trim()
    .split("\n");
  assert.equal(count.length, 30);
  daemon = await startDaemon(fleet, { cliPath: process.env.SMOKE_CLI });
  console.log(`daemon productVersion ${daemon.record.productVersion}`);
  child = spawn(
    guiTestBinary,
    [
      "--ignored",
      "--nocapture",
      "--test-threads=1",
      "a_session_over_the_pane_limit_opens_and_switches_by_window",
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
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      output = (output + chunk).slice(-262144);
      if (process.env.SMOKE_TRANSCRIPT) appendFileSync(process.env.SMOKE_TRANSCRIPT, chunk);
      const ready = output.match(/WINDOW_SPLIT_READY (\S+)/u);
      if (!split && ready) {
        split = true;
        const target = `=${session}:=${ready[1]}`;
        tmux("split-window", "-d", "-t", target, "sh -i");
        tmux("select-layout", "-t", target, "tiled");
        writeFileSync(join(signals, "split-done"), String(Date.now()));
      }
    });
  const [code, signal] = await once(child, "close", { signal: AbortSignal.timeout(300000) });
  const line = output.split("\n").find((l) => l.startsWith("WINDOW_LIVE "));
  console.log(line ? JSON.stringify(JSON.parse(line.slice(12)), null, 1) : output.slice(-4000));
  // Keys typed into the old window during a switch never ran anywhere.
  const panes = tmux("list-panes", "-s", "-t", `=${session}`, "-F", "#{pane_id}")
    .trim()
    .split("\n");
  const strays = panes.filter((pane) =>
    tmux("capture-pane", "-p", "-t", pane, "-S", "-200").includes("during-switch"),
  );
  console.log(JSON.stringify({ panesAtEnd: panes.length, panesWithStrayKeys: strays.length }));
  assert.equal(strays.length, 0, "keys typed during a switch reached a pane");
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
