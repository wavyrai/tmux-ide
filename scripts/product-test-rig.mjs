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
  readdirSync,
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
  appendBoundedWebDiagnostic,
  awaitWebDiagnosticWithDeadline,
  boundedSourceTraceDiff,
  buildProductDiagnosticReport,
  buildWebStartupEvidence,
  causalFixtureBaselineReadiness,
  causalInputSamples,
  causalInputSampleHasIncarnation,
  causalProbeEpochState,
  coherentGenerationPaint,
  coherentGenerationDuration,
  coherentReadiness,
  inputPaintSamples,
  latestCausalFixtureCanonicalMode,
  paneBodyRegion,
  paneGeometryIdentity,
  processAlive,
  productInputQueueObservation,
  productInputQueuesSettled,
  productResourceCycleCommands,
  productResourceCyclePlan,
  productResourceEndpointEpochState,
  productResourceGeometryIdentity,
  productResourceMeasuredEndpointTraceIds,
  productResourceProbeCells,
  publicRigStatus,
  readJson,
  resolvePaneBodyRect,
  runCausalFixtureTeardownGate,
  selectProductResourceEndpoint,
  summarizeProductResources,
  shouldCaptureWebConsoleMessage,
  waitForLifecycleEntry,
  writeJsonAtomic,
} from "./product-test-rig-lib.mjs";
import { sourceArchitectureInventory } from "./architecture-debt-inventory.mjs";
import { acquireProductRigSleepAssertion } from "./lib/product-rig-sleep-assertion.mjs";
import {
  assessConfiglessJourneyBoundaries,
  buildProductDiagnosticCorrelation,
  CONFIGLESS_TMUX_SESSION_FORMAT,
  createConfiglessProductJourneyOwnerOperations,
  createFreshFleetCatalogReader,
  parseConfiglessTmuxSessionInventory,
  qualifyCanonicalSeedPaint,
  waitForQualifiedWorkspaceClientState,
} from "./lib/product-configless-owner.mjs";
import {
  PRODUCT_DIAGNOSTIC_BUNDLE_FILES,
  PRODUCT_JOURNEY_REGISTRY,
  auditProductJourneyScope,
  collectProductRigCleanupFailures,
  createProductRigCleanupReceipt,
  createProductDiagnosticBundle,
  dispatchProductJourneyExecutor,
  parseProductDiagnoseOptions,
  productDiagnosticRunId,
  productRigTerminalFailureError,
  productRigTerminalFailureState,
  prepareProductDiagnosticBundlePublication,
  productRigCleanupAcknowledgesRequest,
  productRigCleanupBarrierFailures,
  isCleanLegacyStoppedProductRigState,
  resolveProductJourneyPlan,
  runConfiglessProductJourneyOwnerBoot,
  runIsolatedProductJourneyAttempt,
  runProductJourneyPlan,
  settleInternalProductRigCleanup,
} from "./product-test-rig-journeys.mjs";

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
const shutdownRequestPath = join(rigRoot, "shutdown-request.json");
const artifactDir = join(rigRoot, "artifacts");
const diagnosticRoot = resolve(
  process.env.TMUX_IDE_PRODUCT_DIAGNOSTIC_DIR || join(repoRoot, ".tasks", "product-diagnostics"),
);
const diagnosticCaptures = new Map();
const diagnosticAttemptPhases = new Map();
const UNAVAILABLE_WEB_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const DIAGNOSTIC_TEXT_LIMIT = 64 * 1024;

function boundedDiagnosticText(value) {
  const text = String(value ?? "");
  return text.length <= DIAGNOSTIC_TEXT_LIMIT ? text : text.slice(-DIAGNOSTIC_TEXT_LIMIT);
}

