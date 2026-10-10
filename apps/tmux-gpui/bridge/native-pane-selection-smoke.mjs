// Physical packaged two-pane selection/chrome proof; inspect screenshots separately.
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";
import { spawn, execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
const appPath = process.env.TMUX_GPUI_TEST_APP;
if (!appPath) throw new Error("Set TMUX_GPUI_TEST_APP to the explicit development app");
const fleet = await createScratchFleet({
  sessions: 1,
  windowsPerSession: 1,
  slug: "gpui-pane-selection",
});
let daemon, app, closed;
const wait = async (predicate) => {
  const deadline = Date.now() + 180000;
  while (!predicate()) {
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
  const result = await closed;
  if (result.code !== 0) throw new Error(`App exit failed: ${JSON.stringify(result)}`);
  if (!has(left, "GPUI_LEFT_OK") || !has(right, "GPUI_RIGHT_OK"))
    throw new Error("App close disturbed source panes");
  console.log(
    JSON.stringify({
      passed: true,
      distinctPaneTargets: true,
      visualAppearance: "requires separate screenshots",
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
  try {
    if (daemon) await daemon.stop();
  } finally {
    await fleet.dispose();
  }
}
