// Remote input latency: a private daemon and tmux (scratch fleet, its own -S
// socket and HOME) reached through a delay proxy, measured by the production
// Rust controller and input scheduler (herdr-client example
// tmux_input_latency_probe). Each round runs two fresh fixtures on the same
// link: a quiet one (key echo, a 30-key burst, text+Enter lines) and one with
// busy neighbour panes (key echo). The gate compares ratios to plain key echo
// of the same round; see gate.mjs and performance/remote-latency-budgets.json.
//
// Env: REMOTE_LATENCY_CLI (built CLI, absolute), REMOTE_LATENCY_PROBE (probe
// binary), REMOTE_LATENCY_OUT (evidence dir), REMOTE_LATENCY_ROUNDS,
// REMOTE_LATENCY_PROFILES (comma-separated names), REMOTE_LATENCY_CALIBRATE=1
// (report only, never fail).
import { execFile, execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createScratchFleet } from "../lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../lib/product-fixtures/daemon.ts";
import { startDelayProxy } from "./delay-proxy.mjs";
import { evaluate, renderSummary } from "./gate.mjs";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const budgets = JSON.parse(
  readFileSync(join(root, "performance/remote-latency-budgets.json"), "utf8"),
);
const cli = process.env.REMOTE_LATENCY_CLI;
const probe = process.env.REMOTE_LATENCY_PROBE;
for (const [name, path] of [
  ["REMOTE_LATENCY_CLI", cli],
  ["REMOTE_LATENCY_PROBE", probe],
])
  if (!path || !isAbsolute(path)) throw new Error(`${name} must be an absolute path`);
const out = resolve(process.env.REMOTE_LATENCY_OUT ?? join(root, ".tasks/remote-latency"));
const rounds = Number(process.env.REMOTE_LATENCY_ROUNDS || budgets.rounds);
const only = process.env.REMOTE_LATENCY_PROFILES?.split(",").filter(Boolean);
const calibrate = process.env.REMOTE_LATENCY_CALIBRATE === "1";
const profiles = budgets.profiles.filter((profile) => !only || only.includes(profile.name));
mkdirSync(out, { recursive: true });
const log = join(out, "runs.jsonl");

// Never reach a tmux server or daemon outside the fixture.
for (const name of [
  "TMUX",
  "TMUX_PANE",
  "TMUX_TMPDIR",
  "TMUX_IDE_DAEMON_INFO_DIR",
  "TMUX_IDE_HOME",
])
  delete process.env[name];

// A neighbour that prints its name at once (the probe types into the pane that
// does not say "spinner"), waits for the probe's go file, then keeps writing.
const spinner = (index, go) =>
  `printf 'spinner ${index}\\n'; while [ ! -f ${go} ]; do sleep 0.05; done; n=0; ` +
  `while :; do n=$((n+1)); printf 'spinner ${index} line %d %s\\n' $n ${"x".repeat(48)}; sleep 0.05; done`;

async function measure(profile, busy, round) {
  const fleet = await createScratchFleet({
    sessions: 1,
    windowsPerSession: 1,
    slug: "rlat",
    initialPaneCommand: { executable: "/bin/cat" },
  });
  let daemon;
  let proxy;
  try {
    if (!fleet.socketPath.startsWith(fleet.root) || !fleet.daemonInfoDir.startsWith(fleet.root))
      throw new Error("fixture socket and daemon record must live in the scratch root");
    const tmux = (...args) =>
      execFileSync(fleet.environment.TMUX_IDE_TMUX_BIN, ["-S", fleet.socketPath, ...args]);
    const go = join(fleet.root, "go");
    const target = `${fleet.sessionNames[0]}:`;
    if (busy) {
      tmux("resize-window", "-t", target, "-x", "240", "-y", "72");
      for (let index = 0; index < budgets.busyPanes; index++) {
        tmux("split-window", "-d", "-t", target, "/bin/sh", "-c", spinner(index, go));
        tmux("select-layout", "-t", target, "tiled");
      }
    }
    daemon = await startDaemon(fleet, { cliPath: cli });
    proxy = await startDelayProxy({
      targetPort: daemon.record.port,
      oneWayDelayMs: profile.oneWayDelayMs,
      mbit: profile.mbit ?? 0,
    });
    rmSync(go, { force: true });
    const { stdout } = await run(
      probe,
      [join(fleet.daemonInfoDir, "daemon.json"), String(proxy.port), "5"],
      {
        env: {
          ...process.env,
          ...fleet.environment,
          GO_FILE: go,
          PROBE_SCENARIOS: busy ? "echo" : "echo,burst30,lines",
        },
        timeout: 240_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const value = JSON.parse(stdout.trim());
    appendFileSync(
      log,
      `${JSON.stringify({ profile: profile.name, round, busy, bytes: proxy.bytes, value })}\n`,
    );
    return value;
  } finally {
    await proxy?.close();
    await daemon?.stop();
    await fleet.dispose();
  }
}

const results = {};
for (const profile of profiles) {
  results[profile.name] = [];
  for (let round = 0; round < rounds; round++) {
    // Alternate which fixture goes first, so neither always meets a warmer runner.
    const order = round % 2 ? [true, false] : [false, true];
    const entry = {};
    try {
      for (const busy of order) {
        let value;
        try {
          value = await measure(profile, busy, round);
        } catch (first) {
          // One retry: a fixture that fails to start says nothing about latency.
          console.error(
            `${profile.name} round ${round} ${busy ? "busy" : "plain"}: retrying after ${first.message}`,
          );
          value = await measure(profile, busy, round);
        }
        entry[busy ? "busy" : "plain"] = value;
      }
    } catch (error) {
      entry.error = String(error.stderr || error.message)
        .trim()
        .split("\n")
        .slice(-3)
        .join(" | ")
        .slice(0, 400);
    }
    results[profile.name].push(entry);
    console.log(JSON.stringify({ profile: profile.name, round, ...entry }));
  }
}

const verdict = evaluate({ ...budgets, profiles }, results);
const summary = renderSummary(verdict, { calibrate });
writeFileSync(join(out, "results.json"), JSON.stringify({ budgets, results, verdict }, null, 2));
writeFileSync(join(out, "summary.md"), summary);
process.stdout.write(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
if (!verdict.ok && !calibrate) process.exitCode = 1;
