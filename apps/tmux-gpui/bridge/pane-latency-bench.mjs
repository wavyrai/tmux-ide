// Opt-in pane switch / resize latency measurement against an owned daemon and tmux socket.
// Drives the browser bridge exactly as the native app does (stdin commands, stdout
// publications) and reports milliseconds from command to the first matching publication.
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";
import { listTmuxServers } from "../../../packages/daemon-client/src/tmux-server-client.ts";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

const rounds = Number(process.env.TMUX_GPUI_BENCH_ROUNDS ?? 12);
const [fitCols, fitRows] = (process.env.TMUX_GPUI_BENCH_GRID ?? "110x32").split("x").map(Number);
let publicationBytes = 0;
let publicationCount = 0;
const fleet = await createScratchFleet({ sessions: 1, windowsPerSession: 1, slug: "gpui-latency" });
let daemon, browser;
let stderr = "";
const events = [];
const waiters = new Set();
const tmux = (...args) =>
  execFileSync(fleet.environment.TMUX_IDE_TMUX_BIN, ["-S", fleet.socketPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...fleet.environment },
  }).trim();
const next = (predicate, label, timeout = 20000) =>
  new Promise((done, fail) => {
    const waiter = { predicate, done };
    waiters.add(waiter);
    setTimeout(() => {
      if (!waiters.delete(waiter)) return;
      const last = events.at(-1)?.value;
      const summary = last && {
        request: last.request,
        selectedPane: last.selectedPane,
        inputReady: last.inputReady,
        snapshot: !!last.snapshot,
        resizeToken: !!last.resizeToken,
        resizeGestureSupported: last.resizeGestureSupported,
        status: last.status,
      };
      fail(new Error(`Deadline: ${label} ${JSON.stringify(summary)}\n${stderr.slice(-2000)}`));
    }, timeout);
  });
