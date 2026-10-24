import { catalogObservation, nativeCatalogObservation } from "./native-gui-catalog-observation.mjs";
// Owned GUI qualification only. Run with Node 24 --import tsx; never rebuilds.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWriteStream, appendFileSync } from "node:fs";
import { mkdtemp, writeFile, appendFile, access, mkdir } from "node:fs/promises";
import { isAbsolute, join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
process.umask(0o077);
const args = process.argv.slice(2),
  options = {};
for (let i = 0; i < args.length; i += 2) {
  if (
    ![
      "--repo",
      "--tmux",
      "--cli",
      "--binary",
      "--artifacts",
      "--seconds",
      "--ssh",
      "--graphics",
      "--alternate",
      "--cursor-pulse",
      "--split-axis",
    ].includes(args[i]) ||
    !args[i + 1] ||
    options[args[i]]
  )
    throw Error("Invalid arguments");
  options[args[i]] = args[i + 1];
}
for (const key of ["--repo", "--cli", "--binary", "--tmux"]) {
  if (!isAbsolute(options[key] ?? "")) throw Error(`Explicit absolute ${key} required`);
  await access(options[key]);
}
if (options["--ssh"] !== undefined && options["--ssh"] !== "1") throw Error("--ssh requires 1");
if (options["--graphics"] !== undefined && options["--graphics"] !== "1")
  throw Error("--graphics requires 1");
if (options["--alternate"] !== undefined && options["--alternate"] !== "1")
  throw Error("--alternate requires 1");
if (options["--cursor-pulse"] !== undefined && options["--cursor-pulse"] !== "1")
  throw Error("--cursor-pulse requires 1");
const seconds = Number(options["--seconds"] ?? 600);
const splitAxis = options["--split-axis"] ?? "columns";
if (!["columns", "rows"].includes(splitAxis)) throw Error("--split-axis requires columns|rows");
if (!Number.isInteger(seconds) || seconds < 10 || seconds > 1800)
  throw Error("Duration must be 10..1800 seconds");
const repo = options["--repo"];
const artifacts = options["--artifacts"] ?? (await mkdtemp("/tmp/tmux-gui-evidence-"));
if (!isAbsolute(artifacts)) throw Error("Absolute artifacts path required");
await mkdir(artifacts, { recursive: true, mode: 0o700 });
const load = (file) => import(pathToFileURL(join(repo, file)).href);
const { createScratchFleet } = await load("scripts/lib/product-fixtures/scratch-fleet.ts");
const { startDaemon } = await load("scripts/lib/product-fixtures/daemon.ts");
const { stopFixtureChild } = await load("apps/tmux-gpui/bridge/fixture-child.mjs");
const { listTmuxServers } = await load("packages/daemon-client/src/tmux-server-client.ts");
// Delete inherited personal daemon selectors before fixture creation.
for (const key of Object.keys(process.env))
  if (
    key.startsWith("TMUX_IDE_") ||
    key === "TMUX" ||
    key === "TMUX_PANE" ||
    key === "TMUX_TMPDIR" ||
    key === "NODE_OPTIONS" ||
    key === "NODE_PATH"
  )
    delete process.env[key];
process.env.PATH = `${dirname(options["--tmux"])}:${process.env.PATH ?? ""}`;
const receiver = join(artifacts, "receiver.cjs");
await writeFile(
  receiver,
  `const fs=require('node:fs');const path=require('node:path');
const pane=process.env.TMUX_PANE.replace(/[^a-zA-Z0-9]/g,'');
const file=path.join(process.argv[2], 'input-'+pane+'.jsonl');
process.stdin.setRawMode(true);process.stdin.resume();
for(let n=0;n<350;n++)process.stdout.write('GUI HISTORY '+pane+' '+String(n).padStart(4,'0')+' abcdefghijklmnopqrstuvwxyz\\r\\n');
${options["--graphics"] === "1" ? "const image=Buffer.alloc(32*16*4);for(let n=0;n<image.length;n+=4){image[n]=240;image[n+1]=120;image[n+2]=30;image[n+3]=255;}process.stdout.write(String.fromCharCode(27)+'_Ga=T,f=32,s=32,v=16,i=91,c=8,r=3,q=2;'+image.toString('base64')+String.fromCharCode(27)+'\\\\'+'\\r\\n\\r\\n\\r\\n');" : ""}
${options["--alternate"] === "1" ? "process.stdout.write(String.fromCharCode(27)+'[?1049hALTERNATE SCREEN — Ctrl+] returns to normal history\\r\\n');" : ""}
process.stdout.write('Link check: https://example.com/\\r\\n');
process.stdout.write('READY '+pane+' — type unique markers; Ctrl bytes are captured, not executed\\r\\n');
${options["--cursor-pulse"] === "1" ? "let shown=true;setInterval(()=>{shown=!shown;process.stdout.write(String.fromCharCode(27)+'[?25'+(shown?'h':'l'));},250);" : ""}
process.stdin.on('data',data=>{fs.appendFileSync(file,JSON.stringify({time:Date.now(),pane,hex:data.toString('hex')})+'\\n');${options["--alternate"] === "1" ? "if(data.includes(29)){process.stdout.write(String.fromCharCode(27)+'[?1049lNORMAL SCREEN — history available\\r\\n');return;}" : ""}process.stdout.write(data);});
`,
  { mode: 0o600 },
);
let fleet,
  daemon,
  browser,
  native,
  timer,
  deadline,
  busy = false,
  sampling,
  ssh;
const run = promisify(execFile);
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
let stop;
const stopped = new Promise((resolve) => {
  stop = resolve;
});
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  fleet = await createScratchFleet({
    sessions: 1,
    slug: "native-gui",
    windowsPerSession: 1,
    initialPaneCommand: { executable: process.execPath, args: [receiver, artifacts] },
  });
  if (fleet.environment.TMUX_IDE_TMUX_BIN !== options["--tmux"])
    throw Error("Scratch fleet did not select the explicitly requested tmux binary");
  const env = { ...process.env, ...fleet.environment };
  const tmux = (...argv) =>
    run(fleet.environment.TMUX_IDE_TMUX_BIN, ["-S", fleet.socketPath, ...argv], {
      env,
      cwd: fleet.root,
      timeout: 3000,
      maxBuffer: 1024 * 1024,
    });
  await tmux(
    "split-window",
    splitAxis === "rows" ? "-v" : "-h",
    "-t",
    fleet.initialPanes[0].paneId,
    [process.execPath, receiver, artifacts].map(quote).join(" "),
  );
  daemon = await startDaemon(fleet, { cliPath: options["--cli"] });
  const { servers } = await listTmuxServers({
    baseUrl: daemon.baseUrl + "/",
    ownerToken: daemon.record.authToken,
    hostClientId: "gpui-fixture",
    origin: "tmux-ide://app",
  });
  const online = servers.filter((s) => s.state === "online");
  if (online.length !== 1) throw Error("Expected one owned tmux server");
  if (options["--ssh"] === "1") {
    const { createNativeGuiSsh } = await import("./native-gui-ssh-fixture.mjs");
    ssh = await createNativeGuiSsh({ repo, fleet, daemon, env });
  }
  const browserEnv = ssh?.environment ?? env;
  const config = join(fleet.root, "host.json");
  await writeFile(
    config,
    JSON.stringify(
      ssh?.host ?? {
        baseUrl: daemon.baseUrl + "/",
        ownerToken: daemon.record.authToken,
        scope: { serverId: online[0].serverId, generation: online[0].generation },
      },
    ),
    { mode: 0o600 },
  );
  native = spawn(options["--binary"], ["--tmux-browser-stdio"], {
    env: browserEnv,
    cwd: repo,
    stdio: ["pipe", "pipe", "pipe"],
  });
  browser = spawn(
    process.execPath,
    ["--import", "tsx", join(repo, "apps/tmux-gpui/bridge/browser.ts"), ssh ? config : "--local"],
    { env: browserEnv, cwd: repo, stdio: ["pipe", "pipe", "pipe"] },
  );
  native.stderr.pipe(createWriteStream(join(artifacts, "native.log"), { mode: 0o600 }));
  browser.stderr.pipe(createWriteStream(join(artifacts, "browser.log"), { mode: 0o600 }));
  for (const child of [native, browser]) {
    child.once("error", stop);
    child.once("exit", stop);
    child.stdin.on("error", () => {});
  }
  // Observe only fixed metadata; never record raw handoff, tickets, cells, IDs or tokens.
  const observe = (stream, direction) => {
    let pending = "";
    let catalogEvents = 0;
    stream.on("data", (chunk) => {
      pending += chunk.toString("utf8");
      if (pending.length > 16 * 1024 * 1024) {
        pending = "";
        return;
      }
      let end;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        let value;
        try {
          value = JSON.parse(line);
        } catch {
          continue;
        }
        if (direction === "broker-to-native") {
          const catalog = catalogObservation(value);
          if (catalog && catalogEvents++ < 1024) {
            appendFileSync(
              join(artifacts, "metadata.jsonl"),
              JSON.stringify({ time: Date.now(), direction, ...catalog }) + "\n",
            );
            continue;
          }
        }
        const type = value.type;
        if (
          typeof type !== "string" ||
          ![
            "native-split-layout",
            "native-split-layout-result",
            "split-gesture",
            "presence",
            "native-pane-selected",
            "native-terminal-ready",
            "native-terminal-open",
            "native-terminal-catalog",
          ].includes(type)
        )
          continue;
        const event = { time: Date.now(), direction, type, ...nativeCatalogObservation(value) };
        if (type === "native-terminal-open")
          event.localImages = Boolean(value.capability?.localImages);
        for (const key of [
          "request",
          "fromRequest",
          "sequence",
          "revision",
          "active",
          "inputReady",
          "coherent",
        ])
          if (["number", "boolean"].includes(typeof value[key])) event[key] = value[key];
        if (["ok", "failed"].includes(value.status)) event.status = value.status;
        if (["begin", "release", "cancel"].includes(value.phase)) event.phase = value.phase;
        if (value.resource && type === "native-split-layout-result") {
          event.cols = value.resource.cols;
          event.rows = value.resource.rows;
          event.panes = value.resource.panes?.map(({ left, top, width, height }) => ({
            left,
            top,
            width,
            height,
          }));
          event.splits = value.resource.splits?.map(({ axis, boundary, start, length }) => ({
            axis,
            boundary,
            start,
            length,
          }));
        }
        appendFileSync(join(artifacts, "metadata.jsonl"), JSON.stringify(event) + "\n");
      }
    });
  };
  observe(browser.stdout, "broker-to-native");
  observe(native.stdout, "native-to-broker");
  browser.stdout.pipe(native.stdin);
  native.stdout.pipe(browser.stdin);
  const sample = async () => {
    if (busy) return;
    busy = true;
    try {
      ssh?.check();
      const { stdout } = await tmux(
        "list-panes",
        "-a",
        "-F",
        "#{session_name}\t#{window_id}\t#{pane_id}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}\t#{window_width}\t#{window_height}\t#{pane_active}",
      );
      await appendFile(
        join(artifacts, "geometry.jsonl"),
        JSON.stringify({
          time: Date.now(),
          panes: stdout
            .trim()
            .split("\n")
            .map((line) => line.split("\t")),
        }) + "\n",
      );
    } catch {
      stop();
    } finally {
      busy = false;
    }
  };
  timer = setInterval(() => {
    sampling = sample();
  }, 250);
  sampling = sample();
  await writeFile(
    join(artifacts, "manifest.json"),
    JSON.stringify(
      {
        binary: options["--binary"],
        cli: options["--cli"],
        repo,
        direct: true,
        ssh: !!ssh,
        alternateScreen: options["--alternate"] === "1",
        cursorPulse: options["--cursor-pulse"] === "1",
        splitAxis,
        session: fleet.sessionNames[0],
        socket: fleet.socketPath,
        tmuxBinary: fleet.environment.TMUX_IDE_TMUX_BIN,
        runnerPid: process.pid,
        fixtureRoot: fleet.root,
        started: Date.now(),
        durationSeconds: seconds,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      ready: true,
      artifacts,
      session: fleet.sessionNames[0],
      steps: [
        `Open fixture session; click ${splitAxis === "rows" ? "top" : "left"} pane; type FIRST-ONE and Enter`,
        `Click ${splitAxis === "rows" ? "bottom" : "right"} pane; type SECOND-ONE and Enter; repeat switches 10 times`,
        "Blur to another app for 3 seconds; return; type FOCUS-RETURN",
        "Scroll history up/down; return live; type AFTER-SCROLL",
        "Observe sizes stay stable across selection/focus; Ctrl-C/Ctrl-Space may be tested safely",
        "Ctrl-C this fixture runner to clean up owned processes; evidence survives",
      ],
    }),
  );
  deadline = setTimeout(stop, seconds * 1000);
  await stopped;
} finally {
  clearInterval(timer);
  clearTimeout(deadline);
  await sampling;
  const cleanup = [];
  for (const [name, fn] of [
    ["native", () => stopFixtureChild(native)],
    ["browser", () => stopFixtureChild(browser)],
    ["ssh", () => ssh?.dispose()],
    ["daemon", () => daemon?.stop()],
    ["fleet", () => fleet?.dispose()],
  ]) {
    try {
      await fn();
      cleanup.push({ name, ok: true });
    } catch (error) {
      // Keep failure classification without serializing private paths or credentials.
      const code =
        typeof error?.code === "string" && /^[A-Z_]{1,40}$/.test(error.code) ? error.code : null;
      cleanup.push({ name, ok: false, code });
    }
  }
  await writeFile(
    join(artifacts, "cleanup.json"),
    JSON.stringify({ time: Date.now(), cleanup }, null, 2),
  );
  if (cleanup.some((c) => !c.ok)) process.exitCode = 1;
}
