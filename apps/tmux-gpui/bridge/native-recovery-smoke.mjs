// Opt-in physical recovery proof with an owned daemon and the same packaged app.
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";
import { spawn, execFileSync } from "node:child_process";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
const appPath = process.env.TMUX_GPUI_TEST_APP;
if (!appPath) throw new Error("Set TMUX_GPUI_TEST_APP to the explicit development app");
const resume = process.env.TMUX_GPUI_RECOVERY_SIGNAL;
if (!resume?.startsWith("/"))
  throw new Error("Set a fresh absolute TMUX_GPUI_RECOVERY_SIGNAL path");
try {
  await stat(resume);
  throw new Error("Recovery signal already exists");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const fleet = await createScratchFleet({
  sessions: 1,
  windowsPerSession: 1,
  slug: "gpui-recovery",
});
let daemon, app, closed;
const wait = async (predicate) => {
  const deadline = Date.now() + 180000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Packaged app proof deadline");
    await new Promise((done) => setTimeout(done, 50));
  }
};
try {
  daemon = await startDaemon(fleet);
  app = spawn(join(resolve(appPath), "Contents/MacOS/tmux-ide-launcher"), [], {
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
  closed = new Promise((done) => app.once("close", (code, signal) => done({ code, signal })));
  app.once("error", (error) => console.error("App spawn failed", error.code));
  console.log(
    "Packaged app ready: select session/pane, type echo BEFORE_REPLACEMENT and Return; keep the window open",
  );
  const capture = () =>
    execFileSync(
      fleet.environment.TMUX_IDE_TMUX_BIN,
      ["-S", fleet.socketPath, "capture-pane", "-p", "-t", fleet.sessionNames[0]],
      { encoding: "utf8", env: { ...process.env, ...fleet.environment } },
    );
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
    try {
      await stat(resume);
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (Date.now() > deadline) throw new Error("Native unavailable observation deadline");
    await new Promise((done) => setTimeout(done, 50));
  }
  daemon = await startDaemon(fleet);
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
  await wait(() => app.exitCode !== null || app.signalCode !== null);
  const result = await closed;
  if (result.code !== 0) throw new Error(`App exit failed: ${JSON.stringify(result)}`);
  if (!capture().includes("BEFORE_REPLACEMENT"))
    throw new Error("App close disturbed source session");
  console.log(
    JSON.stringify({
      passed: true,
      daemonReplaced: true,
      sameAppRecovered: true,
      packagedRuntime: true,
      isolatedCwd: true,
      minimalPath: true,
      sourceSurvivesClose: true,
    }),
  );
} finally {
  if (app && app.exitCode === null && app.signalCode === null) {
    app.kill("SIGTERM");
    const escalation = setTimeout(() => {
      if (app.exitCode === null && app.signalCode === null) app.kill("SIGKILL");
    }, 3000);
    try {
      await closed;
    } finally {
      clearTimeout(escalation);
    }
  }
  if (daemon) await daemon.stop();
  await fleet.dispose();
}