let request = 0;
const send = (command) => browser.stdin.write(JSON.stringify(command) + "\n");
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    n: sorted.length,
    min: +sorted[0].toFixed(1),
    p50: +pick(0.5).toFixed(1),
    p90: +pick(0.9).toFixed(1),
    max: +sorted.at(-1).toFixed(1),
  };
};
try {
  const first = tmux("display-message", "-p", "-t", fleet.sessionNames[0], "#{pane_id}");
  tmux("split-window", "-h", "-t", first, "sh -i");
  tmux("split-window", "-v", "-t", first, "sh -i");
  for (let n = 0; n < 40; n++) tmux("send-keys", "-t", first, "-l", `echo line-${n}\n`);
  daemon = await startDaemon(fleet);
  const options = {
    baseUrl: daemon.baseUrl + "/",
    ownerToken: daemon.record.authToken,
    hostClientId: "gpui-latency-bench",
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
  const bundle = process.env.TMUX_GPUI_TEST_BUNDLE;
  browser = spawn(
    process.execPath,
    [
      ...(bundle ? [] : ["--import", "tsx"]),
      bundle ? resolve(bundle, "browser.bundle.mjs") : resolve("apps/tmux-gpui/bridge/browser.ts"),
      config,
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...fleet.environment,
        ...(process.env.TMUX_GPUI_BENCH_NODE_OPTIONS
          ? { NODE_OPTIONS: process.env.TMUX_GPUI_BENCH_NODE_OPTIONS }
          : {}),
      },
    },
  );
  browser.stderr.on("data", (b) => (stderr += b.toString()));
  let buffer = "";
  browser.stdout.on("data", (b) => {
    buffer += b.toString();
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      publicationBytes += line.length;
      publicationCount++;
      if (process.env.TMUX_GPUI_BENCH_DUMP && line.length > 100000)
        writeFileSync(process.env.TMUX_GPUI_BENCH_DUMP, line + "\n");
      const event = { at: performance.now(), value: JSON.parse(line) };
      buffer = buffer.slice(end + 1);
      events.push(event);
      if (events.length > 64) events.shift();
      for (const waiter of [...waiters])
        if (waiter.predicate(event.value)) {
          waiters.delete(waiter);
          waiter.done(event);
        }
    }
  });
  const sessions = (await next((e) => e.sessions?.length === 1, "catalog")).value.sessions;
  send({ type: "session", request: ++request, id: sessions[0].id });
  const panes = (
    await next((e) => e.request === request && e.panes?.length === 3, "panes")
  ).value.panes.map((p) => p.id);
  const ready = (target) => (e) =>
    e.request === request && e.selectedPane === target && e.snapshot && e.inputReady;
  send({ type: "pane", request: ++request, id: panes[0] });
  await next(ready(panes[0]), "initial pane");

  // Pane switch: command -> first publication that shows the target selected with
  // a frame, and -> first publication where input is admitted for it.
  const switchFrame = [];
  const switchReady = [];
  const loading = [];
  for (let n = 1; n <= rounds; n++) {
    const target = panes[n % panes.length];
    const started = performance.now();
    send({ type: "pane", request: ++request, id: target });
    const blank = next(
      (e) => e.request === request && (!e.snapshot || e.selectedPane !== target),
      "blank",
      200,
    ).catch(() => null);
    const frame = await next(
      (e) => e.request === request && e.selectedPane === target && e.snapshot,
      "switch frame",
    );
    const input = frame.value.inputReady ? frame : await next(ready(target), "switch input");
    switchFrame.push(frame.at - started);
    switchReady.push(input.at - started);
    if (await blank) loading.push(n);
    await new Promise((r) => setTimeout(r, 30));
  }

  // TUI reference: the attached client only needs tmux to change the active pane.
  const tuiSwitch = [];
  const tmuxPanes = tmux("list-panes", "-t", first, "-F", "#{pane_id}").split("\n");
  for (let n = 1; n <= rounds; n++) {
    const started = performance.now();
    tmux("select-pane", "-t", tmuxPanes[n % tmuxPanes.length]);
    tuiSwitch.push(performance.now() - started);
  }

  // Window resize: one request, then a burst like a live window drag.
  const latest = () => events.at(-1).value;
  const windowSingle = [];
  for (let n = 0; n < Math.min(rounds, 8); n++) {
    const cols = 100 + (n % 2) * 20;
    const rows = 30 + (n % 2) * 6;
    const started = performance.now();
    send({
      type: "input",
      request,
      id: latest().selectedPane,
      input: { kind: "resize", data: { cols, rows } },
    });
    const done = await next(
      (e) =>
        e.request === request &&
        e.snapshot?.cols === cols &&
        e.snapshot?.rows === rows &&
        e.inputReady,
      "window resize",
    );
    windowSingle.push(done.at - started);
  }
  const burstStarted = performance.now();
  const steps = 30;
  for (let n = 0; n < steps; n++) {
    send({
      type: "input",
      request,
      id: latest().selectedPane,
      input: { kind: "resize", data: { cols: 90 + n, rows: 28 + (n >> 1) } },
    });
    await new Promise((r) => setTimeout(r, 16));
  }
  const sentAll = performance.now() - burstStarted;
  const finalCols = 90 + steps - 1;
  const finalRows = 28 + ((steps - 1) >> 1);
  const burst = await next(
    (e) =>
      e.request === request &&
      e.snapshot?.cols === finalCols &&
      e.snapshot?.rows === finalRows &&
      e.inputReady,
    "window resize burst",
    60000,
  );
  const burstSettle = burst.at - burstStarted;

  // Divider drag through the gesture protocol (latest-wins on the bridge).
  const dividerStep = [];
  let dragTotal = null;
  const regionOf = (e, id) => e.regions.find((r) => r.id === id);
  const leftPane = latest().regions.reduce((a, b) => (b.left < a.left ? b : a)).id;
  if (process.env.TMUX_GPUI_BENCH_FRESH_DIVIDER) {
    send({ type: "session", request: ++request, id: sessions[0].id });
    await next((e) => e.request === request && e.panes?.length === 3, "fresh panes");
  }
  send({ type: "pane", request: ++request, id: leftPane });
  await next(ready(leftPane), "divider pane");
  // The native view fits the viewport once per navigation request, as it does here.
  send({
    type: "input",
    request,
    id: leftPane,
    input: { kind: "resize", data: { cols: fitCols, rows: fitRows } },
  });
  await next(
    (e) =>
      e.request === request &&
      e.snapshot?.cols === fitCols &&
      e.snapshot?.rows === fitRows &&
      e.inputReady,
    "divider fit",
  );
  publicationBytes = 0;
  publicationCount = 0;
  const tokenReady = (e) => e.request === request && e.resizeToken && e.resizeGestureSupported;
  if (!tokenReady(events.at(-1).value)) await next(tokenReady, "token");
  {
    const start = latest();
    const width = regionOf(start, leftPane).width;
    const gesture = randomUUID();
    const base = { type: "resize-gesture", request, gesture, id: leftPane, axis: "cols" };
    send({ ...base, phase: "begin", token: start.resizeToken, cells: width });
    await next((e) => e.resizeGesture?.gesture === gesture, "gesture begin");
    // Step-by-step: each move waits for the settled frame before the next one.
    let cells = width;
    for (let n = 0; n < Math.min(rounds, 8); n++) {
      cells += n % 2 ? -3 : 4;
      const started = performance.now();
      send({ ...base, phase: "move", cells });
      const shown = await next(
        (e) => regionOf(e, leftPane)?.width === cells && e.resizeGesture?.gesture === gesture,
        "divider step",
      );
      dividerStep.push(shown.at - started);
    }
    // Continuous drag: one move per 16ms frame, then release; time to the final frame.
    const dragStarted = performance.now();
    for (let n = 0; n < steps; n++) {
      send({ ...base, phase: "move", cells: cells + 1 + (n % 15) });
      await new Promise((r) => setTimeout(r, 16));
    }
    const final = cells + 1 + ((steps - 1) % 15);
    send({ ...base, phase: "release", cells: final });
    const settled = await next(
      (e) =>
        e.resizeGesture?.gesture === gesture &&
        e.resizeGesture.phase === "settled" &&
        regionOf(e, leftPane)?.width === final,
      "divider drag settle",
      60000,
    );
    dragTotal = settled.at - dragStarted;
  }
  console.log(
    JSON.stringify(
      {
        bundle: !!bundle,
        paneSwitchToFrameMs: stats(switchFrame),
        paneSwitchToInputMs: stats(switchReady),
        paneSwitchBlankedRounds: loading.length,
        tuiSelectPaneCommandMs: stats(tuiSwitch),
        windowResizeSingleMs: stats(windowSingle),
        windowResizeBurst: {
          steps,
          sentOverMs: Math.round(sentAll),
          settledAtMs: Math.round(burstSettle),
        },
        dividerStepMs: stats(dividerStep),
        dividerDrag: { steps, settledAtMs: Math.round(dragTotal) },
        dividerPublications: {
          grid: `${fitCols}x${fitRows}`,
          count: publicationCount,
          averageBytes: Math.round(publicationBytes / Math.max(1, publicationCount)),
        },
      },
      null,
      2,
    ),
  );
} finally {
  if (browser && browser.exitCode === null) {
    const done = once(browser, "close");
    browser.kill("SIGTERM");
    await done;
  }
  if (daemon) await daemon.stop();
  await fleet.dispose();
}
