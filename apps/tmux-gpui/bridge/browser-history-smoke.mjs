import { startNativeJourney } from "./native-journey-fixture.mjs";
// Isolated browser publication history journey; no GUI or CLI build.
import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
import { setTimeout } from "node:timers";
import { execFileSync, spawn } from "node:child_process";
import { access, stat, writeFile, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, join, isAbsolute } from "node:path";
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";

import { listTmuxServers } from "../../../packages/daemon-client/src/tmux-server-client.ts";
import { stopFixtureChild } from "./fixture-child.mjs";
const cli = process.env.TMUX_GPUI_TEST_CLI;
assert.ok(cli && isAbsolute(cli), "Explicit private TMUX_GPUI_TEST_CLI required");
const app = process.env.TMUX_GPUI_TEST_APP;
if (app !== undefined) {
  assert.ok(isAbsolute(app), "TMUX_GPUI_TEST_APP must be absolute");
  assert.ok((await stat(app)).isDirectory());
  for (const file of ["node", "bridge/browser.bundle.mjs"]) {
    const path = join(app, "Contents/Resources", file);
    assert.ok((await stat(path)).isFile());
    await access(path, file === "node" ? constants.X_OK : constants.R_OK);
  }
}
for (const key of Object.keys(process.env)) {
  if (
    key.startsWith("TMUX_IDE_") ||
    key.startsWith("CLAUDE") ||
    key.startsWith("CODEX") ||
    key.startsWith("ANTHROPIC") ||
    key.startsWith("OPENAI") ||
    ["TMUX", "TMUX_PANE", "TMUX_TMPDIR", "NODE_OPTIONS", "NODE_PATH"].includes(key)
  )
    delete process.env[key];
}
const fleet = await createScratchFleet({
  sessions: 1,
  windowsPerSession: 1,
  slug: "gpui-browser-history",
});
const fixtureEnvironment = { ...fleet.environment };
const run = (...args) =>
  execFileSync(fleet.environment.TMUX_IDE_TMUX_BIN, ["-S", fleet.socketPath, ...args], {
    env: { ...process.env, ...fixtureEnvironment },
    encoding: "utf8",
    timeout: 5000,
  }).trim();
