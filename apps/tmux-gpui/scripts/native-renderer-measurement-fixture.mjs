// Manual renderer-endpoint qualification. No Terminal/desktop input automation.
// Run with Node 24 --import tsx. Explicit artifacts only: never builds/downloads.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, writeFile, appendFile, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { trialManifest, analyzeTrials } from "../bridge/performance/renderer-trials.mjs";
process.umask(0o077);
const options = {},
  args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  if (
    ![
      "--repo",
      "--cli",
      "--binary",
      "--tmux",
      "--tui",
      "--bun",
      "--output",
      "--profile",
      "--seconds",
      "--route",
      "--smoke",
      "--transport",
    ].includes(args[i]) ||
    !args[i + 1] ||
    options[args[i]]
  )
    throw Error("Invalid arguments");
  options[args[i]] = args[i + 1];
}
for (const key of ["--repo", "--cli", "--binary", "--tmux", "--output"])
  if (!isAbsolute(options[key] ?? "")) throw Error(`Explicit absolute ${key} required`);
if (!!options["--tui"] === !!options["--bun"])
  throw Error("Choose one explicit --tui compiled artifact or --bun source runtime");
for (const key of ["--repo", "--cli", "--binary", "--tmux", options["--tui"] ? "--tui" : "--bun"]) {
  if (!isAbsolute(options[key])) throw Error(`Absolute ${key} required`);
  await access(options[key]);
}
if (!["debug", "release"].includes(options["--profile"]))
  throw Error("Explicit --profile debug|release required (caller-declared)");
if (options["--smoke"] !== undefined && options["--smoke"] !== "1")
  throw Error("--smoke requires 1");
const seconds = Number(options["--seconds"] ?? 1200),
  route = options["--route"] ?? "local";
const transport = options["--transport"] ?? "native";
if (!["native", "legacy"].includes(transport)) throw Error("--transport requires native|legacy");
if (
  !Number.isInteger(seconds) ||
  seconds < 60 ||
  seconds > 1800 ||
  !["local", "ssh"].includes(route)
)
  throw Error("Invalid duration/route");
if (options["--bun"] && basename(options["--bun"]) !== "bun")
  throw Error("Source runtime must be the explicit bun executable");
if (options["--bun"] && options["--cli"] !== join(options["--repo"], "bin/cli.js"))
  throw Error(
    "Source TUI requires this checkout's bin/cli.js so public app resolves matching sources",
  );
const repo = options["--repo"],
  output = options["--output"],
  run = promisify(execFile);
await mkdir(output, { mode: 0o700 }); // Must be fresh; never overwrite evidence.
const load = (p) => import(pathToFileURL(join(repo, p)).href);
const hash = async (p) =>
  createHash("sha256")
    .update(await readFile(p))
    .digest("hex");
const json = (p, v) =>
  writeFile(join(output, p), JSON.stringify(v, null, 2) + "\n", { mode: 0o600 });
const { createScratchFleet } = await load("scripts/lib/product-fixtures/scratch-fleet.ts");
const { startDaemon } = await load("scripts/lib/product-fixtures/daemon.ts");
const { listTmuxServers } = await load("packages/daemon-client/src/tmux-server-client.ts");
const { stopFixtureChild } = await load("apps/tmux-gpui/bridge/fixture-child.mjs");
for (const key of Object.keys(process.env))
  if (
    key.startsWith("TMUX_IDE_") ||
    ["TMUX", "TMUX_PANE", "TMUX_TMPDIR", "NODE_OPTIONS", "NODE_PATH", "BUN_OPTIONS"].includes(key)
  )
    delete process.env[key];
process.env.PATH = `${dirname(options["--tmux"])}:${options["--bun"] ? dirname(options["--bun"]) + ":" : ""}${process.env.PATH ?? ""}`;
let fleet, daemon, ssh, native, browser, timer, sampleTimer, sampling, manifest;
let stop;
const stopped = new Promise((resolve) => {
  stop = resolve;
});
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const alive = join(output, "fixture-alive"),
  done = join(output, "tui-exited.json");
