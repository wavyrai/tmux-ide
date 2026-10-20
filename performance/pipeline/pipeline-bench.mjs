// Opt-in end-to-end measurement of the native-app data pipeline:
//   tmux %output -> daemon -> live helper -> browser helper -> preview-launcher -> GUI
// against a scratch tmux socket, temp HOME and an owned daemon. A stand-in GUI
// process (fake-gui.mjs) sits where the native binary runs and relays to this
// harness, which plays the GUI: it parses every publication (the decode proxy)
// and drives commands. Every Node process loads probe.mjs, which records bytes,
// lines, large JSON costs, CPU, RSS and latency marks per process.
//
//   node --import tsx performance/pipeline/pipeline-bench.mjs BRIDGE_BUNDLE_DIR OUT.json
//
// Env: PIPELINE_GRID=110x32, PIPELINE_WORKLOADS=comma list (default all),
//      PIPELINE_PANES=3, PIPELINE_ROUNDS=12, PIPELINE_KITTY_FRAMES=30
import { createScratchFleet } from "../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../scripts/lib/product-fixtures/daemon.ts";
import { listTmuxServers } from "../../packages/daemon-client/src/tmux-server-client.ts";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { writeFrames } from "./kitty-frames.mjs";

const here = import.meta.dirname;
const repo = resolve(here, "../..");
const [bundleDir, outPath] = process.argv.slice(2).map((p) => resolve(p));
if (!bundleDir || !outPath) throw new Error("usage: pipeline-bench.mjs BRIDGE_BUNDLE_DIR OUT.json");
const [fitCols, fitRows] = (process.env.PIPELINE_GRID ?? "110x32").split("x").map(Number);
const paneCount = Number(process.env.PIPELINE_PANES ?? 3);
const rounds = Number(process.env.PIPELINE_ROUNDS ?? 12);
const selected = new Set(
  (process.env.PIPELINE_WORKLOADS ?? "idle,keystroke,seq,buildlog,top,scroll,switch,divider,kitty")
    .split(",")
    .filter(Boolean),
);
const COLOR_BASE = 0xabc000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fleet = await createScratchFleet({ sessions: 1, windowsPerSession: 1, slug: "pipeline" });
const probeDir = join(fleet.root, "probe");
mkdirSync(probeDir);
const shortDir = mkdtempSync(join(tmpdir(), "pl-"));
const guiSocket = join(shortDir, "gui.sock");
process.env.PIPELINE_PROBE_DIR = probeDir;
process.env.PIPELINE_PROBE_CLI ??= join(repo, "bin", "cli.js");
const probeUrl = pathToFileURL(join(here, "probe.mjs")).href;

const tmuxEnv = { ...process.env, ...fleet.environment };
delete tmuxEnv.NODE_OPTIONS;
const tmux = (...args) =>
  execFileSync(fleet.environment.TMUX_IDE_TMUX_BIN, ["-S", fleet.socketPath, ...args], {
    encoding: "utf8",
    env: tmuxEnv,
  }).trim();

let daemon, launcher, connection;
let stderr = "";
const events = [];
const waiters = new Set();
const recv = { bytes: 0, lines: 0, parseMs: 0, maxLine: 0, marks: new Map() };
const results = { grid: `${fitCols}x${fitRows}`, panes: paneCount, workloads: {} };

const next = (predicate, label, timeout = 20000) =>
  new Promise((done, fail) => {
    const waiter = { predicate, done };
    waiters.add(waiter);
    setTimeout(() => {
      if (!waiters.delete(waiter)) return;
      fail(new Error(`Deadline: ${label}\n${stderr.slice(-3000)}`));
    }, timeout);
  });
let request = 0;
const send = (command) => connection.write(JSON.stringify(command) + "\n");
const latest = () => events.at(-1).value;

