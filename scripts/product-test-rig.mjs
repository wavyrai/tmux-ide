#!/usr/bin/env node

/**
 * One real-product test rig: private tmux + one daemon + real TUI + real Web.
 * It is deliberately an operator/test surface, not a second product runtime.
 */
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  startDaemon,
  waitForReadinessLadder,
} from "../apps/desktop-renderer/e2e/fixtures/daemon.ts";
import { startDevServer } from "../apps/desktop-renderer/e2e/fixtures/dev-server.ts";
import { createScratchFleet } from "../apps/desktop-renderer/e2e/fixtures/scratch-fleet.ts";
import {
  PRODUCT_RIG_STATE_VERSION,
  coherentReadiness,
  processAlive,
  publicRigStatus,
  readJson,
  writeJsonAtomic,
} from "./product-test-rig-lib.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = await import(
  fileURLToPath(
    new URL("../apps/desktop-renderer/node_modules/playwright/index.mjs", import.meta.url),
  )
);
const rigRoot = resolve(
  process.env.TMUX_IDE_PRODUCT_RIG_DIR || join(repoRoot, ".tasks", "product-test-rig"),
);
const statePath = join(rigRoot, "state.json");
const timelinePath = join(rigRoot, "timeline.jsonl");
const ownerLogPath = join(rigRoot, "owner.log");
const artifactDir = join(rigRoot, "artifacts");

function usage() {
  return `Product test rig\n\nUsage:\n  pnpm product:testdrive start [--json]\n  pnpm product:testdrive status [--json]\n  pnpm product:testdrive capture [--json]\n  pnpm product:testdrive smoke [--json]\n  pnpm product:testdrive stop [--json]\n`;
}

