// Opt-in per-process pipeline probe. Loaded with `--import` (bridge helpers) or
// from daemon-entry.mjs (daemon). Inert unless PIPELINE_PROBE_DIR is set.
//
// Counts, per process: stdout/stdin bytes and lines, tmux control-mode bytes and
// %output lines, TCP bytes read/written, large JSON.stringify/JSON.parse time and
// bytes, CPU, RSS and GC pause time. Writes one JSON file per pid every second and on SIGUSR2.
import childProcess from "node:child_process";
import diagnostics from "node:diagnostics_channel";
import { writeFileSync, renameSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
import { PerformanceObserver, performance } from "node:perf_hooks";

const dir = process.env.PIPELINE_PROBE_DIR;
if (dir) {
  const script = basename(process.argv[1] ?? "node");
  const role = process.env.PIPELINE_PROBE_ROLE ?? (/^(cli\.|daemon-entry)/.test(script) ? "daemon" : script.replace(/\.(bundle\.mjs|ts|mjs|js)$/, ""));
  const LARGE = 4096;
  const s = {
    role, pid: process.pid, ppid: process.ppid, argv: process.argv.slice(2, 4),
    stdoutBytes: 0, stdoutLines: 0, stdinBytes: 0,
    tmuxControlBytes: 0, tmuxOutputLines: 0, tmuxControlProcesses: 0,
    childStdoutBytes: 0,
    netRead: 0, netWritten: 0, sockets: 0,
    stringifyMs: 0, stringifyBytes: 0, stringifyCalls: 0,
    parseMs: 0, parseBytes: 0, parseCalls: 0,
    stringifyByKind: {},
    deliveries: {},
    controlPauses: 0,
    controlPausedMs: 0,
    gcMs: 0, cpuUserMs: 0, cpuSystemMs: 0, rss: 0, heapUsed: 0, maxRss: 0, at: 0,
  };
  // Latency marks: the harness types `printf ... #IN<n>` and the pane prints
  // MK<n>K in RGB colour 0xABC000+n, so the same id is visible as text in tmux
  // control output and as a colour value in compact and verbose snapshot JSON.
  s.marks = {};
  const COLOR_BASE = 0xabc000;
  const mark = (where, id) => {
    const bucket = (s.marks[where] ??= {});
    if (bucket[id] === undefined) bucket[id] = performance.timeOrigin + performance.now();
  };
  const scanText = (where, text, prefix, end) => {
    for (let i = text.indexOf(prefix); i >= 0; i = text.indexOf(prefix, i + 1)) {
      const m = end.exec(text.slice(i + prefix.length, i + prefix.length + 12));
      if (m) mark(where, Number(m[1]));
    }
  };
  const scanColor = (where, text) => {
    for (let i = text.indexOf("11256"); i >= 0; i = text.indexOf("11256", i + 1)) {
      const value = Number(text.slice(i, i + 8));
      if (value >= COLOR_BASE && value < COLOR_BASE + 256 && !/\d/.test(text[i + 8] ?? "")) mark(where, value - COLOR_BASE);
    }
    for (let i = text.indexOf("11255"); i >= 0; i = text.indexOf("11255", i + 1)) {
      const value = Number(text.slice(i, i + 8));
      if (value >= COLOR_BASE && value < COLOR_BASE + 256 && !/\d/.test(text[i + 8] ?? "")) mark(where, value - COLOR_BASE);
    }
  };
  const asText = (chunk) => (typeof chunk === "string" ? chunk : chunk ? Buffer.from(chunk.buffer ?? chunk, chunk.byteOffset, chunk.length).toString("latin1") : "");
  const live = new Set();
  let closedRead = 0, closedWritten = 0;
  const track = (socket) => {
    s.sockets++;
    live.add(socket);
    // Hook below the stream API: the HTTP parser reads the handle directly until
    // upgrade, and ws corks frames into _writev.
    if (role === "live" || role === "browser") {
      const push = socket.push;
      socket.push = function (chunk, ...rest) {
        if (chunk) scanColor("netIn", asText(chunk));
        return push.call(this, chunk, ...rest);
      };
    }
    if (role === "daemon") {
      const write = socket._write;
      const writev = socket._writev;
      socket._write = function (chunk, ...rest) {
        if (chunk && chunk.length > 8) scanColor("netOut", asText(chunk));
        return write.call(this, chunk, ...rest);
      };
      if (writev)
        socket._writev = function (chunks, ...rest) {
          for (const { chunk } of chunks) if (chunk && chunk.length > 8) scanColor("netOut", asText(chunk));
          return writev.call(this, chunks, ...rest);
        };
    }
  };
  diagnostics.subscribe("net.client.socket", ({ socket }) => track(socket));
  diagnostics.subscribe("net.server.socket", ({ socket }) => track(socket));

  const { stringify, parse } = JSON;
  // Event log of graphics frames (PIPELINE_PROBE_EVENTS=1), to place waits on a timeline.
  const logEvents = !!process.env.PIPELINE_PROBE_EVENTS;
  s.events = [];
  const logEvent = (op, value) => {
    if (!logEvents || s.events.length > 4000 || !value || typeof value !== "object") return;
    const type = value.type;
    if (type !== "terminal-graphics" && type !== "terminal-graphics-request" && type !== "terminal-graphics-blob") return;
    const extra = type === "terminal-graphics" ? (value.state?.images ?? []).map((i) => String(i.digest).slice(0, 6)).join(",")
      : type === "terminal-graphics-request" ? (value.digests ?? []).map((d) => String(d).slice(0, 6)).join(",")
      : `${String(value.blob?.digest).slice(0, 6)}@${value.blob?.offset}`;
    s.events.push([Math.round(performance.timeOrigin + performance.now()), op, type, extra]);
  };
  JSON.stringify = function (...args) {
    const t = performance.now();
    const out = stringify.apply(this, args);
    logEvent("send", args[0]);
    if (typeof out === "string" && out.length >= LARGE) {
      s.stringifyMs += performance.now() - t;
      s.stringifyBytes += out.length;
      s.stringifyCalls++;
      // By message type: which frames dominate the bytes this process serializes.
      const kind = /"(?:type|frame|kind)":"([^"]{1,40})"/.exec(out.slice(0, 300))?.[1] ?? /^\[?\{?"?([A-Za-z]{1,30})/.exec(out)?.[1] ?? "other";
      const h = (s.stringifyByKind[kind] ??= { calls: 0, bytes: 0 });
      h.calls++;
      h.bytes += out.length;
    }
    return out;
  };
  JSON.parse = function (text, reviver) {
    const t = performance.now();
    const out = parse.call(this, text, reviver);
    logEvent("recv", out);
    if (out?.type === "terminal-delivery-envelope" && out.envelope) {
      const e = out.envelope;
      const key = `${e.frame}/${e.encoding}/${e.history}`;
      const d = (s.deliveries[key] ??= { count: 0, bytes: 0, maxBytes: 0 });
      d.count++;
      d.bytes += e.representationBytes;
      d.maxBytes = Math.max(d.maxBytes, e.representationBytes);
    }
    if (typeof text === "string" && text.length >= LARGE) {
      s.parseMs += performance.now() - t;
      s.parseBytes += text.length;
      s.parseCalls++;
    }
    return out;
  };

  const countLines = (chunk) => {
    let n = 0;
    if (typeof chunk === "string") { for (let i = chunk.indexOf("\n"); i >= 0; i = chunk.indexOf("\n", i + 1)) n++; }
    else if (chunk) { for (let i = chunk.indexOf(10); i >= 0; i = chunk.indexOf(10, i + 1)) n++; }
    return n;
  };
  const size = (chunk) => (typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk?.length ?? 0);
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    s.stdoutBytes += size(chunk);
    s.stdoutLines += countLines(chunk);
    scanColor("stdout", asText(chunk));
    return write(chunk, ...rest);
  };
  if (role === "browser" || role === "live" || role === "fake-gui") {
    const stdin = process.stdin;
    const push = stdin.push;
    stdin.push = function (chunk, ...rest) {
      if (chunk) {
        s.stdinBytes += size(chunk);
        { const text = asText(chunk); scanText("stdin", text, "#IN", /^(\d+)/); if (role === "fake-gui") scanColor("stdin", text); }
      }
      return push.call(this, chunk, ...rest);
    };
  }

  const spawn = childProcess.spawn;
  const OUTPUT = Buffer.from("%output ");
  const EXT = Buffer.from("%extended-output ");
  childProcess.spawn = function (command, args, options) {
    const child = spawn.call(this, command, args, options);
    const control = Array.isArray(args) && args.includes("-C") && /tmux/.test(String(command));
    if (control) {
      s.tmuxControlProcesses++;
      // Read-side flow control: how long the daemon leaves tmux output unread.
      const out = child.stdout;
      const pause = out.pause, resume = out.resume;
      let pausedAt = null;
      out.pause = function () {
        if (pausedAt === null && this.readableFlowing !== false) { pausedAt = performance.now(); s.controlPauses++; }
        return pause.call(this);
      };
      out.resume = function () {
        if (pausedAt !== null) { s.controlPausedMs += performance.now() - pausedAt; pausedAt = null; }
        return resume.call(this);
      };
      const write = child.stdin.write;
      child.stdin.write = function (chunk, ...rest) {
        const text = asText(chunk);
        scanText("tmuxWrite", text, "#IN", /^(\d+)/);
        // send-keys may carry the text as hex; "23 49 4e" is "#IN".
        return write.call(this, chunk, ...rest);
      };
    }
    child.stdout?.prependListener("data", (b) => {
      if (!control) { s.childStdoutBytes += b.length; return; }
      s.tmuxControlBytes += b.length;
      const text = b.toString("latin1");
      scanText("tmuxEcho", text, "#IN", /^(\d+)/);
      scanText("tmuxOutput", text, "MK", /^(\d+)K/);
      for (let i = b.indexOf(OUTPUT); i >= 0; i = b.indexOf(OUTPUT, i + 8)) s.tmuxOutputLines++;
      for (let i = b.indexOf(EXT); i >= 0; i = b.indexOf(EXT, i + 8)) s.tmuxOutputLines++;
    });
    return child;
  };
  syncBuiltinESMExports();

  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) s.gcMs += entry.duration;
  }).observe({ entryTypes: ["gc"] });

  const file = join(dir, `${role}-${process.pid}.json`);
  const flush = () => {
    const cpu = process.cpuUsage();
    const mem = process.memoryUsage();
    s.cpuUserMs = cpu.user / 1000;
    s.cpuSystemMs = cpu.system / 1000;
    s.rss = mem.rss;
    s.heapUsed = mem.heapUsed;
    s.maxRss = process.resourceUsage().maxRSS * 1024;
    let r = closedRead, w = closedWritten;
    for (const socket of live) { r += socket.bytesRead; w += socket.bytesWritten; }
    s.netRead = r;
    s.netWritten = w;
    s.at = performance.timeOrigin + performance.now();
    try {
      writeFileSync(file + ".tmp", stringify(s));
      renameSync(file + ".tmp", file);
    } catch {}
  };
  setInterval(flush, Number(process.env.PIPELINE_PROBE_INTERVAL_MS ?? 1000)).unref();
  process.on("SIGUSR2", flush);

  // PIPELINE_PROBE_PROFILE=1: CPU profile per sampling window. Each SIGUSR2 ends
  // the current window (writing <role>-<pid>-<n>.cpuprofile) and starts the next.
  if (process.env.PIPELINE_PROBE_PROFILE) {
    const { Session } = await import("node:inspector");
    const session = new Session();
    session.connect();
    const post = (method, params) =>
      new Promise((done, fail) => session.post(method, params, (e, r) => (e ? fail(e) : done(r))));
    await post("Profiler.enable");
    await post("Profiler.setSamplingInterval", { interval: 200 });
    await post("Profiler.start");
    let windowIndex = 0;
    process.on("SIGUSR2", async () => {
      try {
        const { profile } = await post("Profiler.stop");
        writeFileSync(join(dir, `${role}-${process.pid}-${windowIndex++}.cpuprofile`), stringify(profile));
        await post("Profiler.start");
      } catch {}
    });
  }
  process.on("exit", flush);
}