try {
  const fixture = join(repo, "apps/tmux-gpui/bridge/performance/renderer-fixture.mjs");
  fleet = await createScratchFleet({
    sessions: 1,
    slug: "renderer",
    windowsPerSession: 1,
    initialPaneCommand: {
      executable: "/usr/bin/env",
      args: ["TMUX_IDE_RENDERER_FIXTURE=1", process.execPath, fixture],
    },
  });
  if (fleet.environment.TMUX_IDE_TMUX_BIN !== options["--tmux"])
    throw Error("Explicit bundled tmux mismatch");
  const env = { ...process.env, ...fleet.environment };
  daemon = await startDaemon(fleet, { cliPath: options["--cli"] });
  for (const name of fleet.sessionNames) await daemon.promote(name);
  const { servers } = await listTmuxServers({
    baseUrl: daemon.baseUrl + "/",
    ownerToken: daemon.record.authToken,
    hostClientId: "renderer-fixture",
    origin: "tmux-ide://app",
  });
  const online = servers.filter((s) => s.state === "online");
  if (online.length !== 1) throw Error("Expected one owned server");
  if (route === "ssh") {
    const { createNativeGuiSsh } = await import("./native-gui-ssh-fixture.mjs");
    ssh = await createNativeGuiSsh({ repo, fleet, daemon, env });
  }
  const clientEnv = ssh?.environment ?? env;
  const hashes = {};
  for (const [name, path] of Object.entries({
    node: process.execPath,
    cli: options["--cli"],
    native: options["--binary"],
    tmux: options["--tmux"],
    tuiRuntime: options["--tui"] ?? options["--bun"],
    fixture,
    outputWorkload: join(repo, "apps/tmux-gpui/bridge/performance/renderer-output.mjs"),
    tuiProbe: join(repo, "packages/daemon/src/tui/mirror/runtime/renderer-probe.ts"),
    ...(transport === "legacy" ? { broker: join(repo, "apps/tmux-gpui/bridge/browser.ts") } : {}),
  }))
    hashes[name] = { path, sha256: await hash(path) };
  const git = async (...argv) =>
    (await run("git", argv, { cwd: repo, maxBuffer: 32 * 1024 * 1024 })).stdout;
  const diff = await git("diff", "HEAD", "--", "bin", "packages", "apps/tmux-gpui");
  const untracked = (
    await git(
      "ls-files",
      "--others",
      "--exclude-standard",
      "--",
      "bin",
      "packages",
      "apps/tmux-gpui",
    )
  )
    .split("\n")
    .filter(Boolean);
  const untrackedHashes = {};
  for (const p of untracked) untrackedHashes[p] = await hash(join(repo, p));
  const grid = fleet.windowGrid(fleet.sessionNames[0]);
  manifest = trialManifest({
    build: {
      transport,
      profile: options["--profile"],
      profileVerified: false,
      nodeVersion: process.version,
      tuiMode: options["--tui"] ? "compiled" : "bun-source",
      hashes,
      commit: (await git("rev-parse", "HEAD")).trim(),
      diffSha256: createHash("sha256").update(diff).digest("hex"),
      untrackedHashes,
    },
    daemon: hashes.cli,
    tmux: hashes.tmux,
    route,
    cols: grid.cols,
    rows: grid.rows,
    geometryMatched: false,
    sourceLifetime: { session: fleet.sessionNames[0], pane: fleet.initialPanes[0].paneId },
    endpointLimit:
      "Admission of injected nonce workload to renderer completion; not physical key or display-vsync latency",
  });
  await json("manifest.json", manifest);
  const loadSnapshot = {};
  for (const [name, command, argv] of [
    ["uptime", "/usr/bin/uptime", []],
    ["cpuCount", "/usr/sbin/sysctl", ["-n", "hw.ncpu"]],
  ]) {
    try {
      loadSnapshot[name] = (await run(command, argv, { timeout: 2000 })).stdout.trim();
    } catch {
      loadSnapshot[name] = "unavailable";
    }
  }
  await json("load-before.json", { time: Date.now(), ...loadSnapshot });
  const probeEnv = (side) => ({
    TMUX_IDE_RENDERER_FIXTURE: "1",
    TMUX_IDE_RENDERER_PROBE_TRIALS: JSON.stringify(
      manifest.trials
        .filter((t) => t.side === side)
        .map(({ id, nonce, kind }) => ({ id, nonce, kind })),
    ),
    TMUX_IDE_RENDERER_PROBE_LOG: join(output, `${side}.jsonl`),
  });
  const tuiEnv = {
    ...Object.fromEntries(
      Object.entries(clientEnv).filter(
        ([key]) =>
          key.startsWith("TMUX_IDE_") ||
          ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME", "SHELL"].includes(key),
      ),
    ),
    // Public app bootstraps local discovery even with --ssh. Reuse the owned
    // daemon; only SSH transport PATH comes from the private client helper.
    TMUX_IDE_HOME: fleet.environment.TMUX_IDE_HOME,
    TMUX_IDE_REGISTRY_DIR: fleet.environment.TMUX_IDE_REGISTRY_DIR,
    TMUX_IDE_DAEMON_INFO_DIR: fleet.environment.TMUX_IDE_DAEMON_INFO_DIR,
    ...probeEnv("tui"),
    ...(options["--tui"] ? { TMUX_IDE_TUI_BIN: options["--tui"] } : { TMUX_IDE_TUI_SOURCE: "1" }),
  };
  const tuiArgs = [
    options["--cli"],
    "app",
    fleet.sessionNames[0],
    "--server",
    online[0].serverId,
    ...(ssh ? ["--ssh", "target"] : []),
  ];
  await writeFile(alive, "owned fixture live\n", { flag: "wx", mode: 0o600 });
  // User starts this wrapper in their terminal. Existing identity-checked
  // fixture tracker retires only this exact child and proven descendants.
  const launcher = `import {spawn,execFileSync} from 'node:child_process';import {access,writeFile} from 'node:fs/promises';
import {createMacProcessIdentity,ownedProcesses} from ${JSON.stringify(pathToFileURL(join(repo, "scripts/lib/owned-ssh-fixture.mjs")).href)};
if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error('Run manually in a terminal');
await access(${JSON.stringify(alive)});
const allocations=[];const kernel=await createMacProcessIdentity({parent:${JSON.stringify(output)},onAllocated:a=>allocations.push(a)});
await access(${JSON.stringify(alive)});
const tracker=ownedProcesses({identify:pid=>kernel.identify(pid),list:async()=>execFileSync('/bin/ps',['-axo','pid=,ppid='],{encoding:'utf8'}).trim().split('\\n').map(line=>{const[pid,ppid]=line.trim().split(/\\s+/).map(Number);return{pid,ppid};})});
await writeFile(${JSON.stringify(join(output, "tui-started.json"))},JSON.stringify({wrapperPid:process.pid,time:Date.now()}),{flag:'wx',mode:0o600});
const child=tracker.retain(spawn(${JSON.stringify(process.execPath)},${JSON.stringify(tuiArgs)},{cwd:${JSON.stringify(repo)},env:{...${JSON.stringify(tuiEnv)},TERM:process.env.TERM??"xterm-256color",COLORTERM:process.env.COLORTERM??"truecolor"},stdio:'inherit'}));
let closing=false,flight;
async function close(){if(closing)return;closing=true;clearInterval(watcher);await flight;let stopped=false;try{await tracker.dispose();stopped=true;for(const a of allocations.reverse())await a.disposeFiles();}finally{await writeFile(${JSON.stringify(done)},JSON.stringify({stopped,time:Date.now()}),{mode:'600'});process.exitCode=stopped?0:1;}}
const watcher=setInterval(()=>{if(flight||closing)return;flight=access(${JSON.stringify(alive)}).catch(()=>{queueMicrotask(close);}).finally(()=>{flight=undefined;});},100);
process.once('SIGINT',close);process.once('SIGTERM',close);child.once('error',close);child.once('exit',close);
await tracker.capture().catch(close);
`;
  await writeFile(join(output, "launch-tui.mjs"), launcher, { flag: "wx", mode: 0o600 });
  const config = join(fleet.root, "host.json");
  await writeFile(config, JSON.stringify(ssh?.host ?? {}), { mode: 0o600 });
  if (!options["--smoke"]) {
    const nativeArgs =
      transport === "legacy"
        ? ["--tmux-browser-stdio"]
        : ssh
          ? [
              "--tmux-native-ssh",
              ssh.host.sshTarget,
              "--local-daemon",
              join(fleet.daemonInfoDir, "daemon.json"),
            ]
          : ["--tmux-native-local"];
    native = spawn(options["--binary"], nativeArgs, {
      env: { ...clientEnv, ...probeEnv("gui") },
      cwd: repo,
      stdio: [transport === "native" ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (transport === "legacy") {
      browser = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          join(repo, "apps/tmux-gpui/bridge/browser.ts"),
          ssh ? config : "--local",
        ],
        { env: clientEnv, cwd: repo, stdio: ["pipe", "pipe", "pipe"] },
      );
      native.stdout.pipe(browser.stdin);
      browser.stdout.pipe(native.stdin);
    } else {
      native.stdout.pipe(createWriteStream(join(output, "native-stdout.log"), { mode: 0o600 }));
    }
    for (const [name, child] of [
      ["native", native],
      ["browser", browser],
    ]) {
      if (!child) continue;
      child.stderr.pipe(createWriteStream(join(output, `${name}.log`), { mode: 0o600 }));
      child.once("error", stop);
      child.once("exit", stop);
      child.stdin?.on("error", () => {});
    }
  }
  const sample = async () => {
    try {
      const { stdout } = await run(
        options["--tmux"],
        [
          "-S",
          fleet.socketPath,
          "display-message",
          "-p",
          "-t",
          fleet.initialPanes[0].paneId,
          "#{pane_id} #{pane_pid} #{pane_width} #{pane_height}",
        ],
        { env, timeout: 2000 },
      );
      await appendFile(
        join(output, "geometry.jsonl"),
        JSON.stringify({ time: Date.now(), pane: stdout.trim() }) + "\n",
      );
      ssh?.check();
    } catch {
      stop();
    }
  };
  sampleTimer = setInterval(() => {
    if (!sampling)
      sampling = sample().finally(() => {
        sampling = undefined;
      });
  }, 1000);
  await json("owned.json", {
    runner: process.pid,
    native: native?.pid ?? null,
    browser: browser?.pid ?? null,
    root: fleet.root,
    socket: fleet.socketPath,
    session: fleet.sessionNames[0],
    serverId: online[0].serverId,
    deadline: Date.now() + seconds * 1000,
  });
  await writeFile(
    join(output, "instructions.txt"),
    [
      `Manual launch: ${[process.execPath, "--import", import.meta.resolve("tsx"), join(output, "launch-tui.mjs")].map((v) => "'" + v.replaceAll("'", "'\\''") + "'").join(" ")}`,
      `Select GUI session ${fleet.sessionNames[0]} and its only pane. Keep both clients alive.`,
      "Before any trial, match actual pane columns/rows in BOTH receipts and geometry.jsonl. Initial manifest geometry is setup only, not qualification.",
      "Do not benchmark during builds. Record terminal version/font/window size, display settings, load and user-visible response observations separately.",
      "Follow this GLOBAL order; each client receives only its own trials. Return LIVE before every trial. Never type ! for calibration.",
      ...manifest.trials.map(
        (t, i) =>
          `${i + 1}. ${t.side} ${t.id}: ${t.kind !== "scroll" ? "type ! once" : "type ! once to prepare output; wait SCROLL READY, then scroll upward until a nonce marker becomes newly visible at row zero"}; wait for its JSONL receipt before continuing.`,
      ),
      "Failure/missing receipts stay in evidence. Do not retry a consumed trial. Stop the runner with Ctrl-C; only owned fixture resources are removed.",
      "Renderer completion does not measure display-vsync or physical key latency. Source Bun vs native release is a declared build difference. SSH here is loopback transport only.",
    ].join("\n") + "\n",
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      ready: true,
      output,
      manualTui: [
        process.execPath,
        "--import",
        import.meta.resolve("tsx"),
        join(output, "launch-tui.mjs"),
      ],
      instructions: join(output, "instructions.txt"),
    }),
  );
  if (options["--smoke"]) {
    await sample();
    stop();
  }
  timer = setTimeout(stop, seconds * 1000);
  await stopped;
} finally {
  clearTimeout(timer);
  clearInterval(sampleTimer);
  await sampling;
  await rm(alive, { force: true });
  const cleanup = [];
  let tuiStarted = false;
  try {
    await access(join(output, "tui-started.json"));
    tuiStarted = true;
  } catch {
    // A manual TUI may never have been launched.
  }
  let tuiStopped = !tuiStarted;
  for (let i = 0; tuiStarted && !tuiStopped && i < 100; i++) {
    try {
      tuiStopped = JSON.parse(await readFile(done, "utf8")).stopped === true;
      if (!tuiStopped) await new Promise((r) => setTimeout(r, 100));
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  cleanup.push({ name: "manual-tui", ok: tuiStopped });
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
    } catch {
      cleanup.push({ name, ok: false });
    }
  }
  if (manifest) {
    const receipts = [];
    for (const side of ["gui", "tui"]) {
      try {
        receipts.push(
          ...(await readFile(join(output, `${side}.jsonl`), "utf8"))
            .split("\n")
            .filter(Boolean)
            .map(JSON.parse),
        );
      } catch (e) {
        if (e.code !== "ENOENT") {
          cleanup.push({ name: `${side}-receipts`, ok: false });
          receipts.length = 0;
          break;
        }
      }
    }
    await json("summary.json", analyzeTrials(manifest, receipts));
  }
  await json("cleanup.json", { time: Date.now(), cleanup });
  if (cleanup.some((c) => !c.ok)) process.exitCode = 1;
}
