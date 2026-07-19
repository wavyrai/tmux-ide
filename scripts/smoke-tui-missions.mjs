#!/usr/bin/env node
import { constants, accessSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import stringWidth from "string-width";

const execFile = promisify(execFileCallback);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const compiledTui = join(repoRoot, "packages/daemon/dist/tui/tmux-ide-tui");
const runId = `tmux_ide_c06_${process.pid}_${Date.now()}`;
const targetSession = `${runId}_target`;
const clientSession = `${runId}_client`;
const scratchDir = mkdtempSync(join(tmpdir(), `${runId}_scratch_`));
const stateHomes = [];
let stateHome = "";
const appLog = join(scratchDir, "tmux-ide-tui.log");

function fail(message) {
  throw new Error(message);
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function tmux(args, options = {}) {
  try {
    return await execFile("tmux", args, {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
      ...options,
    });
  } catch (error) {
    const stderr = error.stderr ? `\n${error.stderr}` : "";
    const stdout = error.stdout ? `\n${error.stdout}` : "";
    throw new Error(`tmux ${args.join(" ")} failed:${stderr}${stdout}`, { cause: error });
  }
}

async function cleanup() {
  for (const session of [clientSession, targetSession]) {
    if (!session.startsWith(runId)) continue;
    await execFile("tmux", ["kill-session", "-t", session]).catch(() => {});
  }
  rmSync(scratchDir, { recursive: true, force: true });
  for (const home of stateHomes) rmSync(home, { recursive: true, force: true });
}

async function commandExists(command, args) {
  try {
    await execFile(command, args, { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

function assertExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
  } catch {
    fail(`compiled TUI binary missing or not executable at ${path}; run pnpm build:tui`);
  }
}

async function seedMissionRepository(paneId) {
  const { MissionRepository } = await import(
    pathToFileURL(join(repoRoot, "packages/daemon/dist/lib/mission-repository.js")).href
  );
  const actor = { type: "user", id: "renderer-smoke" };
  const missions = await MissionRepository.open(repoRoot, { home: stateHome });
  missions.create({
    id: "mis_smoke_renderer",
    title: "Smoke renderer mission",
    objective: "Verify compiled Missions board detail and inspector frames",
    labels: ["smoke"],
    actor,
  });
  missions.startMission("mis_smoke_renderer", actor);
  missions.addTask({
    id: "tsk_smoke_renderer",
    missionId: "mis_smoke_renderer",
    title: "Render smoke task",
    description: "Exercise F6, c, x, z, arrows, Enter, and Escape in a compiled TUI.",
    priority: 2,
    assignee: "smoke-agent",
    actor,
  });
  missions.claimTask("mis_smoke_renderer", "tsk_smoke_renderer", "smoke-agent", actor);
  missions.startTask("mis_smoke_renderer", "tsk_smoke_renderer", actor);
  missions.startAttempt({
    id: "att_smoke_renderer",
    missionId: "mis_smoke_renderer",
    taskId: "tsk_smoke_renderer",
    agent: "smoke-agent",
    harness: "codex",
    model: "gpt-5",
    session: targetSession,
    terminal: paneId,
    actor,
  });
  missions.create({
    id: "mis_smoke_blocked",
    title: "Blocked smoke mission",
    objective: "Verify keyboard selection follows a zoomed lane",
    labels: ["smoke"],
    actor,
  });
  missions.startMission("mis_smoke_blocked", actor);
  missions.blockMission("mis_smoke_blocked", "Blocked for renderer smoke", actor);
}

async function startTargetSession() {
  await tmux([
    "new-session",
    "-d",
    "-s",
    targetSession,
    "-c",
    repoRoot,
    "printf 'tmux-ide smoke terminal ready\\n'; while :; do sleep 60; done",
  ]);
  const { stdout } = await tmux([
    "display-message",
    "-p",
    "-t",
    `${targetSession}:0.0`,
    "#{pane_id}",
  ]);
  return stdout.trim();
}

async function startClientSession(cols, rows) {
  const launcher = join(scratchDir, "launch-tui.sh");
  rmSync(appLog, { force: true });
  writeFileSync(
    launcher,
    [
      "#!/bin/sh",
      `export TMUX_IDE_CWD=${shQuote(repoRoot)}`,
      `export TMUX_IDE_HOME=${shQuote(stateHome)}`,
      `export TMUX_IDE_CLI=${shQuote(join(repoRoot, "bin/cli.js"))}`,
      `${shQuote(compiledTui)} app --target ${shQuote(targetSession)} 2>${shQuote(appLog)}`,
      "code=$?",
      `echo "tmux-ide-tui exited $code" >>${shQuote(appLog)}`,
      "sleep 300",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await tmux([
    "new-session",
    "-d",
    "-s",
    clientSession,
    "-x",
    String(cols),
    "-y",
    String(rows),
    "-c",
    scratchDir,
    launcher,
  ]);
}

async function captureFrame(rows) {
  const { stdout } = await tmux([
    "capture-pane",
    "-p",
    "-t",
    `${clientSession}:0.0`,
    "-S",
    "0",
    "-E",
    String(rows - 1),
  ]);
  const lines = stdout.endsWith("\n") ? stdout.slice(0, -1).split("\n") : stdout.split("\n");
  return lines.map((line) => line.replace(/\r$/u, ""));
}

function assertFrameBounds(lines, cols, rows, label) {
  if (lines.length !== rows) {
    fail(`${label}: expected ${rows} captured rows, got ${lines.length}`);
  }
  for (const [index, line] of lines.entries()) {
    const width = stringWidth(line);
    if (width > cols) {
      fail(`${label}: line ${index + 1} width ${width} exceeds ${cols}: ${line}`);
    }
  }
}

async function waitForFrame(rows, predicate, label) {
  const started = Date.now();
  let last = [];
  while (Date.now() - started < 10_000) {
    last = await captureFrame(rows);
    const text = last.join("\n");
    if (predicate(text)) return last;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  const log = (() => {
    try {
      return readFileSync(appLog, "utf8");
    } catch {
      return "(no app log)";
    }
  })();
  fail(`${label}: timed out waiting for frame; last frame:\n${last.join("\n")}\napp log:\n${log}`);
}

async function sendKeys(keys) {
  await tmux(["send-keys", "-t", `${clientSession}:0.0`, ...keys]);
}

async function stopClientSession() {
  await sendKeys(["C-q"]);
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    const log = (() => {
      try {
        return readFileSync(appLog, "utf8");
      } catch {
        return "";
      }
    })();
    if (log.includes("tmux-ide-tui exited 0")) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  const log = readFileSync(appLog, "utf8");
  if (!log.includes("tmux-ide-tui exited 0")) {
    fail(`Ctrl-Q did not stop the compiled TUI cleanly; app log:\n${log}`);
  }
  await tmux(["has-session", "-t", targetSession]);
  await tmux(["kill-session", "-t", clientSession]);
}

async function smokeSize(cols, rows) {
  await tmux(["resize-window", "-t", clientSession, "-x", String(cols), "-y", String(rows)]);
  await sendKeys(["F6"]);
  const board = await waitForFrame(
    rows,
    (text) =>
      text.includes("Smoke renderer") ||
      text.includes("mis_smoke_renderer") ||
      text.includes("Verify compiled Missions") ||
      text.includes("started 0/1 @smoke-agent"),
    `${cols}x${rows} board`,
  );
  assertFrameBounds(board, cols, rows, `${cols}x${rows} board`);

  if (!board.join("\n").includes("[board]")) fail(`${cols}x${rows}: board mode marker missing`);
  if (cols === 80 && board.join("\n").includes("agents:")) {
    fail("80x24: narrow smoke unexpectedly rendered a permanent inspector");
  }
  if (cols === 120 && !board.join("\n").includes("mis:")) {
    fail("120x40: medium smoke did not render compact inspector context");
  }
  if (cols === 200 && !board.join("\n").includes("mission: mis_smoke_renderer")) {
    fail("200x60: wide smoke did not render full inspector mission context");
  }

  await sendKeys(["c"]);
  await waitForFrame(rows, (text) => text.includes("c expand"), `${cols}x${rows} collapse`);
  await sendKeys(["x"]);
  await waitForFrame(rows, (text) => text.includes("x unzoom"), `${cols}x${rows} zoom`);
  await sendKeys(["z"]);
  await waitForFrame(rows, (text) => text.includes("z detailed"), `${cols}x${rows} density`);
  await sendKeys(["Right"]);
  const updated = await waitForFrame(
    rows,
    (text) => text.includes("Blocked smoke"),
    `${cols}x${rows} selection follow`,
  );
  assertFrameBounds(updated, cols, rows, `${cols}x${rows} interaction`);

  await sendKeys(["Enter"]);
  const detail = await waitForFrame(
    rows,
    (text) => text.includes("esc back"),
    `${cols}x${rows} detail`,
  );
  assertFrameBounds(detail, cols, rows, `${cols}x${rows} detail`);

  await sendKeys(["Escape"]);
  const back = await waitForFrame(rows, (text) => text.includes("[board]"), `${cols}x${rows} back`);
  assertFrameBounds(back, cols, rows, `${cols}x${rows} back`);

  await sendKeys(["C-c"]);
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  const afterCtrlC = await waitForFrame(
    rows,
    (text) => text.includes("[board]"),
    `${cols}x${rows} Ctrl-C keep-alive`,
  );
  assertFrameBounds(afterCtrlC, cols, rows, `${cols}x${rows} Ctrl-C keep-alive`);
}

try {
  if (!(await commandExists("tmux", ["-V"]))) fail("tmux is required for this smoke test");
  assertExecutable(compiledTui);
  const paneId = await startTargetSession();
  for (const [cols, rows] of [
    [80, 24],
    [120, 40],
    [200, 60],
  ]) {
    stateHome = mkdtempSync(join(tmpdir(), `${runId}_${cols}x${rows}_home_`));
    stateHomes.push(stateHome);
    await seedMissionRepository(paneId);
    await startClientSession(cols, rows);
    await waitForFrame(rows, (text) => text.includes("tmux-ide"), `${cols}x${rows} initial app`);
    await smokeSize(cols, rows);
    await stopClientSession();
  }
  console.log(
    "Missions compiled TUI smoke passed: 80x24, 120x40, 200x60; Ctrl-C kept alive; Ctrl-Q exited cleanly",
  );
} finally {
  await cleanup();
}
