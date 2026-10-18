// Private bundled-bridge publication timing; no native UI or CPU claim.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { stopFixtureChild } from "../../../apps/tmux-gpui/bridge/fixture-child.mjs";
const root = resolve(import.meta.dirname, "../../..");
const scenario = process.argv[2],
  output = resolve(process.argv[3] ?? "");
assert.equal(scenario, "quiet");
const variant = process.argv[4];
assert.ok(["baseline", "candidate"].includes(variant));
assert.ok(
  output.startsWith(join(root, ".tasks/native-reliability-mission/nr09-retained-serialization/")),
);
await assert.rejects(stat(output));
const payload = join(root, ".tasks/native-reliability-mission/nr01-current-payload");
const payloadReceipt = JSON.parse(await readFile(join(payload, "receipt.json"), "utf8"));
const hostLoad = {
  uptime: execFileSync("/usr/bin/uptime", [], { encoding: "utf8" }).trim(),
  cpuCount: Number(execFileSync("/usr/sbin/sysctl", ["-n", "hw.ncpu"], { encoding: "utf8" })),
  loadAverage: execFileSync("/usr/sbin/sysctl", ["-n", "vm.loadavg"], { encoding: "utf8" }).trim(),
};
const cli = join(payload, "cli.mjs"),
  entry =
    variant === "candidate"
      ? join(
          root,
          ".tasks/native-reliability-mission/nr09-retained-serialization/bridge/browser.bundle.mjs",
        )
      : join(payload, "bridge/browser.bundle.mjs");
const tmuxBin = join(root, ".tasks/tmux38-compat/tmux-3.8/tmux");
const producerPath = join(root, ".tasks/native-reliability-mission/nr04-busy/producer.sh");
const digest = async (p) =>
  createHash("sha256")
    .update(await readFile(p))
    .digest("hex");
const paths = [
  join(root, ".tasks/native-reliability-mission/nr09-retained-serialization/prepare.py"),
  join(
    root,
    ".tasks/native-reliability-mission/nr09-retained-serialization/bridge/browser.bundle.mjs",
  ),
  join(
    root,
    ".tasks/native-reliability-mission/nr09-retained-serialization/bridge/live.bundle.mjs",
  ),
  join(payload, "bridge/browser.bundle.mjs"),
  resolve(import.meta.filename),
  join(root, "scripts/lib/product-fixtures/scratch-fleet.ts"),
  join(root, "apps/tmux-gpui/bridge/fixture-child.mjs"),
  cli,
  entry,
  join(payload, "bridge/live.bundle.mjs"),
  process.execPath,
  tmuxBin,
  producerPath,
  join(root, "bin/cli.js"),
];
const hashes = Object.fromEntries(await Promise.all(paths.map(async (p) => [p, await digest(p)])));
assert.match(process.version, /^v24\./);
assert.equal(execFileSync(tmuxBin, ["-V"], { encoding: "utf8" }).trim(), "tmux 3.8");
for (const key of Object.keys(process.env))
  if (
    key.startsWith("TMUX_IDE_") ||
    ["TMUX", "TMUX_PANE", "TMUX_TMPDIR", "NODE_OPTIONS", "NODE_PATH"].includes(key)
  )
    delete process.env[key];
process.env.PATH = join(root, ".tasks/tmux38-compat/tmux-3.8") + ":/usr/bin:/bin:/usr/sbin:/sbin";
const fleet = await createScratchFleet({ sessions: 2, windowsPerSession: 1, slug: "nr09" });
const canonical = join(fleet.root, "canonical"),
  temporary = join(fleet.root, "tmp");
await mkdir(canonical);
await mkdir(temporary);
const env = {
  ...process.env,
  ...fleet.environment,
  TMPDIR: temporary,
  TMUX_IDE_DAEMON_INFO_DIR: canonical,
  TMUX_IDE_REGISTRY_DIR: canonical,
  TMUX_IDE_TMUX_SOCKET_PATH: fleet.socketPath,
};
delete env.TMUX_IDE_TMUX_SOCKET_NAME;
const tmux = (...args) =>
  execFileSync(tmuxBin, ["-S", fleet.socketPath, ...args], {
    env,
    encoding: "utf8",
    timeout: 4000,
    maxBuffer: 1024 * 1024,
  }).trimEnd();
