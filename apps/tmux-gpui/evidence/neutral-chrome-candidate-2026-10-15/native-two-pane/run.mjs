// Diagnostic copy only: no build or root CLI fallback.
import process from "node:process";
import console from "node:console";
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { setTimeout } from "node:timers";
import { spawn, execFileSync } from "node:child_process";
import { join, isAbsolute } from "node:path";
import { createScratchFleet } from "../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { stopFixtureChild } from "../../apps/tmux-gpui/bridge/fixture-child.mjs";
import { canonicalDaemonUrl } from "../../packages/daemon/src/lib/canonical-daemon.ts";
let fatal;
const cancel = () => {
  fatal ??= new Error("Native two-pane proof cancelled");
};
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);
const privateCli = process.env.TMUX_GPUI_TEST_CLI;
if (!privateCli) throw new Error("TMUX_GPUI_TEST_CLI is required; no build fallback");
{
  assert.ok(isAbsolute(privateCli), "TMUX_GPUI_TEST_CLI must be absolute");
  assert.ok((await stat(privateCli)).isFile(), "Private CLI must be a regular file");
  await access(privateCli, constants.R_OK);
}
async function startFixtureDaemon(fleet) {
  const child = spawn(process.execPath, [privateCli, "--headless"], {
    cwd: fleet.root,
    env: { ...process.env, ...fleet.environment },
    stdio: "ignore",
  });
  let childError;
  child.on("error", (error) => {
    childError = error;
  });
  try {
    const deadline = Date.now() + 45000;
    for (;;) {
      if (fatal) throw fatal;
      if (childError) throw childError;
      assert.ok(child.exitCode === null && child.signalCode === null, "Private daemon exited");
      assert.ok(Date.now() < deadline, "Private daemon startup deadline");
      let record;
      try {
        record = JSON.parse(await readFile(join(fleet.daemonInfoDir, "daemon.json"), "utf8"));
      } catch {
        /* Await the owned atomic discovery record. */
      }
      if (record?.pid === child.pid && typeof record.authToken === "string" && record.instanceId)
        return {
          record,
          baseUrl: canonicalDaemonUrl("http", record.bindHostname, record.port),
          stop: () => stopFixtureChild(child),
        };
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } catch (error) {
    try {
      await stopFixtureChild(child);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Private daemon startup failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
}
const appPath = process.env.TMUX_GPUI_TEST_APP;
if (!appPath || !isAbsolute(appPath))
  throw new Error("Set TMUX_GPUI_TEST_APP to an absolute development app path");
const launcher = join(appPath, "Contents/MacOS/tmux-ide-launcher");
assert.ok((await stat(launcher)).isFile(), "App launcher must be a regular file");
await access(launcher, constants.X_OK);
for (const key of Object.keys(process.env))
  if (
    key.startsWith("TMUX_IDE_") ||
    ["TMUX", "TMUX_PANE", "TMUX_TMPDIR", "NODE_OPTIONS", "NODE_PATH"].includes(key)
  )
    delete process.env[key];
const fleet = await createScratchFleet({
  sessions: 1,
  windowsPerSession: 1,
  slug: "gpui-pane-selection",
});
let daemon, app, closed, result;
const failures = [];
const wait = async (predicate) => {
  const deadline = Date.now() + 180000;
  for (;;) {
    if (fatal) throw fatal;
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error("Packaged app proof deadline");
    await new Promise((done) => setTimeout(done, 50));
  }
};
const tmux = (...args) =>
  execFileSync(fleet.environment.TMUX_IDE_TMUX_BIN, ["-S", fleet.socketPath, ...args], {
    encoding: "utf8",
    timeout: 2000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, ...fleet.environment },
  }).trimEnd();
try {
  if (fatal) throw fatal;
  const left = tmux("display-message", "-p", "-t", fleet.sessionNames[0], "#{pane_id}");
  const right = tmux("split-window", "-h", "-P", "-F", "#{pane_id}", "-t", left, "sh -i");
  for (const [pane, side] of [
    [left, "LEFT"],
    [right, "RIGHT"],
  ]) {
    tmux(
      "send-keys",
      "-t",
      pane,
      "-l",
      `export PS1='${side}> '; clear; printf '${side}_CONTENT\\n'`,
    );
    tmux("send-keys", "-t", pane, "Enter");
  }
  daemon = await startFixtureDaemon(fleet);
  if (fatal) throw fatal;
  console.log(JSON.stringify({ event: "fixture-owned", root: fleet.root, socketPath: fleet.socketPath, session: fleet.sessionNames[0], left, right, daemonPid: daemon.record.pid }));
  app = spawn(launcher, [], {
    cwd: fleet.root,
    env: {
      ...process.env,
      ...fleet.environment,
      PATH: "/usr/bin:/bin",
      NODE_OPTIONS: "--invalid-proof-option",
      NODE_PATH: "/nonexistent-proof-path",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  console.log(JSON.stringify({ event: "app-owned", pid: app.pid, appPath }));
  closed = new Promise((done) => app.once("close", (code, signal) => done({ code, signal })));
  app.once("error", (error) => { fatal = error; });
  const capture = (pane) => tmux("capture-pane", "-p", "-t", pane);
  const has = (pane, marker) =>
    capture(pane)
      .split("\n")
      .some((line) => line.trim() === marker);
  console.log(
    "Packaged panes ready: open session/window, click LEFT terminal when ready, verify selected title/rail and type echo GPUI_LEFT_OK then Return.",
  );
  await wait(() => {
    if (app.exitCode !== null || app.signalCode !== null)
      throw new Error("App closed before left input");
    return has(left, "GPUI_LEFT_OK");
  });
  if (capture(right).includes("GPUI_LEFT_OK"))
    throw new Error("Left input crossed pane identities");
  console.log(
    "Left verified: click RIGHT terminal when ready, verify selected title changes and separator stays clear of content, type echo GPUI_RIGHT_OK then Return.",
  );
  await wait(() => {
    if (app.exitCode !== null || app.signalCode !== null)
      throw new Error("App closed before right input");
    return has(right, "GPUI_RIGHT_OK");
  });
  if (capture(left).includes("GPUI_RIGHT_OK"))
    throw new Error("Right input crossed pane identities");
  console.log("Both pane targets verified. Capture visual evidence, then Cmd-Q.");
  await wait(() => app.exitCode !== null || app.signalCode !== null);
  const exit = await closed;
  if (exit.code !== 0) throw new Error(`App exit failed: ${JSON.stringify(exit)}`);
  if (!has(left, "GPUI_LEFT_OK") || !has(right, "GPUI_RIGHT_OK"))
    throw new Error("App close disturbed source panes");
  result = {
    passed: true,
    distinctPaneTargets: true,
    visualAppearance: "requires separate screenshots",
    packagedRuntime: true,
    isolatedCwd: true,
    privateCli: true,
    minimalPath: true,
    sourceSurvivesClose: true,
  };
} catch (error) {
  failures.push(error);
} finally {
  for (const cleanup of [
    () => stopFixtureChild(app),
    () => daemon?.stop(),
    () => fleet.dispose(),
  ]) {
    try { await cleanup(); } catch (error) { failures.push(error); }
  }
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}
if (fatal && !failures.includes(fatal)) failures.push(fatal);
if (failures.length) throw new AggregateError(failures, "Two-pane proof or cleanup failed");
console.log(JSON.stringify(result));