function emit(value, json) {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${value}\n`);
}

function event(phase, detail = {}) {
  const entry = {
    at: new Date().toISOString(),
    elapsedMs: Date.now() - ownerStartedAt,
    phase,
    ...detail,
  };
  writeFileSync(timelinePath, `${JSON.stringify(entry)}\n`, { flag: "a", mode: 0o600 });
  return entry;
}

function commandEnv(state) {
  return {
    ...process.env,
    TMUX_IDE_TESTDRIVE_RUNTIME_DIR: state.tui.runtimeDir,
    TMUX_IDE_TESTDRIVE_HOST_SESSION: state.tui.hostSession,
    TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH: state.runtimeNamespace.tmuxSocketPath,
    TMUX_IDE_TESTDRIVE_USE_CANONICAL_DAEMON: "1",
    TMUX_IDE_TESTDRIVE_CANONICAL_HOME: state.runtimeNamespace.daemonInfoDir,
  };
}

function tuiCommand(state, args, options = {}) {
  return execFileSync(process.execPath, [join(repoRoot, "scripts", "tui-testdrive.mjs"), ...args], {
    cwd: repoRoot,
    env: commandEnv(state),
    encoding: "utf8",
    stdio: options.ignore ? "ignore" : ["ignore", "pipe", "pipe"],
  });
}

function tmuxTruth(state) {
  const socket = state.runtimeNamespace.tmuxSocketPath;
  const session = state.session;
  const format =
    "#{session_name}|#{window_id}|#{window_name}|#{window_width}x#{window_height}|#{window_layout}";
  const windows = execFileSync(
    "tmux",
    ["-S", socket, "list-windows", "-t", `=${session}`, "-F", format],
    {
      encoding: "utf8",
    },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  const panes = execFileSync(
    "tmux",
    [
      "-S",
      socket,
      "list-panes",
      "-s",
      "-t",
      `=${session}`,
      "-F",
      "#{pane_id}|#{window_id}|#{pane_width}x#{pane_height}|#{pane_active}",
    ],
    {
      encoding: "utf8",
    },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  return { session, windows, panes };
}

async function captureArtifacts(state, label = "capture", existingPage = null) {
  mkdirSync(artifactDir, { recursive: true });
  const suffix = `${label}-${Date.now()}`;
  const tuiText = tuiCommand(state, ["capture", "--ansi", "--history", "80"]);
  const tuiStatus = JSON.parse(tuiCommand(state, ["status", "--json"]));
  const tuiPath = join(artifactDir, `${suffix}-tui.ansi.txt`);
  await writeFile(tuiPath, tuiText, "utf8");
  const truth = tmuxTruth(state);
  const tmuxPath = join(artifactDir, `${suffix}-tmux.json`);
  await writeFile(tmuxPath, `${JSON.stringify(truth, null, 2)}\n`, "utf8");

  const captureBrowser = existingPage ? null : await chromium.launch({ headless: true });
  try {
    const page =
      existingPage ?? (await captureBrowser.newPage({ viewport: { width: 1440, height: 900 } }));
    if (!existingPage) {
      await page.goto(state.web.pageUrl, { waitUntil: "domcontentloaded" });
      await page.locator(".app[data-shell-source='runtime']").waitFor({ timeout: 60_000 });
      await page
        .locator(".terminal-surface[data-phase='connected']")
        .first()
        .waitFor({ timeout: 60_000 });
    }
    const webPath = join(artifactDir, `${suffix}-web.png`);
    await page.screenshot({ path: webPath, fullPage: true });
    const web = await page.evaluate(() => ({
      title: globalThis.document.title,
      shellSource:
        globalThis.document.querySelector(".app")?.getAttribute("data-shell-source") ?? null,
      terminalPhases: [...globalThis.document.querySelectorAll(".terminal-surface")].map((node) =>
        node.getAttribute("data-phase"),
      ),
      text: globalThis.document.body.innerText.slice(0, 4_000),
    }));
    const webStatePath = join(artifactDir, `${suffix}-web.json`);
    await writeFile(webStatePath, `${JSON.stringify(web, null, 2)}\n`, "utf8");
    event("capture", { label, tuiPath, tmuxPath, webPath, webStatePath });
    return { label, tuiPath, tmuxPath, webPath, webStatePath, truth, web, tuiStatus };
  } finally {
    await captureBrowser?.close();
  }
}

async function waitForState(predicate, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let state = null;
  while (Date.now() < deadline) {
    state = readJson(statePath);
    if (state?.status === "failed") throw new Error(state.failure || "product rig failed");
    if (predicate(state)) return state;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`timed out waiting for product rig (${state?.status ?? "no state"})`);
}

async function start(json) {
  const existing = readJson(statePath);
  if (existing && processAlive(existing.ownerPid)) {
    emit(json ? publicRigStatus(existing) : `Product rig already ${existing.status}`, json);
    return;
  }
  rmSync(rigRoot, { recursive: true, force: true });
  mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  chmodSync(rigRoot, 0o700);
  const log = openSync(ownerLogPath, "a", 0o600);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "__owner"], {
    cwd: repoRoot,
    env: process.env,
    detached: true,
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  child.unref();
  const state = await waitForState((candidate) => candidate?.status === "ready");
  emit(
    json ? publicRigStatus(state) : `Product rig ready: ${state.session} · ${state.web.pageUrl}`,
    json,
  );
}

async function stop(json) {
  const state = readJson(statePath);
  if (state && processAlive(state.ownerPid)) process.kill(state.ownerPid, "SIGTERM");
  await waitForState((candidate) => !candidate || candidate.status === "stopped", 15_000).catch(
    () => undefined,
  );
  const finalState = readJson(statePath);
  emit(json ? publicRigStatus(finalState) : "Product rig stopped", json);
}

async function capture(json, label = "manual") {
  const state = await waitForState((candidate) => candidate?.status === "ready", 5_000);
  const result = await captureArtifacts(state, label);
  emit(json ? result : `Captured ${result.webPath}`, json);
}

async function smoke(json) {
  await start(false);
  const state = await waitForState((candidate) => candidate?.status === "ready");
  const before = tmuxTruth(state);
  tuiCommand(state, ["resize", "132", "38"]);
  await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  const result = await captureArtifacts(state, "smoke");
  const tuiText = readFileSync(result.tuiPath, "utf8");
  const windowNames = result.truth.windows.map((entry) => entry.split("|")[2]);
  const evidence = {
    passed:
      result.web.shellSource === "runtime" &&
      result.web.text.includes(state.session) &&
      tuiText.includes(state.session) &&
      result.truth.session === state.session &&
      result.tuiStatus.daemon?.instanceId === state.daemon.instanceId &&
      windowNames.every((name) => result.web.text.includes(name) && tuiText.includes(name)),
    daemonGeneration: state.daemon.instanceId,
    session: state.session,
    before,
    after: result.truth,
    readiness: state.tui.readiness,
    artifacts: result,
  };
  const reportPath = join(artifactDir, "smoke-report.json");
  await writeFile(reportPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  if (!evidence.passed) throw new Error(`product smoke failed; see ${reportPath}`);
  emit(json ? { ...evidence, reportPath } : `Product smoke passed; ${reportPath}`, json);
}

let ownerStartedAt = Date.now();
async function owner() {
  ownerStartedAt = Date.now();
  const slug = randomBytes(3).toString("hex");
  let fleet = null;
  let daemon = null;
  let devServer = null;
  let browser = null;
  let closing = false;
  let state = {
    version: PRODUCT_RIG_STATE_VERSION,
    status: "starting",
    ownerPid: process.pid,
    artifactDir,
    timelinePath,
  };
  const publish = (patch) => {
    state = { ...state, ...patch };
    writeJsonAtomic(statePath, state);
  };
  const cleanup = async () => {
    if (closing) return;
    closing = true;
    event("cleanup-start");
    try {
      if (state.tui) tuiCommand(state, ["stop"], { ignore: true });
    } catch {
      // The hosted TUI may already have stopped independently.
    }
    await browser?.close().catch(() => undefined);
    await devServer?.stop().catch(() => undefined);
    await daemon?.stop().catch(() => undefined);
    await fleet?.dispose().catch(() => undefined);
    publish({
      status: state.status === "failed" ? "failed" : "stopped",
      stoppedAt: new Date().toISOString(),
      web: null,
    });
    event("cleanup-complete");
  };
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => void cleanup().finally(() => process.exit(0)));
  }

  try {
    rmSync(timelinePath, { force: true });
    event("namespace-start");
    const scratchFleet = await createScratchFleet({ sessions: 1, slug });
    const cleanupToken = `product-test-rig:${slug}`;
    fleet = {
      ...scratchFleet,
      environment: {
        ...scratchFleet.environment,
        TMUX_IDE_RUNTIME_MODE: "testdrive",
        TMUX_IDE_CLEANUP_TOKEN: cleanupToken,
        TMUX_IDE_TMUX_SOCKET_PATH: scratchFleet.socketPath,
      },
    };
    const session = fleet.sessionNames[0];
    const runtimeNamespace = {
      root: fleet.root,
      tmuxSocketPath: fleet.socketPath,
      daemonInfoDir: fleet.daemonInfoDir,
      cleanupToken,
    };
    const tui = {
      hostSession: `_tmux-ide-product-rig-${slug}`,
      runtimeDir: join(rigRoot, "tui"),
    };
    publish({ session, runtimeNamespace, tui });
    event("tmux-ready", { session, socketPath: fleet.socketPath });

    daemon = await startDaemon(fleet);
    const workspace = await daemon.promote(session);
    await waitForReadinessLadder(daemon);
    publish({ daemon: daemon.record, workspace });
    event("daemon-ready", { instanceId: daemon.record.instanceId, workspace });

    devServer = await startDevServer(daemon);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const webStartedAt = Date.now();
    await page.goto(devServer.pageUrl, { waitUntil: "domcontentloaded" });
    await page.locator(".app[data-shell-source='runtime']").waitFor({ timeout: 60_000 });
    await page
      .locator(".terminal-surface[data-phase='connected']")
      .first()
      .waitFor({ timeout: 60_000 });
    const webCoherentTerminalFrameMs = Date.now() - webStartedAt;
    publish({
      web: {
        pageUrl: devServer.pageUrl,
        coherentTerminalFrameMs: webCoherentTerminalFrameMs,
      },
    });
    event("web-coherent-terminal-frame", { elapsedFromWebStartMs: webCoherentTerminalFrameMs });

    await execFileAsync("bun", [join(repoRoot, "scripts", "build-tui.mjs")], {
      cwd: repoRoot,
      timeout: 120_000,
    });
    tuiCommand(state, ["start", "--target", session, "--cols", "160", "--rows", "44"]);
    tuiCommand(state, ["key", "F2"]);
    const tuiStartedAt = Date.now();
    let tuiStatus = null;
    for (;;) {
      tuiStatus = JSON.parse(tuiCommand(state, ["status", "--json"]));
      if (tuiStatus.readiness?.coherentTerminalFrameMs !== null) break;
      if (Date.now() - tuiStartedAt > 30_000)
        throw new Error("TUI did not reach a coherent terminal frame");
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    const readiness = coherentReadiness({
      chromeMs: tuiStatus.readiness.appChromeFrameMs,
      terminalMs: tuiStatus.readiness.coherentTerminalFrameMs,
    });
    publish({ tui: { ...tui, readiness } });
    event("tui-coherent-terminal-frame", readiness);
    await captureArtifacts(state, "boot", page);
    publish({ status: "ready", readyAt: new Date().toISOString() });
    await new Promise(() => undefined);
  } catch (error) {
    publish({ status: "failed", failure: error instanceof Error ? error.stack : String(error) });
    event("failed", { failure: error instanceof Error ? error.message : String(error) });
    await cleanup();
    process.exitCode = 1;
  }
}

const [command = "status", ...args] = process.argv.slice(2);
const json = args.includes("--json");
try {
  if (command === "__owner") await owner();
  else if (command === "start") await start(json);
  else if (command === "status")
    emit(
      json
        ? publicRigStatus(readJson(statePath))
        : JSON.stringify(publicRigStatus(readJson(statePath)), null, 2),
      json,
    );
  else if (command === "capture") await capture(json);
  else if (command === "smoke") await smoke(json);
  else if (command === "stop") await stop(json);
  else if (["help", "--help", "-h"].includes(command)) process.stdout.write(usage());
  else throw new Error(`unknown command ${command}\n\n${usage()}`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
