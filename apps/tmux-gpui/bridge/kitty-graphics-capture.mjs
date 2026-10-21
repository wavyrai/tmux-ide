// Opt-in capture of a real kitty-graphics client through the product bridge
// path (owned daemon, scratch tmux). The pane's raw output is recorded with
// scripts/kitty-spike/frame-logger.py, which times every transmission; each
// one is matched to the moment the bridge forwarded its last image chunk.
//
//   KITTY_CAPTURE_COMMAND=<client binary> KITTY_CAPTURE_URL=<url> \
//     node --import tsx apps/tmux-gpui/bridge/kitty-graphics-capture.mjs
//
// KITTY_CAPTURE_RAW=<path> keeps the raw pane bytes. TMUX_GPUI_TEST_BINARY
// pipes the bridge into a dev native binary so its consumption is measured.
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

const fleet = await createScratchFleet({ sessions: 1, windowsPerSession: 1, slug: "gpui-kcap" });
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
  const raw = fleet.root + "/pane.raw";
  const frameLog = fleet.root + "/frames.log";
  const logger = resolve("apps/tmux-gpui/scripts/kitty-spike/frame-logger.py");
  tmux("pipe-pane", "-o", "-t", pane, `/usr/bin/python3 ${logger} ${raw} ${frameLog}`);
  const url = process.env.KITTY_CAPTURE_URL ?? "https://example.com";
  tmux(
    "send-keys",
    "-t",
    pane,
    "-l",
    `clear; DO_NOT_TRACK=1 TERMINAL_BROWSER_NO_TELEMETRY=1 ${process.env.KITTY_CAPTURE_COMMAND} open ${url}`,
  );
  tmux("send-keys", "-t", pane, "Enter");
  const started = Date.now();
  await new Promise((r) => setTimeout(r, 8000));
  const delivered0 = [...arrivals.values()].filter((a) => a.at).length;
  // Scroll the page for a few seconds.
  const scrollStarted = Date.now();
  for (let i = 0; i < 40; i++) {
    // SGR wheel (the client enables 1006/1016): 65 = wheel down, 64 = up.
    const wheel = `\x1b[<${i % 20 < 10 ? 65 : 64};400;400M`;
    tmux("send-keys", "-t", pane, "-H", ...Buffer.from(wheel).toString("hex").match(/../gu));
    await new Promise((r) => setTimeout(r, 100));
  }
  const scrollMs = Date.now() - scrollStarted;
  await new Promise((r) => setTimeout(r, 1500));
  const delivered1 = [...arrivals.values()].filter((a) => a.at).length;
  const graphics = events.at(-1)?.graphics ?? [];
  if (process.env.KITTY_CAPTURE_SCREEN)
    await writeFile(process.env.KITTY_CAPTURE_SCREEN, JSON.stringify(events.at(-1)));
  tmux("send-keys", "-t", pane, "C-q");
  await new Promise((r) => setTimeout(r, 1500));
  tmux("pipe-pane", "-t", pane);
  if (process.env.KITTY_CAPTURE_RAW)
    await writeFile(process.env.KITTY_CAPTURE_RAW, await readFile(raw));
  const rawText = (await readFile(raw)).toString("latin1");
  const frames = (await readFile(frameLog, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const during = frames.filter(
    (f) => f.at * 1000 >= scrollStarted && f.at * 1000 <= scrollStarted + scrollMs,
  );
  const latencies = frames
    .map((f) => (arrivals.get(f.digest)?.at ?? NaN) - f.at * 1000)
    .filter((ms) => Number.isFinite(ms))
    .sort((a, b) => a - b);
  const pct = (p) =>
    latencies.length ? Math.round(latencies[Math.floor((latencies.length - 1) * p)]) : null;
  console.log(
    JSON.stringify({
      tmux: tmux("-V"),
      url,
      rawBytes: rawText.length,
      transmits: (rawText.match(/_Ga=T/gu) ?? []).length,
      queries: rawText.match(/_G[^;]*a=q[^;]*/gu) ?? [],
      imagesDeliveredWhileLoading: delivered0,
      imagesDeliveredWhileScrolling: delivered1 - delivered0,
      scrollFps: Number(((delivered1 - delivered0) / (scrollMs / 1000)).toFixed(1)),
      clientFramesWhileScrolling: during.length,
      clientScrollFps: Number((during.length / (scrollMs / 1000)).toFixed(1)),
      clientFrames: frames.length,
      framesDelivered: latencies.length,
      latencyMs: { p50: pct(0.5), p95: pct(0.95), max: pct(1) },
      bytesToWindow: forwardedBytes,
      publications,
      placements: graphics,
      native: !!native,
      elapsedMs: Date.now() - started,
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
