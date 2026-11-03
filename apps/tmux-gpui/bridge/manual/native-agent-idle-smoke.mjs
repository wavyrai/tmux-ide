// Card #716: Home's agent rows on an idle isolated daemon with 2 hook-stamped
// agents (requests, publications, visible roster changes over the idle window),
// then the time for one agent's state flip to show. Owned scratch tmux server
// and daemon only; never the developer's.
import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createScratchFleet } from "../../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../../scripts/lib/product-fixtures/daemon.ts";
import { stopFixtureChild } from "../fixture-child.mjs";
const { AbortSignal, setTimeout } = globalThis;

const [guiTestBinary] = process.argv.slice(2);
assert(
  guiTestBinary && isAbsolute(guiTestBinary),
  "Usage: node --import tsx native-agent-idle-smoke.mjs ABS_GUI_TEST_BINARY",
);
const fleet = await createScratchFleet({ sessions: 2, windowsPerSession: 1, slug: "agent-idle" });
const tmux = (...args) =>
  execFileSync(fleet.environment.TMUX_IDE_TMUX_BIN, ["-S", fleet.socketPath, ...args], {
    env: { ...process.env, ...fleet.environment },
    timeout: 5000,
  });
const stamp = (state) => `${state}:${Math.floor(Date.now() / 1000)}`;
const signals = mkdtempSync(join(tmpdir(), "agent-idle-"));
let daemon, child;
try {
  const panes = fleet.sessionNames.map(
    (name) => fleet.initialPanes.find((p) => p.sessionName === name).paneId,
  );
  for (const [index, pane] of panes.entries()) {
    tmux("set-option", "-p", "-t", pane, "@agent_display_name", `Fixture agent ${"AB"[index]}`);
    tmux("set-option", "-p", "-t", pane, "@agent_state", stamp("working"));
  }
  daemon = await startDaemon(fleet);
  for (const name of fleet.sessionNames) await daemon.promote(name);
  child = spawn(
    guiTestBinary,
    [
      "--ignored",
      "--nocapture",
      "--test-threads=1",
      "agent_rows_stay_still_when_idle_and_show_a_flip_within_a_second",
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
  // Each phase flips agent A once: Home to blocked, the open session back to working.
  const flips = { home: "blocked", session: "working" };
  const done = new Set();
  const cpu = {};
  const tmuxPid = tmux("display-message", "-p", "#{pid}").toString().trim();
  const seconds = (pid) => {
    const [m, sec] = execFileSync("ps", ["-o", "cputime=", "-p", String(pid)])
      .toString()
      .trim()
      .split(":");
    return Number(m) * 60 + Number(sec);
  };
  const cputime = () => ({ daemon: seconds(daemon.record.pid), tmux: seconds(tmuxPid) });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      output = (output + chunk).slice(-262144);
      if (process.env.SMOKE_TRANSCRIPT) appendFileSync(process.env.SMOKE_TRANSCRIPT, chunk);
      // Daemon CPU over Home's idle window, for the tick-cost comparison.
      if (!cpu.start && output.includes("AGENT_HOME_IDLE_START")) cpu.start = cputime();
      if (!cpu.end && output.includes("AGENT_FLIP_READY home")) cpu.end = cputime();
      for (const [phase, state] of Object.entries(flips))
        if (!done.has(phase) && output.includes(`AGENT_FLIP_READY ${phase}`)) {
          done.add(phase);
          // A random offset keeps the flip from lining up with the daemon's tick.
          setTimeout(
            () => {
              tmux("set-option", "-p", "-t", panes[0], "@agent_state", stamp(state));
              writeFileSync(join(signals, `flipped-${phase}`), String(Date.now()));
            },
            Math.floor(Math.random() * 2000),
          );
        }
    });
  const [code, signal] = await once(child, "close", { signal: AbortSignal.timeout(300000) });
  const line = output.split("\n").find((l) => l.startsWith("AGENT_IDLE "));
  console.log(line ? JSON.stringify(JSON.parse(line.slice(11)), null, 1) : output.slice(-4000));
  if (cpu.start !== undefined && cpu.end !== undefined)
    console.log(
      `DAEMON_IDLE_CPU_SECONDS ${(cpu.end.daemon - cpu.start.daemon).toFixed(2)} tmux ${(cpu.end.tmux - cpu.start.tmux).toFixed(2)}`,
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