function onLine(line, at) {
  recv.bytes += line.length + 1;
  recv.lines++;
  recv.maxLine = Math.max(recv.maxLine, line.length);
  for (let i = line.indexOf('"value":1125'); i >= 0; i = line.indexOf('"value":1125', i + 1)) {
    const value = Number(line.slice(i + 8, i + 16));
    const id = value - COLOR_BASE;
    if (id >= 0 && id < 256 && !recv.marks.has(id)) recv.marks.set(id, { at, line: line.length });
  }
  const t = performance.now();
  const value = JSON.parse(line);
  recv.parseMs += performance.now() - t;
  if (line.length > 100000 && process.env.PIPELINE_DUMP && !value.kittyImageChunk)
    writeFileSync(process.env.PIPELINE_DUMP, line + "\n");
  if (recordFile && !value.kittyImageChunk) appendFileSync(recordFile, line + "\n");
  if (value.kittyImageChunk) kittyTimeline.push([Math.round(at), String(value.kittyImageChunk.digest).slice(0, 6), value.kittyImageChunk.offset ?? value.kittyImageChunk.index ?? null, line.length]);
  const event = { at, value, bytes: line.length };
  events.push(event);
  if (events.length > 64) events.shift();
  for (const waiter of [...waiters])
    if (waiter.predicate(value)) {
      waiters.delete(waiter);
      waiter.done(event);
    }
}

