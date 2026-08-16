#!/usr/bin/env node

/**
 * One real-product test rig: private tmux + one daemon + real TUI + real Web.
 * It is deliberately an operator/test surface, not a second product runtime.
 */
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  watch,
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
  PRODUCT_RIG_SOURCE_DIFF_MAX_BYTES,
  PRODUCT_RIG_STATE_VERSION,
  activeTmuxPaneFromRows,
  boundedSourceTraceDiff,
  buildProductDiagnosticReport,
  coherentGenerationPaint,
  coherentGenerationDuration,
  coherentReadiness,
  inputPaintSamples,
  paneBodyRegion,
  paneGeometryIdentity,
  processAlive,
  publicRigStatus,
  readJson,
  resolvePaneBodyRect,
  summarizeProductResources,
  writeJsonAtomic,
} from "./product-test-rig-lib.mjs";
import { sourceArchitectureInventory } from "./architecture-debt-inventory.mjs";

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
const WARM_COHERENT_SAMPLE_COUNT = 20;

function usage() {
  return `Product test rig\n\nUsage:\n  pnpm product:testdrive start [--json]\n  pnpm product:testdrive status [--json]\n  pnpm product:testdrive capture [--json]\n  pnpm product:testdrive smoke [--json]\n  pnpm product:testdrive diagnose [--json]\n  pnpm product:testdrive inventory [--json]\n  pnpm product:testdrive stop [--json]\n`;
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
    // The observer host is deliberately isolated from the product tmux
    // server. Test-drive capture/status/key traffic must never queue ahead of
    // the daemon's control-mode reads and writes on the server being measured.
    TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH: state.runtimeNamespace.hostTmuxSocketPath,
    // The host and target intentionally share the private product-rig server.
    // Canonical-daemon mode still needs the product process itself to resolve
    // tmux through that exact socket instead of silently discovering the
    // user's default server.
    TMUX_IDE_TMUX_SOCKET_PATH: state.runtimeNamespace.tmuxSocketPath,
    TMUX_IDE_TESTDRIVE_USE_CANONICAL_DAEMON: "1",
    TMUX_IDE_TESTDRIVE_CANONICAL_HOME: state.runtimeNamespace.daemonInfoDir,
    ...(state.tui.performanceTracePath
      ? {
          TMUX_IDE_PERFORMANCE_TRACE_LOG: state.tui.performanceTracePath,
          TMUX_IDE_PERFORMANCE_TRACE_COMMIT: state.tui.performanceTraceCommit,
          TMUX_IDE_PERFORMANCE_TRACE_TREE: state.tui.performanceTraceTree,
        }
      : {}),
  };
}

function readJsonLines(path) {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function sourceTraceProvenance() {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  let diff;
  try {
    diff = execFileSync("git", ["diff", "--binary", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      // Leave a small decode/error margin above the explicit product ceiling.
      maxBuffer: PRODUCT_RIG_SOURCE_DIFF_MAX_BYTES + 64 * 1024,
    });
  } catch (error) {
    if (error?.code === "ENOBUFS") {
      throw new Error(
        `Product rig source diff exceeded the ${PRODUCT_RIG_SOURCE_DIFF_MAX_BYTES}-byte hard ceiling`,
        { cause: error },
      );
    }
    throw error;
  }
  boundedSourceTraceDiff(diff);
  const tree = execFileSync("git", ["hash-object", "--stdin"], {
    cwd: repoRoot,
    input: diff,
    encoding: "utf8",
  }).trim();
  return { commit, tree };
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

function activeTmuxPane(state) {
  const rows = execFileSync(
    "tmux",
    [
      "-S",
      state.runtimeNamespace.tmuxSocketPath,
      "list-panes",
      "-s",
      "-t",
      `=${state.session}`,
      "-F",
      "#{pane_id}|#{window_active}|#{pane_active}|#{@tmux_ide_pane_id}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}",
    ],
    { encoding: "utf8" },
  );
  const pane = activeTmuxPaneFromRows(rows);
  if (!pane) throw new Error("product rig could not resolve one active stamped tmux pane");
  return pane;
}

function activeVerticalResizeSeparator(state) {
  const panes = execFileSync(
    "tmux",
    [
      "-S",
      state.runtimeNamespace.tmuxSocketPath,
      "list-panes",
      "-t",
      `=${state.session}:`,
      "-F",
      "#{pane_id}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}",
    ],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [paneId, left, top, width, height] = line.split("|");
      return {
        paneId,
        left: Number(left),
        top: Number(top),
        width: Number(width),
        height: Number(height),
      };
    });
  for (const before of panes) {
    const after = panes.find(
      (candidate) =>
        candidate.left === before.left + before.width + 1 &&
        Math.max(before.top, candidate.top) <
          Math.min(before.top + before.height, candidate.top + candidate.height),
    );
    if (!after) continue;
    return {
      paneId: before.paneId,
      width: before.width,
      x: before.left + before.width,
      y:
        2 +
        Math.floor(
          (Math.max(before.top, after.top) +
            Math.min(before.top + before.height, after.top + after.height)) /
            2,
        ),
    };
  }
  return null;
}

function activeWindowPaneGeometry(state) {
  return execFileSync(
    "tmux",
    [
      "-S",
      state.runtimeNamespace.tmuxSocketPath,
      "list-panes",
      "-s",
      "-t",
      `=${state.session}`,
      "-F",
      "#{pane_id}|#{window_active}|#{@tmux_ide_pane_id}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}",
    ],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [paneId, windowActive, semanticPaneId, left, top, width, height] = line.split("|");
      return {
        paneId,
        semanticPaneId,
        windowActive: windowActive === "1",
        left: Number(left),
        top: Number(top),
        width: Number(width),
        height: Number(height),
      };
    })
    .filter(({ paneId, windowActive }) => Boolean(paneId) && windowActive);
}

