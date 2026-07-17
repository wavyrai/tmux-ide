#!/usr/bin/env bun
/**
 * perf-mirror — the M21 baseline harness.
 *
 * Drives the real unified app (`tmux-ide app`) against a scripted tmux session
 * on the default socket, exercising the three mirror-pipeline taps that gate
 * behind TMUX_IDE_ZZ_PERF, then prints a p50/p95 table for:
 *   - feed-parse   ms per stdout chunk   (/tmp/zz-feed.log,  control-client)
 *   - snapshot     ms per 8ms paint tick (/tmp/zz-perf.log,  app.tsx)
 *   - input-echo   ms keystroke→echo→paint (/tmp/zz-input.log, perf-tap)
 * across three scenarios: IDLE, FLOOD (scrolling), ALT (alt-screen redraw).
 *
 * Everything it creates is `zz-perf-*` on the default socket and is killed on
 * exit (success OR failure). It NEVER touches any other session. Run it from
 * the repo root:  bun scripts/perf-mirror.mjs
 *
 * Env knobs (all optional): PERF_FLOOD_MS, PERF_ALT_MS, PERF_IDLE_MS,
 * PERF_KEYS (input samples), PERF_KEY_GAP_MS, PERF_WARMUP_MS.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import os from "node:os";
import { summarize } from "../packages/daemon/src/tui/mirror/perf-tap.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP = "packages/daemon/src/tui/mirror/app.tsx";
const TARGET = "zz-perf-target";
const HOST = "zz-perf-host";
const FEED_LOG = "/tmp/zz-feed.log";
const SNAP_LOG = "/tmp/zz-perf.log";
const INPUT_LOG = "/tmp/zz-input.log";

const cfg = {
  floodMs: num(process.env.PERF_FLOOD_MS, 6000),
  altMs: num(process.env.PERF_ALT_MS, 6000),
  idleMs: num(process.env.PERF_IDLE_MS, 4000),
  keys: num(process.env.PERF_KEYS, 50),
  keyGapMs: num(process.env.PERF_KEY_GAP_MS, 90),
  warmupMs: num(process.env.PERF_WARMUP_MS, 5000),
};

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

/** tmux on the DEFAULT socket, un-nested (TMUX/TMUX_TMPDIR cleared) — the socket
 *  the app's control client attaches to and where the user's real sessions live.
 *  We only ever name zz-perf-* targets. */
function tmux(args, opts = {}) {
  return execFileSync("tmux", args, {
    env: { ...process.env, TMUX: "", TMUX_TMPDIR: "" },
    encoding: "utf8",
    stdio: opts.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    ...opts,
  });
}
function tmuxQuiet(args) {
  try {
    return tmux(args);
  } catch {
    return "";
  }
}
function sessionExists(name) {
  try {
    tmux(["has-session", "-t", name]);
    return true;
  } catch {
    return false;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const truncate = (p) => writeFileSync(p, "");
function readCol(path, col) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => Number(l.trim().split(/\s+/)[col]))
    .filter((n) => Number.isFinite(n));
}

// ── keystroke / flood injection ─────────────────────────────────────────────

/** Type into the HOST (the app), which forwards to the focused target pane. */
const sendHostKey = (key) => tmuxQuiet(["send-keys", "-t", HOST, key]);
const sendHostChar = (ch) => tmuxQuiet(["send-keys", "-t", HOST, "-l", ch]);
/** Run a command directly in the TARGET pane (bypasses the app — pure output). */
function runInTarget(line) {
  tmuxQuiet(["send-keys", "-t", TARGET, "-l", line]);
  tmuxQuiet(["send-keys", "-t", TARGET, "Enter"]);
}
/** Interrupt whatever the target pane is running, back to a clean prompt. */
function calmTarget() {
  tmuxQuiet(["send-keys", "-t", TARGET, "C-c"]);
  tmuxQuiet(["send-keys", "-t", TARGET, "-l", "printf '\\033[?1049l'"]);
  tmuxQuiet(["send-keys", "-t", TARGET, "Enter"]);
  tmuxQuiet(["send-keys", "-t", TARGET, "-l", "clear"]);
  tmuxQuiet(["send-keys", "-t", TARGET, "Enter"]);
}

