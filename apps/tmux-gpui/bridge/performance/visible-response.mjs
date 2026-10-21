// Opt-in physical-window observation. Never substitutes JSON arrival for visible pixels.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { createScratchFleet } from "../../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../../scripts/lib/product-fixtures/daemon.ts";
import { listTmuxServers } from "../../../../packages/daemon-client/src/tmux-server-client.ts";
import { stopFixtureChild } from "../fixture-child.mjs";
import { pairs, marker, observation, summarize, cleanEnvironment } from "./measurement.mjs";
import { ownedSsh, quote } from "./owned-ssh.mjs";

const argv = process.argv.slice(2),
  options = {};
for (let n = 0; n < argv.length; n += 2) {
  assert.ok(argv[n].startsWith("--") && argv[n + 1]);
  options[argv[n].slice(2)] = argv[n + 1];
}
for (const name of ["cli", "tui", "app", "probe", "output"])
  assert.ok(isAbsolute(options[name] ?? ""), `--${name} absolute path required`);
assert.ok(["local", "ssh"].includes(options.route), "--route local|ssh required");
assert.equal(options.run, "yes", "Explicit --run yes required; do not benchmark during builds");
assert.ok(["output", "physical"].includes(options.trigger), "--trigger output|physical required");
assert.ok(
  ["debug", "release"].includes(options.profile),
  "--profile debug|release required (caller-declared native build profile)",
);
const probe = (...args) =>
  JSON.parse(execFileSync(options.probe, args.map(String), { encoding: "utf8", timeout: 15000 }));