async function activePaneBodyEvidence(state) {
  const panes = activeWindowPaneGeometry(state);
  const nonce = randomBytes(4).toString("hex");
  const markers = panes.map((pane, ordinal) => ({
    ...pane,
    marker: `__tmi_pane_${ordinal}_${nonce}__`,
  }));
  for (const { paneId, marker } of markers)
    execFileSync(
      "tmux",
      ["-S", state.runtimeNamespace.tmuxSocketPath, "send-keys", "-t", paneId, "-l", marker],
      { encoding: "utf8" },
    );
  let frame = "";
  let evidence;
  let sampleOrdinal = 0;
  const deadline = Date.now() + 5_000;
  do {
    sampleOrdinal += 1;
    const geometryBefore = activeWindowPaneGeometry(state);
    const geometryIdentityBefore = paneGeometryIdentity(geometryBefore);
    frame = tuiCommand(state, ["capture"]);
    const nativeBodies = new Map(
      markers.map((pane) => [
        pane.paneId,
        execFileSync(
          "tmux",
          [
            "-S",
            state.runtimeNamespace.tmuxSocketPath,
            "capture-pane",
            "-p",
            "-J",
            "-t",
            pane.paneId,
          ],
          { encoding: "utf8" },
        ),
      ]),
    );
    const geometryAfter = activeWindowPaneGeometry(state);
    const geometryIdentityAfter = paneGeometryIdentity(geometryAfter);
    const sampleStable = geometryIdentityBefore === geometryIdentityAfter;
    const geometryByPane = new Map(geometryAfter.map((pane) => [pane.paneId, pane]));
    evidence = markers.map((pane) => {
      const geometry = geometryByPane.get(pane.paneId) ?? pane;
      const rectangle = { ...geometry, semanticPaneId: pane.semanticPaneId };
      const nativeBody = nativeBodies.get(pane.paneId) ?? "";
      const renderedBody = paneBodyRegion(frame, rectangle);
      const renderedBodyRect = resolvePaneBodyRect(frame, rectangle);
      return {
        paneId: pane.paneId,
        semanticPaneId: pane.semanticPaneId,
        markerHash: createHash("sha256").update(pane.marker).digest("hex"),
        nativeBodyHash: createHash("sha256").update(nativeBody).digest("hex"),
        renderedBodyHash: createHash("sha256").update(renderedBody).digest("hex"),
        renderedBodyRect,
        sample: {
          ordinal: sampleOrdinal,
          stableGeometry: sampleStable,
          geometryIdentityBefore,
          geometryIdentityAfter,
          geometry,
          hostFrameHash: createHash("sha256").update(frame).digest("hex"),
        },
        markerVisibleInNative: sampleStable && nativeBody.includes(pane.marker),
        markerVisibleInPaneRect:
          sampleStable && renderedBodyRect.valid && renderedBody.includes(pane.marker),
      };
    });
    if (evidence.every((entry) => entry.markerVisibleInNative && entry.markerVisibleInPaneRect))
      break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  } while (Date.now() < deadline);
  for (const { paneId } of markers)
    execFileSync(
      "tmux",
      ["-S", state.runtimeNamespace.tmuxSocketPath, "send-keys", "-t", paneId, "C-u"],
      { encoding: "utf8" },
    );
  return {
    passed:
      evidence.length > 0 &&
      evidence.every((entry) => entry.markerVisibleInNative && entry.markerVisibleInPaneRect),
    detail: `${evidence.filter(({ markerVisibleInPaneRect }) => markerVisibleInPaneRect).length}/${evidence.length} active-window pane rectangles contain their unique marker`,
    panes: evidence,
  };
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

async function firstAttachablePane(daemon, session) {
  const response = await fetch(
    `${daemon.baseUrl}/api/project/${encodeURIComponent(session)}/application-shell?version=3`,
    { headers: { Authorization: `Bearer ${daemon.record.authToken}` } },
  );
  if (!response.ok) throw new Error(`application-shell answered ${response.status}`);
  const body = await response.json();
  const resources = body?.resource?.terminalInventory?.resources ?? [];
  const available = resources.find(
    (resource) =>
      resource?.attachability?.status === "available" && resource?.attachability?.semanticPaneId,
  );
  if (!available) throw new Error("product rig found no attachable semantic pane");
  return available.attachability.semanticPaneId;
}

async function fleetSessionId(daemon, label) {
  const response = await fetch(`${daemon.baseUrl}/api/resources/fleet-catalog`, {
    headers: { Authorization: `Bearer ${daemon.record.authToken}` },
  });
  if (!response.ok) throw new Error(`fleet-catalog answered ${response.status}`);
  const body = await response.json();
  const session = body?.sessions?.find((entry) => entry?.label === label);
  if (!session?.sessionId) throw new Error(`fleet catalog has no canonical id for ${label}`);
  return session.sessionId;
}

async function proveMultiClientConvergence(
  state,
  daemon,
  { previousGeneration = null, allowRestartPending = false } = {},
) {
  const pane = await firstAttachablePane(daemon, state.session);
  const sessionId = await fleetSessionId(daemon, state.session);
  const startedAt = Date.now();
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      "bun",
      [join(repoRoot, "scripts", "product-test-rig-multiclient.ts")],
      {
        cwd: repoRoot,
        timeout: 30_000,
        env: {
          ...process.env,
          TMUX_IDE_RIG_BASE_URL: daemon.baseUrl,
          TMUX_IDE_RIG_OWNER_TOKEN: daemon.record.authToken,
          TMUX_IDE_RIG_GENERATION: daemon.record.instanceId,
          TMUX_IDE_RIG_WORKSPACE: state.workspace,
          TMUX_IDE_RIG_PANE: pane,
          TMUX_IDE_RIG_SESSION: state.session,
          TMUX_IDE_RIG_SESSION_ID: sessionId,
          TMUX_IDE_RIG_TMUX_SOCKET: state.runtimeNamespace.tmuxSocketPath,
          TMUX_IDE_RIG_WEB_ORIGIN: new URL(state.web.pageUrl).origin,
          ...(previousGeneration ? { TMUX_IDE_RIG_PREVIOUS_GENERATION: previousGeneration } : {}),
        },
      },
    ));
  } catch (error) {
    const detail = [error?.stdout, error?.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`multi-client convergence command failed${detail ? `:\n${detail}` : ""}`, {
      cause: error,
    });
  }
  const report = JSON.parse(stdout.trim().split("\n").at(-1));
  const incomplete = Object.entries(report.requirements ?? {}).filter(
    ([name, result]) =>
      (!allowRestartPending || name !== "daemonRestartRecovery") &&
      (result?.passed !== true || result?.skipped !== false),
  );
  if (
    report.status !== "passed" ||
    report.generation !== daemon.record.instanceId ||
    incomplete.length > 0
  ) {
    throw new Error(`multi-client convergence failed: ${stdout}`);
  }
  event("multi-client-convergence", {
    elapsedMs: Date.now() - startedAt,
    report,
  });
  return report;
}