const ids = fleet.initialPanes.map((p) => p.paneId);
const sources = () =>
  ids.map((id) =>
    tmux(
      "display-message",
      "-p",
      "-t",
      id,
      "#{pane_id}|#{pane_pid}|#{pane_birth_id}|#{window_width}|#{window_height}",
    ),
  );
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const observed = new Set();
const processTree = () => {
  const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((s) => s.trim().split(/\s+/).map(Number));
  let change = true;
  while (change) {
    change = false;
    for (const [pid, parent] of rows)
      if (observed.has(parent) && !observed.has(pid)) {
        observed.add(pid);
        change = true;
      }
  }
};
let daemon,
  browser,
  latest,
  buffer = "",
  fatal,
  closing = false,
  request = 0,
  active = null,
  continuation = null,
  stderrBytes = 0;
const switches = [],
  failures = [];
let cleanup = false,
  original,
  record,
  publications = 0,
  inputVerified = false,
  sourcePreserved = false;
const deadline = Date.now() + 120000;
const cancel = () => {
  fatal ??= new Error("cancelled");
};
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);
async function until(fn, ms = 30000) {
  const end = Math.min(deadline, Date.now() + ms);
  while (!(await fn())) {
    if (fatal) throw fatal;
    assert.ok(Date.now() < end, "bounded phase timeout");
    await delay(10);
  }
}
const own = (child) => {
  observed.add(child.pid);
  child.on("error", (e) => {
    fatal ??= e;
  });
  child.on("exit", () => {
    if (!closing) fatal ??= new Error("owned child exited");
  });
  child.stderr?.on("data", (d) => {
    stderrBytes += d.length;
    if (stderrBytes > 65536) fatal ??= new Error("stderr bound");
  });
  return child;
};
const send = (command) => {
  assert.ok(browser.stdin.write(JSON.stringify(command) + "\n"), "command pipe backpressure");
};
const text = (state) =>
  (state.snapshot ?? state.retainedPreview?.snapshot)?.grid
    ?.map((row) => row.cells.map((c) => c.grapheme).join(""))
    .join("\n") ?? "";