let daemon, browser, native, latest, fatal, result;
let stderr = "";
const failures = [];
async function until(predicate) {
  const deadline = Date.now() + 25000;
  for (;;) {
    native?.assertHealthy();
    if (fatal) throw fatal;
    if (predicate()) {
      native?.assertHealthy();
      if (fatal) throw fatal;
      return;
    }
    if (browser && (browser.exitCode !== null || browser.signalCode !== null))
      throw new Error("Browser exited");
    assert.ok(
      Date.now() < deadline,
      `Browser-history deadline: ${JSON.stringify({ status: latest?.status, selectedPane: latest?.selectedPane, panes: latest?.panes, presence: latest?.presenceRevision, hasSnapshot: !!latest?.snapshot, inputReady: latest?.inputReady })}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
try {
  const nativePane = fleet.initialPanes[0].paneId;
  run(
    "send-keys",
    "-t",
    nativePane,
    "-l",
    "i=0; while [ $i -lt 180 ]; do printf 'HISTORY_%03d\\n' $i; i=$((i+1)); done",
  );
  run("send-keys", "-t", nativePane, "Enter");
  daemon = spawn(process.execPath, [cli, "--headless"], {
    env: { ...process.env, ...fixtureEnvironment },
    stdio: "ignore",
  });
  daemon.on("error", (error) => {
    fatal ??= error;
  });
  let record;
  const deadline = Date.now() + 25000;
  while (!record) {
    native?.assertHealthy();
    if (fatal) throw fatal;
    assert.ok(Date.now() < deadline, "Daemon startup deadline");
    try {
      const value = JSON.parse(await readFile(fleet.daemonInfoDir + "/daemon.json", "utf8"));
      if (value.pid === daemon.pid) record = value;
    } catch {
      // Wait for the owned daemon atomic discovery record.
    }
    if (!record) await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const options = {
    baseUrl: `http://127.0.0.1:${record.port}/`,
    ownerToken: record.authToken,
    hostClientId: "gpui-browser-history",
    origin: "tmux-ide://app",
  };
  const server = (await listTmuxServers(options)).servers.find((s) => s.state === "online");
  assert.ok(server);
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
  browser = spawn(
    app ? join(app, "Contents/Resources/node") : process.execPath,
    app
      ? [join(app, "Contents/Resources/bridge/browser.bundle.mjs"), config]
      : ["--import", "tsx", resolve("apps/tmux-gpui/bridge/browser.ts"), config],
    {
      env: { ...process.env, ...fixtureEnvironment, ...(app ? { PATH: "/usr/bin:/bin" } : {}) },
      ...(app ? { cwd: fleet.root } : {}),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  browser.on("error", (error) => {
    fatal ??= error;
  });
  browser.stdin.on("error", (error) => {
    fatal ??= error;
  });
  browser.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-4096);
  });
  native = startNativeJourney(browser, {
    worker: true,
    onState: (state) => {
      latest = state;
    },
  });
  const send = (command) => native.send(command);
  await until(() => latest?.sessions.length === 1);
  const session = latest.sessions[0].id;
  assert.equal(latest.sessions[0].paneCount, 1);
  send({ type: "presence", active: true, revision: 1 });
  send({ type: "session", request: 1, id: session });
  await until(() => latest?.request === 1 && latest.sessionCatalogComplete);
  const original = latest.preferredPane;
  assert.ok(original);
  send({ type: "pane", request: 2, id: original });
  await until(() => latest?.inputReady && latest.paneActions);
  const before = run("list-panes", "-a", "-F", "#{pane_id}|#{pane_pid}|#{pane_birth_id}");
  const text = () => latest?.frameText ?? "";
  await until(() => latest?.request === 2 && latest.inputReady && text().includes("HISTORY_179"));
  assert.equal(latest.historyOffset, 0);
  send({ type: "input", request: 2, id: original, input: { kind: "scroll", data: 30 } });
  await until(() => latest?.historyOffset > 0 && latest.snapshot && !latest.inputReady);
  assert.equal(latest.historyOffset, 30);
  send({ type: "input", request: 2, id: original, input: { kind: "scroll", data: 0 } });
  await until(() => latest?.historyOffset === 0 && latest.inputReady);
  const marker = "BROWSER_HISTORY_LIVE_OK";
  send({
    type: "input",
    request: 2,
    id: original,
    input: { kind: "text", data: `printf '\\n${marker}\\n'` },
  });
  send({ type: "input", request: 2, id: original, input: { kind: "key", data: "Enter" } });
  await until(() => run("capture-pane", "-p", "-t", nativePane).split("\n").includes(marker));
  send({ type: "input", request: 2, id: original, input: { kind: "scroll", data: 30 } });
  await until(() => latest?.historyOffset > 0 && !latest.inputReady);
  send({ type: "home", request: 3 });
  await until(() => latest?.request === 3 && latest.surface === "home");
  assert.equal(latest.historyOffset, 0);
  assert.equal(latest.snapshot, null);
  assert.equal(run("list-panes", "-a", "-F", "#{pane_id}|#{pane_pid}|#{pane_birth_id}"), before);
  result = {
    passed: true,
    scrolledHistoryOffset: true,
    backToLiveInput: true,
    navigationClearsOffset: true,
    sourceIdentityPreserved: true,
    packaged: !!app,
  };
} catch (error) {
  failures.push(error);
} finally {
  for (const cleanup of [
    () => native?.stop(),
    () => stopFixtureChild(browser),
    () => daemon && stopFixtureChild(daemon),
    () => fleet.dispose(),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
}
if (fatal) failures.push(fatal);
if (failures.length) throw new AggregateError(failures, "Browser-history fixture failed");
console.log(JSON.stringify({ ...result, cleanup: true }));