// ── lifecycle ───────────────────────────────────────────────────────────────

function cleanup() {
  for (const s of [HOST, TARGET]) {
    if (sessionExists(s)) tmuxQuiet(["kill-session", "-t", s]);
  }
}

async function setup() {
  cleanup(); // clear any leftovers from a crashed prior run
  truncate(FEED_LOG);
  truncate(SNAP_LOG);
  truncate(INPUT_LOG);

  // Target: a plain shell on the default socket. The app mirrors this session;
  // its control client (`tmux -C attach`, TMUX="") reaches the default socket.
  tmux(["new-session", "-d", "-s", TARGET, "-x", "200", "-y", "50"]);
  // A generous host so the app has room and never wraps the flood oddly.
  tmux([
    "new-session",
    "-d",
    "-s",
    HOST,
    "-x",
    "220",
    "-y",
    "60",
    // Forward TMUX_IDE_FB_PANES verbatim so the default incremental blit path
    // (M21.4) and the `=0` StyledRun kill switch can be measured on the same
    // harness/taps. Unset → the app's default (blit).
    `cd ${REPO} && TMUX_IDE_ZZ_PERF=1 ${process.env.TMUX_IDE_FB_PANES !== undefined ? `TMUX_IDE_FB_PANES=${process.env.TMUX_IDE_FB_PANES} ` : ""}exec bun ${APP} --target=${TARGET}`,
  ]);

  process.stdout.write(`  warming up (${cfg.warmupMs}ms) — app attaching + seeding…\n`);
  await sleep(cfg.warmupMs);
  sendHostKey("F2"); // force the Terminal surface (pane-forward keyboard path)
  await sleep(400);
}

/** Assert the mirror is actually live: a brief flood must grow the feed log. */
async function assertLive() {
  truncate(FEED_LOG);
  runInTarget("for i in 1 2 3 4 5; do echo probe-$i; done");
  await sleep(800);
  const n = readCol(FEED_LOG, 1).length;
  if (n === 0) {
    const pane = tmuxQuiet(["capture-pane", "-t", HOST, "-p"]).slice(0, 800);
    throw new Error(
      `mirror never went live — no %output feed after a probe.\n--- host pane ---\n${pane}`,
    );
  }
  calmTarget();
  await sleep(500);
}

// ── scenarios ────────────────────────────────────────────────────────────────

/** Idle: quiet pane; capture the low-water feed/snapshot floor. */
async function scenarioIdle() {
  calmTarget();
  await sleep(600);
  truncate(FEED_LOG);
  truncate(SNAP_LOG);
  await sleep(cfg.idleMs);
  return { feed: readCol(FEED_LOG, 1), snap: readCol(SNAP_LOG, 0) };
}

/** Flood: a steady stream of new lines (scrollback growth + re-snapshot). */
async function scenarioFlood() {
  calmTarget();
  await sleep(500);
  truncate(FEED_LOG);
  truncate(SNAP_LOG);
  // ~200 lines/sec — a busy build/test log, not a fork bomb.
  runInTarget(
    'i=0; while true; do echo "flood line $i $(date +%s%N)"; i=$((i+1)); sleep 0.005; done',
  );
  await sleep(cfg.floodMs);
  const out = { feed: readCol(FEED_LOG, 1), snap: readCol(SNAP_LOG, 0) };
  calmTarget();
  await sleep(500);
  return out;
}

/** Alt-screen: an app that repaints in place (cursor addressing, no scrollback). */
async function scenarioAlt() {
  calmTarget();
  await sleep(500);
  truncate(FEED_LOG);
  truncate(SNAP_LOG);
  runInTarget(
    "printf '\\033[?1049h'; while true; do printf '\\033[H\\033[2J'; date +%s.%N; seq 1 30; sleep 0.05; done",
  );
  await sleep(cfg.altMs);
  const out = { feed: readCol(FEED_LOG, 1), snap: readCol(SNAP_LOG, 0) };
  calmTarget();
  await sleep(500);
  return out;
}