function publish(value, bytes, now) {
  latest = value;
  assert.ok(++publications <= 20000);
  if (active && !active.complete && value.request >= active.request) {
    active.publications++;
    active.bytes += bytes;
    const elapsed = now - active.start;
    if (value.retainedPreview) {
      active.retainedFrames++;
      active.firstRetainedMs ??= elapsed;
      assert.equal(value.inputReady, false);
      assert.equal(value.selectedPane, null);
      assert.equal(value.copyRegion, null);
      assert.deepEqual(value.regions, []);
      assert.equal(value.resizeToken, null);
      assert.equal(value.paneActions, null);
      assert.ok(
        text(value)
          .split("\n")
          .some((line) => line.trim() === active.marker),
        "retained target marker",
      );
    } else if (value.snapshot) {
      active.freshFrames++;
      if (value.selectedSession === active.session) {
        active.firstFreshMs ??= elapsed;
        assert.ok(
          text(value)
            .split("\n")
            .some((line) => line.trim() === active.marker),
          "fresh target marker",
        );
      }
    } else active.emptyFrames++;
    if (value.inputReady && value.snapshot && value.selectedSession === active.session) {
      active.firstInputReadyMs ??= elapsed;
      active.complete = true;
    }
  }
  // Native-like metadata continuation is issued directly at its first valid publication.
  if (
    continuation &&
    !continuation.pane &&
    value.request === continuation.request &&
    value.sessionCatalogComplete &&
    value.preferredPane &&
    value.selectedSession === continuation.session
  ) {
    const pane = value.preferredPane;
    continuation.pane = pane;
    continuation.request = ++request;
    send({ type: "pane", request, id: pane });
  }
}
async function open(command, target) {
  continuation = { request: ++request, session: target.sessionId, pane: null };
  send({ ...command, request });
  await until(
    () =>
      latest?.request === request &&
      latest.inputReady &&
      latest.snapshot &&
      latest.selectedSession === target.sessionId &&
      latest.sessionTabs?.active,
  );
  continuation = null;
  return latest.sessionTabs.active;
}
async function activate(tab, target, marker, measure) {
  const row = latest.sessionTabs.rows.find((r) => r.id === tab);
  assert.ok(row?.available);
  const fromRequest = latest.request,
    revision = latest.sessionTabs.revision;
  continuation = { request: ++request, session: target.sessionId, pane: null };
  const tickBefore = scenario === "busy" && measure ? tick() : null;
  if (measure)
    active = {
      target: marker,
      session: target.sessionId,
      marker,
      request,
      start: performance.now(),
      publications: 0,
      bytes: 0,
      retainedFrames: 0,
      freshFrames: 0,
      emptyFrames: 0,
      firstRetainedMs: null,
      firstFreshMs: null,
      firstInputReadyMs: null,
    };
  send({ type: "session-tab", request, fromRequest, revision, action: row.activate });
  await until(
    () =>
      latest?.request === request &&
      latest.sessionTabs?.active === tab &&
      latest.inputReady &&
      latest.snapshot,
  );
  if (measure) {
    const tickAfter = scenario === "busy" ? tick() : null;
    assert.ok(
      active.firstRetainedMs !== null &&
        active.firstFreshMs !== null &&
        active.firstInputReadyMs !== null,
    );
    assert.ok(
      text(latest)
        .split("\n")
        .some((line) => line.trim() === marker),
    );
    switches.push({
      ...active,
      start: undefined,
      session: undefined,
      marker: undefined,
      tickBefore,
      tickAfter,
    });
    active = null;
    if (scenario === "busy") {
      assert.ok(tickBefore >= 1 && tickAfter >= tickBefore && tickAfter < 200);
    }
  }
  continuation = null;
  processTree();
}
const tick = () =>
  Number(tmux("capture-pane", "-p", "-t", ids[0]).match(/NR04_TICK_(\d+)/)?.[1] ?? 0);