// ---- process sampling ------------------------------------------------------
const tmuxServerPid = () => Number(tmux("display-message", "-p", "#{pid}"));
function psTable() {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,time=,command="], { encoding: "utf8" });
  const table = new Map();
  for (const row of rows.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(row);
    if (!m) continue;
    const [mm, ss] = m[4].split(":");
    const cpuMs = (Number(mm) * 60 + Number(ss)) * 1000;
    table.set(Number(m[1]), { ppid: Number(m[2]), rss: Number(m[3]) * 1024, cpuMs, command: m[5] });
  }
  return table;
}
async function sample() {
  for (const name of readdirSync(probeDir)) {
    const pid = Number(/-(\d+)\.json$/.exec(name)?.[1]);
    if (pid) try { process.kill(pid, "SIGUSR2"); } catch {}
  }
  await sleep(80);
  const probes = [];
  for (const name of readdirSync(probeDir)) {
    if (!name.endsWith(".json")) continue;
    try {
      probes.push(JSON.parse(readFileSync(join(probeDir, name), "utf8")));
    } catch {}
  }
  const ps = psTable();
  const daemonPid = daemon?.record.pid;
  const native = [];
  const serverPid = tmuxServerPid();
  native.push({ role: "tmux-server", pid: serverPid, ...ps.get(serverPid) });
  for (const child of sshProcesses) {
    const row = ps.get(child.pid);
    if (row) native.push({ role: child.spawnfile === "ssh" ? "ssh-client" : "sshd", pid: child.pid, ...row });
    const frontier = [child.pid];
    while (frontier.length) {
      const parent = frontier.pop();
      for (const [pid, r] of ps)
        if (r.ppid === parent) {
          native.push({ role: "sshd-session", pid, ...r });
          frontier.push(pid);
        }
    }
  }
  for (const [pid, row] of ps)
    if (row.ppid === daemonPid && /tmux/.test(row.command) && / -C/.test(row.command))
      native.push({ role: "tmux-control-client", pid, ...row });
  for (const p of probes) {
    const row = ps.get(p.pid);
    p.alive = !!row;
    if (row) p.rss = row.rss;
  }
  return { probes, native, at: performance.now() };
}
const SUM = [
  "stdoutBytes", "stdoutLines", "stdinBytes", "tmuxControlBytes", "tmuxOutputLines",
  "netRead", "netWritten", "stringifyMs", "stringifyBytes", "stringifyCalls", "parseMs",
  "parseBytes", "parseCalls", "gcMs", "controlPauses", "controlPausedMs", "cpuUserMs", "cpuSystemMs",
];
function diff(before, after) {
  const roles = {};
  const prior = new Map(before.probes.map((p) => [p.pid, p]));
  for (const p of after.probes) {
    const b = prior.get(p.pid);
    const r = (roles[p.role] ??= { processes: 0, alive: 0, rss: 0 });
    r.processes++;
    if (p.alive) {
      r.alive++;
      r.rss += p.rss;
    }
    for (const key of SUM) r[key] = (r[key] ?? 0) + (p[key] - (b?.[key] ?? 0));
    r.cpuMs = (r.cpuMs ?? 0) + (p.cpuUserMs + p.cpuSystemMs - ((b?.cpuUserMs ?? 0) + (b?.cpuSystemMs ?? 0)));
  }
  const priorNative = new Map(before.native.map((p) => [p.pid, p]));
  for (const p of after.native) {
    const r = (roles[p.role] ??= { processes: 0, alive: 0, rss: 0, cpuMs: 0 });
    r.processes++;
    r.alive++;
    r.rss += p.rss ?? 0;
    r.cpuMs += (p.cpuMs ?? 0) - (priorNative.get(p.pid)?.cpuMs ?? 0);
  }
  for (const r of Object.values(roles))
    for (const k of Object.keys(r)) if (typeof r[k] === "number") r[k] = Math.round(r[k] * 10) / 10;
  return roles;
}
function marksOf(snapshot) {
  const out = {};
  for (const p of snapshot.probes)
    for (const [where, ids] of Object.entries(p.marks ?? {})) {
      const key = `${p.role}.${where}`;
      for (const [id, t] of Object.entries(ids)) {
        const bucket = (out[key] ??= {});
        bucket[id] = Math.min(bucket[id] ?? Infinity, t);
      }
    }
  return out;
}
let recordFile = null;
const kittyTimeline = [];
async function measure(name, body) {
  if (!selected.has(name)) return;
  recordFile = process.env.PIPELINE_RECORD ? join(process.env.PIPELINE_RECORD, `${name}.jsonl`) : null;
  await sleep(400);
  const before = await sample();
  const recvBefore = { ...recv };
  const started = performance.now();
  const extra = (await body()) ?? {};
  const elapsedMs = performance.now() - started;
  await sleep(300);
  const after = await sample();
  results.workloads[name] = {
    elapsedMs: Math.round(elapsedMs),
    gui: {
      bytes: recv.bytes - recvBefore.bytes,
      lines: recv.lines - recvBefore.lines,
      nodeParseMs: Math.round((recv.parseMs - recvBefore.parseMs) * 10) / 10,
      maxLine: recv.maxLine,
    },
    roles: diff(before, after),
    ...extra,
  };
  recv.maxLine = 0;
  recordFile = null;
  results.workloads[name].stringifyByKind = Object.fromEntries(
    after.probes.map((p) => [p.role, Object.entries(p.stringifyByKind ?? {}).map(([k, v]) => {
      const b = before.probes.find((q) => q.pid === p.pid)?.stringifyByKind?.[k];
      return [k, v.calls - (b?.calls ?? 0), Math.round((v.bytes - (b?.bytes ?? 0)) / 1e3)];
    }).filter((x) => x[1] > 0).sort((a, b) => b[2] - a[2]).slice(0, 8)]),
  );
  results.workloads[name].deliveries = Object.fromEntries(
    after.probes.filter((p) => p.role === "live").flatMap((p) => Object.entries(p.deliveries ?? {}).map(([k, v]) => {
      const b = before.probes.find((q) => q.pid === p.pid)?.deliveries?.[k];
      return [`${p.pid}:${k}`, { count: v.count - (b?.count ?? 0), kB: Math.round((v.bytes - (b?.bytes ?? 0)) / 1e3), maxKB: Math.round(v.maxBytes / 1e3) }];
    })).filter(([, v]) => v.count > 0),
  );
  process.stderr.write(`[pipeline] ${name} done in ${Math.round(elapsedMs)} ms\n`);
}
const stats = (values) => {
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const r = (v) => Math.round(v * 10) / 10;
  return { n: sorted.length, min: r(sorted[0]), p50: r(pick(0.5)), p90: r(pick(0.9)), max: r(sorted.at(-1)) };
};


