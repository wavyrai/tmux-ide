#!/usr/bin/env node

/**
 * One real-product test rig: private tmux + one daemon + real TUI + real Web.
 * It is deliberately an operator/test surface, not a second product runtime.
 */
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
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
  PRODUCT_RIG_SOURCE_INVENTORY_MAX_BYTES,
  PRODUCT_RIG_SOURCE_INVENTORY_MAX_PATHS,
  PRODUCT_RIG_STATE_VERSION,
  activeTmuxPaneFromRows,
  bindPromotedInitialPane,
  appendBoundedWebDiagnostic,
  awaitWebDiagnosticWithDeadline,
  buildSourceTracePayload,
  buildProductDiagnosticReport,
  buildWebStartupEvidence,
  causalFixtureBaselineReadiness,
  causalInputSamples,
  causalInputSampleHasIncarnation,
  causalProbeEpochState,
  createProductRigAttemptTimelineClock,
  compareProductSourceProvenance,
  productRigSourceTraceIncludesPath,
  productRigHostHeartbeatObservation,
  productRigSourceTraceDiffArgs,
  productRigSourceTraceUntrackedArgs,
  readBoundedSourceTraceFiles,
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
import { runBoundedChildCommand } from "./lib/bounded-child-command.mjs";
import {
  assessCoherentFirstPaneBoundaries,
  assessConfiglessJourneyBoundaries,
  buildProductDiagnosticCorrelation,
  CONFIGLESS_TMUX_SESSION_FORMAT,
  createConfiglessProductJourneyOwnerOperations,
  createFreshFleetCatalogReader,
  parseConfiglessTmuxSessionInventory,
  qualifyCanonicalSeedPaint,
  qualifyCoherentFrameCausality,
  qualifyPreseededPaneEvidence,
  waitForCanonicalFrameFence,
  waitForQualifiedWorkspaceClientState,
} from "./lib/product-configless-owner.mjs";
import {
  PRODUCT_DIAGNOSTIC_BUNDLE_FILES,
  PRODUCT_JOURNEY_REGISTRY,
  auditProductJourneyScope,
  bufferOwnedTuiRuntimeEvidence,
  collectProductRigCleanupFailures,
  createProductRigCleanupReceipt,
  createProductDiagnosticBundle,
  createIsolatedTargetedTuiCwd,
  dispatchProductJourneyExecutor,
  parseProductDiagnoseOptions,
  prepareIsolatedTargetedTuiCwd,
  prepareOwnedTuiRuntime,
  productDiagnosticRunId,
  productRigTerminalFailureError,
  productRigTerminalFailureState,
  prepareProductDiagnosticBundlePublication,
  productRigCleanupAcknowledgesRequest,
  productRigCleanupBarrierFailures,
  isCleanLegacyStoppedProductRigState,
  resolveProductJourneyPlan,
  runConfiglessProductJourneyOwnerBoot,
  runCoherentFirstPaneOwnerBoot,
  runFirstKeyPasteOwnerBoot,
  runFocusOwnerBoot,
  runKeyboardPointerResizeOwnerBoot,
  runWindowLifecycleOwnerBoot,
  runIsolatedProductJourneyAttempt,
  runProductJourneyPlan,
  settleInternalProductRigCleanup,
  startOwnedProductRigDaemon,
} from "./product-test-rig-journeys.mjs";
import {
  assessFocusJourneyBoundaries,
  advanceFocusFramebufferStability,
  assessFocusFramebufferAttempt,
  decodeFocusFramebufferCapture,
  captureFocusWebSemanticDocument,
  inspectFocusFramebufferCapture,
  projectFocusFramebufferRect,
  qualifyFocusWorkspaceState,
  qualifyProductFocusEvidence,
  selectFocusCursorPresentationRow,
  sliceFocusTerminalCells,
  waitForFocusWebSemantic,
} from "./lib/product-focus.mjs";
import {
  assessProductWindowLifecycle,
  assessWindowPresentationFrames,
  assessWindowSwitchPhaseTimingRecords,
  assessWindowLifecycleJourneyBoundaries,
  classifyWindowTmuxPostFailureSnapshot,
  joinWindowResourcesToTmuxLabels,
  ownedWindowActionFailureObservation,
  qualifyWindowWorkspaceState,
  summarizeWindowPartialRuntimeEvidence,
  windowApplicationShellTimeoutObservation,
  windowLifecycleWriterFailureObservation,
  windowSwitchInputFailureObservation,
  windowSwitchSelectionFailureObservation,
} from "./lib/product-window-lifecycle.mjs";
import {
  assessKeyboardPointerResizeJourneyBoundaries,
  assessExactResizeTmuxBaseline,
  assessResizePostPromotionCommands,
  assessProductKeyboardPointerResize,
  inspectResizeGuideFramebuffer,
} from "./lib/product-keyboard-pointer-resize.mjs";
import { runBoundedFocusTmux } from "./lib/product-focus-tmux.mjs";
import { readBoundedDiagnosticTail } from "./lib/bounded-diagnostic-tail.mjs";
import { parseLayout } from "../packages/daemon/src/terminal/protocol/layout-parse.ts";
import {
  assessFirstKeyPasteBoundaries,
  assessProductFirstInput,
  assessProductInputDistribution,
  productFirstInputDocument,
  productCoherentFrameTimeoutObservation,
  launchAndWaitForExactProductTui,
  productInputOutlierEvidence,
  qualifyProductFirstInput,
  qualifyProductInputDistribution,
  settleProductFirstInputFixtureReset,
  summarizeProductInputDistribution,
  waitForProductInputQualification,
  waitForProductInputPersistenceFence,
} from "./lib/product-first-input.mjs";
import {
  classifyProductTuiCommandFailure,
  exactProductTuiLaunchReceipt,
  waitForProductTuiHostReadiness,
} from "./lib/product-tui-host-readiness.mjs";

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
let diagnosticFrozenProvenance = null;
const activeTuiCommandPids = new Set();
const productInputFingerprintKeys = new Map();
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

function boundedRuntimeJsonLines(path) {
  const tail = readBoundedDiagnosticTail(path);
  const text = tail.available ? tail.text : "";
  if (!text)
    return Object.freeze({
      text: "",
      records: Object.freeze([]),
      available: false,
      reason: tail.reason,
    });
  const records = text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  return Object.freeze({
    text,
    records: Object.freeze(records),
    available: true,
    reason: null,
  });
}

function partialProductRuntimeEvidence(state) {
  const runtimeDir = state?.tui?.runtimeDir;
  const tracePath = state?.tui?.performanceTracePath;
  const lifecycle =
    typeof runtimeDir === "string"
      ? boundedRuntimeJsonLines(join(runtimeDir, "performance.jsonl"))
      : { text: "", records: [] };
  const trace =
    typeof tracePath === "string" ? boundedRuntimeJsonLines(tracePath) : { text: "", records: [] };
  return summarizeWindowPartialRuntimeEvidence({
    lifecycleText: lifecycle.text,
    lifecycleRecords: lifecycle.records,
    lifecycleReadReason: lifecycle.reason ?? null,
    referenceText: trace.text,
    referenceRecords: trace.records,
    referenceReadReason: trace.reason ?? null,
  });
}