try {
  for (let i = 0; i < 2; i++) {
    tmux("resize-window", "-t", `=${fleet.sessionNames[i]}:one`, "-x", "132", "-y", "41");
    fleet.typeInPane(
      fleet.sessionNames[i],
      `export PS1='READY> '; clear; printf 'NR09_TARGET_${i}\\n'`,
    );
  }
  await until(() =>
    ids.every((id, i) =>
      tmux("capture-pane", "-p", "-t", id)
        .split("\n")
        .some((line) => line.trim() === `NR09_TARGET_${i}`),
    ),
  );
  const serverPid = Number(tmux("display-message", "-p", "-t", ids[0], "#{pid}"));
  assert.ok(serverPid > 1);
  observed.add(serverPid);
  for (const id of ids)
    observed.add(Number(tmux("display-message", "-p", "-t", id, "#{pane_pid}")));
  daemon = own(
    spawn(process.execPath, [cli, "--headless"], {
      env,
      cwd: fleet.projectDir,
      stdio: ["ignore", "ignore", "pipe"],
    }),
  );
  await until(async () => {
    try {
      record = JSON.parse(await readFile(join(canonical, "daemon.json"), "utf8"));
      return record.pid === daemon.pid;
    } catch {
      return false;
    }
  });
  browser = own(
    spawn(process.execPath, [entry, "--local"], {
      env,
      cwd: fleet.root,
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );
  browser.stdout.setEncoding("utf8");
  browser.stdout.on("data", (data) => {
    try {
      buffer += data;
      assert.ok(Buffer.byteLength(buffer) <= 8 * 1024 * 1024);
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const value = JSON.parse(line);
        publish(value, Buffer.byteLength(line) + 1, performance.now());
      }
    } catch (e) {
      fatal ??= e;
    }
  });
  browser.stdin.on("error", cancel);
  browser.stdout.on("error", cancel);
  send({ type: "presence", active: true, revision: 1 });
  await until(
    () =>
      latest?.presenceRevision === 1 &&
      latest.fleet?.groups.find((g) => g.id === "local")?.sessions.length === 2 &&
      latest.sessions.length === 2,
  );
  const targets = fleet.sessionNames.map((name) =>
    latest.fleet.groups.find((g) => g.id === "local").sessions.find((s) => s.name === name),
  );
  assert.ok(targets.every(Boolean));
  const a = await open({ type: "session", id: targets[0].sessionId }, targets[0]);
  const bRow = latest.fleet.groups
    .find((g) => g.id === "local")
    .sessions.find((s) => s.name === fleet.sessionNames[1]);
  const b = await open({ type: "fleet-session", selection: bRow.selection }, targets[1]);
  for (const [tab, target, marker] of [
    [a, targets[0], "NR09_TARGET_0"],
    [b, targets[1], "NR09_TARGET_1"],
  ])
    await activate(tab, target, marker, false);
  original = sources();
  assert.ok(
    original.every((s) => s.endsWith("|132|41")),
    "matched geometry",
  );
  if (scenario === "busy") {
    await writeFile(join(fleet.root, "busy.sh"), await readFile(producerPath));
    fleet.typeInPane(fleet.sessionNames[0], `sh '${join(fleet.root, "busy.sh")}'`);
    await until(() => tick() >= 1);
  }
  for (const [tab, target, marker] of [
    [a, targets[0], "NR09_TARGET_0"],
    [b, targets[1], "NR09_TARGET_1"],
    [a, targets[0], "NR09_TARGET_0"],
  ])
    await activate(tab, target, marker, true);
  if (scenario === "busy")
    await until(() => tmux("capture-pane", "-p", "-t", ids[0]).includes("NR04_BUSY_DONE"));
  send({
    type: "input",
    request: latest.request,
    id: latest.selectedPane,
    input: { kind: "text", data: "printf 'NR09_FRESH_INPUT\\n'\n" },
  });
  await until(() =>
    tmux("capture-pane", "-p", "-t", ids[0])
      .split("\n")
      .some((l) => l.trim() === "NR09_FRESH_INPUT"),
  );
  inputVerified = true;
  assert.deepEqual(sources(), original);
  sourcePreserved = true;
} catch (e) {
  failures.push(String(e));
} finally {
  closing = true;
  try {
    processTree();
  } catch (e) {
    failures.push(String(e));
  }
  for (const child of [browser, daemon])
    try {
      if (child) await stopFixtureChild(child);
    } catch (e) {
      failures.push(String(e));
    }
  try {
    tmux("kill-server");
    const end = Date.now() + 8000;
    while ([...observed].some(alive) && Date.now() < end) await delay(50);
    assert.ok(
      [...observed].every((p) => !alive(p)),
      "observed owned processes exited",
    );
    await rm(fleet.root, { recursive: true, force: true });
    cleanup = true;
  } catch (e) {
    failures.push(String(e));
  }
}
if (fatal) failures.push(String(fatal));
const after = Object.fromEntries(await Promise.all(paths.map(async (p) => [p, await digest(p)])));
if (JSON.stringify(hashes) !== JSON.stringify(after)) failures.push("artifact hash changed");
const result = {
  variant,
  passed: failures.length === 0,
  scenario,
  endpoint: "command write to parsed matching bridge publication callback",
  nativeUi: false,
  cpuMeasured: false,
  rssMeasured: false,
  geometry: "132x41 window",
  payloadSourceCommit: payloadReceipt.head,
  hostLoad,
  harnessCheckoutHead: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  node: process.version,
  tmux: "3.8",
  hashes,
  hashesUnchanged: JSON.stringify(hashes) === JSON.stringify(after),
  switches,
  publications,
  inputVerified,
  sourcePreserved,
  observedProcessCount: observed.size,
  cleanup,
  failures,
};
await writeFile(output, JSON.stringify(result, null, 2) + "\n");
console.log(
  JSON.stringify({
    passed: result.passed,
    scenario,
    switches: switches.length,
    cleanup,
    output,
    failures,
  }),
);
if (!result.passed) process.exitCode = 1;
