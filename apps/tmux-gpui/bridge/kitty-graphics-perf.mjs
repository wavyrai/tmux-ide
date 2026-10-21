// Opt-in kitty graphics throughput measurement through the product bridge
// path. A pane runs scripts/kitty-spike/emulate-client.py (a full-frame
// client re-transmitting one image under tmux); every image chunk the bridge
// forwards toward the window is timed against the frame's write time.
//
//   KITTY_PERF_FPS=30 KITTY_PERF_SECONDS=8 node --import tsx \
//     apps/tmux-gpui/bridge/kitty-graphics-perf.mjs
//
// TMUX_GPUI_TEST_BINARY pipes the bridge into a dev native binary so its
// stdin backpressure is part of the measurement.
//
import process from "node:process";
import console from "node:console";
import { setTimeout } from "node:timers";
import { Buffer } from "node:buffer";
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";
import { listTmuxServers } from "../../../packages/daemon-client/src/tmux-server-client.ts";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

if (process.env.TMUX_IDE_KITTY_SMOKE_TMUX)
  process.env.PATH = `${process.env.TMUX_IDE_KITTY_SMOKE_TMUX}:${process.env.PATH}`;

const fleet = await createScratchFleet({ sessions: 1, windowsPerSession: 1, slug: "gpui-kperf" });
let daemon, browser, native;
const events = [];
let stderr = "";
let nativeStderr = "";
const tmux = (...args) =>
  execFileSync(fleet.environment.TMUX_IDE_TMUX_BIN, ["-S", fleet.socketPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...fleet.environment },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const send = (command) => browser.stdin.write(JSON.stringify(command) + "\n");
const until = async (predicate, label) => {
  const end = Date.now() + 60000;
  while (!predicate()) {
    if (browser?.exitCode != null) throw new Error("Browser exited: " + stderr);
    if (native?.exitCode != null) throw new Error("Native exited: " + nativeStderr);
    if (Date.now() > end) throw new Error(`${label} deadline: ${stderr}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

try {
  const fps = Number(process.env.KITTY_PERF_FPS ?? 30);
  const seconds = Number(process.env.KITTY_PERF_SECONDS ?? 8);
  const [cols, rows] = (process.env.KITTY_PERF_GRID ?? "120x40").split("x").map(Number);
  daemon = await startDaemon(
    fleet,
    process.env.KITTY_PERF_CLI ? { cliPath: process.env.KITTY_PERF_CLI } : undefined,
  );
  const options = {
    baseUrl: daemon.baseUrl + "/",
    ownerToken: daemon.record.authToken,
    hostClientId: "gpui-kitty-perf",
    origin: "tmux-ide://app",
  };
  const { servers } = await listTmuxServers(options);
  const server = servers.find((s) => s.state === "online");
  const config = fleet.root + "/host.json";
  await writeFile(
    config,
    JSON.stringify({
      baseUrl: options.baseUrl,
      ownerToken: options.ownerToken,
      scope: { serverId: server.serverId, generation: server.generation },
    }),
    { mode: 0o600 },
  );
  const arrivals = new Map();
  let forwardedBytes = 0;
  let chunkBytes = 0;
  let publications = 0;
  browser = spawn(
    process.execPath,
    ["--import", "tsx", resolve("apps/tmux-gpui/bridge/browser.ts"), config],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...fleet.environment,
        ...(process.env.KITTY_PERF_BRIDGE_PROFILE
          ? { NODE_OPTIONS: `--cpu-prof --cpu-prof-dir=${process.env.KITTY_PERF_BRIDGE_PROFILE}` }
          : {}),
      },
    },
  );
  browser.stderr.on("data", (b) => (stderr += b.toString()));
  let buffer = "";
  browser.stdout.on("data", (b) => {
    forwardedBytes += b.length;
    buffer += b.toString();
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const event = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (event.kittyImageChunk) {
        const chunk = event.kittyImageChunk;
        chunkBytes += end + 1;
        const got =
          (arrivals.get(chunk.digest)?.bytes ?? 0) + Buffer.byteLength(chunk.data, "base64");
        arrivals.set(chunk.digest, { bytes: got, at: got >= chunk.total ? Date.now() : null });
      } else {
        publications += 1;
        events.push(event);
      }
    }
  });
  if (process.env.TMUX_GPUI_TEST_BINARY) {
    native = spawn(process.env.TMUX_GPUI_TEST_BINARY, ["--tmux-browser-stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...fleet.environment },
    });
    native.stderr.on("data", (b) => (nativeStderr += b.toString()));
    browser.stdout.pipe(native.stdin);
    native.stdin.on("error", () => {});
  }
  send({ type: "presence", active: true, revision: 1 });
  await until(() => events.some((e) => e.sessions?.length === 1), "catalog");
  send({ type: "session", request: 1, id: events.at(-1).sessions[0].id });
  await until(() => events.at(-1)?.request === 1 && events.at(-1)?.panes.length >= 1, "panes");
  send({ type: "pane", request: 2, id: events.at(-1).panes[0].id });
  await until(() => events.some((e) => e.request === 2 && e.snapshot && e.inputReady), "ready");
  const pane = tmux("display-message", "-p", "-t", fleet.sessionNames[0], "#{pane_id}");
  tmux("resize-window", "-t", fleet.sessionNames[0], "-x", String(cols), "-y", String(rows + 1));
  const log = fleet.root + "/frames.log";
  const emulator = resolve("apps/tmux-gpui/scripts/kitty-spike/emulate-client.py");
  tmux(
    "send-keys",
    "-t",
    pane,
    "-l",
    `clear; /usr/bin/python3 ${emulator} ${log} ${cols} ${rows - 1} ${fps} ${seconds}; echo PERF-DONE`,
  );
  tmux("send-keys", "-t", pane, "Enter");
  const started = Date.now();
  await until(
    () =>
      Date.now() - started > (seconds + 1) * 1000 &&
      tmux("capture-pane", "-p", "-t", pane).includes("PERF-DONE"),
    "emulator",
  );
  await new Promise((r) => setTimeout(r, 3000));
  const frames = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const latencies = [];
  for (const frame of frames) {
    const arrival = arrivals.get(frame.zlibDigest) ?? arrivals.get(frame.rawDigest);
    if (arrival?.at) latencies.push(arrival.at - frame.writtenAt * 1000);
  }
  latencies.sort((a, b) => a - b);
  const pct = (p) =>
    latencies.length ? Math.round(latencies[Math.floor((latencies.length - 1) * p)]) : null;
  const placed = events.at(-1)?.graphics?.length ?? 0;
  console.log(
    JSON.stringify({
      tmux: tmux("-V"),
      targetFps: fps,
      seconds,
      canvas: `${cols * 8}x${(rows - 1) * 16}`,
      framesWritten: frames.length,
      framesDelivered: latencies.length,
      deliveredFps: Number((latencies.length / seconds).toFixed(1)),
      latencyMs: { p50: pct(0.5), p95: pct(0.95), max: pct(1) },
      bytesToWindowPerFrame: Math.round(forwardedBytes / Math.max(1, frames.length)),
      imageBytesPerFrame: Math.round(chunkBytes / Math.max(1, frames.length)),
      publications,
      paneBytesPerFrame: Math.round(frames.reduce((n, f) => n + f.bytes, 0) / frames.length),
      placements: placed,
      native: !!native,
    }),
  );
} finally {
  for (const child of [native, browser])
    if (child && child.exitCode === null) {
      const done = once(child, "close");
      child.kill("SIGTERM");
      await done;
    }
  if (daemon) await daemon.stop();
  await fleet.dispose();
}
