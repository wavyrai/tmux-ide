// Live (capability 122): a pane with ~2000 rows of history against an owned
// scratch tmux server and daemon (never the developer's). The daemon must be
// a release with history on demand (productVersion >= 2.9.27): pass its
// bin/cli.js as SMOKE_CLI.
//
//   SMOKE_CLI=/abs/bin/cli.js node --import tsx native-history-on-demand-smoke.mjs ABS_GUI_TEST_BINARY
import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createScratchFleet } from "../../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../../scripts/lib/product-fixtures/daemon.ts";
import { stopFixtureChild } from "../fixture-child.mjs";
const { AbortSignal } = globalThis;

const [guiTestBinary] = process.argv.slice(2);
assert(
  guiTestBinary && isAbsolute(guiTestBinary),
  "Usage: node --import tsx native-history-on-demand-smoke.mjs ABS_GUI_TEST_BINARY",
);
assert(process.env.SMOKE_CLI && isAbsolute(process.env.SMOKE_CLI), "Set SMOKE_CLI");
const fleet = await createScratchFleet({ sessions: 1, windowsPerSession: 1, slug: "history" });
const tmux = (...args) =>
  execFileSync(fleet.environment.TMUX_IDE_TMUX_BIN, ["-S", fleet.socketPath, ...args], {
    env: { ...process.env, ...fleet.environment },
    timeout: 5000,
  }).toString();
let daemon, child;
try {
  const pane = fleet.initialPanes[0].paneId;
  tmux("send-keys", "-t", pane, "clear; seq 1 3000", "Enter");
  const deadline = Date.now() + 20000;
  while (!tmux("capture-pane", "-p", "-t", pane).includes("3000")) {
    assert(Date.now() < deadline, "seq did not finish");
    await sleep(50);
  }
  const history = Number(tmux("display-message", "-p", "-t", pane, "#{history_size}").trim());
  console.log(`pane history rows ${history}`);
  daemon = await startDaemon(fleet, { cliPath: process.env.SMOKE_CLI });
  console.log(`daemon productVersion ${daemon.record.productVersion}`);
  child = spawn(
    guiTestBinary,
    ["--ignored", "--nocapture", "--test-threads=1", "scrolling_up_loads_older_history_by_request"],
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
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      output = (output + chunk).slice(-262144);
      if (process.env.SMOKE_TRANSCRIPT) appendFileSync(process.env.SMOKE_TRANSCRIPT, chunk);
    });
  const [code, signal] = await once(child, "close", { signal: AbortSignal.timeout(180000) });
  const line = output.split("\n").find((l) => l.startsWith("HISTORY_LIVE "));
  console.log(line ? JSON.stringify(JSON.parse(line.slice(13)), null, 1) : output.slice(-4000));
  if (process.env.SMOKE_DAEMON_LOG)
    writeFileSync(
      process.env.SMOKE_DAEMON_LOG,
      daemon.output().replaceAll(daemon.record.authToken, "[redacted]"),
    );
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