await mkdir(options.output, { mode: 0o700 }); // exclusive evidence directory
const save = (name, value) =>
  writeFile(join(options.output, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const permissions = probe("preflight");
await save("preflight.json", permissions);
assert.ok(
  permissions.screenCapture && (options.trigger === "output" || permissions.inputPosting),
  "Physical observation unavailable: grant capture/input to this probe; no helper-only substitution",
);
for (const name of ["cli", "tui", "probe"]) assert.ok((await stat(options[name])).isFile());
assert.ok((await stat(join(options.app, "Contents/MacOS/tmux-ide-launcher"))).isFile());
const base = cleanEnvironment(process.env);
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, base);
const fleet = await createScratchFleet({
  sessions: 1,
  windowsPerSession: 1,
  slug: "visible-response",
});
const environment = {
  ...base,
  ...fleet.environment,
  XDG_DATA_HOME: join(fleet.root, "home", ".local/share"),
  XDG_STATE_HOME: join(fleet.root, "home", ".local/state"),
  TMUX_IDE_TUI_BIN: options.tui,
  TMUX_IDE_TMUX_SOCKET_PATH: fleet.socketPath,
  TMUX: "",
};
const run = (...args) =>
  execFileSync(environment.TMUX_IDE_TMUX_BIN, ["-S", fleet.socketPath, ...args], {
    env: environment,
    encoding: "utf8",
    timeout: 5000,
  }).trimEnd();
const children = [],
  tracked = new Map();
const processStart = (pid) => {
  try {
    return execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
};
const track = (child) => {
  children.push(child);
  tracked.set(child.pid, processStart(child.pid));
  return child;
};
const ownPid = (pid) => {
  assert.ok(Number.isInteger(pid) && pid > 1);
  tracked.set(pid, processStart(pid));
  assert.ok(tracked.get(pid));
};
const descendants = (pid) => {
  const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
  const ids = new Set([pid]);
  for (let n = 0; n < 10; n++) for (const [id, parent] of rows) if (ids.has(parent)) ids.add(id);
  return [...ids];
};
const received = join(fleet.root, "received.jsonl");
let daemon,
  app,
  terminalPid,
  receipt = {
    passed: false,
    route: options.route,
    endpoint:
      options.trigger === "output"
        ? "source-trigger-to-window-screenshot-observation"
        : "physical-input-to-window-screenshot-observation",
    trigger: options.trigger,
    physicalInputPostingAvailable: permissions.inputPosting,
    samples: [],
  };
let cancelled = false;
const cancel = () => {
  cancelled = true;
};
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);
const deadline = Date.now() + 300000;
async function until(fn, label) {
  for (;;) {
    assert.ok(!cancelled && Date.now() < deadline, `bounded fixture deadline: ${label}`);
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
}
try {
  const pane = run("display-message", "-p", "-t", fleet.sessionNames[0], "#{pane_id}");
  const panes = [pane];
  panes.push(run("split-window", "-h", "-P", "-F", "#{pane_id}", "-t", pane, "sh -i"));
  panes.push(run("split-window", "-v", "-P", "-F", "#{pane_id}", "-t", pane, "sh -i"));
  const pids = panes.map((id) => run("display-message", "-p", "-t", id, "#{pane_pid}"));
  receipt.fixture = {
    session: fleet.sessionNames[0],
    intendedPane: pane,
    panes,
    programPanePid: pids[0],
  };
  receipt.panePidsBeforeClose = pids;
  await save("receipt.json", receipt);
  const program = join(fleet.root, "marker.py");
  await writeFile(
    program,
    `import os,sys,tty,time,json,select,re\ntty.setraw(0)\nos.write(1,b"\\x1b[2J\\x1b[HMEASUREMENT_READY")\nbuf=b""\nend=time.monotonic()+300\nwith open(sys.argv[1],"a",buffering=1) as log:\n while time.monotonic()<end:\n  if not select.select([0],[],[],0.1)[0]: continue\n  data=os.read(0,4096)\n  if not data: break\n  for byte in data:\n   buf+=bytes([byte])\n   if byte in (10,13):\n    text=buf[:-1].decode("ascii",errors="replace")\n    log.write(json.dumps({"text":text,"hex":buf.hex()})+"\\n")\n    if re.fullmatch(r"P[0-9]{3}",text):\n     n=int(text[1:]);r=55+n*7;g=160-n*3;b=96+n*5\n     os.write(1,("\\x1b[2J\\x1b[H\\x1b[48;2;%d;%d;%dm%s%s\\x1b[0m\\r\\n"%(r,g,b,text," "*30)).encode())\n    buf=b""\n`,
    { mode: 0o600 },
  );
  const python = execFileSync("/usr/bin/which", ["python3"], { encoding: "utf8" }).trim();
  run("send-keys", "-t", pane, "-l", `exec ${quote(python)} ${quote(program)} ${quote(received)}`);
  run("send-keys", "-t", pane, "Enter");
  await until(
    () => run("capture-pane", "-p", "-t", pane).includes("MEASUREMENT_READY"),
    "marker process",
  );
  daemon = await startDaemon(fleet, { cliPath: options.cli });
  const hostOptions = {
    baseUrl: daemon.baseUrl + "/",
    ownerToken: daemon.record.authToken,
    hostClientId: "visible-response",
    origin: "tmux-ide://app",
  };
  const server = (await listTmuxServers(hostOptions)).servers.find((s) => s.state === "online");
  assert.ok(server);
  let remote;
  if (options.route === "ssh")
    remote = await ownedSsh({
      root: fleet.root,
      environment,
      node: process.execPath,
      cli: options.cli,
      daemonPort: new URL(daemon.baseUrl).port,
      track,
    });
  const host = join(fleet.root, "host.json");
  // Host config intentionally contains only supported fields.
  await writeFile(
    host,
    JSON.stringify({
      baseUrl: remote?.url ?? hostOptions.baseUrl,
      ...(remote
        ? { remoteSocketOrigin: new URL(daemon.baseUrl.replace("http:", "ws:")).origin }
        : {}),
      ownerToken: hostOptions.ownerToken,
      scope: { serverId: server.serverId, generation: server.generation },
    }),
    { mode: 0o600 },
  );
  const fontDirectory = join(environment.XDG_CONFIG_HOME, "tmux-ide");
  await mkdir(fontDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(fontDirectory, "gpui-fonts.json"),
    JSON.stringify({ version: 1, family: "Menlo", size: 14 }),
    { mode: 0o600 },
  );
  app = track(
    spawn(join(options.app, "Contents/MacOS/tmux-ide-launcher"), [host], {
      env: environment,
      stdio: "ignore",
    }),
  );
  const tuiEnv = {
    ...environment,
    ...(remote ? { PATH: `${remote.path}:${environment.PATH}` } : {}),
  };
  const tuiScript = join(fleet.root, "tui.sh"),
    envPath = join(fleet.root, "tui-env.json");
  const args = [
    options.cli,
    "app",
    fleet.sessionNames[0],
    "--server",
    server.serverId,
    ...(remote ? ["--ssh", remote.alias] : []),
  ];
  await writeFile(
    tuiScript,
    `#!/bin/sh\nexec /usr/bin/env -i ${Object.entries(tuiEnv)
      .map(([k, v]) => `${k}=${quote(v)}`)
      .join(" ")} ${quote(process.execPath)} ${args.map(quote).join(" ")}\n`,
    { mode: 0o700 },
  );
  await writeFile(envPath, JSON.stringify(tuiEnv), { mode: 0o600 });
  terminalPid = probe(
    "launch-terminal",
    options.ghostty ?? "/Applications/Ghostty.app",
    envPath,
    tuiScript,
  ).pid;
  ownPid(terminalPid);
  const hash = async (file) =>
    createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
  receipt.identity = {
    cli: await hash(options.cli),
    tui: await hash(options.tui),
    native: await hash(join(options.app, "Contents/MacOS/tmux-ide-gpui")),
    live: await hash(join(options.app, "Contents/Resources/bridge/live.bundle.mjs")),
    bridgeManifest: await hash(join(options.app, "Contents/Resources/bridge/bridge-manifest.json")),
    embeddedNode: await hash(join(options.app, "Contents/Resources/node")),
    nativeBuildProfile: options.profile,
    nativeBuildProfileSource: "caller-declared",
    configuredFont: { family: "Menlo", size: 14, scope: "both owned clients" },
    launcher: await hash(join(options.app, "Contents/MacOS/tmux-ide-launcher")),
    browser: await hash(join(options.app, "Contents/Resources/bridge/browser.bundle.mjs")),
    node: process.version,
    tmux: run("-V"),
    terminal: execFileSync(
      join(options.ghostty ?? "/Applications/Ghostty.app", "Contents/MacOS/ghostty"),
      ["+version"],
      { encoding: "utf8" },
    ).trim(),
  };
  console.log(
    `Owned clients launched. Select ${fleet.sessionNames[0]} / first pane in GUI, match both canonical grids, then write ${join(options.output, "armed.json")} as {"guiPid":...,"guiWindow":...,"tuiWindow":...,"cols":...,"rows":...}. Window inventory refreshes in ui-state.json. No samples begin before arming.`,
  );
  const arm = await until(async () => {
    const guiPids = descendants(app.pid);
    for (const pid of guiPids)
      if (!tracked.has(pid)) {
        const start = processStart(pid);
        if (start) tracked.set(pid, start);
      }
    await save("ui-state.json", {
      root: fleet.root,
      session: fleet.sessionNames[0],
      pane,
      pids,
      gui: probe("windows", ...guiPids).windows,
      tui: probe("windows", terminalPid).windows,
      launcherPid: app.pid,
      terminalPid,
    });
    try {
      const value = JSON.parse(await readFile(join(options.output, "armed.json"), "utf8"));
      assert.ok(guiPids.includes(value.guiPid));
      assert.ok(
        Number.isInteger(value.cols) &&
          value.cols >= 20 &&
          value.cols <= 1000 &&
          Number.isInteger(value.rows) &&
          value.rows >= 10 &&
          value.rows <= 500,
      );
      return value;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return null;
    }
  }, "explicit owned-window arming");
  ownPid(arm.guiPid);
  const targets = { gui: [arm.guiPid, arm.guiWindow], tui: [terminalPid, arm.tuiWindow] };
  const grid = () => run("display-message", "-p", "-t", pane, "#{window_width}x#{window_height}");
  let matchedPanes;
  for (const [index, side] of pairs().entries()) {
    assert.ok(Date.now() < deadline && !cancelled);
    const target = targets[side],
      mark = marker(index),
      hex = mark.rgb.toString(16).padStart(6, "0");
    probe("activate", ...target);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(
      grid(),
      `${arm.cols}x${arm.rows}`,
      "matched canonical grid required for each client",
    );
    const paneGrids = panes.map((id) =>
      run("display-message", "-p", "-t", id, "#{pane_width}x#{pane_height}"),
    );
    matchedPanes ??= paneGrids;
    assert.deepEqual(paneGrids, matchedPanes, "all pane grids must match across clients");
    const windowInfo = probe("windows", target[0]).windows.find((row) => row.window === target[1]);
    assert.ok(windowInfo, "owned foreground window remains observable");
    const load = execFileSync("/usr/bin/uptime", [], { encoding: "utf8" }).trim();
    let negative = probe(
      "capture",
      ...target,
      join(options.output, `${index}-before.png`),
      hex,
      mark.text,
    );
    assert.ok(negative.matchingPixels < 200, "sample marker must not already be visible");
    let input;
    if (options.trigger === "physical") input = probe("input", ...target, mark.text);
    else {
      const triggerStartNs = probe("clock").clockNs;
      run("send-keys", "-t", pane, "-l", mark.text);
      run("send-keys", "-t", pane, "Enter");
      input = { triggerStartNs, triggerEndNs: probe("clock").clockNs };
    }
    let positive;
    for (let capture = 0; capture < 40; capture++) {
      assert.ok(Date.now() < deadline && !cancelled);
      const image = join(options.output, `${index}-${capture}.png`);
      const value = probe("capture", ...target, image, hex, mark.text);
      if (value.matchingPixels >= 200 && value.markerVisible) {
        positive = { ...value, image };
        break;
      }
      negative = value;
    }
    assert.ok(positive, "marker was not observed on the actual owned window");
    const recorded = (await readFile(received, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(recorded.length, index + 1, "exactly one marker accepted per explicit trigger");
    assert.equal(recorded.at(-1).text, mark.text);
    assert.equal(recorded.at(-1).hex, Buffer.from(mark.text + "\r").toString("hex"));
    assert.ok(run("capture-pane", "-p", "-t", pane).includes(mark.text));
    assert.equal(grid(), `${arm.cols}x${arm.rows}`);
    receipt.samples.push({
      side,
      index,
      marker: mark.text,
      correct: true,
      load,
      display: windowInfo.display,
      windowBounds: windowInfo.bounds,
      grid: grid(),
      ...observation(input, negative, positive),
      triggerTiming: input,
      negative,
      positive,
    });
    await save("receipt.json", receipt);
  }
  receipt.summary = summarize(receipt.samples);
  receipt.displayMatched = receipt.samples.every(
    (sample) =>
      sample.display.refreshHz !== "unknown" &&
      sample.display.scale !== "unknown" &&
      JSON.stringify(sample.display) === JSON.stringify(receipt.samples[0].display),
  );
  if (!receipt.displayMatched)
    receipt.comparisonLimit =
      "Display refresh/scale was unknown or differed; do not claim fully matched visible timing";
  receipt.passed = true;
  receipt.panePidsBeforeClose = pids;
} catch (error) {
  receipt.error = String(error.stack ?? error);
  throw error;
} finally {
  const cleanup = [];
  if (!terminalPid) {
    try {
      terminalPid = Number(await readFile(join(fleet.root, "tui-env.json.pid"), "utf8"));
      ownPid(terminalPid);
    } catch {}
  }
  // Snapshot descendants before stopping roots; every PID must still have its recorded start time.
  for (const pid of [
    ...(app ? descendants(app.pid) : []),
    ...(terminalPid ? descendants(terminalPid) : []),
  ])
    if (!tracked.has(pid)) {
      const start = processStart(pid);
      if (start) tracked.set(pid, start);
    }
  for (const [pid, start] of [...tracked].reverse())
    if (processStart(pid) === start) {
      try {
        process.kill(pid, "SIGTERM");
        cleanup.push(pid);
      } catch {}
    }
  for (const child of children) await stopFixtureChild(child).catch(() => {});
  const cleanupDeadline = Date.now() + 3000;
  while (
    Date.now() < cleanupDeadline &&
    [...tracked].some(([pid, start]) => processStart(pid) === start)
  )
    await new Promise((r) => setTimeout(r, 50));
  for (const [pid, start] of tracked)
    if (processStart(pid) === start) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  try {
    receipt.received = (await readFile(received, "utf8")).trim().split("\n").map(JSON.parse);
  } catch {}

  try {
    receipt.panePidsAfterClientClose = run(
      "list-panes",
      "-t",
      fleet.sessionNames[0],
      "-F",
      "#{pane_pid}",
    ).split("\n");
    if (receipt.panePidsBeforeClose)
      assert.deepEqual(
        [...receipt.panePidsAfterClientClose].sort(),
        [...receipt.panePidsBeforeClose].sort(),
      );
  } catch (error) {
    receipt.passed = false;
    receipt.cleanupError = String(error);
  }
  if (daemon) await daemon.stop();
  await fleet.dispose();
  receipt.ownedProcessesTerminated = cleanup;
  await save("receipt.json", receipt);
  process.off("SIGINT", cancel);
  process.off("SIGTERM", cancel);
}

assert.equal(receipt.passed, true, receipt.cleanupError ?? "measurement did not complete");