async function start(json, quiet = false) {
  const existing = readJson(statePath);
  if (existing && processAlive(existing.ownerPid)) {
    if (!quiet)
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
  if (!quiet)
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
  await start(false, true);
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

async function waitForTuiLifecycleEntry(state, predicate, timeoutMs, timeoutMessage) {
  const lifecyclePath = join(state.tui.runtimeDir, "performance.jsonl");
  const startedAt = performance.now();
  const findEntry = () => readJsonLines(lifecyclePath).findLast(predicate) ?? null;
  const existing = findEntry();
  if (existing) return existing;

  return await new Promise((resolveWait, rejectWait) => {
    let settled = false;
    let checking = false;
    let timer = null;
    let watcher = null;
    const finish = (error, entry = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      watcher?.close();
      if (error) rejectWait(error);
      else resolveWait(entry);
    };
    const armDeadline = () => {
      const remainingMs = timeoutMs - (performance.now() - startedAt);
      if (remainingMs <= 0) {
        finish(new Error(timeoutMessage));
        return;
      }
      timer = setTimeout(armDeadline, Math.ceil(remainingMs));
    };
    const check = () => {
      if (checking || settled) return;
      checking = true;
      try {
        const entry = findEntry();
        if (entry) finish(null, entry);
      } finally {
        checking = false;
      }
    };
    try {
      // `tui-testdrive start` has already created this generation's lifecycle
      // file before returning. Observe that inode directly instead of spawning
      // a Node status process every 25 ms and perturbing the runtime under test.
      watcher = watch(lifecyclePath, { persistent: false }, check);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    armDeadline();
    // Close the subscribe/read race without a retry loop.
    check();
  });
}

async function waitForCoherentTui(state, timeoutMs = 30_000, expectedProcessId = null) {
  await waitForTuiLifecycleEntry(
    state,
    (entry) =>
      entry?.phase === "first-terminal-frame" &&
      entry?.daemonGeneration === state.daemon.instanceId &&
      (expectedProcessId === null || entry?.processId === `opentui:${expectedProcessId}`),
    timeoutMs,
    "diagnostic TUI did not reach a coherent terminal frame",
  );
  return JSON.parse(tuiCommand(state, ["status", "--json"]));
}

async function proveHostTerminalPublication(state, label, timeoutMs = 5_000) {
  const { paneId } = activeTmuxPane(state);
  const marker = `TMI_HOST_${label.replaceAll(/[^a-zA-Z0-9]/gu, "_")}_${randomBytes(4).toString("hex")}`;
  const markerCommand = `printf '%s\\n' '${marker}'`;
  execFileSync(
    "tmux",
    ["-S", state.runtimeNamespace.tmuxSocketPath, "send-keys", "-t", paneId, "C-u"],
    { encoding: "utf8" },
  );
  execFileSync(
    "tmux",
    ["-S", state.runtimeNamespace.tmuxSocketPath, "send-keys", "-t", paneId, "-l", markerCommand],
    { encoding: "utf8" },
  );
  execFileSync(
    "tmux",
    ["-S", state.runtimeNamespace.tmuxSocketPath, "send-keys", "-t", paneId, "Enter"],
    { encoding: "utf8" },
  );
  let frame = "";
  let nativeFrame = "";
  const observationStartedAt = performance.now();
  const deadline = performance.now() + timeoutMs;
  try {
    while (performance.now() < deadline) {
      frame = tuiCommand(state, ["capture"]);
      nativeFrame = execFileSync(
        "tmux",
        ["-S", state.runtimeNamespace.tmuxSocketPath, "capture-pane", "-p", "-t", paneId],
        { encoding: "utf8" },
      );
      if (frame.includes(marker) && nativeFrame.includes(marker)) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    const suffix = `${label}-${Date.now()}`;
    mkdirSync(artifactDir, { recursive: true });
    const framePath = join(artifactDir, `${suffix}-host-frame.txt`);
    const nativeFramePath = join(artifactDir, `${suffix}-native-frame.txt`);
    const lifecyclePath = join(artifactDir, `${suffix}-lifecycle.jsonl`);
    await writeFile(framePath, frame, "utf8");
    await writeFile(nativeFramePath, nativeFrame, "utf8");
    await writeFile(
      lifecyclePath,
      existsSync(join(state.tui.runtimeDir, "performance.jsonl"))
        ? readFileSync(join(state.tui.runtimeDir, "performance.jsonl"), "utf8")
        : "",
      "utf8",
    );
    if (!frame.includes(marker) || !nativeFrame.includes(marker)) {
      throw new Error(
        `host PTY publication ${label} timed out (native=${nativeFrame.includes(marker)}, host=${frame.includes(marker)}); artifacts: ${framePath}, ${nativeFramePath}, ${lifecyclePath}`,
      );
    }
    const lifecycle = readJsonLines(join(state.tui.runtimeDir, "performance.jsonl"));
    const rendererPaint = lifecycle.findLast(
      (entry) =>
        entry?.phase === "first-terminal-frame" &&
        entry?.daemonGeneration === state.daemon.instanceId,
    );
    if (!Number.isFinite(rendererPaint?.elapsedMs))
      throw new Error(`host PTY publication ${label} has no generation-fenced renderer mark`);
    const publication = JSON.parse(
      tuiCommand(state, [
        "publication",
        "terminal",
        "--token",
        marker,
        "--generation",
        state.daemon.instanceId,
        "--elapsed-ms",
        String(rendererPaint.elapsedMs + (performance.now() - observationStartedAt)),
        "--json",
      ]),
    );
    const evidencePath = join(artifactDir, `${suffix}-host-publication.json`);
    await writeFile(
      evidencePath,
      `${JSON.stringify(
        {
          ...publication,
          label,
          paneId,
          markerHash: createHash("sha256").update(marker).digest("hex"),
          nativeVisible: true,
          framePath,
          nativeFramePath,
          lifecyclePath,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return Object.freeze({
      ...publication,
      label,
      paneId,
      markerHash: createHash("sha256").update(marker).digest("hex"),
      nativeVisible: true,
      framePath,
      nativeFramePath,
      lifecyclePath,
      evidencePath,
    });
  } finally {
    try {
      execFileSync(
        "tmux",
        ["-S", state.runtimeNamespace.tmuxSocketPath, "send-keys", "-t", paneId, "C-l"],
        { encoding: "utf8" },
      );
    } catch {
      // A failed rig may already have retired the private fleet.
    }
  }
}

async function preserveWarmRehostFailure(state, ordinal, error) {
  const suffix = `warm-rehost-${ordinal}-failure-${Date.now()}`;
  mkdirSync(artifactDir, { recursive: true });
  const framePath = join(artifactDir, `${suffix}-host-frame.txt`);
  const lifecyclePath = join(artifactDir, `${suffix}-lifecycle.jsonl`);
  const evidencePath = join(artifactDir, `${suffix}.json`);
  let frame = "";
  try {
    frame = tuiCommand(state, ["capture"]);
  } catch {
    // A failed host may already have retired its exact tmux pane.
  }
  const lifecycle = existsSync(join(state.tui.runtimeDir, "performance.jsonl"))
    ? readFileSync(join(state.tui.runtimeDir, "performance.jsonl"), "utf8")
    : "";
  await Promise.all([
    writeFile(framePath, frame, "utf8"),
    writeFile(lifecyclePath, lifecycle, "utf8"),
    writeFile(
      evidencePath,
      `${JSON.stringify(
        {
          ordinal,
          error: error instanceof Error ? error.message : String(error),
          chromeVisible: frame.includes("tmux-ide"),
          frameBytes: Buffer.byteLength(frame),
          frameHash: createHash("sha256").update(frame).digest("hex"),
          framePath,
          lifecyclePath,
        },
        null,
        2,
      )}\n`,
      "utf8",
    ),
  ]);
  return evidencePath;
}

function coherentGenerationJourney(lifecycle) {
  const painted = coherentGenerationPaint(lifecycle);
  if (!painted) return null;
  const generation = painted.daemonGeneration;
  // Each test-drive rehost owns a fresh lifecycle file. Runtime progress and
  // shell lifecycle records are process-local and intentionally omit the
  // daemon generation; the connection/paint endpoints fence this journey.
  const entries = lifecycle.filter((entry) => Number.isFinite(entry?.elapsedMs));
  const pickEntry = (predicate) => entries.find(predicate) ?? null;
  const pick = (predicate) => pickEntry(predicate)?.elapsedMs ?? null;
  const connectionMs = pick((entry) => entry.phase === "generation-connection-resolved");
  const entryStartMs = pick((entry) => entry.phase === "entry-start");
  const shellStaleMs = pick(
    (entry) => entry.phase === "generation-shell-lifecycle" && entry.clientPhase === "stale",
  );
  const shellLiveMs = pick(
    (entry) =>
      entry.phase === "generation-shell-lifecycle" &&
      entry.clientPhase === "live" &&
      entry.shellStatus === "live",
  );
  const physicalReadyMs = pick(
    (entry) =>
      entry.phase === "generation-runtime-progress" && entry.runtimePhase === "physical-ready",
  );
  const streamIssueStartEntry = pickEntry(
    (entry) =>
      entry.phase === "generation-runtime-progress" && entry.runtimePhase === "stream-issue-start",
  );
  const streamIssueStartMs = streamIssueStartEntry?.elapsedMs ?? null;
  const streamIssueResponseMs = pick(
    (entry) =>
      entry.phase === "generation-runtime-progress" &&
      entry.runtimePhase === "stream-issue-response",
  );
  const streamSocketCreatedMs = pick(
    (entry) =>
      entry.phase === "generation-runtime-progress" &&
      entry.runtimePhase === "stream-socket-created",
  );
  const streamSocketOpenMs = pick(
    (entry) =>
      entry.phase === "generation-runtime-progress" && entry.runtimePhase === "stream-socket-open",
  );
  const streamReadyFrameMs = pick(
    (entry) =>
      entry.phase === "generation-runtime-progress" && entry.runtimePhase === "stream-ready-frame",
  );
  const streamOpenResolvedMs = pick(
    (entry) =>
      entry.phase === "generation-runtime-progress" &&
      entry.runtimePhase === "stream-open-resolved",
  );
  const coherentMs = pick(
    (entry) => entry.phase === "generation-runtime-progress" && entry.runtimePhase === "coherent",
  );
  const segment = (start, end) =>
    Number.isFinite(start) && Number.isFinite(end) ? end - start : null;
  return Object.freeze({
    generation,
    streamRequestId: streamIssueStartEntry?.requestId ?? null,
    // Keep the process/host boundary visible beside the warm connection gate.
    // `elapsedMs` is launch-epoch based, while entry-start identifies the
    // first mark emitted by the fresh TUI process.
    launchToHostMs: painted.elapsedMs,
    entryToHostMs: segment(entryStartMs, painted.elapsedMs),
    totalMs: segment(connectionMs, painted.elapsedMs),
    marks: Object.freeze({
      entryStartMs,
      connectionMs,
      shellStaleMs,
      shellLiveMs,
      streamIssueStartMs,
      streamIssueResponseMs,
      streamSocketCreatedMs,
      streamSocketOpenMs,
      streamReadyFrameMs,
      streamOpenResolvedMs,
      physicalReadyMs,
      coherentMs,
      paintedMs: painted.elapsedMs,
    }),
    segments: Object.freeze({
      connectionToShellStaleMs: segment(connectionMs, shellStaleMs),
      shellStaleToLiveMs: segment(shellStaleMs, shellLiveMs),
      shellLiveToPhysicalReadyMs: segment(shellLiveMs, physicalReadyMs),
      shellLiveToStreamIssueStartMs: segment(shellLiveMs, streamIssueStartMs),
      streamIssueRequestMs: segment(streamIssueStartMs, streamIssueResponseMs),
      streamIssueResponseToSocketCreatedMs: segment(streamIssueResponseMs, streamSocketCreatedMs),
      streamSocketConnectMs: segment(streamSocketCreatedMs, streamSocketOpenMs),
      streamOpenToReadyFrameMs: segment(streamSocketOpenMs, streamReadyFrameMs),
      streamReadyToResolvedMs: segment(streamReadyFrameMs, streamOpenResolvedMs),
      streamResolvedToPhysicalReadyMs: segment(streamOpenResolvedMs, physicalReadyMs),
      physicalReadyToCoherentMs: segment(physicalReadyMs, coherentMs),
      coherentToPaintMs: segment(coherentMs, painted.elapsedMs),
    }),
  });
}

function runtimeResourceRetirement(lifecycle, ordinal) {
  const snapshot = lifecycle.findLast(
    (entry) => entry?.phase === "resource-snapshot" && entry?.boundary === "post-close",
  );
  const resources = snapshot?.resources ?? null;
  const active = resources
    ? Object.fromEntries(
        Object.entries(resources).map(([kind, count]) => [kind, Number(count?.active ?? -1)]),
      )
    : null;
  return Object.freeze({
    ordinal,
    processId: snapshot?.processId ?? null,
    active,
    diagnostics: snapshot?.diagnostics ?? null,
    passed:
      Boolean(active) &&
      Object.entries(active).every(([kind, count]) =>
        kind === "host-shutdown-timer" ? count >= 0 && count <= 1 : count === 0,
      ) &&
      snapshot?.diagnostics?.droppedRecords === 0 &&
      snapshot?.diagnostics?.failed === false,
  });
}

async function diagnose(json) {
  await start(false, true);
  let state = await waitForState((candidate) => candidate?.status === "ready");
  const tracePath = state.tui.performanceTracePath;
  const warmCoherentSamples = [];
  const warmCoherentJourneys = [];
  const warmHostPublications = [];
  const runtimeResourceRetirements = [];
  for (let ordinal = 0; ordinal < WARM_COHERENT_SAMPLE_COUNT; ordinal += 1) {
    try {
      tuiCommand(state, ["stop"], { ignore: true });
      const retiredLifecycle = readJsonLines(join(state.tui.runtimeDir, "performance.jsonl"));
      const retirement = runtimeResourceRetirement(retiredLifecycle, ordinal);
      runtimeResourceRetirements.push(retirement);
      if (!retirement.passed) {
        throw new Error(
          `TUI runtime resources did not retire to baseline at warm rehost ${ordinal}: ${JSON.stringify(retirement)}`,
        );
      }
      tuiCommand(state, ["start", "--target", state.session, "--cols", "160", "--rows", "44"]);
      const host = JSON.parse(tuiCommand(state, ["status", "--json"]));
      if (!Number.isInteger(host.processId) || typeof host.launchId !== "string")
        throw new Error(`warm rehost ${ordinal} did not publish a launch identity`);
      if (warmHostPublications.at(-1)?.processId === host.processId)
        throw new Error(`warm rehost ${ordinal} reused host process ${host.processId}`);
      tuiCommand(state, ["key", "F2"]);
      await waitForCoherentTui(state, 30_000, host.processId);
      const publication = await proveHostTerminalPublication(state, `warm-rehost-${ordinal}`);
      if (publication.processId !== host.processId)
        throw new Error(
          `warm rehost ${ordinal} host changed process ${host.processId} -> ${publication.processId}`,
        );
      warmHostPublications.push(publication);
      const lifecycle = readJsonLines(join(state.tui.runtimeDir, "performance.jsonl"));
      const duration = coherentGenerationDuration(lifecycle);
      if (Number.isFinite(duration)) warmCoherentSamples.push(duration);
      const journey = coherentGenerationJourney(lifecycle);
      if (journey) warmCoherentJourneys.push(Object.freeze({ ordinal, ...journey }));
    } catch (error) {
      const evidencePath = await preserveWarmRehostFailure(state, ordinal, error);
      throw new Error(
        `Warm rehost ${ordinal} failed; preserved exact host/lifecycle evidence at ${evidencePath}`,
        { cause: error },
      );
    }
  }
  const windowSwitchSamples = [];
  for (let ordinal = 0; ordinal < 30; ordinal += 1) {
    const before = readJsonLines(join(state.tui.runtimeDir, "performance.jsonl")).filter(
      ({ phase }) => phase === "window-switch-settled",
    ).length;
    tuiCommand(state, ["key", "C-t"]);
    const deadline = Date.now() + 2_000;
    let settled = [];
    while (Date.now() < deadline) {
      settled = readJsonLines(join(state.tui.runtimeDir, "performance.jsonl")).filter(
        ({ phase }) => phase === "window-switch-settled",
      );
      if (settled.length > before) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    }
    const durationMicros = settled.at(-1)?.durationMicros;
    if (settled.length > before && Number.isFinite(durationMicros))
      windowSwitchSamples.push(durationMicros / 1_000);
  }
  const resizeGuideSamples = [];
  for (let ordinal = 0; ordinal < 20; ordinal += 1) {
    const separator = activeVerticalResizeSeparator(state);
    if (!separator) break;
    const before = readJsonLines(join(state.tui.runtimeDir, "performance.jsonl")).filter(
      ({ phase }) => phase === "resize-guide-settled",
    ).length;
    const delta = ordinal % 2 === 0 ? 1 : -1;
    tuiCommand(state, ["mouse", "down", String(separator.x), String(separator.y)]);
    tuiCommand(state, ["mouse", "hold", String(separator.x + delta), String(separator.y)]);
    const deadline = Date.now() + 1_000;
    let settled = [];
    while (Date.now() < deadline) {
      settled = readJsonLines(join(state.tui.runtimeDir, "performance.jsonl")).filter(
        ({ phase }) => phase === "resize-guide-settled",
      );
      if (settled.length > before) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 2));
    }
    tuiCommand(state, ["mouse", "up", String(separator.x + delta), String(separator.y)]);
    const durationMicros = settled.at(-1)?.durationMicros;
    if (settled.length > before && Number.isFinite(durationMicros))
      resizeGuideSamples.push(durationMicros / 1_000);
    const expectedWidth = separator.width + delta;
    const commitDeadline = Date.now() + 2_000;
    let committedWidth = separator.width;
    while (Date.now() < commitDeadline) {
      committedWidth = Number(
        execFileSync(
          "tmux",
          [
            "-S",
            state.runtimeNamespace.tmuxSocketPath,
            "display-message",
            "-p",
            "-t",
            separator.paneId,
            "#{pane_width}",
          ],
          { encoding: "utf8" },
        ).trim(),
      );
      if (committedWidth === expectedWidth) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    }
    if (committedWidth !== expectedWidth) {
      throw new Error(
        `resize guide painted but semantic resize did not settle (${separator.paneId}: ${separator.width} -> ${expectedWidth}; observed ${committedWidth})`,
      );
    }
  }
  const qualifyingInputEvidence = [];
  if (tracePath) {
    const samplesForCurrentProcess = () => {
      const records = readJsonLines(tracePath);
      const processId = records.findLast(
        (record) => record?.type === "performance.trace.header",
      )?.processId;
      return inputPaintSamples(records).filter(
        (sample) => sample.generation === state.daemon.instanceId && sample.processId === processId,
      );
    };
    for (let ordinal = 0; ordinal < 30; ordinal += 1) {
      const before = samplesForCurrentProcess().length;
      const marker = `z${ordinal.toString(36).padStart(2, "0")}q`;
      tuiCommand(state, ["text", marker]);
      const deadline = Date.now() + 2_000;
      // Do not make the diagnostic owner contend with the measured daemon/TUI
      // by reparsing a growing JSONL trace every 5ms during the causal path.
      // The trace timestamps are process-local, so this observation delay does
      // not enter the metric; it only keeps the observer from perturbing it.
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      while (Date.now() < deadline) {
        const samples = samplesForCurrentProcess();
        const activePane = activeTmuxPane(state);
        const activePaneId = activePane.paneId;
        const nativeFrame = execFileSync(
          "tmux",
          ["-S", state.runtimeNamespace.tmuxSocketPath, "capture-pane", "-p", "-t", activePaneId],
          { encoding: "utf8" },
        );
        const tuiFrame = tuiCommand(state, ["capture"]);
        const { left, top, width, height } = activePane;
        const renderedBody = paneBodyRegion(tuiFrame, { left, top, width, height });
        const candidate = samples
          .slice(before)
          .findLast(
            (sample) =>
              sample.semanticPaneId === activePane.semanticPaneId &&
              Number.isInteger(sample.revision) &&
              typeof sample.stateHash === "string",
          );
        if (candidate && nativeFrame.includes(marker) && renderedBody.includes(marker)) {
          qualifyingInputEvidence.push({
            traceId: candidate.traceId,
            paintStateIdentity: "latest-canonical-state-blitted",
            marker,
            markerHash: createHash("sha256").update(marker).digest("hex"),
            semanticPaneId: candidate.semanticPaneId,
            revision: candidate.revision,
            stateHash: candidate.stateHash,
            markerVisibleInNative: true,
            markerVisibleInPaneRect: true,
            renderedBodyHash: createHash("sha256").update(renderedBody).digest("hex"),
          });
          break;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
      tuiCommand(state, ["key", "C-u"]);
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    if (qualifyingInputEvidence.length < 30)
      event("diagnostic-input-samples-incomplete", {
        measured: qualifyingInputEvidence.length,
        required: 30,
      });
  }
  let resourceObservation = null;
  let idleObservation = null;
  if (tracePath) {
    const activeProcessId = readJsonLines(tracePath).findLast(
      (record) => record?.type === "performance.trace.header",
    )?.processId;
    const loadBaseline = readJsonLines(tracePath).length;
    const waitForTuiMarker = async (marker) => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (tuiCommand(state, ["capture"]).includes(marker)) return;
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
      throw new Error(`TUI did not paint resource-cycle marker ${marker}`);
    };
    // Four same-process load→clear→settle cycles distinguish retained product
    // state from allocator high-water without requiring or faking GC. Cycle
    // endpoints, not 16 probes in one retained-history epoch, form the memory
    // distribution.
    const resourceEndpointTraceIds = [];
    for (let cycle = 0; cycle < 4; cycle += 1) {
      const flooded = `tmux-ide-flood-${cycle}`;
      tuiCommand(state, [
        "text",
        `i=0; while [ $i -lt 300 ]; do echo tmux-ide-load-$i; i=$((i+1)); done; echo ${flooded}`,
      ]);
      tuiCommand(state, ["key", "Enter"]);
      await waitForTuiMarker(flooded);
      const settled = `tmux-ide-settled-${cycle}`;
      tuiCommand(state, ["text", `printf '\\033[2J\\033[3J\\033[H${settled}\\n'`]);
      tuiCommand(state, ["key", "Enter"]);
      await waitForTuiMarker(settled);
      for (let probe = 0; probe < 4; probe += 1) {
        const beforeSamples = inputPaintSamples(readJsonLines(tracePath)).filter(
          (sample) => sample.processId === activeProcessId,
        );
        tuiCommand(state, ["text", String.fromCharCode(97 + cycle * 4 + probe)]);
        const deadline = Date.now() + 2_000;
        while (Date.now() < deadline) {
          const samples = inputPaintSamples(readJsonLines(tracePath)).filter(
            (sample) => sample.processId === activeProcessId,
          );
          const endpoint = samples.slice(beforeSamples.length).at(-1);
          if (endpoint) {
            resourceEndpointTraceIds.push(endpoint.traceId);
            break;
          }
          await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        }
      }
      tuiCommand(state, ["key", "C-u"]);
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
    const loadRecords = readJsonLines(tracePath)
      .slice(loadBaseline)
      .filter((record) => record?.processId === activeProcessId);
    const clientStages = loadRecords.filter(
      (record) => record?.type === "performance.stage" && record.stage === "client",
    );
    const deliveries = loadRecords.filter(
      (record) => record?.type === "performance.terminal-delivery",
    );
    resourceObservation = summarizeProductResources(
      clientStages,
      deliveries,
      resourceEndpointTraceIds,
    );
    const beforeIdle = readJsonLines(tracePath).filter(
      (record) => record?.processId === activeProcessId,
    );
    const idleStartedAtMicros = Math.max(
      0,
      ...beforeIdle.map((record) => record.atMicros ?? record.endedAtMicros ?? 0),
    );
    const idleFrameBefore = tuiCommand(state, ["capture"]);
    const idleFrameHashBefore = createHash("sha256").update(idleFrameBefore).digest("hex");
    const idleStartedAt = performance.now();
    // Give the monotonic observation window explicit scheduling slack. A
    // nominal 10,000ms timer can wake a few milliseconds early on macOS and
    // must not turn a genuinely idle renderer into a false failed boundary.
    await new Promise((resolveWait) => setTimeout(resolveWait, 10_100));
    const idleRecords = readJsonLines(tracePath).filter(
      (record) =>
        record?.processId === activeProcessId &&
        Number.isFinite(record.atMicros) &&
        record.atMicros > idleStartedAtMicros,
    );
    const idlePaints = idleRecords.filter(
      (record) => record?.type === "performance.terminal-paint",
    );
    const idleFrameAfter = tuiCommand(state, ["capture"]);
    const idleFrameHashAfter = createHash("sha256").update(idleFrameAfter).digest("hex");
    idleObservation = Object.freeze({
      durationMs: Math.floor(performance.now() - idleStartedAt),
      frameCount: idleRecords.filter((record) => record?.type === "performance.frame").length,
      terminalPaints: idlePaints.length,
      zeroDirtyPaints: idlePaints.filter((record) => record.dirtyRows === 0).length,
      dirtyRows: idlePaints.reduce((total, record) => total + (record.dirtyRows ?? 0), 0),
      frameHashBefore: idleFrameHashBefore,
      frameHashAfter: idleFrameHashAfter,
      framebufferStable: idleFrameHashBefore === idleFrameHashAfter,
    });
  }
  state = await waitForState((candidate) => candidate?.status === "ready", 5_000);
  const framebufferEvidence = await activePaneBodyEvidence(state);
  await captureArtifacts(state, "diagnose");
  // A closed collector summary is the only truthful proof that trace
  // backpressure did not drop or oversize records. Stop the hosted TUI after
  // all visual journeys, then build the report from its final streams.
  tuiCommand(state, ["stop"]);
  const lifecycle = readJsonLines(join(state.tui.runtimeDir, "performance.jsonl"));
  const traceRecords = tracePath ? readJsonLines(tracePath) : [];
  const daemonTraceRecords = state.tui.daemonPerformanceTracePath
    ? readJsonLines(state.tui.daemonPerformanceTracePath)
    : [];
  const stderrPath = join(state.tui.runtimeDir, "stderr.log");
  let stderr = "";
  try {
    stderr = readFileSync(stderrPath, "utf8");
  } catch {
    // Absence is represented honestly as an empty diagnostic stream.
  }
  const report = {
    ...buildProductDiagnosticReport({
      state,
      truth: tmuxTruth(state),
      lifecycle,
      traceRecords,
      daemonTraceRecords,
      stderr,
      warmCoherentSamples,
      warmCoherentJourneys,
      runtimeResourceRetirements,
      windowSwitchSamples,
      resizeGuideSamples,
      framebufferEvidence,
      idleObservation,
      resourceObservation,
      qualifyingInputEvidence,
    }),
    warmHostPublications: Object.freeze([...warmHostPublications]),
  };
  const reportPath = join(artifactDir, "diagnostic-report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  emit(
    json ? { ...report, reportPath } : `Product diagnosis ${report.status}; ${reportPath}`,
    json,
  );
  if (report.status !== "passed") process.exitCode = 1;
}

function inventory(json) {
  const productBaseline = JSON.parse(
    readFileSync(join(repoRoot, "docs", "product", "product-baseline.json"), "utf8"),
  );
  const report = {
    ...sourceArchitectureInventory(repoRoot),
    productBaseline,
    productTestRig: {
      ownsPrivateTmuxSocket: true,
      ownsEphemeralStateHome: true,
      touchesCanonicalUserTmux: false,
      capabilities: [
        "real-opentui",
        "real-web",
        "tmux-layout-truth",
        "coherent-terminal-readiness",
        "multi-client-authority-convergence",
        "daemon-generation-recovery",
        "artifact-capture",
      ],
      unqualified: [
        "input-to-consumed-paint-distribution",
        "operation-correlated-drag-settlement",
        "packed-install-first-run",
      ],
    },
  };
  emit(json ? report : JSON.stringify(report, null, 2), json);
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
    const daemonPerformanceTracePath = join(rigRoot, "daemon-performance.jsonl");
    const collectDaemonCausalTrace = process.env.TMUX_IDE_PRODUCT_DIAGNOSTIC_CAUSAL_TRACE !== "0";
    fleet = {
      ...scratchFleet,
      environment: {
        ...scratchFleet.environment,
        TMUX_IDE_RUNTIME_MODE: "testdrive",
        TMUX_IDE_CLEANUP_TOKEN: cleanupToken,
        TMUX_IDE_TMUX_SOCKET_PATH: scratchFleet.socketPath,
        ...(collectDaemonCausalTrace
          ? { TMUX_IDE_SESSION_RUNTIME_TRACE_LOG: daemonPerformanceTracePath }
          : {}),
      },
    };
    const session = fleet.sessionNames[0];
    // Product-owned geometry fixture: the production resize guide needs a real
    // tmux divider. Create it before daemon discovery so every client receives
    // the same canonical three-pane/two-window inventory.
    execFileSync(
      "tmux",
      ["-S", fleet.socketPath, "split-window", "-h", "-t", `=${session}:=one`, "exec sh -i"],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    const runtimeNamespace = {
      root: fleet.root,
      tmuxSocketPath: fleet.socketPath,
      hostTmuxSocketPath: join(fleet.root, "product-rig-host-tmux.sock"),
      daemonInfoDir: fleet.daemonInfoDir,
      cleanupToken,
    };
    const traceProvenance = sourceTraceProvenance();
    const tui = {
      hostSession: `_tmux-ide-product-rig-${slug}`,
      runtimeDir: join(rigRoot, "tui"),
      performanceTracePath: join(rigRoot, "tui", "performance-trace.jsonl"),
      performanceTraceCommit: traceProvenance.commit,
      performanceTraceTree: traceProvenance.tree,
      daemonPerformanceTracePath: collectDaemonCausalTrace ? daemonPerformanceTracePath : null,
    };
    publish({ session, runtimeNamespace, tui });
    event("tmux-ready", { session, socketPath: fleet.socketPath });

    daemon = await startDaemon(fleet);
    const workspace = await daemon.promote(session);
    await waitForReadinessLadder(daemon);
    publish({ daemon: daemon.record, workspace });
    event("daemon-ready", { instanceId: daemon.record.instanceId, workspace });

    devServer = await startDevServer(daemon, {
      daemonInfoPath: join(fleet.daemonInfoDir, "daemon.json"),
    });
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
    let tuiStatus = await waitForCoherentTui(state);
    const initialHostPublication = await proveHostTerminalPublication(state, "boot");
    tuiStatus = JSON.parse(tuiCommand(state, ["status", "--json"]));
    const readiness = coherentReadiness({
      chromeMs: tuiStatus.readiness.appChromeFrameMs,
      terminalMs: initialHostPublication.elapsedMs,
    });
    publish({ tui: { ...tui, readiness } });
    event("tui-coherent-terminal-frame", readiness);
    const beforeRestart = await proveMultiClientConvergence(state, daemon, {
      allowRestartPending: true,
    });
    const previousGeneration = daemon.record.instanceId;
    const restartStartedAt = Date.now();
    await daemon.stop();
    await page
      .locator(".terminal-surface:not([data-phase='connected'])")
      .first()
      .waitFor({ timeout: 10_000 })
      .catch(() => undefined);
    daemon = await startDaemon(fleet);
    const restartedWorkspace = await daemon.promote(session);
    await waitForReadinessLadder(daemon);
    publish({ daemon: daemon.record, workspace: restartedWorkspace });
    await page
      .locator(".terminal-surface[data-phase='connected']")
      .first()
      .waitFor({ timeout: 30_000 });
    let restartedTui = null;
    const tuiRestartDeadline = Date.now() + 30_000;
    while (Date.now() < tuiRestartDeadline) {
      restartedTui = JSON.parse(tuiCommand(state, ["status", "--json"]));
      if (
        restartedTui.readiness?.activeGeneration === daemon.record.instanceId &&
        restartedTui.readiness?.generationStatus === "live"
      )
        break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    if (
      restartedTui?.readiness?.activeGeneration !== daemon.record.instanceId ||
      restartedTui?.readiness?.generationStatus !== "live"
    ) {
      throw new Error("hosted TUI did not recover onto the restarted daemon generation");
    }
    const afterRestart = await proveMultiClientConvergence(state, daemon, {
      previousGeneration,
    });
    const hostedTuiMarker = `RIG_HOSTED_TUI_${randomBytes(4).toString("hex")}`;
    tuiCommand(state, ["text", `printf '${hostedTuiMarker}\\n'`]);
    tuiCommand(state, ["key", "Enter"]);
    let hostedTuiFrame = "";
    const hostedTuiInputDeadline = Date.now() + 5_000;
    while (Date.now() < hostedTuiInputDeadline) {
      hostedTuiFrame = tuiCommand(state, ["capture", "--history", "20"]);
      if (hostedTuiFrame.includes(hostedTuiMarker)) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    if (!hostedTuiFrame.includes(hostedTuiMarker)) {
      throw new Error("hosted TUI input did not reach a painted terminal after daemon restart");
    }
    const convergence = {
      ...afterRestart,
      restart: {
        previousGeneration,
        generation: daemon.record.instanceId,
        elapsedMs: Date.now() - restartStartedAt,
        webRecovered: true,
        tuiRecovered: true,
        hostedTuiInputPainted: true,
      },
      runs: [beforeRestart, afterRestart],
    };
    publish({ convergence });
    await captureArtifacts(state, "boot", page);
    publish({ status: "ready", readyAt: new Date().toISOString() });
    await new Promise(() => undefined);
  } catch (error) {
    const daemonOutput = daemon?.output().slice(-16_384) ?? "";
    publish({ status: "failed", failure: error instanceof Error ? error.stack : String(error) });
    event("failed", {
      failure: error instanceof Error ? error.message : String(error),
      ...(daemonOutput ? { daemonOutput } : {}),
    });
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
  else if (command === "diagnose") await diagnose(json);
  else if (command === "inventory") inventory(json);
  else if (command === "stop") await stop(json);
  else if (["help", "--help", "-h"].includes(command)) process.stdout.write(usage());
  else throw new Error(`unknown command ${command}\n\n${usage()}`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
