// Opt-in native proof: launch the assembled app with no development tools on PATH.
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";
import { spawn, execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
const appPath = process.env.TMUX_GPUI_TEST_APP;
if (!appPath) throw new Error("Set TMUX_GPUI_TEST_APP to the explicit development app");
const fleet = await createScratchFleet({
  sessions: 1,
  windowsPerSession: 1,
  slug: "gpui-packaged",
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
    "Packaged app ready: select session/pane, type echo PACKAGED_GPUI_OK and Return, then Cmd-Q",
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
      .some((line) => line.trim() === "PACKAGED_GPUI_OK");
  });
  console.log("Packaged input verified; close the native window with Cmd-Q");
  await wait(() => app.exitCode !== null || app.signalCode !== null);
  const result = await closed;
  if (result.code !== 0) throw new Error(`App exit failed: ${JSON.stringify(result)}`);
  if (!capture().includes("PACKAGED_GPUI_OK"))
    throw new Error("App close disturbed source session");
  console.log(
    JSON.stringify({
      passed: true,
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