/** Input latency: type single chars into the app at a shell prompt; each echoes. */
async function scenarioInput() {
  calmTarget();
  await sleep(600);
  truncate(INPUT_LOG);
  const glyphs = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (let k = 0; k < cfg.keys; k++) {
    sendHostChar(glyphs[k % glyphs.length]);
    await sleep(cfg.keyGapMs);
  }
  await sleep(400);
  const out = { echo: readCol(INPUT_LOG, 1), paint: readCol(INPUT_LOG, 2) };
  // Drop the half-typed line through the app. This is also the harness's
  // regression check that Ctrl-C reaches the focused pane without exiting the
  // mirror; every later scenario depends on the host staying alive.
  sendHostKey("C-c");
  return out;
}

// ── reporting ────────────────────────────────────────────────────────────────

function fmt(n) {
  return n.toFixed(2).padStart(8);
}
function row(label, s) {
  return `  ${label.padEnd(26)} ${String(s.count).padStart(6)} ${fmt(s.p50)} ${fmt(s.p95)} ${fmt(s.max)} ${fmt(s.mean)}`;
}
function table(rows) {
  const head = `  ${"metric".padEnd(26)} ${"n".padStart(6)} ${"p50".padStart(8)} ${"p95".padStart(8)} ${"max".padStart(8)} ${"mean".padStart(8)}`;
  return [head, "  " + "-".repeat(head.length - 2), ...rows].join("\n");
}

function machineInfo() {
  const cpu = os.cpus()[0]?.model ?? "unknown";
  let tmuxV = "unknown";
  try {
    tmuxV = tmux(["-V"]).trim();
  } catch {
    /* ignore */
  }
  let opentui = "unknown";
  try {
    const pkg = JSON.parse(readFileSync(resolve(REPO, "packages/daemon/package.json"), "utf8"));
    opentui =
      pkg.dependencies?.["@opentui/core"] ?? pkg.dependencies?.["@opentui/solid"] ?? "unknown";
  } catch {
    /* ignore */
  }
  return {
    date: new Date().toISOString(),
    platform: `${os.platform()} ${os.release()} (${os.arch()})`,
    cpu: `${cpu} × ${os.cpus().length}`,
    mem: `${(os.totalmem() / 1024 ** 3).toFixed(0)} GB`,
    bun: process.versions.bun ?? "n/a",
    node: process.versions.node,
    tmux: tmuxV,
    opentui,
  };
}

async function main() {
  const info = machineInfo();
  process.stdout.write("perf-mirror — M21 baseline harness\n");
  process.stdout.write(
    `  ${info.platform} · ${info.cpu} · bun ${info.bun} · ${info.tmux} · @opentui ${info.opentui}\n\n`,
  );

  await setup();
  await assertLive();

  process.stdout.write("  running IDLE…\n");
  const idle = await scenarioIdle();
  process.stdout.write("  running INPUT…\n");
  const input = await scenarioInput();
  process.stdout.write("  running FLOOD…\n");
  const flood = await scenarioFlood();
  process.stdout.write("  running ALT-SCREEN…\n\n");
  const alt = await scenarioAlt();

  const rows = [
    row("feed-parse ms/chunk [idle]", summarize(idle.feed)),
    row("feed-parse ms/chunk [flood]", summarize(flood.feed)),
    row("feed-parse ms/chunk [alt]", summarize(alt.feed)),
    row("snapshot ms/tick [idle]", summarize(idle.snap)),
    row("snapshot ms/tick [flood]", summarize(flood.snap)),
    row("snapshot ms/tick [alt]", summarize(alt.snap)),
    row("input echo ms (t1-t0)", summarize(input.echo)),
    row("input paint ms (t2-t0)", summarize(input.paint)),
  ];
  process.stdout.write(table(rows) + "\n");

  return { info, rows };
}

let exitCode = 0;
try {
  await main();
} catch (err) {
  exitCode = 1;
  process.stderr.write(`\nperf-mirror FAILED: ${err?.stack ?? err}\n`);
} finally {
  cleanup();
  // Best-effort confirmation the zz-perf-* sessions are gone.
  const leftover = [HOST, TARGET].filter(sessionExists);
  if (leftover.length)
    process.stderr.write(`  WARNING leftover sessions: ${leftover.join(", ")}\n`);
  else process.stdout.write("\n  cleanup: zz-perf-* sessions removed.\n");
}
process.exit(exitCode);