function readDiagnosticText(path, fallback = "") {
  try {
    return boundedDiagnosticText(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function productDiagnosticCorrelation(state, captureEvidence) {
  const tuiAvailable = Boolean(captureEvidence?.tuiPath && existsSync(captureEvidence.tuiPath));
  const webAvailable = Boolean(captureEvidence?.webPath && existsSync(captureEvidence.webPath));
  const configless = state?.journeyEvidence?.configlessColdStart ?? null;
  return buildProductDiagnosticCorrelation({
    state,
    tuiAvailable,
    webAvailable,
    web: captureEvidence?.web ?? null,
    expected: configless
      ? {
          daemonGeneration: state?.daemon?.instanceId ?? null,
          workspaceName: state?.workspace ?? null,
          sessionName: state?.session ?? null,
          fleetSessionId: configless.adopted?.fleetSessionId ?? null,
          catalogRevision: configless.adopted?.catalogRevision ?? null,
          semanticPaneId: configless.coherent?.semanticPaneId ?? null,
        }
      : null,
  });
}
const WARM_COHERENT_SAMPLE_COUNT = 20;

function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function diagnosticReproduction(journeyId, variant = null) {
  return `#!/bin/sh
set -eu
SOURCE_ROOT=\${TMUX_IDE_SOURCE_ROOT:-"$PWD"}
if [ ! -f "$SOURCE_ROOT/package.json" ] || [ ! -f "$SOURCE_ROOT/scripts/product-test-rig.mjs" ]; then
  printf '%s\n' 'Set TMUX_IDE_SOURCE_ROOT to a tmux-ide source tree.' >&2
  exit 2
fi
cd "$SOURCE_ROOT"
exec pnpm product:testdrive diagnose --journey ${journeyId}${variant ? ` --variant ${variant}` : ""} --repeat 1 --json
`;
}

function terminalCellAt(frame, row, column) {
  const line = frame.split("\n")[row] ?? "";
  return line[column] ?? " ";
}

function usage() {
  return `Product test rig\n\nUsage:\n  pnpm product:testdrive start [--json]\n  pnpm product:testdrive status [--json]\n  pnpm product:testdrive capture [--json]\n  pnpm product:testdrive smoke [--json]\n  pnpm product:testdrive diagnose [--journey <id>] [--variant <key|paste>] [--repeat <1-10>] [--json]\n  pnpm product:testdrive inventory [--json]\n  pnpm product:testdrive stop [--json]\n`;
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
  const environment = {
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
    ...(state.tui.publicEntry
      ? {
          HOME: state.runtimeNamespace.home,
          XDG_CONFIG_HOME: join(state.runtimeNamespace.home, ".config"),
          TMUX: "",
          TMUX_IDE_HOME: state.runtimeNamespace.stateDir,
          TMUX_IDE_CONFIG: join(state.runtimeNamespace.stateDir, "config.json"),
          TMUX_IDE_DAEMON_INFO_DIR: state.runtimeNamespace.daemonInfoDir,
          TMUX_IDE_REGISTRY_DIR: state.runtimeNamespace.registryDir,
          TMUX_IDE_SETTINGS_DIR: state.runtimeNamespace.settingsDir,
          TMUX_IDE_TESTDRIVE_DAEMON_INFO_DIR: state.runtimeNamespace.daemonInfoDir,
        }
      : {
          TMUX_IDE_TESTDRIVE_USE_CANONICAL_DAEMON: "1",
          TMUX_IDE_TESTDRIVE_CANONICAL_HOME: state.runtimeNamespace.daemonInfoDir,
        }),
    ...(state.tui.performanceTracePath
      ? {
          TMUX_IDE_PERFORMANCE_TRACE_LOG: state.tui.performanceTracePath,
          TMUX_IDE_PERFORMANCE_TRACE_COMMIT: state.tui.performanceTraceCommit,
          TMUX_IDE_PERFORMANCE_TRACE_TREE: state.tui.performanceTraceTree,
          TMUX_IDE_CAUSAL_CELL_FIXTURE: "1",
        }
      : {}),
  };
  if (state.tui.publicEntry) {
    delete environment.TMUX_IDE_TESTDRIVE_USE_CANONICAL_DAEMON;
    delete environment.TMUX_IDE_TESTDRIVE_CANONICAL_HOME;
    delete environment.TMUX_IDE_RUNTIME_MODE;
    delete environment.TMUX_IDE_CLEANUP_TOKEN;
    delete environment.TMUX_IDE_TMUX_SOCKET_NAME;
  }
  return environment;
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
    const web = await page.evaluate(
      async ({ workspaceName }) => {
        const host = globalThis.tmuxIdeHost;
        const [bootstrap, workspaces, shell] = await Promise.all([
          host.bootstrap(),
          host.daemon.listWorkspaces(),
          host.daemon.fetchApplicationShell({ workspaceName, resourceVersion: 3 }),
        ]);
        const shellResource = shell.status === "ok" ? shell.envelope.resource : null;
        const workspaceRows =
          workspaces.status === "ok"
            ? workspaces.workspaces.filter((workspace) => workspace.workspaceName === workspaceName)
            : [];
        const workspaceRow = workspaceRows.length === 1 ? workspaceRows[0] : null;
        return {
          title: globalThis.document.title,
          shellSource:
            globalThis.document.querySelector(".app")?.getAttribute("data-shell-source") ?? null,
          terminalPhases: [...globalThis.document.querySelectorAll(".terminal-surface")].map(
            (node) => node.getAttribute("data-phase"),
          ),
          terminals: [...globalThis.document.querySelectorAll(".terminal-surface")].map((node) => ({
            phase: node.getAttribute("data-phase"),
            workspaceName: node.getAttribute("data-workspace-name"),
            semanticPaneId: node.getAttribute("data-semantic-pane-id"),
          })),
          windowContainerCount: globalThis.document.querySelectorAll(".tiled-workspace").length,
          windows: [...globalThis.document.querySelectorAll(".window-tabs__tab")].map((node) => ({
            windowResourceId: node.getAttribute("data-window-resource-id"),
            semanticPaneIds: node.getAttribute("data-semantic-pane-ids"),
            paneCount: node.getAttribute("data-pane-count"),
            active: node.getAttribute("data-active"),
          })),
          hostCorrelation: {
            domDaemonGeneration:
              globalThis.document.querySelector(".app")?.getAttribute("data-daemon-generation") ??
              null,
            bootstrapDaemon:
              bootstrap.daemon.status === "connected" ? bootstrap.daemon.identity.instanceId : null,
            listDaemon: workspaces.status === "ok" ? workspaces.daemon.instanceId : null,
            workspaceNames:
              workspaces.status === "ok"
                ? workspaces.workspaces.map((workspace) => workspace.workspaceName)
                : [],
            workspaceRow,
            shellDaemon: shell.status === "ok" ? shell.envelope.daemon.instanceId : null,
            shellWorkspaceName: shellResource?.workspace?.name ?? null,
            shellWorkspaceId: shellResource?.workspace?.id ?? null,
            shellFleetSessionId: shellResource?.fleetSessionId ?? null,
            terminalResources:
              shellResource?.terminalInventory?.resources.map((resource) => ({
                resourceId: resource.id,
                windowResourceId: resource.windowResourceId ?? resource.id,
                active: resource.active,
                semanticPaneId:
                  resource.attachability.status === "available"
                    ? resource.attachability.semanticPaneId
                    : null,
              })) ?? [],
          },
          text: globalThis.document.body.innerText.slice(0, 4_000),
        };
      },
      { workspaceName: state.workspace },
    );
    const webStatePath = join(artifactDir, `${suffix}-web.json`);
    await writeFile(webStatePath, `${JSON.stringify(web, null, 2)}\n`, "utf8");
    event("capture", { label, tuiPath, tmuxPath, webPath, webStatePath });
    return { label, tuiPath, tmuxPath, webPath, webStatePath, truth, web, tuiStatus };
  } finally {
    await captureBrowser?.close();
  }
}

async function waitForState(predicate, timeoutMs = 90_000, { allowTerminalFailure = false } = {}) {
  const deadline = Date.now() + timeoutMs;
  let state = null;
  while (Date.now() < deadline) {
    state = readJson(statePath);
    if (!allowTerminalFailure && ["failed", "cleanup-failed"].includes(state?.status)) {
      throw productRigTerminalFailureError(state);
    }
    if (predicate(state)) return state;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`timed out waiting for product rig (${state?.status ?? "no state"})`);
}

function installWebStartupDiagnostics(page) {
  const diagnostics = {
    pageErrors: [],
    console: [],
    requestFailures: [],
    httpErrors: [],
    webSockets: [],
  };
  const append = (entries, entry) => {
    appendBoundedWebDiagnostic(entries, entry);
  };
  page.on("pageerror", (error) => append(diagnostics.pageErrors, error.stack ?? error.message));
  page.on("console", (message) => {
    if (shouldCaptureWebConsoleMessage(message.type(), message.text())) {
      append(diagnostics.console, { type: message.type(), text: message.text() });
    }
  });
  page.on("requestfailed", (request) =>
    append(diagnostics.requestFailures, {
      method: request.method(),
      resourceType: request.resourceType(),
      url: request.url(),
      error: request.failure()?.errorText ?? null,
    }),
  );
  page.on("response", (response) => {
    if (response.status() >= 400) {
      append(diagnostics.httpErrors, {
        status: response.status(),
        resourceType: response.request().resourceType(),
        url: response.url(),
      });
    }
  });
  page.on("websocket", (socket) => {
    append(diagnostics.webSockets, { event: "open", url: socket.url() });
    socket.on("socketerror", (error) =>
      append(diagnostics.webSockets, {
        event: "frameerror",
        source: "socketerror",
        url: socket.url(),
        error,
      }),
    );
    socket.on("close", () => append(diagnostics.webSockets, { event: "close", url: socket.url() }));
  });
  return diagnostics;
}

async function captureWebStartupFailure({ page, diagnostics, navigation, devServer, daemon }) {
  mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  const suffix = `web-startup-failure-${Date.now()}`;
  const screenshotPath = join(artifactDir, `${suffix}.png`);
  const evidencePath = join(artifactDir, `${suffix}.json`);
  let screenshotError = null;
  try {
    // Fixed viewport only: never let an unexpectedly tall page make failure evidence unbounded.
    await page.screenshot({ path: screenshotPath, fullPage: false, timeout: 5_000 });
  } catch (error) {
    screenshotError = error instanceof Error ? error.message : String(error);
  }
  const pageSnapshot = await awaitWebDiagnosticWithDeadline(
    page.evaluate(() => {
      const document = globalThis.document;
      const root = document.querySelector("#root");
      const app = document.querySelector(".app");
      let remaining = 160;
      const serialize = (node, depth = 0) => {
        if (!(node instanceof globalThis.Element) || remaining <= 0 || depth > 7) return null;
        remaining -= 1;
        const attributes = {};
        for (const name of [
          "id",
          "class",
          "role",
          "aria-label",
          "data-shell-source",
          "data-phase",
        ]) {
          const value = node.getAttribute(name);
          if (value !== null) attributes[name] = value.slice(0, 300);
        }
        return {
          tag: node.tagName.toLowerCase(),
          attributes,
          text: [...node.childNodes]
            .filter((child) => child.nodeType === globalThis.Node.TEXT_NODE)
            .map((child) => child.textContent ?? "")
            .join(" ")
            .trim()
            .slice(0, 300),
          children: [...node.children].map((child) => serialize(child, depth + 1)).filter(Boolean),
        };
      };
      const terminalPhases = [...document.querySelectorAll(".terminal-surface")].map((node) =>
        node.getAttribute("data-phase"),
      );
      const host = globalThis.tmuxIdeHost;
      return {
        page: {
          currentUrl: globalThis.location.href,
          title: document.title,
          readyState: document.readyState,
          root: root
            ? {
                present: true,
                childCount: root.childElementCount,
                textLength: root.textContent?.length,
              }
            : { present: false, childCount: 0, textLength: 0 },
          app: {
            present: app !== null,
            shellSource: app?.getAttribute("data-shell-source") ?? null,
          },
          hostActive: {
            present: host !== undefined,
            type: typeof host,
            methods:
              host && typeof host === "object"
                ? Object.keys(host)
                    .filter((key) => typeof host[key] === "function")
                    .slice(0, 40)
                : [],
          },
          terminalPhases,
          bodyExcerpt: document.body?.innerText.slice(0, 4_000) ?? "",
        },
        dom: root ? serialize(root) : null,
      };
    }),
    {
      timeoutMs: 3_000,
      onFailure: (error) => ({
        page: {
          currentUrl: page.url(),
          evaluationError: error instanceof Error ? error.message : String(error),
        },
        dom: null,
      }),
    },
  );
  const evidence = buildWebStartupEvidence(
    {
      capturedAt: new Date().toISOString(),
      navigation,
      ...pageSnapshot,
      ...diagnostics,
      screenshotPath: screenshotError ? null : screenshotPath,
      screenshotError,
      viteOutput: devServer?.output() ?? "",
      daemonOutput: daemon?.output() ?? "",
    },
    { secrets: [daemon?.record?.authToken] },
  );
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  return { evidencePath, screenshotPath: screenshotError ? null : screenshotPath };
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

async function start(json, quiet = false, planEntry = null) {
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
    env: {
      ...process.env,
      ...(planEntry
        ? {
            TMUX_IDE_PRODUCT_JOURNEY: planEntry.journey.id,
            ...(planEntry.variant ? { TMUX_IDE_PRODUCT_JOURNEY_VARIANT: planEntry.variant } : {}),
          }
        : {}),
    },
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

async function stop(json, { quiet = false, strict = false, maxAttempts = 2 } = {}) {
  let state = readJson(statePath);
  if (!state) {
    if (!quiet) emit(json ? publicRigStatus(state) : "Product rig stopped", json);
    return null;
  }
  if (!processAlive(state.ownerPid)) {
    if (strict) {
      if (
        isCleanLegacyStoppedProductRigState(state, {
          processAlive,
          pathExists: existsSync,
        })
      ) {
        if (!quiet) emit(json ? publicRigStatus(state) : "Product rig stopped", json);
        return state;
      }
      const priorRequest = state.cleanup?.requestId ?? "missing-cleanup-request";
      const failures = productRigCleanupBarrierFailures(state, priorRequest, {
        processAlive,
        pathExists: existsSync,
      });
      if (failures.length > 0)
        throw new Error(`ProductRig stale owner residue: ${failures.join(", ")}`);
    }
    if (!quiet) emit(json ? publicRigStatus(state) : "Product rig stopped", json);
    return state;
  }
  if (
    state.cleanup?.status === "passed" &&
    ["stopped", "failed"].includes(state.status) &&
    typeof state.cleanup.requestId === "string"
  ) {
    const deathDeadline = Date.now() + 5_000;
    while (processAlive(state.ownerPid) && Date.now() < deathDeadline)
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    state = readJson(statePath) ?? state;
    if (!processAlive(state.ownerPid)) {
      if (strict) {
        const failures = productRigCleanupBarrierFailures(state, state.cleanup.requestId, {
          processAlive,
          pathExists: existsSync,
        });
        if (failures.length > 0)
          throw new Error(`ProductRig cleanup barrier failed: ${failures.join(", ")}`);
      }
      if (!quiet) emit(json ? publicRigStatus(state) : "Product rig stopped", json);
      return state;
    }
  }
  if (typeof state.ownerToken !== "string" || state.ownerToken.length < 32)
    throw new Error("ProductRig live owner has no exact shutdown token");

  let finalState = state;
  let requestId = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    requestId = `${Date.now()}-${randomBytes(6).toString("hex")}`;
    writeJsonAtomic(shutdownRequestPath, {
      version: 1,
      requestId,
      attempt,
      ownerPid: state.ownerPid,
      ownerToken: state.ownerToken,
      cleanupToken: state.runtimeNamespace?.cleanupToken ?? null,
    });
    try {
      finalState = await waitForState(
        (candidate) =>
          productRigCleanupAcknowledgesRequest(candidate, requestId) &&
          candidate.cleanup?.status &&
          ["cleanup-failed", "stopped", "failed"].includes(candidate.status),
        15_000,
        { allowTerminalFailure: true },
      );
    } catch (error) {
      if (attempt === maxAttempts || !strict) throw error;
      continue;
    }
    if (finalState.cleanup?.status === "passed") {
      requestId = finalState.cleanup.requestId;
      break;
    }
    if (attempt === maxAttempts)
      throw new Error(
        `ProductRig cleanup failed after bounded retry: ${(finalState.cleanup?.failures ?? [])
          .map(({ subsystem, detail }) => `${subsystem}:${detail}`)
          .join(", ")}`,
      );
  }

  const deathDeadline = Date.now() + 5_000;
  while (processAlive(finalState.ownerPid) && Date.now() < deathDeadline)
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  if (strict) {
    const failures = productRigCleanupBarrierFailures(finalState, requestId, {
      processAlive,
      pathExists: existsSync,
    });
    if (failures.length > 0)
      throw new Error(`ProductRig cleanup barrier failed: ${failures.join(", ")}`);
  }
  if (!quiet) emit(json ? publicRigStatus(finalState) : "Product rig stopped", json);
  return finalState;
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
  const findEntry = () => readJsonLines(lifecyclePath).findLast(predicate) ?? null;
  return await waitForLifecycleEntry({
    findEntry,
    subscribe: (check) => watch(lifecyclePath, { persistent: false }, check),
    timeoutMs,
    timeoutMessage,
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

async function provePreseededPanePublication(state, seed, timeoutMs = 5_000) {
  const count = (value, token) => value.split(token).length - 1;
  const deadline = performance.now() + timeoutMs;
  let sample = null;
  while (performance.now() < deadline) {
    const geometryBefore = activeWindowPaneGeometry(state);
    const target = geometryBefore.find(({ paneId }) => paneId === seed.paneId);
    if (!target?.semanticPaneId) throw new Error("preseed pane lost its canonical semantic id");
    const nativeByPane = new Map(
      geometryBefore.map(({ paneId }) => [
        paneId,
        execFileSync(
          "tmux",
          ["-S", state.runtimeNamespace.tmuxSocketPath, "capture-pane", "-p", "-J", "-t", paneId],
          { encoding: "utf8" },
        ),
      ]),
    );
    const frame = tuiCommand(state, ["capture"]);
    const geometryAfter = activeWindowPaneGeometry(state);
    const bodyRect = resolvePaneBodyRect(frame, target);
    const targetBody = paneBodyRegion(frame, target);
    sample = {
      daemonGeneration: state.daemon.instanceId,
      paneId: target.paneId,
      semanticPaneId: target.semanticPaneId,
      geometry: target,
      bodyRect,
      geometryStable: paneGeometryIdentity(geometryBefore) === paneGeometryIdentity(geometryAfter),
      markerHash: createHash("sha256").update(seed.marker).digest("hex"),
      nativeTargetOccurrences: count(nativeByPane.get(target.paneId) ?? "", seed.marker),
      nativeOtherOccurrences: [...nativeByPane.entries()]
        .filter(([paneId]) => paneId !== target.paneId)
        .reduce((total, [, body]) => total + count(body, seed.marker), 0),
      renderedTargetOccurrences: count(targetBody, seed.marker),
      renderedOutsideOccurrences: count(frame, seed.marker) - count(targetBody, seed.marker),
      frameHash: createHash("sha256").update(frame).digest("hex"),
    };
    if (
      sample.geometryStable &&
      sample.bodyRect.valid &&
      sample.bodyRect.bodyRows === sample.geometry.height &&
      sample.nativeTargetOccurrences === 1 &&
      sample.nativeOtherOccurrences === 0 &&
      sample.renderedTargetOccurrences === 1 &&
      sample.renderedOutsideOccurrences === 0
    )
      break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  if (
    !sample?.geometryStable ||
    !sample.bodyRect.valid ||
    sample.bodyRect.bodyRows !== sample.geometry.height ||
    sample.nativeTargetOccurrences !== 1 ||
    sample.nativeOtherOccurrences !== 0 ||
    sample.renderedTargetOccurrences !== 1 ||
    sample.renderedOutsideOccurrences !== 0
  )
    throw new Error(`preseeded coherent pane proof failed: ${JSON.stringify(sample)}`);
  const lifecycle = readJsonLines(join(state.tui.runtimeDir, "performance.jsonl"));
  const internalPublication = lifecycle.findLast(
    ({ phase, publicationPhase, daemonGeneration }) =>
      phase === "generation-host-internal-snapshot-publication" &&
      publicationPhase === "internal-snapshot-published" &&
      daemonGeneration === state.daemon.instanceId,
  );
  const hostFrame = lifecycle.findLast(
    ({ phase, daemonGeneration }) =>
      phase === "first-terminal-frame" && daemonGeneration === state.daemon.instanceId,
  );
  if (
    !Number.isFinite(internalPublication?.monotonicMicros) ||
    !Number.isFinite(hostFrame?.monotonicMicros) ||
    hostFrame.monotonicMicros < internalPublication.monotonicMicros
  )
    throw new Error("preseed pane has no ordered generation-fenced host publication evidence");
  const canonicalSeedPaint = qualifyCanonicalSeedPaint(
    readJsonLines(state.tui.performanceTracePath),
    {
      semanticPaneId: sample.semanticPaneId,
      generation: state.daemon.instanceId,
      canonicalCols: sample.geometry.width,
      canonicalRows: sample.geometry.height + 1,
      viewportCols: sample.bodyRect.width,
      viewportRows: sample.geometry.height,
      processId: hostFrame.processId,
      clockId: hostFrame.clockId,
      sourceEpoch: 1,
    },
  );
  return Object.freeze({ ...sample, internalPublication, hostFrame, canonicalSeedPaint });
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

async function diagnoseRuntimeQualification(planEntry) {
  diagnosticAttemptPhases.set(planEntry.runId, "product-rig-startup");
  await start(false, true, planEntry);
  let state = await waitForState((candidate) => candidate?.status === "ready");
  diagnosticAttemptPhases.set(planEntry.runId, "journey-drive");
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
  let causalProbeIncarnation = null;
  let resourcePhaseReleased = !tracePath;
  if (tracePath) {
    const fixturePane = activeTmuxPane(state);
    const fixtureShellCommand = execFileSync(
      "tmux",
      [
        "-S",
        state.runtimeNamespace.tmuxSocketPath,
        "display-message",
        "-p",
        "-t",
        fixturePane.paneId,
        "#{pane_current_command}",
      ],
      { encoding: "utf8" },
    ).trim();
    const fixtureCommand = `${shellSingleQuote(process.execPath)} ${shellSingleQuote(
      join(repoRoot, "scripts", "lib", "product-rig-causal-cell-fixture.mjs"),
    )}`;
    execFileSync("tmux", [
      "-S",
      state.runtimeNamespace.tmuxSocketPath,
      "send-keys",
      "-l",
      "-t",
      fixturePane.paneId,
      fixtureCommand,
    ]);
    execFileSync("tmux", [
      "-S",
      state.runtimeNamespace.tmuxSocketPath,
      "send-keys",
      "-t",
      fixturePane.paneId,
      "Enter",
    ]);
    const fixtureReadyDeadline = Date.now() + 2_000;
    let fixtureReady = "";
    while (Date.now() < fixtureReadyDeadline) {
      fixtureReady = execFileSync(
        "tmux",
        [
          "-S",
          state.runtimeNamespace.tmuxSocketPath,
          "show-options",
          "-pqv",
          "-t",
          fixturePane.paneId,
          "@tmux_ide_causal_fixture",
        ],
        { encoding: "utf8" },
      ).trim();
      if (fixtureReady === "ready-v1") break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    if (fixtureReady !== "ready-v1") throw new Error("causal-cell fixture did not fence readiness");
    const fixtureProcess = execFileSync(
      "tmux",
      [
        "-S",
        state.runtimeNamespace.tmuxSocketPath,
        "display-message",
        "-p",
        "-t",
        fixturePane.paneId,
        "#{pane_current_command}",
      ],
      { encoding: "utf8" },
    ).trim();
    if (fixtureProcess !== "node")
      throw new Error(`causal-cell raw/noecho fixture did not start (${fixtureProcess})`);
    const fixtureOption = () =>
      execFileSync(
        "tmux",
        [
          "-S",
          state.runtimeNamespace.tmuxSocketPath,
          "show-options",
          "-pqv",
          "-t",
          fixturePane.paneId,
          "@tmux_ide_causal_fixture",
        ],
        { encoding: "utf8" },
      ).trim();
    const paneCurrentCommand = () =>
      execFileSync(
        "tmux",
        [
          "-S",
          state.runtimeNamespace.tmuxSocketPath,
          "display-message",
          "-p",
          "-t",
          fixturePane.paneId,
          "#{pane_current_command}",
        ],
        { encoding: "utf8" },
      ).trim();
    const sendLiteralLine = (line) => {
      execFileSync("tmux", [
        "-S",
        state.runtimeNamespace.tmuxSocketPath,
        "send-keys",
        "-l",
        "-t",
        fixturePane.paneId,
        line,
      ]);
      execFileSync("tmux", [
        "-S",
        state.runtimeNamespace.tmuxSocketPath,
        "send-keys",
        "-t",
        fixturePane.paneId,
        "C-j",
      ]);
    };
    const resetFixtureBaseline = async (ordinal) => {
      const token = `probe-${ordinal}`;
      sendLiteralLine(`reset-v1;${token}`);
      const expectedOption = `ready-v1:${token}`;
      const deadline = Date.now() + 2_000;
      let identity = null;
      let stableSince = 0;
      let maximumStableMs = 0;
      let identityChanges = 0;
      let lastDiagnostic = null;
      while (Date.now() < deadline) {
        const activeBefore = activeTmuxPane(state);
        const native = execFileSync(
          "tmux",
          [
            "-S",
            state.runtimeNamespace.tmuxSocketPath,
            "capture-pane",
            "-p",
            "-t",
            fixturePane.paneId,
          ],
          { encoding: "utf8" },
        );
        const body = paneBodyRegion(tuiCommand(state, ["capture"]), activeBefore);
        const activeAfter = activeTmuxPane(state);
        const records = readJsonLines(tracePath);
        const processId = records.findLast(
          (record) => record?.type === "performance.trace.header",
        )?.processId;
        const queueObservation = productInputQueueObservation(records, processId);
        const geometryBefore = paneGeometryIdentity([activeBefore]);
        const geometryAfter = paneGeometryIdentity([activeAfter]);
        const nativeHash = createHash("sha256").update(native).digest("hex");
        const bodyHash = createHash("sha256").update(body).digest("hex");
        const nativeCell = terminalCellAt(native, 0, activeBefore.width - 1);
        const tuiCell = terminalCellAt(body, 0, activeBefore.width - 1);
        const nextIdentity = [
          geometryBefore,
          nativeHash,
          bodyHash,
          queueObservation?.type ?? "missing",
          queueObservation?.traceId ?? "no-trace",
          queueObservation?.operation ?? "no-operation",
          queueObservation?.atMicros ?? "no-clock",
          queueObservation?.inputPending ?? "missing",
          queueObservation?.inputInFlight ?? "missing",
          queueObservation?.inputPendingBytes ?? "missing",
        ].join(":");
        const observedOption = fixtureOption();
        const observedCommand = paneCurrentCommand();
        const readiness = causalFixtureBaselineReadiness({
          fixtureOption: observedOption,
          expectedOption,
          currentCommand: observedCommand,
          queueObservation,
          activePaneId: activeBefore.paneId,
          fixturePaneId: fixturePane.paneId,
          geometryBefore,
          geometryAfter,
          nativeCell,
          tuiCell,
        });
        const stable = readiness.ready;
        const now = Date.now();
        if (stable && nextIdentity === identity) {
          maximumStableMs = Math.max(maximumStableMs, now - stableSince);
          if (now - stableSince >= 100)
            return Object.freeze({ native, body, active: activeBefore });
        } else {
          if (identity !== null && nextIdentity !== identity) identityChanges += 1;
          identity = stable ? nextIdentity : null;
          stableSince = now;
        }
        lastDiagnostic = Object.freeze({
          processId: processId ?? null,
          predicates: readiness.predicates,
          fixtureOption: observedOption,
          expectedOption,
          currentCommand: observedCommand,
          queue: queueObservation
            ? {
                type: queueObservation.type,
                operation: queueObservation.operation ?? null,
                traceId: queueObservation.traceId ?? null,
                inputPending: queueObservation.inputPending,
                inputInFlight: queueObservation.inputInFlight,
                inputPendingBytes: queueObservation.inputPendingBytes,
              }
            : null,
          geometryBefore,
          geometryAfter,
          nativeCellBlank: nativeCell === " ",
          tuiCellBlank: tuiCell === " ",
          nativeHash,
          bodyHash,
          identityChanges,
          maximumStableMs,
          traceLength: records.length,
        });
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
      throw new Error(
        `causal-cell fixture baseline did not settle for probe ${ordinal}: ${JSON.stringify(lastDiagnostic)}`,
      );
    };
    let causalFailure = null;
    try {
      for (let ordinal = 0; ordinal < 30; ordinal += 1) {
        const baseline = await resetFixtureBaseline(ordinal);
        const marker = ordinal % 2 === 0 ? "x" : `p${ordinal.toString(36)}q`;
        const activeBefore = baseline.active;
        if (activeBefore.paneId !== fixturePane.paneId)
          throw new Error("causal-cell fixture lost active pane identity before input");
        const nativeBefore = baseline.native;
        const bodyBefore = baseline.body;
        const activePrepared = activeTmuxPane(state);
        if (
          activePrepared.paneId !== fixturePane.paneId ||
          paneGeometryIdentity([activeBefore]) !== paneGeometryIdentity([activePrepared])
        ) {
          throw new Error("causal-cell fixture geometry changed while capturing the baseline");
        }
        const epochBaseline = readJsonLines(tracePath).length;
        if (marker.length === 1) tuiCommand(state, ["text", marker]);
        else
          tuiCommand(state, ["input", JSON.stringify({ version: 1, kind: "paste", text: marker })]);
        const deadline = Date.now() + 2_000;
        // Do not make the diagnostic owner contend with the measured daemon/TUI
        // by reparsing a growing JSONL trace every 5ms during the causal path.
        // The trace timestamps are process-local, so this observation delay does
        // not enter the metric; it only keeps the observer from perturbing it.
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
        while (Date.now() < deadline) {
          const records = readJsonLines(tracePath);
          const processId = records.findLast(
            (record) => record?.type === "performance.trace.header",
          )?.processId;
          const epoch = causalProbeEpochState(records, epochBaseline, processId);
          if (epoch.status === "ambiguous" || epoch.status === "failed") {
            throw new Error(
              `causal-cell probe ${ordinal} ${epoch.status}: ${epoch.reason ?? "unknown"}`,
            );
          }
          const samples = causalInputSamples(records).filter(
            (sample) =>
              sample.generation === state.daemon.instanceId && sample.processId === processId,
          );
          const activePane = activeTmuxPane(state);
          const activePaneId = activePane.paneId;
          const nativeFrame = execFileSync(
            "tmux",
            ["-S", state.runtimeNamespace.tmuxSocketPath, "capture-pane", "-p", "-t", activePaneId],
            { encoding: "utf8" },
          );
          const tuiFrame = tuiCommand(state, ["capture"]);
          const activeAfter = activeTmuxPane(state);
          // Keep the semantic identity attached to the rectangle: tmux's pane
          // origin can drift from OpenTUI chrome while the semantic anchor stays
          // authoritative for the exact body we must qualify.
          const renderedBody = paneBodyRegion(tuiFrame, activePane);
          const candidate = samples.find(
            (sample) =>
              sample.traceId === epoch.traceId &&
              sample.semanticPaneId === activePane.semanticPaneId &&
              causalInputSampleHasIncarnation(sample) &&
              Number.isInteger(sample.revision) &&
              typeof sample.stateHash === "string",
          );
          const expectedCell = marker.at(-1);
          const causalPainted = candidate?.clientStages?.find(
            (stage) => stage.operation === "causal-cell-painted",
          );
          const geometryStable =
            activeAfter.paneId === fixturePane.paneId &&
            paneGeometryIdentity([activeBefore]) === paneGeometryIdentity([activePane]) &&
            paneGeometryIdentity([activePane]) === paneGeometryIdentity([activeAfter]);
          const exactProof =
            causalPainted?.causalAttribution === true &&
            causalPainted.semanticPaneId === activePane.semanticPaneId &&
            causalPainted.generation === state.daemon.instanceId &&
            causalPainted.incarnation === candidate?.incarnation &&
            Number.isInteger(causalPainted.row) &&
            Number.isInteger(causalPainted.column) &&
            causalPainted.revision === candidate?.revision &&
            causalPainted.stateHash === candidate?.stateHash;
          const beforeNativeCell = exactProof
            ? terminalCellAt(nativeBefore, causalPainted.row, causalPainted.column)
            : null;
          const beforeTuiCell = exactProof
            ? terminalCellAt(bodyBefore, causalPainted.row, causalPainted.column)
            : null;
          const afterNativeCell = exactProof
            ? terminalCellAt(nativeFrame, causalPainted.row, causalPainted.column)
            : null;
          const afterTuiCell = exactProof
            ? terminalCellAt(renderedBody, causalPainted.row, causalPainted.column)
            : null;
          if (
            candidate &&
            geometryStable &&
            exactProof &&
            beforeNativeCell === causalPainted.beforeGrapheme &&
            beforeTuiCell === causalPainted.beforeGrapheme &&
            afterNativeCell === expectedCell &&
            afterTuiCell === expectedCell &&
            causalPainted.afterGrapheme === expectedCell
          ) {
            if (causalProbeIncarnation !== null && causalProbeIncarnation !== candidate.incarnation)
              throw new Error("causal-cell probes crossed terminal incarnations");
            causalProbeIncarnation = candidate.incarnation;
            qualifyingInputEvidence.push({
              traceId: candidate.traceId,
              paintStateIdentity: "latest-canonical-state-blitted",
              marker,
              markerHash: createHash("sha256").update(marker).digest("hex"),
              semanticPaneId: candidate.semanticPaneId,
              incarnation: candidate.incarnation,
              revision: causalPainted.revision,
              stateHash: causalPainted.stateHash,
              row: causalPainted.row,
              column: causalPainted.column,
              beforeGrapheme: causalPainted.beforeGrapheme,
              afterGrapheme: causalPainted.afterGrapheme,
              markerVisibleInNative: true,
              markerVisibleInPaneRect: true,
              causalAttribution: true,
              fixtureKind: marker.length === 1 ? "single-key" : "paste",
              renderedBodyHash: createHash("sha256").update(renderedBody).digest("hex"),
            });
            break;
          }
          await new Promise((resolveWait) => setTimeout(resolveWait, 25));
        }
        if (qualifyingInputEvidence.length !== ordinal + 1)
          throw new Error(`causal-cell probe ${ordinal} did not close with exact paint evidence`);
      }
    } catch (error) {
      causalFailure = error;
    }
    const shellMarkerSuffix = randomBytes(8).toString("hex");
    const shellMarker = `tmux-ide-shell-ready-${shellMarkerSuffix}`;
    const teardownTraceBaseline = readJsonLines(tracePath).length;
    try {
      await runCausalFixtureTeardownGate({
        interrupt: () =>
          execFileSync("tmux", [
            "-S",
            state.runtimeNamespace.tmuxSocketPath,
            "send-keys",
            "-t",
            fixturePane.paneId,
            "C-c",
          ]),
        sendShellMarker: () =>
          sendLiteralLine(`printf '%s%s\\n' 'tmux-ide-shell-ready-' '${shellMarkerSuffix}'`),
        observe: () => {
          const activeBefore = activeTmuxPane(state);
          const native = execFileSync(
            "tmux",
            [
              "-S",
              state.runtimeNamespace.tmuxSocketPath,
              "capture-pane",
              "-p",
              "-t",
              fixturePane.paneId,
            ],
            { encoding: "utf8" },
          );
          const body = paneBodyRegion(tuiCommand(state, ["capture"]), activeBefore);
          const activeAfter = activeTmuxPane(state);
          const records = readJsonLines(tracePath);
          const processId = records.findLast(
            (record) => record?.type === "performance.trace.header",
          )?.processId;
          const canonicalExpected = {
            processId,
            semanticPaneId: fixturePane.semanticPaneId,
            generation: state.daemon.instanceId,
            incarnation: causalProbeIncarnation,
          };
          const canonical =
            causalProbeIncarnation === null
              ? null
              : latestCausalFixtureCanonicalMode(records, teardownTraceBaseline, canonicalExpected);
          const canonicalWraparound = canonical?.wraparound === true;
          const inputQueues = productInputQueueObservation(records, processId);
          const geometryBefore = paneGeometryIdentity([activeBefore]);
          const geometryAfter = paneGeometryIdentity([activeAfter]);
          const nativeHash = createHash("sha256").update(native).digest("hex");
          const bodyHash = createHash("sha256").update(body).digest("hex");
          const markerNativeIndex = native.indexOf(shellMarker);
          const markerTuiIndex = body.indexOf(shellMarker);
          const stabilityParts = Object.freeze({
            geometry: geometryBefore,
            nativeHash,
            bodyHash,
            queueType: inputQueues?.type ?? "missing",
            queueTraceId: inputQueues?.traceId ?? "no-trace",
            queueOperation: inputQueues?.operation ?? "no-operation",
            queueAtMicros: inputQueues?.atMicros ?? "no-clock",
            inputPending: inputQueues?.inputPending ?? "missing",
            inputInFlight: inputQueues?.inputInFlight ?? "missing",
            inputPendingBytes: inputQueues?.inputPendingBytes ?? "missing",
          });
          return {
            fixtureOption: fixtureOption(),
            currentCommand: paneCurrentCommand(),
            expectedCommand: fixtureShellCommand,
            marker: shellMarker,
            nativeFrame: native,
            tuiBody: body,
            markerNativeIndex: markerNativeIndex >= 0 ? markerNativeIndex : null,
            markerTuiIndex: markerTuiIndex >= 0 ? markerTuiIndex : null,
            canonicalWraparound,
            canonical,
            queueType: inputQueues?.type,
            queueOperation: inputQueues?.operation,
            queueTraceId: inputQueues?.traceId,
            queueAtMicros: inputQueues?.atMicros,
            inputPending: inputQueues?.inputPending,
            inputInFlight: inputQueues?.inputInFlight,
            inputPendingBytes: inputQueues?.inputPendingBytes,
            geometryStable: geometryBefore === geometryAfter,
            geometryBefore,
            geometryAfter,
            nativeHash,
            bodyHash,
            stabilityParts,
            stabilityIdentity: Object.values(stabilityParts).join(":"),
          };
        },
        releaseResource: () => {
          resourcePhaseReleased = true;
        },
      });
    } catch (teardownFailure) {
      if (causalFailure)
        throw new AggregateError(
          [causalFailure, teardownFailure],
          "Causal input qualification and fixture teardown both failed",
          { cause: teardownFailure },
        );
      throw teardownFailure;
    }
    if (causalFailure) throw causalFailure;
    if (qualifyingInputEvidence.length !== 30)
      throw new Error(`diagnostic input samples incomplete (${qualifyingInputEvidence.length}/30)`);
    if (
      causalProbeIncarnation === null ||
      qualifyingInputEvidence.some(({ incarnation }) => incarnation !== causalProbeIncarnation)
    )
      throw new Error("diagnostic input samples did not retain one terminal incarnation");
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
    // Eight fixed, unmeasured cycles condition xterm/allocator high-water
    // state before sixteen measured cycles. Every cycle still closes the same
    // load→clear→settle→single-probe epoch. All twenty-four cycles stay
    // in workload peak and queue evidence; only the final sixteen endpoint ids
    // enter retained-memory growth and slope calculations. No GC is forced.
    const resourceCycleEndpoints = [];
    for (const { cycle, phase, loadLines, cycleMarker, probe } of productResourceCyclePlan()) {
      if (!resourcePhaseReleased)
        throw new Error("Resource workload dispatched before causal fixture teardown");
      const flooded = `tmux-ide-flood-${cycle}`;
      const commands = productResourceCycleCommands({ cycle, loadLines });
      tuiCommand(state, ["text", commands.floodCommand]);
      tuiCommand(state, ["key", "Enter"]);
      await waitForTuiMarker(flooded);
      tuiCommand(state, ["text", commands.settleCommand]);
      tuiCommand(state, ["key", "Enter"]);
      await waitForTuiMarker(cycleMarker);

      // The marker command is outside the measured endpoint: its many input
      // characters repeatedly supersede the latest-only trace slot. Establish
      // a quiet, empty input lane before admitting exactly one probe byte.
      const settleDeadline = Date.now() + 2_000;
      let stableTraceIds = null;
      let stableSince = 0;
      let inputQuiet = false;
      while (Date.now() < settleDeadline) {
        const records = readJsonLines(tracePath);
        const traceIds = inputPaintSamples(records)
          .filter((sample) => sample.processId === activeProcessId)
          .map(({ traceId }) => traceId)
          .sort()
          .join("\n");
        const now = Date.now();
        if (productInputQueuesSettled(records, activeProcessId) && traceIds === stableTraceIds) {
          if (now - stableSince >= 100) {
            inputQuiet = true;
            break;
          }
        } else {
          stableTraceIds = traceIds;
          stableSince = now;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
      if (!inputQuiet)
        throw new Error(`TUI input queues did not settle for resource cycle ${cycle}`);

      const beforeSamples = inputPaintSamples(readJsonLines(tracePath)).filter(
        (sample) => sample.processId === activeProcessId,
      );
      const activePane = activeTmuxPane(state);
      const paneIdentity = paneGeometryIdentity([activePane]);
      const captureProbeObservation = () => {
        const paneBefore = activeTmuxPane(state);
        const native = execFileSync(
          "tmux",
          [
            "-S",
            state.runtimeNamespace.tmuxSocketPath,
            "capture-pane",
            "-p",
            "-t",
            paneBefore.paneId,
          ],
          { encoding: "utf8" },
        );
        const tuiFrame = tuiCommand(state, ["capture"]);
        const paneAfter = activeTmuxPane(state);
        const geometryIdentity = productResourceGeometryIdentity(tuiFrame, paneBefore);
        const stable =
          paneGeometryIdentity([paneBefore]) === paneIdentity &&
          paneGeometryIdentity([paneAfter]) === paneIdentity &&
          geometryIdentity !== null;
        return Object.freeze({
          stable,
          native,
          tui: paneBodyRegion(tuiFrame, paneBefore),
          geometryIdentity,
        });
      };
      const beforeProbe = captureProbeObservation();
      if (!beforeProbe.stable)
        throw new Error(`Resource probe geometry was not stable before cycle ${cycle}`);
      tuiCommand(state, ["text", probe]);
      const deadline = Date.now() + 2_000;
      let endpoint = null;
      let endpointCells = [];
      let lastSamples = beforeSamples;
      let postTraceIds = null;
      let postTraceStableSince = 0;
      while (Date.now() < deadline) {
        const records = readJsonLines(tracePath);
        lastSamples = inputPaintSamples(records).filter(
          (sample) => sample.processId === activeProcessId,
        );
        const afterProbe = captureProbeObservation();
        endpointCells = productResourceProbeCells({
          beforeNative: beforeProbe.native,
          afterNative: afterProbe.native,
          beforeTui: beforeProbe.tui,
          afterTui: afterProbe.tui,
          probe,
        });
        const traceIds = lastSamples
          .map(({ traceId }) => traceId)
          .sort()
          .join("\n");
        const now = Date.now();
        const traceQuiet = traceIds === postTraceIds && now - postTraceStableSince >= 100;
        if (traceIds !== postTraceIds) {
          postTraceIds = traceIds;
          postTraceStableSince = now;
        }
        const epoch = productResourceEndpointEpochState({
          beforeSamples,
          afterSamples: lastSamples,
          expected: {
            cycle,
            processId: activeProcessId,
            generation: state.daemon.instanceId,
            semanticPaneId: activePane.semanticPaneId,
          },
          inputSettled: productInputQueuesSettled(records, activeProcessId),
          traceQuiet,
          probeCellCount: endpointCells.length,
          geometryStable:
            afterProbe.stable && afterProbe.geometryIdentity === beforeProbe.geometryIdentity,
        });
        if (epoch.status === "ready") {
          endpoint = epoch.endpoint;
          break;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
      if (!endpoint) {
        selectProductResourceEndpoint(beforeSamples, lastSamples, {
          cycle,
          processId: activeProcessId,
          generation: state.daemon.instanceId,
          semanticPaneId: activePane.semanticPaneId,
        });
        throw new Error(`Resource probe endpoint did not settle for cycle ${cycle}`);
      }
      if (endpointCells.length !== 1)
        throw new Error(`TUI did not paint the resource probe cell for cycle ${cycle}`);
      resourceCycleEndpoints.push({ cycle, phase, traceId: endpoint.traceId });
      tuiCommand(state, ["key", "C-u"]);
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
    const resourceEndpointTraceIds =
      productResourceMeasuredEndpointTraceIds(resourceCycleEndpoints);
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
  diagnosticAttemptPhases.set(planEntry.runId, "evidence-capture");
  const captureEvidence = await captureArtifacts(
    state,
    `diagnose-${planEntry.journey.id}-r${planEntry.repetition}`,
  );
  diagnosticCaptures.set(planEntry.runId, captureEvidence);
  diagnosticAttemptPhases.set(planEntry.runId, "report-correlation");
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
  const baseReport = {
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
    journey: planEntry.journey.id,
    variant: planEntry.variant,
    repetition: planEntry.repetition,
    repeat: planEntry.repeat,
    runId: planEntry.runId,
    sourceProvenance: {
      commit: state.tui?.performanceTraceCommit ?? null,
      tree: state.tui?.performanceTraceTree ?? null,
    },
    warmHostPublications: Object.freeze([...warmHostPublications]),
  };
  const correlation = productDiagnosticCorrelation(state, captureEvidence);
  const correlationBoundary = {
    id: "diagnostic-correlation",
    status: correlation.complete ? "passed" : "unmeasured",
    detail: correlation.complete
      ? "daemon revision, WorkspaceClient state and Web semantic state aligned"
      : `missing ${correlation.missing.join(", ")}`,
  };
  const report = {
    ...baseReport,
    status:
      baseReport.status === "failed"
        ? "failed"
        : correlation.complete
          ? baseReport.status
          : "incomplete",
    firstUnmeasuredBoundary:
      baseReport.firstUnmeasuredBoundary ??
      (correlation.complete ? null : "diagnostic-correlation"),
    boundaries: Object.freeze([...baseReport.boundaries, Object.freeze(correlationBoundary)]),
    diagnosticCorrelation: {
      complete: correlation.complete,
      missing: correlation.missing,
    },
  };
  const reportPath = join(artifactDir, "diagnostic-report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return {
    report,
    reportPath,
    evidence: {
      report,
      alignment: {
        version: 1,
        journey: planEntry.journey.id,
        firstBrokenBoundary: report.firstBrokenBoundary,
        firstBrokenInputBoundary: report.firstBrokenInputBoundary,
        firstUnmeasuredBoundary: report.firstUnmeasuredBoundary,
        boundaries: report.boundaries,
        correlation: { complete: correlation.complete, missing: correlation.missing },
        availability: correlation.availability,
      },
      timeline: readDiagnosticText(timelinePath),
      tmuxTruth: captureEvidence.truth,
      daemonState: correlation.daemonState,
      clientState: correlation.clientState,
      tuiAnsi: readDiagnosticText(
        captureEvidence.tuiPath,
        "[unavailable: captured TUI artifact could not be read]\n",
      ),
      webPngPath: captureEvidence.webPath,
      stderr: boundedDiagnosticText(stderr),
      reproduction: diagnosticReproduction(planEntry.journey.id, planEntry.variant),
    },
  };
}

async function diagnoseConfiglessColdStart(planEntry) {
  diagnosticAttemptPhases.set(planEntry.runId, "product-rig-startup");
  await start(false, true, planEntry);
  const state = await waitForState((candidate) => candidate?.status === "ready");
  diagnosticAttemptPhases.set(planEntry.runId, "evidence-capture");
  const captureEvidence = await captureArtifacts(
    state,
    `diagnose-${planEntry.journey.id}-r${planEntry.repetition}`,
  );
  diagnosticCaptures.set(planEntry.runId, captureEvidence);
  tuiCommand(state, ["stop"]);
  const timeline = readJsonLines(timelinePath);
  const correlation = productDiagnosticCorrelation(state, captureEvidence);
  const { boundaries, firstBrokenBoundary, firstUnmeasuredBoundary, status } =
    assessConfiglessJourneyBoundaries({
      timeline,
      correlationComplete: correlation.complete,
      correlationMissing: correlation.missing,
      automaticPromotionCausalityComplete: Boolean(
        state.journeyEvidence?.configlessColdStart?.discovered?.publicLifecycle &&
        state.journeyEvidence?.configlessColdStart?.adopted?.fleetSessionId,
      ),
      canonicalSeedPaintComplete: Boolean(
        state.journeyEvidence?.configlessColdStart?.coherent?.canonicalSeedPaint,
      ),
    });
  const report = {
    version: 1,
    status,
    journey: planEntry.journey.id,
    variant: planEntry.variant,
    repetition: planEntry.repetition,
    repeat: planEntry.repeat,
    runId: planEntry.runId,
    firstBrokenBoundary,
    firstUnmeasuredBoundary,
    boundaries,
    journeyEvidence: state.journeyEvidence?.configlessColdStart ?? null,
    diagnosticCorrelation: { complete: correlation.complete, missing: correlation.missing },
    sourceProvenance: {
      commit: state.tui?.performanceTraceCommit ?? null,
      tree: state.tui?.performanceTraceTree ?? null,
    },
  };
  const stderr = readDiagnosticText(join(state.tui.runtimeDir, "stderr.log"));
  return {
    report,
    reportPath: null,
    evidence: {
      report,
      alignment: {
        version: 1,
        journey: planEntry.journey.id,
        firstBrokenBoundary,
        firstUnmeasuredBoundary,
        boundaries,
        correlation: { complete: correlation.complete, missing: correlation.missing },
        availability: correlation.availability,
      },
      timeline: readDiagnosticText(timelinePath),
      tmuxTruth: captureEvidence.truth,
      daemonState: correlation.daemonState,
      clientState: correlation.clientState,
      tuiAnsi: readDiagnosticText(captureEvidence.tuiPath),
      webPngPath: captureEvidence.webPath,
      stderr: boundedDiagnosticText(stderr),
      reproduction: diagnosticReproduction(planEntry.journey.id, planEntry.variant),
    },
  };
}

function executeProductJourney(planEntry) {
  return dispatchProductJourneyExecutor(planEntry, {
    "configless-cold-start": diagnoseConfiglessColdStart,
    "runtime-qualification": diagnoseRuntimeQualification,
  });
}

async function prepareDiagnosticFailure(planEntry, error, firstBrokenBoundary) {
  const state = readJson(statePath);
  const failureObservation = error?.observation ?? state?.failureObservation ?? null;
  let captureEvidence = diagnosticCaptures.get(planEntry.runId) ?? null;
  if (!captureEvidence && state?.status === "ready") {
    try {
      captureEvidence = await captureArtifacts(
        state,
        `diagnose-failure-${planEntry.journey.id}-r${planEntry.repetition}`,
      );
    } catch {
      // The bundle below records bounded unavailable artifacts without
      // replacing the original failure or pretending visual correlation.
    }
  }
  const failure = boundedDiagnosticText(
    error instanceof Error ? error.stack || error.message : String(error),
  );
  const stderrPath = state?.tui?.runtimeDir ? join(state.tui.runtimeDir, "stderr.log") : null;
  const stderr = stderrPath ? readDiagnosticText(stderrPath) : "";
  let truth = captureEvidence?.truth ?? null;
  if (!truth && state?.session) {
    try {
      truth = tmuxTruth(state);
    } catch {
      // Truth remains explicitly unavailable below.
    }
  }
  const tuiAvailable = Boolean(captureEvidence?.tuiPath && existsSync(captureEvidence.tuiPath));
  const webAvailable = Boolean(captureEvidence?.webPath && existsSync(captureEvidence.webPath));
  const correlation = productDiagnosticCorrelation(state, captureEvidence);
  const report = {
    version: 1,
    status: "failed",
    journey: planEntry.journey.id,
    variant: planEntry.variant,
    repetition: planEntry.repetition,
    repeat: planEntry.repeat,
    runId: planEntry.runId,
    firstBrokenBoundary,
    firstUnmeasuredBoundary: null,
    failure,
    failureObservation,
    sourceProvenance: {
      commit: state?.tui?.performanceTraceCommit ?? null,
      tree: state?.tui?.performanceTraceTree ?? null,
    },
  };
  return {
    report,
    reportPath: null,
    evidence: {
      report,
      alignment: {
        version: 1,
        journey: planEntry.journey.id,
        firstBrokenBoundary,
        failure,
        failureObservation,
        correlation: { complete: false, missing: correlation.missing },
        availability: {
          tmuxTruth: truth !== null,
          tui: tuiAvailable,
          web: webAvailable,
        },
      },
      timeline: readDiagnosticText(timelinePath),
      tmuxTruth: truth ?? {
        status: "unavailable",
        reason: `not captured before ${firstBrokenBoundary}`,
      },
      daemonState: correlation.daemonState,
      clientState: { ...correlation.clientState, failureObservation },
      tuiAnsi: tuiAvailable
        ? readDiagnosticText(captureEvidence.tuiPath)
        : `[unavailable: TUI frame not captured before ${firstBrokenBoundary}]\n`,
      ...(webAvailable ? { webPngPath: captureEvidence.webPath } : { webPng: UNAVAILABLE_WEB_PNG }),
      stderr,
      reproduction: diagnosticReproduction(planEntry.journey.id, planEntry.variant),
    },
  };
}

async function executeDiagnosticAttempt(entry) {
  try {
    return await runIsolatedProductJourneyAttempt(entry, {
      onPhase: (phase) => diagnosticAttemptPhases.set(entry.runId, phase),
      currentBoundary: () => diagnosticAttemptPhases.get(entry.runId) ?? "journey-drive",
      preCleanup: () => stop(false, { quiet: true, strict: true }),
      drive: () => executeProductJourney(entry),
      prepareFailure: (error, boundary) => prepareDiagnosticFailure(entry, error, boundary),
      postCleanup: async () =>
        createProductRigCleanupReceipt(
          entry,
          await stop(false, { quiet: true, strict: true, maxAttempts: 1 }),
          1,
        ),
      retryCleanup: async () =>
        createProductRigCleanupReceipt(
          entry,
          await stop(false, { quiet: true, strict: true, maxAttempts: 1 }),
          2,
        ),
      appendCleanupFailure: (failedResult, cleanupError) => {
        const cleanupFailure = boundedDiagnosticText(
          cleanupError instanceof Error
            ? cleanupError.stack || cleanupError.message
            : String(cleanupError),
        );
        failedResult.report.cleanupFailure = cleanupFailure;
        failedResult.evidence.alignment.cleanupFailure = cleanupFailure;
      },
      publishFailure: (failedResult, cleanupReceipt) => {
        const publication = prepareProductDiagnosticBundlePublication({
          root: diagnosticRoot,
          runId: entry.runId,
          report: failedResult.report,
          evidence: failedResult.evidence,
          cleanupReceipt,
        });
        const bundle = createProductDiagnosticBundle({
          root: diagnosticRoot,
          runId: entry.runId,
          evidence: publication.evidence,
        });
        if (join(bundle.runDir, "report.json") !== publication.reportPath)
          throw new Error("published diagnostic reportPath diverged from its sealed bundle");
        return bundle;
      },
      publishSuccess: (completed, cleanupReceipt) => {
        const publication = prepareProductDiagnosticBundlePublication({
          root: diagnosticRoot,
          runId: entry.runId,
          report: completed.report,
          evidence: completed.evidence,
          cleanupReceipt,
        });
        const bundle = createProductDiagnosticBundle({
          root: diagnosticRoot,
          runId: entry.runId,
          evidence: publication.evidence,
        });
        if (join(bundle.runDir, "report.json") !== publication.reportPath)
          throw new Error("published diagnostic reportPath diverged from its sealed bundle");
        return {
          report: publication.report,
          reportPath: publication.reportPath,
          bundle,
        };
      },
    });
  } finally {
    diagnosticCaptures.delete(entry.runId);
    diagnosticAttemptPhases.delete(entry.runId);
  }
}

async function diagnose(options) {
  const plan = resolveProductJourneyPlan(options).map((entry) => ({
    ...entry,
    runId: productDiagnosticRunId({
      journeyId: entry.journey.id,
      variant: entry.variant,
      repetition: entry.repetition,
      now: Date.now(),
      nonce: randomBytes(4).toString("hex"),
    }),
  }));
  const runs = await runProductJourneyPlan(plan, executeDiagnosticAttempt);
  const failed = runs.some(({ report }) => report.status !== "passed");
  const result =
    runs.length === 1
      ? { ...runs[0].report, reportPath: runs[0].reportPath, bundle: runs[0].bundle }
      : {
          version: 1,
          status: failed ? "failed" : "passed",
          runs: runs.map(({ report, reportPath, bundle }) => ({
            journey: report.journey,
            variant: report.variant,
            repetition: report.repetition,
            status: report.status,
            firstBrokenBoundary: report.firstBrokenBoundary,
            firstUnmeasuredBoundary: report.firstUnmeasuredBoundary,
            reportPath,
            bundle,
          })),
        };
  emit(
    options.json
      ? result
      : `Product diagnosis ${result.status}; ${runs.map(({ bundle }) => bundle.runDir).join(", ")}`,
    options.json,
  );
  if (failed) process.exitCode = 1;
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
      journeyRegistry: PRODUCT_JOURNEY_REGISTRY,
      journeyScope: auditProductJourneyScope(),
      diagnosticBundle: {
        root: ".tasks/product-diagnostics/<run-id>",
        files: PRODUCT_DIAGNOSTIC_BUNDLE_FILES,
        publication: "validated-fsynced-permission-sealed-atomic-rename",
      },
    },
  };
  emit(json ? report : JSON.stringify(report, null, 2), json);
}

async function observePublicElectedDaemon(daemonInfoDir, timeoutMs = 45_000) {
  const daemonInfoPath = join(daemonInfoDir, "daemon.json");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = readJson(daemonInfoPath);
    if (
      record &&
      Number.isInteger(record.pid) &&
      typeof record.instanceId === "string" &&
      typeof record.authToken === "string" &&
      Number.isInteger(record.port) &&
      processAlive(record.pid)
    )
      return record;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("public no-argument CLI did not elect a canonical daemon before deadline");
}

function attachPublicElectedDaemon(record) {
  const baseUrl = `http://${record.bindHostname ?? "127.0.0.1"}:${record.port}`;
  const headers = { Authorization: `Bearer ${record.authToken}` };
  const readJsonResponse = async (path, init = {}) => {
    const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
    if (!response.ok) throw new Error(`${path} answered ${response.status}`);
    return response.json();
  };
  const fleetCatalog = createFreshFleetCatalogReader(readJsonResponse);
  return {
    record,
    baseUrl,
    readiness: async () => (await readJsonResponse("/api/resources/startup-readiness")).ladder,
    workspaceCatalog: async () => readJsonResponse("/api/resources/workspace-catalog?version=2"),
    fleetCatalog,
    fleetLabels: async () => {
      const body = await readJsonResponse("/api/resources/fleet-catalog");
      return (body.sessions ?? []).map(({ label }) => label);
    },
    output: () => "",
    stop: async () => {
      const response = await fetch(`${baseUrl}/api/v2/action/daemon.shutdown`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: "product-rig-exact-owner-cleanup",
          expectedInstanceId: record.instanceId,
        }),
        signal: AbortSignal.timeout(2_000),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.ok !== true || result?.result?.stopping !== true)
        throw new Error(`public-elected daemon refused exact shutdown (${response.status})`);
      const deadline = Date.now() + 5_000;
      while (processAlive(record.pid) && Date.now() < deadline)
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      if (processAlive(record.pid))
        throw new Error(`public-elected daemon ${record.instanceId} remained live after shutdown`);
    },
  };
}

let ownerStartedAt = Date.now();
async function owner() {
  ownerStartedAt = Date.now();
  const journeyId = process.env.TMUX_IDE_PRODUCT_JOURNEY ?? "runtime-qualification";
  const slug = randomBytes(3).toString("hex");
  const ownerToken = randomBytes(24).toString("hex");
  let sleepAssertion = null;
  let fleet = null;
  let daemon = null;
  let devServer = null;
  let browser = null;
  let closing = false;
  let cleanupPromise = null;
  let sleepAssertionAcquisition = null;
  const ownerAbort = new AbortController();
  let state = {
    version: PRODUCT_RIG_STATE_VERSION,
    status: "starting",
    ownerPid: process.pid,
    ownerToken,
    artifactDir,
    timelinePath,
  };
  const publish = (patch) => {
    state = { ...state, ...patch };
    writeJsonAtomic(statePath, state);
  };
  const cleanup = (request = {}) => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      closing = true;
      ownerAbort.abort();
      const attempt = Number.isInteger(request.attempt) ? request.attempt : 1;
      const requestId = request.requestId ?? `internal-${Date.now()}`;
      event("cleanup-start", { requestId, attempt });
      const failures = [
        ...(await collectProductRigCleanupFailures([
          {
            subsystem: "tui",
            run: async () => {
              if (state.tui) tuiCommand(state, ["stop"]);
            },
          },
          { subsystem: "browser", run: async () => browser?.close() },
          { subsystem: "dev-server", run: async () => devServer?.stop() },
          { subsystem: "daemon", run: async () => daemon?.stop() },
          { subsystem: "fleet", run: async () => fleet?.dispose() },
          {
            subsystem: "sleep-assertion",
            run: async () => {
              const acquiredAssertion =
                sleepAssertion ?? (await sleepAssertionAcquisition?.catch(() => null));
              await acquiredAssertion?.release();
            },
          },
        ])),
      ];
      if (Number.isInteger(state.daemon?.pid) && processAlive(state.daemon.pid))
        failures.push({ subsystem: "daemon", detail: `pid ${state.daemon.pid} remained live` });
      for (const [subsystem, path] of [
        ["runtime-root", state.runtimeNamespace?.root],
        ["tmux-socket", state.runtimeNamespace?.tmuxSocketPath],
        ["host-tmux-socket", state.runtimeNamespace?.hostTmuxSocketPath],
        ["daemon-info", state.runtimeNamespace?.daemonInfoDir],
      ])
        if (typeof path === "string" && existsSync(path))
          failures.push({ subsystem, detail: `owned path remained: ${path}` });
      const passed = failures.length === 0;
      const ownerFailed = state.status === "failed" || typeof state.failure === "string";
      publish({
        status: passed ? (ownerFailed ? "failed" : "stopped") : "cleanup-failed",
        ...(passed ? { stoppedAt: new Date().toISOString() } : {}),
        cleanup: {
          version: 1,
          requestId,
          attempt,
          status: passed ? "passed" : "failed",
          cleanupToken: state.runtimeNamespace?.cleanupToken ?? null,
          failures,
          completedAt: new Date().toISOString(),
        },
        web: null,
      });
      event(passed ? "cleanup-complete" : "cleanup-failed", { requestId, attempt, failures });
      return { passed, failures };
    })().finally(() => {
      cleanupPromise = null;
    });
    return cleanupPromise;
  };
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(
      signal,
      () =>
        void cleanup({ requestId: `signal-${signal}-${Date.now()}`, attempt: 1 }).then((result) =>
          process.exit(result.passed ? 0 : 1),
        ),
    );
  }
  let handlingShutdownRequest = false;
  const shutdownPoller = setInterval(() => {
    if (handlingShutdownRequest) return;
    const request = readJson(shutdownRequestPath);
    if (
      !request ||
      request.ownerPid !== process.pid ||
      request.ownerToken !== ownerToken ||
      (state.runtimeNamespace?.cleanupToken &&
        request.cleanupToken !== state.runtimeNamespace.cleanupToken) ||
      request.requestId === state.cleanup?.requestId
    )
      return;
    handlingShutdownRequest = true;
    void cleanup(request)
      .then((result) => {
        if (result.passed) {
          clearInterval(shutdownPoller);
          rmSync(shutdownRequestPath, { force: true });
          process.exit(typeof state.failure === "string" ? 1 : 0);
        }
      })
      .finally(() => {
        handlingShutdownRequest = false;
      });
  }, 50);

  try {
    rmSync(timelinePath, { force: true });
    sleepAssertionAcquisition = acquireProductRigSleepAssertion({ signal: ownerAbort.signal });
    sleepAssertion = await sleepAssertionAcquisition;
    void sleepAssertion.failure.catch(async (error) => {
      if (closing) return;
      publish({ status: "failed", failure: error.stack ?? error.message });
      event("failed", { failure: error.message });
      await settleInternalProductRigCleanup({
        maxImmediateAttempts: 1,
        cleanup: (attempt) =>
          cleanup({ requestId: `sleep-assertion-failure-${Date.now()}`, attempt }),
        onTerminal: async () => {
          clearInterval(shutdownPoller);
          process.exit(1);
        },
        onRetryable: async () => {
          // Keep the token-valid shutdown poller alive for strict cleanup.
        },
      });
    });
    event("host-sleep-assertion-ready", {
      kind: sleepAssertion.kind,
      pid: sleepAssertion.pid,
    });
    if (!sleepAssertion.active())
      throw new Error("ProductRig host sleep assertion was not active before orchestration");
    event("namespace-start");
    if (journeyId === "configless-cold-start") {
      const coldBoot = await runConfiglessProductJourneyOwnerBoot(
        createConfiglessProductJourneyOwnerOperations({
          createNamespace: async ({ adoptSessions }) => {
            const marker = `RIG_CONFIGLESS_${randomBytes(6).toString("hex").toUpperCase()}`;
            const scratchFleet = await createScratchFleet({
              sessions: 1,
              slug,
              adoptSessions,
              initialPaneMarker: marker,
            });
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
              home: fleet.environment.HOME,
              projectDir: fleet.projectDir,
              registryDir: fleet.environment.TMUX_IDE_REGISTRY_DIR,
              settingsDir: fleet.environment.TMUX_IDE_SETTINGS_DIR,
              stateDir: fleet.environment.TMUX_IDE_HOME,
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
              daemonPerformanceTracePath: null,
              publicEntry: true,
            };
            publish({ session, runtimeNamespace, tui });
            const seedPane = activeWindowPaneGeometry(state).find(
              ({ windowActive }) => windowActive,
            );
            if (!seedPane) throw new Error("configless namespace has no preseeded active pane");
            event("ordinary-session-ready", { session, socketPath: fleet.socketPath });
            return {
              session,
              marker,
              runtimeNamespace,
              seed: { marker, paneId: seedPane.paneId, geometry: seedPane },
              tui,
            };
          },
          inspectNamespace: async (namespace) => {
            const configPaths = [
              join(namespace.runtimeNamespace.projectDir, ".tmux-ide", "workspace.yml"),
              join(namespace.runtimeNamespace.projectDir, "ide.yml"),
            ];
            const daemonEntries = readdirSync(namespace.runtimeNamespace.daemonInfoDir);
            const registryEntries = readdirSync(namespace.runtimeNamespace.registryDir);
            const sessionInventory = parseConfiglessTmuxSessionInventory(
              execFileSync(
                "tmux",
                [
                  "-S",
                  namespace.runtimeNamespace.tmuxSocketPath,
                  "list-sessions",
                  "-F",
                  CONFIGLESS_TMUX_SESSION_FORMAT,
                ],
                { encoding: "utf8", maxBuffer: 64 * 1024 },
              ),
              namespace.session,
            );
            const exactSession = sessionInventory.exact;
            return {
              workspaceConfigExists: existsSync(configPaths[0]),
              legacyConfigExists: existsSync(configPaths[1]),
              configPaths,
              daemonEntries,
              registryEntries,
              session: namespace.session,
              sessionNames: sessionInventory.sessionNames,
              adoptionStamp: exactSession.adoptionStamp,
              promotedStamp: exactSession.promotedStamp,
              workspaceNameStamp: exactSession.workspaceNameStamp,
              promotionOperationStamp: exactSession.promotionOperationStamp,
              workspaceOpenStamp: exactSession.workspaceOpenStamp,
              workspaceOpenOperationStamp: exactSession.workspaceOpenOperationStamp,
            };
          },
          buildBeforeMeasurement: async () => {
            await execFileAsync("bun", [join(repoRoot, "scripts", "build-tui.mjs")], {
              cwd: repoRoot,
              timeout: 120_000,
            });
            event("premeasurement-build-complete");
          },
          launchPublicEntry: async (launch) => {
            const actualEnvironment = commandEnv(state);
            for (const [key, value] of Object.entries(launch.environment))
              if (actualEnvironment[key] !== value)
                throw new Error(`public entry environment mismatch for ${key}`);
            if (
              "TMUX_IDE_TESTDRIVE_USE_CANONICAL_DAEMON" in actualEnvironment ||
              "TMUX_IDE_TESTDRIVE_CANONICAL_HOME" in actualEnvironment
            )
              throw new Error("public entry retained a canonical-daemon testdrive override");
            event("public-cli-spawn", {
              argv: ["bin/cli.js"],
              cwd: launch.cwd,
            });
            tuiCommand(state, [
              "start",
              "--public-entry",
              "--cwd",
              launch.cwd,
              "--cols",
              "160",
              "--rows",
              "44",
            ]);
            const status = JSON.parse(tuiCommand(state, ["status", "--json"]));
            if (status.entry !== "public-no-argument-cli")
              throw new Error("testdrive did not preserve the public no-argument CLI entry");
            return status;
          },
          observeElectedDaemon: async (namespace) => {
            const record = await observePublicElectedDaemon(
              namespace.runtimeNamespace.daemonInfoDir,
            );
            daemon = attachPublicElectedDaemon(record);
            publish({ daemon: record });
            event("daemon-election", { instanceId: record.instanceId, pid: record.pid });
            return daemon;
          },
          poll: async (label, probe) => {
            const deadline = Date.now() + 30_000;
            while (Date.now() < deadline) {
              const value = await probe();
              if (value) return value;
              await new Promise((resolveWait) => setTimeout(resolveWait, 50));
            }
            throw new Error(`${label} did not settle before deadline`);
          },
          readWorkspaceCatalog: (electedDaemon) => electedDaemon.workspaceCatalog(),
          readPublicLifecycle: (namespace) =>
            readJsonLines(join(namespace.tui.runtimeDir, "performance.jsonl")),
          readFleetCatalog: (electedDaemon) => electedDaemon.fleetCatalog(),
          recordObservation: async (phase, detail) => event(phase, detail),
          recordBoundary: async (phase, detail) => {
            if (phase === "canonical-promotion-adoption")
              publish({
                workspace: detail.workspaceName,
                daemon: {
                  ...state.daemon,
                  revision: detail.catalogRevision,
                  revisionKind: "fleet-catalog",
                },
              });
            event(phase, detail);
          },
          proveCoherentPublication: async (namespace, _electedDaemon, adopted) => {
            await waitForReadinessLadder(daemon);
            await waitForCoherentTui(state);
            const publication = await provePreseededPanePublication(state, namespace.seed);
            const workspaceClient = await waitForQualifiedWorkspaceClientState(
              () => readJsonLines(join(namespace.tui.runtimeDir, "performance.jsonl")),
              {
                processId: publication.hostFrame.processId,
                daemonGeneration: daemon.record.instanceId,
                workspaceName: state.workspace,
                sessionName: state.session,
                fleetSessionId: adopted.fleetSessionId,
                semanticPaneId: publication.semanticPaneId,
                canonicalGeneration: publication.canonicalSeedPaint.publication.generation,
              },
            );
            publish({
              convergence: { workspaceClient },
              tui: {
                ...namespace.tui,
                readiness: coherentReadiness({
                  chromeMs: publication.chromeElapsedMs ?? publication.elapsedMs,
                  terminalMs: publication.elapsedMs,
                }),
              },
            });
            event("coherent-terminal-publication", {
              markerHash: createHash("sha256").update(namespace.marker).digest("hex"),
              publication,
            });
            return publication;
          },
          startWebAfterColdBoundary: async () => {
            devServer = await startDevServer(daemon, {
              daemonInfoPath: join(fleet.daemonInfoDir, "daemon.json"),
            });
            browser = await chromium.launch({ headless: true });
            const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
            const page = await context.newPage();
            await page.goto(devServer.pageUrl, { waitUntil: "domcontentloaded" });
            await page.locator(".app[data-shell-source='runtime']").waitFor({ timeout: 60_000 });
            await page
              .locator(".terminal-surface[data-phase='connected']")
              .first()
              .waitFor({ timeout: 60_000 });
            publish({ web: { pageUrl: devServer.pageUrl, startedAfterColdBoundary: true } });
            event("web-started-after-cold-boundary", { pageUrl: devServer.pageUrl });
            await captureArtifacts(state, "configless-cold", page);
            return { pageUrl: devServer.pageUrl, semanticConnected: true };
          },
        }),
      );
      publish({
        journeyEvidence: {
          configlessColdStart: {
            discovered: coldBoot.discovered,
            adopted: coldBoot.adopted,
            coherent: coldBoot.coherent,
            publicProcess: coldBoot.publicProcess,
            web: coldBoot.web,
          },
        },
        status: "ready",
        readyAt: new Date().toISOString(),
      });
      await new Promise(() => undefined);
      return;
    }
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
    // Register before navigation: module-load failures often happen before any
    // selector can exist, and closing Chromium would otherwise destroy them.
    const webDiagnostics = installWebStartupDiagnostics(page);
    const webStartedAt = Date.now();
    const navigation = {
      requestedUrl: devServer.pageUrl,
      url: null,
      status: null,
    };
    try {
      const response = await page.goto(devServer.pageUrl, { waitUntil: "domcontentloaded" });
      navigation.url = response?.url() ?? page.url();
      navigation.status = response?.status() ?? null;
      await page.locator(".app[data-shell-source='runtime']").waitFor({ timeout: 60_000 });
      await page
        .locator(".terminal-surface[data-phase='connected']")
        .first()
        .waitFor({ timeout: 60_000 });
    } catch (error) {
      navigation.url ??= page.url();
      try {
        const failureArtifacts = await captureWebStartupFailure({
          page,
          diagnostics: webDiagnostics,
          navigation,
          devServer,
          daemon,
        });
        publish({ webStartupFailureArtifact: failureArtifacts.evidencePath });
        event("web-startup-failure-evidence", failureArtifacts);
      } catch (evidenceError) {
        event("web-startup-failure-evidence-error", {
          failure: evidenceError instanceof Error ? evidenceError.message : String(evidenceError),
        });
      }
      throw error;
    }
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
    publish(productRigTerminalFailureState(error, "product-rig-startup"));
    event("failed", {
      failure: error instanceof Error ? error.message : String(error),
      ...(daemonOutput ? { daemonOutput } : {}),
    });
    await settleInternalProductRigCleanup({
      maxImmediateAttempts: 2,
      cleanup: (attempt) =>
        cleanup({ requestId: `owner-failure-${attempt}-${Date.now()}`, attempt }),
      onTerminal: async () => {
        clearInterval(shutdownPoller);
        process.exitCode = 1;
      },
      onRetryable: async () => {
        // The exact owner must remain alive to accept the controller's final
        // tokened retry. No later journey can start while this poller survives.
        process.exitCode = 2;
      },
    });
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
  else if (command === "diagnose") await diagnose(parseProductDiagnoseOptions(args));
  else if (command === "inventory") inventory(json);
  else if (command === "stop") await stop(json);
  else if (["help", "--help", "-h"].includes(command)) process.stdout.write(usage());
  else throw new Error(`unknown command ${command}\n\n${usage()}`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
