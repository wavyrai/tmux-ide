// Physical window navigation proof: each tab must target its own verified pane.
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";
import { spawn, execFileSync } from "node:child_process";
import { join, resolve, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
const interruptionSignal = process.env.TMUX_GPUI_INTERRUPTION_SIGNAL;
if (interruptionSignal && (!isAbsolute(interruptionSignal) || existsSync(interruptionSignal)))
  throw new Error("Interruption signal must be an absent absolute path");
const initialWindow = process.env.TMUX_GPUI_TEST_INITIAL_WINDOW ?? "one";
if (!["one", "two"].includes(initialWindow)) throw new Error("Initial window must be one or two");
const followingWindow = initialWindow === "one" ? "two" : "one";
const marker = (name) => `WINDOW_${name.toUpperCase()}_OK`;
const appPath = process.env.TMUX_GPUI_TEST_APP;
if (!appPath) throw new Error("Set TMUX_GPUI_TEST_APP to the explicit development app");
const fleet = await createScratchFleet({
  sessions: 1,
  windowsPerSession: 2,
  slug: "gpui-window-nav",
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
  execFileSync(
    fleet.environment.TMUX_IDE_TMUX_BIN,
    ["-S", fleet.socketPath, "select-window", "-t", `=${fleet.sessionNames[0]}:=${initialWindow}`],
    { env: { ...process.env, ...fleet.environment } },
  );
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
    `Packaged app ready: open the session without clicking a window tab; the initial window must be ${initialWindow}. Click its ready terminal, type echo ${marker(initialWindow)} and Return; then use the window strip.`,
  );
  const capture = (name = initialWindow) =>
    execFileSync(
      fleet.environment.TMUX_IDE_TMUX_BIN,
      ["-S", fleet.socketPath, "capture-pane", "-p", "-t", `=${fleet.sessionNames[0]}:=${name}`],
      { encoding: "utf8", env: { ...process.env, ...fleet.environment } },
    );
  if (interruptionSignal) {
    const untouched = capture().trimEnd();
    console.log(
      `Interruption proof: click while authority is pending, offer echo ${marker(initialWindow)} and Return, then create the signal file before clicking to rearm.`,
    );
    await wait(() => {
      if (app.exitCode !== null || app.signalCode !== null)
        throw new Error("App closed before interrupted-input proof");
      return existsSync(interruptionSignal);
    });
    if (capture().trimEnd() !== untouched)
      throw new Error("Premature input changed the source terminal before explicit rearm");
    console.log(
      "Premature input left source untouched; click the ready terminal and retype the complete first command.",
    );
  }
  await wait(() => {
    if (app.exitCode !== null || app.signalCode !== null)
      throw new Error("App closed before input proof");
    return capture()
      .split("\n")
      .some((line) => line.trim() === marker(initialWindow));
  });
  console.log(
    `Initial window verified. Click window ${followingWindow} in the top strip, type echo ${marker(followingWindow)} and Return.`,
  );
  await wait(() =>
    capture(followingWindow)
      .split("\n")
      .some((line) => line.trim() === marker(followingWindow)),
  );
  if (capture("one").includes("WINDOW_TWO_OK") || capture("two").includes("WINDOW_ONE_OK"))
    throw new Error("Window input crossed targets");
  console.log("Window-strip routing verified; close with Cmd-Q");
  await wait(() => app.exitCode !== null || app.signalCode !== null);
  const result = await closed;
  if (result.code !== 0) throw new Error(`App exit failed: ${JSON.stringify(result)}`);
  if (!capture().includes(marker(initialWindow)))
    throw new Error("App close disturbed source session");
  console.log(
    JSON.stringify({
      passed: true,
      prematureInputUnchanged: interruptionSignal ? true : undefined,
      initialWindow,
      distinctWindowTargets: true,
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