function productDiagnosticCorrelation(state, captureEvidence) {
  const tuiAvailable = Boolean(captureEvidence?.tuiPath && existsSync(captureEvidence.tuiPath));
  const webAvailable = Boolean(captureEvidence?.webPath && existsSync(captureEvidence.webPath));
  const configless = state?.journeyEvidence?.configlessColdStart ?? null;
  const coherent = state?.journeyEvidence?.coherentFirstPane ?? null;
  const firstInput = state?.journeyEvidence?.firstKeyPaste ?? null;
  const focus = state?.journeyEvidence?.focus ?? null;
  const windowLifecycle = state?.journeyEvidence?.windowLifecycle ?? null;
  const keyboardPointerResize = state?.journeyEvidence?.keyboardPointerResize ?? null;
  const exact = configless
    ? {
        fleetSessionId: configless.adopted?.fleetSessionId,
        catalogRevision: configless.adopted?.catalogRevision,
        semanticPaneId: configless.coherent?.semanticPaneId,
      }
    : coherent
      ? {
          fleetSessionId: coherent.identity?.fleetSessionId,
          catalogRevision: coherent.identity?.catalogRevision,
          semanticPaneId: coherent.coherent?.semanticPaneId,
        }
      : firstInput
        ? {
            fleetSessionId: firstInput.identity?.fleetSessionId,
            catalogRevision: firstInput.identity?.catalogRevision,
            semanticPaneId: firstInput.distribution?.semanticPaneId,
          }
        : focus
          ? {
              fleetSessionId: focus.identity?.fleetSessionId,
              catalogRevision: focus.identity?.catalogRevision,
              semanticPaneId: focus.reclaim?.assessment?.qualified?.semanticPaneId,
            }
          : windowLifecycle
            ? {
                fleetSessionId: windowLifecycle.identity?.fleetSessionId,
                catalogRevision: windowLifecycle.identity?.catalogRevision,
                semanticPaneId: windowLifecycle.renamed?.selected?.semanticPaneId,
              }
            : keyboardPointerResize
              ? {
                  fleetSessionId: keyboardPointerResize.expected?.fleetSessionId,
                  catalogRevision: keyboardPointerResize.expected?.catalogRevision,
                  semanticPaneId: keyboardPointerResize.expected?.semanticPaneId,
                }
              : null;
  return buildProductDiagnosticCorrelation({
    state,
    tuiAvailable,
    webAvailable,
    web: captureEvidence?.web ?? null,
    expected: exact
      ? {
          daemonGeneration: state?.daemon?.instanceId ?? null,
          workspaceName: state?.workspace ?? null,
          sessionName: state?.session ?? null,
          fleetSessionId: exact.fleetSessionId ?? null,
          catalogRevision: exact.catalogRevision ?? null,
          semanticPaneId: exact.semanticPaneId ?? null,
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

let attemptTimelineOriginMs = performance.timeOrigin + performance.now();
let attemptTimelineClock = createProductRigAttemptTimelineClock(undefined, attemptTimelineOriginMs);

function resetAttemptTimelineClock(origin = performance.timeOrigin + performance.now()) {
  if (!Number.isFinite(origin)) throw new Error("Product rig timeline origin is unavailable");
  attemptTimelineOriginMs = origin;
  attemptTimelineClock = createProductRigAttemptTimelineClock(undefined, origin);
}

function event(phase, detail = {}) {
  const entry = {
    at: new Date().toISOString(),
    phase,
    ...detail,
    elapsedMs: attemptTimelineClock.elapsedMs(),
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
          TMUX_IDE_PERFORMANCE_TRACE_DETAIL: state.tui.performanceTraceDetail ?? "1",
          TMUX_IDE_PERFORMANCE_TRACE_INPUT_ORIGIN: state.tui.performanceTraceInputOrigin ?? "0",
          TMUX_IDE_PERFORMANCE_TRACE_INPUT_DETAIL: state.tui.performanceTraceInputDetail ?? "0",
          TMUX_IDE_PERFORMANCE_TRACE_INPUT_FINGERPRINT_KEY:
            productInputFingerprintKeys.get(state.tui.runtimeDir) ?? "",
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
    diff = execFileSync("git", productRigSourceTraceDiffArgs(), {
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
  let untrackedOutput;
  try {
    untrackedOutput = execFileSync("git", productRigSourceTraceUntrackedArgs(), {
      cwd: repoRoot,
      maxBuffer: PRODUCT_RIG_SOURCE_INVENTORY_MAX_BYTES,
    });
  } catch (error) {
    if (error?.code === "ENOBUFS")
      throw new Error("Product rig untracked source inventory exceeded its byte ceiling", {
        cause: error,
      });
    throw error;
  }
  const untracked = untrackedOutput.toString("utf8").split("\0").filter(Boolean).sort();
  if (untracked.length > PRODUCT_RIG_SOURCE_INVENTORY_MAX_PATHS)
    throw new Error("Product rig untracked source inventory exceeded its path-count ceiling");
  const includedUntracked = untracked.filter(productRigSourceTraceIncludesPath);
  for (const path of includedUntracked) {
    if (path.startsWith("/") || path.split("/").includes("..") || /[\0\r\n]/u.test(path)) {
      throw new Error(`Product rig untracked source path is malformed: ${path}`);
    }
  }
  const untrackedFiles = readBoundedSourceTraceFiles(diff, includedUntracked, {
    openFile: (path) =>
      openSync(resolve(repoRoot, path), fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)),
    statFile: fstatSync,
    readFile: (descriptor, size) => {
      const content = Buffer.allocUnsafe(size);
      let offset = 0;
      while (offset < size) {
        const bytesRead = readSync(descriptor, content, offset, size - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const grew = readSync(descriptor, Buffer.allocUnsafe(1), 0, 1, size) !== 0;
      if (offset !== size || grew)
        throw new Error("Product rig untracked source changed while hashing");
      return content;
    },
    closeFile: closeSync,
  });
  const payload = buildSourceTracePayload(diff, untrackedFiles);
  const tree = execFileSync("git", ["hash-object", "--stdin"], {
    cwd: repoRoot,
    input: payload,
    encoding: "utf8",
  }).trim();
  const trackedPaths = execFileSync(
    "git",
    [
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      "HEAD",
      "--",
      ".",
      ":(exclude)packages/daemon/native/**",
    ],
    { cwd: repoRoot, maxBuffer: PRODUCT_RIG_SOURCE_INVENTORY_MAX_BYTES },
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const manifestPaths = [...new Set([...trackedPaths, ...includedUntracked])].sort();
  if (manifestPaths.length > PRODUCT_RIG_SOURCE_INVENTORY_MAX_PATHS)
    throw new Error("Product rig source manifest exceeded its path-count ceiling");
  let manifestBytes = 0;
  const manifest = manifestPaths.map((path) => {
    const pathDigest = createHash("sha256").update(path).digest("hex");
    let descriptor;
    try {
      descriptor = openSync(
        resolve(repoRoot, path),
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      );
    } catch (error) {
      if (error?.code === "ENOENT") {
        return Object.freeze({
          pathDigest,
          contentDigest: createHash("sha256").update("deleted").digest("hex"),
          bytes: 0,
        });
      }
      throw error;
    }
    try {
      const before = fstatSync(descriptor);
      if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size < 0)
        throw new Error("Product rig source manifest encountered a non-regular file");
      manifestBytes += before.size;
      if (manifestBytes > PRODUCT_RIG_SOURCE_DIFF_MAX_BYTES)
        throw new Error("Product rig source manifest exceeded its byte ceiling");
      const content = Buffer.allocUnsafe(before.size);
      let offset = 0;
      while (offset < before.size) {
        const count = readSync(descriptor, content, offset, before.size - offset, offset);
        if (count === 0) break;
        offset += count;
      }
      const grew = readSync(descriptor, Buffer.allocUnsafe(1), 0, 1, before.size) !== 0;
      const after = fstatSync(descriptor);
      if (
        offset !== before.size ||
        grew ||
        after.size !== before.size ||
        after.dev !== before.dev ||
        after.ino !== before.ino
      )
        throw new Error("Product rig source changed while building its manifest");
      return Object.freeze({
        pathDigest,
        contentDigest: createHash("sha256").update(content).digest("hex"),
        bytes: content.length,
      });
    } finally {
      closeSync(descriptor);
    }
  });
  const manifestDigest = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  const provenance = Object.freeze({
    commit,
    tree,
    manifestDigest,
    manifest: Object.freeze(manifest),
  });
  const expectedCommit = process.env.TMUX_IDE_PRODUCT_EXPECTED_SOURCE_COMMIT;
  const expectedTree = process.env.TMUX_IDE_PRODUCT_EXPECTED_SOURCE_TREE;
  const expectedManifest = process.env.TMUX_IDE_PRODUCT_EXPECTED_SOURCE_MANIFEST;
  if (
    (expectedCommit && expectedCommit !== provenance.commit) ||
    (expectedTree && expectedTree !== provenance.tree) ||
    (expectedManifest && expectedManifest !== provenance.manifestDigest)
  ) {
    const error = new Error("ProductRig source provenance changed before TUI launch");
    error.boundary = "source-provenance";
    throw error;
  }
  return provenance;
}

function assertFrozenProductSource(stage) {
  if (!diagnosticFrozenProvenance) return;
  const actual = sourceTraceProvenance();
  const assessment = compareProductSourceProvenance(diagnosticFrozenProvenance, actual);
  if (assessment.stable) return;
  const error = new Error(`ProductRig source provenance changed ${stage}`);
  error.boundary = "source-provenance";
  error.observation = Object.freeze({
    operation: "product-rig-source-provenance",
    reason: "source-drift",
    stage,
    commitExact: assessment.commitExact,
    treeExact: assessment.treeExact,
    manifestExact: assessment.manifestExact,
    changedCount: Math.min(assessment.changedCount, PRODUCT_RIG_SOURCE_INVENTORY_MAX_PATHS),
    changedPathDigests: assessment.changedPathDigests,
    expectedManifestDigest: diagnosticFrozenProvenance.manifestDigest,
    actualManifestDigest: actual.manifestDigest,
  });
  throw error;
}

function tuiCommand(state, args, options = {}) {
  return execFileSync(process.execPath, [join(repoRoot, "scripts", "tui-testdrive.mjs"), ...args], {
    cwd: repoRoot,
    env: commandEnv(state),
    encoding: "utf8",
    stdio: options.ignore ? "ignore" : ["ignore", "pipe", "pipe"],
  });
}

async function tuiCommandAsync(state, args, { timeout = 5_000, signal } = {}) {
  const { stdout } = await runBoundedChildCommand({
    executable: process.execPath,
    args: [join(repoRoot, "scripts", "tui-testdrive.mjs"), ...args],
    options: {
      cwd: repoRoot,
      env: commandEnv(state),
      encoding: "utf8",
      maxBuffer: 64 * 1_024,
    },
    timeoutMs: timeout,
    signal,
    onSpawn: (pid) => {
      if (Number.isSafeInteger(pid)) activeTuiCommandPids.add(pid);
    },
    onSettled: (pid) => {
      if (Number.isSafeInteger(pid)) activeTuiCommandPids.delete(pid);
    },
  });
  return stdout;
}

function focusHostReadinessObservation(
  state,
  {
    reason,
    stage = "atomic-host-display",
    attempts,
    startedAt,
    deadlineMs,
    currentHostIdentity = null,
  },
) {
  const lifecycle = readJsonLines(join(state.tui.runtimeDir, "performance.jsonl"));
  const stderr = readDiagnosticText(join(state.tui.runtimeDir, "stderr.log"));
  const metadataPath = join(state.tui.runtimeDir, "state.json");
  const metadata = existsSync(metadataPath) ? readJson(metadataPath) : null;
  return Object.freeze({
    operation: "focus-host-ready",
    reason,
    stage,
    attempts,
    elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
    deadlineMs,
    metadataPresent: metadata !== null,
    metadataProcessId: Number.isSafeInteger(metadata?.processId) ? metadata.processId : null,
    metadataProcessAlive: processAlive(metadata?.processId),
    currentHostIdentity,
    lifecycleCount: Math.min(lifecycle.length, 256),
    latestLifecyclePhase:
      typeof lifecycle.at(-1)?.phase === "string" ? lifecycle.at(-1).phase.slice(0, 64) : null,
    stderrBytes: Math.min(Buffer.byteLength(stderr), 65_536),
    stderrSha256: createHash("sha256").update(stderr).digest("hex"),
  });
}

async function waitForExactFocusHostReceipt(state, launched, { deadlineMs = 10_000, signal } = {}) {
  const startedAt = performance.now();
  const result = await waitForProductTuiHostReadiness({
    launched,
    readStatus: async ({ remainingMs }) => {
      const commandTimeout = Math.min(1_500, remainingMs);
      const controller = new AbortController();
      let timeoutFired = false;
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => {
        timeoutFired = true;
        controller.abort();
      }, commandTimeout);
      try {
        const parsed = JSON.parse(
          await tuiCommandAsync(state, ["status", "--json"], {
            timeout: commandTimeout,
            signal: controller.signal,
          }),
        );
        return parsed && typeof parsed === "object" && typeof parsed.running === "boolean"
          ? parsed
          : { running: false, statusObservation: { reason: "identity-invalid" } };
      } catch (error) {
        if (error instanceof SyntaxError) {
          return { running: false, statusObservation: { reason: "identity-invalid" } };
        }
        const reason = signal?.aborted
          ? "aborted"
          : classifyProductTuiCommandFailure(error, { timeoutFired });
        if (reason === "host-status-timeout") {
          return { running: false, statusObservation: { reason: "host-status-timeout" } };
        }
        if (reason === "aborted") {
          const aborted = new Error("focus host status aborted", { cause: error });
          aborted.code = "ABORT_ERR";
          throw aborted;
        }
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    },
    isProcessAlive: processAlive,
    deadlineMs,
    signal,
  });
  if (result.passed) return result.status;
  const failure = new Error(`focus host readiness failed: ${result.reason}`);
  failure.boundary = "focus-host-ready";
  failure.observation = focusHostReadinessObservation(state, {
    reason: result.reason,
    attempts: result.attempts,
    startedAt,
    deadlineMs,
    currentHostIdentity: result.currentHostIdentity,
  });
  throw failure;
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

function sessionPaneGeometry(state) {
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
    .filter(({ paneId }) => Boolean(paneId));
}

function activeWindowPaneGeometry(state) {
  return sessionPaneGeometry(state).filter(({ windowActive }) => windowActive);
}

async function focusTargetTmux(state, args, { deadline, signal, maxBuffer = 64 * 1_024 }) {
  return runBoundedFocusTmux({
    socketPath: state.runtimeNamespace.tmuxSocketPath,
    args,
    deadline,
    signal,
    maxBuffer,
  });
}

function parseFocusPaneGeometry(stdout) {
  const panes = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [paneId, windowActive, semanticPaneId, left, top, width, height] = line.split("\t");
      return {
        paneId,
        semanticPaneId,
        windowActive: windowActive === "1",
        left: Number(left),
        top: Number(top),
        width: Number(width),
        height: Number(height),
      };
    });
  if (
    panes.length < 1 ||
    panes.some(
      (pane) =>
        !/^%[0-9]+$/u.test(pane.paneId ?? "") ||
        typeof pane.semanticPaneId !== "string" ||
        pane.semanticPaneId.length < 1 ||
        ![pane.left, pane.top, pane.width, pane.height].every(Number.isSafeInteger) ||
        pane.left < 0 ||
        pane.top < 0 ||
        pane.width < 1 ||
        pane.height < 1,
    )
  )
    throw new Error("focus target pane geometry was invalid");
  return panes;
}

async function focusActiveWindowPaneGeometry(state, lifecycle) {
  const stdout = await focusTargetTmux(
    state,
    [
      "list-panes",
      "-s",
      "-t",
      `=${state.session}`,
      "-F",
      "#{pane_id}\t#{window_active}\t#{@tmux_ide_pane_id}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}",
    ],
    lifecycle,
  );
  return parseFocusPaneGeometry(stdout).filter(({ windowActive }) => windowActive);
}

async function exactWindowTmuxSnapshot(state, expected, timeoutMs = 2_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const stdout = await focusTargetTmux(
      state,
      [
        "list-panes",
        "-s",
        "-t",
        `=${state.session}`,
        "-F",
        "#{window_id}\t#{@tmux_ide_window_id}\t#{window_name}\t#{window_active}\t#{window_width}\t#{window_height}\t#{pane_id}\t#{@tmux_ide_pane_id}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}",
      ],
      { deadline: performance.now() + timeoutMs, signal: controller.signal },
    );
    const rows = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [
          nativeWindowId,
          resourceId,
          name,
          active,
          windowCols,
          windowRows,
          paneId,
          semanticPaneId,
          left,
          top,
          cols,
          rows,
        ] = line.split("\t");
        return Object.freeze({
          nativeWindowId,
          resourceId,
          name,
          active: active === "1",
          paneId,
          semanticPaneId,
          geometry: Object.freeze({
            windowCols: Number(windowCols),
            windowRows: Number(windowRows),
            left: Number(left),
            top: Number(top),
            cols: Number(cols),
            rows: Number(rows),
          }),
        });
      });
    const exact =
      rows.length === expected.length &&
      rows.filter(({ active }) => active).length === 1 &&
      rows.every(
        (row) =>
          /^@[0-9]+$/u.test(row.nativeWindowId) &&
          /^%[0-9]+$/u.test(row.paneId) &&
          Object.values(row.geometry).every(Number.isSafeInteger) &&
          row.geometry.windowCols > 0 &&
          row.geometry.windowRows > 0 &&
          row.geometry.left >= 0 &&
          row.geometry.top >= 0 &&
          row.geometry.cols > 0 &&
          row.geometry.rows > 0 &&
          typeof row.resourceId === "string" &&
          row.resourceId.length > 0 &&
          row.resourceId.length <= 256 &&
          expected.some(
            (window) =>
              `terminal-window.${createHash("sha256").update(row.resourceId).digest("hex").slice(0, 20)}` ===
                window.windowResourceId &&
              row.semanticPaneId === window.semanticPaneId &&
              (!("name" in window) || row.name === window.name) &&
              row.active === window.active,
          ),
      );
    if (!exact) {
      const error = new Error("exact window tmux snapshot did not match semantic inventory");
      error.observation = Object.freeze({
        operation: "window-tmux-snapshot",
        expectedCount: Math.min(expected.length, 513),
        actualCount: Math.min(rows.length, 513),
        activeCount: Math.min(rows.filter(({ active }) => active).length, 513),
      });
      throw error;
    }
    return Object.freeze(rows);
  } finally {
    clearTimeout(timer);
  }
}

async function canonicalWindowLayout(state, paneId, lifecycle) {
  const stdout = await focusTargetTmux(
    state,
    [
      "list-panes",
      "-t",
      paneId,
      "-F",
      "#{window_visible_layout}\t#{window_id}\t#{?window_zoomed_flag,1,0}\t#{pane-border-status}\t#{pane_id}\t#{@tmux_ide_pane_id}\t#{pane_active}",
    ],
    lifecycle,
  );
  const rows = stdout
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"));
  const [first] = rows;
  const [visibleLayout = "", windowId = "", zoomed = "", paneBorderStatus = ""] = first ?? [];
  const parsed = parseLayout(visibleLayout);
  if (
    !parsed ||
    !["top", "bottom", "off"].includes(paneBorderStatus) ||
    rows.some(
      (row) =>
        row[0] !== visibleLayout ||
        row[1] !== windowId ||
        row[2] !== zoomed ||
        row[3] !== paneBorderStatus,
    )
  )
    return null;
  const semanticByRawPaneId = new Map(
    rows.map(([, , , , rawPaneId = "", semanticPaneId = "", active = ""]) => [
      rawPaneId,
      { semanticPaneId, active: active === "1" },
    ]),
  );
  const panes = parsed.leaves.map((leaf) => {
    const identity = semanticByRawPaneId.get(leaf.id);
    if (!identity?.semanticPaneId) return null;
    return Object.freeze({
      pane: identity.semanticPaneId,
      left: leaf.left,
      top: leaf.top,
      width: leaf.width,
      height: leaf.height,
      active: identity.active,
    });
  });
  if (
    panes.some((pane) => pane === null) ||
    new Set(panes.map((pane) => pane?.pane)).size !== panes.length
  )
    return null;
  return Object.freeze({
    type: "layout",
    semanticWindowId: windowId,
    windowName: null,
    currentWindow: true,
    cols: parsed.width,
    rows: parsed.height,
    zoomed: zoomed === "1",
    paneBorderStatus,
    panes: Object.freeze(panes),
  });
}

function latestFocusFramebufferTrace(state, expected, diagnosticEpoch) {
  return readJsonLines(state.tui.performanceTracePath)
    .filter(
      (record) =>
        record?.semanticPaneId === expected.semanticPaneId &&
        record.processId === expected.processId &&
        record.clockId === expected.clockId &&
        record.generation === expected.canonicalGeneration &&
        record.incarnation === expected.incarnation &&
        record.rendererEpoch === expected.rendererEpoch &&
        record.sourceEpoch === expected.sourceEpoch &&
        (diagnosticEpoch === 0 || record.diagnosticEpoch === diagnosticEpoch) &&
        /^performance\.terminal-focus-(?:paint|fence)$/u.test(record.type ?? ""),
    )
    .slice(-2)
    .map((record) => ({
      type: record.type,
      diagnosticEpoch: record.diagnosticEpoch,
      atMicros: record.atMicros,
      rendererEpoch: record.rendererEpoch,
      revision: record.revision,
      stateHash: record.stateHash,
    }));
}

function focusFramebufferCaptureFailureReason(error) {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("host identity mismatched")) return "capture-host-identity";
  if (message.includes("row count mismatched")) return "capture-row-count";
  if (message.includes("row overflowed")) return "capture-column-overflow";
  if (error?.code === "ABORT_ERR" || error?.killed === true || error?.signal === "SIGTERM")
    return "target-tmux-timeout";
  if (message.includes("geometry was invalid") || message.includes("layout"))
    return "target-tmux-parse";
  if (typeof error?.code === "string") return "target-tmux-server-gone";
  return "capture-error";
}

async function focusPaneSnapshot(
  state,
  expectedPaneId,
  { expectedMarker, expected, diagnosticEpoch = 0, timeoutMs = 2_000 },
) {
  const deadline = performance.now() + timeoutMs;
  const controller = new AbortController();
  const deadlineTimer = setTimeout(() => controller.abort(), timeoutMs);
  const lifecycle = { deadline, signal: controller.signal };
  let previousDigest = null;
  let attempts = 0;
  let lastObservation = null;
  try {
    while (performance.now() < deadline) {
      attempts += 1;
      let geometryBefore;
      try {
        geometryBefore = await focusActiveWindowPaneGeometry(state, lifecycle);
      } catch (error) {
        lastObservation = {
          reason: focusFramebufferCaptureFailureReason(error),
          stage: "native-geometry-before",
          matchCount: 0,
          expectedPaneId,
          expectedSemanticPaneId: expected.semanticPaneId,
          diagnosticEpoch,
          latestTrace: latestFocusFramebufferTrace(state, expected, diagnosticEpoch),
        };
        break;
      }
      const pane = geometryBefore.find(({ paneId }) => paneId === expectedPaneId);
      if (!pane || geometryBefore.length !== 1) {
        lastObservation = { reason: "active-pane-cardinality", matchCount: 0 };
        const retryMs = Math.min(25, Math.max(0, deadline - performance.now()));
        if (retryMs > 0) await new Promise((resolveWait) => setTimeout(resolveWait, retryMs));
        continue;
      }
      let canonicalLayout;
      try {
        canonicalLayout = await canonicalWindowLayout(state, pane.paneId, lifecycle);
      } catch (error) {
        lastObservation = {
          reason: focusFramebufferCaptureFailureReason(error),
          matchCount: 0,
          expectedPaneId,
          expectedSemanticPaneId: expected.semanticPaneId,
          diagnosticEpoch,
          nativeRect: { left: pane.left, top: pane.top, width: pane.width, height: pane.height },
          nativePane: { left: pane.left, top: pane.top, width: pane.width, height: pane.height },
          latestTrace: latestFocusFramebufferTrace(state, expected, diagnosticEpoch),
        };
        const retryMs = Math.min(25, Math.max(0, deadline - performance.now()));
        if (retryMs > 0) await new Promise((resolveWait) => setTimeout(resolveWait, retryMs));
        continue;
      }
      const projectedRect = projectFocusFramebufferRect({
        hostCols: expected.hostCols,
        hostRows: expected.hostRows,
        canonicalLayout,
        canonicalPaneId: pane.semanticPaneId,
      });
      let capture;
      try {
        const remainingMs = Math.max(1, Math.floor(deadline - performance.now()));
        const envelope = JSON.parse(
          await tuiCommandAsync(state, ["capture", "--ansi", "--json"], {
            timeout: Math.min(1_750, remainingMs),
            signal: controller.signal,
          }),
        );
        if (
          envelope?.hostIdentity?.paneId !== expected.hostPaneId ||
          envelope?.hostIdentity?.sessionId !== expected.hostSessionId ||
          envelope?.hostIdentity?.processId !==
            Number(expected.processId.slice("opentui:".length)) ||
          envelope?.hostIdentity?.cols !== expected.hostCols ||
          envelope?.hostIdentity?.rows !== expected.hostRows
        )
          throw new Error("focus capture host identity mismatched");
        capture = decodeFocusFramebufferCapture(envelope);
      } catch (error) {
        lastObservation = {
          reason: focusFramebufferCaptureFailureReason(error),
          matchCount: 0,
          expectedPaneId,
          expectedSemanticPaneId: expected.semanticPaneId,
          diagnosticEpoch,
          nativeRect: { left: pane.left, top: pane.top, width: pane.width, height: pane.height },
          nativePane: { left: pane.left, top: pane.top, width: pane.width, height: pane.height },
          latestTrace: latestFocusFramebufferTrace(state, expected, diagnosticEpoch),
        };
        const retryMs = Math.min(25, Math.max(0, deadline - performance.now()));
        if (retryMs > 0) await new Promise((resolveWait) => setTimeout(resolveWait, retryMs));
        continue;
      }
      let cursorRow;
      let geometryAfter;
      try {
        cursorRow = Number(
          (
            await focusTargetTmux(
              state,
              ["display-message", "-p", "-t", pane.paneId, "#{cursor_y}"],
              lifecycle,
            )
          ).trim(),
        );
        if (!Number.isSafeInteger(cursorRow) || cursorRow < 0)
          throw new Error("focus target cursor geometry was invalid");
        geometryAfter = await focusActiveWindowPaneGeometry(state, lifecycle);
      } catch (error) {
        lastObservation = {
          reason: focusFramebufferCaptureFailureReason(error),
          stage: "native-geometry-after",
          matchCount: 0,
          expectedPaneId,
          expectedSemanticPaneId: expected.semanticPaneId,
          diagnosticEpoch,
          latestTrace: latestFocusFramebufferTrace(state, expected, diagnosticEpoch),
        };
        break;
      }
      const inspected = inspectFocusFramebufferCapture({
        ansiFrame: capture.ansi,
        semanticPaneId: pane.semanticPaneId,
        expectedMarker,
        projectedRect,
        cursorRow,
      });
      const attempt = assessFocusFramebufferAttempt({
        inspected,
        geometryBeforeDigest: paneGeometryIdentity(geometryBefore),
        geometryAfterDigest: paneGeometryIdentity(geometryAfter),
        pane,
        canonicalLayout,
        expected,
      });
      const frameHash = createHash("sha256").update(capture.ansi).digest("hex");
      const canonicalLayoutDigest = createHash("sha256")
        .update(JSON.stringify(canonicalLayout))
        .digest("hex");
      const projectedDigest = createHash("sha256")
        .update(JSON.stringify(projectedRect))
        .digest("hex");
      const nativeDigest = createHash("sha256")
        .update(paneGeometryIdentity(geometryAfter))
        .digest("hex");
      const latestTrace = latestFocusFramebufferTrace(state, expected, diagnosticEpoch);
      lastObservation = {
        reason: attempt.valid ? "framebuffer-unstable" : attempt.reason,
        ...inspected.observation,
        frameHash,
        projectedRect,
        canonicalPane: projectedRect,
        projectedDigest,
        canonicalLayout: canonicalLayout
          ? {
              cols: canonicalLayout.cols,
              rows: canonicalLayout.rows,
              paneBorderStatus: canonicalLayout.paneBorderStatus,
              paneCount: canonicalLayout.panes.length,
            }
          : null,
        canonicalLayoutDigest,
        nativeRect: { left: pane.left, top: pane.top, width: pane.width, height: pane.height },
        nativePane: { left: pane.left, top: pane.top, width: pane.width, height: pane.height },
        nativeDigest,
        expectedMarker,
        expectedPaneId,
        expectedSemanticPaneId: expected.semanticPaneId,
        diagnosticEpoch,
        latestTrace,
      };
      const structuralDigest = createHash("sha256")
        .update(
          `${frameHash}:${projectedDigest}:${canonicalLayoutDigest}:${nativeDigest}:${cursorRow}`,
        )
        .digest("hex");
      const stability = advanceFocusFramebufferStability(previousDigest, {
        valid: attempt.valid,
        digest: structuralDigest,
      });
      if (attempt.valid && stability.stable) {
        let nativeBody;
        let geometryFinal;
        try {
          nativeBody = await focusTargetTmux(
            state,
            ["capture-pane", "-p", "-J", "-t", pane.paneId],
            { ...lifecycle, maxBuffer: 4 * 1_024 * 1_024 },
          );
          geometryFinal = await focusActiveWindowPaneGeometry(state, lifecycle);
        } catch (error) {
          lastObservation = {
            ...lastObservation,
            reason: focusFramebufferCaptureFailureReason(error),
            stage: "native-body-capture",
          };
          break;
        }
        const finalPane = geometryFinal.find(({ paneId }) => paneId === expectedPaneId);
        if (
          geometryFinal.length !== 1 ||
          !finalPane ||
          paneGeometryIdentity(geometryFinal) !== paneGeometryIdentity(geometryAfter)
        ) {
          lastObservation = {
            ...lastObservation,
            reason: "geometry-drift",
            stage: "native-body-post-capture",
          };
          previousDigest = null;
          continue;
        }
        const bodyLines = inspected.lines
          .slice(projectedRect.firstBodyRow, projectedRect.firstBodyRow + projectedRect.bodyRows)
          .map((line) => sliceFocusTerminalCells(line, projectedRect.left, projectedRect.width));
        if (bodyLines.some((line) => line === null)) {
          lastObservation = {
            ...lastObservation,
            reason: "capture-cell-boundary",
            stage: "framebuffer-body-slice",
          };
          break;
        }
        const body = bodyLines.join("\n");
        const lines = body.split("\n");
        return Object.freeze({
          cursorRow,
          nativeBodyHash: createHash("sha256").update(nativeBody).digest("hex"),
          renderedBodyHash: createHash("sha256").update(body).digest("hex"),
          renderedBodyWithoutCursorHash: createHash("sha256")
            .update(lines.filter((_line, index) => index !== cursorRow).join("\n"))
            .digest("hex"),
          cursorTextRowHash: createHash("sha256")
            .update(lines[cursorRow] ?? "")
            .digest("hex"),
          cursorPresentationRowHash: createHash("sha256")
            .update(
              selectFocusCursorPresentationRow(
                capture.ansi,
                { ...projectedRect, valid: true },
                cursorRow,
              ),
            )
            .digest("hex"),
          geometryHash: nativeDigest,
          canonicalGeometryHash: canonicalLayoutDigest,
          projectedRect,
          canonicalPane: projectedRect,
          nativePane: { left: pane.left, top: pane.top, width: pane.width, height: pane.height },
          captureAttempts: attempts,
        });
      }
      previousDigest = stability.nextDigest;
      const retryMs = Math.min(25, Math.max(0, deadline - performance.now()));
      if (retryMs > 0) await new Promise((resolveWait) => setTimeout(resolveWait, retryMs));
    }
    const error = new Error("focus framebuffer capture did not stabilize");
    error.boundary = "focus-framebuffer-capture";
    error.observation = Object.freeze({
      operation: "wait-for-focus-framebuffer-capture",
      attempts,
      ...(lastObservation ?? { reason: "capture-error", matchCount: 0 }),
    });
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
    controller.abort();
  }
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
  const deadline = performance.now() + timeoutMs;
  let previousHeartbeatWallMs = Date.now();
  let state;
  for (;;) {
    state = readJson(statePath);
    const wallNowMs = Date.now();
    const heartbeat = productRigHostHeartbeatObservation({
      previousHeartbeatWallMs,
      wallNowMs,
    });
    previousHeartbeatWallMs = wallNowMs;
    if (heartbeat.suspended) {
      const suspended = new Error("ProductRig host was suspended during orchestration");
      suspended.boundary = state?.currentJourneyBoundary ?? "host-suspended";
      suspended.observation = Object.freeze({
        operation: "product-rig-host-suspension",
        reason: "host-suspended",
        stage: state?.currentJourneyBoundary ?? "unknown",
        switchOrdinalWatermark: Number.isSafeInteger(state?.windowSwitchOrdinalWatermark)
          ? Math.min(state.windowSwitchOrdinalWatermark, 32)
          : null,
        heartbeatElapsedMs: heartbeat.elapsedMs,
        heartbeatExpectedIntervalMs: heartbeat.expectedIntervalMs,
        heartbeatGapMs: heartbeat.gapMs,
      });
      throw suspended;
    }
    if (!allowTerminalFailure && ["failed", "cleanup-failed"].includes(state?.status)) {
      throw productRigTerminalFailureError(state);
    }
    if (predicate(state)) return state;
    if (performance.now() >= deadline) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  const timeout = new Error(`timed out waiting for product rig (${state?.status ?? "no state"})`);
  if (typeof state?.currentJourneyBoundary === "string") {
    timeout.boundary = state.currentJourneyBoundary;
    timeout.observation = Object.freeze({
      operation: "product-rig-owner-readiness",
      reason: "owner-timeout",
      stage: state.currentJourneyBoundary,
      switchOrdinalWatermark: Number.isSafeInteger(state?.windowSwitchOrdinalWatermark)
        ? Math.min(state.windowSwitchOrdinalWatermark, 32)
        : null,
      elapsedMs: timeoutMs,
    });
  }
  throw timeout;
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

async function dispatchOwnedProductAction(daemon, action, operationId, input, hostClientId) {
  const response = await fetch(`${daemon.baseUrl}/api/v2/action/${action}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${daemon.record.authToken}`,
      "Content-Type": "application/json",
      "X-Tmux-Ide-Operation-Id": operationId,
      ...(typeof hostClientId === "string" && hostClientId.length <= 256
        ? { "X-Tmux-Ide-Host-Client-Id": hostClientId }
        : {}),
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(5_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok !== true || !payload.result) {
    const error = new Error(`owned ${action} action failed (${response.status})`);
    error.observation = ownedWindowActionFailureObservation({
      action,
      operationId,
      status: response.status,
      payload,
    });
    throw error;
  }
  if (
    payload.result.operationId !== operationId ||
    payload.result.daemonInstanceId !== daemon.record.instanceId
  ) {
    const error = new Error(`owned ${action} action returned a mismatched operation identity`);
    error.observation = ownedWindowActionFailureObservation({
      action,
      operationId,
      status: response.status,
      payload: { ok: false, result: payload.result, error: { code: "result_invalid" } },
    });
    throw error;
  }
  return Object.freeze(payload.result);
}

function invalidOwnedProductActionResult(action, operationId, result) {
  const error = new Error(`owned ${action} action returned an invalid result`);
  error.observation = ownedWindowActionFailureObservation({
    action,
    operationId,
    status: 200,
    payload: { ok: false, result, error: { code: "result_invalid" } },
  });
  return error;
}

async function productApplicationShell(daemon, session) {
  const response = await fetch(
    `${daemon.baseUrl}/api/project/${encodeURIComponent(session)}/application-shell?version=3`,
    {
      headers: { Authorization: `Bearer ${daemon.record.authToken}` },
      signal: AbortSignal.timeout(3_000),
    },
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.resource)
    throw new Error("application-shell inventory was unavailable");
  return payload.resource;
}

function productApplicationShellWaitObservation(latest, expectedCount, attempts, startedAt) {
  const resources = productWindowResources(latest);
  const revisionCandidates = [
    latest?.revision,
    latest?.terminalInventory?.revision,
    latest?.terminalInventory?.resourceRevision,
  ];
  return windowApplicationShellTimeoutObservation({
    resources,
    expectedCount,
    attempts,
    elapsedMs: performance.now() - startedAt,
    revision: revisionCandidates.find((value) => Number.isSafeInteger(value)) ?? null,
  });
}

async function waitForProductApplicationShell(
  daemon,
  session,
  qualify,
  timeoutMs = 10_000,
  expectedCount = null,
) {
  const startedAt = performance.now();
  const deadline = performance.now() + timeoutMs;
  let latest = null;
  let attempts = 0;
  while (performance.now() < deadline) {
    latest = await productApplicationShell(daemon, session);
    attempts += 1;
    if (qualify(latest)) return latest;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  const error = new Error("application-shell lifecycle state did not settle");
  error.observation = productApplicationShellWaitObservation(
    latest,
    Number.isSafeInteger(expectedCount) ? expectedCount : null,
    attempts,
    startedAt,
  );
  throw error;
}

function productWindowResources(shell) {
  const inventory = shell?.terminalInventory;
  const activeResourceId = inventory?.activeResourceId ?? null;
  if (!Array.isArray(inventory?.resources)) return [];
  return inventory.resources.flatMap((resource) => {
    const resourceId = resource?.resourceId ?? resource?.id;
    const semanticPaneId =
      resource?.semanticPaneId ?? resource?.attachability?.semanticPaneId ?? null;
    const windowResourceId = resource?.windowResourceId ?? resourceId;
    const resourceTitle = resource?.displayTitle ?? resource?.title ?? resource?.name;
    if (
      typeof resourceId !== "string" ||
      typeof windowResourceId !== "string" ||
      typeof semanticPaneId !== "string" ||
      typeof resourceTitle !== "string"
    )
      return [];
    return [
      Object.freeze({
        resourceId,
        windowResourceId,
        semanticPaneId,
        resourceTitle,
        active: resourceId === activeResourceId,
      }),
    ];
  });
}

function productWindowResourcesExactlyMatch(resources, expected) {
  if (!Array.isArray(resources) || !Array.isArray(expected) || resources.length !== expected.length)
    return false;
  const tuples = (values) =>
    values
      .map((resource) => [
        resource.resourceId,
        resource.windowResourceId ?? resource.resourceId,
        resource.semanticPaneId,
        resource.resourceTitle,
        resource.active === true,
      ])
      .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(tuples(resources)) === JSON.stringify(tuples(expected));
}

async function settleWindowReferenceTrace(referenceTracePath, beforeCount, deadline) {
  let previousDigest = null;
  let stableSamples = 0;
  let quietStartedAt = performance.now();
  while (performance.now() < deadline) {
    const tail = readJsonLines(referenceTracePath).slice(beforeCount);
    if (tail.length > 4_096) throw new Error("window presentation trace exceeded its bound");
    const digest = createHash("sha256").update(JSON.stringify(tail)).digest("hex");
    if (digest === previousDigest) stableSamples += 1;
    else {
      stableSamples = 1;
      quietStartedAt = performance.now();
    }
    previousDigest = digest;
    const quietDurationMs = Math.floor(performance.now() - quietStartedAt);
    if (stableSamples >= 2 && quietDurationMs >= 300)
      return Object.freeze({ tail, digest, stableSamples, quietDurationMs, quiet: true });
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("window presentation trace did not reach a quiet watermark");
}

function windowRenderWork(tail, digest, stableSamples, quietDurationMs, expected) {
  const frames = tail.filter((record) => record?.type === "performance.frame");
  return Object.freeze({
    terminalPaintCount: tail.filter((record) => record?.type === "performance.terminal-paint")
      .length,
    canonicalPublicationCount: tail.filter(
      (record) => record?.type === "performance.terminal-canonical-publication",
    ).length,
    canonicalPaintCount: tail.filter(
      (record) => record?.type === "performance.terminal-canonical-paint",
    ).length,
    canonicalUpdateCount: tail.filter(
      (record) => record?.type === "performance.terminal-canonical-update",
    ).length,
    frameCount: tail.filter((record) => record?.type === "performance.frame").length,
    presentation: assessWindowPresentationFrames(frames, expected),
    eventCount: tail.length,
    traceDigest: digest,
    stableSamples,
    quietDurationMs,
    quiet: true,
  });
}

function exactWindowSwitchDaemonTiming(records, started) {
  const fail = (firstFailedPredicate) => {
    const error = new Error("window switch daemon phase timing did not qualify");
    error.observation = Object.freeze({
      operation: "window-switch-daemon-phase-timing",
      firstFailedPredicate,
    });
    throw error;
  };
  if (!Array.isArray(records) || records.length > 4_096) fail("record-cardinality");
  const operations = [
    "semantic-pane-inventory-lookup",
    "semantic-pane-resolution",
    "tmux-selection-effect-proof",
    "semantic-mutation-effect",
  ];
  const exact = records.filter(
    (record) =>
      record?.type === "performance.stage" &&
      record.traceId === started.traceId &&
      record.scenario === "window-switch",
  );
  if (exact.length !== operations.length) fail("phase-cardinality");
  const values = {};
  const spans = [];
  let clockIdentity = null;
  for (const operation of operations) {
    const matches = exact.filter((record) => record.operation === operation);
    if (matches.length !== 1) fail("phase-operation");
    const span = matches[0];
    if (
      span.authority?.generation !== started.daemonGeneration ||
      span.authority?.incarnation !== null ||
      span.stage !== "tmux" ||
      typeof span.processId !== "string" ||
      span.processId.length < 1 ||
      span.processId.length > 256 ||
      typeof span.clockId !== "string" ||
      span.clockId.length < 1 ||
      span.clockId.length > 128 ||
      span.clockKind !== "performance-now" ||
      !Number.isSafeInteger(span.startedAtMicros) ||
      !Number.isSafeInteger(span.endedAtMicros) ||
      span.startedAtMicros < 0 ||
      span.endedAtMicros < span.startedAtMicros
    )
      fail(
        span.authority?.generation !== started.daemonGeneration ||
          span.authority?.incarnation !== null ||
          span.stage !== "tmux"
          ? "phase-identity"
          : "phase-monotonic",
      );
    const currentClockIdentity = `${span.processId}\0${span.clockId}\0${span.clockKind}`;
    if (clockIdentity !== null && currentClockIdentity !== clockIdentity) fail("phase-clock");
    clockIdentity = currentClockIdentity;
    spans.push(span);
    values[`${operation.replaceAll("-", "_")}Ms`] =
      (span.endedAtMicros - span.startedAtMicros) / 1_000;
  }
  const [inventory, resolution, selection, total] = spans;
  if (
    total.startedAtMicros > inventory.startedAtMicros ||
    inventory.endedAtMicros > resolution.startedAtMicros ||
    resolution.endedAtMicros > selection.startedAtMicros ||
    selection.endedAtMicros > total.endedAtMicros
  )
    fail("phase-order");
  return Object.freeze(values);
}

async function driveExactHostedWindowSwitch(
  state,
  tracePath,
  seen,
  { timeoutMs = 5_000, signal, boundary, ordinal = null },
) {
  const before = readJsonLines(tracePath);
  const beforeCount = before.length;
  const referenceTracePath = state.tui.performanceTracePath;
  const referenceBefore = readJsonLines(referenceTracePath);
  const daemonTracePath = state.tui.daemonPerformanceTracePath;
  if (typeof daemonTracePath !== "string")
    throw new Error("window switch daemon phase trace was unavailable");
  const daemonBeforeCount = readJsonLines(daemonTracePath).length;
  let delivery;
  try {
    delivery = JSON.parse(
      await tuiCommandAsync(
        state,
        ["input", JSON.stringify({ version: 1, kind: "control-key", key: "t" })],
        { timeout: Math.min(timeoutMs, 2_000), signal },
      ),
    );
  } catch (cause) {
    const error = new Error("window switch hosted input command failed", { cause });
    error.boundary = boundary;
    error.observation = windowSwitchInputFailureObservation({
      boundary,
      ordinal,
      reason: signal?.aborted ? "aborted" : (cause?.productRigReason ?? "command-failed"),
      timeoutMs: Math.min(timeoutMs, 2_000),
    });
    throw error;
  }
  if (
    delivery?.kind !== "control-key" ||
    delivery?.requestedKey !== "t" ||
    delivery?.delivery !== "exact-bytes-to-immutable-host-pane-pty" ||
    delivery?.bytesInjected !== 1 ||
    delivery?.phases !== 1
  )
    throw new Error("window switch hosted control-key receipt was invalid");
  const deadline = performance.now() + timeoutMs;
  let started = null;
  let settled = null;
  let fence = null;
  while (performance.now() < deadline && (!started || !settled)) {
    const appended = readJsonLines(tracePath).slice(beforeCount);
    const starts = appended.filter(
      (record) => record?.phase === "window-switch-start" && !seen.has(record.traceId),
    );
    if (starts.length > 1) throw new Error("hosted control-key produced duplicate switch starts");
    started = starts[0] ?? null;
    const receipts = started
      ? appended.filter(
          (record) =>
            record?.phase === "window-switch-receipt" && record.traceId === started.traceId,
        )
      : [];
    if (receipts.length > 1)
      throw new Error("hosted control-key produced duplicate switch selection receipts");
    const failures = started
      ? appended.filter(
          (record) =>
            record?.phase === "window-switch-failed" && record.traceId === started.traceId,
        )
      : [];
    if (failures.length > 1)
      throw new Error("hosted control-key produced duplicate terminal switch failures");
    const rejectedReceipt = receipts.find(
      (record) => record?.selected !== true || record?.applied !== true,
    );
    if (failures.length === 1 || rejectedReceipt) {
      const failure = failures[0] ?? {
        stage: rejectedReceipt?.failureStage,
        reason: rejectedReceipt?.failureReason,
        backendReason: rejectedReceipt?.failureBackendReason,
      };
      const error = new Error("window switch selection receipt failed");
      error.observation = windowSwitchSelectionFailureObservation(
        failure,
        starts.length,
        receipts.length,
        failures.length,
      );
      throw error;
    }
    const settledMatches = started
      ? appended.filter(
          (record) =>
            record?.phase === "window-switch-settled" && record.traceId === started.traceId,
        )
      : [];
    if (settledMatches.length > 1)
      throw new Error("hosted control-key produced duplicate switch settlements");
    settled = settledMatches[0] ?? null;
    if (!started || !settled) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  if (!started || !settled) throw new Error("window switch actual-frame fence did not settle");
  const appended = readJsonLines(tracePath).slice(beforeCount);
  if (
    settled.traceId !== started.traceId ||
    settled.target !== started.target ||
    settled.paneId !== started.paneId ||
    settled.startedAtMicros !== started.startedAtMicros
  )
    throw new Error("window switch lifecycle identity did not join exactly");
  while (performance.now() < deadline && !fence) {
    const fenceMatches = readJsonLines(tracePath)
      .slice(beforeCount)
      .filter(
        (record) => record?.phase === "window-switch-fence" && record.traceId === settled.traceId,
      );
    if (fenceMatches.length > 1)
      throw new Error("hosted control-key produced duplicate switch fences");
    fence = fenceMatches[0] ?? null;
    if (!fence) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  if (!fence) throw new Error("window switch critical persistence fence did not settle");
  const fenceIdentityKeys = [
    "traceId",
    "target",
    "paneId",
    "startedAtMicros",
    "daemonGeneration",
    "clientGeneration",
    "rendererEpoch",
    "sourceEpoch",
    "generation",
    "incarnation",
    "revision",
    "stateHash",
    "cols",
    "rows",
    "processId",
    "clockId",
  ];
  if (
    fence.phase !== "window-switch-fence" ||
    fenceIdentityKeys.some((key) => fence[key] !== started[key])
  )
    throw new Error("window switch persistence fence identity did not join exactly");
  if (
    fence.writerHealth?.droppedRecords !== 0 ||
    fence.writerHealth?.failed !== false ||
    fence.writerHealth?.pendingCriticalRecords !== 0
  ) {
    const error = new Error("window switch lifecycle writer fence was unhealthy");
    error.observation = windowLifecycleWriterFailureObservation({
      stage: "switch",
      health: fence.writerHealth,
      records: readJsonLines(tracePath),
    });
    throw error;
  }
  const quiet = await settleWindowReferenceTrace(
    referenceTracePath,
    referenceBefore.length,
    deadline,
  );
  const renderWork = windowRenderWork(
    quiet.tail,
    quiet.digest,
    quiet.stableSamples,
    quiet.quietDurationMs,
    { kind: "window-switch", ...started },
  );
  const phaseAssessment = assessWindowSwitchPhaseTimingRecords({
    records: appended,
    started,
    settled,
  });
  if (!phaseAssessment.qualified) {
    const error = new Error("window switch phase timing did not qualify");
    error.observation = Object.freeze({
      operation: "window-switch-phase-timing",
      firstFailedPredicate: phaseAssessment.firstFailedPredicate,
    });
    throw error;
  }
  const phaseTiming = phaseAssessment.timing;
  const daemonTiming = exactWindowSwitchDaemonTiming(
    readJsonLines(daemonTracePath).slice(daemonBeforeCount),
    started,
  );
  seen.add(settled.traceId);
  return Object.freeze({
    delivery,
    started,
    settled,
    fence,
    renderWork,
    phaseTiming: Object.freeze({ ...phaseTiming, daemon: daemonTiming }),
  });
}

async function waitForWindowRenameFence(
  state,
  { lifecycleBefore, referenceBefore, expected, timeoutMs = 5_000 },
) {
  const lifecyclePath = join(state.tui.runtimeDir, "performance.jsonl");
  const deadline = performance.now() + timeoutMs;
  let started = null;
  let presented = null;
  let fence = null;
  while (performance.now() < deadline && (!started || !presented || !fence)) {
    const appended = readJsonLines(lifecyclePath).slice(lifecycleBefore);
    const starts = appended.filter(
      (record) =>
        record?.phase === "window-rename-start" &&
        record.target === expected.windowResourceId &&
        record.paneId === expected.semanticPaneId &&
        record.previousName === expected.previousName &&
        record.windowName === expected.windowName,
    );
    if (starts.length > 1) throw new Error("window rename published duplicate starts");
    started = starts[0] ?? null;
    presented = started
      ? (appended.find(
          (record) =>
            record?.phase === "window-rename-presented" && record.traceId === started.traceId,
        ) ?? null)
      : null;
    fence = started
      ? (appended.find(
          (record) => record?.phase === "window-rename-fence" && record.traceId === started.traceId,
        ) ?? null)
      : null;
    if (!started || !presented || !fence)
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  if (!started || !presented || !fence)
    throw new Error("window rename actual-frame fence did not settle");
  const identityKeys = [
    "target",
    "paneId",
    "windowName",
    "daemonGeneration",
    "clientGeneration",
    "rendererEpoch",
    "sourceEpoch",
    "generation",
    "incarnation",
    "revision",
    "stateHash",
    "cols",
    "rows",
  ];
  if (identityKeys.some((key) => presented[key] !== started[key] || fence[key] !== started[key]))
    throw new Error("window rename presentation identity or writer fence was invalid");
  if (
    fence.writerHealth?.droppedRecords !== 0 ||
    fence.writerHealth?.failed !== false ||
    fence.writerHealth?.pendingCriticalRecords !== 0
  ) {
    const error = new Error("window rename lifecycle writer fence was unhealthy");
    error.observation = windowLifecycleWriterFailureObservation({
      stage: "rename",
      health: fence.writerHealth,
      records: readJsonLines(lifecyclePath),
    });
    throw error;
  }
  const quiet = await settleWindowReferenceTrace(
    state.tui.performanceTracePath,
    referenceBefore,
    deadline,
  );
  return Object.freeze({
    traceId: started.traceId,
    started,
    presented,
    fence,
    renderWork: windowRenderWork(
      quiet.tail,
      quiet.digest,
      quiet.stableSamples,
      quiet.quietDurationMs,
      { kind: "window-rename", ...started },
    ),
  });
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
      TMUX_IDE_PRODUCT_TIMELINE_ORIGIN_MS: String(attemptTimelineOriginMs),
      ...(diagnosticFrozenProvenance
        ? {
            TMUX_IDE_PRODUCT_EXPECTED_SOURCE_COMMIT: diagnosticFrozenProvenance.commit,
            TMUX_IDE_PRODUCT_EXPECTED_SOURCE_TREE: diagnosticFrozenProvenance.tree,
            TMUX_IDE_PRODUCT_EXPECTED_SOURCE_MANIFEST: diagnosticFrozenProvenance.manifestDigest,
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

async function waitForTuiLifecycleEntry(
  state,
  predicate,
  timeoutMs,
  timeoutMessage,
  { signal, processId } = {},
) {
  const lifecyclePath = join(state.tui.runtimeDir, "performance.jsonl");
  const findEntry = () => readJsonLines(lifecyclePath).findLast(predicate) ?? null;
  if (signal || processId) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      if (signal?.aborted) {
        const error = new Error("TUI lifecycle wait aborted");
        error.code = "ABORT_ERR";
        throw error;
      }
      if (processId && !processAlive(processId)) {
        const error = new Error("TUI process exited during lifecycle wait");
        error.code = "PROCESS_DEAD";
        throw error;
      }
      const entry = findEntry();
      if (entry) return entry;
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    throw new Error(timeoutMessage);
  }
  return await waitForLifecycleEntry({
    findEntry,
    subscribe: (check) => watch(lifecyclePath, { persistent: false }, check),
    timeoutMs,
    timeoutMessage,
  });
}

async function waitForFocusQualification(
  state,
  expected,
  snapshots,
  inputs,
  timeoutMs = 5_000,
  stage = "complete",
) {
  const deadline = performance.now() + timeoutMs;
  let assessment = null;
  while (performance.now() < deadline) {
    assessment = qualifyProductFocusEvidence({
      lifecycleRecords: readJsonLines(join(state.tui.runtimeDir, "performance.jsonl")),
      traceRecords: readJsonLines(state.tui.performanceTracePath),
      expected,
      snapshots,
      inputs,
      stage,
    });
    if (assessment.qualified) return assessment;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  const error = new Error("focus journey exact blur/reclaim proof did not settle");
  error.boundary =
    stage === "blur" || assessment?.firstFailedPredicate?.startsWith("blur")
      ? "focus-blur-proved"
      : "focus-reclaim-proved";
  error.observation = Object.freeze({
    operation: "wait-for-focus-proof",
    firstFailedPredicate: assessment?.firstFailedPredicate ?? "missing",
    predicates: assessment?.predicates ?? [],
  });
  throw error;
}

async function waitForFocusWorkspaceEvidence(state, expected, timeoutMs = 5_000) {
  const deadline = performance.now() + timeoutMs;
  let lastError = null;
  while (performance.now() < deadline) {
    try {
      return qualifyFocusWorkspaceState(
        readJsonLines(join(state.tui.runtimeDir, "performance.jsonl")),
        expected,
      );
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw lastError ?? new Error("focus WorkspaceClient evidence did not settle");
}

async function waitForWindowWorkspaceEvidence(state, expected, timeoutMs = 5_000) {
  const deadline = performance.now() + timeoutMs;
  let lastError = null;
  while (performance.now() < deadline) {
    try {
      return qualifyWindowWorkspaceState(
        readJsonLines(join(state.tui.runtimeDir, "performance.jsonl")),
        expected,
      );
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw lastError ?? new Error("window WorkspaceClient evidence did not settle");
}

async function readExactResizeTmuxPanes(state, timeoutMs = 2_000) {
  const deadline = performance.now() + timeoutMs;
  const stdout = await runBoundedFocusTmux({
    socketPath: state.runtimeNamespace.tmuxSocketPath,
    args: [
      "list-panes",
      "-t",
      `=${state.session}:`,
      "-F",
      "#{pane_id}|#{@tmux_ide_pane_id}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}|#{pane_active}",
    ],
    deadline,
  });
  const rows = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [paneId, semanticPaneId, left, top, cols, rows, active] = line.split("|");
      return Object.freeze({
        paneId,
        semanticPaneId,
        left: Number(left),
        top: Number(top),
        cols: Number(cols),
        rows: Number(rows),
        active: active === "1",
      });
    });
  if (
    rows.length !== 2 ||
    rows.some(
      (row) =>
        !/^%\d+$/u.test(row.paneId) ||
        typeof row.semanticPaneId !== "string" ||
        row.semanticPaneId.length < 1 ||
        row.semanticPaneId.length > 256 ||
        ![row.left, row.top, row.cols, row.rows].every(Number.isSafeInteger) ||
        row.cols < 1 ||
        row.rows < 1,
    ) ||
    new Set(rows.map(({ paneId }) => paneId)).size !== 2 ||
    new Set(rows.map(({ semanticPaneId }) => semanticPaneId)).size !== 2 ||
    rows.filter(({ active }) => active).length !== 1
  )
    throw new Error("resize tmux inventory was not exactly two stamped panes");
  return Object.freeze(rows);
}

function exactResizeBlockerCommand(marker = "") {
  const script =
    "if(process.argv[1])process.stdout.write(process.argv[1]+'\\n');setInterval(()=>{},2147483647)";
  const quote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;
  return `exec ${[process.execPath, "-e", script, marker].map(quote).join(" ")}`;
}

async function conditionExactResizeTmuxFixture(socketPath, session, seed, timeoutMs = 5_000) {
  const deadline = performance.now() + timeoutMs;
  const target = `=${session}:=one`;
  const run = (args) => runBoundedFocusTmux({ socketPath, args, deadline });
  await run(["set-option", "-w", "-t", target, "pane-border-status", "top"]);
  await run(["resize-window", "-t", target, "-x", "132", "-y", "41"]);
  await run(["select-layout", "-t", target, "even-horizontal"]);
  let previousDigest = null;
  while (performance.now() < deadline) {
    const stdout = await run([
      "list-panes",
      "-t",
      target,
      "-F",
      "#{window_visible_layout}\t#{pane-border-status}\t#{pane_id}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}\t#{pane_pid}\t#{pane_current_command}",
    ]);
    const rows = stdout
      .trimEnd()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t"));
    const visibleLayout = rows[0]?.[0] ?? "";
    const panes = rows.map((row) => ({
      visibleLayout: row[0],
      paneBorderStatus: row[1],
      paneId: row[2],
      semanticPaneId: "",
      left: Number(row[3]),
      top: Number(row[4]),
      width: Number(row[5]),
      height: Number(row[6]),
      processId: Number(row[7]),
      currentCommand: row[8],
    }));
    let targetMarkerCount = 0;
    let otherMarkerCount = 0;
    for (const pane of panes) {
      const body = await run(["capture-pane", "-p", "-J", "-t", pane.paneId]);
      const count = body.split(seed.marker).length - 1;
      if (pane.paneId === seed.paneId) targetMarkerCount += count;
      else otherMarkerCount += count;
    }
    const assessment = assessExactResizeTmuxBaseline({
      visibleLayout,
      layout: parseLayout(visibleLayout),
      panes,
      expectedCommand: basename(process.execPath),
      requireSemanticPaneIds: false,
      seedPaneId: seed.paneId,
      targetMarkerCount,
      otherMarkerCount,
    });
    const digest = createHash("sha256")
      .update(JSON.stringify({ visibleLayout, panes, targetMarkerCount, otherMarkerCount }))
      .digest("hex");
    if (assessment.exact && digest === previousDigest) return;
    previousDigest = assessment.exact ? digest : null;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("resize tmux fixture did not quiesce before daemon startup");
}

async function validateExactResizeTmuxBaseline(state, session, seed, timeoutMs = 5_000) {
  const deadline = performance.now() + timeoutMs;
  const target = `=${session}:=one`;
  const commandLog = [];
  const run = (args) => {
    commandLog.push(Object.freeze([...args]));
    return runBoundedFocusTmux({
      socketPath: state.runtimeNamespace.tmuxSocketPath,
      args,
      deadline,
    });
  };
  const sample = async () => {
    const stdout = await run([
      "list-panes",
      "-t",
      target,
      "-F",
      "#{window_visible_layout}\t#{pane-border-status}\t#{pane_id}\t#{@tmux_ide_pane_id}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}\t#{pane_pid}\t#{pane_current_command}",
    ]);
    const rows = stdout
      .trimEnd()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t"));
    const visibleLayout = rows[0]?.[0] ?? "";
    const parsed = parseLayout(visibleLayout);
    const panes = rows.map((row) => ({
      visibleLayout: row[0],
      paneBorderStatus: row[1],
      paneId: row[2],
      semanticPaneId: row[3],
      left: Number(row[4]),
      top: Number(row[5]),
      width: Number(row[6]),
      height: Number(row[7]),
      processId: Number(row[8]),
      currentCommand: row[9],
    }));
    let targetMarkerCount = 0;
    let otherMarkerCount = 0;
    for (const pane of panes) {
      const body = await run(["capture-pane", "-p", "-J", "-t", pane.paneId]);
      const count = body.split(seed.marker).length - 1;
      if (pane.paneId === seed.paneId) targetMarkerCount += count;
      else otherMarkerCount += count;
    }
    const assessment = assessExactResizeTmuxBaseline({
      visibleLayout,
      layout: parsed,
      panes,
      expectedCommand: basename(process.execPath),
      seedPaneId: seed.paneId,
      targetMarkerCount,
      otherMarkerCount,
    });
    return Object.freeze({
      exact: assessment.exact,
      digest: createHash("sha256")
        .update(
          JSON.stringify({
            visibleLayout,
            panes,
            targetMarkerCount,
            otherMarkerCount,
          }),
        )
        .digest("hex"),
      panes: Object.freeze(panes),
    });
  };
  let previous = null;
  let attempts = 0;
  while (performance.now() < deadline) {
    attempts += 1;
    const current = await sample();
    if (
      current.exact &&
      previous?.exact &&
      current.digest === previous.digest &&
      assessResizePostPromotionCommands(commandLog)
    )
      return Object.freeze({ digest: current.digest, attempts, paneCount: current.panes.length });
    previous = current;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  const error = new Error("resize tmux baseline did not settle at exact pre-sized geometry");
  error.boundary = "resize-daemon-ready";
  error.observation = Object.freeze({
    reason: "resize-baseline-geometry-mismatch",
    attempts: Math.min(attempts, 512),
    exact: previous?.exact === true,
    paneCount: Math.min(previous?.panes?.length ?? 0, 513),
  });
  throw error;
}

async function waitForResizeLifecycleRecord(state, predicate, baseline, timeoutMs = 5_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const records = readJsonLines(join(state.tui.runtimeDir, "performance.jsonl"));
    const matches = records.slice(baseline).filter(predicate);
    if (matches.length === 1) return Object.freeze({ record: matches[0], records });
    if (matches.length > 1) throw new Error("resize lifecycle evidence duplicated");
    await new Promise((resolveWait) => setTimeout(resolveWait, 4));
  }
  throw new Error("resize lifecycle evidence did not settle before deadline");
}

function exactResizeFence(records, operationId, semanticPaneId) {
  const phases = [
    "pane-resize-receipt",
    "pane-resize-layout",
    "pane-resize-settled",
    "pane-resize-fence",
  ];
  const selected = Object.fromEntries(
    phases.map((phase) => [
      phase,
      records.filter(
        (record) =>
          record?.phase === phase &&
          record.operationId === operationId &&
          record.semanticPaneId === semanticPaneId,
      ),
    ]),
  );
  if (phases.some((phase) => selected[phase].length !== 1))
    throw new Error("resize operation lifecycle cardinality was not exact");
  const [receipt, layout, settled, fence] = phases.map((phase) => selected[phase][0]);
  if (
    receipt.verb !== "workspace.pane.resize" ||
    !["applied", "unchanged"].includes(receipt.receiptOutcome) ||
    receipt.receiptCells !== layout.layoutCells ||
    settled.layoutCells !== receipt.receiptCells ||
    settled.presentationChanged !== true ||
    !/^[0-9a-f]{64}$/u.test(settled.presentationDigest ?? "") ||
    settled.identityLineageExact !== true ||
    fence.writerHealth?.droppedRecords !== 0 ||
    fence.writerHealth?.failed !== false ||
    fence.writerHealth?.pendingCriticalRecords !== 0
  )
    throw new Error("resize operation lifecycle fence was not exact");
  return Object.freeze({ receipt, layout, settled, fence });
}

function resizeIdentityEvidence(value) {
  return Object.freeze({
    processId: value.processId,
    daemonGeneration: value.daemonGeneration,
    clientGeneration: value.clientGeneration,
    workspaceName: value.workspaceName,
    sessionName: value.sessionName,
    semanticPaneId: value.semanticPaneId,
  });
}

function resizeTmuxGeometryExact(before, after, semanticPaneId, settledCols) {
  if (!Array.isArray(before) || !Array.isArray(after) || before.length !== 2 || after.length !== 2)
    return false;
  const keyedBefore = new Map(before.map((pane) => [pane.semanticPaneId, pane]));
  const keyedAfter = new Map(after.map((pane) => [pane.semanticPaneId, pane]));
  if (keyedBefore.size !== 2 || keyedAfter.size !== 2) return false;
  for (const [paneId, prior] of keyedBefore) {
    const next = keyedAfter.get(paneId);
    if (
      !next ||
      next.paneId !== prior.paneId ||
      next.top !== prior.top ||
      next.rows !== prior.rows ||
      next.active !== prior.active
    )
      return false;
  }
  const priorExtent = Math.max(...before.map(({ left, cols }) => left + cols));
  const nextExtent = Math.max(...after.map(({ left, cols }) => left + cols));
  return keyedAfter.get(semanticPaneId)?.cols === settledCols && nextExtent === priorExtent;
}

async function driveExactResizeInput(state, document, signal) {
  const receipt = JSON.parse(
    await tuiCommandAsync(state, ["input", JSON.stringify(document)], {
      timeout: document.timeoutMs,
      signal,
    }),
  );
  if (
    receipt?.version !== 1 ||
    receipt.kind !== document.kind ||
    receipt.delivery !== "exact-bytes-to-immutable-host-pane-pty" ||
    !/^%\d+$/u.test(receipt.paneId ?? "") ||
    !/^\$\d+$/u.test(receipt.sessionId ?? "") ||
    receipt.target !== receipt.paneId ||
    receipt.geometry?.cols !== 160 ||
    receipt.geometry?.rows !== 44 ||
    !Number.isSafeInteger(receipt.bytesInjected) ||
    receipt.bytesInjected < 1
  )
    throw new Error("resize hosted input receipt was invalid");
  return Object.freeze(receipt);
}

function windowWorkspaceEvidenceWatermark(state, processId, daemonGeneration) {
  const values = readJsonLines(join(state.tui.runtimeDir, "performance.jsonl"))
    .filter(
      (record) =>
        record?.phase === "generation-workspace-client-state" &&
        record.processId === processId &&
        record.daemonGeneration === daemonGeneration &&
        Number.isSafeInteger(record.monotonicMicros),
    )
    .map((record) => record.monotonicMicros);
  const watermark = Math.max(-1, ...values);
  if (!Number.isSafeInteger(watermark) || watermark < 0 || watermark >= Number.MAX_SAFE_INTEGER)
    throw new Error("window WorkspaceClient watermark is unavailable");
  return watermark;
}

function windowResourceAcknowledgementWatermark(state, processId, daemonGeneration) {
  const values = readJsonLines(join(state.tui.runtimeDir, "performance.jsonl"))
    .filter(
      (record) =>
        record?.phase === "generation-workspace-client-state" &&
        record.processId === processId &&
        record.daemonGeneration === daemonGeneration,
    )
    .map(
      (record) => record?.workspaceClient?.committed?.lastResourceChangeAcknowledgement?.sequence,
    )
    .filter((sequence) => Number.isSafeInteger(sequence) && sequence >= 0);
  const watermark = Math.max(-1, ...values);
  if (!Number.isSafeInteger(watermark) || watermark >= Number.MAX_SAFE_INTEGER)
    throw new Error("window resource acknowledgement watermark is unavailable");
  return watermark;
}

function focusWorkspaceEvidenceWatermark(state, expected) {
  const matches = readJsonLines(join(state.tui.runtimeDir, "performance.jsonl")).filter(
    (record) =>
      record?.phase === "generation-workspace-client-state" &&
      record.processId === expected.processId &&
      record.daemonGeneration === expected.daemonGeneration &&
      Number.isSafeInteger(record.monotonicMicros) &&
      record.monotonicMicros >= 0,
  );
  const watermark = Math.max(-1, ...matches.map((record) => record.monotonicMicros));
  if (!Number.isSafeInteger(watermark) || watermark < 0 || watermark >= Number.MAX_SAFE_INTEGER) {
    const error = new Error("focus post-Web WorkspaceClient watermark is unavailable");
    error.boundary = "focus-web-correlation";
    error.observation = Object.freeze({
      operation: "focus-workspace-client-watermark",
      matchingRecords: Math.min(matches.length, 513),
      reason: "watermark-unavailable",
    });
    throw error;
  }
  return watermark;
}

async function waitForFocusPaintFence(state, expected, diagnosticEpoch, timeoutMs = 5_000) {
  const deadline = performance.now() + timeoutMs;
  let observation = null;
  while (performance.now() < deadline) {
    const records = readJsonLines(state.tui.performanceTracePath);
    const exactIdentity = (record) =>
      record.diagnosticEpoch === diagnosticEpoch &&
      record.processId === expected.processId &&
      record.clockId === expected.clockId &&
      record.semanticPaneId === expected.semanticPaneId &&
      record.generation === expected.canonicalGeneration &&
      record.incarnation === expected.incarnation &&
      record.revision === expected.revision &&
      record.stateHash === expected.stateHash &&
      record.sourceEpoch === expected.sourceEpoch &&
      record.rendererEpoch === expected.rendererEpoch;
    const matches = records.filter(
      (record) =>
        record?.type === "performance.terminal-focus-fence" &&
        exactIdentity(record) &&
        record.writerHealth?.failed === false &&
        record.writerHealth?.droppedRecords === 0 &&
        record.writerHealth?.oversizedRecords === 0,
    );
    const latestPaint = records.findLast(
      (record) =>
        record?.type === "performance.terminal-paint" &&
        record.processId === expected.processId &&
        record.clockId === expected.clockId,
    );
    observation = Object.freeze({
      matchingPaints: records.filter(
        (record) => record?.type === "performance.terminal-focus-paint" && exactIdentity(record),
      ).length,
      matchingFences: matches.length,
      totalFocusRecords: records.filter((record) =>
        ["performance.terminal-focus-paint", "performance.terminal-focus-fence"].includes(
          record?.type,
        ),
      ).length,
      latestOrdinaryPaint:
        latestPaint &&
        Number.isSafeInteger(latestPaint.atMicros) &&
        Number.isSafeInteger(latestPaint.dirtyRows)
          ? { atMicros: latestPaint.atMicros, dirtyRows: latestPaint.dirtyRows }
          : null,
    });
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  const error = new Error("focus pane paint fence did not settle exactly once");
  error.boundary = diagnosticEpoch === 1 ? "focus-blur-proved" : "focus-reclaim-proved";
  error.observation = Object.freeze({
    operation: "wait-for-focus-paint-fence",
    diagnosticEpoch,
    semanticPaneId: expected.semanticPaneId,
    ...observation,
  });
  throw error;
}

async function waitForCoherentTui(
  state,
  timeoutMs = 30_000,
  expectedProcessId = null,
  retainedStatus = null,
  signal = undefined,
) {
  try {
    await waitForTuiLifecycleEntry(
      state,
      (entry) =>
        entry?.phase === "first-terminal-frame" &&
        entry?.daemonGeneration === state.daemon.instanceId &&
        (expectedProcessId === null || entry?.processId === `opentui:${expectedProcessId}`),
      timeoutMs,
      "diagnostic TUI did not reach a coherent terminal frame",
      { signal, processId: expectedProcessId },
    );
  } catch (error) {
    error.observation = productCoherentFrameTimeoutObservation({
      lifecycleRecords: readJsonLines(join(state.tui.runtimeDir, "performance.jsonl")),
      traceRecords: readJsonLines(state.tui.performanceTracePath),
      processId: expectedProcessId === null ? null : `opentui:${expectedProcessId}`,
      daemonGeneration: state.daemon.instanceId,
      detailMode: state.tui.performanceTraceDetail,
    });
    throw error;
  }
  return retainedStatus ?? JSON.parse(tuiCommand(state, ["status", "--json"]));
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
      sessionPaneGeometry(state).map(({ paneId }) => [
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
      paneCount: geometryAfter.length,
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
    if (qualifyPreseededPaneEvidence(sample)) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  qualifyPreseededPaneEvidence(sample, { throwOnFailure: true });
  const lifecycle = readJsonLines(join(state.tui.runtimeDir, "performance.jsonl"));
  const hostFrame = lifecycle.findLast(
    ({ phase, daemonGeneration }) =>
      phase === "first-terminal-frame" && daemonGeneration === state.daemon.instanceId,
  );
  if (!hostFrame) {
    const error = new Error("coherent frame causality is missing the target host frame");
    error.boundary = "coherent-terminal-publication";
    error.observation = Object.freeze({
      daemonGeneration: state.daemon.instanceId,
      firstTerminalFrames: 0,
    });
    throw error;
  }
  const fencedTrace = await waitForCanonicalFrameFence(
    () => readJsonLines(state.tui.performanceTracePath),
    {
      processId: hostFrame.processId,
      clockId: hostFrame.clockId,
      daemonGeneration: state.daemon.instanceId,
      rendererEpoch: hostFrame.rendererEpoch,
      semanticPaneId: sample.semanticPaneId,
      sourceEpoch: 1,
      canonicalCols: sample.geometry.width,
      canonicalRows: sample.geometry.height + 1,
      viewportCols: sample.bodyRect.width,
      viewportRows: sample.geometry.height,
    },
  );
  const performanceRecords = fencedTrace.records;
  let canonicalSeedPaint;
  try {
    canonicalSeedPaint = qualifyCanonicalSeedPaint(performanceRecords, {
      semanticPaneId: sample.semanticPaneId,
      generation: state.daemon.instanceId,
      canonicalCols: sample.geometry.width,
      canonicalRows: sample.geometry.height + 1,
      viewportCols: sample.bodyRect.width,
      viewportRows: sample.geometry.height,
      processId: hostFrame.processId,
      clockId: hostFrame.clockId,
      sourceEpoch: 1,
    });
  } catch (error) {
    let preCleanTmux = Object.freeze({
      available: false,
      paneCount: 0,
      targetGeometryExact: false,
      targetCols: null,
      targetRows: null,
    });
    try {
      const stdout = await runBoundedFocusTmux({
        socketPath: state.runtimeNamespace.tmuxSocketPath,
        args: [
          "list-panes",
          "-t",
          sample.paneId,
          "-F",
          "#{pane_id}\t#{@tmux_ide_pane_id}\t#{pane_width}\t#{pane_height}",
        ],
        deadline: performance.now() + 500,
        maxBuffer: 64 * 1_024,
      });
      const rows = stdout
        .trimEnd()
        .split("\n")
        .filter(Boolean)
        .slice(0, 514)
        .map((line) => line.split("\t"));
      const target = rows.find(([paneId]) => paneId === sample.paneId);
      const targetCols = Number(target?.[2]);
      const targetRows = Number(target?.[3]);
      preCleanTmux = Object.freeze({
        available: rows.length <= 513 && Boolean(target),
        paneCount: Math.min(rows.length, 513),
        targetGeometryExact:
          target?.[1] === sample.semanticPaneId &&
          targetCols === sample.geometry.width &&
          targetRows === sample.geometry.height,
        targetCols: Number.isSafeInteger(targetCols) ? targetCols : null,
        targetRows: Number.isSafeInteger(targetRows) ? targetRows : null,
      });
    } catch {
      // Failure evidence is optional, bounded, and must not mask the seed-proof failure.
    }
    const samePane = performanceRecords.filter(
      (record) =>
        record?.semanticPaneId === sample.semanticPaneId &&
        record.generation === state.daemon.instanceId &&
        record.processId === hostFrame.processId &&
        record.clockId === hostFrame.clockId &&
        record.sourceEpoch === 1,
    );
    const summarize = (record) =>
      record
        ? Object.freeze({
            type: record.type,
            updateType: record.updateType ?? null,
            revision: Number.isSafeInteger(record.revision) ? record.revision : null,
            cols: Number.isSafeInteger(record.cols) ? record.cols : null,
            rows: Number.isSafeInteger(record.rows) ? record.rows : null,
            viewportCols: Number.isSafeInteger(record.viewportCols) ? record.viewportCols : null,
            viewportRows: Number.isSafeInteger(record.viewportRows) ? record.viewportRows : null,
            acceptedUpdateType: ["terminal.seed", "terminal.patch"].includes(
              record.acceptedUpdateType,
            )
              ? record.acceptedUpdateType
              : null,
            acceptedRevision: Number.isSafeInteger(record.acceptedRevision)
              ? record.acceptedRevision
              : null,
          })
        : null;
    error.observation = Object.freeze({
      ...(error.observation ?? {}),
      preCleanTmux,
      latestCanonicalPatch: summarize(
        samePane.findLast(({ type }) => type === "performance.terminal-canonical-update"),
      ),
      latestCanonicalFrame: summarize(
        samePane.findLast(({ type }) => type === "performance.terminal-canonical-host-frame"),
      ),
      latestCanonicalFence: summarize(
        samePane.findLast(({ type }) => type === "performance.terminal-frame-fence"),
      ),
    });
    throw error;
  }
  const frameCausality = qualifyCoherentFrameCausality(
    lifecycle,
    canonicalSeedPaint,
    state.daemon.instanceId,
    performanceRecords,
  );
  return Object.freeze({
    ...sample,
    internalPublication: frameCausality.internalPublication,
    hostFrame: frameCausality.hostFrame,
    canonicalSeedPaint,
    frameCausality,
    connectToCoherentMs: frameCausality.connectToCoherentMs,
  });
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
  await tuiCommandAsync(state, ["stop"], { timeout: 5_000 });
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
      manifestDigest: state.tui?.performanceTraceManifestDigest ?? null,
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
  await tuiCommandAsync(state, ["stop"], { timeout: 5_000 });
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
      manifestDigest: state.tui?.performanceTraceManifestDigest ?? null,
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

async function diagnoseCoherentFirstPane(planEntry) {
  diagnosticAttemptPhases.set(planEntry.runId, "product-rig-startup");
  await start(false, true, planEntry);
  const state = await waitForState((candidate) => candidate?.status === "ready");
  diagnosticAttemptPhases.set(planEntry.runId, "evidence-capture");
  const captureEvidence = await captureArtifacts(
    state,
    `diagnose-${planEntry.journey.id}-r${planEntry.repetition}`,
  );
  diagnosticCaptures.set(planEntry.runId, captureEvidence);
  await tuiCommandAsync(state, ["stop"], { timeout: 5_000 });
  const timeline = readJsonLines(timelinePath);
  const correlation = productDiagnosticCorrelation(state, captureEvidence);
  const assessment = assessCoherentFirstPaneBoundaries({
    timeline,
    correlationComplete: correlation.complete,
  });
  const report = {
    version: 1,
    status: assessment.status,
    journey: planEntry.journey.id,
    variant: planEntry.variant,
    repetition: planEntry.repetition,
    repeat: planEntry.repeat,
    runId: planEntry.runId,
    firstBrokenBoundary: assessment.firstBrokenBoundary,
    firstUnmeasuredBoundary: assessment.firstUnmeasuredBoundary,
    boundaries: assessment.boundaries,
    journeyEvidence: state.journeyEvidence?.coherentFirstPane ?? null,
    diagnosticCorrelation: { complete: correlation.complete, missing: correlation.missing },
    sourceProvenance: {
      commit: state.tui?.performanceTraceCommit ?? null,
      tree: state.tui?.performanceTraceTree ?? null,
      manifestDigest: state.tui?.performanceTraceManifestDigest ?? null,
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
        firstBrokenBoundary: assessment.firstBrokenBoundary,
        firstUnmeasuredBoundary: assessment.firstUnmeasuredBoundary,
        boundaries: assessment.boundaries,
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

async function diagnoseFirstKeyPaste(planEntry) {
  diagnosticAttemptPhases.set(planEntry.runId, "product-rig-startup");
  await start(false, true, planEntry);
  const state = await waitForState((candidate) => candidate?.status === "ready");
  diagnosticAttemptPhases.set(planEntry.runId, "evidence-capture");
  const captureEvidence = await captureArtifacts(
    state,
    `diagnose-${planEntry.journey.id}-${planEntry.variant}-r${planEntry.repetition}`,
  );
  diagnosticCaptures.set(planEntry.runId, captureEvidence);
  await tuiCommandAsync(state, ["stop"], { timeout: 5_000 });
  const timeline = readJsonLines(timelinePath);
  const correlation = productDiagnosticCorrelation(state, captureEvidence);
  const journeyEvidence = state.journeyEvidence?.firstKeyPaste ?? null;
  const assessment = assessFirstKeyPasteBoundaries({
    timeline,
    evidence: journeyEvidence,
    correlationComplete: correlation.complete,
  });
  const report = {
    version: 1,
    status: assessment.status,
    journey: planEntry.journey.id,
    variant: planEntry.variant,
    repetition: planEntry.repetition,
    repeat: planEntry.repeat,
    runId: planEntry.runId,
    firstBrokenBoundary: assessment.firstBrokenBoundary,
    firstUnmeasuredBoundary: assessment.firstUnmeasuredBoundary,
    boundaries: assessment.boundaries,
    firstInput: journeyEvidence?.firstInput ?? null,
    distribution: journeyEvidence?.distribution ?? null,
    diagnosticCorrelation: { complete: correlation.complete, missing: correlation.missing },
    sourceProvenance: {
      commit: state.tui?.performanceTraceCommit ?? null,
      tree: state.tui?.performanceTraceTree ?? null,
      manifestDigest: state.tui?.performanceTraceManifestDigest ?? null,
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
        variant: planEntry.variant,
        firstBrokenBoundary: assessment.firstBrokenBoundary,
        firstUnmeasuredBoundary: assessment.firstUnmeasuredBoundary,
        boundaries: assessment.boundaries,
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

async function diagnoseFocus(planEntry) {
  diagnosticAttemptPhases.set(planEntry.runId, "product-rig-startup");
  await start(false, true, planEntry);
  const state = await waitForState((candidate) => candidate?.status === "ready");
  diagnosticAttemptPhases.set(planEntry.runId, "evidence-capture");
  const captureEvidence = await captureArtifacts(
    state,
    `diagnose-${planEntry.journey.id}-r${planEntry.repetition}`,
  );
  diagnosticCaptures.set(planEntry.runId, captureEvidence);
  await tuiCommandAsync(state, ["stop"], { timeout: 5_000 });
  const timeline = readJsonLines(timelinePath);
  const correlation = productDiagnosticCorrelation(state, captureEvidence);
  const journeyEvidence = state.journeyEvidence?.focus ?? null;
  const assessment = assessFocusJourneyBoundaries({
    timeline,
    evidence: journeyEvidence?.reclaim?.assessment ?? null,
    correlationComplete: correlation.complete,
  });
  const report = {
    version: 1,
    status: assessment.status,
    journey: planEntry.journey.id,
    variant: null,
    repetition: planEntry.repetition,
    repeat: planEntry.repeat,
    runId: planEntry.runId,
    firstBrokenBoundary: assessment.firstBrokenBoundary,
    firstUnmeasuredBoundary: assessment.firstUnmeasuredBoundary,
    boundaries: assessment.boundaries,
    focus: journeyEvidence,
    diagnosticCorrelation: { complete: correlation.complete, missing: correlation.missing },
    sourceProvenance: {
      commit: state.tui?.performanceTraceCommit ?? null,
      tree: state.tui?.performanceTraceTree ?? null,
      manifestDigest: state.tui?.performanceTraceManifestDigest ?? null,
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
        firstBrokenBoundary: assessment.firstBrokenBoundary,
        firstUnmeasuredBoundary: assessment.firstUnmeasuredBoundary,
        boundaries: assessment.boundaries,
        correlation: { complete: correlation.complete, missing: correlation.missing },
        availability: correlation.availability,
      },
      timeline: readDiagnosticText(timelinePath),
      tmuxTruth: captureEvidence.truth,
      daemonState: correlation.daemonState,
      clientState: correlation.clientState,
      tuiAnsi: readDiagnosticText(captureEvidence.tuiPath),
      webPngPath: captureEvidence.webPath,
      stderr: boundedDiagnosticText(readDiagnosticText(join(state.tui.runtimeDir, "stderr.log"))),
      reproduction: diagnosticReproduction(planEntry.journey.id, null),
    },
  };
}

async function diagnoseWindowLifecycle(planEntry) {
  diagnosticAttemptPhases.set(planEntry.runId, "product-rig-startup");
  await start(false, true, planEntry);
  const state = await waitForState((candidate) => candidate?.status === "ready");
  diagnosticAttemptPhases.set(planEntry.runId, "evidence-capture");
  const captureEvidence = await captureArtifacts(
    state,
    `diagnose-${planEntry.journey.id}-r${planEntry.repetition}`,
  );
  diagnosticCaptures.set(planEntry.runId, captureEvidence);
  await tuiCommandAsync(state, ["stop"], { timeout: 5_000 });
  const timeline = readJsonLines(timelinePath);
  const correlation = productDiagnosticCorrelation(state, captureEvidence);
  const journeyEvidence = state.journeyEvidence?.windowLifecycle ?? null;
  const expected = journeyEvidence?.expected ?? null;
  const causal = assessProductWindowLifecycle({ evidence: journeyEvidence, expected });
  const assessment = assessWindowLifecycleJourneyBoundaries({
    timeline,
    assessment: causal,
    correlationComplete: correlation.complete,
  });
  const report = {
    version: 1,
    status: assessment.status,
    journey: planEntry.journey.id,
    variant: null,
    repetition: planEntry.repetition,
    repeat: planEntry.repeat,
    runId: planEntry.runId,
    firstBrokenBoundary: assessment.firstBrokenBoundary,
    firstUnmeasuredBoundary: assessment.firstUnmeasuredBoundary,
    boundaries: assessment.boundaries,
    causalAssessment: causal,
    windowLifecycle: journeyEvidence,
    diagnosticCorrelation: { complete: correlation.complete, missing: correlation.missing },
    sourceProvenance: {
      commit: state.tui?.performanceTraceCommit ?? null,
      tree: state.tui?.performanceTraceTree ?? null,
      manifestDigest: state.tui?.performanceTraceManifestDigest ?? null,
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
        firstBrokenBoundary: assessment.firstBrokenBoundary,
        firstUnmeasuredBoundary: assessment.firstUnmeasuredBoundary,
        boundaries: assessment.boundaries,
        causalAssessment: causal,
        correlation: { complete: correlation.complete, missing: correlation.missing },
        availability: correlation.availability,
      },
      timeline: readDiagnosticText(timelinePath),
      tmuxTruth: captureEvidence.truth,
      daemonState: correlation.daemonState,
      clientState: correlation.clientState,
      tuiAnsi: readDiagnosticText(captureEvidence.tuiPath),
      webPngPath: captureEvidence.webPath,
      stderr: boundedDiagnosticText(readDiagnosticText(join(state.tui.runtimeDir, "stderr.log"))),
      reproduction: diagnosticReproduction(planEntry.journey.id, null),
    },
  };
}

async function diagnoseKeyboardPointerResize(planEntry) {
  diagnosticAttemptPhases.set(planEntry.runId, "product-rig-startup");
  await start(false, true, planEntry);
  const state = await waitForState((candidate) => candidate?.status === "ready");
  diagnosticAttemptPhases.set(planEntry.runId, "evidence-capture");
  const captureEvidence = await captureArtifacts(
    state,
    `diagnose-${planEntry.journey.id}-r${planEntry.repetition}`,
  );
  diagnosticCaptures.set(planEntry.runId, captureEvidence);
  await tuiCommandAsync(state, ["stop"], { timeout: 5_000 });
  const timeline = readJsonLines(timelinePath);
  const correlation = productDiagnosticCorrelation(state, captureEvidence);
  const journeyEvidence = state.journeyEvidence?.keyboardPointerResize ?? null;
  const causal = assessProductKeyboardPointerResize({
    evidence: journeyEvidence,
    expected: journeyEvidence?.expected ?? null,
  });
  const assessment = assessKeyboardPointerResizeJourneyBoundaries({
    timeline,
    assessment: causal,
    correlationComplete: correlation.complete,
  });
  const report = {
    version: 1,
    status: assessment.status,
    journey: planEntry.journey.id,
    variant: null,
    repetition: planEntry.repetition,
    repeat: planEntry.repeat,
    runId: planEntry.runId,
    firstBrokenBoundary: assessment.firstBrokenBoundary,
    firstUnmeasuredBoundary: assessment.firstUnmeasuredBoundary,
    boundaries: assessment.boundaries,
    causalAssessment: causal,
    keyboardPointerResize: journeyEvidence,
    diagnosticCorrelation: { complete: correlation.complete, missing: correlation.missing },
    sourceProvenance: {
      commit: state.tui?.performanceTraceCommit ?? null,
      tree: state.tui?.performanceTraceTree ?? null,
      manifestDigest: state.tui?.performanceTraceManifestDigest ?? null,
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
        firstBrokenBoundary: assessment.firstBrokenBoundary,
        firstUnmeasuredBoundary: assessment.firstUnmeasuredBoundary,
        boundaries: assessment.boundaries,
        causalAssessment: causal,
        correlation: { complete: correlation.complete, missing: correlation.missing },
        availability: correlation.availability,
      },
      timeline: readDiagnosticText(timelinePath),
      tmuxTruth: captureEvidence.truth,
      daemonState: correlation.daemonState,
      clientState: correlation.clientState,
      tuiAnsi: readDiagnosticText(captureEvidence.tuiPath),
      webPngPath: captureEvidence.webPath,
      stderr: boundedDiagnosticText(readDiagnosticText(join(state.tui.runtimeDir, "stderr.log"))),
      reproduction: diagnosticReproduction(planEntry.journey.id, null),
    },
  };
}

function executeProductJourney(planEntry) {
  return dispatchProductJourneyExecutor(planEntry, {
    "configless-cold-start": diagnoseConfiglessColdStart,
    "coherent-first-pane": diagnoseCoherentFirstPane,
    "first-key-paste": diagnoseFirstKeyPaste,
    focus: diagnoseFocus,
    "window-lifecycle": diagnoseWindowLifecycle,
    "keyboard-pointer-resize": diagnoseKeyboardPointerResize,
    "runtime-qualification": diagnoseRuntimeQualification,
  });
}

async function prepareDiagnosticFailure(planEntry, error, firstBrokenBoundary) {
  const state = readJson(statePath);
  const partialRuntime = partialProductRuntimeEvidence(state);
  let failureObservation = error?.observation ?? state?.failureObservation ?? null;
  if (
    failureObservation?.operation === "wait-for-coherent-terminal-frame" &&
    state?.tui?.runtimeDir &&
    state?.tui?.performanceTracePath
  ) {
    failureObservation = productCoherentFrameTimeoutObservation({
      lifecycleRecords: readJsonLines(join(state.tui.runtimeDir, "performance.jsonl")),
      traceRecords: readJsonLines(state.tui.performanceTracePath),
      processId: failureObservation.processId,
      daemonGeneration: failureObservation.daemonGeneration,
      detailMode: state.tui.performanceTraceDetail,
    });
  }
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
    partialRuntime,
    sourceProvenance: {
      commit: state?.tui?.performanceTraceCommit ?? null,
      tree: state?.tui?.performanceTraceTree ?? null,
      manifestDigest: state?.tui?.performanceTraceManifestDigest ?? null,
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
        partialRuntime,
        correlation: { complete: false, missing: correlation.missing },
        availability: {
          tmuxTruth: truth !== null,
          tui: tuiAvailable,
          web: webAvailable,
          partialRuntime:
            partialRuntime.lifecycle.available || partialRuntime.referenceTrace.available,
        },
      },
      timeline: readDiagnosticText(timelinePath),
      tmuxTruth: truth ?? {
        status: "unavailable",
        reason: `not captured before ${firstBrokenBoundary}`,
      },
      daemonState: correlation.daemonState,
      clientState: { ...correlation.clientState, failureObservation, partialRuntime },
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
  resetAttemptTimelineClock();
  try {
    return await runIsolatedProductJourneyAttempt(entry, {
      onPhase: (phase) => diagnosticAttemptPhases.set(entry.runId, phase),
      currentBoundary: () => diagnosticAttemptPhases.get(entry.runId) ?? "journey-drive",
      preCleanup: () => stop(false, { quiet: true, strict: true }),
      drive: async () => {
        assertFrozenProductSource("before-repetition");
        const completed = await executeProductJourney(entry);
        assertFrozenProductSource("after-repetition");
        return completed;
      },
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
      validateAfterCleanup: () => assertFrozenProductSource("after-cleanup"),
      appendCleanupFailure: (failedResult, cleanupError) => {
        const cleanupFailure = boundedDiagnosticText(
          cleanupError instanceof Error
            ? cleanupError.stack || cleanupError.message
            : String(cleanupError),
        );
        failedResult.report.cleanupFailure = cleanupFailure;
        failedResult.evidence.alignment.cleanupFailure = cleanupFailure;
      },
      appendValidationFailure: (failedResult, validationError) => {
        const observation =
          validationError?.boundary === "source-provenance" &&
          validationError?.observation?.reason === "source-drift"
            ? validationError.observation
            : Object.freeze({
                operation: "product-rig-post-cleanup-validation",
                reason: "validation-failed",
              });
        failedResult.report.sourceProvenanceFailure = observation;
        failedResult.evidence.alignment.sourceProvenanceFailure = observation;
        failedResult.evidence.clientState.sourceProvenanceFailure = observation;
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
  await execFileAsync(process.execPath, [join(repoRoot, "scripts", "build-cli.mjs")], {
    cwd: repoRoot,
    timeout: 120_000,
  });
  diagnosticFrozenProvenance = sourceTraceProvenance();
  let runs;
  try {
    runs = await runProductJourneyPlan(plan, executeDiagnosticAttempt);
  } finally {
    diagnosticFrozenProvenance = null;
  }
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

async function observeTargetedCanonicalIdentity(daemon, sessionName, workspaceName) {
  const headers = { Authorization: `Bearer ${daemon.record.authToken}` };
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const [catalogResponse, fleetResponse] = await Promise.all([
      fetch(`${daemon.baseUrl}/api/resources/workspace-catalog?version=2`, { headers }),
      fetch(`${daemon.baseUrl}/api/resources/fleet-catalog`, { headers }),
    ]);
    if (catalogResponse.ok && fleetResponse.ok) {
      const catalog = await catalogResponse.json();
      const fleetCatalog = await fleetResponse.json();
      const intents = catalog.intents?.filter(
        (entry) =>
          entry.workspaceName === workspaceName &&
          entry.sessionName === sessionName &&
          entry.availability === "live",
      );
      const live = catalog.liveSessions?.filter(({ sessionName: name }) => name === sessionName);
      const fleetRows = fleetCatalog.sessions?.filter(({ label }) => label === sessionName);
      if (
        catalog.daemon?.instanceId === daemon.record.instanceId &&
        fleetCatalog.daemon?.instanceId === daemon.record.instanceId &&
        intents?.length === 1 &&
        live?.length === 1 &&
        fleetRows?.length === 1 &&
        live[0].fleetSessionId === fleetRows[0].sessionId &&
        /^[0-9a-f]{20}$/u.test(fleetCatalog.catalogRevision ?? "")
      )
        return Object.freeze({
          workspaceName,
          sessionName,
          fleetSessionId: live[0].fleetSessionId,
          catalogRevision: fleetCatalog.catalogRevision,
        });
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("targeted canonical workspace identity did not settle before deadline");
}

function causalFixtureOption(state, paneId) {
  return execFileSync(
    "tmux",
    [
      "-S",
      state.runtimeNamespace.tmuxSocketPath,
      "show-options",
      "-pqv",
      "-t",
      paneId,
      "@tmux_ide_causal_fixture",
    ],
    { encoding: "utf8" },
  ).trim();
}

async function waitForDirectCausalFixture(state, paneId) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const command = execFileSync(
      "tmux",
      [
        "-S",
        state.runtimeNamespace.tmuxSocketPath,
        "display-message",
        "-p",
        "-t",
        paneId,
        "#{pane_current_command}",
      ],
      { encoding: "utf8" },
    ).trim();
    if (command === "node" && causalFixtureOption(state, paneId) === "ready-v1") return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("direct causal fixture did not become ready before TUI input");
}

function activeCanonicalIdentity(records, expected) {
  const paint = records.findLast(
    (record) =>
      record?.type === "performance.terminal-canonical-paint" &&
      record.processId === expected.processId &&
      record.semanticPaneId === expected.semanticPaneId &&
      record.generation === expected.generation,
  );
  if (
    !paint ||
    typeof paint.incarnation !== "string" ||
    !Number.isSafeInteger(paint.revision) ||
    typeof paint.stateHash !== "string"
  )
    throw new Error("first-input lane has no exact canonical paint identity");
  return Object.freeze({
    ...expected,
    clockId: paint.clockId,
    incarnation: paint.incarnation,
    revision: paint.revision,
    stateHash: paint.stateHash,
  });
}

async function waitForInputEpoch(tracePath, baseline, processId) {
  return waitForProductInputPersistenceFence({
    readRecords: () => readJsonLines(tracePath),
    baseline,
    processId,
  });
}

async function owner() {
  const inheritedTimelineOrigin = Number(process.env.TMUX_IDE_PRODUCT_TIMELINE_ORIGIN_MS);
  resetAttemptTimelineClock(
    Number.isFinite(inheritedTimelineOrigin)
      ? inheritedTimelineOrigin
      : performance.timeOrigin + performance.now(),
  );
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
    daemonLifecycle: "not-started",
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
              if (state.tui) await tuiCommandAsync(state, ["stop"], { timeout: 5_000 });
            },
          },
          {
            subsystem: "tui-evidence",
            run: async () => {
              const ownedRuntimeDirs = state.ownedTuiRuntimeDirs ?? [];
              const bufferedTui = bufferOwnedTuiRuntimeEvidence({
                ownedRuntimeDirs,
                activeTui: state.tui,
                artifactDir,
                pathExists: existsSync,
                ensureArtifactDir: (path) => mkdirSync(path, { recursive: true, mode: 0o700 }),
                moveRuntimeDir: renameSync,
                onActiveTuiRelocated: (tui) => publish({ tui }),
              });
              if (bufferedTui !== state.tui) publish({ tui: bufferedTui });
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
      for (const pid of activeTuiCommandPids) {
        if (processAlive(pid))
          failures.push({ subsystem: "tui-command", detail: `pid ${pid} remained live` });
      }
      for (const [subsystem, path] of [
        ["runtime-root", state.runtimeNamespace?.root],
        ["tmux-socket", state.runtimeNamespace?.tmuxSocketPath],
        ["host-tmux-socket", state.runtimeNamespace?.hostTmuxSocketPath],
        ["daemon-info", state.runtimeNamespace?.daemonInfoDir],
        ...(state.ownedTuiRuntimeDirs ?? []).map((path) => ["tui-runtime", path]),
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
      publish({
        status: "failed",
        failure: error.stack ?? error.message,
        firstBrokenBoundary: state.currentJourneyBoundary ?? "host-sleep-assertion",
        failureObservation: Object.freeze({
          operation: "product-rig-host-sleep-assertion",
          reason: "sleep-assertion-lost",
          stage: state.currentJourneyBoundary ?? "startup",
          switchOrdinalWatermark: Number.isSafeInteger(state.windowSwitchOrdinalWatermark)
            ? Math.min(state.windowSwitchOrdinalWatermark, 32)
            : null,
        }),
      });
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
    if (journeyId === "first-key-paste") {
      const variant = process.env.TMUX_IDE_PRODUCT_JOURNEY_VARIANT;
      if (variant !== "key" && variant !== "paste")
        throw new Error("first-key-paste owner requires an exact key or paste variant");
      const inputBoot = await runFirstKeyPasteOwnerBoot({
        createInputNamespace: async () => {
          const fixturePath = join(
            repoRoot,
            "scripts",
            "lib",
            "product-rig-causal-cell-fixture.mjs",
          );
          const daemonPerformanceTracePath = join(rigRoot, "first-input-daemon-performance.jsonl");
          const scratchFleet = await createScratchFleet({
            sessions: 1,
            slug,
            initialPaneCommand: { executable: process.execPath, args: [fixturePath] },
          });
          const cleanupToken = `product-test-rig:${slug}`;
          fleet = {
            ...scratchFleet,
            environment: {
              ...scratchFleet.environment,
              TMUX_IDE_RUNTIME_MODE: "testdrive",
              TMUX_IDE_CLEANUP_TOKEN: cleanupToken,
              TMUX_IDE_TMUX_SOCKET_PATH: scratchFleet.socketPath,
              TMUX_IDE_SESSION_RUNTIME_TRACE_LOG: daemonPerformanceTracePath,
            },
          };
          const session = fleet.sessionNames[0];
          const initialPane = fleet.initialPanes.find((pane) => pane.sessionName === session);
          if (!initialPane)
            throw new Error("first-input namespace did not retain its exact initial raw pane");
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
          const intendedTui = {
            hostSession: `_tmux-ide-product-rig-${slug}`,
            runtimeDir: join(rigRoot, "tui-first-input"),
            performanceTracePath: join(rigRoot, "tui-first-input", "performance-trace.jsonl"),
            daemonPerformanceTracePath,
          };
          const inputFingerprintKey = randomBytes(32).toString("hex");
          productInputFingerprintKeys.set(intendedTui.runtimeDir, inputFingerprintKey);
          const tui = prepareOwnedTuiRuntime({
            ownership: { session, runtimeNamespace },
            intendedTui: {
              ...intendedTui,
              performanceTraceDetail: "1",
              performanceTraceInputOrigin: "1",
              performanceTraceInputDetail: "1",
            },
            publish,
            resolveProvenance: sourceTraceProvenance,
            createRuntimeDir: createIsolatedTargetedTuiCwd,
          });
          await waitForDirectCausalFixture(state, initialPane.paneId);
          event("first-input-namespace-ready", {
            variant,
            paneId: initialPane.paneId,
            geometry: initialPane,
            fixtureStartedBeforeDaemon: true,
          });
          return {
            session,
            runtimeNamespace,
            tui,
            paneId: initialPane.paneId,
            initialPane,
            inputFingerprintKey,
          };
        },
        startCanonicalDaemon: async () => {
          daemon = await startOwnedProductRigDaemon({
            start: () => startDaemon(fleet),
            publish,
            waitUntilReady: waitForReadinessLadder,
          });
          return daemon;
        },
        openCanonicalWorkspace: async (namespace, runningDaemon) => {
          const workspace = await runningDaemon.promote(namespace.session);
          const identity = await observeTargetedCanonicalIdentity(
            runningDaemon,
            namespace.session,
            workspace,
          );
          publish({
            workspace,
            daemon: {
              ...runningDaemon.record,
              revision: identity.catalogRevision,
              revisionKind: "fleet-catalog",
            },
          });
          event("first-input-daemon-ready", identity);
          return identity;
        },
        buildBeforeMeasurement: async () => {
          await execFileAsync("bun", [join(repoRoot, "scripts", "build-tui.mjs")], {
            cwd: repoRoot,
            timeout: 120_000,
          });
        },
        prepareFirstTui: async (namespace) =>
          prepareIsolatedTargetedTuiCwd(namespace.tui.runtimeDir),
        launchFirstTui: async (namespace) => {
          const status = await launchAndWaitForExactProductTui({
            start: () =>
              tuiCommand(state, [
                "start",
                "--target",
                namespace.session,
                "--cols",
                "160",
                "--rows",
                "44",
              ]),
            status: () => JSON.parse(tuiCommand(state, ["status", "--json"])),
            waitForCoherent: (processId) => waitForCoherentTui(state, 30_000, processId),
          });
          return Object.freeze({ processId: status.processId, launchId: status.launchId });
        },
        proveNoPriorHostedInput: async (namespace, runningDaemon) => {
          await waitForDirectCausalFixture(state, namespace.paneId);
          const active = activeTmuxPane(state);
          bindPromotedInitialPane(namespace.initialPane, active);
          const records = readJsonLines(namespace.tui.performanceTracePath);
          const processId = records.findLast(
            (record) => record?.type === "performance.trace.header",
          )?.processId;
          if (!processId) throw new Error("first-input trace header is unavailable");
          if (
            records.some(
              (record) =>
                record.processId === processId &&
                (record.type === "performance.input-origin" ||
                  (record.type === "performance.stage" && record.stage === "input")),
            )
          )
            throw new Error("first-input lane observed hosted input before the tested input");
          if (!productInputQueuesSettled(records, processId))
            throw new Error("first-input lane queue was not empty before tested input");
          const token = `first-${variant}-${randomBytes(6).toString("hex")}`;
          const sendReset = () => {
            execFileSync("tmux", [
              "-S",
              state.runtimeNamespace.tmuxSocketPath,
              "send-keys",
              "-l",
              "-t",
              namespace.paneId,
              `reset-v1;${token}`,
            ]);
            execFileSync("tmux", [
              "-S",
              state.runtimeNamespace.tmuxSocketPath,
              "send-keys",
              "-t",
              namespace.paneId,
              "C-j",
            ]);
          };
          const settled = await settleProductFirstInputFixtureReset({
            token,
            sendReset,
            expected: {
              paneId: namespace.paneId,
              semanticPaneId: active.semanticPaneId,
              generation: runningDaemon.record.instanceId,
            },
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
                  namespace.paneId,
                ],
                { encoding: "utf8" },
              );
              const tuiFrame = tuiCommand(state, ["capture"]);
              const activeAfter = activeTmuxPane(state);
              const currentRecords = readJsonLines(namespace.tui.performanceTracePath);
              const canonical = activeCanonicalIdentity(currentRecords, {
                processId,
                semanticPaneId: activeBefore.semanticPaneId,
                generation: runningDaemon.record.instanceId,
              });
              const body = paneBodyRegion(tuiFrame, activeBefore);
              return Object.freeze({
                fixtureOption: causalFixtureOption(state, namespace.paneId),
                currentCommand: execFileSync(
                  "tmux",
                  [
                    "-S",
                    state.runtimeNamespace.tmuxSocketPath,
                    "display-message",
                    "-p",
                    "-t",
                    namespace.paneId,
                    "#{pane_current_command}",
                  ],
                  { encoding: "utf8" },
                ).trim(),
                paneId: activeBefore.paneId,
                semanticPaneId: activeBefore.semanticPaneId,
                generation: canonical.generation,
                incarnation: canonical.incarnation,
                revision: canonical.revision,
                stateHash: canonical.stateHash,
                geometry: paneGeometryIdentity([activeBefore]),
                geometryStable:
                  paneGeometryIdentity([activeBefore]) === paneGeometryIdentity([activeAfter]),
                nativeCellBlank: terminalCellAt(native, 0, activeBefore.width - 1) === " ",
                tuiCellBlank: terminalCellAt(body, 0, activeBefore.width - 1) === " ",
                queueSettled: productInputQueuesSettled(currentRecords, processId),
                nativeHash: createHash("sha256").update(native).digest("hex"),
                tuiHash: createHash("sha256").update(body).digest("hex"),
              });
            },
          });
          const finalRecords = readJsonLines(namespace.tui.performanceTracePath);
          if (
            finalRecords.some(
              (record) =>
                record.processId === processId &&
                (record.type === "performance.input-origin" ||
                  (record.type === "performance.stage" && record.stage === "input")),
            )
          )
            throw new Error("fixture reset introduced hosted input before the tested input");
          event("first-input-no-prior-hosted-input", {
            processId,
            semanticPaneId: active.semanticPaneId,
            baselineRevision: settled.revision,
            baselineStateHash: settled.stateHash,
          });
          return Object.freeze({
            active,
            expected: Object.freeze({
              processId,
              clockId: "opentui-performance-now",
              semanticPaneId: settled.semanticPaneId,
              generation: settled.generation,
              incarnation: settled.incarnation,
              revision: settled.revision,
              stateHash: settled.stateHash,
              inputFingerprintKey: namespace.inputFingerprintKey,
            }),
            traceBaseline: finalRecords.length,
          });
        },
        driveFirstInput: async (namespace, _runningDaemon, _identity, _process, baseline) => {
          const document = productFirstInputDocument(variant, 0);
          const nativeBefore = execFileSync(
            "tmux",
            [
              "-S",
              state.runtimeNamespace.tmuxSocketPath,
              "capture-pane",
              "-p",
              "-t",
              namespace.paneId,
            ],
            { encoding: "utf8" },
          );
          const bodyBefore = paneBodyRegion(tuiCommand(state, ["capture"]), baseline.active);
          const delivery = JSON.parse(tuiCommand(state, ["input", JSON.stringify(document)]));
          await waitForInputEpoch(
            namespace.tui.performanceTracePath,
            baseline.traceBaseline,
            baseline.expected.processId,
          );
          const qualified = await waitForProductInputQualification({
            baseline: baseline.traceBaseline,
            processId: baseline.expected.processId,
            readTuiRecords: () => readJsonLines(namespace.tui.performanceTracePath),
            readDaemonRecords: () => readJsonLines(namespace.tui.daemonPerformanceTracePath),
            assess: (tuiRecords, daemonTraceRecords) =>
              assessProductFirstInput(tuiRecords, {
                ...baseline.expected,
                variant,
                document,
                daemonTraceRecords,
                requireDaemonEvidence: true,
                requireSharedClockEvidence: true,
              }),
            qualify: (tuiRecords, daemonTraceRecords) =>
              qualifyProductFirstInput(tuiRecords, {
                ...baseline.expected,
                variant,
                document,
                daemonTraceRecords,
                requireDaemonEvidence: true,
                requireSharedClockEvidence: true,
              }),
          });
          if (!qualified)
            throw new Error("first input did not close its exact parser-to-paint chain");
          const activeAfter = activeTmuxPane(state);
          const nativeAfter = execFileSync(
            "tmux",
            [
              "-S",
              state.runtimeNamespace.tmuxSocketPath,
              "capture-pane",
              "-p",
              "-t",
              namespace.paneId,
            ],
            { encoding: "utf8" },
          );
          const bodyAfter = paneBodyRegion(tuiCommand(state, ["capture"]), activeAfter);
          const { row, column, beforeGrapheme, afterGrapheme } = qualified.painted;
          if (
            activeAfter.paneId !== namespace.paneId ||
            paneGeometryIdentity([baseline.active]) !== paneGeometryIdentity([activeAfter]) ||
            terminalCellAt(nativeBefore, row, column) !== beforeGrapheme ||
            terminalCellAt(bodyBefore, row, column) !== beforeGrapheme ||
            terminalCellAt(nativeAfter, row, column) !== afterGrapheme ||
            terminalCellAt(bodyAfter, row, column) !== afterGrapheme
          )
            throw new Error("first input changed-cell evidence disagreed with native/TUI cells");
          const evidence = Object.freeze({
            variant,
            passed: true,
            documentKind: document.kind,
            delivery,
            traceId: qualified.origin.traceId,
            parserOrigin: Object.freeze({
              origin: qualified.origin.origin,
              parserConsumption: qualified.origin.parserConsumption,
              payloadByteCount: qualified.origin.payloadByteCount,
              processId: qualified.origin.processId,
              clockId: qualified.origin.clockId,
              semanticPaneId: qualified.origin.semanticPaneId,
              generation: qualified.origin.generation,
              incarnation: qualified.origin.incarnation,
              revision: qualified.origin.revision,
              stateHash: qualified.origin.stateHash,
            }),
            sample: Object.freeze({
              traceId: qualified.sample.traceId,
              durationMs: qualified.sample.durationMs,
              processId: qualified.sample.processId,
              clockId: qualified.sample.clockId,
              semanticPaneId: qualified.sample.semanticPaneId,
              generation: qualified.sample.generation,
              incarnation: qualified.sample.incarnation,
              revision: qualified.sample.revision,
              stateHash: qualified.sample.stateHash,
              clientReceipts: qualified.sample.clientStages.map(({ operation, offsetMs }) => ({
                operation,
                offsetMs,
              })),
              daemonReceipts: qualified.sample.daemonSpans,
            }),
            cell: { row, column, changed: true, nativeTuiMatched: true },
            queueBefore: qualified.queueBefore,
            queueAfter: qualified.queueAfter,
            fence: qualified.fence,
            noPriorHostedInput: true,
          });
          event("first-input-causal-paint", evidence);
          return evidence;
        },
        rehostDistributionTui: async (namespace, _daemon, _identity, firstProcess) => {
          tuiCommand(state, ["stop"]);
          const distributionRuntimeDir = join(rigRoot, "tui-input-distribution");
          const tui = prepareOwnedTuiRuntime({
            ownership: {},
            intendedTui: {
              ...namespace.tui,
              runtimeDir: distributionRuntimeDir,
              performanceTracePath: join(distributionRuntimeDir, "performance-trace.jsonl"),
              performanceTraceDetail: "0",
              performanceTraceInputOrigin: "1",
              performanceTraceInputDetail: "1",
            },
            ownedTuiRuntimeDirs: state.ownedTuiRuntimeDirs ?? [],
            publish,
            resolveProvenance: sourceTraceProvenance,
            createRuntimeDir: createIsolatedTargetedTuiCwd,
          });
          const inputFingerprintKey = randomBytes(32).toString("hex");
          productInputFingerprintKeys.set(tui.runtimeDir, inputFingerprintKey);
          prepareIsolatedTargetedTuiCwd(tui.runtimeDir);
          const status = await launchAndWaitForExactProductTui({
            start: () =>
              tuiCommand(state, [
                "start",
                "--target",
                namespace.session,
                "--cols",
                "160",
                "--rows",
                "44",
              ]),
            status: () => JSON.parse(tuiCommand(state, ["status", "--json"])),
            waitForCoherent: (processId) => waitForCoherentTui(state, 30_000, processId),
          });
          if (status.processId === firstProcess.processId)
            throw new Error("distribution lane reused the first-input TUI process");
          const records = readJsonLines(tui.performanceTracePath);
          const processId = records.findLast(
            (record) => record?.type === "performance.trace.header",
          )?.processId;
          if (!processId || !productInputQueuesSettled(records, processId))
            throw new Error("distribution lane did not start with an empty exact queue");
          const active = activeTmuxPane(state);
          if (active.paneId !== namespace.paneId)
            throw new Error("distribution lane targeted a different physical pane");
          const expected = activeCanonicalIdentity(records, {
            processId,
            semanticPaneId: active.semanticPaneId,
            generation: state.daemon.instanceId,
          });
          if (
            records.some(
              (record) =>
                record.processId === processId &&
                (record.type === "performance.input-origin" ||
                  (record.type === "performance.stage" && record.stage === "input")),
            )
          )
            throw new Error("distribution lane observed input before its first timing sample");
          event("distribution-lane-fresh", {
            processId,
            previousProcessId: firstProcess.processId,
          });
          return Object.freeze({
            processId,
            launchId: status.launchId,
            tui,
            active,
            expected,
            inputFingerprintKey,
          });
        },
        driveDistribution: async (_namespace, runningDaemon, identity, process) => {
          const startOrdinal = 1;
          for (let ordinal = 0; ordinal < 30; ordinal += 1) {
            const baseline = readJsonLines(process.tui.performanceTracePath).length;
            tuiCommand(state, [
              "input",
              JSON.stringify(productFirstInputDocument(variant, startOrdinal + ordinal)),
            ]);
            await waitForInputEpoch(process.tui.performanceTracePath, baseline, process.processId);
          }
          const expected = {
            variant,
            ...process.expected,
            inputFingerprintKey: process.inputFingerprintKey,
            revision: undefined,
            stateHash: undefined,
            requireDaemonEvidence: true,
            requireSharedClockEvidence: true,
            startOrdinal,
          };
          const distribution = await waitForProductInputQualification({
            boundary: "distribution-samples",
            baseline: 0,
            processId: process.expected.processId,
            readTuiRecords: () => readJsonLines(process.tui.performanceTracePath),
            readDaemonRecords: () => readJsonLines(process.tui.daemonPerformanceTracePath),
            assess: (tuiRecords, daemonTraceRecords) =>
              assessProductInputDistribution(tuiRecords, {
                ...expected,
                daemonTraceRecords,
              }),
            qualify: (tuiRecords, daemonTraceRecords) => {
              return qualifyProductInputDistribution(tuiRecords, {
                ...expected,
                daemonTraceRecords,
              });
            },
          });
          if (!distribution.passed)
            throw new Error(
              `first-input distribution failed: ${JSON.stringify({ sampleCount: distribution?.sampleCount ?? 0, p95Ms: distribution?.p95Ms ?? null, p99Ms: distribution?.p99Ms ?? null })}`,
            );
          if (
            distribution.samples[0]?.origin.revision !== process.expected.revision ||
            distribution.samples[0]?.origin.stateHash !== process.expected.stateHash
          )
            throw new Error("distribution first parser origin did not match its pre-input anchor");
          const workspaceClient = await waitForQualifiedWorkspaceClientState(
            () => readJsonLines(join(process.tui.runtimeDir, "performance.jsonl")),
            {
              processId: process.processId,
              daemonGeneration: runningDaemon.record.instanceId,
              workspaceName: state.workspace,
              sessionName: state.session,
              fleetSessionId: identity.fleetSessionId,
              semanticPaneId: process.expected.semanticPaneId,
              canonicalGeneration: runningDaemon.record.instanceId,
            },
          );
          publish({ convergence: { workspaceClient } });
          const evidence = Object.freeze({
            variant,
            passed: true,
            sampleCount: distribution.sampleCount,
            startOrdinal,
            p95Ms: distribution.p95Ms,
            p99Ms: distribution.p99Ms,
            processId: process.processId,
            semanticPaneId: expected.semanticPaneId,
            generation: expected.generation,
            incarnation: expected.incarnation,
            topOutliers: productInputOutlierEvidence({
              samples: distribution.samples,
              startOrdinal,
              daemonObserverRecords: readJsonLines(process.tui.daemonPerformanceTracePath),
            }),
            samples: Object.freeze(
              distribution.samples.map(
                ({ origin, sample, painted, queueBefore, queueAfter, fence }) =>
                  Object.freeze({
                    traceId: sample.traceId,
                    durationMs: sample.durationMs,
                    processId: sample.processId,
                    clockId: sample.clockId,
                    semanticPaneId: sample.semanticPaneId,
                    generation: sample.generation,
                    incarnation: sample.incarnation,
                    revision: sample.revision,
                    stateHash: sample.stateHash,
                    parserOrigin: origin.origin,
                    parserConsumption: origin.parserConsumption,
                    payloadByteCount: origin.payloadByteCount,
                    queueBefore: {
                      inputPending: queueBefore.inputPending,
                      inputInFlight: queueBefore.inputInFlight,
                      inputPendingBytes: queueBefore.inputPendingBytes,
                    },
                    queueAfter: {
                      inputPending: queueAfter.inputPending,
                      inputInFlight: queueAfter.inputInFlight,
                      inputPendingBytes: queueAfter.inputPendingBytes,
                    },
                    dirtyRowProved: painted.dirtyRowProved === true,
                    fenceHealth: fence.writerHealth,
                    clientReceipts: sample.clientStages.map(({ operation, offsetMs }) => ({
                      operation,
                      offsetMs,
                    })),
                    daemonReceipts: sample.daemonSpans,
                  }),
              ),
            ),
          });
          event("distribution-samples", summarizeProductInputDistribution(evidence));
          return evidence;
        },
        startWebAfterInput: async () => {
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
          publish({ web: { pageUrl: devServer.pageUrl, startedAfterInputBoundary: true } });
          event("first-input-web-correlation", { pageUrl: devServer.pageUrl });
          return Object.freeze({ pageUrl: devServer.pageUrl });
        },
      });
      publish({
        journeyEvidence: { firstKeyPaste: inputBoot },
        status: "ready",
        readyAt: new Date().toISOString(),
      });
      await new Promise(() => undefined);
      return;
    }
    if (journeyId === "keyboard-pointer-resize") {
      let resizeReadiness = null;
      let activeDrag = null;
      const resizeBoot = await runKeyboardPointerResizeOwnerBoot({
        onBoundary: (boundary) =>
          publish({
            currentJourneyBoundary: boundary,
            currentJourneyBoundaryAtWallMs: Date.now(),
            currentJourneyBoundaryAtMonotonicMs: performance.now(),
          }),
        createResizeNamespace: async () => {
          const marker = `RIG_RESIZE_${randomBytes(6).toString("hex").toUpperCase()}`;
          const daemonPerformanceTracePath = join(rigRoot, "resize-daemon-performance.jsonl");
          const scratchFleet = await createScratchFleet({
            sessions: 1,
            slug,
            initialPaneCommand: {
              executable: process.execPath,
              args: [
                "-e",
                "if(process.argv[1])process.stdout.write(process.argv[1]+'\\n');setInterval(()=>{},2147483647)",
                marker,
              ],
            },
            windowsPerSession: 1,
          });
          // Cleanup owns the scratch server before any further setup subprocess can fail.
          fleet = scratchFleet;
          const session = scratchFleet.sessionNames[0];
          if (!scratchFleet.initialPanes[0])
            throw new Error("resize namespace lost its exact initial pane receipt");
          await execFileAsync(
            "tmux",
            [
              "-S",
              scratchFleet.socketPath,
              "split-window",
              "-h",
              "-t",
              `=${session}:one`,
              "-d",
              exactResizeBlockerCommand(),
            ],
            { cwd: scratchFleet.root, env: scratchFleet.environment, timeout: 2_000 },
          );
          await conditionExactResizeTmuxFixture(scratchFleet.socketPath, session, {
            marker,
            paneId: scratchFleet.initialPanes[0].paneId,
          });
          if (
            scratchFleet.listWindows(session).length !== 1 ||
            scratchFleet.countPanes(session) !== 2 ||
            scratchFleet.paneSizes(session, "one").length !== 2
          )
            throw new Error("resize namespace did not start with one window and two panes");
          const cleanupToken = `product-test-rig:${slug}`;
          fleet = {
            ...scratchFleet,
            environment: {
              ...scratchFleet.environment,
              TMUX_IDE_RUNTIME_MODE: "testdrive",
              TMUX_IDE_CLEANUP_TOKEN: cleanupToken,
              TMUX_IDE_TMUX_SOCKET_PATH: scratchFleet.socketPath,
              TMUX_IDE_SESSION_RUNTIME_TRACE_LOG: daemonPerformanceTracePath,
            },
          };
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
          const tui = prepareOwnedTuiRuntime({
            ownership: { session, runtimeNamespace },
            intendedTui: {
              hostSession: `_tmux-ide-product-rig-${slug}`,
              runtimeDir: join(rigRoot, "tui-keyboard-pointer-resize"),
              performanceTracePath: join(
                rigRoot,
                "tui-keyboard-pointer-resize",
                "performance-trace.jsonl",
              ),
              performanceTraceDetail: "1",
              daemonPerformanceTracePath,
            },
            publish,
            resolveProvenance: sourceTraceProvenance,
            createRuntimeDir: createIsolatedTargetedTuiCwd,
          });
          publish({ session, runtimeNamespace, tui });
          event("resize-namespace-ready", { windows: 1, panes: 2 });
          return Object.freeze({
            session,
            marker,
            seed: scratchFleet.initialPanes[0],
            runtimeNamespace,
            tui,
          });
        },
        startCanonicalDaemon: async () => {
          daemon = await startOwnedProductRigDaemon({
            start: () => startDaemon(fleet),
            publish,
            waitUntilReady: waitForReadinessLadder,
          });
          return daemon;
        },
        openCanonicalWorkspace: async (namespace, runningDaemon) => {
          const workspace = await runningDaemon.promote(namespace.session);
          const identity = await observeTargetedCanonicalIdentity(
            runningDaemon,
            namespace.session,
            workspace,
          );
          const resizeBaseline = await validateExactResizeTmuxBaseline(state, namespace.session, {
            marker: namespace.marker,
            paneId: namespace.seed.paneId,
          });
          publish({
            workspace,
            daemon: {
              ...runningDaemon.record,
              revision: identity.catalogRevision,
              revisionKind: "fleet-catalog",
            },
          });
          event("resize-daemon-ready", { ...identity, resizeBaseline });
          return identity;
        },
        buildBeforeMeasurement: async () => {
          await execFileAsync("bun", [join(repoRoot, "scripts", "build-tui.mjs")], {
            cwd: repoRoot,
            timeout: 120_000,
          });
          prepareIsolatedTargetedTuiCwd(state.tui.runtimeDir);
          event("resize-tui-build", {});
        },
        launchResizeTui: async (namespace) => {
          const launched = JSON.parse(
            await tuiCommandAsync(
              state,
              ["start", "--target", namespace.session, "--cols", "160", "--rows", "44", "--json"],
              { timeout: 30_000, signal: ownerAbort.signal },
            ),
          );
          if (
            !exactProductTuiLaunchReceipt(launched, {
              target: namespace.session,
              cols: 160,
              rows: 44,
            })
          )
            throw new Error("resize TUI launch receipt was invalid");
          const controller = new AbortController();
          const abort = () => controller.abort();
          ownerAbort.signal.addEventListener("abort", abort, { once: true });
          resizeReadiness = {
            launched,
            controller,
            startedAt: performance.now(),
            deadlineMs: 50_000,
            timer: setTimeout(() => controller.abort(), 50_000),
            detach: () => ownerAbort.signal.removeEventListener("abort", abort),
          };
          event("resize-tui-started", { processId: launched.processId });
          return launched;
        },
        waitForResizeHostReady: async (_namespace, _daemon, _identity, launched) => {
          if (!resizeReadiness || resizeReadiness.launched !== launched)
            throw new Error("resize readiness owner was unavailable");
          const host = await waitForExactFocusHostReceipt(state, launched, {
            deadlineMs: 10_000,
            signal: resizeReadiness.controller.signal,
          });
          event("resize-host-ready", { processId: launched.processId });
          return host;
        },
        waitForResizeTuiCoherent: async (_namespace, _daemon, _identity, launched, host) => {
          const readiness = resizeReadiness;
          if (!readiness || readiness.launched !== launched)
            throw new Error("resize readiness owner was unavailable");
          try {
            await waitForCoherentTui(
              state,
              30_000,
              launched.processId,
              host,
              readiness.controller.signal,
            );
            await waitForExactFocusHostReceipt(state, launched, {
              deadlineMs: Math.max(
                1,
                readiness.deadlineMs - (performance.now() - readiness.startedAt),
              ),
              signal: readiness.controller.signal,
            });
          } finally {
            clearTimeout(readiness.timer);
            readiness.detach();
            readiness.controller.abort();
            resizeReadiness = null;
          }
          event("resize-tui-coherent", { processId: launched.processId });
          return Object.freeze({ processId: launched.processId, launchId: launched.launchId });
        },
        proveResizeBaseline: async (namespace, runningDaemon, identity, process) => {
          const publication = await provePreseededPanePublication(state, {
            marker: namespace.marker,
            paneId: namespace.seed.paneId,
            geometry: namespace.seed,
          });
          const shell = await waitForProductApplicationShell(
            runningDaemon,
            namespace.session,
            (candidate) => productWindowResources(candidate).length === 2,
            10_000,
            2,
          );
          const resources = productWindowResources(shell);
          const panes = await readExactResizeTmuxPanes(state);
          const active = panes.find(({ active }) => active);
          const selected = resources.find(
            ({ semanticPaneId }) => semanticPaneId === active?.semanticPaneId,
          );
          if (!active || !selected || resources.filter(({ active }) => active).length !== 1)
            throw new Error("resize baseline did not join exact active pane");
          const clientId = `opentui:${process.processId}`;
          const workspaceClient = await waitForQualifiedWorkspaceClientState(
            () => readJsonLines(join(namespace.tui.runtimeDir, "performance.jsonl")),
            {
              processId: clientId,
              daemonGeneration: runningDaemon.record.instanceId,
              workspaceName: identity.workspaceName,
              sessionName: identity.sessionName,
              fleetSessionId: identity.fleetSessionId,
              semanticPaneId: selected.semanticPaneId,
              canonicalGeneration: publication.canonicalSeedPaint.publication.generation,
            },
          );
          const baseline = Object.freeze({
            processId: clientId,
            daemonGeneration: runningDaemon.record.instanceId,
            clientGeneration: workspaceClient.committed.generation,
            workspaceName: identity.workspaceName,
            sessionName: identity.sessionName,
            semanticPaneId: selected.semanticPaneId,
            clientId,
            resources,
            selected,
            panes,
            publication,
            workspaceClient,
            terminalResourceRevision: workspaceClient.committed.terminalResourceRevision,
          });
          event("resize-baseline", { panes: panes.length });
          return baseline;
        },
        driveKeyboardResize: async (_namespace, runningDaemon, _identity, _process, baseline) => {
          const lifecycleBefore = readJsonLines(
            join(state.tui.runtimeDir, "performance.jsonl"),
          ).length;
          const watermark = windowWorkspaceEvidenceWatermark(
            state,
            baseline.processId,
            baseline.daemonGeneration,
          );
          const tmuxBefore = await readExactResizeTmuxPanes(state);
          const targetBefore = tmuxBefore.find(
            ({ semanticPaneId }) => semanticPaneId === baseline.semanticPaneId,
          );
          const delivery = await driveExactResizeInput(
            state,
            {
              version: 1,
              kind: "modified-key",
              key: "right",
              modifiers: ["meta"],
              timeoutMs: 2_000,
            },
            ownerAbort.signal,
          );
          if (delivery.requestedKey !== "right" || delivery.requestedModifiers?.[0] !== "meta")
            throw new Error("resize Meta+Right delivery receipt was invalid");
          const found = await waitForResizeLifecycleRecord(
            state,
            (record) =>
              record?.phase === "pane-resize-fence" &&
              record.source === "keyboard" &&
              record.semanticPaneId === baseline.semanticPaneId,
            lifecycleBefore,
          );
          const joined = exactResizeFence(
            found.records.slice(lifecycleBefore),
            found.record.operationId,
            baseline.semanticPaneId,
          );
          const tmuxAfter = await readExactResizeTmuxPanes(state);
          const targetAfter = tmuxAfter.find(
            ({ semanticPaneId }) => semanticPaneId === baseline.semanticPaneId,
          );
          if (!targetBefore || !targetAfter || targetAfter.cols !== targetBefore.cols + 1)
            throw new Error("Meta+Right did not resize the exact active pane by one cell");
          const shell = await waitForProductApplicationShell(
            runningDaemon,
            baseline.sessionName,
            (candidate) => productWindowResources(candidate).length === 2,
            10_000,
            2,
          );
          const resources = productWindowResources(shell);
          const workspaceClient = await waitForWindowWorkspaceEvidence(state, {
            processId: baseline.processId,
            daemonGeneration: baseline.daemonGeneration,
            clientGeneration: baseline.clientGeneration,
            clientId: baseline.clientId,
            workspaceName: baseline.workspaceName,
            sessionName: baseline.sessionName,
            afterMicros: watermark + 1,
            boundary: "resize-keyboard-proved",
            resources,
            web: false,
            exactTerminalResourceRevision: baseline.terminalResourceRevision,
            receipt: {
              operationId: found.record.operationId,
              operationKind: "workspace.pane.resize",
              semanticPaneId: baseline.semanticPaneId,
            },
          });
          const evidence = Object.freeze({
            ...resizeIdentityEvidence(baseline),
            source: "keyboard",
            operationId: found.record.operationId,
            axis: "cols",
            beforeCells: targetBefore.cols,
            requestedCells: targetBefore.cols + 1,
            settledCells: targetAfter.cols,
            receipt: Object.freeze({
              operationId: found.record.operationId,
              verb: "workspace.pane.resize",
              axis: found.record.axis,
              requestedCells: found.record.requestedCells,
              outcome: joined.receipt.receiptOutcome,
              cells: joined.receipt.receiptCells,
            }),
            layout: Object.freeze({
              operationId: found.record.operationId,
              cells: joined.layout.layoutCells,
            }),
            frame: Object.freeze({
              operationId: found.record.operationId,
              identityExact: joined.settled.identityLineageExact,
              presentationChanged: joined.settled.presentationChanged,
              presentationDigest: joined.settled.presentationDigest,
            }),
            fence: Object.freeze({ writerHealth: joined.fence.writerHealth }),
            tmux: tmuxAfter,
            workspaceClient,
            delivery,
          });
          event("resize-keyboard-proved", { axis: "cols" });
          return evidence;
        },
        drivePointerPreviews: async (
          _namespace,
          _daemon,
          _identity,
          _process,
          baseline,
          keyboard,
        ) => {
          const panes = keyboard.tmux;
          const left = panes.slice().sort((a, b) => a.left - b.left)[0];
          const right = panes.slice().sort((a, b) => a.left - b.left)[1];
          if (!left || !right || right.left !== left.left + left.cols + 1)
            throw new Error("resize baseline had no exact vertical separator");
          const x = 28 + left.left + left.cols;
          const y =
            2 + Math.floor(Math.max(left.top, right.top) + Math.min(left.rows, right.rows) / 2);
          const down = await driveExactResizeInput(
            state,
            {
              version: 1,
              kind: "application-mouse",
              action: "down",
              x,
              y,
              timeoutMs: 2_000,
            },
            ownerAbort.signal,
          );
          if (down.requestedAction !== "down")
            throw new Error("resize pointer-down delivery receipt was invalid");
          const samples = [];
          let lastX = x;
          for (let ordinal = 0; ordinal < 30; ordinal += 1) {
            lastX = x + 1 + (ordinal % 2);
            const baselineCount = readJsonLines(
              join(state.tui.runtimeDir, "performance.jsonl"),
            ).length;
            const delivery = await driveExactResizeInput(
              state,
              {
                version: 1,
                kind: "application-mouse",
                action: "drag",
                x: lastX,
                y,
                timeoutMs: 2_000,
              },
              ownerAbort.signal,
            );
            if (delivery.requestedAction !== "drag")
              throw new Error("resize pointer-drag delivery receipt was invalid");
            const settled = await waitForResizeLifecycleRecord(
              state,
              (record) =>
                record?.phase === "resize-guide-settled" &&
                record.semanticPaneId === baseline.semanticPaneId,
              baselineCount,
              2_000,
            );
            const record = settled.record;
            const fences = settled.records
              .slice(baselineCount)
              .filter(
                (candidate) =>
                  candidate?.phase === "resize-guide-fence" && candidate.traceId === record.traceId,
              );
            if (
              fences.length !== 1 ||
              record.identityExact !== true ||
              record.presentationChanged !== true ||
              !/^[0-9a-f]{64}$/u.test(record.presentationDigest ?? "")
            )
              throw new Error("resize guide actual-frame evidence was not exact");
            if (!Number.isSafeInteger(record.durationMicros) || record.durationMicros < 0)
              throw new Error("resize guide duration was unavailable");
            const captureEnvelope = JSON.parse(
              await tuiCommandAsync(state, ["capture", "--ansi", "--json"], {
                timeout: 1_500,
                signal: ownerAbort.signal,
              }),
            );
            const capture = decodeFocusFramebufferCapture(captureEnvelope);
            const framebuffer = inspectResizeGuideFramebuffer({
              plain: capture.plain,
              cols: capture.cols,
              rows: capture.rows,
              guide: record.guide,
              axis: record.axis,
            });
            if (
              framebuffer.exact !== true ||
              captureEnvelope.hostIdentity?.paneId !== delivery.paneId ||
              captureEnvelope.hostIdentity?.sessionId !== delivery.sessionId ||
              captureEnvelope.hostIdentity?.cols !== delivery.geometry.cols ||
              captureEnvelope.hostIdentity?.rows !== delivery.geometry.rows
            )
              throw new Error("resize guide framebuffer cells were not exact");
            samples.push(
              Object.freeze({
                ordinal,
                traceId: record.traceId,
                ...resizeIdentityEvidence(baseline),
                axis: record.axis,
                cells: record.cells,
                durationMs: record.durationMicros / 1_000,
                guide: Object.freeze({
                  ...record.guide,
                  digest: record.guideDigest,
                }),
                actualFrame: Object.freeze({
                  traceId: record.traceId,
                  guideDigest: record.guideDigest,
                  presentationDigest: record.presentationDigest,
                  presentationChanged: record.presentationChanged,
                  identityExact: record.identityExact,
                  framebuffer,
                }),
                fence: Object.freeze({ writerHealth: fences[0].writerHealth }),
                delivery,
                pointerIngress: record.pointerIngress,
              }),
            );
          }
          activeDrag = Object.freeze({ x: lastX, y, beforeCells: left.cols });
          event("resize-pointer-preview-distribution", { samples: samples.length });
          return Object.freeze(samples);
        },
        drivePointerRelease: async (
          _namespace,
          runningDaemon,
          _identity,
          _process,
          baseline,
          keyboard,
        ) => {
          if (!activeDrag) throw new Error("resize pointer drag ownership was unavailable");
          const lifecycleBefore = readJsonLines(
            join(state.tui.runtimeDir, "performance.jsonl"),
          ).length;
          const watermark = windowWorkspaceEvidenceWatermark(
            state,
            baseline.processId,
            baseline.daemonGeneration,
          );
          const delivery = await driveExactResizeInput(
            state,
            {
              version: 1,
              kind: "application-mouse",
              action: "up",
              x: activeDrag.x,
              y: activeDrag.y,
              timeoutMs: 2_000,
            },
            ownerAbort.signal,
          );
          if (delivery.requestedAction !== "up")
            throw new Error("resize pointer-up delivery receipt was invalid");
          activeDrag = null;
          const found = await waitForResizeLifecycleRecord(
            state,
            (record) =>
              record?.phase === "pane-resize-fence" &&
              record.source === "pointer" &&
              record.semanticPaneId === baseline.semanticPaneId,
            lifecycleBefore,
          );
          const joined = exactResizeFence(
            found.records.slice(lifecycleBefore),
            found.record.operationId,
            baseline.semanticPaneId,
          );
          const tmux = await readExactResizeTmuxPanes(state);
          const target = tmux.find(
            ({ semanticPaneId }) => semanticPaneId === baseline.semanticPaneId,
          );
          if (!target || target.cols !== joined.receipt.receiptCells)
            throw new Error("pointer release did not join exact tmux geometry");
          const shell = await waitForProductApplicationShell(
            runningDaemon,
            baseline.sessionName,
            (candidate) => productWindowResources(candidate).length === 2,
            10_000,
            2,
          );
          const resources = productWindowResources(shell);
          const workspaceClient = await waitForWindowWorkspaceEvidence(state, {
            processId: baseline.processId,
            daemonGeneration: baseline.daemonGeneration,
            clientGeneration: baseline.clientGeneration,
            clientId: baseline.clientId,
            workspaceName: baseline.workspaceName,
            sessionName: baseline.sessionName,
            afterMicros: watermark + 1,
            boundary: "resize-pointer-release-proved",
            resources,
            web: false,
            exactTerminalResourceRevision: baseline.terminalResourceRevision,
            receipt: {
              operationId: found.record.operationId,
              operationKind: "workspace.pane.resize",
              semanticPaneId: baseline.semanticPaneId,
            },
          });
          const evidence = Object.freeze({
            ...resizeIdentityEvidence(baseline),
            source: "pointer",
            operationId: found.record.operationId,
            axis: "cols",
            beforeCells: found.record.beforeCells,
            requestedCells: found.record.requestedCells,
            settledCells: target.cols,
            receipt: Object.freeze({
              operationId: found.record.operationId,
              verb: "workspace.pane.resize",
              axis: found.record.axis,
              requestedCells: found.record.requestedCells,
              outcome: joined.receipt.receiptOutcome,
              cells: joined.receipt.receiptCells,
            }),
            layout: Object.freeze({
              operationId: found.record.operationId,
              cells: joined.layout.layoutCells,
            }),
            frame: Object.freeze({
              operationId: found.record.operationId,
              identityExact: joined.settled.identityLineageExact,
              presentationChanged: joined.settled.presentationChanged,
              presentationDigest: joined.settled.presentationDigest,
            }),
            fence: Object.freeze({ writerHealth: joined.fence.writerHealth }),
            resources,
            workspaceClient,
            tmux,
            geometryStable: resizeTmuxGeometryExact(
              keyboard.tmux,
              tmux,
              baseline.semanticPaneId,
              target.cols,
            ),
            delivery,
            pointerIngress: joined.settled.pointerIngress,
          });
          event("resize-pointer-release-proved", { axis: "cols" });
          return evidence;
        },
        startWebAfterResize: async (
          _namespace,
          runningDaemon,
          identity,
          _process,
          baseline,
          _keyboard,
          release,
        ) => {
          const watermark = windowWorkspaceEvidenceWatermark(
            state,
            baseline.processId,
            baseline.daemonGeneration,
          );
          devServer = await startDevServer(runningDaemon, {
            daemonInfoPath: join(fleet.daemonInfoDir, "daemon.json"),
          });
          browser = await chromium.launch({ headless: true });
          const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
          const page = await context.newPage();
          await page.goto(devServer.pageUrl, { waitUntil: "domcontentloaded" });
          const ready = await waitForFocusWebSemantic({
            signal: ownerAbort.signal,
            health: () =>
              ownerAbort.signal.aborted
                ? "aborted"
                : !devServer.isRunning()
                  ? "dev-server-dead"
                  : !browser.isConnected()
                    ? "browser-disconnected"
                    : page.isClosed()
                      ? "page-closed"
                      : null,
            sample: () => page.evaluate(captureFocusWebSemanticDocument),
            derivedResources: release.workspaceClient.derived.terminalInventory.resources,
            expectedWorkspaceName: identity.workspaceName,
            expectedSemanticPaneId: baseline.semanticPaneId,
            expectedDaemonGeneration: runningDaemon.record.instanceId,
          });
          if (ready.semantic.windowNodeCount !== 1 || ready.semantic.terminalNodeCount !== 1)
            throw new Error("resize Web semantic did not retain one tiled two-pane window");
          const workspaceClient = await waitForWindowWorkspaceEvidence(state, {
            processId: baseline.processId,
            daemonGeneration: baseline.daemonGeneration,
            clientGeneration: baseline.clientGeneration,
            clientId: baseline.clientId,
            workspaceName: baseline.workspaceName,
            sessionName: baseline.sessionName,
            afterMicros: watermark + 1,
            boundary: "resize-web-correlation",
            resources: release.resources,
            web: true,
            exactTerminalResourceRevision: baseline.terminalResourceRevision,
          });
          publish({ web: { pageUrl: devServer.pageUrl, startedAfterResizeBoundary: true } });
          event("resize-web-correlation", { windows: ready.semantic.windowNodeCount });
          return Object.freeze({
            semantic: ready.semantic,
            readiness: ready.assessment,
            workspaceClient,
            correlation: Object.freeze({
              daemon: true,
              workspaceClient: true,
              tui: true,
              web: true,
              tmux: true,
            }),
          });
        },
      });
      const pointerRelease = resizeBoot.pointerRelease;
      const journeyEvidence = Object.freeze({
        expected: Object.freeze({
          processId: resizeBoot.baseline.processId,
          daemonGeneration: resizeBoot.baseline.daemonGeneration,
          clientGeneration: resizeBoot.baseline.clientGeneration,
          workspaceName: resizeBoot.baseline.workspaceName,
          sessionName: resizeBoot.baseline.sessionName,
          fleetSessionId: resizeBoot.identity.fleetSessionId,
          catalogRevision: resizeBoot.identity.catalogRevision,
          semanticPaneId: resizeBoot.baseline.semanticPaneId,
        }),
        baseline: resizeIdentityEvidence(resizeBoot.baseline),
        keyboard: resizeBoot.keyboard,
        pointerPreviews: resizeBoot.pointerPreviews,
        pointerRelease,
        tmux: Object.freeze({
          semanticPaneId: resizeBoot.baseline.semanticPaneId,
          [pointerRelease.axis]: pointerRelease.settledCells,
          geometryStable: pointerRelease.geometryStable,
        }),
        workspaceClient: Object.freeze({
          pendingCount: pointerRelease.workspaceClient.pending.length,
          semanticPaneId: resizeBoot.baseline.semanticPaneId,
          lastReceiptOperationId:
            pointerRelease.workspaceClient.committed.lastReceipt?.operationId ?? null,
          lastReceiptPhase: pointerRelease.workspaceClient.committed.lastReceipt?.phase ?? null,
        }),
        correlation: resizeBoot.web.correlation,
        web: resizeBoot.web,
      });
      const assessment = assessProductKeyboardPointerResize({
        evidence: journeyEvidence,
        expected: journeyEvidence.expected,
      });
      if (!assessment.qualified) {
        const error = new Error("keyboard/pointer resize causal assessment failed");
        error.boundary = "resize-causal-proof";
        error.observation = Object.freeze({
          operation: "keyboard-pointer-resize-assessment",
          firstFailedPredicate: assessment.firstFailedPredicate,
          sampleCount: assessment.metrics.sampleCount,
          previewP95Ms: assessment.metrics.previewP95Ms,
        });
        throw error;
      }
      publish({
        convergence: { workspaceClient: resizeBoot.web.workspaceClient },
        journeyEvidence: { keyboardPointerResize: journeyEvidence },
        status: "ready",
        readyAt: new Date().toISOString(),
      });
      await new Promise(() => undefined);
      return;
    }
    if (journeyId === "window-lifecycle") {
      let windowReadiness = null;
      const windowBoot = await runWindowLifecycleOwnerBoot({
        onBoundary: (boundary) =>
          publish({
            currentJourneyBoundary: boundary,
            currentJourneyBoundaryAtWallMs: Date.now(),
            currentJourneyBoundaryAtMonotonicMs: performance.now(),
          }),
        createWindowNamespace: async () => {
          const marker = `RIG_WINDOW_${randomBytes(6).toString("hex").toUpperCase()}`;
          const daemonPerformanceTracePath = join(
            rigRoot,
            "window-lifecycle-daemon-performance.jsonl",
          );
          const scratchFleet = await createScratchFleet({
            sessions: 1,
            slug,
            initialPaneMarker: marker,
            windowsPerSession: 1,
          });
          const cleanupToken = `product-test-rig:${slug}`;
          fleet = {
            ...scratchFleet,
            environment: {
              ...scratchFleet.environment,
              TMUX_IDE_RUNTIME_MODE: "testdrive",
              TMUX_IDE_CLEANUP_TOKEN: cleanupToken,
              TMUX_IDE_TMUX_SOCKET_PATH: scratchFleet.socketPath,
              TMUX_IDE_SESSION_RUNTIME_TRACE_LOG: daemonPerformanceTracePath,
            },
          };
          const session = fleet.sessionNames[0];
          const initialPane = fleet.initialPanes.find((pane) => pane.sessionName === session);
          if (!initialPane) throw new Error("window namespace lost its exact initial pane");
          const initialWindows = fleet.listWindows(session);
          const initialPaneCount = fleet.countPanes(session);
          const initialWindow = fleet.currentWindow(session);
          if (
            initialWindows.length !== 1 ||
            initialWindows[0] !== "one" ||
            initialWindow !== "one" ||
            initialPaneCount !== 1
          ) {
            const error = new Error("window namespace did not start with exactly one window/pane");
            error.boundary = "window-namespace-ready";
            error.observation = Object.freeze({
              operation: "window-namespace-cardinality",
              reason: "unexpected-initial-cardinality",
              expectedWindowCount: 1,
              actualWindowCount: Math.min(initialWindows.length, 3),
              expectedPaneCount: 1,
              actualPaneCount: Math.min(initialPaneCount, 3),
              selectedWindowMatched: initialWindow === "one",
            });
            throw error;
          }
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
          const tui = prepareOwnedTuiRuntime({
            ownership: { session, runtimeNamespace },
            intendedTui: {
              hostSession: `_tmux-ide-product-rig-${slug}`,
              runtimeDir: join(rigRoot, "tui-window-lifecycle"),
              performanceTracePath: join(
                rigRoot,
                "tui-window-lifecycle",
                "performance-trace.jsonl",
              ),
              performanceTraceDetail: "1",
              daemonPerformanceTracePath,
            },
            publish,
            resolveProvenance: sourceTraceProvenance,
            createRuntimeDir: createIsolatedTargetedTuiCwd,
          });
          event("window-namespace-ready", {
            paneId: initialPane.paneId,
            windows: initialWindows.length,
            panes: initialPaneCount,
          });
          return Object.freeze({
            session,
            seed: { marker, paneId: initialPane.paneId, geometry: initialPane },
            runtimeNamespace,
            tui,
          });
        },
        startCanonicalDaemon: async () => {
          daemon = await startOwnedProductRigDaemon({
            start: () => startDaemon(fleet),
            publish,
            waitUntilReady: waitForReadinessLadder,
          });
          return daemon;
        },
        openCanonicalWorkspace: async (namespace, runningDaemon) => {
          const workspace = await runningDaemon.promote(namespace.session);
          const identity = await observeTargetedCanonicalIdentity(
            runningDaemon,
            namespace.session,
            workspace,
          );
          publish({
            workspace,
            daemon: {
              ...runningDaemon.record,
              revision: identity.catalogRevision,
              revisionKind: "fleet-catalog",
            },
          });
          event("window-daemon-ready", identity);
          return identity;
        },
        buildBeforeMeasurement: async () => {
          await execFileAsync("bun", [join(repoRoot, "scripts", "build-tui.mjs")], {
            cwd: repoRoot,
            timeout: 120_000,
          });
          prepareIsolatedTargetedTuiCwd(state.tui.runtimeDir);
          event("window-tui-build", {});
        },
        launchWindowTui: async (namespace) => {
          const launchStartedAt = performance.now();
          let launched;
          try {
            launched = JSON.parse(
              await tuiCommandAsync(
                state,
                ["start", "--target", namespace.session, "--cols", "160", "--rows", "44", "--json"],
                { timeout: 30_000 },
              ),
            );
          } catch (cause) {
            const error = new Error("window lifecycle TUI launch failed", { cause });
            error.boundary = "window-tui-started";
            error.observation = Object.freeze({
              ...focusHostReadinessObservation(state, {
                reason: "identity-invalid",
                attempts: 0,
                startedAt: launchStartedAt,
                deadlineMs: 30_000,
                stage: "launch",
              }),
              operation: "window-tui-started",
            });
            throw error;
          }
          if (
            !exactProductTuiLaunchReceipt(launched, {
              target: namespace.session,
              cols: 160,
              rows: 44,
            })
          ) {
            const error = new Error("window lifecycle TUI launch receipt was invalid");
            error.boundary = "window-tui-started";
            error.observation = Object.freeze({
              ...focusHostReadinessObservation(state, {
                reason: "identity-invalid",
                attempts: 0,
                startedAt: launchStartedAt,
                deadlineMs: 30_000,
                stage: "launch-receipt",
              }),
              operation: "window-tui-started",
            });
            throw error;
          }
          const startedAt = performance.now();
          const deadlineMs = 50_000;
          const controller = new AbortController();
          windowReadiness = {
            launched,
            startedAt,
            deadlineMs,
            controller,
            timer: setTimeout(() => controller.abort(), deadlineMs),
          };
          event("window-tui-started", { processId: launched.processId });
          return launched;
        },
        waitForWindowHostReady: async (_namespace, _daemon, _identity, launched) => {
          const readiness = windowReadiness;
          if (!readiness || readiness.launched !== launched)
            throw new Error("window readiness lifecycle was not initialized");
          let status;
          try {
            status = await waitForExactFocusHostReceipt(state, launched, {
              deadlineMs: Math.min(
                10_000,
                Math.max(1, readiness.deadlineMs - (performance.now() - readiness.startedAt)),
              ),
              signal: readiness.controller.signal,
            });
          } catch (error) {
            clearTimeout(readiness.timer);
            readiness.controller.abort();
            windowReadiness = null;
            error.boundary = "window-host-ready";
            if (error.observation)
              error.observation = Object.freeze({
                ...error.observation,
                operation: "window-host-ready",
              });
            throw error;
          }
          event("window-host-ready", { processId: launched.processId });
          return status;
        },
        waitForWindowTuiCoherent: async (_namespace, _daemon, _identity, launched, host) => {
          const readiness = windowReadiness;
          if (!readiness || readiness.launched !== launched)
            throw new Error("window readiness lifecycle was not initialized");
          try {
            const remaining = Math.max(
              1,
              Math.min(30_000, readiness.deadlineMs - (performance.now() - readiness.startedAt)),
            );
            await waitForCoherentTui(
              state,
              remaining,
              launched.processId,
              host,
              readiness.controller.signal,
            );
            await waitForExactFocusHostReceipt(state, launched, {
              deadlineMs: Math.max(
                1,
                readiness.deadlineMs - (performance.now() - readiness.startedAt),
              ),
              signal: readiness.controller.signal,
            });
          } catch (error) {
            error.boundary = "window-tui-coherent";
            error.observation = Object.freeze({
              ...(error.observation ?? {}),
              operation: "window-tui-coherent",
              stage: "post-frame-host-revalidation",
            });
            throw error;
          } finally {
            clearTimeout(readiness.timer);
            readiness.controller.abort();
            windowReadiness = null;
          }
          event("window-tui-coherent", { processId: launched.processId });
          return Object.freeze({
            processId: launched.processId,
            launchId: launched.launchId,
            hostIdentity: launched.hostIdentity,
          });
        },
        proveWindowBaseline: async (namespace, runningDaemon, identity, process) => {
          const publication = await provePreseededPanePublication(state, namespace.seed);
          const shell = await waitForProductApplicationShell(
            runningDaemon,
            namespace.session,
            (candidate) => productWindowResources(candidate).length === 1,
            10_000,
            1,
          );
          const shellResources = productWindowResources(shell);
          const shellSelected = shellResources[0];
          if (!shellSelected || shellSelected.semanticPaneId !== publication.semanticPaneId)
            throw new Error("window baseline resource did not match the canonical pane");
          const clientId = `opentui:${process.processId}`;
          const workspaceClient = await waitForQualifiedWorkspaceClientState(
            () => readJsonLines(join(namespace.tui.runtimeDir, "performance.jsonl")),
            {
              processId: clientId,
              daemonGeneration: runningDaemon.record.instanceId,
              workspaceName: identity.workspaceName,
              sessionName: identity.sessionName,
              fleetSessionId: identity.fleetSessionId,
              semanticPaneId: shellSelected.semanticPaneId,
              canonicalGeneration: publication.canonicalSeedPaint.publication.generation,
            },
          );
          const owners = workspaceClient.committed.authority?.owners;
          if (!["input", "focus", "geometry"].every((kind) => owners?.[kind] === clientId))
            throw new Error("window baseline did not own all authorities");
          if (!Number.isSafeInteger(workspaceClient.committed.terminalResourceRevision))
            throw new Error("window baseline terminal resource revision was unavailable");
          const tmux = await exactWindowTmuxSnapshot(state, shellResources);
          const windows = joinWindowResourcesToTmuxLabels(shellResources, tmux);
          const selected = windows[0];
          const baseline = Object.freeze({
            processId: `opentui:${process.processId}`,
            daemonGeneration: runningDaemon.record.instanceId,
            clientGeneration: workspaceClient.committed.generation,
            clientId,
            workspaceName: identity.workspaceName,
            sessionName: identity.sessionName,
            windows,
            selected,
            publication,
            terminalResourceRevision: workspaceClient.committed.terminalResourceRevision,
            workspaceClient,
            tmux,
          });
          event("window-baseline", { semanticPaneId: selected.semanticPaneId });
          return baseline;
        },
        createWindow: async (namespace, runningDaemon, _identity, _process, baseline) => {
          const watermark = windowWorkspaceEvidenceWatermark(
            state,
            baseline.processId,
            baseline.daemonGeneration,
          );
          const operationId = randomUUID();
          const receipt = await dispatchOwnedProductAction(
            runningDaemon,
            "workspace.pane.create",
            operationId,
            {
              kind: "terminal",
              workspaceName: baseline.workspaceName,
              displayTitle: "Lifecycle Two",
              placement: { kind: "window" },
            },
            baseline.clientId,
          );
          if (
            receipt.outcome !== "created" ||
            receipt.resource?.kind !== "terminal" ||
            receipt.resource?.workspaceName !== baseline.workspaceName ||
            receipt.resource?.displayTitle !== "Lifecycle Two"
          )
            throw invalidOwnedProductActionResult("workspace.pane.create", operationId, receipt);
          const shell = await waitForProductApplicationShell(
            runningDaemon,
            namespace.session,
            (candidate) => productWindowResources(candidate).length === 2,
            10_000,
            2,
          );
          const shellResources = productWindowResources(shell);
          const shellSelected = shellResources.find(
            ({ semanticPaneId }) => semanticPaneId === receipt.resource.semanticPaneId,
          );
          if (!shellSelected) throw new Error("created window was absent from application-shell");
          const workspaceClient = await waitForWindowWorkspaceEvidence(state, {
            processId: baseline.processId,
            daemonGeneration: baseline.daemonGeneration,
            clientGeneration: baseline.clientGeneration,
            clientId: baseline.clientId,
            workspaceName: baseline.workspaceName,
            sessionName: baseline.sessionName,
            afterMicros: watermark + 1,
            boundary: "window-create-proved",
            resources: shellResources,
            web: false,
            minimumTerminalResourceRevision: baseline.terminalResourceRevision + 1,
          });
          const expectedTmuxWindows = shellResources.map((window) => ({
            ...window,
            name:
              window.semanticPaneId === shellSelected.semanticPaneId
                ? receipt.resource.displayTitle
                : baseline.windows.find(
                    ({ semanticPaneId }) => semanticPaneId === window.semanticPaneId,
                  )?.name,
          }));
          const tmux = await exactWindowTmuxSnapshot(state, expectedTmuxWindows);
          const windows = joinWindowResourcesToTmuxLabels(shellResources, tmux);
          const selected = windows.find(
            ({ semanticPaneId }) => semanticPaneId === shellSelected.semanticPaneId,
          );
          if (!selected) throw new Error("created window label did not join application-shell");
          event("window-create-proved", { operationId, semanticPaneId: selected.semanticPaneId });
          return Object.freeze({
            ...baseline,
            windows,
            selected,
            terminalResourceRevision: workspaceClient.committed.terminalResourceRevision,
            workspaceClient,
            tmux,
            operationId,
            actionResult: receipt,
          });
        },
        primeCreatedWindow: async (
          namespace,
          runningDaemon,
          _identity,
          _process,
          baseline,
          created,
        ) => {
          const tracePath = join(namespace.tui.runtimeDir, "performance.jsonl");
          const watermark = windowWorkspaceEvidenceWatermark(
            state,
            baseline.processId,
            baseline.daemonGeneration,
          );
          const { delivery, settled, fence, renderWork, phaseTiming } =
            await driveExactHostedWindowSwitch(state, tracePath, new Set(), {
              boundary: "window-switch-visible",
              signal: ownerAbort.signal,
            });
          if (settled.paneId !== created.selected.semanticPaneId)
            throw new Error("first hosted switch did not select the detached created window");
          const primedWindows = created.windows.map((window) => ({
            ...window,
            active: window.resourceId === created.selected.resourceId,
          }));
          const shell = await waitForProductApplicationShell(
            runningDaemon,
            namespace.session,
            (candidate) =>
              productWindowResourcesExactlyMatch(productWindowResources(candidate), primedWindows),
            10_000,
            2,
          );
          const shellResources = productWindowResources(shell);
          const workspaceClient = await waitForWindowWorkspaceEvidence(state, {
            processId: baseline.processId,
            daemonGeneration: baseline.daemonGeneration,
            clientGeneration: baseline.clientGeneration,
            clientId: baseline.clientId,
            workspaceName: baseline.workspaceName,
            sessionName: baseline.sessionName,
            afterMicros: watermark + 1,
            boundary: "window-switch-visible",
            resources: shellResources,
            web: false,
            minimumTerminalResourceRevision: created.terminalResourceRevision,
            receipt: {
              operationId: settled.traceId,
              operationKind: "workspace.pane.select",
              semanticPaneId: created.selected.semanticPaneId,
            },
          });
          const tmux = await exactWindowTmuxSnapshot(state, primedWindows);
          event("window-switch-visible", { traceId: settled.traceId });
          return Object.freeze({
            processId: baseline.processId,
            daemonGeneration: baseline.daemonGeneration,
            clientGeneration: baseline.clientGeneration,
            workspaceName: baseline.workspaceName,
            sessionName: baseline.sessionName,
            traceId: settled.traceId,
            operationId: settled.traceId,
            selectionApplied: settled.selectionApplied,
            canonicalIdentity: Object.freeze({
              sourceEpoch: settled.sourceEpoch,
              generation: settled.generation,
              incarnation: settled.incarnation,
              revision: settled.revision,
              stateHash: settled.stateHash,
              cols: settled.cols,
              rows: settled.rows,
            }),
            targetResourceId: created.selected.resourceId,
            visibleFrame: Object.freeze({
              resourceId: created.selected.resourceId,
              semanticPaneId: created.selected.semanticPaneId,
            }),
            fence: Object.freeze({ traceId: fence.traceId, writerHealth: fence.writerHealth }),
            delivery,
            renderWork,
            phaseTiming,
            tmux,
            workspaceClient,
          });
        },
        driveWarmSwitches: async (
          namespace,
          _daemon,
          _identity,
          _process,
          baseline,
          created,
          renamed,
        ) => {
          const samples = [];
          const tracePath = join(namespace.tui.runtimeDir, "performance.jsonl");
          const seen = new Set(
            readJsonLines(tracePath)
              .filter((record) => record?.phase === "window-switch-settled")
              .map((record) => record.traceId)
              .filter((traceId) => typeof traceId === "string"),
          );
          for (let ordinal = 0; ordinal < 32; ordinal += 1) {
            publish({
              currentJourneyBoundary: "window-switch-distribution",
              windowSwitchOrdinalWatermark: ordinal,
              currentJourneyBoundaryAtWallMs: Date.now(),
              currentJourneyBoundaryAtMonotonicMs: performance.now(),
            });
            const { delivery, settled, fence, renderWork, phaseTiming } =
              await driveExactHostedWindowSwitch(state, tracePath, seen, {
                boundary: "window-switch-distribution",
                ordinal,
                signal: ownerAbort.signal,
              });
            const selected = renamed.windows.find(
              ({ semanticPaneId }) => semanticPaneId === settled.paneId,
            );
            if (!selected) throw new Error("window switch selected an unknown pane");
            const switchedWindows = renamed.windows.map((window) => ({
              ...window,
              active: window.resourceId === selected.resourceId,
            }));
            const tmux = await exactWindowTmuxSnapshot(state, switchedWindows);
            if (ordinal >= 2)
              samples.push(
                Object.freeze({
                  ordinal: ordinal - 2,
                  traceId: settled.traceId,
                  operationId: settled.traceId,
                  selectionApplied: settled.selectionApplied,
                  followUpRequested: settled.followUpRequested,
                  processId: baseline.processId,
                  daemonGeneration: baseline.daemonGeneration,
                  clientGeneration: baseline.clientGeneration,
                  workspaceName: baseline.workspaceName,
                  sessionName: baseline.sessionName,
                  targetResourceId: selected.resourceId,
                  visibleFrame: Object.freeze({
                    resourceId: selected.resourceId,
                    semanticPaneId: selected.semanticPaneId,
                  }),
                  fence: Object.freeze({
                    traceId: fence.traceId,
                    writerHealth: fence.writerHealth,
                  }),
                  delivery,
                  renderWork,
                  phaseTiming,
                  tmux,
                  durationMs: settled.durationMicros / 1_000,
                }),
              );
          }
          publish({
            currentJourneyBoundary: "window-switch-distribution",
            windowSwitchOrdinalWatermark: 32,
            currentJourneyBoundaryAtWallMs: Date.now(),
            currentJourneyBoundaryAtMonotonicMs: performance.now(),
          });
          event("window-switch-distribution", { samples: samples.length });
          return Object.freeze(samples);
        },
        renameWindow: async (
          namespace,
          runningDaemon,
          _identity,
          _process,
          baseline,
          created,
          primed,
        ) => {
          if (
            primed?.targetResourceId !== created.selected.resourceId ||
            primed?.visibleFrame?.semanticPaneId !== created.selected.semanticPaneId ||
            primed?.workspaceClient?.committed?.lastReceipt?.operationId !== primed?.traceId ||
            primed?.workspaceClient?.committed?.lastReceipt?.operationKind !==
              "workspace.pane.select" ||
            primed?.workspaceClient?.committed?.lastReceipt?.phase !== "observed" ||
            primed?.workspaceClient?.committed?.lastReceipt?.proof?.outcome !== "applied" ||
            !Number.isSafeInteger(primed?.workspaceClient?.record?.monotonicMicros) ||
            primed.workspaceClient.record.monotonicMicros <=
              created.workspaceClient.record.monotonicMicros
          )
            throw new Error("window rename lacked exact newer selected-pane convergence");
          const lifecycleBefore = readJsonLines(
            join(namespace.tui.runtimeDir, "performance.jsonl"),
          ).length;
          const referenceBefore = readJsonLines(namespace.tui.performanceTracePath).length;
          const watermark = windowWorkspaceEvidenceWatermark(
            state,
            baseline.processId,
            baseline.daemonGeneration,
          );
          const acknowledgementWatermark = windowResourceAcknowledgementWatermark(
            state,
            baseline.processId,
            baseline.daemonGeneration,
          );
          const operationId = randomUUID();
          const renamedName = "Lifecycle Renamed";
          let result;
          try {
            result = await dispatchOwnedProductAction(
              runningDaemon,
              "workspace.rename",
              operationId,
              {
                workspaceName: baseline.workspaceName,
                scope: "window",
                target: { by: "pane", semanticPaneId: created.selected.semanticPaneId },
                name: renamedName,
              },
              baseline.clientId,
            );
          } catch (error) {
            const expectedResources = created.windows.map((window) => ({
              ...window,
              active: window.resourceId === created.selected.resourceId,
            }));
            const [shellSnapshot, tmuxSnapshot] = await Promise.allSettled([
              productApplicationShell(runningDaemon, namespace.session),
              exactWindowTmuxSnapshot(state, expectedResources),
            ]);
            const shellResources =
              shellSnapshot.status === "fulfilled"
                ? productWindowResources(shellSnapshot.value)
                : [];
            const tmuxEvidence = classifyWindowTmuxPostFailureSnapshot(tmuxSnapshot);
            const bounded = new Error(error instanceof Error ? error.message : String(error), {
              cause: error,
            });
            bounded.observation = Object.freeze({
              ...(error?.observation ??
                ownedWindowActionFailureObservation({
                  action: "workspace.rename",
                  operationId,
                  status: null,
                  payload: null,
                })),
              postFailure: Object.freeze({
                applicationShellAvailable: shellSnapshot.status === "fulfilled",
                applicationShellResourceCount: Math.min(shellResources.length, 512),
                applicationShellExact:
                  shellSnapshot.status === "fulfilled" &&
                  productWindowResourcesExactlyMatch(shellResources, expectedResources),
                tmuxAvailable: tmuxEvidence.tmuxAvailable,
                tmuxWindowCount: tmuxEvidence.tmuxWindowCount,
                tmuxPreActionStateExact: tmuxEvidence.tmuxPreActionStateExact,
              }),
            });
            throw bounded;
          }
          if (
            result.outcome !== "applied" ||
            result.verb !== "workspace.rename" ||
            result.scope !== "window" ||
            result.name !== renamedName ||
            result.workspaceName !== baseline.workspaceName
          )
            throw invalidOwnedProductActionResult("workspace.rename", operationId, result);
          const renamedResources = created.windows.map((window) => ({
            ...window,
            resourceTitle:
              window.semanticPaneId === created.selected.semanticPaneId
                ? renamedName
                : window.resourceTitle,
            active: window.resourceId === created.selected.resourceId,
          }));
          const shell = await waitForProductApplicationShell(
            runningDaemon,
            namespace.session,
            (candidate) =>
              productWindowResourcesExactlyMatch(
                productWindowResources(candidate),
                renamedResources,
              ),
            10_000,
            2,
          );
          const shellResources = productWindowResources(shell);
          const shellSelected = shellResources.find(
            ({ semanticPaneId }) => semanticPaneId === created.selected.semanticPaneId,
          );
          if (!shellSelected?.active)
            throw new Error("renamed window was not the active selected window");
          const workspaceClient = await waitForWindowWorkspaceEvidence(state, {
            processId: baseline.processId,
            daemonGeneration: baseline.daemonGeneration,
            clientGeneration: baseline.clientGeneration,
            clientId: baseline.clientId,
            workspaceName: baseline.workspaceName,
            sessionName: baseline.sessionName,
            afterMicros: watermark + 1,
            boundary: "window-rename-visible",
            resources: shellResources,
            web: false,
            exactTerminalResourceRevision: created.terminalResourceRevision,
            acknowledgement: {
              daemonInstanceId: baseline.daemonGeneration,
              operationId,
              afterSequence: acknowledgementWatermark,
            },
          });
          const expectedTmuxWindows = shellResources.map((window) => ({
            ...window,
            name:
              window.semanticPaneId === shellSelected.semanticPaneId
                ? renamedName
                : created.windows.find(
                    ({ semanticPaneId }) => semanticPaneId === window.semanticPaneId,
                  )?.name,
          }));
          const tmux = await exactWindowTmuxSnapshot(state, expectedTmuxWindows);
          const windows = joinWindowResourcesToTmuxLabels(shellResources, tmux);
          const selected = windows.find(
            ({ semanticPaneId }) => semanticPaneId === shellSelected.semanticPaneId,
          );
          if (!selected) throw new Error("renamed tmux label did not join application-shell");
          const renamedTmuxWindow = tmux.find(
            (row) => row.semanticPaneId === selected.semanticPaneId,
          );
          if (!renamedTmuxWindow)
            throw new Error("renamed window lost its exact tmux semantic identity");
          const presentation = await waitForWindowRenameFence(state, {
            lifecycleBefore,
            referenceBefore,
            expected: {
              windowResourceId: renamedTmuxWindow.resourceId,
              semanticPaneId: selected.semanticPaneId,
              previousName: created.selected.name,
              windowName: renamedName,
            },
          });
          event("window-rename-visible", { operationId, renamedName });
          return Object.freeze({
            ...baseline,
            windows,
            selected,
            terminalResourceRevision: workspaceClient.committed.terminalResourceRevision,
            workspaceClient,
            tmux,
            presentation,
            operationId,
            acknowledgementWatermark,
            actionResult: result,
          });
        },
        startWebAfterWindowLifecycle: async (
          _namespace,
          runningDaemon,
          identity,
          _process,
          baseline,
          created,
          _switches,
          renamed,
        ) => {
          const watermark = windowWorkspaceEvidenceWatermark(
            state,
            baseline.processId,
            baseline.daemonGeneration,
          );
          devServer = await startDevServer(runningDaemon, {
            daemonInfoPath: join(fleet.daemonInfoDir, "daemon.json"),
          });
          browser = await chromium.launch({ headless: true });
          const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
          const page = await context.newPage();
          await page.goto(devServer.pageUrl, { waitUntil: "domcontentloaded" });
          const ready = await waitForFocusWebSemantic({
            signal: ownerAbort.signal,
            health: () =>
              ownerAbort.signal.aborted
                ? "aborted"
                : !devServer.isRunning()
                  ? "dev-server-dead"
                  : !browser.isConnected()
                    ? "browser-disconnected"
                    : page.isClosed()
                      ? "page-closed"
                      : null,
            sample: () => page.evaluate(captureFocusWebSemanticDocument),
            derivedResources: renamed.workspaceClient.derived.terminalInventory.resources,
            expectedWorkspaceName: identity.workspaceName,
            expectedSemanticPaneId: renamed.selected.semanticPaneId,
            expectedDaemonGeneration: runningDaemon.record.instanceId,
          });
          const semantic = ready.semantic;
          if (
            semantic.windowNodeCount !== 2 ||
            semantic.terminalNodeCount !== 1 ||
            semantic.windows.filter(
              (window) =>
                window.windowResourceId === created.selected.windowResourceId &&
                window.label === renamed.selected.name &&
                window.active === "true",
            ).length !== 1 ||
            semantic.windows.filter(
              (window) =>
                window.windowResourceId === baseline.selected.windowResourceId &&
                window.label === baseline.selected.name &&
                window.active === "false",
            ).length !== 1
          )
            throw new Error("window Web semantic did not converge to two groups and one terminal");
          const workspaceClient = await waitForWindowWorkspaceEvidence(state, {
            processId: baseline.processId,
            daemonGeneration: baseline.daemonGeneration,
            clientGeneration: baseline.clientGeneration,
            clientId: baseline.clientId,
            workspaceName: baseline.workspaceName,
            sessionName: baseline.sessionName,
            afterMicros: watermark + 1,
            boundary: "window-web-correlation",
            resources: renamed.windows,
            web: true,
          });
          publish({ web: { pageUrl: devServer.pageUrl, startedAfterWindowBoundary: true } });
          event("window-web-correlation", { windows: semantic.windowNodeCount });
          return Object.freeze({
            pageUrl: devServer.pageUrl,
            semantic,
            readiness: ready.assessment,
            workspaceClient,
            correlation: Object.freeze({
              daemon: true,
              workspaceClient: true,
              tui: true,
              web: true,
              tmux: true,
            }),
            expected: Object.freeze({
              processId: baseline.processId,
              daemonGeneration: baseline.daemonGeneration,
              clientGeneration: baseline.clientGeneration,
              workspaceName: identity.workspaceName,
              sessionName: identity.sessionName,
              initial: Object.freeze({
                ...baseline.selected,
                semanticWindowId: baseline.tmux.find(
                  (row) => row.semanticPaneId === baseline.selected.semanticPaneId,
                )?.resourceId,
              }),
              created: Object.freeze({
                ...created.selected,
                semanticWindowId: renamed.presentation.started.target,
              }),
              renamedName: renamed.selected.name,
            }),
          });
        },
      });
      publish({
        convergence: { workspaceClient: windowBoot.web.workspaceClient },
        journeyEvidence: {
          windowLifecycle: {
            identity: windowBoot.identity,
            expected: windowBoot.web.expected,
            baseline: windowBoot.baseline,
            created: windowBoot.created,
            primed: windowBoot.primed,
            switches: windowBoot.switches,
            renamed: windowBoot.renamed,
            correlation: windowBoot.web.correlation,
            web: { semantic: windowBoot.web.semantic },
          },
        },
        status: "ready",
        readyAt: new Date().toISOString(),
      });
      await new Promise(() => undefined);
      return;
    }
    if (journeyId === "focus") {
      let focusReadiness = null;
      const focusBoot = await runFocusOwnerBoot({
        createFocusNamespace: async () => {
          const marker = `RIG_FOCUS_${randomBytes(6).toString("hex").toUpperCase()}`;
          const scratchFleet = await createScratchFleet({
            sessions: 1,
            slug,
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
          const initialPane = fleet.initialPanes.find((pane) => pane.sessionName === session);
          if (!initialPane) throw new Error("focus namespace lost its exact initial pane");
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
          const tui = prepareOwnedTuiRuntime({
            ownership: { session, runtimeNamespace },
            intendedTui: {
              hostSession: `_tmux-ide-product-rig-${slug}`,
              runtimeDir: join(rigRoot, "tui-focus"),
              performanceTracePath: join(rigRoot, "tui-focus", "performance-trace.jsonl"),
              performanceTraceDetail: "1",
              daemonPerformanceTracePath: null,
            },
            publish,
            resolveProvenance: sourceTraceProvenance,
            createRuntimeDir: createIsolatedTargetedTuiCwd,
          });
          event("focus-namespace-ready", { paneId: initialPane.paneId });
          return {
            session,
            marker,
            seed: { marker, paneId: initialPane.paneId, geometry: initialPane },
            runtimeNamespace,
            tui,
          };
        },
        startCanonicalDaemon: async () => {
          daemon = await startOwnedProductRigDaemon({
            start: () => startDaemon(fleet),
            publish,
            waitUntilReady: waitForReadinessLadder,
          });
          return daemon;
        },
        openCanonicalWorkspace: async (namespace, runningDaemon) => {
          const workspace = await runningDaemon.promote(namespace.session);
          const identity = await observeTargetedCanonicalIdentity(
            runningDaemon,
            namespace.session,
            workspace,
          );
          publish({
            workspace,
            daemon: {
              ...runningDaemon.record,
              revision: identity.catalogRevision,
              revisionKind: "fleet-catalog",
            },
          });
          event("focus-daemon-ready", identity);
          return identity;
        },
        buildBeforeMeasurement: async () => {
          await execFileAsync("bun", [join(repoRoot, "scripts", "build-tui.mjs")], {
            cwd: repoRoot,
            timeout: 120_000,
          });
          prepareIsolatedTargetedTuiCwd(state.tui.runtimeDir);
          event("focus-tui-build", { prepared: true });
        },
        launchFocusTui: async (namespace) => {
          let launched;
          const launchStartedAt = performance.now();
          try {
            launched = JSON.parse(
              await tuiCommandAsync(
                state,
                ["start", "--target", namespace.session, "--cols", "160", "--rows", "44", "--json"],
                { timeout: 30_000 },
              ),
            );
          } catch (error) {
            const reason = classifyProductTuiCommandFailure(error);
            const bounded = new Error(`focus TUI launch failed: ${reason}`, { cause: error });
            bounded.boundary = "focus-tui-started";
            bounded.observation = focusHostReadinessObservation(state, {
              reason,
              stage: "launch-command",
              attempts: 1,
              startedAt: launchStartedAt,
              deadlineMs: 30_000,
            });
            throw bounded;
          }
          if (
            !exactProductTuiLaunchReceipt(launched, {
              target: namespace.session,
              cols: 160,
              rows: 44,
            })
          ) {
            const error = new Error("focus TUI launch receipt was invalid");
            error.boundary = "focus-tui-started";
            error.observation = focusHostReadinessObservation(state, {
              reason: "identity-invalid",
              attempts: 0,
              startedAt: performance.now(),
              deadlineMs: 10_000,
            });
            throw error;
          }
          event("focus-tui-started", {
            launchId: launched.launchId,
            processId: launched.processId,
            target: launched.target,
            hostIdentity: launched.hostIdentity,
          });
          const startedAt = performance.now();
          const deadlineMs = 50_000;
          const controller = new AbortController();
          focusReadiness = {
            launched,
            startedAt,
            deadlineMs,
            controller,
            timer: setTimeout(() => controller.abort(), deadlineMs),
          };
          return launched;
        },
        waitForFocusHostReady: async (_namespace, _daemon, _identity, launched) => {
          const readiness = focusReadiness;
          if (!readiness || readiness.launched !== launched)
            throw new Error("focus readiness lifecycle was not initialized");
          let status;
          try {
            status = await waitForExactFocusHostReceipt(state, launched, {
              deadlineMs: Math.min(
                10_000,
                Math.max(1, readiness.deadlineMs - (performance.now() - readiness.startedAt)),
              ),
              signal: readiness.controller.signal,
            });
          } catch (error) {
            clearTimeout(readiness.timer);
            readiness.controller.abort();
            focusReadiness = null;
            throw error;
          }
          event("focus-host-ready", {
            launchId: status.launchId,
            processId: status.processId,
            hostIdentity: status.hostIdentity,
          });
          return status;
        },
        waitForFocusTuiCoherent: async (_namespace, _daemon, _identity, launched, status) => {
          const readiness = focusReadiness;
          if (!readiness || readiness.launched !== launched)
            throw new Error("focus readiness lifecycle was not initialized");
          try {
            const coherentRemaining = Math.max(
              1,
              Math.min(30_000, readiness.deadlineMs - (performance.now() - readiness.startedAt)),
            );
            await waitForCoherentTui(
              state,
              coherentRemaining,
              launched.processId,
              status,
              readiness.controller.signal,
            );
            const revalidationRemaining = Math.max(
              1,
              readiness.deadlineMs - (performance.now() - readiness.startedAt),
            );
            try {
              status = await waitForExactFocusHostReceipt(state, launched, {
                deadlineMs: revalidationRemaining,
                signal: readiness.controller.signal,
              });
            } catch (error) {
              error.boundary = "focus-tui-coherent";
              if (error.observation) {
                error.observation = Object.freeze({
                  ...error.observation,
                  stage: "post-frame-host-revalidation",
                });
              }
              throw error;
            }
          } catch (error) {
            if (error?.code === "PROCESS_DEAD" || error?.code === "ABORT_ERR") {
              const rendererObservation = error.observation ?? null;
              error.boundary = "focus-tui-coherent";
              const hostObservation = focusHostReadinessObservation(state, {
                reason: error.code === "PROCESS_DEAD" ? "process-dead" : "aborted",
                attempts: 1,
                stage: "renderer-coherent-wait",
                startedAt: readiness.startedAt,
                deadlineMs: readiness.deadlineMs,
              });
              error.observation = Object.freeze({
                ...hostObservation,
                renderer: rendererObservation,
              });
            } else if (!error?.boundary) {
              error.boundary = "focus-tui-coherent";
            }
            throw error;
          } finally {
            clearTimeout(readiness.timer);
            readiness.controller.abort();
            focusReadiness = null;
          }
          event("focus-tui-coherent", { processId: launched.processId });
          return Object.freeze({
            processId: launched.processId,
            target: launched.target,
            launchId: launched.launchId,
            hostIdentity: launched.hostIdentity,
          });
        },
        proveFocusBaseline: async (namespace, runningDaemon, identity, process) => {
          const publication = await provePreseededPanePublication(state, namespace.seed);
          const lifecycle = readJsonLines(join(namespace.tui.runtimeDir, "performance.jsonl"));
          if (lifecycle.some(({ phase }) => phase?.startsWith("terminal-host-")))
            throw new Error("focus journey observed hosted focus input before its exact baseline");
          const expectedBase = {
            processId: `opentui:${process.processId}`,
            clockId: publication.hostFrame.clockId,
            daemonGeneration: runningDaemon.record.instanceId,
            workspaceName: identity.workspaceName,
            sessionName: identity.sessionName,
            clientId: `opentui:${process.processId}`,
            rendererEpoch: publication.hostFrame.rendererEpoch,
            sourceEpoch: publication.canonicalSeedPaint.paint.sourceEpoch,
            semanticPaneId: publication.semanticPaneId,
            canonicalGeneration: publication.canonicalSeedPaint.publication.generation,
            incarnation: publication.canonicalSeedPaint.publication.incarnation,
            revision: publication.canonicalSeedPaint.publication.revision,
            stateHash: publication.canonicalSeedPaint.publication.stateHash,
            canonicalCols: publication.canonicalSeedPaint.publication.cols,
            canonicalRows: publication.canonicalSeedPaint.publication.rows,
            viewportCols: publication.canonicalSeedPaint.paint.viewportCols,
            viewportRows: publication.canonicalSeedPaint.paint.viewportRows,
          };
          let workspaceClient;
          try {
            workspaceClient = await waitForQualifiedWorkspaceClientState(
              () => readJsonLines(join(namespace.tui.runtimeDir, "performance.jsonl")),
              {
                processId: expectedBase.processId,
                daemonGeneration: expectedBase.daemonGeneration,
                workspaceName: identity.workspaceName,
                sessionName: identity.sessionName,
                fleetSessionId: identity.fleetSessionId,
                semanticPaneId: expectedBase.semanticPaneId,
                canonicalGeneration: expectedBase.canonicalGeneration,
              },
            );
          } catch (error) {
            error.boundary = "focus-baseline";
            throw error;
          }
          const expected = Object.freeze({
            ...expectedBase,
            clientGeneration: workspaceClient.committed.generation,
            hostPaneId: process.hostIdentity.paneId,
            hostSessionId: process.hostIdentity.sessionId,
            hostCols: process.hostIdentity.cols,
            hostRows: process.hostIdentity.rows,
            baselineAuthorityRevision: workspaceClient.committed.authority.revision,
          });
          const owners = workspaceClient.committed.authority?.owners;
          if (!["input", "focus", "geometry"].every((kind) => owners?.[kind] === expected.clientId))
            throw new Error("focus baseline did not own all three authorities");
          const snapshot = await focusPaneSnapshot(state, namespace.seed.paneId, {
            expectedMarker: "●",
            expected,
          });
          publish({ convergence: { workspaceClient } });
          return Object.freeze({ publication, expected, snapshot, workspaceClient });
        },
        driveBlur: async (namespace, _daemon, _identity, _process, baseline) => {
          const delivery = JSON.parse(
            tuiCommand(state, [
              "input",
              JSON.stringify({ version: 1, kind: "focus", state: "blur" }),
            ]),
          );
          if (
            delivery?.kind !== "focus" ||
            delivery?.delivery !== "exact-bytes-to-immutable-host-pane-pty" ||
            delivery?.bytesInjected !== 3 ||
            delivery?.phases !== 1
          )
            throw new Error("focus journey blur parser receipt was not exact");
          const settled = await waitForTuiLifecycleEntry(
            state,
            (entry) => entry?.phase === "terminal-host-focus-fence" && entry.diagnosticEpoch === 1,
            5_000,
            "focus blur did not settle",
          );
          const initiated = readJsonLines(join(state.tui.runtimeDir, "performance.jsonl")).find(
            (entry) =>
              entry?.phase === "terminal-host-renderer-blur-event" && entry.diagnosticEpoch === 1,
          );
          if (!Number.isSafeInteger(initiated?.monotonicMicros))
            throw new Error("focus blur initiation evidence is missing");
          const authorityReceipt = readJsonLines(
            join(state.tui.runtimeDir, "performance.jsonl"),
          ).find(
            (entry) =>
              entry?.phase === "terminal-host-blur-authority-settled" &&
              entry.diagnosticEpoch === 1,
          );
          if (!authorityReceipt) throw new Error("focus blur authority receipt is missing");
          const workspaceClient = await waitForFocusWorkspaceEvidence(state, {
            ...baseline.expected,
            boundary: "focus-blur-proved",
            afterMicros: initiated.monotonicMicros,
            owners: { input: null, focus: null, geometry: null },
            presence: "background",
          });
          const paintFence = await waitForFocusPaintFence(state, baseline.expected, 1);
          const snapshot = await focusPaneSnapshot(state, namespace.seed.paneId, {
            expectedMarker: "○",
            expected: baseline.expected,
            diagnosticEpoch: 1,
          });
          const assessment = await waitForFocusQualification(
            state,
            {
              ...baseline.expected,
              blurAuthorityRevision: workspaceClient.committed.authority.revision,
            },
            { before: baseline.snapshot, blur: snapshot },
            { blur: delivery },
            5_000,
            "blur",
          );
          event("focus-blur-proved", {
            diagnosticEpoch: 1,
            rendererEpoch: baseline.expected.rendererEpoch,
          });
          return Object.freeze({
            delivery,
            initiated,
            settled,
            authorityReceipt,
            paintFence,
            snapshot,
            workspaceClient,
            assessment,
          });
        },
        driveFocus: async (namespace, _daemon, _identity, _process, baseline, blur) => {
          const delivery = JSON.parse(
            tuiCommand(state, [
              "input",
              JSON.stringify({ version: 1, kind: "focus", state: "focus" }),
            ]),
          );
          if (
            delivery?.kind !== "focus" ||
            delivery?.delivery !== "exact-bytes-to-immutable-host-pane-pty" ||
            delivery?.bytesInjected !== 3 ||
            delivery?.phases !== 1
          )
            throw new Error("focus journey reclaim parser receipt was not exact");
          const settled = await waitForTuiLifecycleEntry(
            state,
            (entry) => entry?.phase === "terminal-host-focus-fence" && entry.diagnosticEpoch === 2,
            5_000,
            "focus reclaim did not settle",
          );
          const initiated = readJsonLines(join(state.tui.runtimeDir, "performance.jsonl")).find(
            (entry) =>
              entry?.phase === "terminal-host-renderer-focus-event" && entry.diagnosticEpoch === 2,
          );
          if (!Number.isSafeInteger(initiated?.monotonicMicros))
            throw new Error("focus reclaim initiation evidence is missing");
          const authorityReceipt = readJsonLines(
            join(state.tui.runtimeDir, "performance.jsonl"),
          ).find(
            (entry) =>
              entry?.phase === "terminal-host-focus-authority-settled" &&
              entry.diagnosticEpoch === 2,
          );
          if (!authorityReceipt) throw new Error("focus reclaim authority receipt is missing");
          const owners = {
            input: baseline.expected.clientId,
            focus: baseline.expected.clientId,
            geometry: baseline.expected.clientId,
          };
          const workspaceClient = await waitForFocusWorkspaceEvidence(state, {
            ...baseline.expected,
            boundary: "focus-reclaim-proved",
            afterMicros: initiated.monotonicMicros,
            owners,
            presence: "foreground",
          });
          const paintFence = await waitForFocusPaintFence(state, baseline.expected, 2);
          const snapshot = await focusPaneSnapshot(state, namespace.seed.paneId, {
            expectedMarker: "●",
            expected: baseline.expected,
            diagnosticEpoch: 2,
          });
          const assessment = await waitForFocusQualification(
            state,
            {
              ...baseline.expected,
              blurAuthorityRevision: blur.workspaceClient.committed.authority.revision,
              focusAuthorityRevision: workspaceClient.committed.authority.revision,
            },
            {
              before: baseline.snapshot,
              blur: blur.snapshot,
              focus: snapshot,
            },
            { blur: blur.delivery, focus: delivery },
          );
          event("focus-reclaim-proved", {
            diagnosticEpoch: 2,
            rendererEpoch: baseline.expected.rendererEpoch,
            firstFailedPredicate: assessment.firstFailedPredicate,
          });
          return Object.freeze({
            delivery,
            initiated,
            settled,
            authorityReceipt,
            paintFence,
            snapshot,
            workspaceClient,
            assessment,
          });
        },
        startWebAfterFocus: async (_namespace, _daemon, identity, process, reclaim) => {
          const workspaceClientWatermark = focusWorkspaceEvidenceWatermark(state, {
            processId: `opentui:${process.processId}`,
            daemonGeneration: state.daemon.instanceId,
          });
          devServer = await startDevServer(daemon, {
            daemonInfoPath: join(fleet.daemonInfoDir, "daemon.json"),
          });
          browser = await chromium.launch({ headless: true });
          const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
          const page = await context.newPage();
          await page.goto(devServer.pageUrl, { waitUntil: "domcontentloaded" });
          let ready;
          try {
            ready = await waitForFocusWebSemantic({
              signal: ownerAbort.signal,
              health: () =>
                ownerAbort.signal.aborted
                  ? "aborted"
                  : !devServer.isRunning()
                    ? "dev-server-dead"
                    : !browser.isConnected()
                      ? "browser-disconnected"
                      : page.isClosed()
                        ? "page-closed"
                        : null,
              sample: () => page.evaluate(captureFocusWebSemanticDocument),
              derivedResources: reclaim.workspaceClient.derived.terminalInventory.resources,
              expectedWorkspaceName: identity.workspaceName,
              expectedSemanticPaneId: reclaim.assessment.qualified.semanticPaneId,
              expectedDaemonGeneration: state.daemon.instanceId,
            });
          } catch (error) {
            if (error?.observation) publish({ focusWebObservation: error.observation });
            throw error;
          }
          const semantic = ready.semantic;
          publish({
            focusWebSemantic: semantic,
            focusWebObservation: {
              operation: "wait-for-focus-web-semantic",
              reason: "qualified",
              attempts: ready.attempts,
              stableExactSamples: ready.stableExactSamples,
              firstFailedPredicate: null,
              latest: ready.assessment.normalized,
              digest: ready.assessment.digest,
            },
          });
          const clientId = `opentui:${process.processId}`;
          const workspaceClient = await waitForFocusWorkspaceEvidence(state, {
            processId: clientId,
            daemonGeneration: state.daemon.instanceId,
            clientGeneration: reclaim.workspaceClient.committed.generation,
            workspaceName: identity.workspaceName,
            sessionName: identity.sessionName,
            clientId,
            semanticPaneId: reclaim.assessment.qualified.semanticPaneId,
            afterMicros: workspaceClientWatermark + 1,
            boundary: "focus-web-correlation",
            owners: { input: clientId, focus: clientId, geometry: clientId },
            presence: "foreground",
          });
          publish({ web: { pageUrl: devServer.pageUrl, startedAfterFocusBoundary: true } });
          event("focus-web-correlation", { pageUrl: devServer.pageUrl });
          return Object.freeze({
            pageUrl: devServer.pageUrl,
            semantic,
            readiness: ready.assessment,
            workspaceClient,
          });
        },
      });
      publish({
        convergence: { workspaceClient: focusBoot.web.workspaceClient },
        journeyEvidence: {
          focus: {
            identity: focusBoot.identity,
            process: focusBoot.process,
            baseline: {
              expected: focusBoot.baseline.expected,
              snapshot: focusBoot.baseline.snapshot,
              canonicalSeedPaint: focusBoot.baseline.publication.canonicalSeedPaint,
              hostFrame: focusBoot.baseline.publication.hostFrame,
            },
            blur: {
              delivery: focusBoot.blur.delivery,
              authorityReceipt: focusBoot.blur.authorityReceipt,
              authorityFence: focusBoot.blur.settled,
              paintFence: focusBoot.blur.paintFence,
              snapshot: focusBoot.blur.snapshot,
              authorityRevision: focusBoot.blur.workspaceClient.committed.authority.revision,
              assessment: focusBoot.blur.assessment,
            },
            reclaim: {
              delivery: focusBoot.reclaim.delivery,
              authorityReceipt: focusBoot.reclaim.authorityReceipt,
              authorityFence: focusBoot.reclaim.settled,
              paintFence: focusBoot.reclaim.paintFence,
              snapshot: focusBoot.reclaim.snapshot,
              authorityRevision: focusBoot.reclaim.workspaceClient.committed.authority.revision,
              assessment: focusBoot.reclaim.assessment,
            },
            web: {
              semantic: focusBoot.web.semantic,
              readiness: focusBoot.web.readiness,
            },
          },
        },
        status: "ready",
        readyAt: new Date().toISOString(),
      });
      await new Promise(() => undefined);
      return;
    }
    if (journeyId === "coherent-first-pane") {
      const coherentBoot = await runCoherentFirstPaneOwnerBoot({
        createTargetedNamespace: async () => {
          const marker = `RIG_COHERENT_${randomBytes(6).toString("hex").toUpperCase()}`;
          const scratchFleet = await createScratchFleet({
            sessions: 1,
            slug,
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
          };
          createIsolatedTargetedTuiCwd(tui.runtimeDir);
          publish({ session, runtimeNamespace, tui });
          const seedPane = activeWindowPaneGeometry(state).filter(
            ({ windowActive }) => windowActive,
          );
          if (seedPane.length !== 1)
            throw new Error("coherent journey requires one exact preseeded active pane");
          const seed = { marker, paneId: seedPane[0].paneId, geometry: seedPane[0] };
          event("targeted-namespace-preseeded", {
            paneId: seed.paneId,
            geometry: seed.geometry,
            markerHash: createHash("sha256").update(marker).digest("hex"),
          });
          return { session, marker, runtimeNamespace, seed, tui };
        },
        startCanonicalDaemon: async () => {
          daemon = await startOwnedProductRigDaemon({
            start: () => startDaemon(fleet),
            publish,
            waitUntilReady: waitForReadinessLadder,
          });
          return daemon;
        },
        openCanonicalWorkspace: async (namespace, runningDaemon) => {
          const workspace = await runningDaemon.promote(namespace.session);
          const identity = await observeTargetedCanonicalIdentity(
            runningDaemon,
            namespace.session,
            workspace,
          );
          publish({
            workspace,
            daemon: {
              ...runningDaemon.record,
              revision: identity.catalogRevision,
              revisionKind: "fleet-catalog",
            },
          });
          event("targeted-daemon-ready", identity);
          return identity;
        },
        buildBeforeMeasurement: async () => {
          await execFileAsync("bun", [join(repoRoot, "scripts", "build-tui.mjs")], {
            cwd: repoRoot,
            timeout: 120_000,
          });
        },
        prepareTargetedTuiCwd: async (namespace) => {
          const cwd = prepareIsolatedTargetedTuiCwd(namespace.tui.runtimeDir);
          event("targeted-tui-cwd-ready", {
            runtimeKind: "isolated-testdrive-home",
            mode: "0700",
          });
          return cwd;
        },
        launchTargetedTui: async (namespace) => {
          event("targeted-tui-connect", { session: namespace.session });
          tuiCommand(state, [
            "start",
            "--target",
            namespace.session,
            "--cols",
            "160",
            "--rows",
            "44",
          ]);
          const status = JSON.parse(tuiCommand(state, ["status", "--json"]));
          if (status.target !== namespace.session)
            throw new Error("coherent journey TUI did not retain its exact canonical target");
          return Object.freeze({
            target: status.target,
            processId: Number.isInteger(status.processId) ? status.processId : null,
            launchId: typeof status.launchId === "string" ? status.launchId : null,
          });
        },
        proveCoherentPublication: async (namespace, runningDaemon, identity, _targetedProcess) => {
          await waitForCoherentTui(state);
          const publication = await provePreseededPanePublication(state, namespace.seed);
          const workspaceClient = await waitForQualifiedWorkspaceClientState(
            () => readJsonLines(join(namespace.tui.runtimeDir, "performance.jsonl")),
            {
              processId: publication.hostFrame.processId,
              daemonGeneration: runningDaemon.record.instanceId,
              workspaceName: identity.workspaceName,
              sessionName: identity.sessionName,
              fleetSessionId: identity.fleetSessionId,
              semanticPaneId: publication.semanticPaneId,
              canonicalGeneration: publication.canonicalSeedPaint.publication.generation,
            },
          );
          publish({ convergence: { workspaceClient } });
          event("canonical-seed-paint-correlation", publication.canonicalSeedPaint);
          event("coherent-terminal-publication", {
            markerHash: createHash("sha256").update(namespace.marker).digest("hex"),
            connectToCoherentMs: publication.connectToCoherentMs,
            publication,
          });
          return publication;
        },
        startWebAfterCoherentBoundary: async () => {
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
          publish({ web: { pageUrl: devServer.pageUrl, startedAfterCoherentBoundary: true } });
          event("web-started-after-coherent-boundary", { pageUrl: devServer.pageUrl });
          return Object.freeze({ pageUrl: devServer.pageUrl, semanticConnected: true });
        },
      });
      publish({
        journeyEvidence: {
          coherentFirstPane: {
            identity: coherentBoot.identity,
            targetedProcess: coherentBoot.targetedProcess,
            coherent: coherentBoot.coherent,
            web: coherentBoot.web,
          },
        },
        status: "ready",
        readyAt: new Date().toISOString(),
      });
      await new Promise(() => undefined);
      return;
    }
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
            publish({ daemonLifecycle: "starting" });
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
            publish({ daemonLifecycle: "started", daemon: record });
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

    publish({ daemonLifecycle: "starting" });
    daemon = await startDaemon(fleet);
    publish({ daemonLifecycle: "started", daemon: daemon.record });
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
    publish({ daemonLifecycle: "starting" });
    daemon = await startDaemon(fleet);
    publish({ daemonLifecycle: "started", daemon: daemon.record });
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
