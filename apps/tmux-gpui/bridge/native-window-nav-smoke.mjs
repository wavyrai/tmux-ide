// Physical window navigation proof: each tab must target its own verified pane.
import process from "node:process";
import console from "node:console";
import { setTimeout } from "node:timers";
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";
import { spawn, execFileSync } from "node:child_process";
import { join, resolve, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import { stopFixtureChild } from "./fixture-child.mjs";
const longLabelsValue = process.env.TMUX_GPUI_TEST_LONG_LABELS;
if (longLabelsValue !== undefined && !["0", "1"].includes(longLabelsValue))
  throw new Error("Long labels mode must be 0 or 1");
const longLabels = longLabelsValue === "1";
const narrowSignal = process.env.TMUX_GPUI_NARROW_SIGNAL;
if (longLabels && (!narrowSignal || !isAbsolute(narrowSignal) || existsSync(narrowSignal)))
  throw new Error("Long labels require an absent absolute narrow observation signal");
const interruptionSignal = process.env.TMUX_GPUI_INTERRUPTION_SIGNAL;
if (interruptionSignal && (!isAbsolute(interruptionSignal) || existsSync(interruptionSignal)))
  throw new Error("Interruption signal must be an absent absolute path");
const initialWindow = process.env.TMUX_GPUI_TEST_INITIAL_WINDOW ?? "one";
if (!["one", "two"].includes(initialWindow)) throw new Error("Initial window must be one or two");
const followingWindow = initialWindow === "one" ? "two" : "one";
const marker = (name) => `WINDOW_${name.toUpperCase()}_OK`;
const appPath = process.env.TMUX_GPUI_TEST_APP;
if (!appPath) throw new Error("Set TMUX_GPUI_TEST_APP to the explicit development app");
// Capture GPUI fixture inputs first; never inherit a personal server selector.
for (const key of Object.keys(process.env)) {
  if (
    key.startsWith("TMUX_IDE_") ||
    ["TMUX", "TMUX_PANE", "TMUX_TMPDIR", "NODE_OPTIONS", "NODE_PATH"].includes(key)
  )
    delete process.env[key];
}
const fleet = await createScratchFleet({
  sessions: 1,
  windowsPerSession: 2,
  slug: "gpui-window-nav",
});
let daemon, app, closedResult, successfulResult;
const errors = [];
const tmux = (...args) =>
  execFileSync(fleet.environment.TMUX_IDE_TMUX_BIN, ["-S", fleet.socketPath, ...args], {
    encoding: "utf8",
    timeout: 3000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, ...fleet.environment },
  });
let sessionName = fleet.sessionNames[0];
const windows = {};

const wait = async (predicate) => {
  const deadline = Date.now() + 180000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Packaged app proof deadline");
    await new Promise((done) => setTimeout(done, 50));
  }
};
try {
  for (const name of ["one", "two"]) {
    const [windowId, paneId] = tmux(
      "display-message",
      "-p",
      "-t",
      `=${sessionName}:=${name}`,
      "#{window_id}|#{pane_id}",
    )
      .trim()
      .split("|");
    if (!/^@[0-9]+$/u.test(windowId) || !/^%[0-9]+$/u.test(paneId))
      throw new Error("Owned window identity unavailable");
    windows[name] = { windowId, paneId, label: name, paneLabel: name };
  }
  if (longLabels) {
    const longSession = "LONG SESSION — " + "workspace navigation and clipped labels ".repeat(2);
    tmux("rename-session", "-t", `=${sessionName}`, longSession);
    sessionName = longSession;
    for (const [name, target] of Object.entries(windows)) {
      target.label = `${name.toUpperCase()} — ${"long window navigation label ".repeat(3)}`;
      target.paneLabel = `${name.toUpperCase()} — ${"terminal pane title ".repeat(3)}`;
      tmux("set-option", "-w", "-t", target.windowId, "automatic-rename", "off");
      tmux("rename-window", "-t", target.windowId, target.label);
      tmux("select-pane", "-t", target.paneId, "-T", target.paneLabel);
      tmux("set-option", "-p", "-t", target.paneId, "@ide_name", target.paneLabel);
      tmux("set-option", "-p", "-t", target.paneId, "@tmux_ide_name_source", "manual");
      if (
        tmux("display-message", "-p", "-t", target.paneId, "#{pane_title}").trim() !==
        target.paneLabel.trim()
      )
        throw new Error("Long pane label setup failed");
    }
  }
  tmux("select-window", "-t", windows[initialWindow].windowId);
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
  app.once("close", (code, signal) => {
    closedResult = { code, signal };
  });
  app.once("error", (error) => console.error("App spawn failed", error.code));
  console.log(
    `Packaged app ready: open the session without clicking a window tab; the initial window must be ${initialWindow}. Click its ready terminal, type echo ${marker(initialWindow)} and Return; then use the window strip.`,
  );
  if (longLabels)
    console.log(
      JSON.stringify({
        stage: "NARROW_LONG_LABELS_READY",
        sessionName,
        windows: Object.fromEntries(
          Object.entries(windows).map(([name, target]) => [
            name,
            { label: target.label, paneLabel: target.paneLabel },
          ]),
        ),
        operator:
          "Resize native window to 640×400. Capture Home session card, selected workspace sidebar/header and both window tabs. Labels must clip inside their chrome; terminal cells and controls must remain usable. Complete the ordinary marker route before signaling.",
        observationSignal: narrowSignal,
      }),
    );
  const capture = (name = initialWindow) => tmux("capture-pane", "-p", "-t", windows[name].paneId);
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
  if (longLabels) {
    console.log(
      "Routing verified. Capture the narrow second-window view; create the observation signal only after checking clipping and navigation, then close with Cmd-Q.",
    );
    await wait(() => {
      if (app.exitCode !== null || app.signalCode !== null)
        throw new Error("App closed before narrow observation");
      return existsSync(narrowSignal);
    });
    if (capture("one").includes("WINDOW_TWO_OK") || capture("two").includes("WINDOW_ONE_OK"))
      throw new Error("Window input crossed targets during observation");
  }
  console.log("Window-strip routing verified; close with Cmd-Q");
  await wait(() => closedResult !== undefined);
  const result = closedResult;
  if (result.code !== 0) throw new Error(`App exit failed: ${JSON.stringify(result)}`);
  if (!capture().includes(marker(initialWindow)))
    throw new Error("App close disturbed source session");
  successfulResult = {
    passed: true,
    longLabels,
    narrowLayoutObservation: longLabels
      ? "operator checkpoint; viewport size and pixels require external evidence"
      : undefined,
    prematureInputUnchanged: interruptionSignal ? true : undefined,
    initialWindow,
    distinctWindowTargets: true,
    packagedRuntime: true,
    isolatedCwd: true,
    minimalPath: true,
    sourceSurvivesClose: true,
  };
} catch (error) {
  errors.push(error);
} finally {
  try {
    await stopFixtureChild(app);
  } catch (error) {
    errors.push(error);
  }
  try {
    if (daemon) await daemon.stop();
  } catch (error) {
    errors.push(error);
  }
  try {
    await fleet.dispose();
  } catch (error) {
    errors.push(error);
  }
}
if (errors.length) throw new AggregateError(errors, "Native window navigation fixture failed");
console.log(JSON.stringify(successfulResult));
