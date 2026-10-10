// One synthetic visual case, not an automated pixel/font verdict or GP08 matrix completion.
// --prepare-only creates/captures/disposes the real tmux screen without a daemon or GUI.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";
import { visualScreen } from "./native-visual-screen.mjs";
const args = process.argv.slice(2);
if (args.some((a) => a !== "--prepare-only") || args.length > 1)
  throw new Error("Only --prepare-only is supported");
const prepareOnly = args.length === 1;
const appPath = process.env.TMUX_GPUI_TEST_APP;
const directory = process.env.TMUX_GPUI_VISUAL_DIR;
if (!directory || !isAbsolute(directory) || existsSync(directory))
  throw new Error("Set an absent absolute TMUX_GPUI_VISUAL_DIR");
if (!prepareOnly && (!appPath || !isAbsolute(appPath)))
  throw new Error("Set explicit absolute TMUX_GPUI_TEST_APP");
if (!prepareOnly && !(await stat(join(appPath, "Contents/MacOS/tmux-ide-launcher"))).isFile())
  throw new Error("App launcher missing");
// Isolate this fixture process before shared helpers construct their inherited environments.
// Explicit app/evidence values above are retained; native selection comes only from PATH.
for (const key of Object.keys(process.env)) {
  if (
    key.startsWith("TMUX_IDE_") ||
    ["TMUX", "TMUX_PANE", "TMUX_TMPDIR", "NODE_OPTIONS", "NODE_PATH"].includes(key)
  )
    delete process.env[key];
}
await mkdir(directory, { mode: 0o700 });
let fleet, daemon, app, closed, appError, outcome;
const deadline = Date.now() + 180000;
let cancelled = false;
const cancel = () => {
  cancelled = true;
};
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);
const errors = [];
async function wait(probe) {
  while (true) {
    if (cancelled || Date.now() > deadline) throw new Error("Visual fixture deadline/cancellation");
    if (appError) throw appError;
    const value = probe();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 50));
  }
}
const save = (name, value) =>
  writeFile(join(directory, name), JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
try {
  fleet = await createScratchFleet({
    sessions: 1,
    windowsPerSession: 1,
    slug: "gpui-native-visual",
    initialPaneCommand: {
      executable: process.execPath,
      args: [fileURLToPath(new URL("./native-visual-screen.mjs", import.meta.url))],
    },
  });
  const pane = fleet.initialPanes[0].paneId;
  const tmux = (...values) =>
    execFileSync(fleet.environment.TMUX_IDE_TMUX_BIN, ["-S", fleet.socketPath, ...values], {
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, ...fleet.environment },
    });
  const geometry = () =>
    tmux(
      "display-message",
      "-p",
      "-t",
      pane,
      "#{pane_width}|#{pane_height}|#{cursor_x}|#{cursor_y}|#{cursor_flag}|#{wrap_flag}",
    ).trim();
  const source = () => {
    const before = geometry();
    const [cols, rows, x, y, visible, wrap] = before.split("|").map(Number);
    const { expected } = visualScreen(cols, rows);
    const plain = tmux("capture-pane", "-p", "-t", pane);
    const sgr = tmux("capture-pane", "-e", "-p", "-t", pane);
    const joined = tmux("capture-pane", "-J", "-p", "-t", pane);
    if (geometry() !== before) return null;
    const lines = plain.split("\n");
    if (
      !expected.anchors.every((anchor, index) => lines[index === 5 ? 14 : index] === anchor) ||
      lines[11] !== "WRAP>" + "w".repeat(cols - 5) ||
      lines[12] !== "WRAP_END" ||
      !joined.includes("WRAP>" + "w".repeat(cols - 5) + "WRAP_END") ||
      x !== 8 ||
      y !== 16 ||
      visible !== 1 ||
      wrap !== 1
    )
      return null;
    return {
      expected,
      plain,
      sgr,
      joined,
      geometryBracket: before,
      modes: { cursorVisible: visible === 1, autoWrap: wrap === 1 },
      scope: "Real tmux text/SGR capture and cursor; no native pixel or font assertion",
    };
  };
  await save("source-initial.json", await wait(source));
  if (!prepareOnly) {
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
    app.once("error", (error) => {
      appError = error;
    });
    closed = new Promise((done) => app.once("close", (code, signal) => done({ code, signal })));
    console.log(
      `Visual specimen ready: select ${fleet.sessionNames[0]} / its only pane. Do not type. Compare ASCII, wide/combining/emoji, colors, blank background, wrap and cursor. Save a native screenshot separately, then create ${join(directory, "capture.request")} to record the current source. Then Cmd-Q.`,
    );
    await wait(() => {
      if (app.exitCode !== null || app.signalCode !== null)
        throw new Error("App closed before source capture checkpoint");
      return existsSync(join(directory, "capture.request"));
    });
    await save("source-visible.json", await wait(source));
    console.log(
      "Source checkpoint saved; visual assessment remains manual. Close the app with Cmd-Q.",
    );
    await wait(() => app.exitCode !== null || app.signalCode !== null);
    assert.equal((await closed).code, 0, "Native app must close cleanly");
    await save("source-after-close.json", await wait(source));
  }
  outcome = {
    sourcePrepared: true,
    nativeLaunched: !prepareOnly,
    sourceSurvivesNativeClose: prepareOnly ? null : true,
    visualVerdict: "unassessed — separate native screenshot comparison required",
    matrixComplete: false,
  };
} catch (error) {
  errors.push(String(error));
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
  } catch (error) {
    errors.push(`daemon cleanup: ${String(error)}`);
  }
  try {
    if (fleet) await fleet.dispose();
  } catch (error) {
    errors.push(`fleet cleanup: ${String(error)}`);
  }
  process.off("SIGINT", cancel);
  process.off("SIGTERM", cancel);
  await save("result.json", {
    ...outcome,
    errors,
    visualVerdict: "unassessed — separate native screenshot comparison required",
  });
}
if (errors.length) throw new Error(errors.join("\n"));
console.log(JSON.stringify(outcome));
