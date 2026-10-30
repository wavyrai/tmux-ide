import process from "node:process";
import console from "node:console";
import assert from "node:assert/strict";
import { setTimeout } from "node:timers";
import { constants } from "node:fs";
import { stopFixtureChild } from "../fixture-child.mjs";
import { canonicalDaemonUrl } from "../../../../packages/daemon/src/lib/canonical-daemon.ts";
// Opt-in physical recovery proof with an owned daemon and the same packaged app.
import { createScratchFleet } from "../../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../../scripts/lib/product-fixtures/daemon.ts";
import { spawn, execFileSync } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
let fatal;
const cancel = () => {
  fatal ??= new Error("Native recovery proof cancelled");
};
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);
const privateCli = process.env.TMUX_GPUI_TEST_CLI;
if (privateCli !== undefined) {
  assert.ok(isAbsolute(privateCli), "TMUX_GPUI_TEST_CLI must be absolute");
  assert.ok((await stat(privateCli)).isFile(), "Private CLI must be a regular file");
  await access(privateCli, constants.R_OK);
}
async function startFixtureDaemon(fleet) {
  if (privateCli === undefined) return startDaemon(fleet);
  const child = spawn(process.execPath, [privateCli, "--headless"], {
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
const resume = process.env.TMUX_GPUI_RECOVERY_SIGNAL;
if (!resume?.startsWith("/"))
  throw new Error("Set a fresh absolute TMUX_GPUI_RECOVERY_SIGNAL path");
try {
  await stat(resume);
  throw new Error("Recovery signal already exists");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
for (const key of Object.keys(process.env))
  if (
    key.startsWith("TMUX_IDE_") ||
    ["TMUX", "TMUX_PANE", "TMUX_TMPDIR", "NODE_OPTIONS", "NODE_PATH"].includes(key)
  )
    delete process.env[key];
const fleet = await createScratchFleet({
  sessions: 1,
  windowsPerSession: 1,
  slug: "gpui-recovery",
});
let daemon, app, closedResult, result;
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
    timeout: 5000,
    env: { ...process.env, ...fleet.environment },
  });
try {
  if (fatal) throw fatal;
  const originalSource = tmux(
    "list-panes",
    "-t",
    fleet.sessionNames[0],
    "-F",
    "#{pane_id}\t#{pane_pid}",
  ).trim();
  assert.match(originalSource, /^%[0-9]+\t[1-9][0-9]*$/);
  const sourcePane = originalSource.split("\t")[0];
  daemon = await startFixtureDaemon(fleet);
  if (fatal) throw fatal;
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
  app.once("close", (code, signal) => {
    closedResult = { code, signal };
  });
  app.once("error", () => {
    fatal = new Error("App spawn failed");
  });
  console.log(
    "Packaged app ready: select session/pane, type echo BEFORE_REPLACEMENT and Return; keep the window open",
  );
  const capture = () => tmux("capture-pane", "-p", "-t", sourcePane);
  await wait(() => {
    if (app.exitCode !== null || app.signalCode !== null)
      throw new Error("App closed before input proof");
    return capture()
      .split("\n")
      .some((line) => line.trim() === "BEFORE_REPLACEMENT");
  });
  const originalInstance = daemon.record.instanceId;
  await daemon.stop();
  daemon = undefined;
  console.log(
    "Owned daemon stopped. Verify blank/unavailable native state, then create the recovery signal.",
  );
  const deadline = Date.now() + 180000;
  while (true) {
    if (fatal) throw fatal;
    if (closedResult) throw new Error("App closed before daemon replacement");
    try {
      await stat(resume);
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (Date.now() > deadline) throw new Error("Native unavailable observation deadline");
    await new Promise((done) => setTimeout(done, 50));
  }
  daemon = await startFixtureDaemon(fleet);
  if (daemon.record.instanceId === originalInstance) throw new Error("Daemon was not replaced");
  console.log(
    "New daemon ready. Refresh sessions, select the fresh pane, type echo AFTER_REPLACEMENT and Return.",
  );
  await wait(() => {
    if (app.exitCode !== null || app.signalCode !== null)
      throw new Error("App closed before recovery");
    return capture()
      .split("\n")
      .some((line) => line.trim() === "AFTER_REPLACEMENT");
  });
  console.log("Same app recovered input after daemon replacement; close with Cmd-Q");
  await wait(() => closedResult !== undefined);
  if (closedResult.code !== 0) throw new Error("App exit failed");
  if (
    !capture()
      .split("\n")
      .some((line) => line.trim() === "BEFORE_REPLACEMENT")
  )
    throw new Error("App close disturbed source session");
  assert.equal(
    tmux("list-panes", "-t", fleet.sessionNames[0], "-F", "#{pane_id}\t#{pane_pid}").trim(),
    originalSource,
    "Source pane/process must survive the app and daemon replacement",
  );
  result = {
    passed: true,
    daemonReplaced: true,
    sameAppRecovered: true,
    packagedRuntime: true,
    isolatedCwd: true,
    minimalPath: true,
    sourceSurvivesClose: true,
  };
} catch (error) {
  failures.push(error);
} finally {
  for (const cleanup of [
    async () => {
      if (app) await stopFixtureChild(app);
    },
    async () => {
      if (daemon) await daemon.stop();
    },
    () => fleet.dispose(),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
}
if (fatal && !failures.includes(fatal)) failures.push(fatal);
if (failures.length) throw new AggregateError(failures, "Native recovery proof failed");
console.log(JSON.stringify(result));