// ---- optional SSH route: a user-level sshd on a scratch port and an ssh -L
// tunnel to the daemon, so the daemon->bridge hop crosses a real SSH channel.
const sshProcesses = [];
async function startSshTunnel(daemonPort) {
  const dir = join(shortDir, "ssh");
  mkdirSync(dir);
  const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" });
  sh("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(dir, "host")]);
  sh("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(dir, "user")]);
  writeFileSync(join(dir, "authorized_keys"), readFileSync(join(dir, "user.pub")), { mode: 0o600 });
  const port = 22000 + Math.floor(Math.random() * 2000);
  const local = port + 3000;
  writeFileSync(
    join(dir, "sshd_config"),
    [
      `Port ${port}`, "ListenAddress 127.0.0.1", `HostKey ${join(dir, "host")}`,
      `AuthorizedKeysFile ${join(dir, "authorized_keys")}`, "PasswordAuthentication no",
      "KbdInteractiveAuthentication no", "UsePAM no", "StrictModes no", `PidFile ${join(dir, "sshd.pid")}`,
      "AllowTcpForwarding yes", "Compression no",
    ].join("\n") + "\n",
  );
  const sshd = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", join(dir, "sshd_config")], { stdio: ["ignore", "ignore", "pipe"] });
  sshd.stderr.on("data", (b) => (stderr = (stderr + "[sshd] " + b.toString()).slice(-20000)));
  sshProcesses.push(sshd);
  await sleep(500);
  const ssh = spawn("ssh", [
    "-N", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
    "-o", "ExitOnForwardFailure=yes", "-o", "Compression=" + (process.env.PIPELINE_SSH_COMPRESSION ? "yes" : "no"),
    "-i", join(dir, "user"), "-p", String(port), "-L", `${local}:127.0.0.1:${daemonPort}`, "127.0.0.1",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  ssh.stderr.on("data", (b) => (stderr = (stderr + "[ssh] " + b.toString()).slice(-20000)));
  sshProcesses.push(ssh);
  for (let n = 0; n < 50; n++) {
    await sleep(100);
    try {
      const r = await fetch(`http://127.0.0.1:${local}/api/sessions`);
      if (r.status) break;
    } catch {}
  }
  return `http://127.0.0.1:${local}/`;
}

// ---- workload helpers --------------------------------------------------------
let markId = 0;
const markCommand = (id) =>
  `printf '\\033[38;2;171;192;%dmMK%dK\\033[0m%.0s\\n' ${id} ${id} '#IN${id}'\r`;
let selectedPane;
const typeText = (data) => send({ type: "input", request, id: selectedPane, input: { kind: "text", data } });
async function runAndMark(command, timeout = 120000) {
  const id = ++markId;
  const started = performance.now();
  typeText(`${command}; ${markCommand(id).trimEnd()}\r`);
  const end = started + timeout;
  while (!recv.marks.has(id)) {
    if (performance.now() > end) throw new Error(`mark ${id} for ${command} not seen\n${stderr.slice(-2000)}`);
    await sleep(5);
  }
  const marks = marksOf(await sample());
  const rel = (key) => (marks[key]?.[id] === undefined ? null : Math.round(marks[key][id] - performance.timeOrigin - started));
  return {
    id,
    totalMs: Math.round(recv.marks.get(id).at - started),
    markSeenMs: { daemonTmux: rel("daemon.tmuxOutput"), daemonSend: rel("daemon.netOut"), liveIn: rel("live.netIn"), liveOut: rel("live.stdout"), browserOut: rel("browser.stdout"), gui: rel("fake-gui.stdin") },
  };
}

try {
  const first = tmux("display-message", "-p", "-t", fleet.sessionNames[0], "#{pane_id}");
  if (paneCount >= 2) tmux("split-window", "-h", "-t", first, "sh -i");
  if (paneCount >= 3) tmux("split-window", "-v", "-t", first, "sh -i");
  for (let n = 3; n < paneCount; n++) tmux("split-window", "-t", first, "sh -i");
  for (let n = 0; n < 40; n++) tmux("send-keys", "-t", first, "-l", `echo line-${n}\n`);

  daemon = await startDaemon(fleet, { cliPath: join(here, "daemon-entry.mjs") });
  const options = {
    baseUrl: daemon.baseUrl + "/",
    ownerToken: daemon.record.authToken,
    hostClientId: "pipeline-bench",
    origin: "tmux-ide://app",
  };
  const { servers } = await listTmuxServers(options);
  const server = servers.find((s) => s.state === "online");
  const config = join(fleet.root, "host.json");
  let bridgeBaseUrl = options.baseUrl;
  if (process.env.PIPELINE_SSH) bridgeBaseUrl = await startSshTunnel(daemon.record.port);
  results.transport = process.env.PIPELINE_SSH ? "ssh-localhost-tunnel" : "local";
  writeFileSync(
    config,
    JSON.stringify({
      baseUrl: bridgeBaseUrl,
      ownerToken: options.ownerToken,
      scope: { serverId: server.serverId, generation: server.generation },
    }),
    { mode: 0o600 },
  );

  const guiServer = createServer();
  guiServer.listen(guiSocket);
  await once(guiServer, "listening");
  const accepted = once(guiServer, "connection");
  launcher = spawn(
    process.execPath,
    [join(bundleDir, "preview-launcher.bundle.mjs"), join(here, "fake-gui.mjs"), config, "--browse"],
    {
      stdio: ["ignore", "inherit", "pipe"],
      env: { ...tmuxEnv, NODE_OPTIONS: `--import ${probeUrl}`, FAKE_GUI_SOCKET: guiSocket },
    },
  );
  launcher.stderr.on("data", (b) => (stderr = (stderr + b.toString()).slice(-20000)));
  [connection] = await accepted;
  let buffer = "";
  connection.setEncoding("utf8");
  connection.on("data", (chunk) => {
    const at = performance.now();
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      onLine(line, at);
    }
  });

  const sessions = (await next((e) => e.sessions?.length === 1, "catalog")).value.sessions;
  send({ type: "session", request: ++request, id: sessions[0].id });
  const panes = (await next((e) => e.request === request && e.panes?.length === paneCount, "panes")).value.panes.map(
    (p) => p.id,
  );
  const ready = (target) => (e) =>
    e.request === request && e.selectedPane === target && e.snapshot && e.inputReady;
  send({ type: "pane", request: ++request, id: panes[0] });
  await next(ready(panes[0]), "initial pane");
  selectedPane = panes[0];
  const fit = async () => {
    send({ type: "input", request, id: selectedPane, input: { kind: "resize", data: { cols: fitCols, rows: fitRows } } });
    await next(
      (e) => e.request === request && e.snapshot?.cols === fitCols && e.snapshot?.rows === fitRows && e.inputReady,
      "fit",
    );
  };
  await fit();
  await sleep(1000);

  // One representative publication, broken down by field.
  {
    const e = latest();
    const field = (v) => (v === undefined ? 0 : JSON.stringify(v).length);
    const snap = e.snapshot;
    const cells = (rows) => rows?.reduce((n, r) => n + r.cells.length, 0) ?? 0;
    results.publicationAnatomy = {
      totalBytes: events.at(-1).bytes,
      snapshotBytes: field(snap),
      gridBytes: field(snap?.grid),
      historyBytes: field(snap?.history),
      gridCells: cells(snap?.grid),
      historyRows: snap?.history?.length ?? 0,
      historyCells: cells(snap?.history),
      bytesPerGridCell: Math.round((field(snap?.grid) / Math.max(1, cells(snap?.grid))) * 10) / 10,
      otherFields: Object.fromEntries(
        Object.keys(e)
          .filter((k) => k !== "snapshot")
          .map((k) => [k, field(e[k])])
          .filter(([, n]) => n > 200),
      ),
    };
  }

  await measure("idle", async () => {
    await sleep(Number(process.env.PIPELINE_IDLE_MS ?? 10000));
  });

  await measure("keystroke", async () => {
    const ids = [];
    for (let n = 0; n < rounds * 2; n++) {
      const id = ++markId;
      ids.push({ id, sent: performance.timeOrigin + performance.now() });
      typeText(markCommand(id));
      const end = performance.now() + 10000;
      while (!recv.marks.has(id)) {
        if (performance.now() > end) throw new Error(`keystroke mark ${id} not seen`);
        await sleep(2);
      }
      await sleep(60);
    }
    await sleep(300);
    const marks = marksOf(await sample());
    const hops = {};
    const order = [
      "browser.stdin", "live.stdin", "daemon.tmuxWrite", "daemon.tmuxEcho", "daemon.tmuxOutput",
      "daemon.netOut", "live.netIn", "live.stdout", "browser.stdout", "fake-gui.stdin",
    ];
    for (const { id, sent } of ids) {
      let prev = sent;
      for (const key of order) {
        const t = marks[key]?.[id];
        if (t === undefined) continue;
        (hops[key] ??= []).push(t - prev);
        prev = t;
      }
      (hops["gui.received"] ??= []).push(performance.timeOrigin + recv.marks.get(id).at - prev);
      (hops.total ??= []).push(performance.timeOrigin + recv.marks.get(id).at - sent);
    }
    return { hopMs: Object.fromEntries(Object.entries(hops).map(([k, v]) => [k, stats(v)])) };
  });

  const scripts = join(here, "workloads.py");
  await measure("seq", async () => {
    tmux("clear-history", "-t", first);
    const r = await runAndMark("seq 1 300000");
    return { paneBytes: 1_988_895, ...r };
  });
  await measure("buildlog", async () => runAndMark(`/usr/bin/python3 ${scripts} buildlog 30000`));
  await measure("top", async () => runAndMark(`/usr/bin/python3 ${scripts} top 8 10`));
  await measure("scroll", async () => runAndMark(`/usr/bin/python3 ${scripts} scroll 8 30`));

  await measure("switch", async () => {
    const switchFrame = [];
    const switchReady = [];
    for (let n = 1; n <= rounds; n++) {
      const target = panes[n % panes.length];
      const started = performance.now();
      send({ type: "pane", request: ++request, id: target });
      const frame = await next((e) => e.request === request && e.selectedPane === target && e.snapshot, "switch frame");
      const input = frame.value.inputReady ? frame : await next(ready(target), "switch input");
      switchFrame.push(frame.at - started);
      switchReady.push(input.at - started);
      await sleep(30);
    }
    send({ type: "pane", request: ++request, id: panes[0] });
    await next(ready(panes[0]), "back");
    selectedPane = panes[0];
    return { toFrameMs: stats(switchFrame), toInputMs: stats(switchReady) };
  });

  await measure("divider", async () => {
    const regionOf = (e, id) => e.regions.find((r) => r.id === id);
    const leftPane = latest().regions.reduce((a, b) => (b.left < a.left ? b : a)).id;
    send({ type: "pane", request: ++request, id: leftPane });
    await next(ready(leftPane), "divider pane");
    selectedPane = leftPane;
    await fit();
    const tokenReady = (e) => e.request === request && e.resizeToken && e.resizeGestureSupported;
    if (!tokenReady(latest())) await next(tokenReady, "token");
    const start = latest();
    const width = regionOf(start, leftPane).width;
    const gesture = randomUUID();
    const base = { type: "resize-gesture", request, gesture, id: leftPane, axis: "cols" };
    send({ ...base, phase: "begin", token: start.resizeToken, cells: width });
    await next((e) => e.resizeGesture?.gesture === gesture, "gesture begin");
    const steps = [];
    const perStep = [];
    let cells = width;
    for (let n = 0; n < rounds; n++) {
      cells += n % 2 ? -3 : 4;
      const lines = recv.lines;
      const bytes = recv.bytes;
      const started = performance.now();
      send({ ...base, phase: "move", cells });
      const shown = await next(
        (e) => regionOf(e, leftPane)?.width === cells && e.resizeGesture?.gesture === gesture,
        "divider step",
      );
      steps.push(shown.at - started);
      await sleep(150);
      perStep.push({ lines: recv.lines - lines, bytes: recv.bytes - bytes });
    }
    const dragLines = recv.lines;
    const dragBytes = recv.bytes;
    const dragStarted = performance.now();
    const N = 30;
    for (let n = 0; n < N; n++) {
      send({ ...base, phase: "move", cells: cells + 1 + (n % 15) });
      await sleep(16);
    }
    const final = cells + 1 + ((N - 1) % 15);
    send({ ...base, phase: "release", cells: final });
    const settled = await next(
      (e) =>
        e.resizeGesture?.gesture === gesture &&
        e.resizeGesture.phase === "settled" &&
        regionOf(e, leftPane)?.width === final,
      "drag settle",
      60000,
    );
    return {
      stepMs: stats(steps),
      publicationsPerStep: stats(perStep.map((s) => s.lines)),
      bytesPerStep: stats(perStep.map((s) => s.bytes)),
      drag: {
        moves: N,
        settledMs: Math.round(settled.at - dragStarted),
        publications: recv.lines - dragLines,
        bytes: recv.bytes - dragBytes,
      },
    };
  });

  if (selected.has("kitty")) {
    const dir = join(fleet.root, "frames");
    mkdirSync(dir);
    const count = Number(process.env.PIPELINE_KITTY_FRAMES ?? 30);
    const [w, h] = (process.env.PIPELINE_KITTY_SIZE ?? "1920x1080").split("x").map(Number);
    const frameInfo = writeFrames(dir, { count, width: w, height: h });
    await measure("kitty", async () => {
      typeText("clear\r");
      await sleep(500);
      const r = await runAndMark(`/usr/bin/python3 ${scripts} play ${dir} 10`, 240000);
      return { timeline: kittyTimeline.map(([t, ...rest]) => [t - Math.round(kittyTimeline[0]?.[0] ?? 0), ...rest]), frames: count, size: `${w}x${h}`, pngBytesPerFrame: Math.round(frameInfo.pngBytes), paneBytesPerFrame: Math.round(frameInfo.sequenceBytes), ...r };
    });
  }

  const final = await sample();
  results.processes = final.probes
    .filter((p) => p.alive)
    .map((p) => ({ role: p.role, pid: p.pid, rssMB: Math.round(p.rss / 1e5) / 10, maxRssMB: Math.round(p.maxRss / 1e5) / 10 }))
    .concat(final.native.map((p) => ({ role: p.role, pid: p.pid, rssMB: Math.round((p.rss ?? 0) / 1e5) / 10 })));
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  if (launcher && launcher.exitCode === null) {
    const done = once(launcher, "close");
    launcher.kill("SIGTERM");
    await Promise.race([done, sleep(5000)]);
    if (launcher.exitCode === null) launcher.kill("SIGKILL");
  }
  for (const child of sshProcesses) if (child.exitCode === null) child.kill("SIGTERM");
  if (daemon) await daemon.stop();
  if (process.env.PIPELINE_KEEP_PROBES) execFileSync("cp", ["-R", probeDir, process.env.PIPELINE_KEEP_PROBES]);
  await fleet.dispose();
  rmSync(shortDir, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
