#!/usr/bin/env node

/**
 * One real-product test rig: private tmux + one daemon + real TUI + real Web.
 * It is deliberately an operator/test surface, not a second product runtime.
 */
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
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
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  startDaemon,
  waitForReadinessLadder,
} from "../apps/desktop-renderer/e2e/fixtures/daemon.ts";
import { startDevServer } from "../apps/desktop-renderer/e2e/fixtures/dev-server.ts";
import {
  SCRATCH_INITIAL_PANE_COMMAND_INVALID,
  createScratchFleet,
  validateScratchInitialPaneCommand,
} from "../apps/desktop-renderer/e2e/fixtures/scratch-fleet.ts";
import {
  PRODUCT_RIG_SOURCE_DIFF_MAX_BYTES,
  PRODUCT_RIG_SOURCE_INVENTORY_MAX_BYTES,
  PRODUCT_RIG_SOURCE_INVENTORY_MAX_PATHS,
  PRODUCT_RIG_SOURCE_PATH_MAX_BYTES,
  PRODUCT_RIG_STATE_VERSION,
  activeTmuxPaneFromRows,
  bindPromotedInitialPane,
  appendBoundedWebDiagnostic,
  awaitWebDiagnosticWithDeadline,
  buildSourceTracePayload,
  buildProductSourceManifest,
  buildProductDiagnosticReport,
  buildWebStartupEvidence,
  causalFixtureBaselineReadiness,
  causalInputSamples,
  causalInputSampleHasIncarnation,
  causalProbeEpochState,
  createProductRigAttemptTimelineClock,
  compareProductSourceProvenance,
  deriveProductSourceManifestReadBudget,
  productRigSourceTraceIncludesPath,
  productRigGitBlobObjectId,
  productRigHostHeartbeatObservation,
  productRigSourceTraceDiffArgs,
  productRigSourceTraceUntrackedArgs,
  productSourceHeadBaselineBytes,
  readBoundedSourceTraceFiles,
  coherentGenerationPaint,
  coherentGenerationDuration,
  coherentReadiness,
  createProductJsonlTailReader,
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
  projectProductPaneStreamLifecycle,
  productResourceProbeCells,
  productCapturePageUrlStatus,
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
  parseTestdriveInputFailureObservation,
  testdriveInputSupervisorTimeout,
} from "./lib/tui-testdrive-input.mjs";
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
  assessProductRigRetainedProcessAbsence,
  acquireLegacyProductRigCleanupLedger,
  assessLegacyProductRigCleanupAdmission,
  assessLegacyProductRigOwnerRetryCompatibility,
  createLegacyProductRigOwnerRetryIntent,
  acquireLegacyProductRigOwnerRetryIntent,
  legacyProductRigOwnerRetryIntentMatchesState,
  legacyProductRigOwnerRetryIntentMatchesOwnerRows,
  createLegacyProductRigOwnerRetryShutdownRequest,
  acquireLegacyProductRigOwnerRetryReceipt,
  finalizeLegacyProductRigOwnerRetry,
  isProductRigPendingReapAck,
  retireProductRigCleanupProofFiles,
  captureLegacyProductRigCleanupLedger,
  retireLegacyProductRigCleanupIdentities,
  isCleanLegacyStoppedProductRigState,
  resolveProductJourneyPlan,
  runConfiglessProductJourneyOwnerBoot,
  runCoherentFirstPaneOwnerBoot,
  runCrossClientHandoffOwnerBoot,
  runDaemonRestartOwnerBoot,
  runFirstKeyPasteOwnerBoot,
  runFocusOwnerBoot,
  runKeyboardPointerResizeOwnerBoot,
  runSelectionCopyAppMouseOwnerBoot,
  runAnsiCursorAltScreenOwnerBoot,
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
import {
  assessProductSelectionCopyAppMouse,
  assessApplicationMouseDistribution,
  applicationMouseDistributionFailureObservation,
  applicationMouseForwardFailureObservation,
  applicationMouseCausalSamples,
  assessSelectionCopyAppMouseJourneyBoundaries,
  selectionCausalFailureObservation,
  selectionClipboardEvidence,
  selectionCopyFailureEvidence,
  selectionMouseFixtureProgram,
  selectionLocalModeFailureObservation,
  selectionWebEvidence,
  selectionWorkspaceClientEvidence,
  waitForSelectionMouseModeConditioning,
} from "./lib/product-selection-copy-app-mouse.mjs";
import {
  ANSI_WORKLOAD_ABSOLUTE_MS,
  ANSI_WORKLOAD_NO_PROGRESS_MS,
  ANSI_TUI_HEAP_ABSOLUTE_CEILING_BYTES,
  ANSI_TUI_RSS_ABSOLUTE_CEILING_BYTES,
  advanceAnsiCanonicalPredecessor,
  advanceAnsiWorkloadProgress,
  ansiBaselinePreviousCounters,
  ansiBaselineCursorEvidenceStatus,
  ansiEventLoopResourceCapStatus,
  ansiNativePaneLeaseStatus,
  ansiPreAlternateNormalStatus,
  ansiResourceEpochIdentityExact,
  ansiRenditionFailureLocalization,
  ansiSemanticBodyProjection,
  ansiWorkloadMarker,
  ansiWorkloadOrderedTailStatus,
  ansiWorkloadPayload,
  ansiWorkloadProducerStatus,
  ansiWorkloadProgressExpiry,
  ansiCanonicalPresentationHmac,
  ansiCursorAltJourneyStatus,
  ansiCursorStageFromRecords,
  ansiWebExpectedGridProjection,
  ansiWorkloadDeliveryAuthorityTail,
  ansiWorkloadDeliveryJoin,
  assessAnsiCursorAltScreenEvidence,
  assessAnsiIdleRetainedResourceSamples,
  boundedAnsiResourceFailureFacts,
  boundedAnsiResourcePeakFailureFacts,
  captureAnsiCursorWebPresentation,
  runAnsiDeliveryReadyAction,
} from "./lib/product-ansi-cursor-alt-screen.mjs";
import {
  assessCard5CrossClientEvidence,
  assessCard5DaemonRestartEvidence,
  card5AuthorityReleaseBindingDigest,
  card5AuthorityReleaseBindingHmac,
  card5CrossClientFailureObservation,
  card5DaemonRestartFailureObservation,
  card5HandoffInputPayload,
} from "./lib/product-cross-client-handoff.mjs";
import {
  activateCard5ExactTerminalSurface,
  createCard5ProductionWebHostLease,
  issueCard5PredecessorDescriptor,
  observeCard5WebAuthorityReceipt,
  observeCard5WebCanonical,
  releaseCard5WebOwnedAuthorities,
  rejectCard5PredecessorDescriptor,
} from "./lib/product-card5-production-host-owner.mjs";
import {
  advanceCard5AuthorityReleaseStability,
  advanceCard5PostInputAuthorityPreconditionHistory,
  advanceCard5FocusedConvergenceStability,
  advanceCard5WebPhysicalLifecycleStability,
  advanceCard5RetainedFocusStability,
  assessCard5PostHandoffAuthority,
  assessCard5WebPhysicalLifecycle,
  assessCard5WebAuthorityRelease,
  assessCard5NullAuthorityPair,
  assessCard5TuiFocusAuthority,
  assessCard5TuiFocusedPane,
  assessCard5TuiRetainedFocus,
  assessCard5TuiFocusTransition,
  assessCard5TuiHandoffInput,
  assessCard5ReplacementEnvelopeEvidence,
  boundedCard5PostInputAuthorityPreconditionObservation,
  boundedCard5TuiFocusFailureObservation,
  boundedCard5TuiBlurTransitionObservation,
  boundedCard5HostFailureObservation,
  card5AuthorityActivityWithinCap,
  createCard5TuiFrameFenceTracker,
  createCard5DiagnosticEvidenceBinding,
  exactSharedCard5WebPane,
  isExactCard5TuiHostInputReceipt,
  matchesExpectedCard5WebPane,
  mergeCard5SemanticAuthorityEvidence,
  observeCard5WithinDeadline,
  selectCard5PostInputAuthorityJoin,
  selectCard5TuiHostFocusBinding,
  selectExactCard5PaneGeometry,
  selectExactCard5TmuxPaneBinding,
  runExactCard5TmuxPaneCapture,
  sealCard5TuiFocusAuthority,
  sealCard5CorrelationEvidence,
  sealCard5ProductionClientObservation,
  sameCard5WebPhysicalLifecycleEvidence,
} from "./lib/product-cross-client-host-evidence.mjs";
import {
  assessCard5ObservedHostLifecycle,
  card5HostCleanupStatus,
  validateCard5NativeObserverCommand,
  waitForCard5ObservedHostLifecycle,
} from "./lib/product-card5-host-topology.mjs";
import { conditionAnsiTmuxFixture } from "./lib/product-ansi-tmux-precondition.mjs";

const ANSI_MIRROR_FLOW_FAILURE_REASONS = new Set([
  "command-error",
  "command-timeout",
  "notification-queue-overflow",
  "no-progress",
  "absolute-deadline",
  "attempts-exhausted",
]);
const ANSI_ATOMIC_COLLECTOR_FAILURE_REASONS = new Set([
  "busy",
  "channel-exit",
  "foreign-sentinel",
  "duplicate-sentinel",
  "sentinel-order",
  "capture-byte-cap",
  "capture-line-cap",
  "cursor-cardinality",
  "cursor-byte-cap",
  "unexpected-post-line",
  "marker-rejected",
  "timeout",
  "retired",
]);
import { runBoundedFocusTmux } from "./lib/product-focus-tmux.mjs";
import { readBoundedDiagnosticTail } from "./lib/bounded-diagnostic-tail.mjs";
import { parseLayout } from "../packages/daemon/src/terminal/protocol/layout-parse.ts";
import {
  memorablePaneName,
  resolvePaneDisplayName,
} from "../packages/daemon/src/terminal/protocol/pane-display-name.ts";
import { decodeTmuxArgument } from "../packages/daemon/src/terminal/protocol/session-descriptor-discovery.ts";
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
const { chromium, _electron: electron } = await import(
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
const cleanupProcessLedgerPath = join(rigRoot, "cleanup-process-ledger.json");
const cleanupReapAckPath = join(rigRoot, "cleanup-reap-ack.json");
const cleanupReapReceiptPath = join(rigRoot, "cleanup-reap-receipt.json");
const artifactDir = join(rigRoot, "artifacts");
const diagnosticRoot = resolve(
  process.env.TMUX_IDE_PRODUCT_DIAGNOSTIC_DIR || join(repoRoot, ".tasks", "product-diagnostics"),
);
const diagnosticCaptures = new Map();
const diagnosticAttemptPhases = new Map();
let diagnosticFrozenProvenance = null;
const activeTuiCommandPids = new Set();
const activeCard5NativeObserverPids = new Set();
const productInputFingerprintKeys = new Map();

function cleanupProcessRows() {
  try {
    return execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,stat=,lstart=,command="], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .map((line) =>
        /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.*)$/u.exec(
          line.trim(),
        ),
      )
      .filter(Boolean)
      .map((match) => ({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        state: match[4],
        startToken: match[5],
        command: match[6],
      }));
  } catch {
    return null;
  }
}

function cleanupIdentityAttestation(ownerToken, identities) {
  if (!/^[0-9a-f]{48}$/u.test(ownerToken ?? "")) return null;
  return createHmac("sha256", Buffer.from(ownerToken, "hex"))
    .update(JSON.stringify(identities))
    .digest("hex");
}
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
  const selectionCopyAppMouse = state?.journeyEvidence?.selectionCopyAppMouse ?? null;
  const ansiCursorAltScreenCorrelation =
    state?.journeyEvidence?.ansiCursorAltScreenCorrelation ?? null;
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
              : selectionCopyAppMouse
                ? {
                    fleetSessionId: selectionCopyAppMouse.expected?.fleetSessionId,
                    catalogRevision: selectionCopyAppMouse.expected?.catalogRevision,
                    semanticPaneId: selectionCopyAppMouse.expected?.semanticPaneId,
                  }
                : ansiCursorAltScreenCorrelation
                  ? ansiCursorAltScreenCorrelation
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

function card5ArtifactCorrelation(state, captureEvidence, journeyEvidence, evidenceKey) {
  const tuiAvailable = Boolean(captureEvidence?.tuiPath && existsSync(captureEvidence.tuiPath));
  const webAvailable = Boolean(captureEvidence?.webPath && existsSync(captureEvidence.webPath));
  const identity = state?.card5ArtifactIdentity ?? null;
  const generation = journeyEvidence?.generations?.after ?? null;
  const expectedPaneHmac = journeyEvidence?.after?.clients?.opentui?.paneHmac ?? null;
  const expectedWorkspaceHmac = journeyEvidence?.after?.clients?.opentui?.workspaceHmac ?? null;
  const web = captureEvidence?.web ?? null;
  const host = web?.hostCorrelation ?? null;
  const exactTerminal = web?.terminals?.filter(
    ({ phase, workspaceName, semanticPaneId }) =>
      phase === "connected" &&
      card5EvidenceHmac("workspace", workspaceName, evidenceKey) === expectedWorkspaceHmac &&
      card5EvidenceHmac("pane", semanticPaneId, evidenceKey) === expectedPaneHmac,
  );
  const predicates = Object.freeze({
    tuiAvailable,
    webAvailable,
    identity:
      typeof identity?.fleetSessionId === "string" &&
      /^[0-9a-f]{20}$/u.test(identity?.catalogRevision ?? "") &&
      card5EvidenceHmac("pane", identity?.semanticPaneId, evidenceKey) === expectedPaneHmac,
    daemon:
      typeof generation === "string" &&
      state?.daemon?.instanceId === generation &&
      host?.bootstrapDaemon === generation &&
      host?.listDaemon === generation &&
      host?.shellDaemon === generation &&
      host?.domDaemonGeneration === generation,
    workspace:
      host?.workspaceRow?.workspaceName === state?.workspace &&
      host?.workspaceRow?.sessionName === state?.session &&
      host?.workspaceRow?.availability === "live" &&
      host?.shellFleetSessionId === identity?.fleetSessionId &&
      host?.shellWorkspaceName === state?.workspace,
    terminal: exactTerminal?.length === 1,
    native:
      captureEvidence?.truth?.session === state?.session &&
      Array.isArray(captureEvidence?.truth?.panes) &&
      captureEvidence.truth.panes.length > 0 &&
      captureEvidence?.tuiStatus?.daemon?.instanceId === generation,
  });
  const missing = Object.entries(predicates)
    .filter(([, passed]) => passed !== true)
    .map(([name]) => `card5-artifact.${name}`);
  const artifactHmac =
    missing.length === 0
      ? card5EvidenceHmac(
          "artifact-correlation",
          JSON.stringify({
            generation,
            journeyHmac: journeyEvidence?.correlation?.journeyHmac,
            paneHmac: expectedPaneHmac,
            workspaceHmac: expectedWorkspaceHmac,
            fleetSessionHmac: card5EvidenceHmac(
              "fleet-session",
              identity.fleetSessionId,
              evidenceKey,
            ),
            catalogRevisionHmac: card5EvidenceHmac(
              "catalog-revision",
              identity.catalogRevision,
              evidenceKey,
            ),
          }),
          evidenceKey,
        )
      : null;
  return Object.freeze({
    complete: missing.length === 0,
    missing: Object.freeze(missing),
    artifactHmac,
    daemonState: Object.freeze({
      generationHmac:
        typeof generation === "string"
          ? card5EvidenceHmac("daemon-generation", generation, evidenceKey)
          : null,
      correlationComplete: predicates.daemon,
    }),
    clientState: Object.freeze({ artifactHmac, correlationComplete: missing.length === 0 }),
    availability: Object.freeze({ tui: tuiAvailable, web: webAvailable }),
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
          ...(state.tui.hostFocusLifecyclePath
            ? { TMUX_IDE_TUI_PERF_LOG: state.tui.hostFocusLifecyclePath }
            : {}),
          ...(state.tui.hostFocusControlPath
            ? {
                TMUX_IDE_CARD5_HOST_FOCUS_CONTROL_CAPABILITY: "1",
                TMUX_IDE_CARD5_HOST_FOCUS_CONTROL_PATH: state.tui.hostFocusControlPath,
                TMUX_IDE_CARD5_HOST_FOCUS_CONTROL_ROOT: state.tui.hostFocusControlRoot,
              }
            : {}),
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
  const tree = productRigGitBlobObjectId(payload);
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
  for (const path of manifestPaths) {
    if (
      path.startsWith("/") ||
      path.split("/").includes("..") ||
      /[\0\r\n]/u.test(path) ||
      Buffer.byteLength(path) > PRODUCT_RIG_SOURCE_PATH_MAX_BYTES
    )
      throw new Error("Product rig source manifest path was malformed");
  }
  const headObjects =
    trackedPaths.length === 0
      ? []
      : execFileSync("git", ["cat-file", "--batch-check=%(objecttype) %(objectsize)"], {
          cwd: repoRoot,
          input: trackedPaths.map((path) => `HEAD:${path}`).join("\n") + "\n",
          encoding: "utf8",
          maxBuffer: PRODUCT_RIG_SOURCE_INVENTORY_MAX_BYTES,
        })
          .trimEnd()
          .split("\n");
  const selectedHeadBytes = productSourceHeadBaselineBytes(headObjects, trackedPaths.length);
  const manifestBudget = deriveProductSourceManifestReadBudget(selectedHeadBytes);
  const builtManifest = buildProductSourceManifest(
    manifestPaths,
    {
      openFile: (path) =>
        openSync(resolve(repoRoot, path), fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)),
      statFile: fstatSync,
      readChunk: (descriptor, buffer, length, position) =>
        readSync(descriptor, buffer, 0, length, position),
      closeFile: closeSync,
    },
    manifestBudget,
  );
  const { manifest, manifestDigest } = builtManifest;
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
      "#{qa:session_name}\t#{session_id}\t#{pane_id}\t#{pane_created}\t#{window_active}\t#{qa:@tmux_ide_pane_id}\t#{qa:@ide_name}\t#{qa:@tmux_ide_name_source}\t#{qa:pane_current_command}\t#{qa:pane_title}\t#{qa:@ide_type}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}",
    ],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [
        sessionName,
        sessionId,
        paneId,
        paneCreated,
        windowActive,
        semanticPaneId,
        configuredName,
        configuredNameSource,
        currentCommand,
        title,
        paneType,
        left,
        top,
        width,
        height,
      ] = line.split("\t");
      const decodedSemanticPaneId = decodeTmuxArgument(semanticPaneId);
      const display = resolvePaneDisplayName({
        semanticPaneId: decodedSemanticPaneId,
        configuredName: decodeTmuxArgument(configuredName),
        configuredNameSource: decodeTmuxArgument(configuredNameSource),
        currentCommand: decodeTmuxArgument(currentCommand),
        title: decodeTmuxArgument(title),
        paneType: decodeTmuxArgument(paneType),
      });
      const canonicalDisplayNames = Object.freeze(
        [
          ...new Set([
            display.name,
            ...(display.source === "process" || display.source === "title"
              ? [memorablePaneName(decodedSemanticPaneId)]
              : []),
          ]),
        ].filter(Boolean),
      );
      return {
        sessionName: decodeTmuxArgument(sessionName),
        sessionId,
        paneId,
        paneCreated: Number(paneCreated),
        semanticPaneId: decodedSemanticPaneId,
        displayName: display.name,
        canonicalDisplayNames,
        displayNameSource: display.source,
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
        "#{session_name}\t#{window_id}\t#{@tmux_ide_window_id}\t#{window_name}\t#{window_active}\t#{window_width}\t#{window_height}\t#{pane_id}\t#{@tmux_ide_pane_id}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}",
      ],
      { deadline: performance.now() + timeoutMs, signal: controller.signal },
    );
    const rows = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [
          sessionName,
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
          sessionName,
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
          row.sessionName === state.session &&
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
  const capturePageUrl = existingPage
    ? Object.freeze({ exact: true, pageUrl: null, reason: null })
    : productCapturePageUrlStatus(state?.web?.pageUrl);
  if (!capturePageUrl.exact) {
    const error = new Error("ProductRig artifact capture requires an exact local Web page");
    error.code = "PRODUCT_RIG_CAPTURE_PAGE_URL_INVALID";
    error.boundary = "evidence-capture";
    error.observation = Object.freeze({
      operation: "product-artifact-web-url",
      code: error.code,
      reason: capturePageUrl.reason,
    });
    throw error;
  }
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
      await page.goto(capturePageUrl.pageUrl, { waitUntil: "domcontentloaded" });
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
      ...(state?.journeyEvidence?.ansiCursorAltScreenPartial?.workloadProgress
        ? {
            workloadProgress: Object.freeze({
              activeCycle: Number.isSafeInteger(
                state.journeyEvidence.ansiCursorAltScreenPartial.workloadProgress.activeCycle,
              )
                ? Math.min(
                    Math.max(
                      state.journeyEvidence.ansiCursorAltScreenPartial.workloadProgress.activeCycle,
                      0,
                    ),
                    24,
                  )
                : null,
              completedCycles: Number.isSafeInteger(
                state.journeyEvidence.ansiCursorAltScreenPartial.workloadProgress.completedCycles,
              )
                ? Math.min(
                    Math.max(
                      state.journeyEvidence.ansiCursorAltScreenPartial.workloadProgress
                        .completedCycles,
                      0,
                    ),
                    24,
                  )
                : null,
              progressCount: Number.isSafeInteger(
                state.journeyEvidence.ansiCursorAltScreenPartial.workloadProgress.progressCount,
              )
                ? Math.min(
                    Math.max(
                      state.journeyEvidence.ansiCursorAltScreenPartial.workloadProgress
                        .progressCount,
                      0,
                    ),
                    8_192,
                  )
                : null,
              elapsedMs: Number.isSafeInteger(
                state.journeyEvidence.ansiCursorAltScreenPartial.workloadProgress.elapsedMs,
              )
                ? Math.min(
                    Math.max(
                      state.journeyEvidence.ansiCursorAltScreenPartial.workloadProgress.elapsedMs,
                      0,
                    ),
                    30_000,
                  )
                : null,
              noProgressElapsedMs: Number.isSafeInteger(
                state.journeyEvidence.ansiCursorAltScreenPartial.workloadProgress
                  .noProgressElapsedMs,
              )
                ? Math.min(
                    Math.max(
                      state.journeyEvidence.ansiCursorAltScreenPartial.workloadProgress
                        .noProgressElapsedMs,
                      0,
                    ),
                    15_000,
                  )
                : null,
            }),
          }
        : {}),
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

async function exactAttachablePane(daemon, session, expectedPane) {
  if (typeof expectedPane !== "string" || expectedPane.length < 1) {
    throw new Error("Card5 expected pane identity was unavailable");
  }
  const response = await fetch(
    `${daemon.baseUrl}/api/project/${encodeURIComponent(session)}/application-shell?version=3`,
    { headers: { Authorization: `Bearer ${daemon.record.authToken}` } },
  );
  if (!response.ok) throw new Error(`application-shell answered ${response.status}`);
  const body = await response.json();
  const matching = (body?.resource?.terminalInventory?.resources ?? []).filter(
    (resource) =>
      resource?.attachability?.status === "available" &&
      resource?.attachability?.semanticPaneId === expectedPane,
  );
  if (matching.length !== 1) throw new Error("Card5 exact semantic pane was not attachable");
  return expectedPane;
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

async function card5ArtifactIdentity(daemon, label, semanticPaneId) {
  const response = await fetch(`${daemon.baseUrl}/api/resources/fleet-catalog`, {
    headers: { Authorization: `Bearer ${daemon.record.authToken}` },
  });
  if (!response.ok) throw new Error(`fleet-catalog answered ${response.status}`);
  const body = await response.json();
  const session = body?.sessions?.filter((entry) => entry?.label === label) ?? [];
  if (
    session.length !== 1 ||
    typeof session[0].sessionId !== "string" ||
    !/^[0-9a-f]{20}$/u.test(body?.catalogRevision ?? "") ||
    typeof semanticPaneId !== "string" ||
    semanticPaneId.length < 1 ||
    semanticPaneId.length > 256
  ) {
    throw new Error("Card5 artifact identity was unavailable or ambiguous");
  }
  return Object.freeze({
    fleetSessionId: session[0].sessionId,
    catalogRevision: body.catalogRevision,
    semanticPaneId,
  });
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

function createCard5TuiEvidenceStream(path, daemonPath, lifecyclePath) {
  const reader = createProductJsonlTailReader(path);
  const daemonReader = createProductJsonlTailReader(daemonPath);
  const lifecycleReader = createProductJsonlTailReader(lifecyclePath, {
    recordKind: "lifecycle",
  });
  let processed = 0;
  let lifecycleProcessed = 0;
  const frameFences = createCard5TuiFrameFenceTracker();
  let latestResource = null;
  let inputFenceCount = 0;
  let resourceCount = 0;
  let authorityActivityCount = 0;
  const authorityActivityEvents = [];
  const processReferenceRecords = (records) => {
    for (let index = processed; index < records.length; index += 1) {
      const candidate = records[index];
      if (candidate?.type === "performance.terminal-frame-fence") frameFences.ingest(candidate);
      if (candidate?.type === "performance.input-fence") inputFenceCount += 1;
      if (candidate?.type === "performance.terminal-resource-sample") {
        latestResource = candidate;
        resourceCount += 1;
      }
    }
    processed = records.length;
  };
  const processLifecycleRecords = (records) => {
    for (let index = lifecycleProcessed; index < records.length; index += 1) {
      const candidate = records[index];
      if (
        candidate?.phase === "terminal-host-focus-claim-attempt" &&
        Number.isSafeInteger(candidate?.claimOrdinal) &&
        candidate.claimOrdinal >= 1
      ) {
        authorityActivityCount += 1;
        authorityActivityEvents.push(
          Object.freeze({
            ordinal: candidate.claimOrdinal,
            surface: "opentui",
            kind: "focus",
            outcome: "ok",
            operationOrdinal: null,
            dimensionsHmac: null,
          }),
        );
        if (authorityActivityEvents.length > 64) authorityActivityEvents.shift();
      }
    }
    lifecycleProcessed = records.length;
  };
  const drainBindingSourcesOnce = () => {
    processReferenceRecords(reader.read());
    processLifecycleRecords(lifecycleReader.read());
    return frameFences;
  };
  const drain = () => {
    do {
      processReferenceRecords(reader.read());
    } while (!reader.snapshot().caughtUp);
    do {
      daemonReader.read();
    } while (!daemonReader.snapshot().caughtUp);
    do {
      processLifecycleRecords(lifecycleReader.read());
    } while (!lifecycleReader.snapshot().caughtUp);
    return frameFences;
  };
  return Object.freeze({
    reader,
    daemonReader,
    lifecycleReader,
    drainBindingSourcesOnce,
    drain,
    inputFenceCount: () => inputFenceCount,
    resourceSnapshot: () => Object.freeze({ count: resourceCount, record: latestResource }),
    authorityActivitySnapshot: () =>
      Object.freeze({
        count: Math.min(authorityActivityCount, 0xffff_ffff),
        overflow: authorityActivityCount > authorityActivityEvents.length,
        events: Object.freeze([...authorityActivityEvents]),
        geometrySettlements: Object.freeze([]),
      }),
    close: () => {
      reader.close();
      daemonReader.close();
      lifecycleReader.close();
    },
  });
}

function latestCard5TuiCanonical(stream, semanticPaneId) {
  return stream.drain().latest(semanticPaneId);
}

function card5EvidenceHmac(domain, value, evidenceKey) {
  return createHmac("sha256", Buffer.from(evidenceKey, "hex"))
    .update(`${domain}\0${value}`)
    .digest("hex");
}

async function invokeCard5TuiHostFocusControl({
  state,
  action,
  expected,
  evidenceKey,
  timeoutMs = 1_000,
}) {
  const path = state?.tui?.hostFocusControlPath;
  if (
    !["blur", "focus"].includes(action) ||
    typeof path !== "string" ||
    !path.startsWith("/") ||
    !/^[0-9a-f]{64}$/u.test(evidenceKey ?? "") ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 2_000
  )
    throw new Error("Card5 host-focus control contract was invalid");
  const nonce = randomBytes(16).toString("hex");
  const unsigned = Object.freeze({ version: 1, action, nonce, expected });
  const request = Object.freeze({
    ...unsigned,
    authHmac: card5EvidenceHmac(
      "host-focus-control-request",
      JSON.stringify(unsigned),
      evidenceKey,
    ),
  });
  const response = await new Promise((resolveResponse, rejectResponse) => {
    const socket = createConnection(path);
    let bytes = Buffer.alloc(0);
    let settled = false;
    let timer = null;
    const finish = (error, value = null) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      socket.destroy();
      if (error) rejectResponse(error);
      else resolveResponse(value);
    };
    timer = setTimeout(() => finish(new Error("Card5 host-focus control timed out")), timeoutMs);
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 8_192)
        return finish(new Error("Card5 host-focus control response exceeded its cap"));
      const newline = bytes.indexOf(0x0a);
      if (newline < 0) return;
      if (newline !== bytes.length - 1)
        return finish(new Error("Card5 host-focus control response was malformed"));
      try {
        finish(null, JSON.parse(bytes.subarray(0, newline).toString("utf8")));
      } catch (error) {
        finish(error);
      }
    });
    socket.once("error", (error) => finish(error));
    socket.once("end", () => {
      if (!settled) finish(new Error("Card5 host-focus control ended without a receipt"));
    });
  });
  const exactKeys = (value, keys) =>
    value !== null &&
    typeof value === "object" &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
  if (response?.status === "stale" || response?.status === "rejected") return response;
  if (
    !exactKeys(response, [
      "version",
      "status",
      "action",
      "nonceHmac",
      "diagnosticEpoch",
      "state",
      "bindingHmac",
      "receiptHmac",
    ]) ||
    response.version !== 1 ||
    !["changed", "no-op"].includes(response.status) ||
    response.action !== action ||
    response.nonceHmac !== card5EvidenceHmac("host-focus-control-nonce", nonce, evidenceKey) ||
    response.state !== (action === "focus" ? "foreground" : "background") ||
    response.bindingHmac !==
      card5EvidenceHmac("host-focus-control-binding", JSON.stringify(expected), evidenceKey) ||
    (response.status === "changed"
      ? !Number.isSafeInteger(response.diagnosticEpoch) || response.diagnosticEpoch < 1
      : response.diagnosticEpoch !== null)
  )
    throw new Error("Card5 host-focus control receipt was invalid");
  const unsignedReceipt = {
    version: response.version,
    status: response.status,
    action: response.action,
    nonceHmac: response.nonceHmac,
    diagnosticEpoch: response.diagnosticEpoch,
    state: response.state,
    bindingHmac: response.bindingHmac,
  };
  const expectedReceiptHmac = card5EvidenceHmac(
    "host-focus-control-receipt",
    JSON.stringify(unsignedReceipt),
    evidenceKey,
  );
  if (
    !/^[0-9a-f]{64}$/u.test(response.receiptHmac) ||
    !timingSafeEqual(Buffer.from(response.receiptHmac), Buffer.from(expectedReceiptHmac))
  )
    throw new Error("Card5 host-focus control receipt authentication failed");
  return Object.freeze({ ...response });
}

function card5CorrelationRecord(kind, ordinal, value, identities, evidenceKey) {
  const clients = ["opentui", "web-a", "web-b"];
  const sourceBindings = clients.map((client) => {
    const identity = identities?.[client];
    if (
      !identity ||
      !/^[0-9a-f]{64}$/u.test(identity.paneHmac ?? "") ||
      !/^[0-9a-f]{64}$/u.test(identity.processHmac ?? "") ||
      !/^[0-9a-f]{64}$/u.test(identity.clockHmac ?? "")
    ) {
      throw new Error(`Card5 correlation source ${client} is incomplete`);
    }
    const bindingHmac = card5EvidenceHmac(
      "source-binding",
      [client, identity.paneHmac, identity.processHmac, identity.clockHmac].join("\0"),
      evidenceKey,
    );
    return Object.freeze({
      client,
      paneHmac: identity.paneHmac,
      processHmac: identity.processHmac,
      clockHmac: identity.clockHmac,
      bindingHmac,
    });
  });
  const valueHmac = card5EvidenceHmac("value", JSON.stringify(value), evidenceKey);
  return Object.freeze({
    kind,
    ordinal,
    valueHmac,
    sourceBindings: Object.freeze(sourceBindings),
    recordHmac: card5EvidenceHmac(
      "record",
      [kind, ordinal, valueHmac, ...sourceBindings.map(({ bindingHmac }) => bindingHmac)].join(
        "\0",
      ),
      evidenceKey,
    ),
  });
}

function sealCrossClientCorrelation(proof, evidenceKey) {
  return sealCard5CorrelationEvidence(
    [
      ["host-open", proof.namespace],
      ["canonical-before", proof.initial],
      ["authority-handoff", proof.handoff],
      ["slow-isolation", proof.slowWeb],
      ["generation-replacement", proof.restart],
      ["canonical-after", proof.after],
      ["native-observer", proof.nativeObserver],
    ].map(([kind, value], ordinal) => {
      const identities = ordinal >= 4 ? proof.after.clients : proof.initial.clients;
      return card5CorrelationRecord(kind, ordinal, value, identities, evidenceKey);
    }),
    evidenceKey,
  );
}

function sealDaemonRestartCorrelation(hosts, before, replacement, after, evidenceKey) {
  return sealCard5CorrelationEvidence(
    [
      ["host-open", hosts],
      ["canonical-before", before],
      ["generation-replacement", replacement],
      ["canonical-after", after],
    ].map(([kind, value], ordinal) =>
      card5CorrelationRecord(
        kind,
        ordinal,
        value,
        ordinal >= 2 ? after.clients : before.clients,
        evidenceKey,
      ),
    ),
    evidenceKey,
    ["host-open", "canonical-before", "generation-replacement", "canonical-after"],
  );
}

async function waitForCard5ProductionClientConvergence(
  state,
  hosts,
  evidenceKey,
  tuiEvidence,
  timeoutMs,
  { expectedPane = undefined, onStablePane = undefined, postHandoff = null } = {},
) {
  if (expectedPane !== undefined && (typeof expectedPane !== "string" || expectedPane.length < 1)) {
    throw new TypeError("Card5 expected convergence pane is malformed");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000) {
    throw new TypeError("Card5 convergence timeout is malformed");
  }
  if (
    postHandoff !== null &&
    (!postHandoff ||
      !["web", "opentui"].includes(postHandoff.expectedSurface) ||
      typeof postHandoff.expectedClientId !== "string" ||
      !Number.isSafeInteger(postHandoff.grantRevision) ||
      !/^[0-9a-f]{64}$/u.test(postHandoff.inputProofHmac ?? "") ||
      !postHandoff.expectedBinding ||
      typeof postHandoff.expectedTuiClientId !== "string")
  )
    throw new TypeError("Card5 post-handoff convergence contract is malformed");
  const startedAt = performance.now();
  const deadline = startedAt + timeoutMs;
  let previousDigest = null;
  let previousAuthorityRevision = null;
  let attempts = 0;
  let observedClients = 0;
  let stableSamples = 0;
  let queuePeak = null;
  let divergenceAxes = null;
  let focusDivergenceAxes = null;
  let authorityActivityStorm = false;
  const candidateSummaries = [];
  const focusCandidates = [];
  const authorityViews = [];
  while (performance.now() < deadline) {
    attempts += 1;
    const observed = await observeCard5WithinDeadline(
      () =>
        Promise.all([
          observeCard5WebCanonical(hosts.chromiumPage, evidenceKey, hosts.chromiumProcessIdentity),
          observeCard5WebCanonical(hosts.electronPage, evidenceKey, hosts.electronProcessIdentity),
        ]),
      { deadline },
    );
    if (observed.status !== "ok" || performance.now() >= deadline) break;
    const [webA, webB] = observed.value;
    const tuiAuthorityActivity = tuiEvidence.authorityActivitySnapshot();
    authorityActivityStorm =
      [webA, webB].some(
        (web) => !card5AuthorityActivityWithinCap(web?.workspaceEvidence?.authorityActivity),
      ) || !card5AuthorityActivityWithinCap(tuiAuthorityActivity);
    if (authorityActivityStorm) {
      authorityViews.push(
        Object.freeze({
          a: null,
          b: null,
          activityA: webA?.workspaceEvidence?.authorityActivity ?? null,
          activityB: webB?.workspaceEvidence?.authorityActivity ?? null,
          activityTui: tuiAuthorityActivity,
          semanticEqual: false,
          revisionMonotonic: true,
        }),
      );
      break;
    }
    const sharedPaneId = exactSharedCard5WebPane([webA, webB]);
    const exactPaneId =
      sharedPaneId !== null &&
      (expectedPane === undefined || matchesExpectedCard5WebPane([webA, webB], expectedPane))
        ? sharedPaneId
        : null;
    if (performance.now() >= deadline) break;
    const tui = exactPaneId === null ? null : latestCard5TuiCanonical(tuiEvidence, exactPaneId);
    const webPhysicalLifecycleEvidence =
      tui === null
        ? null
        : Object.freeze({
            chromium: assessCard5WebPhysicalLifecycle(webA, exactPaneId, tui.generation).evidence,
            electron: assessCard5WebPhysicalLifecycle(webB, exactPaneId, tui.generation).evidence,
          });
    const webPhysicalLifecycleExact =
      webPhysicalLifecycleEvidence?.chromium !== null &&
      webPhysicalLifecycleEvidence?.electron !== null;
    if (performance.now() >= deadline) break;
    const canonicalAssessmentA =
      tui === null
        ? null
        : assessCard5TuiFocusedPane({
            records: tuiEvidence.reader.read(),
            expectedPane: exactPaneId,
            expectedCanonical: tui,
            expectedAuthority:
              postHandoff === null ? webA?.workspaceEvidence?.authority : undefined,
            evidenceKey,
          });
    const canonicalAssessmentB =
      tui === null
        ? null
        : assessCard5TuiFocusedPane({
            records: tuiEvidence.reader.read(),
            expectedPane: exactPaneId,
            expectedCanonical: tui,
            expectedAuthority:
              postHandoff === null ? webB?.workspaceEvidence?.authority : undefined,
            evidenceKey,
          });
    const authorityAssessmentA =
      postHandoff === null
        ? assessCard5TuiFocusAuthority(
            webA?.workspaceEvidence?.authority,
            tui?.generation,
            evidenceKey,
            webA?.workspaceEvidence?.authorityRecords,
          )
        : assessCard5PostHandoffAuthority({
            authority: webA?.workspaceEvidence?.authority,
            authorityRecords: webA?.workspaceEvidence?.authorityRecords,
            generation: tui?.generation,
            expectedClientId: postHandoff.expectedClientId,
            expectedSurface: postHandoff.expectedSurface,
            grantRevision: postHandoff.grantRevision,
            inputProofHmac: postHandoff.inputProofHmac,
            evidenceKey,
          });
    const authorityAssessmentB =
      postHandoff === null
        ? assessCard5TuiFocusAuthority(
            webB?.workspaceEvidence?.authority,
            tui?.generation,
            evidenceKey,
            webB?.workspaceEvidence?.authorityRecords,
          )
        : assessCard5PostHandoffAuthority({
            authority: webB?.workspaceEvidence?.authority,
            authorityRecords: webB?.workspaceEvidence?.authorityRecords,
            generation: tui?.generation,
            expectedClientId: postHandoff.expectedClientId,
            expectedSurface: postHandoff.expectedSurface,
            grantRevision: postHandoff.grantRevision,
            inputProofHmac: postHandoff.inputProofHmac,
            evidenceKey,
          });
    const bindingAssessment =
      postHandoff === null || tui === null
        ? null
        : selectCard5TuiHostFocusBinding({
            lifecycleRecords: tuiEvidence.lifecycleReader.read(),
            referenceRecords: tuiEvidence.reader.read(),
            expectedCanonical: tui,
            expectedAuthority: webA?.workspaceEvidence?.authority,
            expectedWorkspaceName: state.workspace,
            expectedTuiClientId: postHandoff.expectedTuiClientId,
            evidenceKey,
          });
    const postBindingExact =
      postHandoff === null ||
      (bindingAssessment?.passed === true &&
        bindingAssessment.binding.rendererEpoch === postHandoff.expectedBinding.rendererEpoch &&
        bindingAssessment.binding.clientGeneration ===
          postHandoff.expectedBinding.clientGeneration &&
        bindingAssessment.binding.bindingEpoch === postHandoff.expectedBinding.bindingEpoch);
    const focusAssessmentA =
      canonicalAssessmentA?.passed === true && authorityAssessmentA.valid && postBindingExact
        ? Object.freeze({
            ...canonicalAssessmentA,
            candidate: Object.freeze({
              ...canonicalAssessmentA.candidate,
              authoritySequenceHmac: authorityAssessmentA.evidence.authoritySequenceHmac,
            }),
            evidence: Object.freeze({
              ...canonicalAssessmentA.evidence,
              ...(postHandoff === null ? {} : authorityAssessmentA.evidence),
            }),
          })
        : canonicalAssessmentA;
    const focusAssessmentB =
      canonicalAssessmentB?.passed === true && authorityAssessmentB.valid && postBindingExact
        ? Object.freeze({
            ...canonicalAssessmentB,
            candidate: Object.freeze({
              ...canonicalAssessmentB.candidate,
              authoritySequenceHmac: authorityAssessmentB.evidence.authoritySequenceHmac,
            }),
            evidence: Object.freeze({
              ...canonicalAssessmentB.evidence,
              ...(postHandoff === null ? {} : authorityAssessmentB.evidence),
            }),
          })
        : canonicalAssessmentB;
    const focusCanonicalCrossbound =
      focusAssessmentA?.passed === true &&
      focusAssessmentB?.passed === true &&
      authorityAssessmentA.valid &&
      authorityAssessmentB.valid &&
      postBindingExact &&
      focusAssessmentA.evidence.presentationHmac === focusAssessmentB.evidence.presentationHmac &&
      focusAssessmentA.evidence.frameHmac === focusAssessmentB.evidence.frameHmac &&
      focusAssessmentA.evidence.canonicalHmac === focusAssessmentB.evidence.canonicalHmac;
    const authorityMerge = mergeCard5SemanticAuthorityEvidence(
      focusAssessmentA?.evidence,
      focusAssessmentB?.evidence,
      previousAuthorityRevision,
    );
    const currentAuthorityRevision = authorityMerge.evidence?.authorityRevision ?? null;
    authorityViews.push(
      Object.freeze({
        a: authorityAssessmentA,
        b: authorityAssessmentB,
        activityA: webA?.workspaceEvidence?.authorityActivity ?? null,
        activityB: webB?.workspaceEvidence?.authorityActivity ?? null,
        activityTui: tuiAuthorityActivity,
        semanticEqual: authorityMerge.status === "exact",
        revisionMonotonic: authorityMerge.status !== "revision-regressed",
      }),
    );
    if (authorityViews.length > 2) authorityViews.shift();
    const focusAssessment =
      focusAssessmentA === null
        ? null
        : focusCanonicalCrossbound && authorityMerge.status === "exact"
          ? Object.freeze({
              ...focusAssessmentA,
              evidence: authorityMerge.evidence,
            })
          : Object.freeze({
              passed: false,
              reason: "focus-presentation-mismatch",
              evidence: null,
              axes: Object.freeze({ ...focusAssessmentA.axes, authority: true }),
              candidate: focusAssessmentA.candidate,
            });
    if (performance.now() >= deadline) break;
    focusDivergenceAxes = focusAssessment?.axes ?? null;
    if (focusAssessment?.candidate) {
      focusCandidates.push(focusAssessment.candidate);
      if (focusCandidates.length > 2) focusCandidates.shift();
    }
    observedClients = [tui, webA, webB].filter(Boolean).length;
    const queueCandidates = [webA?.queuePeak, webB?.queuePeak].filter(Number.isSafeInteger);
    queuePeak = queueCandidates.length > 0 ? Math.max(...queueCandidates) : null;
    if (performance.now() >= deadline) break;
    if (tui && webA && webB && focusAssessment?.passed === true && webPhysicalLifecycleExact) {
      previousAuthorityRevision = currentAuthorityRevision;
      const connectElapsedMs = Math.max(1, performance.now() - startedAt);
      const currentTuiAuthorityClient = webA?.workspaceEvidence?.authority?.clients?.find(
        ({ surface }) => surface === "opentui",
      );
      const currentTuiAuthorityOwners = webA?.workspaceEvidence?.authority?.owners;
      const observations = [
        sealCard5ProductionClientObservation(
          {
            client: "opentui",
            host: "opentui",
            ...tui,
            workspaceName: state.workspace,
            processIdentity: tui.processId,
            presence: postHandoff === null ? "foreground" : currentTuiAuthorityClient?.state,
            passive:
              postHandoff === null
                ? false
                : currentTuiAuthorityOwners?.input !== currentTuiAuthorityClient?.clientId &&
                  currentTuiAuthorityOwners?.focus !== currentTuiAuthorityClient?.clientId,
            geometryOwner:
              postHandoff === null
                ? true
                : currentTuiAuthorityOwners?.geometry === currentTuiAuthorityClient?.clientId,
            queueCurrent: 0,
            queuePeak: 0,
            queueCap: 32,
            connectElapsedMs,
          },
          evidenceKey,
        ),
        sealCard5ProductionClientObservation(
          {
            client: "web-a",
            host: "chromium",
            ...webA,
            queueCap: 32,
            connectElapsedMs,
          },
          evidenceKey,
        ),
        sealCard5ProductionClientObservation(
          {
            client: "web-b",
            host: "electron",
            ...webB,
            queueCap: 32,
            connectElapsedMs,
          },
          evidenceKey,
        ),
      ];
      if (performance.now() >= deadline) break;
      const canonicalStability = advanceCard5FocusedConvergenceStability(
        null,
        observations,
        focusAssessment.evidence,
        evidenceKey,
      );
      const physicalLifecycleStability = advanceCard5WebPhysicalLifecycleStability(
        previousDigest,
        canonicalStability.digest,
        webPhysicalLifecycleEvidence,
        evidenceKey,
      );
      const stability = Object.freeze({
        ...canonicalStability,
        digest: physicalLifecycleStability.digest,
        stable: physicalLifecycleStability.stable,
        reason: physicalLifecycleStability.stable ? null : canonicalStability.reason,
      });
      if (performance.now() >= deadline) break;
      divergenceAxes = stability.axes;
      if (stability.candidate) {
        candidateSummaries.push(stability.candidate);
        if (candidateSummaries.length > 2) candidateSummaries.shift();
      }
      stableSamples = stability.stable ? 2 : stability.digest === null ? 0 : 1;
      if (stability.stable) {
        if (performance.now() >= deadline) break;
        onStablePane?.(exactPaneId);
        if (performance.now() >= deadline) break;
        return Object.freeze({
          generation: observations[0].generation,
          semanticPaneId: exactPaneId,
          focusedPaneEvidence: focusAssessment.evidence,
          webPhysicalLifecycleEvidence,
          clients: Object.freeze(
            Object.fromEntries(observations.map((entry) => [entry.client, entry])),
          ),
          attempts,
          postHandoffAuthorityEvidence:
            postHandoff === null
              ? null
              : Object.freeze({
                  mode: "post-handoff",
                  relation: focusAssessment.evidence.relation,
                  grantRevision: focusAssessment.evidence.grantRevision,
                  currentRevision: focusAssessment.evidence.authorityRevision,
                  releaseRevision: focusAssessment.evidence.releaseRevision,
                  relationHmac: focusAssessment.evidence.authorityRelationHmac,
                  sequenceHmac: focusAssessment.evidence.authoritySequenceHmac,
                  inputProofHmac: focusAssessment.evidence.inputProofHmac,
                  authorityHmac: focusAssessment.evidence.authorityHmac,
                  authorityOwnerHmac: focusAssessment.evidence.authorityOwnerHmac,
                  authorityTopologyHmac: focusAssessment.evidence.authorityTopologyHmac,
                  authorityMutationHmac: focusAssessment.evidence.authorityMutationHmac,
                  duplicateCount: focusAssessment.evidence.authorityDuplicateCount,
                }),
        });
      }
      previousDigest = stability.digest;
    } else {
      previousDigest = null;
      if (currentAuthorityRevision !== null) {
        previousAuthorityRevision = currentAuthorityRevision;
      }
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(40, remaining)));
  }
  const error = new Error("Card5 production clients did not reach two-sample canonical stability");
  error.observation = boundedCard5HostFailureObservation({
    operation: "card5-production-host-observation",
    reason: authorityActivityStorm ? "authority-activity-storm" : "stability-timeout",
    attempts: Math.min(attempts, 4_096),
    elapsedMs: Math.min(Math.round(performance.now() - startedAt), 60_000),
    observedClients,
    stableSamples,
    queuePeak,
    divergenceAxes,
    focusDivergenceAxes,
    focusCandidates,
    authorityViews,
    candidateSummaries,
  });
  throw error;
}

function card5Percentile(samples, percentile) {
  if (!Array.isArray(samples) || samples.length === 0) return null;
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * percentile) - 1)];
}

async function driveCard5AuthorityHandoff(state, daemon, hosts) {
  const expectedPane = hosts.expectedPane;
  const acceptedWebPhysicalLifecycleEvidence = hosts.webPhysicalLifecycleEvidence;
  const acceptedFocusEvidence = hosts.focusedPaneEvidence;
  const acceptedAuthorityEvidence = Object.freeze({
    authorityHmac: acceptedFocusEvidence?.authorityHmac ?? null,
    authorityOwnerHmac: acceptedFocusEvidence?.authorityOwnerHmac ?? null,
    authorityRevision: acceptedFocusEvidence?.authorityRevision ?? null,
    authorityTopologyHmac: acceptedFocusEvidence?.authorityTopologyHmac ?? null,
    authorityMutationHmac: acceptedFocusEvidence?.authorityMutationHmac ?? null,
  });
  const preflightDeadline = performance.now() + 1_000;
  const preflight = await observeCard5WithinDeadline(
    () =>
      Promise.all([
        observeCard5WebCanonical(
          hosts.chromiumPage,
          hosts.evidenceKey,
          hosts.chromiumProcessIdentity,
        ),
        observeCard5WebCanonical(
          hosts.electronPage,
          hosts.evidenceKey,
          hosts.electronProcessIdentity,
        ),
      ]),
    { deadline: preflightDeadline },
  );
  const [preflightA, preflightB] = preflight.status === "ok" ? preflight.value : [null, null];
  const preflightGeneration =
    preflightA?.generation === preflightB?.generation ? preflightA?.generation : null;
  const currentWebPhysicalLifecycleEvidence =
    preflightGeneration === null
      ? null
      : Object.freeze({
          chromium: assessCard5WebPhysicalLifecycle(preflightA, expectedPane, preflightGeneration)
            .evidence,
          electron: assessCard5WebPhysicalLifecycle(preflightB, expectedPane, preflightGeneration)
            .evidence,
        });
  if (
    performance.now() >= preflightDeadline ||
    currentWebPhysicalLifecycleEvidence?.chromium === null ||
    currentWebPhysicalLifecycleEvidence?.electron === null ||
    !sameCard5WebPhysicalLifecycleEvidence(
      acceptedWebPhysicalLifecycleEvidence,
      currentWebPhysicalLifecycleEvidence,
    )
  ) {
    const error = new Error("Card5 Web physical lifecycle changed before authority handoff");
    error.observation = Object.freeze({
      operation: "card5-web-physical-lifecycle-preflight",
      reason: preflight.status === "ok" ? "physical-binding-changed" : "observation-timeout",
      chromiumExact: currentWebPhysicalLifecycleEvidence?.chromium !== null,
      electronExact: currentWebPhysicalLifecycleEvidence?.electron !== null,
      acceptedExact:
        acceptedWebPhysicalLifecycleEvidence?.chromium !== null &&
        acceptedWebPhysicalLifecycleEvidence?.electron !== null,
    });
    throw error;
  }
  await exactAttachablePane(daemon, state.session, expectedPane);
  const observeTmuxPaneBinding = () =>
    selectExactCard5TmuxPaneBinding(activeWindowPaneGeometry(state), expectedPane, state.session);
  const capturedTmuxPaneBinding = observeTmuxPaneBinding();
  const failTmuxPaneBinding = () => {
    const error = new Error("Card5 exact semantic-to-tmux pane binding changed");
    error.observation = Object.freeze({
      operation: "card5-tmux-semantic-pane-capture",
      reason: "topology-changed",
      expectedBinding: capturedTmuxPaneBinding !== null,
      currentBinding: false,
    });
    return error;
  };
  if (capturedTmuxPaneBinding === null) throw failTmuxPaneBinding();
  const requireExpectedWeb = (observed) => {
    if (observed?.semanticPaneId !== expectedPane) {
      throw new Error("Card5 Web terminal switched semantic panes during authority handoff");
    }
    return observed;
  };
  const clickExactSurface = async (page, input = null) => {
    const activationDeadline = input === null ? performance.now() + 3_000 : input.deadline;
    const processIdentity =
      page === hosts.chromiumPage
        ? hosts.chromiumProcessIdentity
        : page === hosts.electronPage
          ? hosts.electronProcessIdentity
          : null;
    if (processIdentity === null) {
      throw new Error("Card5 Web page identity was unavailable for terminal focus");
    }
    return activateCard5ExactTerminalSurface({
      mode: input === null ? "focus" : "input",
      page,
      keyHex: evidenceKey,
      processIdentity,
      expectedPane,
      expectedPaneHmac: card5EvidenceHmac("pane", expectedPane, evidenceKey),
      deadline: activationDeadline,
      ...(input === null
        ? {}
        : {
            inputText: input.text,
            inputSha256: input.sha256,
            inputHostRole:
              page === hosts.chromiumPage
                ? "chromium"
                : page === hosts.electronPage
                  ? "electron"
                  : null,
            inputOrdinal: input.ordinal,
          }),
    });
  };
  const driveExactTuiFocus = async (stateValue, expected) => {
    try {
      return await invokeCard5TuiHostFocusControl({
        state,
        action: stateValue === "blur" ? "blur" : "focus",
        expected,
        evidenceKey,
      });
    } catch (cause) {
      const error = new Error(`Card5 OpenTUI ${stateValue} control receipt was unavailable`, {
        cause,
      });
      error.observation = boundedCard5TuiFocusFailureObservation({
        reason:
          stateValue === "blur" ? "focus-blur-receipt-invalid" : "focus-focus-receipt-invalid",
        axes: { authority: true },
      });
      throw error;
    }
  };
  const steps = [
    async (input) => {
      return JSON.parse(
        tuiCommand(state, [
          "input",
          JSON.stringify({ version: 1, kind: "paste", text: input.text }),
        ]),
      );
    },
    async (input, inputDeadline) => {
      return clickExactSurface(hosts.chromiumPage, {
        text: input.text,
        sha256: input.sha256,
        deadline: inputDeadline,
        ordinal: 1,
      });
    },
    async (input, inputDeadline) => {
      return clickExactSurface(hosts.electronPage, {
        text: input.text,
        sha256: input.sha256,
        deadline: inputDeadline,
        ordinal: 2,
      });
    },
  ];
  const evidenceKey = hosts.evidenceKey;
  let retainedAuthorityEvidence = null;
  let initialNullAuthorityEvidence = null;
  const retainedAuthorityDeadline = performance.now() + 1_000;
  while (performance.now() < retainedAuthorityDeadline) {
    const retainedObservation = await observeCard5WithinDeadline(
      () =>
        Promise.all([
          observeCard5WebCanonical(hosts.chromiumPage, evidenceKey, hosts.chromiumProcessIdentity),
          observeCard5WebCanonical(hosts.electronPage, evidenceKey, hosts.electronProcessIdentity),
        ]),
      { deadline: retainedAuthorityDeadline },
    );
    if (retainedObservation.status !== "ok") break;
    const [authorityWebA, authorityWebB] = retainedObservation.value;
    requireExpectedWeb(authorityWebA);
    requireExpectedWeb(authorityWebB);
    const retainedActivityWithinCap = [authorityWebA, authorityWebB].every((web) =>
      card5AuthorityActivityWithinCap(web?.workspaceEvidence?.authorityActivity),
    );
    const sealedA = sealCard5TuiFocusAuthority(
      authorityWebA?.workspaceEvidence?.authority,
      authorityWebA?.generation,
      evidenceKey,
    );
    const sealedB = sealCard5TuiFocusAuthority(
      authorityWebB?.workspaceEvidence?.authority,
      authorityWebB?.generation,
      evidenceKey,
    );
    const retainedMerge = mergeCard5SemanticAuthorityEvidence(
      sealedA,
      sealedB,
      acceptedAuthorityEvidence.authorityRevision,
    );
    if (
      retainedMerge.status === "exact" &&
      retainedActivityWithinCap &&
      retainedMerge.evidence.authorityHmac === acceptedAuthorityEvidence.authorityHmac &&
      retainedMerge.evidence.authorityOwnerHmac === acceptedAuthorityEvidence.authorityOwnerHmac &&
      retainedMerge.evidence.authorityTopologyHmac ===
        acceptedAuthorityEvidence.authorityTopologyHmac
    ) {
      retainedAuthorityEvidence = retainedMerge.evidence;
      break;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  if (retainedAuthorityEvidence === null) {
    const error = new Error("Card5 retained focus authority changed before handoff");
    error.observation = boundedCard5TuiFocusFailureObservation({
      reason: "focus-convergence-changed",
      axes: { authority: true },
    });
    throw error;
  }
  const transitions = [];
  const ownerReleaseEvidence = [];
  for (const [ordinal, step] of steps.entries()) {
    const marker = `CARD5_HANDOFF_${ordinal}_${randomBytes(4).toString("hex")}`;
    const priorOwnerPage = ordinal === 2 ? hosts.chromiumPage : hosts.electronPage;
    await clickExactSurface(priorOwnerPage);
    let before = null;
    const ownerDeadline = Date.now() + 1_000;
    while (Date.now() < ownerDeadline) {
      before = requireExpectedWeb(
        await observeCard5WebCanonical(
          hosts.chromiumPage,
          evidenceKey,
          hosts.chromiumProcessIdentity,
        ),
      );
      if (before?.workspaceEvidence?.authority?.owners?.input !== null) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    let beforeOwner;
    let authorityBoundary = before?.workspaceEvidence?.authorityRecordCount ?? null;
    const ownerObservation = await observeCard5WithinDeadline(
      () =>
        Promise.all([
          observeCard5WebCanonical(hosts.chromiumPage, evidenceKey, hosts.chromiumProcessIdentity),
          observeCard5WebCanonical(hosts.electronPage, evidenceKey, hosts.electronProcessIdentity),
        ]),
      { deadline: performance.now() + 1_000 },
    );
    if (ownerObservation.status !== "ok") {
      throw new Error("Card5 current authority owner tuple was unavailable");
    }
    const ownerSamples = ownerObservation.value.map(requireExpectedWeb);
    const ownerAuthorities = ownerSamples.map((sample) => sample?.workspaceEvidence?.authority);
    const ownerAuthority = ownerAuthorities[0];
    const canonicalOwnerTuple = (authority) =>
      authority === null || authority === undefined
        ? null
        : JSON.stringify({
            generation: authority.generation,
            session: authority.session,
            revision: authority.revision,
            owners: {
              input: authority.owners?.input,
              focus: authority.owners?.focus,
              geometry: authority.owners?.geometry,
            },
            nativeGeometryYieldUntilMs: authority.nativeGeometryYieldUntilMs,
            clients: Array.isArray(authority.clients)
              ? [...authority.clients]
                  .map((client) => ({
                    clientId: client.clientId,
                    surface: client.surface,
                    state: client.state,
                    connectedRevision: client.connectedRevision,
                    activityRevision: client.activityRevision,
                  }))
                  .sort((left, right) => left.clientId.localeCompare(right.clientId))
              : null,
          });
    const canonicalOwnerAuthority = canonicalOwnerTuple(ownerAuthority);
    if (
      ownerAuthority === null ||
      ownerAuthority === undefined ||
      canonicalOwnerAuthority === null ||
      canonicalOwnerAuthority !== canonicalOwnerTuple(ownerAuthorities[1]) ||
      ownerAuthority.generation !== ownerSamples[0].generation ||
      ownerAuthority.session !== ownerAuthorities[1]?.session ||
      !Number.isSafeInteger(ownerAuthority.revision) ||
      ownerAuthority.revision < retainedAuthorityEvidence.authorityRevision ||
      !["input", "focus", "geometry"].every((authority) => {
        const owner = ownerAuthority.owners?.[authority];
        return (
          owner === null ||
          ownerAuthority.clients?.filter(({ clientId }) => clientId === owner).length === 1
        );
      })
    ) {
      const error = new Error("Card5 current authority owner tuple diverged across Web views");
      error.observation = boundedCard5TuiFocusFailureObservation({
        reason: "focus-owner-tuple-mismatch",
        axes: { authority: true },
      });
      throw error;
    }
    const ownerTuiClients = ownerAuthority.clients.filter(({ surface }) => surface === "opentui");
    if (ownerTuiClients.length !== 1) {
      throw new Error("Card5 current authority owner tuple had no exact OpenTUI client");
    }
    const ownerTuiClientId = ownerTuiClients[0].clientId;
    const tuiOwnedAuthorities = ["input", "focus", "geometry"].filter(
      (authority) => ownerAuthority.owners[authority] === ownerTuiClientId,
    );
    beforeOwner = ownerAuthority.owners.input;
    authorityBoundary = ownerSamples[0]?.workspaceEvidence?.authorityRecordCount ?? null;
    if (beforeOwner === null || !Number.isSafeInteger(authorityBoundary)) {
      throw new Error("Card5 current authority owner tuple had no exact input owner boundary");
    }
    let tuiFocus = null;
    let tuiInputMark = null;
    let postBlurAuthorityEvidence = null;
    let postBlurAuthorityGrant = null;
    let tuiFocusTransition = null;
    let focusTransitionMark = null;
    let focusTransitionReceipts = null;
    let baselineClaimOrdinal = null;
    let blurTransitionAssessment = null;
    let blurTransitionMark = null;
    let priorBlurRecords = [];
    let blurReceipt = null;
    let hostFocusBinding = null;
    let hostFocusBindingHmac = null;
    let currentFocusBeforeBlur = null;
    let focusReferenceMark;
    const releaseTransactionDeadline = performance.now() + 2_000;
    const tuiCanonicalBeforeInput =
      ordinal === 0 || tuiOwnedAuthorities.length > 0
        ? latestCard5TuiCanonical(hosts.tuiEvidence, expectedPane)
        : null;
    if (ordinal === 0 || tuiOwnedAuthorities.length > 0) {
      currentFocusBeforeBlur =
        ordinal === 0
          ? null
          : assessCard5TuiFocusedPane({
              records: hosts.tuiEvidence.reader.recordsThrough(hosts.tuiEvidence.reader.mark()),
              expectedPane,
              expectedCanonical: tuiCanonicalBeforeInput,
              evidenceKey,
            });
      const canonicalHmac =
        tuiCanonicalBeforeInput === null
          ? null
          : card5EvidenceHmac(
              "focused-canonical-identity",
              [
                tuiCanonicalBeforeInput.generation,
                tuiCanonicalBeforeInput.incarnation,
                tuiCanonicalBeforeInput.revision,
                tuiCanonicalBeforeInput.canonicalStateHash,
                tuiCanonicalBeforeInput.cols,
                tuiCanonicalBeforeInput.rows,
              ].join("\0"),
              evidenceKey,
            );
      if (
        !acceptedFocusEvidence ||
        tuiCanonicalBeforeInput === null ||
        card5EvidenceHmac("pane", expectedPane, evidenceKey) !== acceptedFocusEvidence.paneHmac ||
        card5EvidenceHmac("process", tuiCanonicalBeforeInput.processId, evidenceKey) !==
          acceptedFocusEvidence.processHmac ||
        card5EvidenceHmac("clock", tuiCanonicalBeforeInput.clockId, evidenceKey) !==
          acceptedFocusEvidence.clockHmac ||
        tuiCanonicalBeforeInput.generation !== ownerAuthority.generation ||
        typeof tuiCanonicalBeforeInput.incarnation !== "string" ||
        !Number.isSafeInteger(tuiCanonicalBeforeInput.revision) ||
        tuiCanonicalBeforeInput.revision < acceptedFocusEvidence.revision ||
        !/^[0-9a-f]{16}$/u.test(tuiCanonicalBeforeInput.canonicalStateHash ?? "") ||
        !Number.isSafeInteger(tuiCanonicalBeforeInput.cols) ||
        tuiCanonicalBeforeInput.cols < 1 ||
        !Number.isSafeInteger(tuiCanonicalBeforeInput.rows) ||
        tuiCanonicalBeforeInput.rows < 1 ||
        (ordinal === 0 &&
          (canonicalHmac !== acceptedFocusEvidence.canonicalHmac ||
            tuiCanonicalBeforeInput.revision !== acceptedFocusEvidence.revision ||
            tuiCanonicalBeforeInput.cols !== acceptedFocusEvidence.cols ||
            tuiCanonicalBeforeInput.rows !== acceptedFocusEvidence.rows)) ||
        (ordinal > 0 &&
          (!currentFocusBeforeBlur?.passed ||
            currentFocusBeforeBlur.evidence.paneHmac !== acceptedFocusEvidence.paneHmac ||
            currentFocusBeforeBlur.evidence.processHmac !== acceptedFocusEvidence.processHmac ||
            currentFocusBeforeBlur.evidence.clockHmac !== acceptedFocusEvidence.clockHmac ||
            currentFocusBeforeBlur.evidence.canonicalHmac !== canonicalHmac))
      ) {
        throw new Error("Card5 OpenTUI focused-pane convergence proof changed");
      }
      const bindingDeadline = Math.min(releaseTransactionDeadline, performance.now() + 1_000);
      let bindingSelection = null;
      let bindingCandidate = null;
      let bindingStableSamples = 0;
      let referenceTailStable = false;
      let lifecycleTailStable = false;
      while (performance.now() < bindingDeadline) {
        const bindingFrames = hosts.tuiEvidence.drainBindingSourcesOnce();
        if (performance.now() >= bindingDeadline) break;
        const referenceBefore = hosts.tuiEvidence.reader.snapshot();
        const lifecycleBefore = hosts.tuiEvidence.lifecycleReader.snapshot();
        const currentCanonical = bindingFrames.latest(expectedPane);
        if (performance.now() >= bindingDeadline) break;
        const observedBinding = await observeCard5WithinDeadline(
          () =>
            Promise.all([
              observeCard5WebCanonical(
                hosts.chromiumPage,
                evidenceKey,
                hosts.chromiumProcessIdentity,
              ),
              observeCard5WebCanonical(
                hosts.electronPage,
                evidenceKey,
                hosts.electronProcessIdentity,
              ),
            ]),
          { deadline: bindingDeadline },
        );
        if (observedBinding.status !== "ok" || performance.now() >= bindingDeadline) break;
        const currentWeb = observedBinding.value.map(requireExpectedWeb);
        const currentAuthorities = currentWeb.map((sample) => sample?.workspaceEvidence?.authority);
        const currentAuthorityTuple = canonicalOwnerTuple(currentAuthorities[0]);
        hosts.tuiEvidence.drainBindingSourcesOnce();
        if (performance.now() >= bindingDeadline) break;
        const referenceAfter = hosts.tuiEvidence.reader.snapshot();
        const lifecycleAfter = hosts.tuiEvidence.lifecycleReader.snapshot();
        referenceTailStable =
          hosts.tuiEvidence.reader.confirmCaughtUp() &&
          referenceBefore.offset === referenceAfter.offset &&
          referenceBefore.recordCount === referenceAfter.recordCount;
        lifecycleTailStable =
          hosts.tuiEvidence.lifecycleReader.confirmCaughtUp() &&
          lifecycleBefore.offset === lifecycleAfter.offset &&
          lifecycleBefore.recordCount === lifecycleAfter.recordCount;
        const sourcesStable = referenceTailStable && lifecycleTailStable;
        const currentExact =
          sourcesStable &&
          currentCanonical !== null &&
          currentCanonical.semanticPaneId === expectedPane &&
          currentCanonical.processId === tuiCanonicalBeforeInput.processId &&
          currentCanonical.clockId === tuiCanonicalBeforeInput.clockId &&
          currentCanonical.generation === tuiCanonicalBeforeInput.generation &&
          currentCanonical.incarnation === tuiCanonicalBeforeInput.incarnation &&
          currentCanonical.revision === tuiCanonicalBeforeInput.revision &&
          currentCanonical.canonicalStateHash === tuiCanonicalBeforeInput.canonicalStateHash &&
          currentAuthorityTuple !== null &&
          currentAuthorityTuple === canonicalOwnerTuple(currentAuthorities[1]) &&
          currentAuthorityTuple === canonicalOwnerAuthority;
        const selected = selectCard5TuiHostFocusBinding({
          lifecycleRecords: hosts.tuiEvidence.lifecycleReader.recordsThrough(
            hosts.tuiEvidence.lifecycleReader.mark(),
          ),
          referenceRecords: hosts.tuiEvidence.reader.recordsThrough(
            hosts.tuiEvidence.reader.mark(),
          ),
          expectedCanonical: currentCanonical,
          expectedAuthority: currentAuthorities[0],
          expectedWorkspaceName: state.workspace,
          expectedTuiClientId: ownerTuiClientId,
          evidenceKey,
        });
        const candidate = JSON.stringify({
          currentExact,
          source: selected.source,
          binding: selected.binding,
          authority: currentAuthorityTuple,
          referenceOffset: referenceAfter.offset,
          referenceRecords: referenceAfter.recordCount,
          lifecycleOffset: lifecycleAfter.offset,
          lifecycleRecords: lifecycleAfter.recordCount,
        });
        if (performance.now() >= bindingDeadline) break;
        if (currentExact && selected.passed) {
          bindingStableSamples = candidate === bindingCandidate ? bindingStableSamples + 1 : 1;
          bindingCandidate = candidate;
          bindingSelection = selected;
          if (bindingStableSamples >= 2) break;
        } else {
          bindingStableSamples = 0;
          bindingCandidate = null;
          bindingSelection = selected;
        }
        const remaining = bindingDeadline - performance.now();
        if (remaining <= 0) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(5, remaining)));
      }
      blurTransitionMark = hosts.tuiEvidence.lifecycleReader.mark();
      priorBlurRecords = hosts.tuiEvidence.lifecycleReader.recordsThrough(blurTransitionMark);
      if (!bindingSelection?.passed || bindingStableSamples < 2) {
        const error = new Error("Card5 OpenTUI host-focus control binding was unavailable");
        error.observation = Object.freeze({
          ...(bindingSelection?.observation ?? {
            bindingSource: null,
            reason: "binding-source-unavailable",
            gateCount: 0,
            gateOverflow: false,
            gateSchemaMismatch: false,
            gateProcessMismatch: false,
            gateClockMismatch: false,
            gateCapability: false,
            gateDetail: false,
            gatePath: false,
            gateRoot: false,
            gateKey: false,
            gateTrace: false,
            gateEnabled: false,
            relevantCount: 0,
            overflow: false,
            processMismatch: false,
            clockMismatch: false,
            generationMismatch: false,
            sessionMismatch: false,
            workspaceMismatch: false,
            clientMismatch: false,
            epochMismatch: false,
            clientGenerationMismatch: false,
            diagnosticEpochMismatch: false,
            statusMismatch: false,
            presenceMismatch: false,
            revisionRelationMismatch: false,
            receiptMismatch: false,
            ownerMismatch: false,
            authorityOutcome: Object.freeze({
              input: "missing-record",
              focus: "missing-record",
              geometry: "missing-record",
            }),
            allTuiOwners: null,
            recordHmac: null,
          }),
          referenceTailStable,
          lifecycleTailStable,
          stableSamples: bindingStableSamples,
        });
        throw error;
      }
      hostFocusBinding = Object.freeze({
        generation: ownerAuthority.generation,
        runtimeSession: ownerAuthority.session,
        workspaceName: state.workspace,
        semanticPaneId: expectedPane,
        clientId: ownerTuiClientId,
        rendererEpoch: bindingSelection.binding.rendererEpoch,
        clientGeneration: bindingSelection.binding.clientGeneration,
        bindingEpoch: bindingSelection.binding.bindingEpoch,
        processId: tuiCanonicalBeforeInput.processId,
      });
      hostFocusBindingHmac = card5EvidenceHmac(
        "host-focus-control-binding",
        JSON.stringify(hostFocusBinding),
        evidenceKey,
      );
      if (ordinal === 0) focusTransitionMark = blurTransitionMark;
      baselineClaimOrdinal = hosts.tuiEvidence.lifecycleReader
        .recordsThrough(blurTransitionMark)
        .filter(
          (record) =>
            record?.phase === "terminal-host-focus-claim-attempt" &&
            Number.isSafeInteger(record?.claimOrdinal),
        )
        .reduce((latest, record) => Math.max(latest, record.claimOrdinal), 0);
      blurReceipt = await driveExactTuiFocus("blur", hostFocusBinding);
      if (ordinal === 0) focusTransitionReceipts = { blur: blurReceipt };
    }
    const expectedWebReleases = ["input", "focus", "geometry"].filter((authority) => {
      const owner = ownerAuthority.owners[authority];
      return ownerAuthority.clients.find(({ clientId }) => clientId === owner)?.surface === "web";
    });
    const releaseAssessmentFor = (results) =>
      assessCard5WebAuthorityRelease({
        results,
        expectedAuthorities: expectedWebReleases,
        workspaceHmac: card5EvidenceHmac("release-workspace", state.workspace, evidenceKey),
        generationHmac: card5EvidenceHmac(
          "release-generation",
          ownerAuthority.generation,
          evidenceKey,
        ),
        runtimeSessionHmac: card5EvidenceHmac(
          "release-runtime-session",
          ownerAuthority.session,
          evidenceKey,
        ),
        paneHmac: card5EvidenceHmac("release-pane", expectedPane, evidenceKey),
        requestHmacs: ownerSamples
          .map((sample) => sample.runtimeReplacement?.currentLifecycleRequest?.requestHmac)
          .filter((value) => typeof value === "string"),
        clientHmacs: Object.freeze(
          Object.fromEntries(
            ["input", "focus", "geometry"].map((authority) => [
              authority,
              card5EvidenceHmac("authority-client", ownerAuthority.owners[authority], evidenceKey),
            ]),
          ),
        ),
      });
    const releaseObservation = await observeCard5WithinDeadline(
      () =>
        Promise.all(
          [
            ["chromium", hosts.chromiumPage],
            ["electron", hosts.electronPage],
          ].map(([pageRole, page]) =>
            releaseCard5WebOwnedAuthorities(page, {
              workspaceName: state.workspace,
              generation: ownerAuthority.generation,
              runtimeSession: ownerAuthority.session,
              semanticPaneId: expectedPane,
              evidenceKey,
              pageHmac: card5EvidenceHmac("release-page", pageRole, evidenceKey),
            }),
          ),
        ),
      { deadline: releaseTransactionDeadline },
    );
    if (releaseObservation.status !== "ok") {
      const error = new Error("Card5 exact current Web authority release timed out");
      error.observation = boundedCard5TuiFocusFailureObservation({
        reason: "focus-web-release-invalid",
        axes: { authority: true },
        webRelease: releaseAssessmentFor([]).observation,
      });
      throw error;
    }
    const releaseResults = releaseObservation.value;
    const webReleaseReceipts = releaseResults.flatMap((result) => result?.receipts ?? []);
    const releaseAssessment = releaseAssessmentFor(releaseResults);
    if (
      releaseResults.some(({ status }) => status !== "exact") ||
      webReleaseReceipts.length !== expectedWebReleases.length ||
      expectedWebReleases.some(
        (authority) =>
          webReleaseReceipts.filter((receipt) => receipt.authority === authority).length !== 1,
      ) ||
      webReleaseReceipts.some(
        (receipt) =>
          receipt.status !== "released" ||
          !Number.isSafeInteger(receipt.operationOrdinal) ||
          receipt.operationOrdinal < 1 ||
          receipt.afterRevision <= receipt.beforeRevision ||
          receipt.workspaceHmac !==
            card5EvidenceHmac("release-workspace", state.workspace, evidenceKey) ||
          receipt.generationHmac !==
            card5EvidenceHmac("release-generation", ownerAuthority.generation, evidenceKey) ||
          receipt.runtimeSessionHmac !==
            card5EvidenceHmac("release-runtime-session", ownerAuthority.session, evidenceKey) ||
          receipt.paneHmac !== card5EvidenceHmac("release-pane", expectedPane, evidenceKey) ||
          !ownerSamples.some(
            (sample) =>
              receipt.requestHmac ===
              sample.runtimeReplacement?.currentLifecycleRequest?.requestHmac,
          ) ||
          receipt.clientHmac !==
            card5EvidenceHmac(
              "authority-client",
              ownerAuthority.owners[receipt.authority],
              evidenceKey,
            ),
      )
    ) {
      const error = new Error("Card5 exact current Web authority release did not settle");
      error.observation = boundedCard5TuiFocusFailureObservation({
        reason: "focus-web-release-invalid",
        axes: { authority: true },
        webRelease: releaseAssessment.observation,
      });
      throw error;
    }
    const expectedReleaseMap = ["input", "focus", "geometry"]
      .filter((authority) => ownerAuthority.owners[authority] !== null)
      .map((authority) => {
        const clientId = ownerAuthority.owners[authority];
        const surface = ownerAuthority.clients.find(
          (client) => client.clientId === clientId,
        )?.surface;
        const webReceipt = webReleaseReceipts.find((receipt) => receipt.authority === authority);
        return Object.freeze({
          authority,
          surface,
          clientHmac: card5EvidenceHmac("authority-client", clientId, evidenceKey),
          requestHmac: surface === "web" ? (webReceipt?.requestHmac ?? null) : null,
        });
      });
    const expectedReleaseMapHmac = card5EvidenceHmac(
      "handoff-expected-release-map",
      JSON.stringify(expectedReleaseMap),
      evidenceKey,
    );
    const expectedTuiReleaseCount = expectedReleaseMap.filter(
      ({ surface }) => surface === "opentui",
    ).length;
    const ownerReleaseSeal = card5EvidenceHmac(
      "handoff-owner-release-seal",
      `${canonicalOwnerAuthority}\0${expectedReleaseMapHmac}\0${expectedReleaseMap.length}\0${expectedWebReleases.length}\0${expectedTuiReleaseCount}`,
      evidenceKey,
    );
    let nullOwner = null;
    let nullOwnerObserved = false;
    let nullAuthorityEvidence = null;
    let nullAuthoritySnapshot = null;
    let nullRuntimeSession = null;
    const nullCandidates = [];
    const blurCandidates = [];
    let stableRelease = Object.freeze({ candidate: null, samples: 0, passed: false });
    while (performance.now() < releaseTransactionDeadline) {
      hosts.tuiEvidence.drain();
      const blurRecords =
        blurTransitionMark === null
          ? []
          : hosts.tuiEvidence.lifecycleReader.recordsSince(blurTransitionMark);
      blurTransitionAssessment =
        expectedTuiReleaseCount === 0
          ? Object.freeze({ passed: true, reason: null, evidence: null })
          : assessCard5TuiFocusTransition({
              records: blurRecords,
              priorBlurRecords,
              receipts: { blur: blurReceipt },
              expectedCanonical: tuiCanonicalBeforeInput,
              expectedBindingHmac: hostFocusBindingHmac,
              expectedWorkspaceName: state.workspace,
              expectedRendererEpoch: hostFocusBinding.rendererEpoch,
              expectedClientGeneration: hostFocusBinding.clientGeneration,
              expectedRuntimeSession: ownerAuthority.session,
              expectedAuthorityOwners: ownerAuthority.owners,
              expectedTuiClientId: ownerTuiClientId,
              minimumBlurAuthorityRevision: retainedAuthorityEvidence.authorityRevision,
              minimumFocusAuthorityRevision: retainedAuthorityEvidence.authorityRevision,
              baselineClaimOrdinal,
              evidenceKey,
              stage: "blur",
            });
      const blurObservation = boundedCard5TuiBlurTransitionObservation({
        assessment: blurTransitionAssessment,
        records: blurRecords,
        receipt: blurReceipt,
        evidenceKey,
      });
      blurCandidates.push(blurObservation);
      if (blurCandidates.length > 2) blurCandidates.shift();
      if (performance.now() >= releaseTransactionDeadline) break;
      const observedNull = await observeCard5WithinDeadline(
        () =>
          Promise.all([
            observeCard5WebCanonical(
              hosts.chromiumPage,
              evidenceKey,
              hosts.chromiumProcessIdentity,
            ),
            observeCard5WebCanonical(
              hosts.electronPage,
              evidenceKey,
              hosts.electronProcessIdentity,
            ),
          ]),
        { deadline: releaseTransactionDeadline },
      );
      if (observedNull.status !== "ok") break;
      if (performance.now() >= releaseTransactionDeadline) break;
      const samples = observedNull.value;
      samples.forEach(requireExpectedWeb);
      const authorities = samples.map((sample) => sample?.workspaceEvidence?.authority);
      nullOwner = authorities[0]?.owners?.input ?? null;
      const releaseRevisions = [
        ...(blurTransitionAssessment?.evidence?.blurReceiptRevision === undefined ||
        blurTransitionAssessment?.evidence?.blurReceiptRevision === null
          ? []
          : [blurTransitionAssessment.evidence.blurReceiptRevision]),
        ...webReleaseReceipts.map(({ afterRevision }) => afterRevision),
      ];
      const nullAssessment = assessCard5NullAuthorityPair({
        authorities,
        generations: samples.map((sample) => sample?.generation),
        minimumRevision: retainedAuthorityEvidence.authorityRevision,
        releaseRevisions,
        evidenceKey,
      });
      nullCandidates.push(nullAssessment.observation);
      if (nullCandidates.length > 2) nullCandidates.shift();
      const candidate = JSON.stringify({
        blur: blurObservation,
        null: nullAssessment.observation,
      });
      stableRelease = advanceCard5AuthorityReleaseStability(
        stableRelease,
        candidate,
        blurTransitionAssessment.passed && nullAssessment.passed,
      );
      nullOwnerObserved = stableRelease.passed;
      if (nullOwnerObserved) {
        nullAuthorityEvidence = nullAssessment.evidence;
        nullAuthoritySnapshot = authorities[0];
        nullRuntimeSession = authorities[0].session;
        if (ordinal === 0) initialNullAuthorityEvidence = nullAssessment.evidence;
      }
      if (nullOwnerObserved) break;
      const remaining = releaseTransactionDeadline - performance.now();
      if (remaining <= 0) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(10, remaining)));
    }
    if (
      !nullOwnerObserved ||
      nullAuthorityEvidence === null ||
      nullAuthoritySnapshot === null ||
      typeof nullRuntimeSession !== "string" ||
      performance.now() >= releaseTransactionDeadline
    ) {
      const error = new Error("Card5 authority release transaction did not reach a stable null");
      error.observation = boundedCard5TuiFocusFailureObservation({
        reason: "focus-release-unsettled",
        axes: { authority: true },
      });
      error.observation = Object.freeze({
        ...error.observation,
        blurCandidates: Object.freeze([...blurCandidates]),
        nullCandidates: Object.freeze([...nullCandidates]),
      });
      throw error;
    }
    if (expectedTuiReleaseCount > 0) {
      const tuiCanonicalAfterBlur = latestCard5TuiCanonical(hosts.tuiEvidence, expectedPane);
      const currentFocusAfterBlur =
        ordinal === 0
          ? null
          : assessCard5TuiFocusedPane({
              records: hosts.tuiEvidence.reader.recordsThrough(hosts.tuiEvidence.reader.mark()),
              expectedPane,
              expectedCanonical: tuiCanonicalAfterBlur,
              evidenceKey,
            });
      if (
        tuiCanonicalAfterBlur === null ||
        [
          "generation",
          "incarnation",
          "processId",
          "clockId",
          "revision",
          "canonicalStateHash",
          "cols",
          "rows",
        ].some((field) => tuiCanonicalAfterBlur[field] !== tuiCanonicalBeforeInput[field]) ||
        (ordinal > 0 &&
          (!currentFocusAfterBlur?.passed ||
            [
              "paneHmac",
              "processHmac",
              "clockHmac",
              "canonicalHmac",
              "focusStateHmac",
              "revision",
              "cols",
              "rows",
              "viewportCols",
              "viewportRows",
            ].some(
              (field) =>
                currentFocusAfterBlur.evidence[field] !== currentFocusBeforeBlur.evidence[field],
            )))
      ) {
        throw new Error("Card5 OpenTUI canonical state changed across explicit blur release");
      }
    }
    const authorityReleaseEvidence = Object.freeze({
      ownerTupleHmac: card5EvidenceHmac(
        "handoff-owner-tuple",
        canonicalOwnerAuthority,
        evidenceKey,
      ),
      ownerRevision: ownerAuthority.revision,
      ownerReleaseSeal,
      expectedReleaseMapHmac,
      expectedReleaseCount: expectedReleaseMap.length,
      expectedWebReleaseCount: expectedWebReleases.length,
      expectedTuiReleaseCount,
      tuiBlurSettlementHmac: blurTransitionAssessment?.evidence?.blurSettlementHmac ?? null,
      tuiBlurRevision: blurTransitionAssessment?.evidence?.blurReceiptRevision ?? null,
      tuiBlurClientHmac: blurTransitionAssessment?.evidence?.clientHmac ?? null,
      receipts: Object.freeze(webReleaseReceipts.map((receipt) => Object.freeze({ ...receipt }))),
    });
    ownerReleaseEvidence.push(
      Object.freeze({
        ownerTupleHmac: authorityReleaseEvidence.ownerTupleHmac,
        ownerReleaseSeal,
        expectedReleaseMapHmac,
        expectedReleaseCount: expectedReleaseMap.length,
        expectedWebReleaseCount: expectedWebReleases.length,
        expectedTuiReleaseCount,
        tuiBlurSettlementHmac: authorityReleaseEvidence.tuiBlurSettlementHmac,
        tuiBlurRevision: authorityReleaseEvidence.tuiBlurRevision,
        tuiBlurClientHmac: authorityReleaseEvidence.tuiBlurClientHmac,
        expectedReleases: Object.freeze(expectedReleaseMap),
      }),
    );
    hosts.tuiEvidence.drain();
    const inputFencesBefore = hosts.tuiEvidence.inputFenceCount();
    const handoffInput = card5HandoffInputPayload(marker);
    if (handoffInput === null) throw new Error("Card5 handoff input payload was invalid");
    const inputSha256 = handoffInput.sha256;
    if (ordinal === 0) {
      hosts.tuiEvidence.drain();
      focusReferenceMark = hosts.tuiEvidence.reader.mark();
      const focusReceipt = await driveExactTuiFocus("focus", hostFocusBinding);
      let transitionAssessment = null;
      const focusTransitionDeadline = performance.now() + 1_000;
      while (performance.now() < focusTransitionDeadline) {
        hosts.tuiEvidence.drain();
        transitionAssessment = assessCard5TuiFocusTransition({
          records: hosts.tuiEvidence.lifecycleReader.recordsSince(focusTransitionMark),
          receipts: { ...focusTransitionReceipts, focus: focusReceipt },
          expectedCanonical: tuiCanonicalBeforeInput,
          priorBlurRecords,
          expectedBindingHmac: hostFocusBindingHmac,
          expectedWorkspaceName: state.workspace,
          expectedRendererEpoch: hostFocusBinding.rendererEpoch,
          expectedClientGeneration: hostFocusBinding.clientGeneration,
          expectedRuntimeSession: nullRuntimeSession,
          expectedAuthorityOwners: ownerAuthority.owners,
          expectedTuiClientId: ownerTuiClientId,
          minimumBlurAuthorityRevision: retainedAuthorityEvidence.authorityRevision,
          minimumFocusAuthorityRevision: nullAuthorityEvidence.authorityRevision,
          baselineClaimOrdinal,
          evidenceKey,
          stage: "focus",
        });
        if (transitionAssessment.passed) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      }
      if (!transitionAssessment?.passed) {
        const error = new Error("Card5 OpenTUI explicit focus claim did not settle");
        error.observation = boundedCard5TuiFocusFailureObservation({
          reason: transitionAssessment?.reason ?? "focus-claim-lifecycle-invalid",
          axes: { authority: true },
        });
        throw error;
      }
      const duplicateFocusReceipt = await driveExactTuiFocus("focus", hostFocusBinding);
      focusTransitionReceipts = Object.freeze({
        ...focusTransitionReceipts,
        focus: focusReceipt,
        duplicateFocus: duplicateFocusReceipt,
      });
      const focusAuthorityDeadline = performance.now() + 1_000;
      while (performance.now() < focusAuthorityDeadline) {
        const focusObservation = await observeCard5WithinDeadline(
          () =>
            Promise.all([
              observeCard5WebCanonical(
                hosts.chromiumPage,
                evidenceKey,
                hosts.chromiumProcessIdentity,
              ),
              observeCard5WebCanonical(
                hosts.electronPage,
                evidenceKey,
                hosts.electronProcessIdentity,
              ),
            ]),
          { deadline: focusAuthorityDeadline },
        );
        if (focusObservation.status !== "ok") break;
        const [focusedA, focusedB] = focusObservation.value;
        requireExpectedWeb(focusedA);
        requireExpectedWeb(focusedB);
        const sealedA = sealCard5TuiFocusAuthority(
          focusedA.workspaceEvidence?.authority,
          tuiCanonicalBeforeInput.generation,
          evidenceKey,
        );
        const sealedB = sealCard5TuiFocusAuthority(
          focusedB.workspaceEvidence?.authority,
          tuiCanonicalBeforeInput.generation,
          evidenceKey,
        );
        const exactFocusAuthority =
          sealedA !== null &&
          sealedB !== null &&
          sealedA.authorityHmac === sealedB.authorityHmac &&
          sealedA.authorityRevision === sealedB.authorityRevision &&
          sealedA.authorityTopologyHmac === sealedB.authorityTopologyHmac &&
          sealedA.authorityOwnerHmac === sealedB.authorityOwnerHmac &&
          sealedA.authorityRevision > retainedAuthorityEvidence.authorityRevision;
        if (exactFocusAuthority) {
          const records = (focusedA.workspaceEvidence?.authorityRecords ?? []).filter(
            ({ ordinal: recordOrdinal }) =>
              Number.isSafeInteger(authorityBoundary) && recordOrdinal > authorityBoundary,
          );
          const nullIndex = records.findIndex(({ inputOwner }) => inputOwner === null);
          const grant = records.find(
            ({ inputOwner, revision, clients }, recordIndex) =>
              recordIndex > nullIndex &&
              inputOwner !== null &&
              revision === sealedA.authorityRevision &&
              clients?.some(
                ({ clientId, surface }) => clientId === inputOwner && surface === "opentui",
              ) &&
              card5EvidenceHmac("focused-authority-owner", inputOwner, evidenceKey) ===
                sealedA.authorityOwnerHmac,
          );
          if (nullIndex >= 0 && grant) {
            postBlurAuthorityEvidence = sealedA;
            postBlurAuthorityGrant = grant;
            break;
          }
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      }
      if (postBlurAuthorityEvidence === null) {
        const error = new Error("Card5 OpenTUI did not acquire exact input and focus authority");
        error.observation = boundedCard5TuiFocusFailureObservation({
          reason: "focus-authority-unowned",
          axes: { authority: true },
        });
        throw error;
      }
      const retainedFocusDeadline = releaseTransactionDeadline;
      let retainedFocusAssessment = null;
      let retainedFocusStability = Object.freeze({ candidate: null, samples: 0, passed: false });
      let retainedFocusMark = null;
      while (performance.now() < retainedFocusDeadline) {
        const retainedFrames = hosts.tuiEvidence.drainBindingSourcesOnce();
        if (performance.now() >= retainedFocusDeadline) break;
        const referenceBefore = hosts.tuiEvidence.reader.snapshot();
        const lifecycleBefore = hosts.tuiEvidence.lifecycleReader.snapshot();
        const candidateMark = hosts.tuiEvidence.reader.mark();
        const currentCanonical = retainedFrames.latest(expectedPane);
        retainedFocusAssessment = assessCard5TuiRetainedFocus({
          records: hosts.tuiEvidence.reader.recordsSince(focusReferenceMark),
          expectedPane,
          expectedCanonical: tuiCanonicalBeforeInput,
          acceptedFocusEvidence,
          expectedDiagnosticEpoch: focusReceipt.diagnosticEpoch,
          expectedRendererEpoch: hostFocusBinding.rendererEpoch,
          evidenceKey,
        });
        if (performance.now() >= retainedFocusDeadline) break;
        const observed = await observeCard5WithinDeadline(
          () =>
            Promise.all([
              observeCard5WebCanonical(
                hosts.chromiumPage,
                evidenceKey,
                hosts.chromiumProcessIdentity,
              ),
              observeCard5WebCanonical(
                hosts.electronPage,
                evidenceKey,
                hosts.electronProcessIdentity,
              ),
            ]),
          { deadline: retainedFocusDeadline },
        );
        if (observed.status !== "ok" || performance.now() >= retainedFocusDeadline) break;
        const currentWeb = observed.value.map(requireExpectedWeb);
        const currentAuthorities = currentWeb.map((sample) => sample?.workspaceEvidence?.authority);
        const sealedA = sealCard5TuiFocusAuthority(
          currentAuthorities[0],
          tuiCanonicalBeforeInput.generation,
          evidenceKey,
        );
        const sealedB = sealCard5TuiFocusAuthority(
          currentAuthorities[1],
          tuiCanonicalBeforeInput.generation,
          evidenceKey,
        );
        const selectedBinding = selectCard5TuiHostFocusBinding({
          lifecycleRecords: hosts.tuiEvidence.lifecycleReader.recordsThrough(
            hosts.tuiEvidence.lifecycleReader.mark(),
          ),
          referenceRecords: hosts.tuiEvidence.reader.recordsThrough(candidateMark),
          expectedCanonical: currentCanonical,
          expectedAuthority: currentAuthorities[0],
          expectedWorkspaceName: state.workspace,
          expectedTuiClientId: ownerTuiClientId,
          evidenceKey,
        });
        hosts.tuiEvidence.drainBindingSourcesOnce();
        if (performance.now() >= retainedFocusDeadline) break;
        const referenceAfter = hosts.tuiEvidence.reader.snapshot();
        const lifecycleAfter = hosts.tuiEvidence.lifecycleReader.snapshot();
        const tailsStable =
          hosts.tuiEvidence.reader.confirmCaughtUp() &&
          hosts.tuiEvidence.lifecycleReader.confirmCaughtUp() &&
          referenceBefore.offset === referenceAfter.offset &&
          referenceBefore.recordCount === referenceAfter.recordCount &&
          lifecycleBefore.offset === lifecycleAfter.offset &&
          lifecycleBefore.recordCount === lifecycleAfter.recordCount;
        const authorityStable =
          sealedA !== null &&
          sealedB !== null &&
          sealedA.authorityHmac === postBlurAuthorityEvidence.authorityHmac &&
          sealedA.authorityHmac === sealedB.authorityHmac &&
          sealedA.authorityRevision === postBlurAuthorityEvidence.authorityRevision &&
          sealedA.authorityRevision === sealedB.authorityRevision &&
          sealedA.authorityTopologyHmac === postBlurAuthorityEvidence.authorityTopologyHmac &&
          sealedA.authorityTopologyHmac === sealedB.authorityTopologyHmac &&
          sealedA.authorityOwnerHmac === postBlurAuthorityEvidence.authorityOwnerHmac &&
          sealedA.authorityOwnerHmac === sealedB.authorityOwnerHmac;
        const bindingStable =
          selectedBinding.passed &&
          selectedBinding.binding.rendererEpoch === hostFocusBinding.rendererEpoch &&
          selectedBinding.binding.clientGeneration === hostFocusBinding.clientGeneration &&
          selectedBinding.binding.bindingEpoch === hostFocusBinding.bindingEpoch;
        const canonicalStable =
          currentCanonical !== null &&
          currentCanonical.semanticPaneId === expectedPane &&
          currentCanonical.processId === tuiCanonicalBeforeInput.processId &&
          currentCanonical.clockId === tuiCanonicalBeforeInput.clockId &&
          currentCanonical.generation === tuiCanonicalBeforeInput.generation &&
          currentCanonical.incarnation === tuiCanonicalBeforeInput.incarnation &&
          currentCanonical.revision === tuiCanonicalBeforeInput.revision &&
          currentCanonical.canonicalStateHash === tuiCanonicalBeforeInput.canonicalStateHash &&
          currentCanonical.cols === tuiCanonicalBeforeInput.cols &&
          currentCanonical.rows === tuiCanonicalBeforeInput.rows;
        const qualified =
          retainedFocusAssessment.passed &&
          tailsStable &&
          authorityStable &&
          bindingStable &&
          canonicalStable;
        const candidate = JSON.stringify({
          focus: retainedFocusAssessment.candidate,
          authorityHmac: sealedA?.authorityHmac ?? null,
          authorityRevision: sealedA?.authorityRevision ?? null,
          authorityTopologyHmac: sealedA?.authorityTopologyHmac ?? null,
          bindingSource: selectedBinding.source,
          rendererEpoch: selectedBinding.binding?.rendererEpoch ?? null,
          clientGeneration: selectedBinding.binding?.clientGeneration ?? null,
          bindingEpoch: selectedBinding.binding?.bindingEpoch ?? null,
          canonicalRevision: currentCanonical?.revision ?? null,
          canonicalHashHmac:
            currentCanonical === null
              ? null
              : card5EvidenceHmac(
                  "retained-canonical",
                  currentCanonical.canonicalStateHash,
                  evidenceKey,
                ),
          referenceOffset: referenceAfter.offset,
          referenceRecordCount: referenceAfter.recordCount,
          lifecycleOffset: lifecycleAfter.offset,
          lifecycleRecordCount: lifecycleAfter.recordCount,
        });
        if (performance.now() >= retainedFocusDeadline) break;
        retainedFocusStability = advanceCard5RetainedFocusStability(
          retainedFocusStability,
          candidate,
          qualified,
        );
        if (retainedFocusStability.passed) {
          retainedFocusMark = candidateMark;
          break;
        } else if (qualified) {
          retainedFocusMark = candidateMark;
        } else {
          retainedFocusMark = null;
        }
        const remaining = retainedFocusDeadline - performance.now();
        if (remaining <= 0) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(5, remaining)));
      }
      if (
        !retainedFocusAssessment?.passed ||
        !retainedFocusStability.passed ||
        retainedFocusMark === null
      ) {
        const error = new Error("Card5 retained OpenTUI focus state changed before handoff input");
        error.observation = boundedCard5TuiFocusFailureObservation({
          reason: "focus-convergence-changed",
          axes: retainedFocusAssessment?.axes,
          candidate: retainedFocusAssessment?.candidate,
        });
        throw error;
      }
      tuiInputMark = retainedFocusMark;
      tuiFocus = Object.freeze({
        canonical: tuiCanonicalBeforeInput,
        evidence: retainedFocusAssessment.evidence,
      });
    }
    if (ordinal !== 0) hosts.tuiEvidence.drain();
    // The Web transport has two independent source-defined 2s phases:
    // authority settlement and the input acknowledgement. Activation reserves
    // both before dispatch and uses the remainder only for exact preflight.
    const inputDeadline = performance.now() + 6_000;
    const tuiInputReceipt = await step(handoffInput, inputDeadline);
    const receiptBoundary = ordinal === 0 ? null : tuiInputReceipt?.receiptBoundary;
    if (
      ordinal > 0 &&
      (!Number.isSafeInteger(receiptBoundary) ||
        !Number.isSafeInteger(tuiInputReceipt?.receiptOrdinal) ||
        typeof tuiInputReceipt?.authorityClientId !== "string" ||
        !/^[0-9a-f]{64}$/u.test(tuiInputReceipt?.requestHmac ?? ""))
    ) {
      const error = new Error("Card5 exact Web activation receipt changed before handoff join");
      error.observation = Object.freeze({
        operation: "card5-web-terminal-input",
        reason: "activation-receipt-invalid",
      });
      throw error;
    }
    const deadline = Date.now() + 3_000;
    let markerPresent = false;
    while (Date.now() < deadline) {
      const captureResult = runExactCard5TmuxPaneCapture({
        latchedBinding: capturedTmuxPaneBinding,
        observeBinding: observeTmuxPaneBinding,
        capture: (captureArgv) =>
          execFileSync("tmux", ["-S", state.runtimeNamespace.tmuxSocketPath, ...captureArgv], {
            encoding: "utf8",
            maxBuffer: 4 * 1_024 * 1_024,
          }),
      });
      if (captureResult.status !== "ok") throw failTmuxPaneBinding();
      const body = captureResult.value;
      if (body.includes(marker)) {
        markerPresent = true;
        break;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    let after;
    let authorityRecords = [];
    let grantRecord = null;
    let exactInputReceipt = null;
    let tuiInputTrace = null;
    let authorityJoinObservation = null;
    let authorityPreconditionObservation = null;
    let authorityPreconditionHistory = null;
    const authorityDeadline = Date.now() + 3_000;
    while (Date.now() < authorityDeadline) {
      const observationRemainingMs = authorityDeadline - Date.now();
      if (observationRemainingMs <= 0) break;
      const webObservationDeadline = performance.now() + observationRemainingMs;
      const currentWebResults = await Promise.all([
        observeCard5WithinDeadline(
          () =>
            observeCard5WebAuthorityReceipt(
              hosts.chromiumPage,
              evidenceKey,
              hosts.chromiumProcessIdentity,
            ),
          { deadline: webObservationDeadline },
        ),
        observeCard5WithinDeadline(
          () =>
            observeCard5WebAuthorityReceipt(
              hosts.electronPage,
              evidenceKey,
              hosts.electronProcessIdentity,
            ),
          { deadline: webObservationDeadline },
        ),
      ]);
      const currentWebObservations = currentWebResults.map(({ status, value }) =>
        status === "ok" && value?.semanticPaneId === expectedPane ? value : null,
      );
      after = currentWebObservations[0] ?? after;
      const allAuthorityRecords = after?.workspaceEvidence?.authorityRecords ?? [];
      authorityRecords = allAuthorityRecords.filter(
        ({ ordinal: recordOrdinal }) =>
          Number.isSafeInteger(authorityBoundary) && recordOrdinal > authorityBoundary,
      );
      const authorityBoundaryOverflow =
        Number.isSafeInteger(authorityBoundary) &&
        allAuthorityRecords.length > 0 &&
        allAuthorityRecords[0].ordinal > authorityBoundary + 1;
      let receiptCandidates = [];
      let rawReceipts = [];
      let expectedReceiptRequestHmac = null;
      let expectedWebGrantRecord = null;
      if (ordinal > 0) {
        const receiptObservation = currentWebObservations[ordinal === 1 ? 0 : 1];
        rawReceipts = receiptObservation?.runtimeReplacement?.inputReceipts ?? [];
        expectedReceiptRequestHmac = ordinal > 0 ? (tuiInputReceipt?.requestHmac ?? null) : null;
        receiptCandidates = rawReceipts.filter(
          (receipt) =>
            Number.isSafeInteger(receiptBoundary) &&
            receipt.ordinal >= receiptBoundary &&
            receipt.ordinal === tuiInputReceipt?.receiptOrdinal &&
            receipt.generation === receiptObservation.generation &&
            receipt.pane === receiptObservation.semanticPaneId &&
            receipt.inputSha256 === inputSha256 &&
            receipt.authorityClientId === tuiInputReceipt?.authorityClientId &&
            card5EvidenceHmac("request", receipt.requestId, evidenceKey) ===
              tuiInputReceipt?.requestHmac,
        );
        const expectedWebClient =
          receiptCandidates.length === 1 ? receiptCandidates[0].authorityClientId : null;
        const currentAuthorities = currentWebObservations.map(
          (observation) => observation?.workspaceEvidence?.authority,
        );
        const currentAuthority = currentAuthorities[0];
        const currentAuthorityExact =
          currentAuthority !== null &&
          currentAuthority !== undefined &&
          JSON.stringify(currentAuthorities[0]) === JSON.stringify(currentAuthorities[1]) &&
          expectedWebClient !== null &&
          ["input", "focus", "geometry"].every(
            (kind) => currentAuthority.owners?.[kind] === expectedWebClient,
          ) &&
          currentAuthority.clients?.some(
            ({ clientId, surface }) => clientId === expectedWebClient && surface === "web",
          );
        if (currentAuthorityExact) {
          expectedWebGrantRecord = authorityRecords.find(
            (record) =>
              record.generation === currentAuthority.generation &&
              record.session === currentAuthority.session &&
              record.revision === currentAuthority.revision &&
              record.nativeGeometryYieldUntilMs === currentAuthority.nativeGeometryYieldUntilMs &&
              record.inputOwner === currentAuthority.owners.input &&
              record.focusOwner === currentAuthority.owners.focus &&
              record.geometryOwner === currentAuthority.owners.geometry &&
              JSON.stringify(record.clients) === JSON.stringify(currentAuthority.clients),
          );
        }
      }
      const expectedGrantClient =
        ordinal === 0
          ? (postBlurAuthorityGrant?.inputOwner ?? "")
          : (receiptCandidates[0]?.authorityClientId ?? "");
      const expectedGrantRecord = ordinal === 0 ? postBlurAuthorityGrant : expectedWebGrantRecord;
      const expectedGrantRevision = expectedGrantRecord?.revision ?? null;
      const terminalAuthorityPrecondition = boundedCard5PostInputAuthorityPreconditionObservation({
        webResults: currentWebResults,
        receiptPage: ordinal === 0 ? "none" : ordinal === 1 ? "chromium" : "electron",
        receiptBoundary: receiptBoundary ?? 0,
        rawReceipts,
        receiptCandidates,
        expectedInputSha256: inputSha256,
        expectedRequestHmac: expectedReceiptRequestHmac,
        requireReceipt: ordinal > 0,
        expectedPane,
        expectedGeneration: nullAuthoritySnapshot.generation,
        expectedBaselineAuthority: nullAuthoritySnapshot,
        expectedClientId: expectedGrantClient || null,
        expectedSurface: ordinal === 0 ? "opentui" : "web",
        expectedGrantRecord,
        authorityRecords,
        authorityBoundary,
        boundaryOverflow: authorityBoundaryOverflow,
        evidenceKey,
      });
      authorityPreconditionHistory = advanceCard5PostInputAuthorityPreconditionHistory(
        authorityPreconditionHistory,
        terminalAuthorityPrecondition,
        currentWebResults,
      );
      authorityPreconditionObservation =
        authorityPreconditionHistory.lastSuccessful ??
        authorityPreconditionHistory.firstInformative ??
        authorityPreconditionHistory.terminal;
      if (currentWebObservations.some((observation) => observation === null)) {
        const remaining = authorityDeadline - Date.now();
        if (remaining <= 0) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(10, remaining)));
        continue;
      }
      const joined = selectCard5PostInputAuthorityJoin({
        records: authorityRecords,
        nullRevision: nullAuthorityEvidence.authorityRevision,
        expectedNullAuthority: nullAuthoritySnapshot,
        expectedNullEvidence: nullAuthorityEvidence,
        expectedClientId: expectedGrantClient,
        expectedSurface: ordinal === 0 ? "opentui" : "web",
        expectedGrantRevision,
        expectedGrantRecord,
        receiptCandidates,
        requireReceipt: ordinal > 0,
        boundary: authorityBoundary,
        boundaryOverflow: authorityBoundaryOverflow,
        evidenceKey,
      });
      grantRecord = joined.grant;
      exactInputReceipt = joined.receipt;
      const ordinalZeroGrantExact =
        ordinal !== 0 ||
        (grantRecord !== null && postBlurAuthorityGrant !== null && joined.observation.grantExact);
      authorityJoinObservation = Object.freeze({
        ...joined.observation,
        grantExact: joined.observation.grantExact && ordinalZeroGrantExact,
      });
      if (joined.passed && ordinalZeroGrantExact) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    const nullIndex = authorityRecords.findIndex(
      ({ inputOwner, focusOwner, geometryOwner, revision }) =>
        inputOwner === null &&
        focusOwner === null &&
        geometryOwner === null &&
        revision === nullAuthorityEvidence.authorityRevision,
    );
    const grantIndex = authorityRecords.indexOf(grantRecord);
    if (
      grantRecord === null ||
      grantIndex <= nullIndex ||
      (ordinal > 0 && exactInputReceipt === null)
    ) {
      const error = new Error("Card5 post-input authority grant did not settle exactly");
      error.observation = Object.freeze({
        operation: "card5-post-input-authority-join",
        reason: "post-input-authority-unsettled",
        precondition: authorityPreconditionObservation,
        preconditionHistory: authorityPreconditionHistory,
        ...(authorityJoinObservation ?? {
          nullCount: 0,
          nullOverflow: false,
          grantCount: 0,
          grantOverflow: false,
          receiptCount: 0,
          nullExact: false,
          grantExact: false,
          receiptExact: false,
          boundary: Number.isSafeInteger(authorityBoundary) ? authorityBoundary : null,
          boundaryOverflow: false,
          nullReplayCount: 0,
          nullReplayOrdinalHmac: null,
          grantReplayCount: 0,
          grantReplayOrdinalHmac: null,
          stagingCount: 0,
          stagingOverflow: false,
          stagingExact: false,
          stagingOrdinalHmac: null,
          stagingSequenceHmac: null,
          lastRecords: Object.freeze([]),
        }),
      });
      throw error;
    }
    if (ordinal === 0) {
      const traceDeadline = performance.now() + 3_000;
      let assessment = null;
      while (performance.now() < traceDeadline) {
        hosts.tuiEvidence.drain();
        assessment = assessCard5TuiHandoffInput({
          records: hosts.tuiEvidence.reader.recordsSince(tuiInputMark),
          hostReceipt: tuiInputReceipt,
          payload: handoffInput.text,
          expectedPane,
          expectedCanonical: tuiCanonicalBeforeInput,
          inputFingerprintKey: hosts.inputFingerprintKey,
          evidenceKey,
        });
        if (
          assessment.passed ||
          !["input-origin-missing", "input-trace-cardinality"].includes(assessment.reason)
        )
          break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      }
      if (!assessment?.passed) {
        const error = new Error(
          `Card5 OpenTUI input trace was invalid: ${assessment?.reason ?? "timeout"}`,
        );
        error.observation = Object.freeze({
          operation: "card5-tui-authority-handoff-input",
          reason: assessment?.reason ?? "input-trace-timeout",
        });
        throw error;
      }
      tuiInputTrace = assessment.evidence;
      hosts.tuiEvidence.drain();
      const postInputMark = hosts.tuiEvidence.lifecycleReader.mark();
      const transitionAssessment = assessCard5TuiFocusTransition({
        records: hosts.tuiEvidence.lifecycleReader
          .recordsThrough(postInputMark)
          .slice(focusTransitionMark.recordCount),
        receipts: focusTransitionReceipts,
        expectedCanonical: tuiCanonicalBeforeInput,
        priorBlurRecords,
        expectedBindingHmac: hostFocusBindingHmac,
        expectedWorkspaceName: state.workspace,
        expectedRendererEpoch: hostFocusBinding.rendererEpoch,
        expectedClientGeneration: hostFocusBinding.clientGeneration,
        expectedRuntimeSession: nullRuntimeSession,
        expectedAuthorityOwners: ownerAuthority.owners,
        expectedTuiClientId: ownerTuiClientId,
        minimumBlurAuthorityRevision: retainedAuthorityEvidence.authorityRevision,
        minimumFocusAuthorityRevision: nullAuthorityEvidence.authorityRevision,
        baselineClaimOrdinal,
        evidenceKey,
      });
      if (!transitionAssessment.passed) {
        const error = new Error("Card5 OpenTUI duplicate focus changed the explicit focus epoch");
        error.observation = boundedCard5TuiFocusFailureObservation({
          reason: transitionAssessment.reason,
          axes: { authority: true },
        });
        throw error;
      }
      tuiFocusTransition = Object.freeze({
        ...transitionAssessment.evidence,
        nullAuthorityHmac: nullAuthorityEvidence.authorityHmac,
        nullAuthorityMutationHmac: nullAuthorityEvidence.authorityMutationHmac,
        nullAuthorityOwnerHmac: nullAuthorityEvidence.authorityOwnerHmac,
        nullAuthorityRevision: nullAuthorityEvidence.authorityRevision,
        nullAuthorityTopologyHmac: nullAuthorityEvidence.authorityTopologyHmac,
        postInputRecordCount: postInputMark.recordCount,
      });
    }
    const rendered = await waitForCard5ProductionClientConvergence(
      state,
      hosts,
      evidenceKey,
      hosts.tuiEvidence,
      5_000,
      {
        expectedPane,
        postHandoff: {
          expectedClientId: grantRecord.inputOwner,
          expectedSurface: ordinal === 0 ? "opentui" : "web",
          grantRevision: grantRecord.revision,
          inputProofHmac: card5EvidenceHmac(
            "post-handoff-input-proof",
            ordinal === 0
              ? [tuiInputTrace.hostReceiptHmac, tuiInputTrace.traceHmac, inputSha256].join("\0")
              : [
                  exactInputReceipt.requestId,
                  exactInputReceipt.seq,
                  exactInputReceipt.authorityClientId,
                  inputSha256,
                ].join("\0"),
            evidenceKey,
          ),
          expectedBinding: hostFocusBinding,
          expectedTuiClientId: ownerTuiClientId,
        },
      },
    );
    const renderedMarkerCount = (
      await Promise.all(
        [hosts.chromiumPage, hosts.electronPage].map((page) =>
          page.evaluate(
            ({ expected, semanticPaneId }) => {
              const surface = Array.from(
                globalThis.document.querySelectorAll(".terminal-surface[data-phase='connected']"),
              ).find((node) => node.getAttribute("data-semantic-pane-id") === semanticPaneId);
              return Array.from(surface?.querySelectorAll(".xterm-rows") ?? []).some((node) =>
                node.textContent?.includes(expected),
              );
            },
            { expected: marker, semanticPaneId: expectedPane },
          ),
        ),
      )
    ).filter(Boolean).length;
    hosts.tuiEvidence.drain();
    const inputFencesAfter = hosts.tuiEvidence.inputFenceCount();
    if (markerPresent) hosts.recordNativeMarker?.(marker);
    const transition = {
      ordinal,
      client: ["opentui", "web-a", "web-b"][ordinal],
      releaseObserved:
        beforeOwner !== null && nullIndex >= 0 && authorityRecords[nullIndex].revision > 0,
      authorityReleaseEvidence,
      nullAuthorityEvidence: Object.freeze({
        authorityHmac: nullAuthorityEvidence.authorityHmac,
        authorityMutationHmac: nullAuthorityEvidence.authorityMutationHmac,
        authorityOwnerHmac: nullAuthorityEvidence.authorityOwnerHmac,
        authorityRevision: nullAuthorityEvidence.authorityRevision,
        authorityTopologyHmac: nullAuthorityEvidence.authorityTopologyHmac,
      }),
      nullObserved: nullOwner === null && nullIndex >= 0,
      grantObserved: grantIndex > nullIndex,
      inputAccepted: markerPresent,
      receiptSettled:
        ordinal === 0
          ? tuiInputTrace !== null && inputFencesAfter > inputFencesBefore
          : exactInputReceipt !== null,
      renderedClientCount: Object.keys(rendered.clients).length,
      renderedMarkerCount,
      beforeRenditionHmac: before?.contentHmac ?? null,
      renderedRenditionHmac:
        rendered.clients["web-a"]?.renditionHmac === rendered.clients["web-b"]?.renditionHmac
          ? rendered.clients["web-a"].renditionHmac
          : null,
      grantRevision: grantRecord?.revision ?? null,
      grantedClientHmac: grantRecord?.inputOwner
        ? card5EvidenceHmac("authority-client", grantRecord.inputOwner, evidenceKey)
        : null,
      receiptClientHmac:
        ordinal === 0
          ? grantRecord?.inputOwner
            ? card5EvidenceHmac("authority-client", grantRecord.inputOwner, evidenceKey)
            : null
          : exactInputReceipt?.authorityClientId
            ? card5EvidenceHmac(
                "authority-client",
                exactInputReceipt.authorityClientId,
                evidenceKey,
              )
            : null,
      receiptRequestHmac:
        ordinal === 0
          ? (tuiInputTrace?.hostReceiptHmac ?? null)
          : exactInputReceipt?.requestId
            ? card5EvidenceHmac("input-request", exactInputReceipt.requestId, evidenceKey)
            : null,
      receiptOrdinal:
        ordinal === 0 ? (tuiInputReceipt?.physicalTransportCalls ?? null) : exactInputReceipt?.seq,
      receiptPaneHmac:
        ordinal === 0
          ? (tuiInputTrace?.paneHmac ?? null)
          : card5EvidenceHmac("receipt-pane", exactInputReceipt?.pane ?? "unobserved", evidenceKey),
      operationHmac: card5EvidenceHmac(
        "operation",
        `${ordinal}\0${grantRecord?.revision ?? "unobserved"}\0${grantRecord?.inputOwner ?? "unobserved"}\0${ordinal === 0 ? tuiInputReceipt?.paneId : exactInputReceipt?.seq}\0${inputSha256}`,
        evidenceKey,
      ),
      markerHmac: card5EvidenceHmac("marker", marker, evidenceKey),
      authorityJoinEvidence: authorityJoinObservation,
      postHandoffAuthorityEvidence: rendered.postHandoffAuthorityEvidence,
      tuiFocusEvidence:
        tuiFocus === null
          ? null
          : Object.freeze({
              ...tuiFocus.evidence,
              ...postBlurAuthorityEvidence,
              transition: tuiFocusTransition,
              retainedAuthorityHmac: retainedAuthorityEvidence.authorityHmac,
              retainedAuthorityOwnerHmac: retainedAuthorityEvidence.authorityOwnerHmac,
              retainedAuthorityRevision: retainedAuthorityEvidence.authorityRevision,
              retainedAuthorityTopologyHmac: retainedAuthorityEvidence.authorityTopologyHmac,
              postBlurGrantRevision: postBlurAuthorityGrant?.revision ?? null,
            }),
      tuiInputTrace,
    };
    transitions.push(
      Object.freeze({
        ...transition,
        releaseBindingDigest: card5AuthorityReleaseBindingDigest(
          transition,
          ownerReleaseEvidence[ordinal],
        ),
        releaseBindingHmac: card5AuthorityReleaseBindingHmac(
          transition,
          ownerReleaseEvidence[ordinal],
          evidenceKey,
        ),
      }),
    );
  }
  return Object.freeze({
    transitions: Object.freeze(transitions),
    ownerReleaseEvidence: Object.freeze(ownerReleaseEvidence),
    retainedAuthorityEvidence,
    nullAuthorityEvidence: initialNullAuthorityEvidence,
    postBlurAuthorityEvidence: Object.freeze({
      authorityHmac: transitions[0]?.tuiFocusEvidence?.authorityHmac ?? null,
      authorityOwnerHmac: transitions[0]?.tuiFocusEvidence?.authorityOwnerHmac ?? null,
      authorityRevision: transitions[0]?.tuiFocusEvidence?.authorityRevision ?? null,
      authorityTopologyHmac: transitions[0]?.tuiFocusEvidence?.authorityTopologyHmac ?? null,
    }),
  });
}

async function proveCard5PassiveGeometry(
  state,
  hosts,
  evidenceKey,
  { activeChallenge = true, semanticPaneId } = {},
) {
  if (typeof semanticPaneId !== "string" || semanticPaneId.length < 1) {
    throw new Error("Card5 geometry proof requires the accepted convergence pane");
  }
  const argv = validateCard5NativeObserverCommand([
    "list-panes",
    "-a",
    "-F",
    "#{session_id}\t#{window_id}\t#{pane_id}\t#{@tmux_ide_pane_id}\t#{pane_width}\t#{pane_height}",
  ]);
  let geometryReceipt = null;
  if (activeChallenge) {
    const geometryBefore = await observeCard5WebCanonical(
      hosts.chromiumPage,
      evidenceKey,
      hosts.chromiumProcessIdentity,
    );
    if (geometryBefore?.semanticPaneId !== semanticPaneId) {
      throw new Error("Card5 geometry challenge switched semantic panes");
    }
    const geometryBoundary = geometryBefore?.runtimeReplacement?.geometryReceiptCount;
    const viewport = hosts.chromiumPage.viewportSize();
    if (!viewport || !Number.isSafeInteger(geometryBoundary)) {
      throw new Error("Card5 geometry challenge baseline was unavailable");
    }
    await hosts.chromiumPage.setViewportSize({
      width: Math.max(800, viewport.width - 40),
      height: Math.max(600, viewport.height - 24),
    });
    const geometryDeadline = Date.now() + 3_000;
    while (Date.now() < geometryDeadline) {
      const observed = await observeCard5WebCanonical(
        hosts.chromiumPage,
        evidenceKey,
        hosts.chromiumProcessIdentity,
      );
      geometryReceipt = observed?.runtimeReplacement?.geometryReceipts?.find(
        ({ ordinal, generation, authorityClientId }) =>
          ordinal >= geometryBoundary &&
          generation === observed.generation &&
          authorityClientId === observed.workspaceEvidence?.authority?.owners?.geometry,
      );
      if (geometryReceipt) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    if (!geometryReceipt) throw new Error("Card5 geometry challenge had no exact viewport receipt");
    await waitForCard5ProductionClientConvergence(
      state,
      hosts,
      evidenceKey,
      hosts.tuiEvidence,
      5_000,
      { expectedPane: semanticPaneId },
    );
  }
  const samples = [];
  for (let ordinal = 0; ordinal < 2; ordinal += 1) {
    const [webA, webB] = await Promise.all([
      observeCard5WebCanonical(hosts.chromiumPage, evidenceKey, hosts.chromiumProcessIdentity),
      observeCard5WebCanonical(hosts.electronPage, evidenceKey, hosts.electronProcessIdentity),
    ]);
    const sharedPane = exactSharedCard5WebPane([webA, webB]);
    const tui =
      sharedPane === semanticPaneId
        ? latestCard5TuiCanonical(hosts.tuiEvidence, semanticPaneId)
        : null;
    const authority = webA?.workspaceEvidence?.authority;
    const secondAuthority = webB?.workspaceEvidence?.authority;
    hosts.tuiEvidence.drain();
    const daemonRecords = hosts.tuiEvidence.daemonReader.read();
    const activeOpens = daemonRecords.filter(
      (record) =>
        record?.operation === "terminal-delivery-subscriber-lifecycle" &&
        record.terminalDelivery?.deliveryLifecycleEvent === "open" &&
        record.terminalDelivery?.canonicalGeneration === tui?.generation &&
        record.terminalDelivery?.semanticPaneId === tui?.semanticPaneId,
    );
    const requestFor = (observed) => {
      const current = observed?.runtimeReplacement?.currentLifecycleRequest;
      return current?.status === "exact" ? current : null;
    };
    const clientFor = (surface, request) =>
      activeOpens.find(
        ({ terminalDelivery }) =>
          terminalDelivery.deliverySurface === surface &&
          (surface === "opentui" ||
            (request !== null &&
              card5EvidenceHmac("request", terminalDelivery.deliveryRequestId, evidenceKey) ===
                request.requestHmac)),
      )?.terminalDelivery?.deliveryClientId ?? null;
    const identities = [
      {
        client: "opentui",
        source: "authority-snapshot",
        clientId: clientFor("opentui", null),
        observed: tui,
        passive: null,
        geometryOwner: null,
      },
      {
        client: "web-a",
        source: "chromium-dom-and-authority",
        clientId: clientFor("web", requestFor(webA)),
        observed: webA,
        passive: webA?.passive,
        geometryOwner: webA?.geometryOwner,
      },
      {
        client: "web-b",
        source: "electron-dom-and-authority",
        clientId: clientFor("web", requestFor(webB)),
        observed: webB,
        passive: webB?.passive,
        geometryOwner: webB?.geometryOwner,
      },
    ];
    const authorityClients = new Map(authority?.clients?.map((entry) => [entry.clientId, entry]));
    const clients = identities.map((identity) => {
      const authorityClient = authorityClients.get(identity.clientId);
      const geometryOwner = authority?.owners?.geometry === identity.clientId;
      const passive = !geometryOwner;
      if (
        !identity.clientId ||
        !authorityClient ||
        (identity.passive !== null && identity.passive !== passive) ||
        (identity.geometryOwner !== null && identity.geometryOwner !== geometryOwner) ||
        !Number.isSafeInteger(identity.observed?.cols) ||
        !Number.isSafeInteger(identity.observed?.rows)
      ) {
        throw new Error("Card5 geometry client observation was incomplete or contradictory");
      }
      return Object.freeze({
        client: identity.client,
        source: identity.source,
        clientHmac: card5EvidenceHmac("geometry-client", identity.clientId, evidenceKey),
        authorityRevision: authority.revision,
        connectedRevision: authorityClient.connectedRevision,
        activityRevision: authorityClient.activityRevision,
        geometryOwner,
        passive,
        cols: identity.observed.cols,
        rows: identity.observed.rows,
      });
    });
    if (
      JSON.stringify(authority) !== JSON.stringify(secondAuthority) ||
      clients.length !== 3 ||
      new Set(clients.map(({ clientHmac }) => clientHmac)).size !== 3 ||
      new Set(clients.map(({ cols, rows }) => `${cols}x${rows}`)).size !== 1
    ) {
      throw new Error("Card5 geometry authority did not converge across all three clients");
    }
    const nativeLayout = execFileSync(
      "tmux",
      ["-S", state.runtimeNamespace.tmuxSocketPath, ...argv],
      { encoding: "utf8", maxBuffer: 4 * 1_024 * 1_024 },
    );
    const nativePane = nativeLayout
      .trimEnd()
      .split("\n")
      .map((line) => line.split("\t"))
      .find((fields) => fields[3] === tui.semanticPaneId);
    const nativeCols = Number(nativePane?.[4]);
    const nativeRows = Number(nativePane?.[5]);
    if (
      !nativePane ||
      !Number.isSafeInteger(nativeCols) ||
      !Number.isSafeInteger(nativeRows) ||
      nativeCols !== clients[0].cols ||
      nativeRows !== clients[0].rows
    ) {
      throw new Error("Card5 native geometry did not match the canonical pane dimensions");
    }
    samples.push(
      Object.freeze({
        clients: Object.freeze(clients),
        authorityRevision: authority.revision,
        ownerCount: clients.filter(({ geometryOwner }) => geometryOwner).length,
        passiveCount: clients.filter(({ passive }) => passive).length,
        geometryFightCount:
          clients.filter(({ geometryOwner }) => geometryOwner).length === 1 ? 0 : 1,
        nativeCols,
        nativeRows,
        topologyHmac: card5EvidenceHmac(
          "topology",
          JSON.stringify({
            generation: authority.generation,
            revision: authority.revision,
            owners: authority.owners,
            clients,
          }),
          evidenceKey,
        ),
        nativeLayoutHmac: card5EvidenceHmac("native-layout", nativeLayout, evidenceKey),
      }),
    );
    if (ordinal === 0) await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  }
  return Object.freeze({
    challenge: geometryReceipt
      ? Object.freeze({
          receiptHmac: card5EvidenceHmac(
            "geometry-receipt",
            JSON.stringify(geometryReceipt),
            evidenceKey,
          ),
          authorityClientHmac: card5EvidenceHmac(
            "geometry-client",
            geometryReceipt.authorityClientId,
            evidenceKey,
          ),
          requestHmac: card5EvidenceHmac(
            "geometry-request",
            geometryReceipt.requestId,
            evidenceKey,
          ),
          seq: geometryReceipt.seq,
          cols: geometryReceipt.cols,
          rows: geometryReceipt.rows,
        })
      : null,
    samples: Object.freeze(samples),
  });
}

async function proveCard5SlowWebIsolation(state, hosts, evidenceKey, tuiEvidence, semanticPaneId) {
  const requireExpectedWeb = (observed) => {
    if (observed?.semanticPaneId !== semanticPaneId) {
      throw new Error("Card5 slow-client observation switched semantic panes");
    }
    return observed;
  };
  const expectedTuiIdentity = latestCard5TuiCanonical(tuiEvidence, semanticPaneId);
  const expectedTuiProcessId = expectedTuiIdentity?.processId;
  if (!/^opentui:[1-9]\d*$/u.test(expectedTuiProcessId ?? "")) {
    throw new Error("Card5 slow-client OpenTUI process identity was unavailable");
  }
  const slow = await hosts.setElectronSlowHidden(4);
  const reader = tuiEvidence.reader;
  tuiEvidence.drain();
  const mark = reader.mark();
  const daemonMark = tuiEvidence.daemonReader.mark();
  const blockedAt = await hosts.setElectronSinkBlocked(true);
  const deliverySamples = [];
  let immutableHostInputIdentity = null;
  try {
    let priorDeliveryFence = requireExpectedWeb(
      await observeCard5WebCanonical(
        hosts.electronPage,
        evidenceKey,
        hosts.electronProcessIdentity,
      ),
    )?.deliveryFence;
    for (let ordinal = 0; ordinal < 30; ordinal += 1) {
      tuiEvidence.drain();
      const resourceBefore = tuiEvidence.resourceSnapshot().count;
      const marker = `CARD5_SLOW_${ordinal}_${randomBytes(3).toString("hex")}`;
      const payload = `${marker}\n`;
      const ackBoundary = requireExpectedWeb(
        await observeCard5WebCanonical(
          hosts.electronPage,
          evidenceKey,
          hosts.electronProcessIdentity,
        ),
      )?.runtimeReplacement?.ackSentCount;
      if (!Number.isSafeInteger(ackBoundary)) {
        throw new Error("Card5 slow-client ACK boundary was unavailable");
      }
      const inputReceipt = JSON.parse(
        tuiCommand(state, ["input", JSON.stringify({ version: 1, kind: "paste", text: payload })]),
      );
      if (!isExactCard5TuiHostInputReceipt(inputReceipt, payload))
        throw new Error("Card5 slow input host receipt was invalid");
      const hostInputIdentity = [
        inputReceipt.sessionId,
        inputReceipt.paneId,
        inputReceipt.target,
      ].join("\0");
      if (immutableHostInputIdentity === null) immutableHostInputIdentity = hostInputIdentity;
      else if (hostInputIdentity !== immutableHostInputIdentity)
        throw new Error("Card5 slow input host pane identity changed");
      const deadline = performance.now() + 3_000;
      while (performance.now() < deadline) {
        if (tuiCommand(state, ["capture", "--history", "20"]).includes(marker)) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      }
      if (performance.now() >= deadline)
        throw new Error("Card5 OpenTUI input stalled behind hidden Web client");
      let observed = null;
      const deliveryDeadline = performance.now() + 3_000;
      while (performance.now() < deliveryDeadline) {
        observed = requireExpectedWeb(
          await observeCard5WebCanonical(
            hosts.electronPage,
            evidenceKey,
            hosts.electronProcessIdentity,
          ),
        );
        if (observed?.deliveryFence > priorDeliveryFence) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      }
      const sink = await hosts.observeElectronSink();
      let resourceSample = null;
      const resourceDeadline = performance.now() + 1_000;
      while (performance.now() < resourceDeadline) {
        tuiEvidence.drain();
        const resource = tuiEvidence.resourceSnapshot();
        if (resource.count > resourceBefore) {
          resourceSample = resource.record;
          break;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      }
      deliverySamples.push(
        Object.freeze({
          deliveryFenceBefore: priorDeliveryFence,
          deliveryFenceAfter: observed?.deliveryFence ?? null,
          deliveryAckFence: observed?.deliveryAckFence ?? null,
          ackEvent:
            observed?.runtimeReplacement?.ackEvents?.find(
              ({ ordinal: ackOrdinal }) => ackOrdinal >= ackBoundary,
            ) ?? null,
          ackEvents:
            observed?.runtimeReplacement?.ackEvents?.filter(
              ({ ordinal: ackOrdinal }) => ackOrdinal >= ackBoundary,
            ) ?? [],
          ackBoundary,
          requestHmac:
            observed?.runtimeReplacement?.currentLifecycleRequest?.status === "exact"
              ? observed.runtimeReplacement.currentLifecycleRequest.requestHmac
              : null,
          queueCurrent: sink.pendingCurrent,
          queuePeak: sink.pendingPeak,
          queueCap: sink.queueCap,
          resource: resourceSample,
          marker,
          payload,
          inputReceipt,
        }),
      );
      priorDeliveryFence = observed?.deliveryFence ?? priorDeliveryFence;
    }
    while (!reader.snapshot().caughtUp) reader.read();
    const records = reader.recordsSince(mark);
    let daemonRecords = [];
    const settlementDeadline = performance.now() + 1_000;
    while (performance.now() < settlementDeadline) {
      do {
        tuiEvidence.daemonReader.read();
      } while (!tuiEvidence.daemonReader.snapshot().caughtUp);
      daemonRecords = tuiEvidence.daemonReader.recordsSince(daemonMark);
      if (
        deliverySamples.every((delivery) =>
          daemonRecords.some(
            (record) =>
              record?.operation === "terminal-delivery-settled" &&
              card5EvidenceHmac(
                "request",
                record.terminalDelivery?.deliveryRequestId,
                evidenceKey,
              ) === delivery.requestHmac &&
              record.terminalDelivery?.transactionId === delivery.ackEvent?.transactionId &&
              record.terminalDelivery?.canonicalGeneration === delivery.ackEvent?.generation &&
              record.terminalDelivery?.canonicalRevision === delivery.ackEvent?.revision &&
              record.terminalDelivery?.canonicalStateHash === delivery.ackEvent?.canonicalStateHash,
          ),
        )
      )
        break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    }
    const paintsByTrace = new Map(
      inputPaintSamples(records).map((paint) => [paint.traceId, paint]),
    );
    const inputOrigins = records.filter(
      ({ type, traceId, payloadFingerprint }) =>
        type === "performance.input-origin" &&
        typeof traceId === "string" &&
        typeof payloadFingerprint === "string",
    );
    const fences = new Map(
      records
        .filter(
          ({ type, traceId }) => type === "performance.input-fence" && typeof traceId === "string",
        )
        .map((record) => [record.traceId, record]),
    );
    const samples = deliverySamples.map((delivery, ordinal) => {
      const matchingOrigins = inputOrigins.filter(
        (origin) =>
          origin.semanticPaneId === semanticPaneId &&
          origin.payloadByteCount === Buffer.byteLength(delivery.payload) &&
          origin.payloadFingerprint ===
            createHmac("sha256", hosts.inputFingerprintKey)
              .update(origin.traceId)
              .update("\0")
              .update(delivery.payload)
              .digest("hex"),
      );
      if (matchingOrigins.length !== 1) {
        throw new Error("Card5 slow input marker did not map to one exact trace");
      }
      const paint = paintsByTrace.get(matchingOrigins[0].traceId);
      if (!paint) throw new Error("Card5 slow input trace had no exact paint endpoint");
      const fence = fences.get(paint.traceId);
      if (
        matchingOrigins[0].generation !== expectedTuiIdentity.generation ||
        matchingOrigins[0].incarnation !== expectedTuiIdentity.incarnation ||
        matchingOrigins[0].processId !== expectedTuiProcessId ||
        matchingOrigins[0].clockId !== expectedTuiIdentity.clockId ||
        paint.semanticPaneId !== semanticPaneId ||
        paint.generation !== matchingOrigins[0].generation ||
        paint.incarnation !== matchingOrigins[0].incarnation ||
        paint.processId !== matchingOrigins[0].processId ||
        paint.clockId !== matchingOrigins[0].clockId ||
        fence?.semanticPaneId !== semanticPaneId ||
        fence?.generation !== paint.generation ||
        fence?.incarnation !== paint.incarnation ||
        fence?.revision !== paint.revision ||
        fence?.stateHash !== paint.stateHash
      )
        throw new Error("Card5 slow input trace changed semantic authority");
      const matchingAcks = delivery.ackEvents.filter(
        (ack) =>
          ack.generation === fence?.generation &&
          ack.revision === fence?.revision &&
          ack.canonicalStateHash === fence?.stateHash,
      );
      const ackEvent = matchingAcks.length === 1 ? matchingAcks[0] : null;
      const matchingSettlements = daemonRecords.filter(
        (record) =>
          record?.operation === "terminal-delivery-settled" &&
          record.traceId === paint.traceId &&
          card5EvidenceHmac("request", record.terminalDelivery?.deliveryRequestId, evidenceKey) ===
            delivery.requestHmac &&
          record.terminalDelivery?.transactionId === ackEvent?.transactionId &&
          record.terminalDelivery?.canonicalGeneration === ackEvent?.generation &&
          record.terminalDelivery?.canonicalRevision === ackEvent?.revision &&
          record.terminalDelivery?.canonicalStateHash === ackEvent?.canonicalStateHash,
      );
      const settled = matchingSettlements.length === 1 ? matchingSettlements[0] : null;
      const matchingResources = records.filter(
        (record) =>
          record?.type === "performance.terminal-resource-sample" &&
          record.operation === "post-fence" &&
          record.semanticPaneId === fence?.semanticPaneId &&
          record.generation === fence?.generation &&
          record.incarnation === fence?.incarnation &&
          record.revision === fence?.revision &&
          record.stateHash === fence?.stateHash &&
          record.resourceEpochIdentity?.semanticPaneId === fence?.semanticPaneId &&
          record.resourceEpochIdentity?.generation === fence?.generation &&
          record.resourceEpochIdentity?.incarnation === fence?.incarnation &&
          record.resourceEpochIdentity?.revision === fence?.revision &&
          record.resourceEpochIdentity?.stateHash === fence?.stateHash,
      );
      const resource = matchingResources.length === 1 ? matchingResources[0] : null;
      const canonicalIdentity = (value) =>
        value ? [value.generation, value.revision, value.stateHash].join("\0") : "unobserved";
      return Object.freeze({
        inputPaintMs: paint.durationMs,
        sampleOrdinal: ordinal,
        traceHmac: card5EvidenceHmac("input-trace", paint.traceId, evidenceKey),
        markerHmac: card5EvidenceHmac("input-marker", delivery.marker, evidenceKey),
        inputReceiptHmac: card5EvidenceHmac(
          "tui-input-receipt",
          JSON.stringify(delivery.inputReceipt),
          evidenceKey,
        ),
        queueCurrent: delivery.queueCurrent,
        queuePeak: delivery.queuePeak,
        queueCap: delivery.queueCap,
        ackSettled:
          delivery.deliveryFenceAfter > delivery.deliveryFenceBefore &&
          delivery.deliveryAckFence >= delivery.deliveryFenceAfter &&
          settled !== undefined,
        deliveryLaneHmac: settled
          ? card5EvidenceHmac("delivery-lane", settled.terminalDelivery.deliveryLaneId, evidenceKey)
          : null,
        deliveryRequestHmac: settled
          ? card5EvidenceHmac(
              "delivery-request",
              settled.terminalDelivery.deliveryRequestId,
              evidenceKey,
            )
          : null,
        transactionHmac: settled
          ? card5EvidenceHmac(
              "delivery-transaction",
              settled.terminalDelivery.transactionId,
              evidenceKey,
            )
          : null,
        settlementTraceHmac: settled
          ? card5EvidenceHmac("settlement-trace", settled.traceId, evidenceKey)
          : null,
        matchingSettlementCount: matchingSettlements.length,
        fenceTraceHmac: card5EvidenceHmac("settlement-trace", paint.traceId, evidenceKey),
        fenceCanonicalHmac: card5EvidenceHmac(
          "canonical-identity",
          canonicalIdentity(fence),
          evidenceKey,
        ),
        ackCanonicalHmac: card5EvidenceHmac(
          "canonical-identity",
          canonicalIdentity(
            ackEvent
              ? {
                  generation: ackEvent.generation,
                  revision: ackEvent.revision,
                  stateHash: ackEvent.canonicalStateHash,
                }
              : null,
          ),
          evidenceKey,
        ),
        matchingAckCount: matchingAcks.length,
        ackOrdinal: ackEvent?.ordinal ?? null,
        ackBoundary: delivery.ackBoundary,
        canonicalRevision: ackEvent?.revision ?? null,
        deliveryFenceSettled: fence !== undefined,
        writerHealth: fence?.writerHealth ?? null,
        resource: resource
          ? Object.freeze({
              processId: resource.processId,
              processIdentityExact: resource.processId === expectedTuiProcessId,
              clockId: resource.clockId,
              processHmac: card5EvidenceHmac("process", resource.processId, evidenceKey),
              clockHmac: card5EvidenceHmac("clock", resource.clockId, evidenceKey),
              atMicros: resource.atMicros,
              resourceEpochIdentityHmac: card5EvidenceHmac(
                "resource-epoch",
                JSON.stringify(resource.resourceEpochIdentity),
                evidenceKey,
              ),
              canonicalIdentityHmac: card5EvidenceHmac(
                "canonical-identity",
                canonicalIdentity(resource),
                evidenceKey,
              ),
              rssBytes: resource.rssBytes,
              heapUsedBytes: resource.heapUsedBytes,
              rssPeakBytes: resource.rssPeakBytes,
              heapUsedPeakBytes: resource.heapUsedPeakBytes,
              inputPending: resource.inputPending,
              inputInFlight: resource.inputInFlight,
              inputPendingBytes: resource.inputPendingBytes,
              inputPendingPeak: resource.inputPendingPeak,
              inputInFlightPeak: resource.inputInFlightPeak,
              inputPendingBytesPeak: resource.inputPendingBytesPeak,
              resourceSamplingFailureCount: resource.resourceSamplingFailureCount,
              eventLoopDelayMicros: resource.eventLoopDelayMicros,
              eventLoopDelayPeakMicros: resource.eventLoopDelayPeakMicros,
            })
          : null,
      });
    });
    await hosts.setElectronSinkBlocked(false);
    const caughtUp = await waitForCard5ProductionClientConvergence(
      state,
      hosts,
      evidenceKey,
      tuiEvidence,
      5_000,
      { expectedPane: semanticPaneId },
    );
    const sinkAfterRelease = await hosts.observeElectronSink();
    const observed = requireExpectedWeb(
      await observeCard5WebCanonical(
        hosts.electronPage,
        evidenceKey,
        hosts.electronProcessIdentity,
      ),
    );
    if (!observed || observed.presence !== "background") {
      throw new Error("Card5 slow Electron client was not observably hidden");
    }
    return Object.freeze({
      hidden: true,
      throttled: true,
      blockedSinkObserved: blockedAt.blocked === true && sinkAfterRelease.coalescedCount > 0,
      catchUpExact:
        caughtUp.semanticPaneId === semanticPaneId &&
        sinkAfterRelease.blocked === false &&
        sinkAfterRelease.pendingCurrent === 0 &&
        Object.values(caughtUp.clients).every(
          (client) =>
            client.generation === caughtUp.generation &&
            client.canonicalStateHash === caughtUp.clients.opentui.canonicalStateHash &&
            client.revision === caughtUp.clients.opentui.revision,
        ),
      tuiInputP95Ms: card5Percentile(
        samples.map(({ inputPaintMs }) => inputPaintMs),
        0.95,
      ),
      tuiInputP99Ms: card5Percentile(
        samples.map(({ inputPaintMs }) => inputPaintMs),
        0.99,
      ),
      queuePeak: Math.max(...samples.map(({ queuePeak }) => queuePeak)),
      queueCap: samples[0].queueCap,
      droppedCriticalObserved: Math.max(
        ...samples.map(
          ({ writerHealth }) => writerHealth?.droppedRecords ?? Number.POSITIVE_INFINITY,
        ),
      ),
      samples: Object.freeze(samples),
    });
  } finally {
    await hosts.restoreElectron(slow);
  }
}

async function execCard5NativeObserver(state, rawArgv) {
  const argv = validateCard5NativeObserverCommand(rawArgv);
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("tmux", ["-S", state.runtimeNamespace.tmuxSocketPath, ...argv], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (Number.isSafeInteger(child.pid)) activeCard5NativeObserverPids.add(child.pid);
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    const collect = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > 4 * 1_024 * 1_024) child.kill("SIGKILL");
      else target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", rejectRun);
    child.once("close", (code) => {
      if (Number.isSafeInteger(child.pid)) activeCard5NativeObserverPids.delete(child.pid);
      if (code === 0) resolveRun(Buffer.concat(stdout).toString("utf8"));
      else rejectRun(new Error(`Card5 native observer exited ${code}: ${Buffer.concat(stderr)}`));
    });
  });
}

async function proveCard5NativeObserver(state, evidenceKey, expectedPane, expectedMarker) {
  if (
    typeof expectedMarker !== "string" ||
    !/^CARD5_HANDOFF_[0-2]_[0-9a-f]{8}$/u.test(expectedMarker)
  ) {
    throw new Error("Card5 native observer expected marker was unavailable");
  }
  const pane = selectExactCard5PaneGeometry(activeWindowPaneGeometry(state), expectedPane);
  if (!pane) throw new Error("Card5 native observer found no exact accepted pane");
  const layoutArgv = [
    "list-panes",
    "-a",
    "-F",
    "#{session_id}:#{window_id}:#{pane_id}:#{pane_width}:#{pane_height}",
  ];
  const captureArgv = ["capture-pane", "-p", "-J", "-t", pane.paneId];
  const beforeLayout = await execCard5NativeObserver(state, layoutArgv);
  const body = await execCard5NativeObserver(state, captureArgv);
  const afterLayout = await execCard5NativeObserver(state, layoutArgv);
  const layoutHmac = (value) =>
    createHmac("sha256", Buffer.from(evidenceKey, "hex")).update(value).digest("hex");
  return Object.freeze({
    readOnly: beforeLayout === afterLayout,
    markerPresent: body.includes(expectedMarker),
    markerHmac: card5EvidenceHmac("marker", expectedMarker, evidenceKey),
    contentHmac: createHmac("sha256", Buffer.from(evidenceKey, "hex")).update(body).digest("hex"),
    paneHmac: card5EvidenceHmac("pane", pane.semanticPaneId, evidenceKey),
    mutationCount: beforeLayout === afterLayout ? 0 : 1,
    beforeLayoutHmac: layoutHmac(beforeLayout),
    afterLayoutHmac: layoutHmac(afterLayout),
    validatedCommandCount: 3,
    activeProcessCount: activeCard5NativeObserverPids.size,
  });
}

async function start(json, quiet = false, planEntry = null) {
  const existing = readJson(statePath);
  if (existing && processAlive(existing.ownerPid)) {
    if (!quiet)
      emit(json ? publicRigStatus(existing) : `Product rig already ${existing.status}`, json);
    return existing;
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
            TMUX_IDE_PRODUCT_RUN_ID: planEntry.runId,
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
  // Twenty-four independently bounded 30s ANSI workload cycles plus startup,
  // Web, and the 10.1s idle proof remain below this journey-specific owner cap.
  // Other ProductRig journeys retain the normal 90s readiness boundary.
  const readinessTimeoutMs = planEntry?.journey?.id === "ansi-cursor-alt-screen" ? 900_000 : 90_000;
  const state = await waitForState(
    (candidate) => candidate?.status === "ready",
    readinessTimeoutMs,
  );
  if (!quiet)
    emit(
      json ? publicRigStatus(state) : `Product rig ready: ${state.session} · ${state.web.pageUrl}`,
      json,
    );
  return state;
}

function acquireCleanupReapProof(state, requestId, acknowledge = false) {
  const ledger = readJson(cleanupProcessLedgerPath);
  const evidence = state?.cleanup?.processReap;
  if (
    !ledger ||
    ledger.version !== 1 ||
    ledger.requestId !== requestId ||
    ledger.ownerPid !== state?.ownerPid ||
    ledger.cleanupToken !== state?.runtimeNamespace?.cleanupToken ||
    !Array.isArray(ledger.identities) ||
    ledger.identities.length < 1 ||
    ledger.identities.length > 65 ||
    evidence?.version !== 1 ||
    evidence.identityCount !== ledger.identities.length ||
    evidence.terminalIdentityCount !== ledger.identities.length - 1 ||
    cleanupIdentityAttestation(state?.ownerToken, ledger.identities) !== ledger.identityHmac ||
    evidence.identityHmac !== ledger.identityHmac
  )
    return null;
  const exact = ledger.identities.every(
    (identity, index) =>
      identity &&
      Object.keys(identity).sort().join("\0") === "kind\0pgid\0pid\0startToken" &&
      (index === 0
        ? identity.kind === "owner" && identity.pid === state.ownerPid
        : ["chromium", "electron"].includes(identity.kind)) &&
      Number.isSafeInteger(identity.pid) &&
      identity.pid > 0 &&
      Number.isSafeInteger(identity.pgid) &&
      identity.pgid > 0 &&
      typeof identity.startToken === "string" &&
      identity.startToken.length > 0 &&
      identity.startToken.length <= 64,
  );
  if (!exact || new Set(ledger.identities.map(({ pid }) => pid)).size !== ledger.identities.length)
    return null;
  if (acknowledge)
    writeJsonAtomic(cleanupReapAckPath, {
      version: 1,
      requestId,
      ownerPid: state.ownerPid,
      ownerToken: state.ownerToken,
      identityHmac: ledger.identityHmac,
    });
  return Object.freeze(ledger.identities.map((identity) => Object.freeze({ ...identity })));
}

function cleanupReapStatus(identities, state, requestId) {
  const rows = cleanupProcessRows();
  if (Array.isArray(identities)) return assessProductRigRetainedProcessAbsence(identities, rows);
  const receipt = readJson(cleanupReapReceiptPath);
  return receipt?.version === 1 &&
    receipt.requestId === requestId &&
    receipt.ownerPid === state?.ownerPid &&
    receipt.identityHmac === state?.cleanup?.processReap?.identityHmac &&
    receipt.status === "absent"
    ? "absent"
    : "invalid";
}

function finalizeCleanupReapProof(state, requestId, identities) {
  const status = cleanupReapStatus(identities, state, requestId);
  if (status !== "absent" || !Array.isArray(identities)) return status;
  writeJsonAtomic(cleanupReapReceiptPath, {
    version: 1,
    requestId,
    ownerPid: state.ownerPid,
    identityHmac: state.cleanup.processReap.identityHmac,
    status: "absent",
  });
  retireProductRigCleanupProofFiles({
    removeAck: () => rmSync(cleanupReapAckPath, { force: true }),
    removeLedger: () => rmSync(cleanupProcessLedgerPath, { force: true }),
  });
  return "absent";
}

function legacyCleanupAuthorization() {
  if (process.env.TMUX_IDE_PRODUCT_LEGACY_CLEANUP_ONLY !== "1") return null;
  const ownerToken = process.env.TMUX_IDE_PRODUCT_LEGACY_CLEANUP_OWNER_TOKEN;
  const runId = process.env.TMUX_IDE_PRODUCT_LEGACY_CLEANUP_RUN_ID;
  const requestId =
    /^[0-9a-f]{48}$/u.test(ownerToken ?? "") && typeof runId === "string"
      ? `legacy-${createHmac("sha256", Buffer.from(ownerToken, "hex"))
          .update(runId)
          .digest("hex")
          .slice(0, 24)}`
      : null;
  return Object.freeze({
    requestId,
    runId,
    ownerToken,
    commit: process.env.TMUX_IDE_PRODUCT_LEGACY_CLEANUP_COMMIT,
    tree: process.env.TMUX_IDE_PRODUCT_LEGACY_CLEANUP_TREE,
    manifestDigest: process.env.TMUX_IDE_PRODUCT_LEGACY_CLEANUP_MANIFEST,
    runtimeRoot: process.env.TMUX_IDE_PRODUCT_LEGACY_CLEANUP_RUNTIME_ROOT,
  });
}

async function stop(json, { quiet = false, strict = false, maxAttempts = 2 } = {}) {
  let state = readJson(statePath);
  let retainedCleanupIdentities = null;
  let legacyLedger = null;
  let legacyOwnerRetryOnly = false;
  let legacyOwnerRetryInitialState = null;
  if (!state) {
    if (!quiet) emit(json ? publicRigStatus(state) : "Product rig stopped", json);
    return null;
  }
  const legacyAuthorization = legacyCleanupAuthorization();
  const rawLegacyLedger = legacyAuthorization ? readJson(cleanupProcessLedgerPath) : null;
  const rawLegacyOwnerRetryIntent =
    rawLegacyLedger?.mode === "legacy-owner-retry-v1" ? rawLegacyLedger : null;
  const legacyOwnerRetryIntent = rawLegacyOwnerRetryIntent
    ? acquireLegacyProductRigOwnerRetryIntent(legacyAuthorization, rawLegacyOwnerRetryIntent)
    : null;
  const finalizeLegacyOwnerRetry = (current, intent = null) => {
    const existingReceipt = readJson(cleanupReapReceiptPath);
    const result = finalizeLegacyProductRigOwnerRetry(
      current,
      legacyAuthorization,
      intent,
      existingReceipt,
      {
        processAlive,
        pathExists: existsSync,
        processRows: cleanupProcessRows(),
        writeReceipt: (receipt) => writeJsonAtomic(cleanupReapReceiptPath, receipt),
        writeState: (completed) => writeJsonAtomic(statePath, completed),
        removeAck: () => rmSync(cleanupReapAckPath, { force: true }),
        removeIntent: () => rmSync(cleanupProcessLedgerPath, { force: true }),
      },
    );
    if (!result.passed)
      throw new Error(`ProductRig legacy owner retry barrier failed: ${result.reason}`);
    return result.state;
  };
  if (legacyAuthorization && state.cleanup?.status === "passed") {
    const ownerRetryReceipt = acquireLegacyProductRigOwnerRetryReceipt(
      legacyAuthorization,
      readJson(cleanupReapReceiptPath),
      legacyOwnerRetryIntent,
    );
    if (legacyOwnerRetryIntent || ownerRetryReceipt) {
      if (rawLegacyOwnerRetryIntent && legacyOwnerRetryIntent === null)
        throw new Error("ProductRig legacy owner retry intent authentication failed");
      const completed = finalizeLegacyOwnerRetry(state, legacyOwnerRetryIntent);
      if (!quiet) emit(json ? publicRigStatus(completed) : "Product rig stopped", json);
      return completed;
    }
  }
  if (legacyAuthorization && state.cleanup?.status === "passed") {
    const provenance = state.diagnosticAttempt?.sourceProvenance;
    const authorizationExact =
      state.status === "failed" &&
      state.diagnosticAttempt?.runId === legacyAuthorization.runId &&
      state.ownerToken === legacyAuthorization.ownerToken &&
      state.runtimeNamespace?.root === legacyAuthorization.runtimeRoot &&
      provenance?.commit === legacyAuthorization.commit &&
      provenance?.tree === legacyAuthorization.tree &&
      provenance?.manifestDigest === legacyAuthorization.manifestDigest &&
      state.cleanup.requestId === legacyAuthorization.requestId &&
      state.cleanup.card5?.passed === true &&
      state.cleanup.processReap?.version === 1 &&
      Array.isArray(state.cleanup.failures) &&
      state.cleanup.failures.length === 0;
    legacyLedger = rawLegacyLedger
      ? acquireLegacyProductRigCleanupLedger(state, legacyAuthorization, rawLegacyLedger)
      : null;
    const receiptStatus = cleanupReapStatus(null, state, legacyAuthorization.requestId);
    const identityStatus = legacyLedger
      ? cleanupReapStatus(legacyLedger.identities, state, legacyAuthorization.requestId)
      : receiptStatus;
    const failures = productRigCleanupBarrierFailures(state, legacyAuthorization.requestId, {
      processAlive,
      pathExists: existsSync,
      retainedProcessIdentityStatus: () => identityStatus,
    });
    if (
      !authorizationExact ||
      (rawLegacyLedger !== null && legacyLedger === null) ||
      receiptStatus !== "absent" ||
      identityStatus !== "absent" ||
      failures.length > 0
    )
      throw new Error("ProductRig completed legacy cleanup recovery failed exact revalidation");
    retireProductRigCleanupProofFiles({
      removeAck: () => rmSync(cleanupReapAckPath, { force: true }),
      removeLedger: () => rmSync(cleanupProcessLedgerPath, { force: true }),
    });
    if (!quiet) emit(json ? publicRigStatus(state) : "Product rig stopped", json);
    return state;
  }
  if (legacyAuthorization) {
    if (rawLegacyOwnerRetryIntent && legacyOwnerRetryIntent === null)
      throw new Error("ProductRig legacy owner retry intent authentication failed");
    if (legacyOwnerRetryIntent) {
      if (
        !legacyProductRigOwnerRetryIntentMatchesState(
          state,
          legacyAuthorization,
          legacyOwnerRetryIntent,
        )
      )
        throw new Error("ProductRig legacy owner retry intent no longer matched failed state");
      if (!processAlive(state.ownerPid))
        throw new Error("ProductRig legacy owner retry owner exited without a passed response");
      const firstRows = cleanupProcessRows();
      await new Promise((resolveWait) => setImmediate(resolveWait));
      const secondRows = cleanupProcessRows();
      legacyOwnerRetryOnly = assessLegacyProductRigOwnerRetryCompatibility(
        state,
        legacyAuthorization,
        firstRows,
        secondRows,
        { processAlive, pathExists: existsSync },
      ).passed;
      if (
        !legacyOwnerRetryOnly ||
        !legacyProductRigOwnerRetryIntentMatchesOwnerRows(legacyOwnerRetryIntent, firstRows) ||
        !legacyProductRigOwnerRetryIntentMatchesOwnerRows(legacyOwnerRetryIntent, secondRows)
      )
        throw new Error("ProductRig legacy owner retry compatibility revalidation failed");
      legacyOwnerRetryInitialState = state;
    } else {
      legacyLedger = acquireLegacyProductRigCleanupLedger(
        state,
        legacyAuthorization,
        rawLegacyLedger,
      );
    }
    if (!legacyLedger && processAlive(state.ownerPid)) {
      legacyLedger = await captureLegacyProductRigCleanupLedger(state, legacyAuthorization, {
        readProcessRows: cleanupProcessRows,
        yieldTurn: () => new Promise((resolveWait) => setImmediate(resolveWait)),
      });
      if (!legacyLedger) {
        const firstRows = cleanupProcessRows();
        await new Promise((resolveWait) => setImmediate(resolveWait));
        const secondRows = cleanupProcessRows();
        legacyOwnerRetryOnly = assessLegacyProductRigOwnerRetryCompatibility(
          state,
          legacyAuthorization,
          firstRows,
          secondRows,
          { processAlive, pathExists: existsSync },
        ).passed;
        if (legacyOwnerRetryOnly) {
          legacyOwnerRetryInitialState = state;
          const intent = createLegacyProductRigOwnerRetryIntent(
            state,
            legacyAuthorization,
            firstRows.find(({ pid }) => pid === state.ownerPid),
          );
          if (intent === null)
            throw new Error("ProductRig legacy owner retry intent could not be authenticated");
          writeJsonAtomic(cleanupProcessLedgerPath, intent);
        }
      }
    }
    if (!legacyLedger && !legacyOwnerRetryOnly)
      throw new Error("ProductRig legacy cleanup identity preflight did not stabilize");
    if (legacyLedger) writeJsonAtomic(cleanupProcessLedgerPath, legacyLedger);
  }
  const finalizeLegacyCleanup = async (current) => {
    if (!legacyLedger) return null;
    const admission = assessLegacyProductRigCleanupAdmission(current, legacyLedger, {
      processAlive,
      pathExists: existsSync,
    });
    if (!admission.passed)
      throw new Error(`ProductRig legacy cleanup failed closed: ${admission.reason}`);
    const retired = await retireLegacyProductRigCleanupIdentities(legacyLedger, {
      readProcessRows: cleanupProcessRows,
      signalProcess: (pid, signal) => process.kill(pid, signal),
      sleep: (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
    });
    if (!retired.passed)
      throw new Error(`ProductRig legacy cleanup failed closed: ${retired.reason}`);
    const finalAdmission = assessLegacyProductRigCleanupAdmission(current, legacyLedger, {
      processAlive,
      pathExists: existsSync,
    });
    if (!finalAdmission.passed)
      throw new Error(`ProductRig legacy cleanup final reobserve failed: ${finalAdmission.reason}`);
    const retainedStatus = cleanupReapStatus(
      legacyLedger.identities,
      current,
      legacyLedger.requestId,
    );
    if (retainedStatus !== "absent")
      throw new Error(`ProductRig legacy cleanup retained identity status: ${retainedStatus}`);
    const previousCard5 = current.cleanup.card5;
    const cleanOwner = (name) => ({
      owned: previousCard5.owners[name].owned,
      retired: true,
      reason: previousCard5.owners[name].owned ? "legacy-exact-reap" : "not-acquired",
    });
    const card5 = card5HostCleanupStatus({
      entries: Object.fromEntries(
        ["chromium", "electron", "opentui", "daemon", "namespace"].map((name) => [
          name,
          cleanOwner(name),
        ]),
      ),
      chromiumProcessCount: 0,
      chromiumDescendantCount: 0,
      chromiumTerminalProcessCount: 0,
      chromiumProcessEvidence: [],
      chromiumProcessEvidenceOverflow: false,
      chromiumPageCount: previousCard5.chromiumPageCount,
      chromiumContextCount: previousCard5.chromiumContextCount,
      chromiumListenerCount: previousCard5.chromiumListenerCount,
      electronProcessCount: 0,
      electronDescendantCount: 0,
      electronTerminalProcessCount: 0,
      electronProcessEvidence: [],
      electronProcessEvidenceOverflow: false,
      electronWindowCount: previousCard5.electronWindowCount,
      electronListenerCount: previousCard5.electronListenerCount,
      electronOpenHandleCount: previousCard5.electronOpenHandleCount,
      socketResidueCount: previousCard5.socketResidueCount,
      nativeObserverProcessCount: previousCard5.nativeObserverProcessCount,
      pathResidueCount: previousCard5.pathResidueCount,
      launchStage: previousCard5.launchStage,
    });
    if (!card5.passed)
      throw new Error("ProductRig legacy cleanup sanitized Card5 receipt was invalid");
    const processReap = {
      version: 1,
      identityCount: legacyLedger.identities.length,
      terminalIdentityCount: legacyLedger.identities.length - 1,
      identityHmac: legacyLedger.identityHmac,
    };
    const completed = {
      ...current,
      status: "failed",
      stoppedAt: new Date().toISOString(),
      cleanup: {
        version: 1,
        requestId: legacyLedger.requestId,
        attempt: 1,
        status: "passed",
        cleanupToken: current.runtimeNamespace?.cleanupToken ?? null,
        failures: [],
        card5,
        processReap,
        completedAt: new Date().toISOString(),
      },
    };
    writeJsonAtomic(cleanupReapReceiptPath, {
      version: 1,
      requestId: legacyLedger.requestId,
      ownerPid: current.ownerPid,
      identityHmac: legacyLedger.identityHmac,
      status: "absent",
    });
    writeJsonAtomic(statePath, completed);
    retireProductRigCleanupProofFiles({
      removeAck: () => rmSync(cleanupReapAckPath, { force: true }),
      removeLedger: () => rmSync(cleanupProcessLedgerPath, { force: true }),
    });
    return completed;
  };
  if (legacyLedger && !processAlive(state.ownerPid)) {
    const completed = await finalizeLegacyCleanup(state);
    if (!quiet) emit(json ? publicRigStatus(completed) : "Product rig stopped", json);
    return completed;
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
      retainedCleanupIdentities = acquireCleanupReapProof(state, priorRequest);
      const retainedStatus = finalizeCleanupReapProof(
        state,
        priorRequest,
        retainedCleanupIdentities,
      );
      const failures = productRigCleanupBarrierFailures(state, priorRequest, {
        processAlive,
        pathExists: existsSync,
        retainedProcessIdentityStatus: () => retainedStatus,
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
    retainedCleanupIdentities = acquireCleanupReapProof(state, state.cleanup.requestId, true);
    const deathDeadline = Date.now() + 5_000;
    while (processAlive(state.ownerPid) && Date.now() < deathDeadline)
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    state = readJson(statePath) ?? state;
    if (!processAlive(state.ownerPid)) {
      const retainedStatus = finalizeCleanupReapProof(
        state,
        state.cleanup.requestId,
        retainedCleanupIdentities,
      );
      if (strict) {
        const failures = productRigCleanupBarrierFailures(state, state.cleanup.requestId, {
          processAlive,
          pathExists: existsSync,
          retainedProcessIdentityStatus: () => retainedStatus,
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
  const cleanupAttempts = legacyOwnerRetryOnly ? 1 : maxAttempts;
  for (let attempt = 1; attempt <= cleanupAttempts; attempt += 1) {
    requestId = legacyOwnerRetryOnly
      ? legacyAuthorization.requestId
      : `${Date.now()}-${randomBytes(6).toString("hex")}`;
    const shutdownRequest = legacyOwnerRetryOnly
      ? createLegacyProductRigOwnerRetryShutdownRequest(
          state,
          legacyAuthorization,
          acquireLegacyProductRigOwnerRetryIntent(
            legacyAuthorization,
            readJson(cleanupProcessLedgerPath),
          ),
        )
      : {
          version: 1,
          requestId,
          attempt,
          ownerPid: state.ownerPid,
          ownerToken: state.ownerToken,
          cleanupToken: state.runtimeNamespace?.cleanupToken ?? null,
        };
    if (shutdownRequest === null)
      throw new Error("ProductRig legacy owner retry durable request was unavailable");
    writeJsonAtomic(shutdownRequestPath, shutdownRequest);
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
      if (attempt === cleanupAttempts || !strict) throw error;
      continue;
    }
    if (finalState.cleanup?.status === "passed") {
      if (
        legacyOwnerRetryOnly &&
        (finalState.cleanup.requestId !== requestId ||
          finalState.cleanup.cleanupToken !== state.runtimeNamespace?.cleanupToken ||
          finalState.ownerPid !== state.ownerPid ||
          finalState.ownerToken !== state.ownerToken)
      )
        throw new Error("ProductRig legacy owner retry response identity was invalid");
      requestId = finalState.cleanup.requestId;
      retainedCleanupIdentities = legacyOwnerRetryOnly
        ? null
        : acquireCleanupReapProof(finalState, requestId, true);
      break;
    }
    if (attempt === cleanupAttempts && !legacyLedger)
      throw new Error(
        `ProductRig cleanup failed after bounded retry: ${(finalState.cleanup?.failures ?? [])
          .map(({ subsystem, detail }) => `${subsystem}:${detail}`)
          .join(", ")}`,
      );
  }

  if (legacyLedger && finalState.cleanup?.status !== "passed") {
    finalState = await finalizeLegacyCleanup(finalState);
    requestId = finalState.cleanup.requestId;
    retainedCleanupIdentities = null;
  }

  const deathDeadline = Date.now() + 5_000;
  while (processAlive(finalState.ownerPid) && Date.now() < deathDeadline)
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  let retainedStatus = legacyLedger
    ? cleanupReapStatus(null, finalState, requestId)
    : legacyOwnerRetryOnly
      ? "absent"
      : finalizeCleanupReapProof(finalState, requestId, retainedCleanupIdentities);
  if (legacyOwnerRetryOnly) {
    const persistedIntent = acquireLegacyProductRigOwnerRetryIntent(
      legacyAuthorization,
      readJson(cleanupProcessLedgerPath),
    );
    if (
      persistedIntent === null ||
      !legacyProductRigOwnerRetryIntentMatchesState(
        legacyOwnerRetryInitialState,
        legacyAuthorization,
        persistedIntent,
      )
    )
      throw new Error("ProductRig legacy owner retry durable intent was unavailable");
    finalState = finalizeLegacyOwnerRetry(finalState, persistedIntent);
    retainedStatus = "absent";
  }
  if (strict) {
    const failures = productRigCleanupBarrierFailures(finalState, requestId, {
      processAlive,
      pathExists: existsSync,
      retainedProcessIdentityStatus: () => retainedStatus,
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

async function conditionExactSinglePaneTmuxFixture(socketPath, session, paneId, timeoutMs = 5_000) {
  const deadline = performance.now() + timeoutMs;
  const target = `=${session}:=one`;
  const run = (args) => runBoundedFocusTmux({ socketPath, args, deadline });
  await run(["set-option", "-w", "-t", target, "pane-border-status", "top"]);
  await run(["resize-window", "-t", target, "-x", "132", "-y", "41"]);
  let previousDigest = null;
  let stableSamples = 0;
  while (performance.now() < deadline) {
    const stdout = await run([
      "list-panes",
      "-t",
      target,
      "-F",
      "#{pane-border-status}\t#{pane_id}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}",
    ]);
    const rows = stdout.trimEnd().split("\n").filter(Boolean);
    const fields = rows[0]?.split("\t") ?? [];
    const geometry = Object.freeze({
      paneId: fields[1] ?? null,
      left: Number(fields[2]),
      top: Number(fields[3]),
      width: Number(fields[4]),
      height: Number(fields[5]),
    });
    const exact =
      rows.length === 1 &&
      fields[0] === "top" &&
      geometry.paneId === paneId &&
      geometry.left === 0 &&
      geometry.width === 132 &&
      geometry.height === 40;
    const digest = exact ? JSON.stringify(geometry) : null;
    stableSamples = digest !== null && digest === previousDigest ? stableSamples + 1 : 0;
    previousDigest = digest;
    if (stableSamples >= 2) return geometry;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("single-pane tmux fixture did not settle at hosted TUI geometry");
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

async function driveExactHostedInput(state, document, signal) {
  let output;
  try {
    output = await tuiCommandAsync(state, ["input", JSON.stringify(document)], {
      // The document retains its exact product deadline. This fixed outer-only
      // grace lets the helper publish typed progress and dispose its hook.
      timeout: testdriveInputSupervisorTimeout(document.timeoutMs),
      signal,
    });
  } catch (error) {
    const observation = parseTestdriveInputFailureObservation(error?.stderr, document.kind);
    if (observation) error.observation = observation;
    throw error;
  }
  const receipt = JSON.parse(output);
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
    receipt.bytesInjected < 1 ||
    !Number.isSafeInteger(receipt.phases) ||
    receipt.phases < 1 ||
    receipt.phases > 32 ||
    !Number.isSafeInteger(receipt.transportCalls) ||
    receipt.transportCalls < 1 ||
    receipt.transportCalls > 5
  )
    throw new Error("hosted input receipt was invalid");
  return Object.freeze(receipt);
}

async function selectionPreCleanTmuxSnapshot(state, session) {
  try {
    const stdout = await runBoundedFocusTmux({
      socketPath: state.runtimeNamespace.tmuxSocketPath,
      args: [
        "list-panes",
        "-t",
        session,
        "-F",
        "#{pane_id}\\t#{@tmux_ide_pane_id}\\t#{pane_width}\\t#{pane_height}",
      ],
      deadline: performance.now() + 500,
      maxBuffer: 64 * 1_024,
    });
    const rows = stdout.trimEnd().split("\n").filter(Boolean).slice(0, 514);
    return Object.freeze({
      available: rows.length > 0 && rows.length <= 513,
      paneCount: Math.min(rows.length, 513),
    });
  } catch {
    return Object.freeze({ available: false, paneCount: 0 });
  }
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

async function provePreseededPanePublication(state, seed, canonicalResources, timeoutMs = 5_000) {
  const count = (value, token) => value.split(token).length - 1;
  const deadline = performance.now() + timeoutMs;
  let sample = null;
  while (performance.now() < deadline) {
    const geometryBefore = activeWindowPaneGeometry(state);
    const paneGeometry = geometryBefore.find(({ paneId }) => paneId === seed.paneId);
    if (!paneGeometry?.semanticPaneId)
      throw new Error("preseed pane lost its canonical semantic id");
    const resourceMatches = canonicalResources.filter(
      ({ semanticPaneId }) => semanticPaneId === paneGeometry.semanticPaneId,
    );
    if (resourceMatches.length !== 1)
      throw new Error("preseed pane lost its unique canonical application-shell identity");
    const target = Object.freeze({
      ...paneGeometry,
      canonicalDisplayNames: Object.freeze([
        ...new Set([...paneGeometry.canonicalDisplayNames, resourceMatches[0].resourceTitle]),
      ]),
    });
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
    const seedObservation = error?.observation ?? null;
    error.observation = Object.freeze({
      matchingPublications: Number.isSafeInteger(seedObservation?.matchingPublications)
        ? Math.min(seedObservation.matchingPublications, 257)
        : null,
      matchingPaints: Number.isSafeInteger(seedObservation?.matchingPaints)
        ? Math.min(seedObservation.matchingPaints, 257)
        : null,
      canonicalGeometryExact:
        seedObservation?.canonicalGeometry?.cols === sample.geometry.width &&
        seedObservation?.canonicalGeometry?.rows === sample.geometry.height + 1,
      viewportGeometryExact:
        seedObservation?.viewportGeometry?.cols === sample.bodyRect.width &&
        seedObservation?.viewportGeometry?.rows === sample.geometry.height,
      sourceEpochExact: seedObservation?.sourceEpoch === 1,
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
  const captureEvidence = state.card5CaptureEvidence;
  if (!captureEvidence) {
    throw new Error("Card5 owner did not publish its existing-client correlation capture");
  }
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

async function diagnoseCard5Journey(planEntry, journeyEvidenceKey, assess) {
  diagnosticAttemptPhases.set(planEntry.runId, "product-rig-startup");
  await start(false, true, planEntry);
  const state = await waitForState((candidate) => candidate?.status === "ready");
  diagnosticAttemptPhases.set(planEntry.runId, "evidence-capture");
  const captureEvidence = state.card5CaptureEvidence;
  if (!captureEvidence) {
    throw new Error("Card5 owner did not publish its existing-client correlation capture");
  }
  diagnosticCaptures.set(planEntry.runId, captureEvidence);
  await tuiCommandAsync(state, ["stop"], { timeout: 5_000 });
  const privateEvidenceKey = productInputFingerprintKeys.get(state.tui.runtimeDir) ?? null;
  if (!/^[0-9a-f]{64}$/u.test(privateEvidenceKey ?? "")) {
    throw new Error("Card5 private evidence key was unavailable for final correlation");
  }
  const diagnosticBinding = createCard5DiagnosticEvidenceBinding({
    journeyEvidence: state.journeyEvidence,
    journeyEvidenceKey,
    privateEvidenceKey,
  });
  const journeyEvidence = diagnosticBinding.evidence;
  const artifactCorrelation = diagnosticBinding.correlate((boundEvidence, boundPrivateKey) =>
    card5ArtifactCorrelation(state, captureEvidence, boundEvidence, boundPrivateKey),
  );
  const card5CorrelationComplete =
    journeyEvidence?.correlation?.complete === true &&
    journeyEvidence?.correlation?.missingJoinCount === 0 &&
    journeyEvidence?.correlation?.duplicateJoinCount === 0 &&
    artifactCorrelation.complete === true;
  const correlationMissing = [
    ...(artifactCorrelation.missing ?? []),
    ...(journeyEvidence?.correlation?.complete === true ? [] : ["card5-correlation"]),
  ];
  const correlation = Object.freeze({
    complete: card5CorrelationComplete,
    missing: card5CorrelationComplete ? [] : Object.freeze([...new Set(correlationMissing)]),
    artifactHmac: card5CorrelationComplete ? artifactCorrelation.artifactHmac : null,
  });
  const assessment = diagnosticBinding.assess((boundEvidence, boundPrivateKey) =>
    assess({
      evidence: boundEvidence,
      correlationComplete: correlation.complete,
      evidenceKey: boundPrivateKey,
    }),
  );
  const failureObservation = assessment.qualified
    ? null
    : journeyEvidenceKey === "crossClientHandoff"
      ? card5CrossClientFailureObservation(assessment, journeyEvidence)
      : card5DaemonRestartFailureObservation(assessment, journeyEvidence);
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
    failureObservation,
    [journeyEvidenceKey]: journeyEvidence,
    diagnosticCorrelation: {
      complete: correlation.complete,
      missing: correlation.missing,
      artifactHmac: correlation.artifactHmac,
    },
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
        availability: artifactCorrelation.availability,
        failureObservation,
      },
      timeline: readDiagnosticText(timelinePath),
      tmuxTruth: captureEvidence.truth,
      daemonState: artifactCorrelation.daemonState,
      clientState: artifactCorrelation.clientState,
      tuiAnsi: readDiagnosticText(captureEvidence.tuiPath),
      webPngPath: captureEvidence.webPath,
      stderr: boundedDiagnosticText(readDiagnosticText(join(state.tui.runtimeDir, "stderr.log"))),
      reproduction: diagnosticReproduction(planEntry.journey.id, null),
    },
  };
}

const diagnoseCrossClientHandoff = (planEntry) =>
  diagnoseCard5Journey(planEntry, "crossClientHandoff", assessCard5CrossClientEvidence);

const diagnoseDaemonRestart = (planEntry) =>
  diagnoseCard5Journey(planEntry, "daemonRestart", assessCard5DaemonRestartEvidence);

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

async function diagnoseSelectionCopyAppMouse(planEntry) {
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
  const journeyEvidence = state.journeyEvidence?.selectionCopyAppMouse ?? null;
  const causal = assessProductSelectionCopyAppMouse({
    evidence: journeyEvidence,
    expected: journeyEvidence?.expected ?? null,
  });
  const assessment = assessSelectionCopyAppMouseJourneyBoundaries({
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
    selectionCopyAppMouse: journeyEvidence,
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

async function diagnoseAnsiCursorAltScreen(planEntry) {
  diagnosticAttemptPhases.set(planEntry.runId, "product-rig-startup");
  const state = await start(false, true, planEntry);
  diagnosticAttemptPhases.set(planEntry.runId, "evidence-capture");
  const captureEvidence = await captureArtifacts(
    state,
    `diagnose-${planEntry.journey.id}-r${planEntry.repetition}`,
  );
  diagnosticCaptures.set(planEntry.runId, captureEvidence);
  await tuiCommandAsync(state, ["stop"], { timeout: 5_000 });
  const timeline = readJsonLines(timelinePath);
  const correlation = productDiagnosticCorrelation(state, captureEvidence);
  const journeyEvidence = state.journeyEvidence?.ansiCursorAltScreen ?? null;
  const expected = state.journeyEvidence?.ansiCursorAltScreenExpected ?? null;
  const causal = assessAnsiCursorAltScreenEvidence(journeyEvidence, expected);
  const assessment = ansiCursorAltJourneyStatus({
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
    ansiCursorAltScreen: journeyEvidence,
    ansiCursorAltScreenExpected: expected,
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
        ansiCursorAltScreen: journeyEvidence,
        ansiCursorAltScreenExpected: expected,
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
    "selection-copy-app-mouse": diagnoseSelectionCopyAppMouse,
    "ansi-cursor-alt-screen": diagnoseAnsiCursorAltScreen,
    "cross-client-handoff": diagnoseCrossClientHandoff,
    "daemon-restart": diagnoseDaemonRestart,
    "runtime-qualification": diagnoseRuntimeQualification,
  });
}

async function card5DaemonPaneStreamLifecycle(state, options) {
  const tracePath = state?.tui?.daemonPerformanceTracePath;
  const evidenceKey = state?.tui?.runtimeDir
    ? productInputFingerprintKeys.get(state.tui.runtimeDir)
    : null;
  return projectProductPaneStreamLifecycle(tracePath, evidenceKey, options);
}

async function prepareDiagnosticFailure(
  planEntry,
  error,
  firstBrokenBoundary,
  _cleanupReceipt,
  preCleanupFailureEvidence,
) {
  const state = readJson(statePath);
  const partialRuntime = partialProductRuntimeEvidence(state);
  let failureObservation = error?.observation ?? state?.failureObservation ?? null;
  if (
    failureObservation?.operation === "card5-production-host-launch" &&
    ["chromium-readiness", "electron-readiness"].includes(failureObservation.stage)
  ) {
    failureObservation = Object.freeze({
      ...failureObservation,
      daemonPaneStreamLifecycle:
        preCleanupFailureEvidence?.daemonPaneStreamLifecycle ??
        Object.freeze({
          available: false,
          reason: "pre-cleanup-evidence-unavailable",
          count: 0,
          overflow: 0,
          events: Object.freeze([]),
        }),
    });
  }
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
  if (
    !captureEvidence &&
    ["cross-client-handoff", "daemon-restart"].includes(planEntry.journey.id)
  ) {
    captureEvidence = state?.card5CaptureEvidence ?? null;
  }
  if (
    !captureEvidence &&
    state?.status === "ready" &&
    !["cross-client-handoff", "daemon-restart"].includes(planEntry.journey.id)
  ) {
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
  if (
    !truth &&
    state?.session &&
    !["cross-client-handoff", "daemon-restart"].includes(planEntry.journey.id)
  ) {
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
      commit:
        state?.tui?.performanceTraceCommit ??
        state?.diagnosticAttempt?.sourceProvenance?.commit ??
        null,
      tree:
        state?.tui?.performanceTraceTree ??
        state?.diagnosticAttempt?.sourceProvenance?.tree ??
        null,
      manifestDigest:
        state?.tui?.performanceTraceManifestDigest ??
        state?.diagnosticAttempt?.sourceProvenance?.manifestDigest ??
        null,
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
      captureFailureEvidence: async (error, _boundary, signal) => {
        if (
          error?.observation?.operation !== "card5-production-host-launch" ||
          !["chromium-readiness", "electron-readiness"].includes(error.observation.stage)
        )
          return null;
        const state = readJson(statePath);
        if (state?.failureObservation?.daemonPaneStreamLifecycle)
          return Object.freeze({
            daemonPaneStreamLifecycle: state.failureObservation.daemonPaneStreamLifecycle,
          });
        return Object.freeze({
          daemonPaneStreamLifecycle: await card5DaemonPaneStreamLifecycle(state, { signal }),
        });
      },
      prepareFailure: (error, boundary, receipt, preCleanupEvidence) =>
        prepareDiagnosticFailure(entry, error, boundary, receipt, preCleanupEvidence),
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
  if (plan.some(({ journey }) => ["cross-client-handoff", "daemon-restart"].includes(journey.id))) {
    await execFileAsync("pnpm", ["--filter", "@tmux-ide/electron-shell", "build"], {
      cwd: repoRoot,
      timeout: 120_000,
    });
  }
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
  const card5Journey = ["cross-client-handoff", "daemon-restart"].includes(journeyId);
  const card5InputFingerprintKey = card5Journey ? randomBytes(32).toString("hex") : null;
  const slug = randomBytes(3).toString("hex");
  const ownerToken = randomBytes(24).toString("hex");
  let sleepAssertion = null;
  let fleet = null;
  let daemon = null;
  let devServer = null;
  let browser = null;
  let card5WebHosts = null;
  let card5WebHostLease = null;
  let card5TuiEvidence = null;
  let card5NativeExpectedMarker = null;
  let card5TuiProcessPid = null;
  let card5WebCleanupReceipt = null;
  let closing = false;
  let cleanupPromise = null;
  let sleepAssertionAcquisition = null;
  const ownerAbort = new AbortController();
  const inheritedRunId = process.env.TMUX_IDE_PRODUCT_RUN_ID;
  const inheritedSourceCommit = process.env.TMUX_IDE_PRODUCT_EXPECTED_SOURCE_COMMIT;
  const inheritedSourceTree = process.env.TMUX_IDE_PRODUCT_EXPECTED_SOURCE_TREE;
  const inheritedSourceManifest = process.env.TMUX_IDE_PRODUCT_EXPECTED_SOURCE_MANIFEST;
  const inheritedDiagnosticAttempt =
    typeof inheritedRunId === "string" &&
    /^[a-z0-9][a-z0-9-]{0,159}$/u.test(inheritedRunId) &&
    typeof inheritedSourceCommit === "string" &&
    /^[0-9a-f]{40,64}$/u.test(inheritedSourceCommit) &&
    typeof inheritedSourceTree === "string" &&
    /^[0-9a-f]{40,64}$/u.test(inheritedSourceTree) &&
    typeof inheritedSourceManifest === "string" &&
    /^[0-9a-f]{64}$/u.test(inheritedSourceManifest)
      ? Object.freeze({
          runId: inheritedRunId,
          resourcesCreated: false,
          sourceProvenance: Object.freeze({
            commit: inheritedSourceCommit,
            tree: inheritedSourceTree,
            manifestDigest: inheritedSourceManifest,
          }),
        })
      : null;
  let state = {
    version: PRODUCT_RIG_STATE_VERSION,
    status: "starting",
    ownerPid: process.pid,
    ownerToken,
    daemonLifecycle: "not-started",
    artifactDir,
    timelinePath,
    ...(inheritedDiagnosticAttempt ? { diagnosticAttempt: inheritedDiagnosticAttempt } : {}),
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
          {
            subsystem: "card5-web-hosts",
            run: async () => {
              card5WebCleanupReceipt =
                (await card5WebHostLease?.close()) ?? card5WebHostLease?.snapshot() ?? null;
            },
          },
          { subsystem: "card5-tui-evidence", run: async () => card5TuiEvidence?.close() },
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
      let card5Cleanup = null;
      if (["cross-client-handoff", "daemon-restart"].includes(journeyId)) {
        const ownedPaths = [
          state.runtimeNamespace?.root,
          state.runtimeNamespace?.tmuxSocketPath,
          state.runtimeNamespace?.hostTmuxSocketPath,
          state.runtimeNamespace?.daemonInfoDir,
        ].filter((path) => typeof path === "string");
        const pathResidueCount = ownedPaths.filter((path) => existsSync(path)).length;
        const socketResidueCount = ownedPaths.filter(
          (path) => path.endsWith(".sock") && existsSync(path),
        ).length;
        card5Cleanup = card5HostCleanupStatus({
          entries: {
            chromium: {
              owned: card5WebCleanupReceipt?.chromiumOwned === true,
              retired: card5WebCleanupReceipt?.chromiumRetired === true,
              reason: card5WebCleanupReceipt?.chromiumReason ?? "cleanup-receipt-missing",
            },
            electron: {
              owned: card5WebCleanupReceipt?.electronOwned === true,
              retired: card5WebCleanupReceipt?.electronRetired === true,
              reason: card5WebCleanupReceipt?.electronReason ?? "cleanup-receipt-missing",
            },
            opentui: {
              owned: Number.isSafeInteger(card5TuiProcessPid),
              retired:
                !Number.isSafeInteger(card5TuiProcessPid) || !processAlive(card5TuiProcessPid),
              reason: Number.isSafeInteger(card5TuiProcessPid)
                ? "owner-process-retirement"
                : "not-acquired",
            },
            daemon: {
              owned: daemon !== null,
              retired: !processAlive(state.daemon?.pid),
              reason: daemon === null ? "not-acquired" : "owner-process-retirement",
            },
            namespace: {
              owned: fleet !== null,
              retired: pathResidueCount === 0,
              reason: fleet === null ? "not-acquired" : "owned-path-retirement",
            },
          },
          ...(card5WebCleanupReceipt ?? {}),
          launchStage: card5WebCleanupReceipt?.launchStage ?? "unknown",
          socketResidueCount,
          nativeObserverProcessCount: [...activeCard5NativeObserverPids].filter(processAlive)
            .length,
          pathResidueCount,
        });
        if (!card5Cleanup.passed) {
          failures.push({
            subsystem: "card5-cleanup-ledger",
            detail: "owned host residue remained",
          });
        }
      }
      let processReap = null;
      if (["cross-client-handoff", "daemon-restart"].includes(journeyId)) {
        const rows = cleanupProcessRows();
        const ownerIdentity = rows?.find(({ pid }) => pid === process.pid) ?? null;
        const retained = card5WebCleanupReceipt?.retainedProcessIdentities;
        const terminalIdentities = Array.isArray(retained)
          ? retained
              .filter(
                (entry) =>
                  ["chromium", "electron"].includes(entry?.host) &&
                  Number.isSafeInteger(entry?.pid) &&
                  entry.pid > 0 &&
                  Number.isSafeInteger(entry?.pgid) &&
                  entry.pgid > 0 &&
                  typeof entry?.startToken === "string" &&
                  entry.startToken.length > 0 &&
                  entry.startToken.length <= 64,
              )
              .map(({ host, pid, pgid, startToken }) => ({
                kind: host,
                pid,
                pgid,
                startToken,
              }))
          : [];
        const expectedTerminalCount =
          (card5Cleanup?.chromiumTerminalProcessCount ?? 0) +
          (card5Cleanup?.electronTerminalProcessCount ?? 0);
        if (
          !ownerIdentity ||
          !Array.isArray(retained) ||
          retained.length !== terminalIdentities.length ||
          terminalIdentities.length !== expectedTerminalCount ||
          terminalIdentities.length > 64
        ) {
          failures.push({
            subsystem: "card5-process-reap-ledger",
            detail: "exact retained process identities were unavailable",
          });
        } else {
          const identities = [
            {
              kind: "owner",
              pid: ownerIdentity.pid,
              pgid: ownerIdentity.pgid,
              startToken: ownerIdentity.startToken,
            },
            ...terminalIdentities,
          ];
          const identityHmac = cleanupIdentityAttestation(ownerToken, identities);
          writeJsonAtomic(cleanupProcessLedgerPath, {
            version: 1,
            requestId,
            ownerPid: process.pid,
            cleanupToken: state.runtimeNamespace?.cleanupToken ?? null,
            identities,
            identityHmac,
          });
          processReap = Object.freeze({
            version: 1,
            identityCount: identities.length,
            terminalIdentityCount: terminalIdentities.length,
            identityHmac,
          });
        }
      }
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
          ...(card5Cleanup ? { card5: card5Cleanup } : {}),
          ...(processReap ? { processReap } : {}),
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
    const pendingReapAck = isProductRigPendingReapAck(state, request, journeyId);
    if (
      !request ||
      request.ownerPid !== process.pid ||
      request.ownerToken !== ownerToken ||
      (state.runtimeNamespace?.cleanupToken &&
        request.cleanupToken !== state.runtimeNamespace.cleanupToken) ||
      (request.requestId === state.cleanup?.requestId && !pendingReapAck)
    )
      return;
    handlingShutdownRequest = true;
    void (pendingReapAck ? Promise.resolve({ passed: true, failures: [] }) : cleanup(request))
      .then(async (result) => {
        if (result.passed) {
          if (["cross-client-handoff", "daemon-restart"].includes(journeyId)) {
            const deadline = Date.now() + 5_000;
            let acknowledged = false;
            while (Date.now() < deadline) {
              const ack = readJson(cleanupReapAckPath);
              if (
                ack?.version === 1 &&
                ack.requestId === request.requestId &&
                ack.ownerPid === process.pid &&
                ack.ownerToken === ownerToken &&
                ack.identityHmac === state.cleanup?.processReap?.identityHmac
              ) {
                acknowledged = true;
                break;
              }
              await new Promise((resolveWait) => setTimeout(resolveWait, 10));
            }
            if (!acknowledged) return;
          }
          clearInterval(shutdownPoller);
          rmSync(shutdownRequestPath, { force: true });
          rmSync(cleanupReapAckPath, { force: true });
          process.exit(typeof state.failure === "string" ? 1 : 0);
        }
      })
      .finally(() => {
        handlingShutdownRequest = false;
      });
  }, 50);

  try {
    rmSync(timelinePath, { force: true });
    // Persist the parent-frozen run/provenance identity before any namespace
    // operation can create resources or fail validation.
    publish({});
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
    if (journeyId === "selection-copy-app-mouse") {
      let selectionReadiness = null;
      const selectionHmac = (key, value) =>
        createHmac("sha256", key).update(String(value)).digest("hex");
      const selectionDeliveryEvidence = (delivery, key, clipboard) =>
        Object.freeze({
          ...delivery,
          ...(clipboard ? { clipboard } : {}),
          ...(delivery.selectionStyle
            ? {
                selectionStyle: Object.freeze({
                  cells: delivery.selectionStyle.cells,
                  extraChangedCells: delivery.selectionStyle.extraChangedCells,
                  presentationHmac: selectionHmac(key, delivery.selectionStyle.frameDigest),
                }),
              }
            : {}),
        });
      const captureSelectionFrame = async () => {
        const envelope = JSON.parse(
          await tuiCommandAsync(state, ["capture", "--ansi", "--json"], {
            timeout: 1_500,
            signal: ownerAbort.signal,
          }),
        );
        return Object.freeze({ envelope, capture: decodeFocusFramebufferCapture(envelope) });
      };
      const exactSelectionPoint = (plain, marker) => {
        const lines = plain.split("\n");
        const y = lines.findIndex((line) => line.includes(marker));
        const x = y < 0 ? -1 : lines[y].indexOf(marker);
        if (x < 28 || y < 3 || x + marker.length > 160 || y >= 44)
          throw new Error("selection marker was not in the exact terminal content rectangle");
        return Object.freeze({
          from: Object.freeze({ x, y }),
          to: Object.freeze({ x: x + marker.length - 1, y }),
          contentRect: Object.freeze({ x: 28, y: 3, width: 132, height: 40 }),
        });
      };
      const selectionBoot = await runSelectionCopyAppMouseOwnerBoot({
        onBoundary: (boundary) =>
          publish({
            currentJourneyBoundary: boundary,
            currentJourneyBoundaryAtWallMs: Date.now(),
            currentJourneyBoundaryAtMonotonicMs: performance.now(),
          }),
        createNamespace: async () => {
          const marker = `SELECT_${randomBytes(6).toString("hex").toUpperCase()}`;
          const modeMarker = `MOUSE_READY_${randomBytes(6).toString("hex").toUpperCase()}`;
          const mouseProgram = selectionMouseFixtureProgram();
          const scratchFleet = await createScratchFleet({
            sessions: 1,
            slug,
            windowsPerSession: 1,
            initialPaneCommand: {
              executable: process.execPath,
              args: ["-e", mouseProgram, marker, modeMarker],
            },
          });
          fleet = scratchFleet;
          const session = scratchFleet.sessionNames[0];
          const initialPane = scratchFleet.initialPanes[0];
          if (!initialPane) throw new Error("selection namespace lost its exact initial pane");
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
              runtimeDir: join(rigRoot, "tui-selection-copy-app-mouse"),
              performanceTracePath: join(
                rigRoot,
                "tui-selection-copy-app-mouse",
                "performance-trace.jsonl",
              ),
              performanceTraceDetail: "1",
              daemonPerformanceTracePath: null,
            },
            publish,
            resolveProvenance: sourceTraceProvenance,
            createRuntimeDir: createIsolatedTargetedTuiCwd,
          });
          const evidenceKey = randomBytes(32);
          productInputFingerprintKeys.set(tui.runtimeDir, evidenceKey.toString("hex"));
          publish({ session, runtimeNamespace, tui });
          event("selection-namespace-ready", { windows: 1, panes: 1 });
          return Object.freeze({
            session,
            marker,
            modeMarker,
            seed: { marker, paneId: initialPane.paneId, geometry: initialPane },
            runtimeNamespace,
            tui,
            evidenceKey,
          });
        },
        startDaemon: async () => {
          daemon = await startOwnedProductRigDaemon({
            start: () => startDaemon(fleet),
            publish,
            waitUntilReady: waitForReadinessLadder,
          });
          return daemon;
        },
        openWorkspace: async (namespace, runningDaemon) => {
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
          event("selection-daemon-ready", identity);
          return identity;
        },
        build: async () => {
          await execFileAsync("bun", [join(repoRoot, "scripts", "build-tui.mjs")], {
            cwd: repoRoot,
            timeout: 120_000,
          });
          prepareIsolatedTargetedTuiCwd(state.tui.runtimeDir);
          event("selection-tui-build", {});
        },
        launch: async (namespace) => {
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
            throw new Error("selection TUI launch receipt was invalid");
          const controller = new AbortController();
          const abort = () => controller.abort();
          ownerAbort.signal.addEventListener("abort", abort, { once: true });
          selectionReadiness = {
            launched,
            controller,
            startedAt: performance.now(),
            deadlineMs: 50_000,
            timer: setTimeout(() => controller.abort(), 50_000),
            detach: () => ownerAbort.signal.removeEventListener("abort", abort),
          };
          event("selection-tui-started", { processId: launched.processId });
          return launched;
        },
        waitHost: async (_namespace, _daemon, _identity, launched) => {
          if (!selectionReadiness || selectionReadiness.launched !== launched)
            throw new Error("selection readiness owner was unavailable");
          const host = await waitForExactFocusHostReceipt(state, launched, {
            deadlineMs: 10_000,
            signal: selectionReadiness.controller.signal,
          });
          event("selection-host-ready", { processId: launched.processId });
          return host;
        },
        waitCoherent: async (_namespace, _daemon, _identity, launched, host) => {
          const readiness = selectionReadiness;
          if (!readiness || readiness.launched !== launched)
            throw new Error("selection readiness owner was unavailable");
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
            selectionReadiness = null;
          }
          event("selection-tui-coherent", { processId: launched.processId });
          return Object.freeze({
            processId: launched.processId,
            launchId: launched.launchId,
            hostIdentity: launched.hostIdentity,
          });
        },
        proveBaseline: async (namespace, runningDaemon, identity, process, host) => {
          const shell = await waitForProductApplicationShell(
            runningDaemon,
            namespace.session,
            (candidate) => productWindowResources(candidate).length === 1,
            10_000,
            1,
          );
          const resources = productWindowResources(shell);
          const publication = await provePreseededPanePublication(state, namespace.seed, resources);
          const selected = resources[0];
          if (!selected?.active || selected.semanticPaneId !== publication.semanticPaneId)
            throw new Error("selection baseline did not join the exact active pane");
          const processId = `opentui:${process.processId}`;
          const workspaceClient = await waitForQualifiedWorkspaceClientState(
            () => readJsonLines(join(namespace.tui.runtimeDir, "performance.jsonl")),
            {
              processId,
              daemonGeneration: runningDaemon.record.instanceId,
              workspaceName: identity.workspaceName,
              sessionName: identity.sessionName,
              fleetSessionId: identity.fleetSessionId,
              semanticPaneId: selected.semanticPaneId,
              canonicalGeneration: publication.canonicalSeedPaint.publication.generation,
            },
          );
          const terminalResourceRevision = workspaceClient.committed.terminalResourceRevision;
          if (!Number.isSafeInteger(terminalResourceRevision) || terminalResourceRevision < 0)
            throw new Error("selection baseline terminal resource revision was unavailable");
          const tmux = await exactWindowTmuxSnapshot(state, resources);
          const seedPaint = publication.canonicalSeedPaint;
          const modeExpected = Object.freeze({
            processId: seedPaint.publication.processId,
            clockId: seedPaint.publication.clockId,
            daemonGeneration: runningDaemon.record.instanceId,
            semanticPaneId: selected.semanticPaneId,
            canonicalGeneration: seedPaint.publication.generation,
            canonicalIncarnation: seedPaint.publication.incarnation,
            beforeStateHash: seedPaint.publication.stateHash,
            afterRevision: seedPaint.publication.revision,
            sourceEpoch: seedPaint.publication.sourceEpoch,
            rendererEpoch: publication.frameCausality.hostFrame.rendererEpoch,
            canonicalCols: seedPaint.publication.cols,
            canonicalRows: seedPaint.publication.rows,
            viewportCols: seedPaint.paint.viewportCols,
            viewportRows: seedPaint.paint.viewportRows,
          });
          let conditioning;
          let frame;
          try {
            const traceWatermark = readJsonLines(namespace.tui.performanceTracePath).length;
            const delivery = await driveExactHostedInput(
              state,
              { version: 1, kind: "control-key", key: "y", timeoutMs: 2_000 },
              ownerAbort.signal,
            );
            if (
              delivery.requestedKey !== "y" ||
              delivery.bytesInjected !== 1 ||
              delivery.paneId !== host.hostIdentity.paneId ||
              delivery.sessionId !== host.hostIdentity.sessionId
            )
              throw new Error("selection mouse-mode conditioning delivery was not exact");
            conditioning = await waitForSelectionMouseModeConditioning({
              readRecords: () =>
                readJsonLines(namespace.tui.performanceTracePath).slice(traceWatermark),
              expected: modeExpected,
              signal: ownerAbort.signal,
            });
            frame = await captureSelectionFrame();
            exactSelectionPoint(frame.capture.plain, namespace.modeMarker);
            if ((frame.capture.plain.match(/APP_MOUSE_/gu) ?? []).length !== 0)
              throw new Error("mouse-mode conditioning fabricated an application mouse receipt");
          } catch (error) {
            const records = readJsonLines(namespace.tui.performanceTracePath);
            const latestMode = records
              .filter(
                (record) =>
                  record?.type === "performance.terminal-canonical-mode" &&
                  record.semanticPaneId === selected.semanticPaneId &&
                  record.generation === modeExpected.canonicalGeneration,
              )
              .at(-1);
            const preCleanTmux = await selectionPreCleanTmuxSnapshot(state, namespace.session);
            if (error instanceof Error) {
              error.boundary = "selection-baseline";
              error.observation = Object.freeze({
                ...(error.observation ?? {}),
                preCleanTmux,
                mode: Object.freeze({
                  protocol: ["none", "x10", "vt200", "drag", "any"].includes(
                    latestMode?.mouseProtocol,
                  )
                    ? latestMode.mouseProtocol
                    : null,
                  encoding: ["default", "utf8", "sgr", "sgr-pixels"].includes(
                    latestMode?.mouseEncoding,
                  )
                    ? latestMode.mouseEncoding
                    : null,
                  revision: Number.isSafeInteger(latestMode?.revision) ? latestMode.revision : null,
                  samePane: latestMode?.semanticPaneId === selected.semanticPaneId,
                  sameGeneration: latestMode?.generation === modeExpected.canonicalGeneration,
                }),
              });
            }
            throw error;
          }
          const mouseMode = conditioning.qualifiedMode;
          const point = exactSelectionPoint(frame.capture.plain, namespace.marker);
          const baseline = Object.freeze({
            processId,
            daemonGeneration: runningDaemon.record.instanceId,
            clientGeneration: workspaceClient.committed.generation,
            workspaceName: identity.workspaceName,
            sessionName: identity.sessionName,
            semanticPaneId: selected.semanticPaneId,
            canonicalGeneration: publication.canonicalSeedPaint.publication.generation,
            canonicalIncarnation: publication.canonicalSeedPaint.publication.incarnation,
            canonicalStateHash: publication.canonicalSeedPaint.publication.stateHash,
            terminalResourceRevision,
            clientId: processId,
            resources,
            workspaceClient,
            tmux,
            mouseMode: Object.freeze({
              protocol: mouseMode.mouseProtocol,
              encoding: mouseMode.mouseEncoding,
              revision: mouseMode.revision,
              incarnation: mouseMode.incarnation,
              stateHash: mouseMode.stateHash,
            }),
            conditioning: Object.freeze({
              kind: "control-key",
              requestedKey: "y",
              applicationMouseReceipts: 0,
            }),
            point,
            host: Object.freeze({
              paneId: host.hostIdentity.paneId,
              sessionId: host.hostIdentity.sessionId,
            }),
          });
          event("selection-baseline", { resources: 1 });
          return baseline;
        },
        driveSelection: async (namespace, _daemon, _identity, _process, baseline) => {
          let delivery;
          try {
            delivery = await driveExactHostedInput(
              state,
              {
                version: 1,
                kind: "selection-drag",
                ...baseline.point,
                timeoutMs: 3_000,
              },
              ownerAbort.signal,
            );
          } catch (error) {
            if (error && typeof error === "object") {
              const copyFailure = selectionCopyFailureEvidence(
                readJsonLines(join(state.tui.runtimeDir, "performance.jsonl")),
                baseline,
              );
              error.observation = Object.freeze({
                ...(error.observation ?? {
                  operation: "tui-testdrive-input",
                  kind: "selection-drag",
                  substage: "unknown",
                }),
                copyFailure,
                preCleanTmux: await selectionPreCleanTmuxSnapshot(state, namespace.session),
              });
            }
            throw error;
          }
          const expectedClipboard = selectionClipboardEvidence(
            namespace.marker,
            namespace.evidenceKey,
          );
          const expectedClipboardSha = createHash("sha256").update(namespace.marker).digest("hex");
          if (
            !delivery.selectionStyle ||
            delivery.selectionStyle.extraChangedCells !== 0 ||
            delivery.clipboard?.bytes !== expectedClipboard?.bytes ||
            delivery.clipboard?.sha256 !== expectedClipboardSha
          )
            throw new Error("selection visual/clipboard delivery was not exact");
          const records = readJsonLines(join(state.tui.runtimeDir, "performance.jsonl"));
          const copied = records.filter(({ phase }) => phase === "terminal-selection-copy").at(-1);
          if (copied?.copied !== true || copied.semanticPaneId !== baseline.semanticPaneId)
            throw new Error("selection copy lifecycle fence was unavailable");
          event("selection-visible", { cells: delivery.selectionStyle.cells });
          return Object.freeze({
            delivery: selectionDeliveryEvidence(delivery, namespace.evidenceKey, expectedClipboard),
            style: Object.freeze({
              cells: delivery.selectionStyle.cells,
              extraChangedCells: delivery.selectionStyle.extraChangedCells,
            }),
            presentationHmac: selectionHmac(
              namespace.evidenceKey,
              delivery.selectionStyle.frameDigest,
            ),
            copyFence: copied,
          });
        },
        driveCopy: async (namespace, _daemon, _identity, _process, _baseline) => {
          const beforeCopies = readJsonLines(
            join(state.tui.runtimeDir, "performance.jsonl"),
          ).filter(({ phase }) => phase === "terminal-selection-copy");
          const before = beforeCopies.length;
          const priorCopy = beforeCopies.at(-1) ?? null;
          let delivery;
          try {
            delivery = await driveExactHostedInput(
              state,
              { version: 1, kind: "copy-capture", timeoutMs: 3_000 },
              ownerAbort.signal,
            );
          } catch (error) {
            if (error && typeof error === "object") {
              error.observation = Object.freeze({
                ...(error.observation ?? {
                  operation: "tui-testdrive-input",
                  kind: "copy-capture",
                  substage: "unknown",
                }),
                copyFailure: selectionCopyFailureEvidence(
                  readJsonLines(join(state.tui.runtimeDir, "performance.jsonl")),
                  _baseline,
                ),
                preCleanTmux: await selectionPreCleanTmuxSnapshot(state, namespace.session),
              });
            }
            throw error;
          }
          const expectedClipboard = selectionClipboardEvidence(
            namespace.marker,
            namespace.evidenceKey,
          );
          const expectedClipboardSha = createHash("sha256").update(namespace.marker).digest("hex");
          if (
            delivery.clipboard?.bytes !== expectedClipboard?.bytes ||
            delivery.clipboard?.sha256 !== expectedClipboardSha
          )
            throw new Error("Ctrl-C clipboard evidence did not match the selected terminal cells");
          const copies = readJsonLines(join(state.tui.runtimeDir, "performance.jsonl")).filter(
            ({ phase }) => phase === "terminal-selection-copy",
          );
          const copied = copies.at(-1);
          if (
            before !== 1 ||
            priorCopy?.copyOrdinal !== 0 ||
            copies.length !== before + 1 ||
            copied?.copied !== true ||
            copied.copyOrdinal !== priorCopy.copyOrdinal + 1 ||
            copied.semanticPaneId !== _baseline.semanticPaneId ||
            copied.daemonGeneration !== _baseline.daemonGeneration ||
            copied.clientGeneration !== _baseline.clientGeneration ||
            copied.canonicalIdentity?.generation !== _baseline.canonicalGeneration ||
            copied.canonicalIdentity?.incarnation !== _baseline.mouseMode.incarnation ||
            copied.canonicalIdentity?.revision !== _baseline.mouseMode.revision ||
            copied.canonicalIdentity?.stateHash !== _baseline.mouseMode.stateHash
          )
            throw new Error("Ctrl-C copy lifecycle fence was not exact");
          event("selection-copy-proved", { bytes: delivery.clipboard.bytes });
          return Object.freeze({
            delivery: selectionDeliveryEvidence(delivery, namespace.evidenceKey, expectedClipboard),
            copyFence: copied,
            copySequence: Object.freeze({
              beforeCount: before,
              afterCount: copies.length,
              priorOrdinal: priorCopy.copyOrdinal,
              expectedOrdinal: priorCopy.copyOrdinal + 1,
              actualOrdinal: copied.copyOrdinal,
              identityExact: true,
            }),
          });
        },
        driveAppMouse: async (namespace, _daemon, _identity, _process, baseline) => {
          const point = baseline.point.from;
          const deliveries = [];
          const beforePerformance = readJsonLines(join(state.tui.runtimeDir, "performance.jsonl"));
          const selectReceiptWatermark = Math.max(
            0,
            ...beforePerformance
              .map((record) => record?.workspaceClient?.committed?.lastReceipt?.sequence)
              .filter(Number.isSafeInteger),
          );
          const copyCountBefore = readJsonLines(
            join(state.tui.runtimeDir, "performance.jsonl"),
          ).filter(({ phase }) => phase === "terminal-selection-copy").length;
          try {
            for (let gesture = 0; gesture < 10; gesture += 1)
              for (const [action, x] of [
                ["down", point.x],
                ["drag", point.x + 1],
                ["up", point.x + 1],
              ]) {
                deliveries.push(
                  await driveExactHostedInput(
                    state,
                    {
                      version: 1,
                      kind: "application-mouse",
                      action,
                      x,
                      y: point.y,
                      button: "left",
                      modifiers: [],
                      timeoutMs: 2_000,
                    },
                    ownerAbort.signal,
                  ),
                );
                const paintDeadline = performance.now() + 2_000;
                for (;;) {
                  const records = readJsonLines(namespace.tui.performanceTracePath);
                  const origins = records.filter(
                    (record) =>
                      record?.type === "performance.input-origin" &&
                      record.origin === "application-mouse",
                  );
                  const painted = new Set(
                    records
                      .filter(
                        (record) =>
                          record?.type === "performance.stage" && record.stage === "paint",
                      )
                      .map(({ traceId }) => traceId),
                  );
                  if (
                    origins.filter(({ traceId }) => painted.has(traceId)).length >=
                    deliveries.length
                  )
                    break;
                  if (performance.now() >= paintDeadline)
                    throw new Error(
                      "application mouse input did not reach its exact changed-cell paint",
                    );
                  await new Promise((resolveWait) => setTimeout(resolveWait, 5));
                }
              }
          } catch (error) {
            if (error && typeof error === "object") {
              const performanceRecords = readJsonLines(
                join(state.tui.runtimeDir, "performance.jsonl"),
              );
              const traceRecords = readJsonLines(namespace.tui.performanceTracePath);
              let fixtureReceiptCount = 0;
              try {
                const captured = await captureSelectionFrame();
                fixtureReceiptCount = Math.min(
                  [...captured.capture.plain.matchAll(/APP_MOUSE_/gu)].length,
                  64,
                );
              } catch {
                // The bounded structural counters below remain useful when the
                // failure itself prevents framebuffer capture.
              }
              error.observation = applicationMouseForwardFailureObservation({
                performanceRecords,
                traceRecords,
                deliveries,
                expectedPaneId: baseline.semanticPaneId,
                selectReceiptWatermark,
                fixtureReceiptCount,
              });
            }
            throw error;
          }
          const expectedPoint = Object.freeze({
            column: point.x - baseline.point.contentRect.x,
            row: point.y - baseline.point.contentRect.y,
          });
          let receipts = [];
          let samples = null;
          let distribution = null;
          try {
            const frame = await captureSelectionFrame();
            receipts = [
              ...frame.capture.plain.matchAll(/APP_MOUSE_(\d+)_(\d+)_(\d+)_(\d+)_([Mm])/gu),
            ]
              .map((match) =>
                Object.freeze({
                  ordinal: Number(match[1]),
                  code: Number(match[2]),
                  column: Number(match[3]),
                  row: Number(match[4]),
                  release: match[5] === "m",
                }),
              )
              .slice(-deliveries.length);
            const terminalInputDelta = receipts.length;
            const copyCountAfter = readJsonLines(
              join(state.tui.runtimeDir, "performance.jsonl"),
            ).filter(({ phase }) => phase === "terminal-selection-copy").length;
            samples = applicationMouseCausalSamples({
              records: readJsonLines(namespace.tui.performanceTracePath),
              evidenceKey: namespace.evidenceKey,
              expected: {
                processId: baseline.processId,
                semanticPaneId: baseline.semanticPaneId,
                daemonGeneration: baseline.daemonGeneration,
                canonicalGeneration: baseline.canonicalGeneration,
                ...expectedPoint,
              },
              receipts,
            });
            distribution = assessApplicationMouseDistribution(samples, expectedPoint);
            if (terminalInputDelta !== deliveries.length || !distribution.qualified)
              throw new Error("application mouse bytes did not reach the exact pane application");
            event("application-mouse-forwarded", { terminalInputDelta });
            return Object.freeze({
              deliveries: Object.freeze(
                deliveries.map((delivery) =>
                  selectionDeliveryEvidence(delivery, namespace.evidenceKey, null),
                ),
              ),
              terminalInputDelta,
              localSelectionCopyDelta: copyCountAfter - copyCountBefore,
              acceptedReceiptsExact: samples?.every(({ receiptExact }) => receiptExact) === true,
              terminalProofHmac: createHmac("sha256", namespace.evidenceKey)
                .update(frame.capture.plain)
                .digest("hex"),
              distribution,
            });
          } catch (error) {
            if (error && typeof error === "object" && !error.observation)
              error.observation = applicationMouseDistributionFailureObservation({
                samples,
                distribution,
                expected: expectedPoint,
                deliveryCount: deliveries.length,
                receiptCount: receipts.length,
              });
            throw error;
          }
        },
        driveLocalMode: async (namespace, _daemon, _identity, _process, _baseline, appMouse) => {
          const frame = await captureSelectionFrame();
          const point = exactSelectionPoint(frame.capture.plain, namespace.marker);
          const performancePath = join(state.tui.runtimeDir, "performance.jsonl");
          const performanceBefore = readJsonLines(performancePath);
          const traceBefore = readJsonLines(namespace.tui.performanceTracePath);
          const copiesBefore = performanceBefore.filter(
            ({ phase }) => phase === "terminal-selection-copy",
          ).length;
          let delivery;
          try {
            delivery = await driveExactHostedInput(
              state,
              { version: 1, kind: "selection-drag", ...point, timeoutMs: 3_000 },
              ownerAbort.signal,
            );
          } catch (error) {
            if (error && typeof error === "object") {
              error.observation = Object.freeze(
                selectionLocalModeFailureObservation({
                  inputObservation: error.observation ?? {
                    operation: "tui-testdrive-input",
                    kind: "selection-drag",
                    substage: "unknown",
                  },
                  performanceRecords: readJsonLines(performancePath),
                  traceRecords: readJsonLines(namespace.tui.performanceTracePath),
                  performanceWatermark: performanceBefore.length,
                  traceWatermark: traceBefore.length,
                  copyCountBefore: copiesBefore,
                  expectedPaneId: _baseline.semanticPaneId,
                  mouseMode: _baseline.mouseMode,
                }),
              );
              error.observation = Object.freeze({
                ...error.observation,
                preCleanTmux: await selectionPreCleanTmuxSnapshot(state, namespace.session),
              });
            }
            throw error;
          }
          const after = await captureSelectionFrame();
          const expectedClipboard = selectionClipboardEvidence(
            namespace.marker,
            namespace.evidenceKey,
          );
          const expectedClipboardSha = createHash("sha256").update(namespace.marker).digest("hex");
          const count = (after.capture.plain.match(/APP_MOUSE_/gu) ?? []).length;
          const copies = readJsonLines(join(state.tui.runtimeDir, "performance.jsonl")).filter(
            ({ phase }) => phase === "terminal-selection-copy",
          );
          if (
            count !== appMouse.terminalInputDelta ||
            delivery.selectionStyle?.extraChangedCells !== 0 ||
            delivery.clipboard?.sha256 !== expectedClipboardSha ||
            copies.length !== copiesBefore + 1 ||
            copies.at(-1)?.copied !== true
          )
            throw new Error("local select mode leaked pointer input to the pane application");
          event("selection-local-mode-proved", { cells: delivery.selectionStyle.cells });
          return Object.freeze({
            delivery: selectionDeliveryEvidence(delivery, namespace.evidenceKey, expectedClipboard),
            point,
            terminalInputDelta: count - appMouse.terminalInputDelta,
            style: Object.freeze({
              cells: delivery.selectionStyle.cells,
              extraChangedCells: delivery.selectionStyle.extraChangedCells,
            }),
            copyFence: copies.at(-1),
          });
        },
        startWeb: async (_namespace, runningDaemon, identity, _process, baseline) => {
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
            derivedResources: baseline.workspaceClient.derived.terminalInventory.resources,
            expectedWorkspaceName: identity.workspaceName,
            expectedSemanticPaneId: baseline.semanticPaneId,
            expectedDaemonGeneration: runningDaemon.record.instanceId,
          });
          const workspaceClient = await waitForWindowWorkspaceEvidence(state, {
            processId: baseline.processId,
            daemonGeneration: baseline.daemonGeneration,
            clientGeneration: baseline.clientGeneration,
            clientId: baseline.clientId,
            workspaceName: baseline.workspaceName,
            sessionName: baseline.sessionName,
            afterMicros: 0,
            boundary: "selection-web-correlation",
            resources: baseline.resources,
            web: true,
            exactTerminalResourceRevision: baseline.terminalResourceRevision,
          });
          publish({ web: { pageUrl: devServer.pageUrl, startedAfterSelectionBoundary: true } });
          event("selection-web-correlation", { terminals: ready.semantic.terminalNodeCount });
          return Object.freeze({
            semantic: ready.semantic,
            readiness: ready.assessment,
            stableExactSamples: ready.stableExactSamples,
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
      const tracePath = state.tui.performanceTracePath;
      const quietBefore = readJsonLines(tracePath).length;
      const quiet = await settleWindowReferenceTrace(
        tracePath,
        quietBefore,
        performance.now() + 2_000,
      );
      const clipboard = selectionClipboardEvidence(
        selectionBoot.namespace.marker,
        selectionBoot.namespace.evidenceKey,
      );
      const writerHealth = selectionBoot.localMode.copyFence.writerHealth;
      const tmuxAfter = await exactWindowTmuxSnapshot(state, selectionBoot.baseline.resources);
      const journeyEvidence = Object.freeze({
        expected: Object.freeze({
          processId: selectionBoot.baseline.processId,
          daemonGeneration: selectionBoot.baseline.daemonGeneration,
          clientGeneration: selectionBoot.baseline.clientGeneration,
          workspaceName: selectionBoot.baseline.workspaceName,
          sessionName: selectionBoot.baseline.sessionName,
          fleetSessionId: selectionBoot.identity.fleetSessionId,
          catalogRevision: selectionBoot.identity.catalogRevision,
          semanticPaneId: selectionBoot.baseline.semanticPaneId,
          canonicalGeneration: selectionBoot.baseline.canonicalGeneration,
          canonicalIncarnation: selectionBoot.baseline.canonicalIncarnation,
          canonicalStateHash: selectionBoot.baseline.canonicalStateHash,
          terminalResourceRevision: selectionBoot.baseline.terminalResourceRevision,
        }),
        baseline: selectionBoot.baseline,
        host: selectionBoot.baseline.host,
        clipboard,
        selection: selectionBoot.selection,
        copy: selectionBoot.copy,
        appMouse: selectionBoot.appMouse,
        localMode: selectionBoot.localMode,
        workspaceClient: selectionWorkspaceClientEvidence(selectionBoot.web.workspaceClient),
        tmux: Object.freeze({
          semanticPaneId: selectionBoot.baseline.semanticPaneId,
          geometryStable: JSON.stringify(tmuxAfter) === JSON.stringify(selectionBoot.baseline.tmux),
          snapshotExact:
            tmuxAfter.length === 1 &&
            tmuxAfter[0]?.semanticPaneId === selectionBoot.baseline.semanticPaneId,
          applicationMouseMode: `${selectionBoot.baseline.mouseMode.encoding}-${selectionBoot.baseline.mouseMode.protocol}`,
        }),
        correlation: selectionBoot.web.correlation,
        web: selectionWebEvidence(selectionBoot.web, selectionBoot.baseline.semanticPaneId),
        work: Object.freeze({
          identicalIdleFrames: quiet.tail.filter(({ type }) => type === "performance.frame").length,
          unchangedPaneGridWalks: quiet.tail.filter(
            ({ type }) => type === "performance.terminal-paint",
          ).length,
          terminalPaintsOutsideGestures: quiet.tail.filter(
            ({ type }) => type === "performance.terminal-paint",
          ).length,
        }),
        writerHealth,
      });
      const assessment = assessProductSelectionCopyAppMouse({
        evidence: journeyEvidence,
        expected: journeyEvidence.expected,
      });
      if (!assessment.qualified) {
        const error = new Error("selection/copy/app-mouse causal assessment failed");
        error.boundary = "selection-causal-proof";
        const failureObservation = selectionCausalFailureObservation(assessment, journeyEvidence);
        publish({
          currentJourneyBoundary: "selection-causal-proof",
          currentJourneyBoundaryAtWallMs: Date.now(),
          currentJourneyBoundaryAtMonotonicMs: performance.now(),
          failureObservation,
        });
        error.observation = failureObservation;
        throw error;
      }
      publish({
        convergence: { workspaceClient: selectionBoot.web.workspaceClient },
        journeyEvidence: { selectionCopyAppMouse: journeyEvidence },
        status: "ready",
        readyAt: new Date().toISOString(),
      });
      await new Promise(() => undefined);
      return;
    }
    if (journeyId === "ansi-cursor-alt-screen") {
      const ansiJsonlReaders = new Map();
      const ansiReadJsonLines = (path, recordKind = "trace") => {
        const readerKey = `${recordKind}\0${path}`;
        let reader = ansiJsonlReaders.get(readerKey);
        if (!reader) {
          reader = createProductJsonlTailReader(path, { recordKind });
          ansiJsonlReaders.set(readerKey, reader);
        }
        return reader.read();
      };
      const ansiJsonlWatermark = async (path, recordKind = "trace") => {
        const deadline = performance.now() + 2_000;
        for (;;) {
          ansiReadJsonLines(path, recordKind);
          const reader = ansiJsonlReaders.get(`${recordKind}\0${path}`);
          if (reader.snapshot().caughtUp) return reader.mark();
          if (performance.now() >= deadline) {
            const error = new Error("ANSI JSONL watermark did not reach an exact line boundary");
            error.code = "ANSI_JSONL_WATERMARK_INVALID";
            error.observation = Object.freeze({
              operation: "ansi-jsonl-watermark",
              reason: "incomplete-or-over-budget",
              recordKind,
            });
            throw error;
          }
          await new Promise((resolve) => setImmediate(resolve));
        }
      };
      ownerAbort.signal.addEventListener(
        "abort",
        () => {
          for (const reader of ansiJsonlReaders.values()) reader.close();
          ansiJsonlReaders.clear();
        },
        { once: true },
      );
      let ansiReadiness = null;
      let ansiBaseline = null;
      let ansiPresentationCounters = null;
      let ansiCanonicalPredecessor = null;
      let ansiExpectedDeliverySurfaces = Object.freeze(["opentui"]);
      let ansiExpectedDeliveryClients = null;
      let ansiResourceOrdinal = 0;
      let ansiResourceEpochIdentity = null;
      let ansiPartialEvidence = Object.freeze({
        stage: "starting",
        baseline: null,
        rich: null,
        cursorSamples: Object.freeze([]),
        preAlternateNormal: null,
        alternate: null,
        restored: null,
        workload: null,
        workloadFinalities: Object.freeze([]),
        workloadFailure: null,
        resourceSamples: Object.freeze([]),
        idle: null,
        webPresentations: Object.freeze([]),
        webStageVector: Object.freeze([]),
        webFailure: null,
      });
      const publishAnsiPartial = (patch) => {
        ansiPartialEvidence = Object.freeze({ ...ansiPartialEvidence, ...patch });
        publish({
          journeyEvidence: {
            ...(state.journeyEvidence ?? {}),
            ansiCursorAltScreenPartial: ansiPartialEvidence,
          },
        });
      };
      const ansiHmac = (key, domain, value) =>
        createHmac("sha256", key).update(domain).update("\0").update(String(value)).digest("hex");
      const ansiResourceIdentityHmac = (key, identity) =>
        ansiHmac(
          key,
          "resource-identity",
          JSON.stringify([
            identity.semanticPaneId,
            identity.generation,
            identity.incarnation,
            identity.revision,
            identity.stateHash,
            identity.sourceEpoch,
            identity.rendererEpoch,
            identity.viewportCols,
            identity.viewportRows,
          ]),
        );
      const ansiResourceEpochIdentityHmac = (key, identity) =>
        ansiHmac(
          key,
          "resource-epoch-identity",
          JSON.stringify([
            identity?.processId,
            identity?.clockId,
            identity?.clockKind,
            identity?.semanticPaneId,
            identity?.generation,
            identity?.incarnation,
            identity?.revision,
            identity?.stateHash,
            identity?.sourceEpoch,
            identity?.rendererEpoch,
            identity?.cols,
            identity?.rows,
            identity?.viewportCols,
            identity?.viewportRows,
            identity?.acceptedUpdateType,
            identity?.acceptedRevision,
          ]),
        );
      const ansiStageProjection = (key, mode, presentation) =>
        Object.freeze({
          processHmac: ansiHmac(key, "process", mode.processId),
          clockId: mode.clockId,
          clockKind: mode.clockKind,
          paneHmac: ansiHmac(key, "pane", mode.semanticPaneId),
          generationHmac: ansiHmac(key, "generation", mode.generation),
          incarnationHmac: ansiHmac(key, "incarnation", mode.incarnation),
          revision: mode.revision,
          stateHmac: ansiHmac(key, "state", mode.stateHash),
          presentationHmac: ansiCanonicalPresentationHmac(key, mode, presentation),
          canonicalCols: presentation.cols,
          canonicalRows: presentation.rows,
          viewportCols: presentation.viewportCols,
          viewportRows: presentation.viewportRows,
          sourceEpoch: presentation.sourceEpoch,
          rendererEpoch: presentation.rendererEpoch,
          alternateScreen: mode.alternateScreen,
          cursor: Object.freeze({
            x: presentation.cursorX,
            y: presentation.cursorY,
            hidden: !presentation.visible,
            style: presentation.style,
            blink: presentation.blink,
          }),
          framebufferHmac: null,
          framebufferCellCount: null,
          framebufferWideContinuationCount: null,
          framebufferCombiningCount: null,
          framebufferStyledCellCount: null,
          gridRowsReadTotal: presentation.gridRowsReadTotal,
          fullWalkTotal: presentation.fullWalkTotal,
          presentationCount: presentation.presentationCount,
        });
      const waitAnsiStage = async (namespace, key, expected) => {
        const deadline = performance.now() + 3_000;
        let latest;
        for (;;) {
          const records = ansiReadJsonLines(namespace.tui.performanceTracePath);
          latest = ansiCursorStageFromRecords({
            records,
            daemonRecords: ansiReadJsonLines(namespace.tui.daemonPerformanceTracePath),
            watermark: expected.watermark,
            expected,
            evidenceKey: namespace.evidenceKey,
          });
          if (latest.qualified) return latest;
          if (ownerAbort.signal.aborted) throw new Error("ANSI presentation wait aborted");
          if (performance.now() >= deadline) {
            const error = new Error("ANSI presentation did not reach an exact frame fence");
            error.observation = Object.freeze({
              operation: "ansi-presentation",
              stage: key,
              firstFailedPredicate: latest?.firstFailedPredicate ?? "missing",
              recordCount: Math.min(records.length - expected.watermark, 8_192),
              daemonEvidence: latest?.daemonEvidence ?? null,
              stageEvidence: latest?.stageEvidence ?? null,
            });
            throw error;
          }
          await new Promise((resolveWait) => setTimeout(resolveWait, 5));
        }
      };
      const inspectAnsiNativeStage = async (
        namespace,
        { resources, sessionName, windowResourceId, semanticPaneId },
        stage,
        { displayCursor = false, deadlineMs = 1_500 } = {},
      ) => {
        if (
          !new Set(["baseline", "pre-alternate", "alternate", "final", "workload-timeout"]).has(
            stage,
          )
        )
          throw new TypeError("ANSI native stage was invalid");
        if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 1_500)
          throw new TypeError("ANSI native deadline was invalid");
        let snapshotOutcome = "pending";
        let captureOutcome = "not-attempted";
        let displayOutcome = displayCursor ? "not-attempted" : "not-requested";
        let leaseStatus = Object.freeze({ matchCount: null, mappingExact: false, lease: null });
        try {
          const nativeDeadline = performance.now() + deadlineMs;
          const snapshot = await exactWindowTmuxSnapshot(state, resources);
          snapshotOutcome = "accepted";
          leaseStatus = ansiNativePaneLeaseStatus(snapshot, {
            sessionName,
            windowResourceId,
            semanticPaneId,
          });
          if (!leaseStatus.mappingExact || !leaseStatus.lease) throw new Error("mapping");
          captureOutcome = "attempted";
          const capture = await runBoundedFocusTmux({
            socketPath: namespace.runtimeNamespace.tmuxSocketPath,
            args: ["capture-pane", "-p", "-e", "-t", leaseStatus.lease.paneId],
            deadline: nativeDeadline,
            signal: ownerAbort.signal,
          });
          captureOutcome = "accepted";
          let cursor = null;
          if (displayCursor) {
            displayOutcome = "attempted";
            const fields = (
              await runBoundedFocusTmux({
                socketPath: namespace.runtimeNamespace.tmuxSocketPath,
                args: [
                  "display-message",
                  "-p",
                  "-t",
                  leaseStatus.lease.paneId,
                  "#{cursor_x}\t#{cursor_y}\t#{pane_width}\t#{pane_height}",
                ],
                deadline: nativeDeadline,
                signal: ownerAbort.signal,
              })
            )
              .trimEnd()
              .split("\t")
              .map(Number);
            if (
              fields.length !== 4 ||
              !fields.every(Number.isSafeInteger) ||
              fields.some((value) => value < 0)
            )
              throw new Error("display");
            displayOutcome = "accepted";
            cursor = Object.freeze({
              x: fields[0],
              y: fields[1],
              cols: fields[2],
              rows: fields[3],
            });
          }
          return Object.freeze({
            snapshot,
            capture,
            cursor,
            matchCount: leaseStatus.matchCount,
            mappingExact: leaseStatus.mappingExact,
          });
        } catch {
          const error = new Error(`ANSI native ${stage} evidence failed`);
          error.observation = Object.freeze({
            operation: "ansi-native-tmux",
            stage,
            snapshotOutcome,
            matchCount: leaseStatus.matchCount,
            mappingExact: leaseStatus.mappingExact,
            captureOutcome,
            displayOutcome,
          });
          throw error;
        }
      };
      const ansiTmuxSemanticProjection = (snapshot) =>
        JSON.stringify(
          snapshot.map(({ sessionName, resourceId, name, active, semanticPaneId, geometry }) => ({
            sessionName,
            resourceId,
            name,
            active,
            semanticPaneId,
            geometry,
          })),
        );
      const fixedAnsiCursor = (stage, _marker) => {
        if (stage === "rich")
          return Object.freeze({ x: 6, y: 3, hidden: false, style: "line", blink: true });
        if (stage === "cursor-only")
          return Object.freeze({ x: 3, y: 2, hidden: false, style: "block", blink: false });
        if (stage === "alternate")
          return Object.freeze({ x: 11, y: 7, hidden: true, style: "underline", blink: false });
        return Object.freeze({
          x: 0,
          y: 1,
          hidden: false,
          style: "block",
          blink: false,
        });
      };
      const ansiRenditionCells = (stage, marker) => {
        const cell = (row, column, chars, width, wrapped, rendition = {}) =>
          Object.freeze({
            row,
            column,
            chars,
            width,
            wrapped,
            foreground: rendition.foreground ?? "default",
            background: rendition.background ?? "default",
            bold: rendition.bold ?? false,
            italic: rendition.italic ?? false,
            underline: rendition.underline ?? false,
          });
        const text = (value, row, start, wrapped, rendition) =>
          [...value].map((chars, index) => cell(row, start + index, chars, 1, wrapped, rendition));
        if (stage === "normal" || stage === "restored") return text(marker, 0, 0, false);
        if (stage === "alternate")
          return [
            ...text("ALT_SCREEN", 0, 0, false),
            cell(0, 10, "界", 2, false),
            cell(0, 11, "", 0, false),
            cell(0, 12, "é", 1, false),
          ];
        if (stage === "rich" || stage === "cursor-only") {
          const first = {
            foreground: "indexed:196",
            background: "rgb:010203",
            bold: true,
            italic: true,
            underline: true,
          };
          const wrapped = {
            foreground: "rgb:5ab4ff",
            background: "indexed:17",
            bold: true,
            underline: true,
          };
          return [
            ...text("ANSI_RICH", 0, 0, false, first),
            cell(0, 9, "界", 2, false, first),
            cell(0, 10, "", 0, false, first),
            cell(0, 11, "é", 1, false, first),
            cell(1, 128, "W", 1, false, wrapped),
            cell(1, 129, "界", 2, false, wrapped),
            cell(1, 130, "", 0, false, wrapped),
            cell(1, 131, "é", 1, false, wrapped),
            cell(2, 0, "Z", 1, true, wrapped),
          ];
        }
        return null;
      };
      const ansiFramebufferCells = (stage, marker) => {
        const rendition = ansiRenditionCells(stage, marker);
        if (!rendition) return null;
        const rgb = (color) =>
          color === "indexed:196" ? "rgb:ff0000" : color === "indexed:17" ? "rgb:00005f" : color;
        return Object.freeze(
          rendition.map(
            ({ row, column, chars, width, foreground, background, bold, italic, underline }) =>
              Object.freeze({
                row,
                column,
                chars,
                width,
                foreground: rgb(foreground),
                background: rgb(background),
                attributes: (bold ? 1 : 0) | (italic ? 4 : 0) | (underline ? 8 : 0),
              }),
          ),
        );
      };
      const waitAnsiPostFenceResource = async (namespace, identity, cycle) => {
        const baselineResource = cycle === 0;
        const operation = baselineResource
          ? "ansi-normal-baseline-resource-cap"
          : "ansi-workload-resource-cap";
        const boundary = baselineResource ? "ansi-normal-baseline" : "ansi-sustained-workload";
        if (ansiResourceEpochIdentity === null) ansiResourceEpochIdentity = identity;
        const deadline = performance.now() + 2_000;
        let sample;
        for (;;) {
          sample = ansiReadJsonLines(namespace.tui.performanceTracePath).findLast(
            (record) =>
              record?.type === "performance.terminal-resource-sample" &&
              record.operation === "post-fence" &&
              record.ordinal > ansiResourceOrdinal &&
              record.atMicros >= identity.atMicros &&
              record.processId === identity.processId &&
              record.clockId === identity.clockId &&
              record.clockKind === "performance-now" &&
              record.semanticPaneId === identity.semanticPaneId &&
              record.generation === identity.generation &&
              record.incarnation === identity.incarnation &&
              record.revision === identity.revision &&
              record.stateHash === identity.stateHash &&
              record.sourceEpoch === identity.sourceEpoch &&
              record.rendererEpoch === identity.rendererEpoch &&
              record.viewportCols === identity.viewportCols &&
              record.viewportRows === identity.viewportRows,
          );
          if (sample) break;
          if (performance.now() >= deadline) {
            const observedCount = ansiReadJsonLines(namespace.tui.performanceTracePath).filter(
              (record) => record?.type === "performance.terminal-resource-sample",
            ).length;
            const observation = Object.freeze({
              operation,
              cycle,
              ...boundedAnsiResourceFailureFacts({
                rssBytes: null,
                heapUsedBytes: null,
                eventLoopDelayMicros: null,
              }),
              ...boundedAnsiResourcePeakFailureFacts({
                rssPeakBytes: null,
                heapUsedPeakBytes: null,
                eventLoopDelayPeakMicros: null,
              }),
              resourceEpochArmed: null,
              resourceEpochIdentityHmac: null,
              resourceEpochIdentityExact: null,
              lowWaterFirstSampleOrdinal: null,
              lowWaterLastSampleOrdinal: null,
              lowWaterSampleCount: null,
              lowWaterWindowMicros: null,
              eventLoopDelayPeakSource: null,
              heartbeatPeakExpectedAtMicros: null,
              heartbeatPeakActualAtMicros: null,
              heartbeatPeakWallLatenessMicros: null,
              heartbeatPeakCpuUserMicros: null,
              heartbeatPeakCpuSystemMicros: null,
              heartbeatPeakVoluntaryContextSwitches: null,
              heartbeatPeakInvoluntaryContextSwitches: null,
              heartbeatPeakContextSwitchesAvailable: null,
              heartbeatPeakPhase: null,
              heartbeatPeakRevisionHmac: null,
              heartbeatPeakStateHmac: null,
              heartbeatPeakEpochBound: null,
              inputPending: null,
              inputInFlight: null,
              inputPendingBytes: null,
              inputPendingPeak: null,
              inputInFlightPeak: null,
              inputPendingBytesPeak: null,
              observedCount: Math.min(observedCount, 512),
              resourceSamplingFailureCount: null,
              firstFailedPredicate: "resource-sample-unavailable",
            });
            publishAnsiPartial({
              stage: baselineResource ? "baseline" : "workload",
              workloadFailure: observation,
            });
            const error = new Error(
              baselineResource
                ? "ANSI baseline resource endpoint was unavailable"
                : "ANSI workload resource endpoint was unavailable",
            );
            error.boundary = boundary;
            error.observation = observation;
            throw error;
          }
          await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        }
        ansiResourceOrdinal = sample.ordinal;
        const eventLoopFailure = ansiEventLoopResourceCapStatus(sample);
        const firstFailedPredicate =
          sample.resourceEpochArmed !== true ||
          !ansiResourceEpochIdentityExact(sample.resourceEpochIdentity, ansiResourceEpochIdentity)
            ? "resource-epoch-identity"
            : sample.lowWaterFirstSampleOrdinal !== 1 ||
                sample.lowWaterLastSampleOrdinal !== 8 ||
                sample.lowWaterSampleCount !== 8 ||
                !Number.isSafeInteger(sample.lowWaterWindowMicros) ||
                sample.lowWaterWindowMicros < 40_000 ||
                sample.lowWaterWindowMicros > 2_000_000
              ? "resource-low-water-window"
              : !Number.isSafeInteger(sample.resourceSamplingFailureCount) ||
                  sample.resourceSamplingFailureCount !== 0
                ? "resource-sampling-failure"
                : !Number.isSafeInteger(sample.rssBytes) ||
                    sample.rssBytes < 0 ||
                    sample.rssBytes > ANSI_TUI_RSS_ABSOLUTE_CEILING_BYTES
                  ? "rss-current-cap"
                  : !Number.isSafeInteger(sample.rssPeakBytes) ||
                      sample.rssPeakBytes < 0 ||
                      sample.rssPeakBytes > ANSI_TUI_RSS_ABSOLUTE_CEILING_BYTES
                    ? "rss-absolute-cap"
                    : !Number.isSafeInteger(sample.heapUsedBytes) ||
                        sample.heapUsedBytes < 0 ||
                        sample.heapUsedBytes > ANSI_TUI_HEAP_ABSOLUTE_CEILING_BYTES
                      ? "heap-current-cap"
                      : !Number.isSafeInteger(sample.heapUsedPeakBytes) ||
                          sample.heapUsedPeakBytes < 0 ||
                          sample.heapUsedPeakBytes > ANSI_TUI_HEAP_ABSOLUTE_CEILING_BYTES
                        ? "heap-absolute-cap"
                        : eventLoopFailure !== null
                          ? eventLoopFailure
                          : !new Set(["heartbeat", "endpoint"]).has(sample.eventLoopDelayPeakSource)
                            ? "event-loop-peak-source"
                            : sample.eventLoopDelayPeakSource === "heartbeat" &&
                                (!Number.isSafeInteger(sample.heartbeatPeakExpectedAtMicros) ||
                                  !Number.isSafeInteger(sample.heartbeatPeakActualAtMicros) ||
                                  sample.heartbeatPeakActualAtMicros <
                                    sample.heartbeatPeakExpectedAtMicros ||
                                  Math.abs(
                                    sample.heartbeatPeakActualAtMicros -
                                      sample.heartbeatPeakExpectedAtMicros -
                                      sample.eventLoopDelayPeakMicros,
                                  ) > 1 ||
                                  !Number.isSafeInteger(sample.heartbeatPeakWallLatenessMicros) ||
                                  sample.heartbeatPeakWallLatenessMicros < 0 ||
                                  !Number.isSafeInteger(sample.heartbeatPeakCpuUserMicros) ||
                                  sample.heartbeatPeakCpuUserMicros < 0 ||
                                  !Number.isSafeInteger(sample.heartbeatPeakCpuSystemMicros) ||
                                  sample.heartbeatPeakCpuSystemMicros < 0 ||
                                  (sample.heartbeatPeakContextSwitchesAvailable === true
                                    ? !Number.isSafeInteger(
                                        sample.heartbeatPeakVoluntaryContextSwitches,
                                      ) ||
                                      sample.heartbeatPeakVoluntaryContextSwitches < 0 ||
                                      !Number.isSafeInteger(
                                        sample.heartbeatPeakInvoluntaryContextSwitches,
                                      ) ||
                                      sample.heartbeatPeakInvoluntaryContextSwitches < 0
                                    : sample.heartbeatPeakContextSwitchesAvailable !== false ||
                                      sample.heartbeatPeakVoluntaryContextSwitches !== null ||
                                      sample.heartbeatPeakInvoluntaryContextSwitches !== null) ||
                                  sample.heartbeatPeakPhase !== "terminal-runtime" ||
                                  !Number.isSafeInteger(sample.heartbeatPeakRevision) ||
                                  sample.heartbeatPeakRevision <
                                    sample.resourceEpochIdentity.revision ||
                                  sample.heartbeatPeakRevision > sample.revision ||
                                  !/^[0-9a-f]{16}$/u.test(sample.heartbeatPeakStateHash ?? ""))
                              ? "heartbeat-peak-episode"
                              : sample.inputPending !== 0 ||
                                  sample.inputInFlight !== 0 ||
                                  sample.inputPendingBytes !== 0 ||
                                  sample.inputPendingPeak !== 0 ||
                                  sample.inputInFlightPeak !== 0 ||
                                  sample.inputPendingBytesPeak !== 0
                                ? "input-not-settled"
                                : null;
        if (firstFailedPredicate) {
          const observation = Object.freeze({
            operation,
            cycle,
            ...boundedAnsiResourceFailureFacts({
              rssBytes: sample.rssBytes,
              heapUsedBytes: sample.heapUsedBytes,
              eventLoopDelayMicros: sample.eventLoopDelayMicros,
            }),
            ...boundedAnsiResourcePeakFailureFacts({
              rssPeakBytes: sample.rssPeakBytes,
              heapUsedPeakBytes: sample.heapUsedPeakBytes,
              eventLoopDelayPeakMicros: sample.eventLoopDelayPeakMicros,
            }),
            resourceEpochArmed: sample.resourceEpochArmed === true,
            resourceEpochIdentityHmac:
              sample.resourceEpochArmed === true && sample.resourceEpochIdentity
                ? ansiResourceEpochIdentityHmac(namespace.evidenceKey, sample.resourceEpochIdentity)
                : null,
            resourceEpochIdentityExact: ansiResourceEpochIdentityExact(
              sample.resourceEpochIdentity,
              ansiResourceEpochIdentity,
            ),
            lowWaterFirstSampleOrdinal: Number.isSafeInteger(sample.lowWaterFirstSampleOrdinal)
              ? Math.min(Math.max(sample.lowWaterFirstSampleOrdinal, 0), 16)
              : null,
            lowWaterLastSampleOrdinal: Number.isSafeInteger(sample.lowWaterLastSampleOrdinal)
              ? Math.min(Math.max(sample.lowWaterLastSampleOrdinal, 0), 16)
              : null,
            lowWaterSampleCount: Number.isSafeInteger(sample.lowWaterSampleCount)
              ? Math.min(Math.max(sample.lowWaterSampleCount, 0), 16)
              : null,
            lowWaterWindowMicros: Number.isSafeInteger(sample.lowWaterWindowMicros)
              ? Math.min(Math.max(sample.lowWaterWindowMicros, 0), 2_000_000)
              : null,
            eventLoopDelayPeakSource: new Set(["heartbeat", "endpoint"]).has(
              sample.eventLoopDelayPeakSource,
            )
              ? sample.eventLoopDelayPeakSource
              : null,
            heartbeatPeakExpectedAtMicros: Number.isSafeInteger(
              sample.heartbeatPeakExpectedAtMicros,
            )
              ? Math.min(Math.max(sample.heartbeatPeakExpectedAtMicros, 0), 9_007_199_254_740_991)
              : null,
            heartbeatPeakActualAtMicros: Number.isSafeInteger(sample.heartbeatPeakActualAtMicros)
              ? Math.min(Math.max(sample.heartbeatPeakActualAtMicros, 0), 9_007_199_254_740_991)
              : null,
            heartbeatPeakWallLatenessMicros: Number.isSafeInteger(
              sample.heartbeatPeakWallLatenessMicros,
            )
              ? Math.min(Math.max(sample.heartbeatPeakWallLatenessMicros, 0), 5_000_000)
              : null,
            heartbeatPeakCpuUserMicros: Number.isSafeInteger(sample.heartbeatPeakCpuUserMicros)
              ? Math.min(Math.max(sample.heartbeatPeakCpuUserMicros, 0), 5_000_000)
              : null,
            heartbeatPeakCpuSystemMicros: Number.isSafeInteger(sample.heartbeatPeakCpuSystemMicros)
              ? Math.min(Math.max(sample.heartbeatPeakCpuSystemMicros, 0), 5_000_000)
              : null,
            heartbeatPeakVoluntaryContextSwitches: Number.isSafeInteger(
              sample.heartbeatPeakVoluntaryContextSwitches,
            )
              ? Math.min(Math.max(sample.heartbeatPeakVoluntaryContextSwitches, 0), 65_536)
              : null,
            heartbeatPeakInvoluntaryContextSwitches: Number.isSafeInteger(
              sample.heartbeatPeakInvoluntaryContextSwitches,
            )
              ? Math.min(Math.max(sample.heartbeatPeakInvoluntaryContextSwitches, 0), 65_536)
              : null,
            heartbeatPeakContextSwitchesAvailable:
              sample.heartbeatPeakContextSwitchesAvailable === true,
            heartbeatPeakPhase:
              sample.heartbeatPeakPhase === "terminal-runtime" ? "terminal-runtime" : null,
            heartbeatPeakRevisionHmac: Number.isSafeInteger(sample.heartbeatPeakRevision)
              ? ansiHmac(
                  namespace.evidenceKey,
                  "heartbeat-peak-revision",
                  sample.heartbeatPeakRevision,
                )
              : null,
            heartbeatPeakStateHmac:
              typeof sample.heartbeatPeakStateHash === "string"
                ? ansiHmac(
                    namespace.evidenceKey,
                    "heartbeat-peak-state",
                    sample.heartbeatPeakStateHash,
                  )
                : null,
            heartbeatPeakEpochBound:
              Number.isSafeInteger(sample.heartbeatPeakRevision) &&
              sample.heartbeatPeakRevision >= sample.resourceEpochIdentity.revision &&
              sample.heartbeatPeakRevision <= sample.revision,
            inputPending: Number.isSafeInteger(sample.inputPending) ? sample.inputPending : null,
            inputInFlight: Number.isSafeInteger(sample.inputInFlight) ? sample.inputInFlight : null,
            inputPendingBytes: Number.isSafeInteger(sample.inputPendingBytes)
              ? sample.inputPendingBytes
              : null,
            inputPendingPeak: Number.isSafeInteger(sample.inputPendingPeak)
              ? sample.inputPendingPeak
              : null,
            inputInFlightPeak: Number.isSafeInteger(sample.inputInFlightPeak)
              ? sample.inputInFlightPeak
              : null,
            inputPendingBytesPeak: Number.isSafeInteger(sample.inputPendingBytesPeak)
              ? sample.inputPendingBytesPeak
              : null,
            observedCount: Math.min(ansiResourceOrdinal, 512),
            resourceSamplingFailureCount: Number.isSafeInteger(sample.resourceSamplingFailureCount)
              ? Math.min(Math.max(sample.resourceSamplingFailureCount, 0), 512)
              : null,
            firstFailedPredicate,
          });
          publishAnsiPartial({
            stage: baselineResource ? "baseline" : "workload",
            workloadFailure: observation,
          });
          const error = new Error(
            baselineResource
              ? "ANSI baseline exceeded its resource cap"
              : "ANSI workload exceeded its resource cap",
          );
          error.boundary = boundary;
          error.observation = observation;
          throw error;
        }
        return sample;
      };
      const driveAnsiStage = async (namespace, key, options) => {
        const predecessor = ansiCanonicalPredecessor;
        if (
          !predecessor ||
          options.afterRevision !== predecessor.revision ||
          typeof predecessor.stateHash !== "string"
        )
          throw new Error("ANSI stage did not own the immediate canonical predecessor");
        const readinessGate = await runAnsiDeliveryReadyAction({
          readRecords: () => ansiReadJsonLines(namespace.tui.daemonPerformanceTracePath),
          now: () => performance.now(),
          sleep: (milliseconds) =>
            new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
          expected: {
            ...ansiBaseline.rawIdentity,
            deliveryWorkspaceName: ansiBaseline.deliveryWorkspaceName,
            deliveryClients: ansiExpectedDeliveryClients,
            predecessorRevision: predecessor.revision,
            predecessorStateHash: predecessor.stateHash,
          },
          takeWatermark: async () =>
            (await ansiJsonlWatermark(namespace.tui.performanceTracePath)).recordCount,
          driveInput: () =>
            driveExactHostedInput(
              state,
              { version: 1, kind: "key", key, timeoutMs: 2_000 },
              ownerAbort.signal,
            ),
        });
        if (!readinessGate.qualified) {
          const status = readinessGate.topology;
          const readiness = readinessGate.readiness;
          const error = new Error("ANSI delivery subscriber lanes did not catch up");
          error.code = "ANSI_DELIVERY_LANE_NOT_CAUGHT_UP";
          error.observation = Object.freeze({
            operation: "ansi-delivery-readiness",
            code: "delivery-lane-not-caught-up",
            topologyExact: status?.exact === true,
            reason: status?.exact === true ? readiness?.reason : status?.reason,
            laneCount: Math.min(status?.lanes?.length ?? 0, 17),
            readyLaneCount: readiness?.readyLaneCount ?? 0,
            firstInvalidLaneOrdinal: readiness?.firstInvalidLaneOrdinal ?? null,
            predecessorRevisionHmac: ansiHmac(
              namespace.evidenceKey,
              "delivery-readiness-revision",
              String(predecessor.revision),
            ),
            predecessorStateHmac: ansiHmac(
              namespace.evidenceKey,
              "delivery-readiness-state",
              predecessor.stateHash,
            ),
          });
          publishAnsiPartial({ stage: "web-readiness", webFailure: error.observation });
          throw error;
        }
        const deliveryTopology = readinessGate.topology;
        const watermark = readinessGate.watermark;
        const delivery = readinessGate.delivery;
        if (delivery.bytesInjected !== 1 || delivery.phases !== 1)
          throw new Error("ANSI fixture input delivery was not one exact byte");
        const framebuffer = options.gridWalked
          ? ansiFramebufferCells(options.stage, namespace.marker)
          : null;
        const result = await waitAnsiStage(namespace, key, {
          ...ansiBaseline.rawIdentity,
          watermark,
          afterRevision: predecessor.revision,
          priorStateHash: predecessor.stateHash,
          alternateScreen: options.alternateScreen,
          action: options.action,
          gridWalked: options.gridWalked,
          gridRowsRead: options.gridRowsRead,
          fullWalk: options.fullWalk,
          previousCounters: ansiPresentationCounters,
          deliveryWorkspaceName: ansiBaseline.deliveryWorkspaceName,
          deliverySurfaces: ansiExpectedDeliverySurfaces,
          deliveryClients: ansiExpectedDeliveryClients,
          deliveryTopology,
          framebufferHmac: framebuffer
            ? ansiHmac(namespace.evidenceKey, "opentui-framebuffer", JSON.stringify(framebuffer))
            : null,
          framebufferCellCount: framebuffer?.length ?? null,
          framebufferWideContinuationCount:
            framebuffer?.filter(({ width }) => width === 0).length ?? null,
          framebufferCombiningCount:
            framebuffer?.filter(({ chars }) => /\p{Mark}/u.test(chars)).length ?? null,
          framebufferStyledCellCount:
            framebuffer?.filter(
              ({ foreground, background, attributes }) =>
                foreground !== "default" || background !== "default" || attributes !== 0,
            ).length ?? null,
        });
        ansiPresentationCounters = result.counters;
        ansiCanonicalPredecessor = advanceAnsiCanonicalPredecessor(predecessor, result);
        if (!ansiCanonicalPredecessor)
          throw new Error("ANSI stage did not advance its exact canonical predecessor");
        return result;
      };
      const ansiBoot = await runAnsiCursorAltScreenOwnerBoot({
        onBoundary: (boundary) =>
          publish({
            currentJourneyBoundary: boundary,
            currentJourneyBoundaryAtWallMs: Date.now(),
            currentJourneyBoundaryAtMonotonicMs: performance.now(),
          }),
        createNamespace: async () => {
          const marker = `ANSI_${randomBytes(6).toString("hex").toUpperCase()}`;
          const daemonPerformanceTracePath = join(rigRoot, "ansi-daemon-performance.jsonl");
          const fixtureCompletionPath = join(rigRoot, "ansi-fixture-completion.jsonl");
          const initialPaneCommand = Object.freeze({
            executable: process.execPath,
            args: Object.freeze([
              join(repoRoot, "scripts", "lib", "product-ansi-cursor-alt-screen-fixture.mjs"),
              marker,
              fixtureCompletionPath,
            ]),
          });
          try {
            validateScratchInitialPaneCommand(initialPaneCommand);
          } catch (error) {
            if (error?.code === SCRATCH_INITIAL_PANE_COMMAND_INVALID) {
              const observation = Object.freeze({
                operation: "product-rig-namespace-preflight",
                stage: "ansi-initial-pane-command",
                outcome: "command-rejected",
                resourcesCreated: false,
                pathsClaimed: 0,
                daemonStarted: false,
              });
              publish({
                diagnosticAttempt: Object.freeze({
                  ...state.diagnosticAttempt,
                  resourcesCreated: false,
                  preflight: observation,
                }),
              });
              error.observation = observation;
            }
            throw error;
          }
          const scratchFleet = await createScratchFleet({
            sessions: 1,
            slug,
            windowsPerSession: 1,
            initialPaneCommand,
          });
          fleet = scratchFleet;
          if (state.diagnosticAttempt)
            publish({
              diagnosticAttempt: Object.freeze({
                ...state.diagnosticAttempt,
                resourcesCreated: true,
              }),
            });
          const session = scratchFleet.sessionNames[0];
          const initialPane = scratchFleet.initialPanes[0];
          if (!initialPane) throw new Error("ANSI namespace lost its initial pane");
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
          // Publish the complete ownership/provenance lease before fixture
          // conditioning. A pre-daemon conditioning failure must still be able
          // to produce a non-vacuous exact cleanup receipt and sealed bundle.
          const tui = prepareOwnedTuiRuntime({
            ownership: { session, runtimeNamespace },
            intendedTui: {
              hostSession: `_tmux-ide-product-rig-${slug}`,
              runtimeDir: join(rigRoot, "tui-ansi-cursor-alt-screen"),
              performanceTracePath: join(
                rigRoot,
                "tui-ansi-cursor-alt-screen",
                "performance-trace.jsonl",
              ),
              performanceTraceDetail: "1",
              daemonPerformanceTracePath,
            },
            publish,
            resolveProvenance: sourceTraceProvenance,
            createRuntimeDir: createIsolatedTargetedTuiCwd,
          });
          const conditioned = await conditionAnsiTmuxFixture({
            paneId: initialPane.paneId,
            marker,
            executable: process.execPath,
            run: (args, deadline) =>
              runBoundedFocusTmux({ socketPath: scratchFleet.socketPath, args, deadline }),
          });
          const evidenceKey = randomBytes(32);
          productInputFingerprintKeys.set(tui.runtimeDir, evidenceKey.toString("hex"));
          event("ansi-namespace-ready", { windows: 1, panes: 1 });
          return Object.freeze({
            session,
            marker,
            seed: {
              marker,
              paneId: initialPane.paneId,
              geometry: Object.freeze({
                ...initialPane,
                left: conditioned.paneLeft,
                top: conditioned.paneTop,
                width: conditioned.paneCols,
                height: conditioned.paneRows,
              }),
            },
            runtimeNamespace,
            tui,
            evidenceKey,
            fixtureCompletionPath,
          });
        },
        startDaemon: async () => {
          daemon = await startOwnedProductRigDaemon({
            start: () => startDaemon(fleet),
            publish,
            waitUntilReady: waitForReadinessLadder,
          });
          return daemon;
        },
        openWorkspace: async (namespace, runningDaemon) => {
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
          event("ansi-daemon-ready", {});
          return identity;
        },
        build: async () => {
          await execFileAsync("bun", [join(repoRoot, "scripts", "build-tui.mjs")], {
            cwd: repoRoot,
            timeout: 120_000,
          });
          prepareIsolatedTargetedTuiCwd(state.tui.runtimeDir);
          event("ansi-tui-build", {});
        },
        launch: async (namespace) => {
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
            throw new Error("ANSI TUI launch receipt was invalid");
          const controller = new AbortController();
          const abort = () => controller.abort();
          ownerAbort.signal.addEventListener("abort", abort, { once: true });
          ansiReadiness = {
            launched,
            controller,
            startedAt: performance.now(),
            deadlineMs: 50_000,
            timer: setTimeout(() => controller.abort(), 50_000),
            detach: () => ownerAbort.signal.removeEventListener("abort", abort),
          };
          event("ansi-tui-started", { processId: launched.processId });
          return launched;
        },
        waitHost: async (_namespace, _daemon, _identity, launched) => {
          if (!ansiReadiness || ansiReadiness.launched !== launched)
            throw new Error("ANSI readiness owner was unavailable");
          return waitForExactFocusHostReceipt(state, launched, {
            deadlineMs: 10_000,
            signal: ansiReadiness.controller.signal,
          });
        },
        waitCoherent: async (_namespace, _daemon, _identity, launched, host) => {
          const readiness = ansiReadiness;
          if (!readiness || readiness.launched !== launched)
            throw new Error("ANSI readiness owner was unavailable");
          try {
            await waitForCoherentTui(
              state,
              30_000,
              launched.processId,
              host,
              readiness.controller.signal,
            );
          } finally {
            clearTimeout(readiness.timer);
            readiness.detach();
            readiness.controller.abort();
            ansiReadiness = null;
          }
          event("ansi-tui-coherent", { processId: launched.processId });
          return Object.freeze({
            processId: launched.processId,
            launchId: launched.launchId,
            hostIdentity: launched.hostIdentity,
          });
        },
        proveNormalBaseline: async (namespace, runningDaemon, identity, process, host) => {
          const shell = await waitForProductApplicationShell(
            runningDaemon,
            namespace.session,
            (candidate) => productWindowResources(candidate).length === 1,
            10_000,
            1,
          );
          const resources = productWindowResources(shell);
          const publication = await provePreseededPanePublication(state, namespace.seed, resources);
          const selected = resources[0];
          if (!selected?.active || selected.semanticPaneId !== publication.semanticPaneId)
            throw new Error("ANSI baseline did not join the active pane");
          const processId = `opentui:${process.processId}`;
          const workspaceClient = await waitForQualifiedWorkspaceClientState(
            () =>
              ansiReadJsonLines(join(namespace.tui.runtimeDir, "performance.jsonl"), "lifecycle"),
            {
              processId,
              daemonGeneration: runningDaemon.record.instanceId,
              workspaceName: identity.workspaceName,
              sessionName: identity.sessionName,
              fleetSessionId: identity.fleetSessionId,
              semanticPaneId: selected.semanticPaneId,
              canonicalGeneration: publication.canonicalSeedPaint.publication.generation,
            },
          );
          const terminalResourceRevision = workspaceClient.committed.terminalResourceRevision;
          if (!Number.isSafeInteger(terminalResourceRevision) || terminalResourceRevision < 0)
            throw new Error("ANSI baseline terminal resource revision was unavailable");
          const seed = publication.canonicalSeedPaint.publication;
          const hostFrame = publication.frameCausality.hostFrame;
          const expectedCursor = fixedAnsiCursor("normal", namespace.marker);
          const semanticBody = ansiSemanticBodyProjection(publication.bodyRect);
          if (!semanticBody) {
            const error = new Error("ANSI baseline semantic body projection was invalid");
            error.observation = Object.freeze({
              operation: "ansi-normal-baseline",
              stage: "semantic-body",
              semanticBodyExact: false,
            });
            throw error;
          }
          const baselineExpected = Object.freeze({
            processId,
            clockId: hostFrame.clockId,
            semanticPaneId: selected.semanticPaneId,
            generation: seed.generation,
            incarnation: seed.incarnation,
            revision: seed.revision,
            stateHash: seed.stateHash,
            canonicalCols: seed.cols,
            canonicalRows: seed.rows,
            ...semanticBody,
            sourceEpoch: seed.sourceEpoch,
            rendererEpoch: hostFrame.rendererEpoch,
            cursor: expectedCursor,
            alternateScreen: false,
            wraparound: true,
            mouseProtocol: "none",
            mouseEncoding: "default",
            activePaneExact:
              selected.active === true && selected.semanticPaneId === seed.semanticPaneId,
            seedRevisionExact:
              Number.isSafeInteger(seed.revision) &&
              seed.revision >= 0 &&
              hostFrame.revision === seed.revision &&
              hostFrame.acceptedRevision === seed.revision,
            seedGeometryExact:
              Number.isSafeInteger(seed.cols) &&
              seed.cols > 0 &&
              Number.isSafeInteger(seed.rows) &&
              seed.rows > 0 &&
              hostFrame.cols === seed.cols &&
              hostFrame.rows === seed.rows,
            seedIdentityExact:
              seed.processId === processId &&
              seed.clockId === hostFrame.clockId &&
              seed.clockKind === "performance-now" &&
              hostFrame.processId === processId &&
              hostFrame.clockKind === "performance-now" &&
              hostFrame.semanticPaneId === seed.semanticPaneId &&
              hostFrame.generation === seed.generation &&
              hostFrame.incarnation === seed.incarnation &&
              hostFrame.stateHash === seed.stateHash &&
              hostFrame.sourceEpoch === seed.sourceEpoch &&
              hostFrame.acceptedUpdateType === "terminal.seed" &&
              Number.isSafeInteger(seed.sourceEpoch) &&
              seed.sourceEpoch >= 0 &&
              typeof seed.generation === "string" &&
              seed.generation.length > 0 &&
              typeof seed.incarnation === "string" &&
              seed.incarnation.length > 0 &&
              /^[0-9a-f]{16}$/u.test(seed.stateHash),
          });
          const deadline = performance.now() + 3_000;
          let mode;
          let presentation;
          const baselineFailure = (status) => {
            const error = new Error(
              `ANSI baseline cursor evidence failed: ${status.firstFailedPredicate}`,
            );
            error.observation = Object.freeze({
              operation: "ansi-normal-baseline",
              stage: "cursor-evidence",
              ...status,
            });
            return error;
          };
          for (;;) {
            const records = ansiReadJsonLines(namespace.tui.performanceTracePath);
            const modes = records.filter(
              (record) =>
                record?.type === "performance.terminal-canonical-mode" &&
                record.semanticPaneId === selected.semanticPaneId &&
                record.revision === seed.revision,
            );
            const presentations = records.filter(
              (record) =>
                record?.type === "performance.terminal-cursor-presentation" &&
                record.semanticPaneId === selected.semanticPaneId &&
                record.revision === seed.revision,
            );
            const currentPresentationIndex = records.indexOf(presentations[0]);
            const baselinePredecessor = ansiBaselinePreviousCounters(
              records,
              currentPresentationIndex >= 0 ? currentPresentationIndex : records.length,
              baselineExpected,
            );
            const status = ansiBaselineCursorEvidenceStatus(
              { modes: modes.slice(0, 2), presentations: presentations.slice(0, 2) },
              {
                ...baselineExpected,
                baselinePredecessor,
              },
            );
            if (status.qualified) {
              mode = modes[0];
              presentation = presentations[0];
              break;
            }
            if (modes.length > 1 || presentations.length > 1 || presentations.length === 1)
              throw baselineFailure(status);
            if (performance.now() >= deadline) throw baselineFailure(status);
            await new Promise((resolveWait) => setTimeout(resolveWait, 5));
          }
          const baselineResourceSample = await waitAnsiPostFenceResource(namespace, hostFrame, 0);
          const baselineNative = await inspectAnsiNativeStage(
            namespace,
            {
              resources,
              sessionName: identity.sessionName,
              windowResourceId: selected.windowResourceId,
              semanticPaneId: selected.semanticPaneId,
            },
            "baseline",
          );
          const baseline = Object.freeze({
            stage: ansiStageProjection(namespace.evidenceKey, mode, presentation),
            rawIdentity: Object.freeze({
              processId,
              clockId: "opentui-performance-now",
              daemonProcessId: `daemon:${runningDaemon.record.pid}`,
              daemonClockId: "node-performance-now",
              deliveryWorkspaceName: identity.sessionName,
              deliverySurfaces: Object.freeze(["opentui"]),
              daemonGeneration: runningDaemon.record.instanceId,
              semanticPaneId: selected.semanticPaneId,
              canonicalGeneration: seed.generation,
              canonicalIncarnation: seed.incarnation,
              sourceEpoch: seed.sourceEpoch,
              rendererEpoch: presentation.rendererEpoch,
              canonicalCols: seed.cols,
              canonicalRows: seed.rows,
              ...semanticBody,
            }),
            processId,
            daemonGeneration: runningDaemon.record.instanceId,
            clientGeneration: workspaceClient.committed.generation,
            clientId: processId,
            workspaceName: identity.workspaceName,
            deliveryWorkspaceName: identity.sessionName,
            sessionName: identity.sessionName,
            semanticPaneId: selected.semanticPaneId,
            windowResourceId: selected.windowResourceId,
            terminalResourceRevision,
            resources,
            workspaceClient,
            tmux: baselineNative.snapshot,
            tmuxCaptureHmac: ansiHmac(
              namespace.evidenceKey,
              "tmux-capture",
              baselineNative.capture,
            ),
            host,
            hostFrame,
            baselineResourceSample,
          });
          ansiBaseline = baseline;
          ansiExpectedDeliveryClients = Object.freeze({ opentui: processId });
          ansiCanonicalPredecessor = Object.freeze({
            revision: seed.revision,
            stateHash: seed.stateHash,
          });
          ansiPresentationCounters = Object.freeze({
            gridRowsReadTotal: presentation.gridRowsReadTotal,
            fullWalkTotal: presentation.fullWalkTotal,
            presentationCount: presentation.presentationCount,
          });
          const fixedBaselineCursor = fixedAnsiCursor("normal", namespace.marker);
          if (
            baseline.stage.alternateScreen !== false ||
            Object.entries(fixedBaselineCursor).some(
              ([field, value]) => baseline.stage.cursor[field] !== value,
            )
          )
            throw new Error("ANSI baseline cursor did not match the fixed normal contract");
          event("ansi-normal-baseline", { revision: seed.revision });
          publishAnsiPartial({ stage: "normal", baseline: baseline.stage });
          return baseline;
        },
        driveRichAnsi: async (namespace, _daemon, _identity, _process, baseline) => {
          const result = await driveAnsiStage(namespace, "r", {
            stage: "rich",
            action: "rich-ansi",
            afterRevision: baseline.stage.revision,
            alternateScreen: false,
            gridWalked: true,
            gridRowsRead: 3,
            fullWalk: false,
          });
          if (
            Object.entries(fixedAnsiCursor("rich", namespace.marker)).some(
              ([field, value]) => result.stage.cursor[field] !== value,
            )
          )
            throw new Error("ANSI rich cursor did not match the fixed contract");
          event("ansi-rich-presentation", { revision: result.stage.revision });
          publishAnsiPartial({ stage: "rich", rich: result.stage });
          return result;
        },
        driveCursorDistribution: async (
          namespace,
          _daemon,
          _identity,
          _process,
          baseline,
          rich,
        ) => {
          const samples = [];
          const expectedSamples = [];
          let revision = rich.stage.revision;
          let latest = rich;
          for (let ordinal = 1; ordinal <= 30; ordinal += 1) {
            latest = await driveAnsiStage(namespace, "c", {
              stage: "cursor-only",
              action: "cursor-next",
              afterRevision: revision,
              alternateScreen: false,
              gridWalked: false,
              gridRowsRead: 0,
              fullWalk: false,
            });
            revision = latest.stage.revision;
            const sample = Object.freeze({ ...latest.sample, ordinal });
            const cursorValue = ordinal % 30;
            const shape = 1 + (cursorValue % 6);
            const fixed = {
              x: 2 + (cursorValue % 20),
              y: 1 + (cursorValue % 8),
              hidden: false,
              style: shape <= 2 ? "block" : shape <= 4 ? "underline" : "line",
              blink: shape % 2 === 1,
            };
            if (
              Object.entries(fixed).some(([field, value]) => latest.stage.cursor[field] !== value)
            )
              throw new Error("ANSI cursor-only stage did not match its fixed ordinal contract");
            samples.push(sample);
            expectedSamples.push(
              Object.freeze({
                ordinal,
                action: "cursor-next",
                traceHmac: sample.traceHmac,
                gestureHmac: sample.gestureHmac,
                daemonProcessHmac: ansiHmac(
                  namespace.evidenceKey,
                  "daemon-process",
                  baseline.rawIdentity.daemonProcessId,
                ),
                daemonClockId: baseline.rawIdentity.daemonClockId,
                presentation: sample.presentation,
                cursor: Object.freeze({
                  x: fixed.x,
                  y: fixed.y,
                  hidden: fixed.hidden,
                  canonicalStyle: shape <= 2 ? "block" : shape <= 4 ? "underline" : "bar",
                  rendererStyle: fixed.style,
                  blink: fixed.blink,
                }),
              }),
            );
          }
          event("ansi-cursor-only-distribution", { sampleCount: samples.length });
          publishAnsiPartial({
            stage: "cursor-distribution",
            cursorSamples: Object.freeze(samples),
          });
          return Object.freeze({
            samples: Object.freeze(samples),
            expectedSamples: Object.freeze(expectedSamples),
            latest,
          });
        },
        enterAlternateScreen: async (namespace, _daemon, _identity, _process, baseline, cursor) => {
          const preAlternateCountersBefore = ansiPresentationCounters;
          const preAlternate = await driveAnsiStage(namespace, "b", {
            stage: "normal",
            action: "pre-alternate-normal",
            afterRevision: cursor.latest.stage.revision,
            alternateScreen: false,
            gridWalked: true,
            gridRowsRead: 3,
            fullWalk: false,
          });
          const normalCursor = fixedAnsiCursor("normal", namespace.marker);
          const preAlternateSemanticExact =
            preAlternate.stage.presentationHmac === baseline.stage.presentationHmac &&
            /^[0-9a-f]{64}$/u.test(preAlternate.stage.framebufferHmac ?? "") &&
            preAlternate.stage.alternateScreen === false &&
            Object.entries(normalCursor).every(
              ([field, value]) => preAlternate.stage.cursor[field] === value,
            );
          const preAlternateNative = await inspectAnsiNativeStage(
            namespace,
            {
              resources: baseline.resources,
              sessionName: baseline.sessionName,
              windowResourceId: baseline.windowResourceId,
              semanticPaneId: baseline.semanticPaneId,
            },
            "pre-alternate",
          );
          const expectedNormalFramebuffer = ansiFramebufferCells("normal", namespace.marker);
          const preAlternateStatus = ansiPreAlternateNormalStatus(
            {
              stage: preAlternate.stage,
              nativeGeometryExact:
                ansiTmuxSemanticProjection(preAlternateNative.snapshot) ===
                ansiTmuxSemanticProjection(baseline.tmux),
              nativeCaptureHmac: ansiHmac(
                namespace.evidenceKey,
                "tmux-capture",
                preAlternateNative.capture,
              ),
            },
            {
              presentationHmac: baseline.stage.presentationHmac,
              framebufferHmac: ansiHmac(
                namespace.evidenceKey,
                "opentui-framebuffer",
                JSON.stringify(expectedNormalFramebuffer),
              ),
              cursor: normalCursor,
              nativeCaptureHmac: baseline.tmuxCaptureHmac,
            },
          );
          publishAnsiPartial({
            stage: "pre-alternate-normal",
            preAlternateNormal: Object.freeze({
              ...preAlternateStatus,
              modeCandidateCount: preAlternate.stageEvidence.modeCandidateCount,
              presentationCandidateCount: preAlternate.stageEvidence.presentationCandidateCount,
              frameCandidateCount: preAlternate.stageEvidence.frameCandidateCount,
              fenceCandidateCount: preAlternate.stageEvidence.fenceCandidateCount,
            }),
          });
          if (!preAlternateSemanticExact || !preAlternateStatus.qualified)
            throw new Error("ANSI pre-alternate normal state did not match the baseline");
          const preAlternateEvidence = Object.freeze({
            stage: preAlternate.stage,
            sample: preAlternate.sample,
            cardinality: Object.freeze({
              mode: preAlternate.stageEvidence.modeCandidateCount,
              presentation: preAlternate.stageEvidence.presentationCandidateCount,
              frame: preAlternate.stageEvidence.frameCandidateCount,
              fence: preAlternate.stageEvidence.fenceCandidateCount,
              traced: preAlternate.stageEvidence.tracedCandidateExact,
            }),
            predecessor: Object.freeze({
              revision: cursor.latest.stage.revision,
              stateHmac: cursor.latest.stage.stateHmac,
            }),
            counters: Object.freeze({
              beforeGridRowsReadTotal: preAlternateCountersBefore.gridRowsReadTotal,
              afterGridRowsReadTotal: preAlternate.counters.gridRowsReadTotal,
              beforeFullWalkTotal: preAlternateCountersBefore.fullWalkTotal,
              afterFullWalkTotal: preAlternate.counters.fullWalkTotal,
              beforePresentationCount: preAlternateCountersBefore.presentationCount,
              afterPresentationCount: preAlternate.counters.presentationCount,
              gridRowsReadDelta: preAlternate.sample.causal.gridRowsReadDelta,
              fullWalkDelta: preAlternate.sample.causal.fullWalkDelta,
              presentationCountDelta: preAlternate.sample.causal.presentationCountDelta,
            }),
            native: Object.freeze({
              paneCount: Math.min(preAlternateNative.snapshot.length, 2),
              matchCount: preAlternateNative.matchCount,
              mappingExact: preAlternateNative.mappingExact,
              geometryExact:
                ansiTmuxSemanticProjection(preAlternateNative.snapshot) ===
                ansiTmuxSemanticProjection(baseline.tmux),
              captureHmac: ansiHmac(
                namespace.evidenceKey,
                "tmux-capture",
                preAlternateNative.capture,
              ),
            }),
          });
          const result = await driveAnsiStage(namespace, "a", {
            stage: "alternate",
            action: "enter-alternate",
            afterRevision: preAlternate.stage.revision,
            alternateScreen: true,
            gridWalked: true,
            gridRowsRead: baseline.rawIdentity.viewportRows,
            fullWalk: false,
          });
          if (
            Object.entries(fixedAnsiCursor("alternate", namespace.marker)).some(
              ([field, value]) => result.stage.cursor[field] !== value,
            )
          )
            throw new Error("ANSI alternate cursor did not match the fixed contract");
          event("ansi-alternate-screen", { revision: result.stage.revision });
          const native = await inspectAnsiNativeStage(
            namespace,
            {
              resources: baseline.resources,
              sessionName: baseline.sessionName,
              windowResourceId: baseline.windowResourceId,
              semanticPaneId: baseline.semanticPaneId,
            },
            "alternate",
            { displayCursor: true },
          );
          const alternateResult = Object.freeze({
            ...result,
            preAlternate: Object.freeze({
              stage: preAlternate.stage,
              evidence: preAlternateEvidence,
              nativeCaptureHmac: ansiHmac(
                namespace.evidenceKey,
                "tmux-capture",
                preAlternateNative.capture,
              ),
            }),
            tmux: Object.freeze({
              geometryStable:
                ansiTmuxSemanticProjection(native.snapshot) ===
                ansiTmuxSemanticProjection(baseline.tmux),
              markerAbsent: !native.capture.includes(namespace.marker),
              cursorExact:
                native.cursor.x === 11 &&
                native.cursor.y === 7 &&
                native.cursor.cols === result.stage.canonicalCols &&
                native.cursor.rows === result.stage.viewportRows,
              captureHmac: ansiHmac(namespace.evidenceKey, "tmux-capture", native.capture),
            }),
          });
          publishAnsiPartial({ stage: "alternate", alternate: result.stage });
          return alternateResult;
        },
        restoreNormalScreen: async (
          namespace,
          _daemon,
          _identity,
          _process,
          _baseline,
          alternate,
        ) => {
          const result = await driveAnsiStage(namespace, "n", {
            stage: "restored",
            action: "restore-normal",
            afterRevision: alternate.stage.revision,
            alternateScreen: false,
            gridWalked: true,
            gridRowsRead: _baseline.rawIdentity.viewportRows,
            fullWalk: false,
          });
          if (
            Object.entries(fixedAnsiCursor("restored", namespace.marker)).some(
              ([field, value]) => result.stage.cursor[field] !== value,
            )
          )
            throw new Error("ANSI restored cursor did not match the fixed normal contract");
          const restoredNative = await inspectAnsiNativeStage(
            namespace,
            {
              resources: _baseline.resources,
              sessionName: _baseline.sessionName,
              windowResourceId: _baseline.windowResourceId,
              semanticPaneId: _baseline.semanticPaneId,
            },
            "final",
          );
          const restoredNativeCaptureHmac = ansiHmac(
            namespace.evidenceKey,
            "tmux-capture",
            restoredNative.capture,
          );
          if (
            result.stage.presentationHmac !== _baseline.stage.presentationHmac ||
            result.stage.presentationHmac !== alternate.preAlternate.stage.presentationHmac ||
            result.stage.framebufferHmac !== alternate.preAlternate.stage.framebufferHmac ||
            ansiTmuxSemanticProjection(restoredNative.snapshot) !==
              ansiTmuxSemanticProjection(_baseline.tmux) ||
            restoredNativeCaptureHmac !== _baseline.tmuxCaptureHmac ||
            restoredNativeCaptureHmac !== alternate.preAlternate.nativeCaptureHmac
          )
            throw new Error("ANSI normal buffer restoration was not exact");
          event("ansi-normal-restored", { revision: result.stage.revision });
          publishAnsiPartial({ stage: "restored", restored: result.stage });
          return result;
        },
        runSustainedWorkload: async (
          namespace,
          _daemon,
          _identity,
          _process,
          baseline,
          restored,
        ) => {
          let revision = restored.stage.revision;
          const resourceSamples = [];
          const expectedResources = [];
          const resourceCheckpointSamples = [];
          const expectedResourceCheckpoints = [];
          const workloadFinalities = [];
          const expectedWorkloadFinalities = [];
          let latestFence = restored.raw.fence;
          const boundedWorkloadRegression = ({ cycle, reason, ordered, progress, nowMs }) => {
            const lastResource = resourceCheckpointSamples.at(-1) ?? null;
            const boundedMetric = (value, ceiling) =>
              Number.isSafeInteger(value) && value >= 0 ? Math.min(value, ceiling) : null;
            return Object.freeze({
              operation: "ansi-workload-finality",
              cycle,
              completedCycles: cycle - 1,
              firstFailedPredicate: "progress-regression",
              progressReason: reason,
              progressCount: boundedMetric(progress?.progressCount, 65_536),
              elapsedMs:
                progress && Number.isSafeInteger(nowMs)
                  ? boundedMetric(nowMs - progress.startedAtMs, ANSI_WORKLOAD_ABSOLUTE_MS)
                  : null,
              noProgressElapsedMs:
                progress && Number.isSafeInteger(nowMs)
                  ? boundedMetric(nowMs - progress.lastProgressAtMs, ANSI_WORKLOAD_NO_PROGRESS_MS)
                  : null,
              streamCounts: ordered?.counts ?? null,
              offendingRevisionHmac: Number.isSafeInteger(ordered?.offendingRevision)
                ? ansiHmac(
                    namespace.evidenceKey,
                    "workload-offending-revision",
                    ordered.offendingRevision,
                  )
                : null,
              offendingAcceptedType: new Set(["terminal.seed", "terminal.patch"]).has(
                ordered?.offendingAcceptedType,
              )
                ? ordered.offendingAcceptedType
                : null,
              resourceLast: lastResource
                ? Object.freeze({
                    cycle: lastResource.cycle,
                    rssBytes: boundedMetric(lastResource.rssBytes, 1_073_741_825),
                    heapUsedBytes: boundedMetric(lastResource.heapUsedBytes, 536_870_913),
                    eventLoopDelayMicros: boundedMetric(
                      lastResource.eventLoopDelayMicros,
                      5_000_000,
                    ),
                    rssPeakBytes: boundedMetric(lastResource.rssPeakBytes, 1_073_741_825),
                    heapUsedPeakBytes: boundedMetric(lastResource.heapUsedPeakBytes, 536_870_913),
                    eventLoopDelayPeakMicros: boundedMetric(
                      lastResource.eventLoopDelayPeakMicros,
                      5_000_000,
                    ),
                    inputPendingPeak: boundedMetric(lastResource.inputPendingPeak, 65_537),
                    inputInFlightPeak: boundedMetric(lastResource.inputInFlightPeak, 65_537),
                    inputPendingBytesPeak: boundedMetric(
                      lastResource.inputPendingBytesPeak,
                      67_108_865,
                    ),
                    resourceSamplingFailureCount: boundedMetric(
                      lastResource.resourceSamplingFailureCount,
                      65_537,
                    ),
                  })
                : null,
            });
          };
          for (let cycle = 1; cycle <= 24; cycle += 1) {
            publishAnsiPartial({
              stage: "workload",
              workloadProgress: Object.freeze({
                activeCycle: cycle,
                completedCycles: cycle - 1,
                progressCount: 0,
                elapsedMs: 0,
                noProgressElapsedMs: 0,
              }),
            });
            const watermark = (await ansiJsonlWatermark(namespace.tui.performanceTracePath))
              .recordCount;
            const daemonWatermark = (
              await ansiJsonlWatermark(namespace.tui.daemonPerformanceTracePath)
            ).recordCount;
            const lifecycleWatermark = (
              await ansiJsonlWatermark(
                join(namespace.tui.runtimeDir, "performance.jsonl"),
                "lifecycle",
              )
            ).recordCount;
            const producerWatermark = (await ansiJsonlWatermark(namespace.fixtureCompletionPath))
              .recordCount;
            const marker = ansiWorkloadMarker(namespace.marker, cycle);
            const markerHmac = ansiHmac(namespace.evidenceKey, "workload-marker", marker);
            const workloadPayload = ansiWorkloadPayload(namespace.marker, cycle);
            const payloadBytes = Buffer.byteLength(workloadPayload);
            const payloadSha256 = createHash("sha256").update(workloadPayload).digest("hex");
            const producerPayloadHmac = ansiHmac(
              namespace.evidenceKey,
              "workload-producer-payload",
              payloadSha256,
            );
            const delivery = await driveExactHostedInput(
              state,
              { version: 1, kind: "key", key: "w", timeoutMs: 2_000 },
              ownerAbort.signal,
            );
            if (delivery.bytesInjected !== 1 || delivery.phases !== 1)
              throw new Error("ANSI workload input was not one exact byte");
            const workloadStartedAtMs = Math.floor(performance.now());
            let workloadProgress = advanceAnsiWorkloadProgress(
              null,
              {
                canonicalRevision: null,
                enqueueOrdinal: null,
                enqueueCanonicalRevision: null,
                settledOrdinal: null,
                settledCanonicalRevision: null,
                frameRevision: null,
                fenceRevision: null,
                producerOrdinal: null,
              },
              workloadStartedAtMs,
            );
            let result;
            let candidate = null;
            let lastMarkerCount = 0;
            let lastFinalityObservation;
            let publishedProgressCount = -1;
            let timeoutNativeEvidence = null;
            for (;;) {
              const records = ansiReadJsonLines(namespace.tui.performanceTracePath);
              const tail = records.slice(watermark);
              const daemonRecords = ansiReadJsonLines(namespace.tui.daemonPerformanceTracePath);
              const daemonTail = daemonRecords.slice(daemonWatermark);
              const producerRecords = ansiReadJsonLines(namespace.fixtureCompletionPath);
              const producerTail = producerRecords.slice(producerWatermark);
              const producer = ansiWorkloadProducerStatus(producerTail, {
                cycle,
                ordinal: cycle,
                payloadBytes,
                payloadSha256,
              });
              const origins = tail.filter(
                (record) =>
                  record?.type === "performance.input-origin" &&
                  record.origin === "keyboard" &&
                  record.semanticPaneId === restored.raw.mode.semanticPaneId,
              );
              const origin = origins.length === 1 ? origins[0] : null;
              const modes = tail.filter(
                (record) =>
                  record?.type === "performance.terminal-canonical-mode" &&
                  record.semanticPaneId === restored.raw.mode.semanticPaneId &&
                  record.generation === restored.raw.mode.generation &&
                  record.incarnation === restored.raw.mode.incarnation &&
                  record.processId === baseline.rawIdentity.processId &&
                  record.clockId === baseline.rawIdentity.clockId &&
                  record.clockKind === "performance-now" &&
                  record.revision > revision,
              );
              const canonicalTransitions = tail.filter(
                (record) =>
                  ((record?.type === "performance.terminal-canonical-update" &&
                    record.updateType === "terminal.patch") ||
                    (record?.type === "performance.terminal-canonical-publication" &&
                      record.updateType === "terminal.seed")) &&
                  record.semanticPaneId === restored.raw.mode.semanticPaneId &&
                  record.generation === restored.raw.mode.generation &&
                  record.incarnation === restored.raw.mode.incarnation &&
                  record.processId === baseline.rawIdentity.processId &&
                  record.clockId === baseline.rawIdentity.clockId &&
                  record.clockKind === "performance-now" &&
                  record.revision > revision,
              );
              const authorityFrames = tail.filter(
                (record) =>
                  record?.type === "performance.terminal-canonical-host-frame" &&
                  record.semanticPaneId === restored.raw.mode.semanticPaneId &&
                  record.generation === restored.raw.mode.generation &&
                  record.incarnation === restored.raw.mode.incarnation &&
                  record.processId === baseline.rawIdentity.processId &&
                  record.clockId === baseline.rawIdentity.clockId &&
                  record.clockKind === "performance-now" &&
                  record.revision > revision,
              );
              const authorityFences = tail.filter(
                (record) =>
                  record?.type === "performance.terminal-frame-fence" &&
                  record.semanticPaneId === restored.raw.mode.semanticPaneId &&
                  record.generation === restored.raw.mode.generation &&
                  record.incarnation === restored.raw.mode.incarnation &&
                  record.processId === baseline.rawIdentity.processId &&
                  record.clockId === baseline.rawIdentity.clockId &&
                  record.clockKind === "performance-now" &&
                  record.revision > revision,
              );
              const deliveryAuthority = ansiWorkloadDeliveryAuthorityTail({
                daemonRecords: daemonTail,
                expected: {
                  workspaceName: baseline.deliveryWorkspaceName,
                  semanticPaneId: baseline.semanticPaneId,
                  generation: restored.raw.mode.generation,
                  incarnation: restored.raw.mode.incarnation,
                  daemonProcessId: baseline.rawIdentity.daemonProcessId,
                  daemonClockId: baseline.rawIdentity.daemonClockId,
                  daemonClockKind: "performance-now",
                },
              });
              const orderedProgress = deliveryAuthority.exact
                ? ansiWorkloadOrderedTailStatus({
                    transitions: canonicalTransitions,
                    modes,
                    enqueues: deliveryAuthority.enqueues,
                    settlements: deliveryAuthority.settlements,
                    frames: authorityFrames,
                    fences: authorityFences,
                  })
                : Object.freeze({ exact: false, reason: "delivery-authority", progress: null });
              if (!orderedProgress.exact) {
                const error = new Error("ANSI workload progress tail regressed");
                error.boundary = "ansi-workload-finality";
                error.observation = boundedWorkloadRegression({
                  cycle,
                  reason: orderedProgress.reason,
                  ordered: orderedProgress,
                  progress: workloadProgress,
                  nowMs: Math.floor(performance.now()),
                });
                publishAnsiPartial({ stage: "workload", workloadFailure: error.observation });
                throw error;
              }
              const finalTransition = canonicalTransitions.at(-1) ?? null;
              const matchingModes = modes.filter(
                (record) =>
                  record.revision === finalTransition?.revision &&
                  record.stateHash === finalTransition?.stateHash,
              );
              const mode = matchingModes.length === 1 ? matchingModes[0] : null;
              const frames = authorityFrames.filter(
                (record) =>
                  record.revision === finalTransition?.revision &&
                  record.stateHash === finalTransition?.stateHash,
              );
              const fences = authorityFences.filter(
                (record) =>
                  record.revision === finalTransition?.revision &&
                  record.stateHash === finalTransition?.stateHash,
              );
              const cursorPresentations = tail.filter(
                (record) =>
                  record?.type === "performance.terminal-cursor-presentation" &&
                  record.semanticPaneId === finalTransition?.semanticPaneId &&
                  record.generation === finalTransition?.generation &&
                  record.incarnation === finalTransition?.incarnation &&
                  record.processId === baseline.rawIdentity.processId &&
                  record.clockId === baseline.rawIdentity.clockId &&
                  record.clockKind === "performance-now" &&
                  record.revision === finalTransition?.revision &&
                  record.stateHash === finalTransition?.stateHash,
              );
              const finalCursorPresentation =
                cursorPresentations.length === 1 ? cursorPresentations[0] : null;
              const deliveryJoin = ansiWorkloadDeliveryJoin({
                canonical: finalTransition,
                daemonRecords: daemonTail,
                expected: {
                  workspaceName: baseline.deliveryWorkspaceName,
                  semanticPaneId: baseline.semanticPaneId,
                  daemonProcessId: baseline.rawIdentity.daemonProcessId,
                  daemonClockId: baseline.rawIdentity.daemonClockId,
                  daemonClockKind: "performance-now",
                },
              });
              const progressNowMs = Math.floor(performance.now());
              try {
                workloadProgress = advanceAnsiWorkloadProgress(
                  workloadProgress,
                  {
                    ...orderedProgress.progress,
                    producerOrdinal: producer.exact ? producer.record.ordinal : null,
                  },
                  progressNowMs,
                );
              } catch (error) {
                if (error?.code !== "ANSI_WORKLOAD_PROGRESS_REGRESSION") throw error;
                const regression = new Error("ANSI workload progress regressed across polls");
                regression.boundary = "ansi-workload-finality";
                regression.observation = boundedWorkloadRegression({
                  cycle,
                  reason: "cross-poll",
                  ordered: orderedProgress,
                  progress: workloadProgress,
                  nowMs: progressNowMs,
                });
                publishAnsiPartial({
                  stage: "workload",
                  workloadFailure: regression.observation,
                });
                throw regression;
              }
              if (workloadProgress.progressCount !== publishedProgressCount) {
                publishedProgressCount = workloadProgress.progressCount;
                publishAnsiPartial({
                  stage: "workload",
                  workloadProgress: Object.freeze({
                    activeCycle: cycle,
                    completedCycles: cycle - 1,
                    progressCount: workloadProgress.progressCount,
                    elapsedMs: Math.min(progressNowMs - workloadProgress.startedAtMs, 30_000),
                    noProgressElapsedMs: Math.min(
                      progressNowMs - workloadProgress.lastProgressAtMs,
                      15_000,
                    ),
                  }),
                });
              }
              const progressDeadlineExpiry = ansiWorkloadProgressExpiry(
                workloadProgress,
                progressNowMs,
              );
              if (
                timeoutNativeEvidence === null &&
                progressNowMs - workloadProgress.lastProgressAtMs >= 12_000
              ) {
                try {
                  const native = await inspectAnsiNativeStage(
                    namespace,
                    {
                      resources: baseline.resources,
                      sessionName: baseline.sessionName,
                      windowResourceId: baseline.windowResourceId,
                      semanticPaneId: baseline.semanticPaneId,
                    },
                    "workload-timeout",
                    { displayCursor: true, deadlineMs: 500 },
                  );
                  const nativeMarkerCount = native.capture.split(marker).length - 1;
                  timeoutNativeEvidence = Object.freeze({
                    available: true,
                    markerPresent: nativeMarkerCount === 1,
                    markerCount: Math.min(Math.max(nativeMarkerCount, 0), 2),
                    captureHmac: ansiHmac(
                      namespace.evidenceKey,
                      "workload-timeout-native-capture",
                      native.capture,
                    ),
                    cursorX:
                      Number.isSafeInteger(native.cursor?.x) && native.cursor.x <= 4_096
                        ? native.cursor.x
                        : null,
                    cursorY:
                      Number.isSafeInteger(native.cursor?.y) && native.cursor.y <= 4_096
                        ? native.cursor.y
                        : null,
                    cursorVisible: null,
                    reason: null,
                  });
                } catch {
                  timeoutNativeEvidence = Object.freeze({
                    available: false,
                    markerPresent: null,
                    markerCount: null,
                    captureHmac: null,
                    cursorX: null,
                    cursorY: null,
                    cursorVisible: null,
                    reason: "capture-unavailable",
                  });
                }
              }
              const encode = deliveryJoin.encode;
              const finalSettled = deliveryJoin.settled;
              const tracedEnqueues = deliveryAuthority.enqueues.filter(
                (record) =>
                  typeof origin?.traceId === "string" && record?.traceId === origin.traceId,
              );
              const tracedDelivery = tracedEnqueues.length === 1 ? tracedEnqueues[0] : null;
              const paintCount = tail.filter(
                (record) =>
                  record?.type === "performance.terminal-paint" &&
                  record.processId === baseline.rawIdentity.processId &&
                  record.clockId === baseline.rawIdentity.clockId,
              ).length;
              const lifecycleRecords = ansiReadJsonLines(
                join(namespace.tui.runtimeDir, "performance.jsonl"),
                "lifecycle",
              );
              const currentState = readJson(statePath);
              const latestWorkspaceClient = lifecycleRecords
                .filter(
                  (record) =>
                    record?.phase === "generation-workspace-client-state" &&
                    record.processId === baseline.rawIdentity.processId,
                )
                .at(-1);
              const latestGenerationStatus = lifecycleRecords
                .filter(
                  (record) =>
                    record?.phase === "generation-status" &&
                    record.processId === baseline.rawIdentity.processId,
                )
                .at(-1);
              const workspaceClientExact =
                latestWorkspaceClient?.daemonGeneration === baseline.daemonGeneration &&
                latestWorkspaceClient?.workspaceClient?.committed?.generation ===
                  baseline.clientGeneration;
              const lifecycleExact =
                latestGenerationStatus?.daemonGeneration === baseline.daemonGeneration &&
                latestGenerationStatus?.status === "live";
              const lifecycleViolation = lifecycleRecords
                .slice(lifecycleWatermark)
                .some(
                  (record) =>
                    record?.processId === baseline.rawIdentity.processId &&
                    ((record.phase === "generation-status" &&
                      (record.daemonGeneration !== baseline.daemonGeneration ||
                        record.status !== "live")) ||
                      (record.phase === "generation-workspace-client-state" &&
                        (record.daemonGeneration !== baseline.daemonGeneration ||
                          record.workspaceClient?.committed?.generation !==
                            baseline.clientGeneration))),
                );
              const rebound =
                currentState?.daemon?.instanceId !== baseline.daemonGeneration ||
                currentState?.tui?.runtimeDir !== namespace.tui.runtimeDir ||
                !processAlive(Number(baseline.processId.slice("opentui:".length))) ||
                !workspaceClientExact ||
                !lifecycleExact ||
                lifecycleViolation;
              const faulted =
                currentState?.status === "failed" ||
                daemonTail.some(
                  (record) =>
                    record?.operation === "terminal-delivery-fault" &&
                    record?.processId === baseline.rawIdentity.daemonProcessId &&
                    record?.clockId === baseline.rawIdentity.daemonClockId &&
                    record?.clockKind === "performance-now" &&
                    record?.terminalDelivery?.workspaceName === baseline.deliveryWorkspaceName &&
                    record?.terminalDelivery?.semanticPaneId === baseline.semanticPaneId &&
                    record?.terminalDelivery?.faultReason,
                );
              const flowPhases = new Set([
                "pause",
                "continue-request",
                "continue-reply",
                "continue-notify",
                "provisional-reseed",
                "final-continue-request",
                "final-continue-reply",
                "final-reseed",
                "confirmation-reseed",
                "converged",
                "nonconverged",
              ]);
              const flowRecords = daemonTail.filter(
                (record) =>
                  flowPhases.has(record?.terminalDelivery?.mirrorFlowPhase) &&
                  record?.terminalDelivery?.semanticPaneId === baseline.semanticPaneId,
              );
              const lastFlow = flowRecords.at(-1)?.terminalDelivery ?? null;
              const flowRecoveryEvidence = Object.freeze({
                count: Math.min(flowRecords.length, 33),
                lastPhase: flowPhases.has(lastFlow?.mirrorFlowPhase)
                  ? lastFlow.mirrorFlowPhase
                  : null,
                recoveryOrdinal:
                  Number.isSafeInteger(lastFlow?.mirrorFlowRecoveryOrdinal) &&
                  lastFlow.mirrorFlowRecoveryOrdinal >= 0
                    ? Math.min(lastFlow.mirrorFlowRecoveryOrdinal, 65_536)
                    : null,
                paneIncarnation:
                  Number.isSafeInteger(lastFlow?.mirrorPaneIncarnation) &&
                  lastFlow.mirrorPaneIncarnation >= 0
                    ? Math.min(lastFlow.mirrorPaneIncarnation, 65_536)
                    : null,
                outputOrdinal:
                  Number.isSafeInteger(lastFlow?.mirrorOutputOrdinal) &&
                  lastFlow.mirrorOutputOrdinal >= 0
                    ? Math.min(lastFlow.mirrorOutputOrdinal, 1_000_000)
                    : null,
                elapsedMicros:
                  Number.isSafeInteger(lastFlow?.mirrorRecoveryElapsedMicros) &&
                  lastFlow.mirrorRecoveryElapsedMicros >= 0
                    ? Math.min(lastFlow.mirrorRecoveryElapsedMicros, 5_000_000)
                    : null,
                fingerprintExact:
                  typeof lastFlow?.mirrorRecoveryFingerprintExact === "boolean"
                    ? lastFlow.mirrorRecoveryFingerprintExact
                    : null,
                confirmationOrdinal:
                  Number.isSafeInteger(lastFlow?.mirrorRecoveryConfirmationOrdinal) &&
                  lastFlow.mirrorRecoveryConfirmationOrdinal >= 0
                    ? Math.min(lastFlow.mirrorRecoveryConfirmationOrdinal, 65_536)
                    : null,
                collectorStarted:
                  typeof lastFlow?.mirrorCollectorStarted === "boolean"
                    ? lastFlow.mirrorCollectorStarted
                    : null,
                collectorLastCompletedOrdinal:
                  Number.isSafeInteger(lastFlow?.mirrorCollectorLastCompletedOrdinal) &&
                  lastFlow.mirrorCollectorLastCompletedOrdinal >= -1
                    ? Math.min(lastFlow.mirrorCollectorLastCompletedOrdinal, 32)
                    : null,
                collectorCaptureLineCount:
                  Number.isSafeInteger(lastFlow?.mirrorCollectorCaptureLineCount) &&
                  lastFlow.mirrorCollectorCaptureLineCount >= 0
                    ? Math.min(lastFlow.mirrorCollectorCaptureLineCount, 8_192)
                    : null,
                collectorCaptureByteCount:
                  Number.isSafeInteger(lastFlow?.mirrorCollectorCaptureByteCount) &&
                  lastFlow.mirrorCollectorCaptureByteCount >= 0
                    ? Math.min(lastFlow.mirrorCollectorCaptureByteCount, 16 * 1024 * 1024)
                    : null,
                collectorContinueObserved:
                  typeof lastFlow?.mirrorCollectorContinueObserved === "boolean"
                    ? lastFlow.mirrorCollectorContinueObserved
                    : null,
                collectorStatusObserved:
                  typeof lastFlow?.mirrorCollectorStatusObserved === "boolean"
                    ? lastFlow.mirrorCollectorStatusObserved
                    : null,
                collectorObserverEmissionObserved:
                  typeof lastFlow?.mirrorCollectorObserverEmissionObserved === "boolean"
                    ? lastFlow.mirrorCollectorObserverEmissionObserved
                    : null,
                collectorFailureReason: ANSI_ATOMIC_COLLECTOR_FAILURE_REASONS.has(
                  lastFlow?.mirrorCollectorFailureReason,
                )
                  ? lastFlow.mirrorCollectorFailureReason
                  : null,
                canonicalStateHmac:
                  typeof finalTransition?.stateHash === "string"
                    ? ansiHmac(
                        namespace.evidenceKey,
                        "workload-timeout-canonical-state",
                        finalTransition.stateHash,
                      )
                    : null,
                lastFailureReason: ANSI_MIRROR_FLOW_FAILURE_REASONS.has(
                  lastFlow?.mirrorFlowFailureReason,
                )
                  ? lastFlow.mirrorFlowFailureReason
                  : null,
              });
              const baseExact =
                origin &&
                origin.revision === ansiCanonicalPredecessor?.revision &&
                origin.stateHash === ansiCanonicalPredecessor?.stateHash &&
                finalTransition &&
                tail.length <= 65_536 &&
                daemonTail.length <= 65_536 &&
                frames.length === 1 &&
                fences.length === 1 &&
                finalCursorPresentation !== null &&
                finalCursorPresentation.cursorY === 39 &&
                finalCursorPresentation.viewportRows === 40 &&
                finalCursorPresentation.visible === true &&
                producer.exact &&
                deliveryJoin.exact &&
                tracedDelivery &&
                encode &&
                ["patch", "seed"].includes(encode.terminalDelivery.representation) &&
                Number.isSafeInteger(encode.terminalDelivery.representationBytes) &&
                progressDeadlineExpiry === null &&
                !faulted &&
                !rebound;
              if (baseExact) {
                if (
                  !candidate ||
                  candidate.revision !== finalTransition.revision ||
                  candidate.stateHash !== finalTransition.stateHash ||
                  candidate.canonicalTransitionCount !== canonicalTransitions.length ||
                  candidate.frameCount !== frames.length ||
                  candidate.fenceCount !== fences.length ||
                  candidate.enqueueCount !== deliveryJoin.enqueueCount ||
                  candidate.settledCount !== deliveryJoin.settledCount ||
                  candidate.paintCount !== paintCount
                ) {
                  const captureEnvelope = JSON.parse(
                    await tuiCommandAsync(state, ["capture", "--ansi", "--json"], {
                      timeout: 1_500,
                      signal: ownerAbort.signal,
                    }),
                  );
                  const capture = decodeFocusFramebufferCapture(captureEnvelope);
                  const markerCount = capture.plain.split(marker).length - 1;
                  lastMarkerCount = Math.min(markerCount, 2);
                  const captureIdentityExact =
                    captureEnvelope?.hostIdentity?.processId ===
                      baseline.host?.hostIdentity?.processId &&
                    captureEnvelope?.hostIdentity?.cols === baseline.host?.hostIdentity?.cols &&
                    captureEnvelope?.hostIdentity?.rows === baseline.host?.hostIdentity?.rows;
                  candidate =
                    markerCount === 1 && captureIdentityExact
                      ? Object.freeze({
                          revision: finalTransition.revision,
                          stateHash: finalTransition.stateHash,
                          canonicalTransitionCount: canonicalTransitions.length,
                          frameCount: frames.length,
                          fenceCount: fences.length,
                          enqueueCount: deliveryJoin.enqueueCount,
                          settledCount: deliveryJoin.settledCount,
                          paintCount,
                          startedAt: performance.now(),
                          markerCount,
                        })
                      : null;
                } else if (performance.now() - candidate.startedAt >= 40) {
                  const stableTailMs = Math.floor(performance.now() - candidate.startedAt);
                  const finality = Object.freeze({
                    cycle,
                    markerHmac,
                    payloadBytes,
                    producerStatus: producer.state,
                    producerOrdinal: producer.record.ordinal,
                    producerPayloadHmac,
                    producerBackpressureCount: producer.record.backpressureCount,
                    deliveryBytes: encode.terminalDelivery.representationBytes,
                    representation: encode.terminalDelivery.representation,
                    attemptedPatchBytes: encode.terminalDelivery.attemptedPatchBytes,
                    attemptedSeedBytes: encode.terminalDelivery.attemptedSeedBytes,
                    attemptedLegacyPatchBytes: encode.terminalDelivery.attemptedLegacyPatchBytes,
                    attemptedLegacySeedBytes: encode.terminalDelivery.attemptedLegacySeedBytes,
                    attemptedCompactPatchBytes: encode.terminalDelivery.attemptedCompactPatchBytes,
                    attemptedCompactSeedBytes: encode.terminalDelivery.attemptedCompactSeedBytes,
                    selectedEncoding: encode.terminalDelivery.selectedEncoding,
                    selectionStatus: encode.terminalDelivery.selectionStatus,
                    deliveryOrdinal: encode.terminalDelivery.deliveryOrdinal,
                    deliveryHmac: ansiHmac(
                      namespace.evidenceKey,
                      "workload-delivery",
                      encode.terminalDelivery.transactionId,
                    ),
                    originCount: origins.length,
                    canonicalTransitionType: finalTransition.updateType,
                    canonicalTransitionCount: Math.min(canonicalTransitions.length, 8_193),
                    frameCount: frames.length,
                    fenceCount: fences.length,
                    settledCount: deliveryJoin.settledCount,
                    markerCount: candidate.markerCount,
                    finalCursorY: finalCursorPresentation.cursorY,
                    viewportRows: finalCursorPresentation.viewportRows,
                    cursorVisible: finalCursorPresentation.visible,
                    queueDepth: finalSettled.terminalDelivery.queueDepth,
                    inFlight: finalSettled.terminalDelivery.inFlight,
                    inFlightBytes: finalSettled.terminalDelivery.inFlightBytes,
                    stableTailMs,
                    elapsedMs: Math.min(
                      progressNowMs - workloadProgress.startedAtMs,
                      ANSI_WORKLOAD_ABSOLUTE_MS,
                    ),
                    noProgressElapsedMs: Math.min(
                      progressNowMs - workloadProgress.lastProgressAtMs,
                      ANSI_WORKLOAD_NO_PROGRESS_MS,
                    ),
                    progressCount: workloadProgress.progressCount,
                    absoluteDeadlineMs: ANSI_WORKLOAD_ABSOLUTE_MS,
                    noProgressDeadlineMs: ANSI_WORKLOAD_NO_PROGRESS_MS,
                    laterTransitionCount: Math.max(
                      0,
                      canonicalTransitions.length - candidate.canonicalTransitionCount,
                    ),
                    laterEnqueueCount: Math.max(
                      0,
                      deliveryJoin.enqueueCount - candidate.enqueueCount,
                    ),
                    laterPaintCount: Math.max(0, paintCount - candidate.paintCount),
                    authorityIdentityExact: deliveryJoin.exact,
                    finalityExact: true,
                    drainExact: true,
                    faulted,
                    rebound,
                  });
                  workloadFinalities.push(finality);
                  expectedWorkloadFinalities.push(
                    Object.freeze({ cycle, markerHmac, payloadBytes, producerPayloadHmac }),
                  );
                  result = Object.freeze({
                    raw: Object.freeze({
                      origin,
                      transition: finalTransition,
                      mode,
                      presentation: finalCursorPresentation,
                      fence: fences[0],
                      daemonDelivery: finalSettled,
                      tracedDelivery,
                    }),
                    finality,
                  });
                  break;
                }
              } else {
                candidate = null;
              }
              const drainExact = deliveryJoin.exact;
              const firstFailedPredicate =
                origins.length !== 1
                  ? "origin-count"
                  : !finalTransition
                    ? "canonical-final"
                    : frames.length !== 1
                      ? "actual-frame"
                      : fences.length !== 1
                        ? "healthy-fence"
                        : finalCursorPresentation === null
                          ? "cursor-presentation"
                          : finalCursorPresentation.cursorY !== 39 ||
                              finalCursorPresentation.viewportRows !== 40 ||
                              finalCursorPresentation.visible !== true
                            ? "visible-marker-cursor"
                            : faulted
                              ? "runtime-fault"
                              : rebound
                                ? "runtime-rebind"
                                : !producer.exact
                                  ? producer.state === "error"
                                    ? "producer-error"
                                    : "producer-incomplete"
                                  : !encode
                                    ? "representation"
                                    : !tracedDelivery
                                      ? "operation-trace"
                                      : !drainExact
                                        ? "delivery-drain"
                                        : lastMarkerCount !== 1
                                          ? "visible-marker"
                                          : "stable-tail";
              lastFinalityObservation = Object.freeze({
                operation: "ansi-workload-finality",
                cycle,
                payloadBytes,
                producerStatus: producer.state,
                producerOrdinal: Number.isSafeInteger(producer.record?.ordinal)
                  ? producer.record.ordinal
                  : null,
                producerPayloadHmac:
                  producer.record?.payloadSha256 === payloadSha256 ? producerPayloadHmac : null,
                producerBackpressureCount: Number.isSafeInteger(producer.record?.backpressureCount)
                  ? Math.min(producer.record.backpressureCount, 8_193)
                  : null,
                producerFirstCause: producer.exact
                  ? null
                  : producer.state === "error"
                    ? "stdout-write"
                    : producer.state === "pending"
                      ? "completion-absent"
                      : "completion-invalid",
                originCount: Math.min(origins.length, 2),
                canonicalTransitionType: new Set(["terminal.seed", "terminal.patch"]).has(
                  finalTransition?.updateType,
                )
                  ? finalTransition.updateType
                  : null,
                canonicalTransitionCount: Math.min(canonicalTransitions.length, 8_193),
                frameCount: Math.min(frames.length, 2),
                fenceCount: Math.min(fences.length, 2),
                settledCount: Math.min(deliveryJoin.settledCount, 2),
                markerCount: lastMarkerCount,
                finalCursorY:
                  Number.isSafeInteger(finalCursorPresentation?.cursorY) &&
                  finalCursorPresentation.cursorY >= 0 &&
                  finalCursorPresentation.cursorY <= 4_096
                    ? finalCursorPresentation.cursorY
                    : null,
                viewportRows:
                  Number.isSafeInteger(finalCursorPresentation?.viewportRows) &&
                  finalCursorPresentation.viewportRows > 0 &&
                  finalCursorPresentation.viewportRows <= 4_096
                    ? finalCursorPresentation.viewportRows
                    : null,
                cursorVisible:
                  typeof finalCursorPresentation?.visible === "boolean"
                    ? finalCursorPresentation.visible
                    : null,
                authorityIdentityExact: deliveryJoin.exact,
                operationTraceExact: tracedDelivery !== null,
                finalityExact: false,
                drainExact,
                stableExact: false,
                elapsedMs: Math.min(
                  progressNowMs - workloadProgress.startedAtMs,
                  ANSI_WORKLOAD_ABSOLUTE_MS,
                ),
                noProgressElapsedMs: Math.min(
                  progressNowMs - workloadProgress.lastProgressAtMs,
                  ANSI_WORKLOAD_NO_PROGRESS_MS,
                ),
                progressCount: workloadProgress.progressCount,
                absoluteDeadlineMs: ANSI_WORKLOAD_ABSOLUTE_MS,
                noProgressDeadlineMs: ANSI_WORKLOAD_NO_PROGRESS_MS,
                faulted,
                rebound,
                representation: ["patch", "seed"].includes(encode?.terminalDelivery?.representation)
                  ? encode.terminalDelivery.representation
                  : null,
                selectedEncoding: ["semantic-v1", "semantic-compact-v1"].includes(
                  encode?.terminalDelivery?.selectedEncoding,
                )
                  ? encode.terminalDelivery.selectedEncoding
                  : null,
                attemptedPatchBytes: Number.isSafeInteger(
                  encode?.terminalDelivery?.attemptedPatchBytes,
                )
                  ? Math.min(encode.terminalDelivery.attemptedPatchBytes, 67_108_865)
                  : null,
                attemptedSeedBytes: Number.isSafeInteger(
                  encode?.terminalDelivery?.attemptedSeedBytes,
                )
                  ? Math.min(encode.terminalDelivery.attemptedSeedBytes, 67_108_865)
                  : null,
                attemptedLegacyPatchBytes: Number.isSafeInteger(
                  encode?.terminalDelivery?.attemptedLegacyPatchBytes,
                )
                  ? Math.min(encode.terminalDelivery.attemptedLegacyPatchBytes, 67_108_865)
                  : null,
                attemptedLegacySeedBytes: Number.isSafeInteger(
                  encode?.terminalDelivery?.attemptedLegacySeedBytes,
                )
                  ? Math.min(encode.terminalDelivery.attemptedLegacySeedBytes, 67_108_865)
                  : null,
                attemptedLegacyPatchAtLeastBytes: Number.isSafeInteger(
                  encode?.terminalDelivery?.attemptedLegacyPatchAtLeastBytes,
                )
                  ? Math.min(encode.terminalDelivery.attemptedLegacyPatchAtLeastBytes, 67_108_865)
                  : null,
                attemptedLegacySeedAtLeastBytes: Number.isSafeInteger(
                  encode?.terminalDelivery?.attemptedLegacySeedAtLeastBytes,
                )
                  ? Math.min(encode.terminalDelivery.attemptedLegacySeedAtLeastBytes, 67_108_865)
                  : null,
                attemptedLegacyPatchSizeCapped:
                  encode?.terminalDelivery?.attemptedLegacyPatchSizeCapped === true,
                attemptedLegacySeedSizeCapped:
                  encode?.terminalDelivery?.attemptedLegacySeedSizeCapped === true,
                attemptedCompactPatchBytes: Number.isSafeInteger(
                  encode?.terminalDelivery?.attemptedCompactPatchBytes,
                )
                  ? Math.min(encode.terminalDelivery.attemptedCompactPatchBytes, 67_108_865)
                  : null,
                attemptedCompactSeedBytes: Number.isSafeInteger(
                  encode?.terminalDelivery?.attemptedCompactSeedBytes,
                )
                  ? Math.min(encode.terminalDelivery.attemptedCompactSeedBytes, 67_108_865)
                  : null,
                deliveryBytes: Number.isSafeInteger(encode?.terminalDelivery?.representationBytes)
                  ? Math.min(encode.terminalDelivery.representationBytes, 16_777_217)
                  : null,
                selectionStatus: [
                  "patch-preferred",
                  "seed-preferred",
                  "patch-fallback",
                  "direct-seed",
                  "legacy-patch-fallback",
                  "legacy-seed-fallback",
                ].includes(encode?.terminalDelivery?.selectionStatus)
                  ? encode.terminalDelivery.selectionStatus
                  : null,
                deliveryOrdinal: Number.isSafeInteger(encode?.terminalDelivery?.deliveryOrdinal)
                  ? encode.terminalDelivery.deliveryOrdinal
                  : null,
                deliveryHmac:
                  typeof encode?.terminalDelivery?.transactionId === "string"
                    ? ansiHmac(
                        namespace.evidenceKey,
                        "workload-delivery",
                        encode.terminalDelivery.transactionId,
                      )
                    : null,
                laterTransitionCount: candidate
                  ? Math.min(
                      Math.max(0, canonicalTransitions.length - candidate.canonicalTransitionCount),
                      8_193,
                    )
                  : null,
                laterEnqueueCount: candidate
                  ? Math.min(Math.max(0, deliveryJoin.enqueueCount - candidate.enqueueCount), 8_193)
                  : null,
                laterPaintCount: candidate
                  ? Math.min(Math.max(0, paintCount - candidate.paintCount), 8_193)
                  : null,
                firstFailedPredicate,
                flowRecovery: flowRecoveryEvidence,
              });
              const progressExpiry = faulted
                ? "runtime-fault"
                : rebound
                  ? "runtime-rebind"
                  : progressDeadlineExpiry;
              if (progressExpiry !== null) {
                const timeoutObservation = Object.freeze({
                  ...lastFinalityObservation,
                  nativeTimeout:
                    timeoutNativeEvidence ??
                    Object.freeze({
                      available: false,
                      markerPresent: null,
                      markerCount: null,
                      captureHmac: null,
                      cursorX: null,
                      cursorY: null,
                      cursorVisible: null,
                      reason: "not-attempted",
                    }),
                  firstFailedPredicate:
                    producer.state === "error"
                      ? "producer-error"
                      : producer.state !== "complete"
                        ? "producer-incomplete"
                        : progressExpiry,
                });
                publishAnsiPartial({
                  stage: "workload",
                  workloadFinalities: Object.freeze(workloadFinalities),
                  workloadFailure: timeoutObservation,
                });
                const error = new Error(
                  "ANSI workload did not reach its exact settled final epoch",
                );
                error.boundary = "ansi-workload-finality";
                error.observation = timeoutObservation;
                throw error;
              }
              await new Promise((resolveWait) => setTimeout(resolveWait, 5));
            }
            revision = result.raw.transition.revision;
            const nextPredecessor = advanceAnsiCanonicalPredecessor(
              ansiCanonicalPredecessor,
              Object.freeze({ qualified: true, raw: result.raw }),
            );
            if (!nextPredecessor)
              throw new Error("ANSI workload crossed its canonical predecessor");
            ansiCanonicalPredecessor = nextPredecessor;
            const qualifiedPresentation = result.raw.presentation;
            if (
              !qualifiedPresentation ||
              !Number.isSafeInteger(qualifiedPresentation.gridRowsReadTotal) ||
              !Number.isSafeInteger(qualifiedPresentation.fullWalkTotal) ||
              !Number.isSafeInteger(qualifiedPresentation.presentationCount)
            )
              throw new Error("ANSI workload final presentation counters were unavailable");
            ansiPresentationCounters = Object.freeze({
              gridRowsReadTotal: qualifiedPresentation.gridRowsReadTotal,
              fullWalkTotal: qualifiedPresentation.fullWalkTotal,
              presentationCount: qualifiedPresentation.presentationCount,
            });
            latestFence = result.raw.fence;
            const sample = await waitAnsiPostFenceResource(namespace, latestFence, cycle);
            resourceCheckpointSamples.push(
              Object.freeze({
                phase: "cycle",
                cycle,
                sampleOrdinal: sample.ordinal,
                operation: sample.operation,
                resourceEpochArmed: sample.resourceEpochArmed,
                resourceEpochIdentityHmac: ansiResourceEpochIdentityHmac(
                  namespace.evidenceKey,
                  sample.resourceEpochIdentity,
                ),
                identityHmac: ansiResourceIdentityHmac(namespace.evidenceKey, sample),
                stateHmac: ansiHmac(namespace.evidenceKey, "state", sample.stateHash),
                processHmac: ansiHmac(namespace.evidenceKey, "process", sample.processId),
                clockId: sample.clockId,
                clockKind: sample.clockKind,
                atMicros: sample.atMicros,
                rssBytes: sample.rssBytes,
                heapUsedBytes: sample.heapUsedBytes,
                eventLoopDelayMicros: sample.eventLoopDelayMicros,
                rssPeakBytes: sample.rssPeakBytes,
                heapUsedPeakBytes: sample.heapUsedPeakBytes,
                eventLoopDelayPeakMicros: sample.eventLoopDelayPeakMicros,
                eventLoopDelayPeakSource: sample.eventLoopDelayPeakSource,
                lowWaterFirstSampleOrdinal: sample.lowWaterFirstSampleOrdinal,
                lowWaterLastSampleOrdinal: sample.lowWaterLastSampleOrdinal,
                lowWaterSampleCount: sample.lowWaterSampleCount,
                lowWaterWindowMicros: sample.lowWaterWindowMicros,
                inputPending: sample.inputPending,
                inputInFlight: sample.inputInFlight,
                inputPendingBytes: sample.inputPendingBytes,
                inputPendingPeak: sample.inputPendingPeak,
                inputInFlightPeak: sample.inputInFlightPeak,
                inputPendingBytesPeak: sample.inputPendingBytesPeak,
                resourceSamplingFailureCount: sample.resourceSamplingFailureCount,
              }),
            );
            expectedResourceCheckpoints.push(
              Object.freeze({
                phase: "cycle",
                cycle,
                operation: "post-fence",
                resourceEpochIdentityHmac: ansiResourceEpochIdentityHmac(
                  namespace.evidenceKey,
                  ansiResourceEpochIdentity,
                ),
                identityHmac: ansiResourceIdentityHmac(namespace.evidenceKey, latestFence),
                stateHmac: ansiHmac(namespace.evidenceKey, "state", latestFence.stateHash),
                processHmac: baseline.stage.processHmac,
                clockId: baseline.stage.clockId,
                lowWaterFirstSampleOrdinal: 1,
                lowWaterLastSampleOrdinal: 8,
                lowWaterSampleCount: 8,
              }),
            );
            publishAnsiPartial({
              stage: "workload",
              workloadProgress: Object.freeze({
                activeCycle: cycle,
                completedCycles: cycle,
                progressCount: workloadProgress.progressCount,
                elapsedMs: Math.min(
                  Math.floor(performance.now()) - workloadProgress.startedAtMs,
                  30_000,
                ),
                noProgressElapsedMs: 0,
              }),
              resourceCheckpointCount: resourceCheckpointSamples.length,
              resourcePeak: Object.freeze({
                rssBytes: Math.max(...resourceCheckpointSamples.map(({ rssBytes }) => rssBytes)),
                heapUsedBytes: Math.max(
                  ...resourceCheckpointSamples.map(({ heapUsedBytes }) => heapUsedBytes),
                ),
                eventLoopDelayMicros: Math.max(
                  ...resourceCheckpointSamples.map(
                    ({ eventLoopDelayMicros }) => eventLoopDelayMicros,
                  ),
                ),
              }),
            });
            if (cycle <= 8) continue;
            const daemonDelivery = result.raw.daemonDelivery;
            const tracedDelivery = result.raw.tracedDelivery;
            const endpointOrdinal = cycle - 8;
            resourceSamples.push(
              Object.freeze({
                endpointOrdinal,
                sampleOrdinal: sample.ordinal,
                fenceHmac: ansiHmac(namespace.evidenceKey, "fence", latestFence.stateHash),
                markerHmac: result.finality.markerHmac,
                processHmac: ansiHmac(namespace.evidenceKey, "process", sample.processId),
                clockId: sample.clockId,
                clockKind: sample.clockKind,
                atMicros: sample.atMicros,
                inputPending: sample.inputPending,
                inputInFlight: sample.inputInFlight,
                inputPendingBytes: sample.inputPendingBytes,
                daemonTraceHmac: ansiHmac(
                  namespace.evidenceKey,
                  "daemon-trace",
                  tracedDelivery.traceId,
                ),
                daemonProcessHmac: ansiHmac(
                  namespace.evidenceKey,
                  "daemon-process",
                  tracedDelivery.processId,
                ),
                daemonClockId: tracedDelivery.clockId,
                daemonClockKind: tracedDelivery.clockKind,
                daemonStartedAtMicros: tracedDelivery.startedAtMicros,
                daemonEndedAtMicros: tracedDelivery.endedAtMicros,
                representationCacheBytes: daemonDelivery.terminalDelivery.representationCacheBytes,
                rawJournalBytes: daemonDelivery.terminalDelivery.rawJournalBytes,
                deliveryQueueDepth: daemonDelivery.terminalDelivery.queueDepth,
                deliveryMaxQueueDepth: daemonDelivery.terminalDelivery.maxQueueDepth,
                deliveryInFlight: daemonDelivery.terminalDelivery.inFlight,
                deliveryInFlightBytes: daemonDelivery.terminalDelivery.inFlightBytes,
                rssBytes: sample.rssBytes,
                heapUsedBytes: sample.heapUsedBytes,
                eventLoopDelayMicros: sample.eventLoopDelayMicros,
              }),
            );
            expectedResources.push(
              Object.freeze({
                endpointOrdinal,
                sampleOrdinal: sample.ordinal,
                fenceHmac: ansiHmac(namespace.evidenceKey, "fence", latestFence.stateHash),
                markerHmac: result.finality.markerHmac,
                processHmac: baseline.stage.processHmac,
                clockId: baseline.stage.clockId,
                fenceAtMicros: latestFence.atMicros,
                daemonTraceHmac: ansiHmac(
                  namespace.evidenceKey,
                  "daemon-trace",
                  result.raw.origin.traceId,
                ),
                daemonProcessHmac: ansiHmac(
                  namespace.evidenceKey,
                  "daemon-process",
                  daemonDelivery.processId,
                ),
                daemonClockId: daemonDelivery.clockId,
              }),
            );
          }
          const deliveries = ansiReadJsonLines(namespace.tui.performanceTracePath).filter(
            ({ type }) => type === "performance.terminal-delivery",
          );
          const lastDelivery = deliveries.at(-1);
          event("ansi-sustained-workload", { cycleCount: 24 });
          const sustained = Object.freeze({
            resourceSamples: Object.freeze(resourceSamples),
            expectedResources: Object.freeze(expectedResources),
            workloadFinalities: Object.freeze(workloadFinalities),
            expectedWorkloadFinalities: Object.freeze(expectedWorkloadFinalities),
            latestFence,
            resourceCheckpointSamples: Object.freeze(resourceCheckpointSamples),
            expectedResourceCheckpoints: Object.freeze(expectedResourceCheckpoints),
            workload: Object.freeze({
              cycleCount: 24,
              conditioningCycleCount: 8,
              measuredCycleCount: 16,
              bytes: workloadFinalities.reduce((sum, sample) => sum + sample.payloadBytes, 0),
              maxQueueDepth: Math.max(0, ...deliveries.map(({ queuePeak }) => queuePeak ?? 0)),
              settledDeliveryQueueDepth: lastDelivery?.settledQueueDepth ?? null,
              representationCacheBytes: Math.max(
                0,
                ...resourceSamples.map(({ representationCacheBytes }) => representationCacheBytes),
              ),
              rawJournalBytes: Math.max(
                0,
                ...resourceSamples.map(({ rawJournalBytes }) => rawJournalBytes),
              ),
              eventLoopP99Ms:
                Math.max(
                  0,
                  ...resourceSamples.map(({ eventLoopDelayMicros }) => eventLoopDelayMicros),
                ) / 1_000,
              finalityCycleCount: workloadFinalities.length,
              markerCount: workloadFinalities.reduce((sum, sample) => sum + sample.markerCount, 0),
              stableTailMs: 40,
              finalityExact: workloadFinalities.every((sample) => sample.finalityExact),
              drainExact: workloadFinalities.every((sample) => sample.drainExact),
              faulted: workloadFinalities.some((sample) => sample.faulted),
              rebound: workloadFinalities.some((sample) => sample.rebound),
            }),
          });
          publishAnsiPartial({
            stage: "workload",
            workload: sustained.workload,
            workloadFinalities: sustained.workloadFinalities,
            resourceSamples: sustained.resourceSamples,
          });
          return sustained;
        },
        proveIdle: async (namespace, _daemon, _identity, _process, _baseline, sustained) => {
          const beforeRecords = ansiReadJsonLines(namespace.tui.performanceTracePath);
          const watermark = beforeRecords.length;
          const beforeCounters = beforeRecords
            .filter(({ type }) => type === "performance.terminal-cursor-presentation")
            .at(-1);
          const beforeFrame = await tuiCommandAsync(state, ["capture", "--ansi", "--json"], {
            timeout: 1_500,
            signal: ownerAbort.signal,
          });
          const startedAt = performance.now();
          await new Promise((resolveWait) => setTimeout(resolveWait, 10_100));
          const allAfter = ansiReadJsonLines(namespace.tui.performanceTracePath);
          const tail = allAfter.slice(watermark);
          const afterCounters = allAfter
            .filter(({ type }) => type === "performance.terminal-cursor-presentation")
            .at(-1);
          const countersEqual = (record, expected) =>
            record?.gridRowsReadTotal === expected?.gridRowsReadTotal &&
            record?.fullWalkTotal === expected?.fullWalkTotal &&
            record?.presentationCount === expected?.presentationCount;
          if (
            !ansiPresentationCounters ||
            !countersEqual(beforeCounters, ansiPresentationCounters) ||
            !countersEqual(afterCounters, ansiPresentationCounters)
          ) {
            const error = new Error("ANSI idle did not retain its qualified presentation counters");
            error.boundary = "ansi-idle-quiescent";
            error.observation = Object.freeze({
              operation: "ansi-idle-counter-continuity",
              beforeExact: countersEqual(beforeCounters, ansiPresentationCounters),
              afterExact: countersEqual(afterCounters, ansiPresentationCounters),
            });
            throw error;
          }
          const afterFrame = await tuiCommandAsync(state, ["capture", "--ansi", "--json"], {
            timeout: 1_500,
            signal: ownerAbort.signal,
          });
          const idleResourceSamples = allAfter.filter(
            (record) =>
              record?.type === "performance.terminal-resource-sample" &&
              record.operation === "idle" &&
              record.ordinal > ansiResourceOrdinal &&
              record.semanticPaneId === sustained.latestFence.semanticPaneId &&
              record.generation === sustained.latestFence.generation &&
              record.incarnation === sustained.latestFence.incarnation &&
              record.revision === sustained.latestFence.revision &&
              record.stateHash === sustained.latestFence.stateHash &&
              record.sourceEpoch === sustained.latestFence.sourceEpoch &&
              record.rendererEpoch === sustained.latestFence.rendererEpoch &&
              record.viewportCols === sustained.latestFence.viewportCols &&
              record.viewportRows === sustained.latestFence.viewportRows,
          );
          if (idleResourceSamples.length !== 1) {
            const observation = Object.freeze({
              operation: "ansi-idle-resource-cap",
              observedCount: Math.min(idleResourceSamples.length, 512),
              resourceSamplingFailureCount: null,
              ...boundedAnsiResourceFailureFacts({
                rssBytes: null,
                heapUsedBytes: null,
                eventLoopDelayMicros: null,
              }),
              ...boundedAnsiResourcePeakFailureFacts({
                rssPeakBytes: null,
                heapUsedPeakBytes: null,
                eventLoopDelayPeakMicros: null,
              }),
              resourceEpochArmed: null,
              resourceEpochIdentityHmac: null,
              resourceEpochIdentityExact: null,
              lowWaterFirstSampleOrdinal: null,
              lowWaterLastSampleOrdinal: null,
              lowWaterSampleCount: null,
              lowWaterWindowMicros: null,
              eventLoopDelayPeakSource: null,
              inputPending: null,
              inputInFlight: null,
              inputPendingBytes: null,
              inputPendingPeak: null,
              inputInFlightPeak: null,
              inputPendingBytesPeak: null,
              firstFailedPredicate: "resource-sample-cardinality",
            });
            publishAnsiPartial({ stage: "idle", workloadFailure: observation });
            const error = new Error("ANSI idle resource endpoint was not exact");
            error.boundary = "ansi-idle-quiescent";
            error.observation = observation;
            throw error;
          }
          const idleResource = idleResourceSamples[0];
          const idleEventLoopFailure = ansiEventLoopResourceCapStatus(idleResource);
          const idleRetained = assessAnsiIdleRetainedResourceSamples(
            idleResource.idleRetainedSamples,
            {
              fenceAtMicros: sustained.latestFence.atMicros,
              endpointAtMicros: idleResource.atMicros,
            },
          );
          ansiResourceOrdinal = idleResource.ordinal;
          if (
            idleResource.resourceEpochArmed !== true ||
            !ansiResourceEpochIdentityExact(
              idleResource.resourceEpochIdentity,
              ansiResourceEpochIdentity,
            ) ||
            idleResource.lowWaterFirstSampleOrdinal !== 1 ||
            idleResource.lowWaterLastSampleOrdinal !== 1 ||
            idleResource.lowWaterSampleCount !== 1 ||
            idleResource.lowWaterWindowMicros !== 0 ||
            !Number.isSafeInteger(idleResource.resourceSamplingFailureCount) ||
            idleResource.resourceSamplingFailureCount !== 0 ||
            !Number.isSafeInteger(idleResource.rssBytes) ||
            idleResource.rssBytes < 0 ||
            idleResource.rssBytes > ANSI_TUI_RSS_ABSOLUTE_CEILING_BYTES ||
            !Number.isSafeInteger(idleResource.rssPeakBytes) ||
            idleResource.rssPeakBytes < 0 ||
            idleResource.rssPeakBytes > ANSI_TUI_RSS_ABSOLUTE_CEILING_BYTES ||
            !Number.isSafeInteger(idleResource.heapUsedBytes) ||
            idleResource.heapUsedBytes < 0 ||
            idleResource.heapUsedBytes > ANSI_TUI_HEAP_ABSOLUTE_CEILING_BYTES ||
            !Number.isSafeInteger(idleResource.heapUsedPeakBytes) ||
            idleResource.heapUsedPeakBytes < 0 ||
            idleResource.heapUsedPeakBytes > ANSI_TUI_HEAP_ABSOLUTE_CEILING_BYTES ||
            idleEventLoopFailure !== null ||
            !new Set(["heartbeat", "endpoint"]).has(idleResource.eventLoopDelayPeakSource) ||
            idleResource.inputPending !== 0 ||
            idleResource.inputInFlight !== 0 ||
            idleResource.inputPendingBytes !== 0 ||
            idleResource.inputPendingPeak !== 0 ||
            idleResource.inputInFlightPeak !== 0 ||
            idleResource.inputPendingBytesPeak !== 0 ||
            !idleRetained.qualified
          ) {
            const firstFailedPredicate =
              idleResource.resourceEpochArmed !== true ||
              !ansiResourceEpochIdentityExact(
                idleResource.resourceEpochIdentity,
                ansiResourceEpochIdentity,
              )
                ? "resource-epoch-identity"
                : idleResource.lowWaterFirstSampleOrdinal !== 1 ||
                    idleResource.lowWaterLastSampleOrdinal !== 1 ||
                    idleResource.lowWaterSampleCount !== 1 ||
                    idleResource.lowWaterWindowMicros !== 0
                  ? "resource-low-water-window"
                  : !Number.isSafeInteger(idleResource.resourceSamplingFailureCount) ||
                      idleResource.resourceSamplingFailureCount !== 0
                    ? "resource-sampling-failure"
                    : !Number.isSafeInteger(idleResource.rssBytes) ||
                        idleResource.rssBytes < 0 ||
                        idleResource.rssBytes > ANSI_TUI_RSS_ABSOLUTE_CEILING_BYTES
                      ? "rss-current-cap"
                      : !Number.isSafeInteger(idleResource.rssPeakBytes) ||
                          idleResource.rssPeakBytes < 0 ||
                          idleResource.rssPeakBytes > ANSI_TUI_RSS_ABSOLUTE_CEILING_BYTES
                        ? "rss-absolute-cap"
                        : !Number.isSafeInteger(idleResource.heapUsedBytes) ||
                            idleResource.heapUsedBytes < 0 ||
                            idleResource.heapUsedBytes > ANSI_TUI_HEAP_ABSOLUTE_CEILING_BYTES
                          ? "heap-current-cap"
                          : !Number.isSafeInteger(idleResource.heapUsedPeakBytes) ||
                              idleResource.heapUsedPeakBytes < 0 ||
                              idleResource.heapUsedPeakBytes > ANSI_TUI_HEAP_ABSOLUTE_CEILING_BYTES
                            ? "heap-absolute-cap"
                            : idleEventLoopFailure !== null
                              ? idleEventLoopFailure
                              : !new Set(["heartbeat", "endpoint"]).has(
                                    idleResource.eventLoopDelayPeakSource,
                                  )
                                ? "event-loop-peak-source"
                                : idleResource.inputPending !== 0 ||
                                    idleResource.inputInFlight !== 0 ||
                                    idleResource.inputPendingBytes !== 0 ||
                                    idleResource.inputPendingPeak !== 0 ||
                                    idleResource.inputInFlightPeak !== 0 ||
                                    idleResource.inputPendingBytesPeak !== 0
                                  ? "input-not-settled"
                                  : idleRetained.firstInvalidPredicate;
            const observation = Object.freeze({
              operation: "ansi-idle-resource-cap",
              observedCount: 1,
              resourceSamplingFailureCount: Number.isSafeInteger(
                idleResource.resourceSamplingFailureCount,
              )
                ? Math.min(Math.max(idleResource.resourceSamplingFailureCount, 0), 512)
                : null,
              ...boundedAnsiResourceFailureFacts({
                rssBytes: idleResource.rssBytes,
                heapUsedBytes: idleResource.heapUsedBytes,
                eventLoopDelayMicros: idleResource.eventLoopDelayMicros,
              }),
              ...boundedAnsiResourcePeakFailureFacts({
                rssPeakBytes: idleResource.rssPeakBytes,
                heapUsedPeakBytes: idleResource.heapUsedPeakBytes,
                eventLoopDelayPeakMicros: idleResource.eventLoopDelayPeakMicros,
              }),
              resourceEpochArmed: idleResource.resourceEpochArmed === true,
              resourceEpochIdentityHmac:
                idleResource.resourceEpochArmed === true && idleResource.resourceEpochIdentity
                  ? ansiResourceEpochIdentityHmac(
                      namespace.evidenceKey,
                      idleResource.resourceEpochIdentity,
                    )
                  : null,
              resourceEpochIdentityExact: ansiResourceEpochIdentityExact(
                idleResource.resourceEpochIdentity,
                ansiResourceEpochIdentity,
              ),
              lowWaterFirstSampleOrdinal: Number.isSafeInteger(
                idleResource.lowWaterFirstSampleOrdinal,
              )
                ? Math.min(Math.max(idleResource.lowWaterFirstSampleOrdinal, 0), 16)
                : null,
              lowWaterLastSampleOrdinal: Number.isSafeInteger(
                idleResource.lowWaterLastSampleOrdinal,
              )
                ? Math.min(Math.max(idleResource.lowWaterLastSampleOrdinal, 0), 16)
                : null,
              lowWaterSampleCount: Number.isSafeInteger(idleResource.lowWaterSampleCount)
                ? Math.min(Math.max(idleResource.lowWaterSampleCount, 0), 16)
                : null,
              lowWaterWindowMicros: Number.isSafeInteger(idleResource.lowWaterWindowMicros)
                ? Math.min(Math.max(idleResource.lowWaterWindowMicros, 0), 2_000_000)
                : null,
              eventLoopDelayPeakSource: new Set(["heartbeat", "endpoint"]).has(
                idleResource.eventLoopDelayPeakSource,
              )
                ? idleResource.eventLoopDelayPeakSource
                : null,
              inputPending: Number.isSafeInteger(idleResource.inputPending)
                ? idleResource.inputPending
                : null,
              inputInFlight: Number.isSafeInteger(idleResource.inputInFlight)
                ? idleResource.inputInFlight
                : null,
              inputPendingBytes: Number.isSafeInteger(idleResource.inputPendingBytes)
                ? idleResource.inputPendingBytes
                : null,
              inputPendingPeak: Number.isSafeInteger(idleResource.inputPendingPeak)
                ? idleResource.inputPendingPeak
                : null,
              inputInFlightPeak: Number.isSafeInteger(idleResource.inputInFlightPeak)
                ? idleResource.inputInFlightPeak
                : null,
              inputPendingBytesPeak: Number.isSafeInteger(idleResource.inputPendingBytesPeak)
                ? idleResource.inputPendingBytesPeak
                : null,
              idleRetainedSampleCount: Math.min(Math.max(idleRetained.sampleCount ?? 0, 0), 8),
              idleRetainedFirstInvalidOrdinal: Number.isSafeInteger(
                idleRetained.firstInvalidOrdinal,
              )
                ? Math.min(Math.max(idleRetained.firstInvalidOrdinal, 1), 8)
                : null,
              idleRetainedFirstInvalidPredicate: new Set([
                "idle-retained-cardinality",
                "idle-retained-ordinal",
                "idle-retained-cadence",
                "idle-retained-window",
                "idle-retained-queue",
                "idle-retained-endpoint",
                "rss-slope",
                "heap-slope",
                "idle-retained-rss-growth",
                "idle-retained-heap-growth",
                "idle-retained-rss-high",
                "idle-retained-heap-high",
              ]).has(idleRetained.firstInvalidPredicate)
                ? idleRetained.firstInvalidPredicate
                : null,
              idleRetainedRssSlopeBytesPerSample: Number.isFinite(
                idleRetained.rssSlopeBytesPerSample,
              )
                ? Math.min(
                    Math.max(idleRetained.rssSlopeBytesPerSample, -1_073_741_825),
                    1_073_741_825,
                  )
                : null,
              idleRetainedHeapSlopeBytesPerSample: Number.isFinite(
                idleRetained.heapSlopeBytesPerSample,
              )
                ? Math.min(
                    Math.max(idleRetained.heapSlopeBytesPerSample, -536_870_913),
                    536_870_913,
                  )
                : null,
              idleRetainedRssGrowthBytes: Number.isSafeInteger(idleRetained.rssGrowthBytes)
                ? Math.min(Math.max(idleRetained.rssGrowthBytes, -1_073_741_825), 1_073_741_825)
                : null,
              idleRetainedHeapGrowthBytes: Number.isSafeInteger(idleRetained.heapGrowthBytes)
                ? Math.min(Math.max(idleRetained.heapGrowthBytes, -536_870_913), 536_870_913)
                : null,
              firstFailedPredicate,
            });
            publishAnsiPartial({ stage: "idle", workloadFailure: observation });
            const error = new Error("ANSI idle resource endpoint exceeded a hard cap");
            error.boundary = "ansi-idle-quiescent";
            error.observation = observation;
            throw error;
          }
          const idle = Object.freeze({
            durationMs: Math.floor(performance.now() - startedAt),
            frameCount: tail.filter(({ type }) => type === "performance.frame").length,
            paintCount: tail.filter(({ type }) => type === "performance.terminal-paint").length,
            gridRowsReadDelta:
              (afterCounters?.gridRowsReadTotal ?? -1) - (beforeCounters?.gridRowsReadTotal ?? -2),
            fullWalkDelta:
              (afterCounters?.fullWalkTotal ?? -1) - (beforeCounters?.fullWalkTotal ?? -2),
            presentationCountDelta:
              (afterCounters?.presentationCount ?? -1) - (beforeCounters?.presentationCount ?? -2),
            framebufferHmacBefore: ansiHmac(namespace.evidenceKey, "idle-frame", beforeFrame),
            framebufferHmacAfter: ansiHmac(namespace.evidenceKey, "idle-frame", afterFrame),
            queueDepth: sustained.workload.settledDeliveryQueueDepth,
            resourceExact: true,
            resourceSampleOrdinal: idleResource.ordinal,
            lowWaterFirstSampleOrdinal: idleResource.lowWaterFirstSampleOrdinal,
            lowWaterLastSampleOrdinal: idleResource.lowWaterLastSampleOrdinal,
            lowWaterSampleCount: idleResource.lowWaterSampleCount,
            lowWaterWindowMicros: idleResource.lowWaterWindowMicros,
            resourceProcessHmac: ansiHmac(namespace.evidenceKey, "process", idleResource.processId),
            resourceClockId: idleResource.clockId,
            resourceClockKind: idleResource.clockKind,
            resourceAtMicros: idleResource.atMicros,
            resourceIdentityHmac: ansiResourceIdentityHmac(namespace.evidenceKey, idleResource),
            resourceStateHmac: ansiHmac(namespace.evidenceKey, "state", idleResource.stateHash),
            resourceInputPending: idleResource.inputPending,
            resourceInputInFlight: idleResource.inputInFlight,
            resourceInputPendingBytes: idleResource.inputPendingBytes,
            resourceInputPendingPeak: idleResource.inputPendingPeak,
            resourceInputInFlightPeak: idleResource.inputInFlightPeak,
            resourceInputPendingBytesPeak: idleResource.inputPendingBytesPeak,
            resourceSamplingFailureCount: idleResource.resourceSamplingFailureCount,
            rssBytes: idleResource.rssBytes,
            heapUsedBytes: idleResource.heapUsedBytes,
            eventLoopDelayMicros: idleResource.eventLoopDelayMicros,
            rssPeakBytes: idleResource.rssPeakBytes,
            heapUsedPeakBytes: idleResource.heapUsedPeakBytes,
            eventLoopDelayPeakMicros: idleResource.eventLoopDelayPeakMicros,
            resourceEpochArmed: idleResource.resourceEpochArmed,
            resourceEpochIdentityHmac: ansiResourceEpochIdentityHmac(
              namespace.evidenceKey,
              idleResource.resourceEpochIdentity,
            ),
            eventLoopDelayPeakSource: idleResource.eventLoopDelayPeakSource,
            idleRetainedSampleCount: idleRetained.sampleCount,
            idleRetainedRssSlopeBytesPerSample: idleRetained.rssSlopeBytesPerSample,
            idleRetainedHeapSlopeBytesPerSample: idleRetained.heapSlopeBytesPerSample,
            idleRetainedRssGrowthBytes: idleRetained.rssGrowthBytes,
            idleRetainedHeapGrowthBytes: idleRetained.heapGrowthBytes,
            idleRetainedRssHighBytes: idleRetained.rssHighBytes,
            idleRetainedHeapHighBytes: idleRetained.heapHighBytes,
            idleRetainedFirstInvalidOrdinal: idleRetained.firstInvalidOrdinal,
            idleRetainedFirstInvalidPredicate: idleRetained.firstInvalidPredicate,
          });
          event("ansi-idle-quiescent", idle);
          publishAnsiPartial({ stage: "idle", idle });
          return idle;
        },
        startWeb: async (namespace, runningDaemon, identity, _process, baseline) => {
          devServer = await startDevServer(runningDaemon, {
            daemonInfoPath: join(fleet.daemonInfoDir, "daemon.json"),
          });
          const ansiPageUrl = productCapturePageUrlStatus(devServer.pageUrl);
          if (!ansiPageUrl.exact) {
            const error = new Error("ANSI Web server did not publish an exact local page");
            error.code = "PRODUCT_RIG_ANSI_PAGE_URL_INVALID";
            error.boundary = "ansi-web-correlation";
            error.observation = Object.freeze({
              operation: "ansi-web-page-url",
              code: error.code,
              reason: ansiPageUrl.reason,
            });
            throw error;
          }
          publish({ web: { pageUrl: ansiPageUrl.pageUrl, startedAfterAnsiBoundary: true } });
          browser = await chromium.launch({ headless: true });
          const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
          await context.addInitScript(() => {
            globalThis.__TMUX_IDE_ANSI_RENDITION_PROBE_ENABLED__ = true;
          });
          const page = await context.newPage();
          await page.goto(ansiPageUrl.pageUrl, { waitUntil: "domcontentloaded" });
          await page.locator(".app[data-shell-source='runtime']").waitFor({ timeout: 60_000 });
          await page
            .locator(".terminal-surface[data-phase='connected']")
            .first()
            .waitFor({ timeout: 60_000 });
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
            derivedResources: baseline.workspaceClient.derived.terminalInventory.resources,
            expectedWorkspaceName: identity.workspaceName,
            expectedSemanticPaneId: baseline.semanticPaneId,
            expectedDaemonGeneration: runningDaemon.record.instanceId,
          });
          // Publish and settle the final workspace-client diagnostic before the
          // per-stage frames. The restored stage's critical fence therefore
          // observes writer health after every Web/WC correlation publication.
          const workspaceClient = await waitForWindowWorkspaceEvidence(state, {
            processId: baseline.processId,
            daemonGeneration: baseline.daemonGeneration,
            clientGeneration: baseline.clientGeneration,
            clientId: baseline.clientId,
            workspaceName: baseline.workspaceName,
            sessionName: baseline.sessionName,
            afterMicros: 0,
            boundary: "ansi-web-correlation",
            resources: baseline.resources,
            web: true,
            exactTerminalResourceRevision: baseline.terminalResourceRevision,
          });
          ansiExpectedDeliverySurfaces = Object.freeze(["opentui", "web"]);
          const exactWebClients = workspaceClient.committed.authority.clients.filter(
            (client) => client?.surface === "web",
          );
          if (exactWebClients.length !== 1 || exactWebClients[0]?.clientId === baseline.clientId)
            throw new Error("ANSI Web delivery client authority was not exact");
          ansiExpectedDeliveryClients = Object.freeze({
            opentui: baseline.clientId,
            web: exactWebClients[0].clientId,
          });
          const presentations = [];
          const expectedPresentations = [];
          const webStageVector = [];
          let webFirstFailure = null;
          const boundedWebCandidate = (candidate, stableSamples, identityExact, localization) =>
            candidate
              ? Object.freeze({
                  stage: candidate.stage,
                  semanticPaneHmac: candidate.semanticPaneHmac,
                  generationHmac: candidate.generationHmac,
                  incarnationHmac: candidate.incarnationHmac,
                  stateHmac: candidate.stateHmac,
                  deliveryRequestHmac: candidate.deliveryRequestHmac,
                  rowsHmac: candidate.rowsHmac,
                  cursorHmac: candidate.cursorHmac,
                  domRowsHmac: candidate.domRowsHmac,
                  domCursorHmac: candidate.domCursorHmac,
                  domSemanticExact: candidate.domSemanticExact === true,
                  domRowCountExact: candidate.domRowCountExact === true,
                  domTextExact: candidate.domTextExact === true,
                  domStyleExact: candidate.domStyleExact === true,
                  domFirstMismatchRow:
                    Number.isSafeInteger(candidate.domFirstMismatchRow) &&
                    candidate.domFirstMismatchRow >= 0 &&
                    candidate.domFirstMismatchRow <= 4_095
                      ? candidate.domFirstMismatchRow
                      : null,
                  domFirstMismatchColumn:
                    Number.isSafeInteger(candidate.domFirstMismatchColumn) &&
                    candidate.domFirstMismatchColumn >= 0 &&
                    candidate.domFirstMismatchColumn <= 4_095
                      ? candidate.domFirstMismatchColumn
                      : null,
                  domFirstMismatchComponent: new Set([
                    "row-cardinality",
                    "row-text",
                    "cell-missing",
                    "foreground",
                    "background",
                    "bold",
                    "italic",
                    "underline",
                    "width",
                    "wrap",
                  ]).has(candidate.domFirstMismatchComponent)
                    ? candidate.domFirstMismatchComponent
                    : null,
                  domCursorExact: candidate.domCursorExact === true,
                  renditionHmac: candidate.renditionHmac,
                  positionWrappedHmac: candidate.positionWrappedHmac,
                  renditionCellCount: candidate.renditionCellCount,
                  wideContinuationCount: candidate.wideContinuationCount,
                  combiningCount: candidate.combiningCount,
                  styledCellCount: candidate.styledCellCount,
                  activeBuffer: candidate.activeBuffer,
                  cursorX: candidate.cursorX,
                  cursorY: candidate.cursorY,
                  cursorHidden: candidate.cursorHidden,
                  cursorStyle: candidate.cursorStyle,
                  cursorBlink: candidate.cursorBlink,
                  revision: candidate.revision,
                  sourceEpoch: candidate.sourceEpoch,
                  rendererEpoch: candidate.rendererEpoch,
                  rendererCols:
                    Number.isSafeInteger(candidate.rendererCols) &&
                    candidate.rendererCols >= 1 &&
                    candidate.rendererCols <= 4_096
                      ? candidate.rendererCols
                      : null,
                  rendererRows:
                    Number.isSafeInteger(candidate.rendererRows) &&
                    candidate.rendererRows >= 1 &&
                    candidate.rendererRows <= 4_096
                      ? candidate.rendererRows
                      : null,
                  cols: candidate.cols,
                  rows: candidate.rows,
                  gridRowsRead: candidate.gridRowsRead,
                  gridCellsRead: candidate.gridCellsRead,
                  fullGridWalks: candidate.fullGridWalks,
                  renditionFailure: identityExact ? null : localization,
                  stableSamples: Math.min(Math.max(stableSamples, 0), 2),
                  identityExact,
                })
              : null;
          const publishWebStage = (index, stage, status, candidate, reason = null) => {
            webStageVector[index] = Object.freeze({
              ordinal: index + 1,
              stage,
              status,
              reason,
              candidate,
            });
            publishAnsiPartial({
              stage: `web-${stage}`,
              webPresentations: Object.freeze([...presentations]),
              webStageVector: Object.freeze([...webStageVector]),
              webFailure: webFirstFailure,
            });
          };
          const qualifiedWebPresentation = (candidate, stableSamples) => {
            const presentation = { ...candidate, stableSamples };
            for (const key of [
              "rowsHmac",
              "cursorHmac",
              "graphemeWidthHmac",
              "colorHmac",
              "attributesHmac",
              "cellHmacs",
            ])
              delete presentation[key];
            return Object.freeze(presentation);
          };
          let lastDriven = null;
          let webRendererEpoch = null;
          let revision = ansiReadJsonLines(namespace.tui.performanceTracePath)
            .filter(
              ({ type, semanticPaneId }) =>
                type === "performance.terminal-canonical-mode" &&
                semanticPaneId === baseline.semanticPaneId,
            )
            .at(-1)?.revision;
          for (const [stageIndex, [stage, key, alternateScreen, gridWalked]] of [
            ["normal", "b", false, true],
            ["rich", "r", false, true],
            ["cursor-only", "c", false, false],
            ["alternate", "a", true, true],
            ["restored", "n", false, true],
          ].entries()) {
            if (stage === "alternate") {
              const normalized = await driveAnsiStage(namespace, "b", {
                stage: "normal",
                action: "pre-alternate-normal",
                afterRevision: revision,
                alternateScreen: false,
                gridWalked: true,
                gridRowsRead: 3,
                fullWalk: false,
              });
              revision = normalized.stage.revision;
            }
            const driven = await driveAnsiStage(namespace, key, {
              stage,
              action:
                stage === "normal"
                  ? "pre-alternate-normal"
                  : stage === "rich"
                    ? "rich-ansi"
                    : stage === "cursor-only"
                      ? "cursor-next"
                      : stage === "alternate"
                        ? "enter-alternate"
                        : "restore-normal",
              afterRevision: revision,
              alternateScreen,
              gridWalked,
              gridRowsRead:
                stage === "rich"
                  ? 3
                  : stage === "cursor-only"
                    ? 0
                    : baseline.rawIdentity.viewportRows,
              fullWalk: false,
            });
            lastDriven = driven;
            revision = driven.stage.revision;
            const fixedCursor = fixedAnsiCursor(stage, namespace.marker);
            const canonicalCursorStyle = fixedCursor.style === "line" ? "bar" : fixedCursor.style;
            const expectedRendition = ansiRenditionCells(stage, namespace.marker);
            if (!expectedRendition) throw new Error("ANSI Web rendition contract was unavailable");
            const renditionHmac = ansiHmac(
              namespace.evidenceKey,
              "web-rendition",
              JSON.stringify(expectedRendition),
            );
            const expectedRenditionComponents = Object.freeze({
              positionWrappedHmac: ansiHmac(
                namespace.evidenceKey,
                "web-rendition-position-wrapped",
                JSON.stringify(
                  expectedRendition.map(({ row, column, wrapped }) => ({ row, column, wrapped })),
                ),
              ),
              graphemeWidthHmac: ansiHmac(
                namespace.evidenceKey,
                "web-rendition-grapheme-width",
                JSON.stringify(expectedRendition.map(({ chars, width }) => ({ chars, width }))),
              ),
              colorHmac: ansiHmac(
                namespace.evidenceKey,
                "web-rendition-color",
                JSON.stringify(
                  expectedRendition.map(({ foreground, background }) => ({
                    foreground,
                    background,
                  })),
                ),
              ),
              attributesHmac: ansiHmac(
                namespace.evidenceKey,
                "web-rendition-attributes",
                JSON.stringify(
                  expectedRendition.map(({ bold, italic, underline }) => ({
                    bold,
                    italic,
                    underline,
                  })),
                ),
              ),
              cellHmacs: Object.freeze(
                expectedRendition.map((cell) =>
                  ansiHmac(namespace.evidenceKey, "web-rendition-cell", JSON.stringify(cell)),
                ),
              ),
            });
            if (
              driven.stage.alternateScreen !== alternateScreen ||
              driven.stage.cursor.x !== fixedCursor.x ||
              driven.stage.cursor.y !== fixedCursor.y ||
              driven.stage.cursor.hidden !== fixedCursor.hidden ||
              driven.stage.cursor.style !== fixedCursor.style ||
              driven.stage.cursor.blink !== fixedCursor.blink
            )
              throw new Error("ANSI driven stage did not match its fixed cursor contract");
            const expectedGrid = ansiWebExpectedGridProjection(stage, driven);
            if (!expectedGrid.exact) {
              const observation = Object.freeze({
                operation: "ansi-web-expected-projection",
                stage,
                code: "ANSI_WEB_EXPECTED_GRID_INVALID",
                reason: expectedGrid.reason,
                canonicalRows: expectedGrid.canonicalRows,
                canonicalCols: expectedGrid.canonicalCols,
                presentationRows: expectedGrid.presentationRows,
              });
              webFirstFailure ??= Object.freeze({
                ordinal: stageIndex + 1,
                stage,
                reason: "expected-grid-projection",
              });
              publishWebStage(stageIndex, stage, "failed", observation, "expected-grid-projection");
              const error = new Error("ANSI Web expected grid projection was invalid");
              error.code = "ANSI_WEB_EXPECTED_GRID_INVALID";
              error.observation = observation;
              throw error;
            }
            const webDeliveryRequestHmacs = Object.freeze(
              driven.raw.deliveryTopology.lanes
                .filter((lane) => lane.surface === "web" && lane.purpose === "terminal-surface")
                .map((lane) => ansiHmac(namespace.evidenceKey, "delivery-request", lane.requestId))
                .sort(),
            );
            if (
              webDeliveryRequestHmacs.length < 1 ||
              new Set(webDeliveryRequestHmacs).size !== webDeliveryRequestHmacs.length
            )
              throw new Error("ANSI Web terminal delivery lane authority was not exact");
            const expectedPresentation = Object.freeze({
              generationHmac: driven.stage.generationHmac,
              incarnationHmac: driven.stage.incarnationHmac,
              stateHmac: driven.stage.stateHmac,
              deliveryRequestHmacs: webDeliveryRequestHmacs,
              revision: driven.stage.revision,
              sourceEpoch: 1,
              activeBuffer: alternateScreen ? "alternate" : "normal",
              cursorX: fixedCursor.x,
              cursorY: fixedCursor.y,
              cursorHidden: fixedCursor.hidden,
              cursorStyle: canonicalCursorStyle,
              canonicalCursorStyle,
              cursorBlink: fixedCursor.blink,
              cols: driven.stage.canonicalCols,
              rows: driven.stage.canonicalRows,
              rendererCols: driven.stage.canonicalCols,
              rendererRows: driven.stage.canonicalRows,
              renditionHmac,
              positionWrappedHmac: expectedRenditionComponents.positionWrappedHmac,
              renditionCellCount: expectedRendition.length,
              wideContinuationCount: expectedRendition.filter(({ width }) => width === 0).length,
              combiningCount: expectedRendition.filter(({ chars }) => /\p{Mark}/u.test(chars))
                .length,
              styledCellCount: expectedRendition.filter(
                ({ foreground, background, bold, italic, underline }) =>
                  foreground !== "default" ||
                  background !== "default" ||
                  bold ||
                  italic ||
                  underline,
              ).length,
              gridRowsRead: expectedGrid.gridRowsRead,
              gridCellsRead: expectedGrid.gridCellsRead,
              fullGridWalks: expectedGrid.fullGridWalks,
            });
            const stageDeadline = performance.now() + 2_000;
            let captured;
            let previousProjection = null;
            let lastPublishedCandidate = null;
            let stableSamples = 0;
            for (;;) {
              if (ownerAbort.signal.aborted || !devServer.isRunning() || !browser.isConnected()) {
                webFirstFailure ??= Object.freeze({
                  ordinal: stageIndex + 1,
                  stage,
                  reason: "owner-lost",
                });
                publishWebStage(stageIndex, stage, "failed", null, "owner-lost");
                throw new Error("ANSI Web presentation wait lost its owner");
              }
              let candidate;
              try {
                candidate = await captureAnsiCursorWebPresentation(page, {
                  keyHex: namespace.evidenceKey.toString("hex"),
                  stage,
                  semanticPaneId: baseline.semanticPaneId,
                  expectedRendition,
                  expectedCursor: Object.freeze({
                    ...fixedCursor,
                    style: canonicalCursorStyle,
                  }),
                });
              } catch {
                webFirstFailure ??= Object.freeze({
                  ordinal: stageIndex + 1,
                  stage,
                  reason: "capture-failed",
                });
                publishWebStage(stageIndex, stage, "failed", null, "capture-failed");
                throw new Error("ANSI Web presentation capture failed");
              }
              const predicateVector = Object.freeze({
                generationExact: candidate?.generationHmac === expectedPresentation.generationHmac,
                incarnationExact:
                  candidate?.incarnationHmac === expectedPresentation.incarnationHmac,
                stateExact: candidate?.stateHmac === expectedPresentation.stateHmac,
                deliveryRequestExact: expectedPresentation.deliveryRequestHmacs.includes(
                  candidate?.deliveryRequestHmac,
                ),
                revisionExact: candidate?.revision === expectedPresentation.revision,
                sourceEpochExact: candidate?.sourceEpoch === 1,
                rendererEpochExact:
                  webRendererEpoch === null || candidate?.rendererEpoch === webRendererEpoch,
                rendererColsExact: candidate?.rendererCols === expectedPresentation.rendererCols,
                rendererRowsExact: candidate?.rendererRows === expectedPresentation.rendererRows,
                activeBufferExact: candidate?.activeBuffer === expectedPresentation.activeBuffer,
                canonicalBufferExact:
                  candidate?.canonicalBuffer === expectedPresentation.activeBuffer,
                canonicalCursorXExact: candidate?.canonicalCursorX === fixedCursor.x,
                canonicalCursorYExact: candidate?.canonicalCursorY === fixedCursor.y,
                canonicalCursorHiddenExact: candidate?.canonicalCursorHidden === fixedCursor.hidden,
                canonicalCursorStyleExact: candidate?.canonicalCursorStyle === canonicalCursorStyle,
                canonicalCursorBlinkExact: candidate?.canonicalCursorBlink === fixedCursor.blink,
                renditionHmacExact: candidate?.renditionHmac === renditionHmac,
                positionWrappedHmacExact:
                  candidate?.positionWrappedHmac ===
                  expectedRenditionComponents.positionWrappedHmac,
                domRowsHmacPresent: /^[0-9a-f]{64}$/u.test(candidate?.domRowsHmac ?? ""),
                domCursorHmacPresent: /^[0-9a-f]{64}$/u.test(candidate?.domCursorHmac ?? ""),
                domRowCountExact: candidate?.domRowCountExact === true,
                domTextExact: candidate?.domTextExact === true,
                domStyleExact: candidate?.domStyleExact === true,
                domSemanticExact: candidate?.domSemanticExact === true,
                domCursorExact: candidate?.domCursorExact === true,
                renditionCellCountExact: candidate?.renditionCellCount === expectedRendition.length,
                wideContinuationCountExact:
                  candidate?.wideContinuationCount ===
                  expectedRendition.filter(({ width }) => width === 0).length,
                combiningCountExact:
                  candidate?.combiningCount ===
                  expectedRendition.filter(({ chars }) => /\p{Mark}/u.test(chars)).length,
                styledCellCountExact:
                  candidate?.styledCellCount ===
                  expectedRendition.filter(
                    ({ foreground, background, bold, italic, underline }) =>
                      foreground !== "default" ||
                      background !== "default" ||
                      bold ||
                      italic ||
                      underline,
                  ).length,
                cursorXExact: candidate?.cursorX === fixedCursor.x,
                cursorYExact: candidate?.cursorY === fixedCursor.y,
                cursorHiddenExact: candidate?.cursorHidden === fixedCursor.hidden,
                cursorStyleExact: candidate?.cursorStyle === canonicalCursorStyle,
                cursorBlinkExact: candidate?.cursorBlink === fixedCursor.blink,
                cursorCountExact:
                  candidate?.cursorCount === (expectedPresentation.cursorHidden ? 0 : 1),
                gridRowsReadExact: candidate?.gridRowsRead === expectedPresentation.gridRowsRead,
                gridCellsReadExact: candidate?.gridCellsRead === expectedPresentation.gridCellsRead,
                fullGridWalksExact: candidate?.fullGridWalks === expectedPresentation.fullGridWalks,
              });
              const identityExact = Object.values(predicateVector).every((value) => value === true);
              const renditionLocalization = ansiRenditionFailureLocalization(candidate, {
                ...expectedRenditionComponents,
                rows: expectedRendition.map(({ row }) => row),
              });
              const serialized = identityExact
                ? JSON.stringify(qualifiedWebPresentation(candidate, undefined))
                : null;
              stableSamples =
                serialized && serialized === previousProjection
                  ? stableSamples + 1
                  : serialized
                    ? 1
                    : 0;
              previousProjection = serialized;
              const boundedCandidate = boundedWebCandidate(
                candidate,
                stableSamples,
                identityExact,
                renditionLocalization,
              );
              if (identityExact && stableSamples === 2) {
                captured = qualifiedWebPresentation(candidate, stableSamples);
                webRendererEpoch ??= candidate.rendererEpoch;
                publishWebStage(stageIndex, stage, "qualified", boundedCandidate);
                break;
              }
              const publishedCandidate = JSON.stringify(boundedCandidate);
              if (publishedCandidate !== lastPublishedCandidate) {
                publishWebStage(stageIndex, stage, "candidate", boundedCandidate);
                lastPublishedCandidate = publishedCandidate;
              }
              if (performance.now() >= stageDeadline) {
                const firstFailedPredicate =
                  Object.entries(predicateVector).find(([, exact]) => !exact)?.[0] ??
                  "candidate-missing";
                webFirstFailure ??= Object.freeze({
                  ordinal: stageIndex + 1,
                  stage,
                  reason: "deadline",
                });
                publishWebStage(stageIndex, stage, "failed", boundedCandidate, "deadline");
                const error = new Error("ANSI Web stage did not reach two exact stable samples");
                error.code = "ANSI_WEB_PRESENTATION_DEADLINE";
                error.observation = Object.freeze({
                  operation: "ansi-web-presentation",
                  stage,
                  ordinal: stageIndex + 1,
                  code: error.code,
                  firstFailedPredicate,
                  stableSamples: Math.min(Math.max(stableSamples, 0), 2),
                  candidate: boundedCandidate,
                  predicates: predicateVector,
                });
                throw error;
              }
              try {
                await page.evaluate(
                  () =>
                    new Promise((resolve) => globalThis.requestAnimationFrame(() => resolve(null))),
                );
              } catch {
                const reason =
                  ownerAbort.signal.aborted || !devServer.isRunning() || !browser.isConnected()
                    ? "owner-lost"
                    : "animation-frame-failed";
                webFirstFailure ??= Object.freeze({
                  ordinal: stageIndex + 1,
                  stage,
                  reason,
                });
                publishWebStage(stageIndex, stage, "failed", boundedCandidate, reason);
                throw new Error("ANSI Web presentation frame wait failed");
              }
            }
            presentations.push(captured);
            expectedPresentations.push(
              Object.freeze({
                ...expectedPresentation,
                rendererEpoch: webRendererEpoch,
              }),
            );
          }
          event("ansi-web-correlation", { stages: presentations.length });
          publishAnsiPartial({
            stage: "web",
            webPresentations: Object.freeze(presentations),
            webStageVector: Object.freeze(webStageVector),
            webFailure: null,
          });
          return Object.freeze({
            readiness: ready.assessment,
            stableExactSamples: ready.stableExactSamples,
            presentations: Object.freeze(presentations),
            expected: Object.freeze({
              semanticPaneHmac: ansiHmac(namespace.evidenceKey, "pane", baseline.semanticPaneId),
              presentations: Object.freeze(expectedPresentations),
            }),
            workspaceClient,
            finalStage: lastDriven,
          });
        },
      });
      const writerHealth = ansiBoot.web.finalStage?.writerHealth;
      const finalNative = await inspectAnsiNativeStage(
        ansiBoot.namespace,
        {
          resources: ansiBoot.baseline.resources,
          sessionName: ansiBoot.baseline.sessionName,
          windowResourceId: ansiBoot.baseline.windowResourceId,
          semanticPaneId: ansiBoot.baseline.semanticPaneId,
        },
        "final",
      );
      const finalTmux = finalNative.snapshot;
      const finalTmuxCapture = finalNative.capture;
      const journeyEvidence = Object.freeze({
        baseline: ansiBoot.baseline.stage,
        rich: ansiBoot.rich.stage,
        cursorSamples: ansiBoot.cursor.samples,
        preAlternate: ansiBoot.alternate.preAlternate.evidence,
        alternate: ansiBoot.alternate.stage,
        restored: ansiBoot.restored.stage,
        workload: ansiBoot.sustained.workload,
        workloadFinalities: ansiBoot.sustained.workloadFinalities,
        resourceSamples: ansiBoot.sustained.resourceSamples,
        resourceLifecycle: Object.freeze([
          Object.freeze({
            phase: "baseline",
            cycle: 0,
            sampleOrdinal: ansiBoot.baseline.baselineResourceSample.ordinal,
            operation: ansiBoot.baseline.baselineResourceSample.operation,
            resourceEpochArmed: ansiBoot.baseline.baselineResourceSample.resourceEpochArmed,
            lowWaterFirstSampleOrdinal:
              ansiBoot.baseline.baselineResourceSample.lowWaterFirstSampleOrdinal,
            lowWaterLastSampleOrdinal:
              ansiBoot.baseline.baselineResourceSample.lowWaterLastSampleOrdinal,
            lowWaterSampleCount: ansiBoot.baseline.baselineResourceSample.lowWaterSampleCount,
            lowWaterWindowMicros: ansiBoot.baseline.baselineResourceSample.lowWaterWindowMicros,
            resourceEpochIdentityHmac: ansiResourceEpochIdentityHmac(
              ansiBoot.namespace.evidenceKey,
              ansiBoot.baseline.baselineResourceSample.resourceEpochIdentity,
            ),
            identityHmac: ansiResourceIdentityHmac(
              ansiBoot.namespace.evidenceKey,
              ansiBoot.baseline.baselineResourceSample,
            ),
            stateHmac: ansiHmac(
              ansiBoot.namespace.evidenceKey,
              "state",
              ansiBoot.baseline.baselineResourceSample.stateHash,
            ),
            processHmac: ansiHmac(
              ansiBoot.namespace.evidenceKey,
              "process",
              ansiBoot.baseline.baselineResourceSample.processId,
            ),
            clockId: ansiBoot.baseline.baselineResourceSample.clockId,
            clockKind: ansiBoot.baseline.baselineResourceSample.clockKind,
            atMicros: ansiBoot.baseline.baselineResourceSample.atMicros,
            rssBytes: ansiBoot.baseline.baselineResourceSample.rssBytes,
            heapUsedBytes: ansiBoot.baseline.baselineResourceSample.heapUsedBytes,
            eventLoopDelayMicros: ansiBoot.baseline.baselineResourceSample.eventLoopDelayMicros,
            rssPeakBytes: ansiBoot.baseline.baselineResourceSample.rssPeakBytes,
            heapUsedPeakBytes: ansiBoot.baseline.baselineResourceSample.heapUsedPeakBytes,
            eventLoopDelayPeakMicros:
              ansiBoot.baseline.baselineResourceSample.eventLoopDelayPeakMicros,
            eventLoopDelayPeakSource:
              ansiBoot.baseline.baselineResourceSample.eventLoopDelayPeakSource,
            inputPending: ansiBoot.baseline.baselineResourceSample.inputPending,
            inputInFlight: ansiBoot.baseline.baselineResourceSample.inputInFlight,
            inputPendingBytes: ansiBoot.baseline.baselineResourceSample.inputPendingBytes,
            inputPendingPeak: ansiBoot.baseline.baselineResourceSample.inputPendingPeak,
            inputInFlightPeak: ansiBoot.baseline.baselineResourceSample.inputInFlightPeak,
            inputPendingBytesPeak: ansiBoot.baseline.baselineResourceSample.inputPendingBytesPeak,
            resourceSamplingFailureCount:
              ansiBoot.baseline.baselineResourceSample.resourceSamplingFailureCount,
          }),
          ...ansiBoot.sustained.resourceCheckpointSamples,
          Object.freeze({
            phase: "idle",
            cycle: 25,
            sampleOrdinal: ansiBoot.idle.resourceSampleOrdinal,
            operation: "idle",
            resourceEpochArmed: ansiBoot.idle.resourceEpochArmed,
            lowWaterFirstSampleOrdinal: ansiBoot.idle.lowWaterFirstSampleOrdinal,
            lowWaterLastSampleOrdinal: ansiBoot.idle.lowWaterLastSampleOrdinal,
            lowWaterSampleCount: ansiBoot.idle.lowWaterSampleCount,
            lowWaterWindowMicros: ansiBoot.idle.lowWaterWindowMicros,
            resourceEpochIdentityHmac: ansiBoot.idle.resourceEpochIdentityHmac,
            identityHmac: ansiBoot.idle.resourceIdentityHmac,
            stateHmac: ansiBoot.idle.resourceStateHmac,
            processHmac: ansiBoot.idle.resourceProcessHmac,
            clockId: ansiBoot.idle.resourceClockId,
            clockKind: ansiBoot.idle.resourceClockKind,
            atMicros: ansiBoot.idle.resourceAtMicros,
            rssBytes: ansiBoot.idle.rssBytes,
            heapUsedBytes: ansiBoot.idle.heapUsedBytes,
            eventLoopDelayMicros: ansiBoot.idle.eventLoopDelayMicros,
            rssPeakBytes: ansiBoot.idle.rssPeakBytes,
            heapUsedPeakBytes: ansiBoot.idle.heapUsedPeakBytes,
            eventLoopDelayPeakMicros: ansiBoot.idle.eventLoopDelayPeakMicros,
            eventLoopDelayPeakSource: ansiBoot.idle.eventLoopDelayPeakSource,
            inputPending: ansiBoot.idle.resourceInputPending,
            inputInFlight: ansiBoot.idle.resourceInputInFlight,
            inputPendingBytes: ansiBoot.idle.resourceInputPendingBytes,
            inputPendingPeak: ansiBoot.idle.resourceInputPendingPeak,
            inputInFlightPeak: ansiBoot.idle.resourceInputInFlightPeak,
            inputPendingBytesPeak: ansiBoot.idle.resourceInputPendingBytesPeak,
            resourceSamplingFailureCount: ansiBoot.idle.resourceSamplingFailureCount,
          }),
        ]),
        idle: ansiBoot.idle,
        web: Object.freeze({
          readiness: ansiBoot.web.readiness,
          stableExactSamples: ansiBoot.web.stableExactSamples,
          presentations: ansiBoot.web.presentations,
        }),
        tmux: Object.freeze({
          paneCount: finalTmux.length,
          geometryStable:
            ansiTmuxSemanticProjection(finalTmux) ===
            ansiTmuxSemanticProjection(ansiBoot.baseline.tmux),
          markerExact:
            (finalTmuxCapture.match(new RegExp(ansiBoot.namespace.marker, "gu")) ?? []).length ===
            1,
          baselineCaptureHmac: ansiBoot.baseline.tmuxCaptureHmac,
          alternateCaptureHmac: ansiBoot.alternate.tmux.captureHmac,
          alternateGeometryStable: ansiBoot.alternate.tmux.geometryStable,
          alternateMarkerAbsent: ansiBoot.alternate.tmux.markerAbsent,
          alternateCursorExact: ansiBoot.alternate.tmux.cursorExact,
          finalCaptureHmac: ansiHmac(
            ansiBoot.namespace.evidenceKey,
            "tmux-capture",
            finalTmuxCapture,
          ),
        }),
        writer: Object.freeze({
          droppedRecords: writerHealth?.droppedRecords ?? null,
          oversizedRecords: writerHealth?.oversizedRecords ?? null,
          failed: writerHealth?.failed ?? null,
          pendingCriticalRecords: writerHealth?.pendingCriticalRecords ?? null,
        }),
      });
      const expectedStage = (stage) =>
        Object.freeze({
          processHmac: stage.processHmac,
          clockId: stage.clockId,
          clockKind: stage.clockKind,
          paneHmac: stage.paneHmac,
          generationHmac: stage.generationHmac,
          incarnationHmac: stage.incarnationHmac,
          revision: stage.revision,
          stateHmac: stage.stateHmac,
          presentationHmac: stage.presentationHmac,
          canonicalCols: stage.canonicalCols,
          canonicalRows: stage.canonicalRows,
          viewportCols: stage.viewportCols,
          viewportRows: stage.viewportRows,
          sourceEpoch: stage.sourceEpoch,
          rendererEpoch: stage.rendererEpoch,
          alternateScreen: stage.alternateScreen,
          cursor: Object.freeze({ ...stage.cursor }),
          framebufferHmac: stage.framebufferHmac,
          framebufferCellCount: stage.framebufferCellCount,
          framebufferWideContinuationCount: stage.framebufferWideContinuationCount,
          framebufferCombiningCount: stage.framebufferCombiningCount,
          framebufferStyledCellCount: stage.framebufferStyledCellCount,
          gridRowsReadTotal: stage.gridRowsReadTotal,
          fullWalkTotal: stage.fullWalkTotal,
          presentationCount: stage.presentationCount,
        });
      const lastCursorExpected = ansiBoot.cursor.expectedSamples.at(-1);
      const expectedNormalFramebuffer = ansiFramebufferCells("normal", ansiBoot.namespace.marker);
      const preAlternateExpectedStage = Object.freeze({
        ...expectedStage(ansiBoot.baseline.stage),
        revision: lastCursorExpected.presentation.revision + 1,
        stateHmac: ansiBoot.baseline.stage.stateHmac,
        presentationHmac: ansiBoot.baseline.stage.presentationHmac,
        framebufferHmac: ansiHmac(
          ansiBoot.namespace.evidenceKey,
          "opentui-framebuffer",
          JSON.stringify(expectedNormalFramebuffer),
        ),
        framebufferCellCount: expectedNormalFramebuffer.length,
        framebufferWideContinuationCount: expectedNormalFramebuffer.filter(
          ({ width }) => width === 0,
        ).length,
        framebufferCombiningCount: expectedNormalFramebuffer.filter(({ chars }) =>
          /\p{Mark}/u.test(chars),
        ).length,
        framebufferStyledCellCount: expectedNormalFramebuffer.filter(
          ({ foreground, background, attributes }) =>
            foreground !== "default" || background !== "default" || attributes !== 0,
        ).length,
        gridRowsReadTotal: lastCursorExpected.presentation.gridRowsReadTotal + 3,
        fullWalkTotal: lastCursorExpected.presentation.fullWalkTotal,
        presentationCount: lastCursorExpected.presentation.presentationCount + 1,
        alternateScreen: false,
        cursor: Object.freeze({ ...fixedAnsiCursor("normal", ansiBoot.namespace.marker) }),
      });
      const expected = Object.freeze({
        baseline: expectedStage(ansiBoot.baseline.stage),
        rich: expectedStage(ansiBoot.rich.stage),
        cursorSamples: ansiBoot.cursor.expectedSamples,
        preAlternate: Object.freeze({
          stage: preAlternateExpectedStage,
          predecessorRevision: lastCursorExpected.presentation.revision,
          predecessorStateHmac: lastCursorExpected.presentation.stateHmac,
          presentationHmac: ansiBoot.baseline.stage.presentationHmac,
          framebufferHmac: preAlternateExpectedStage.framebufferHmac,
          nativeCaptureHmac: ansiBoot.baseline.tmuxCaptureHmac,
          cursor: Object.freeze({ ...fixedAnsiCursor("normal", ansiBoot.namespace.marker) }),
          beforeGridRowsReadTotal: lastCursorExpected.presentation.gridRowsReadTotal,
          afterGridRowsReadTotal: preAlternateExpectedStage.gridRowsReadTotal,
          beforeFullWalkTotal: lastCursorExpected.presentation.fullWalkTotal,
          afterFullWalkTotal: preAlternateExpectedStage.fullWalkTotal,
          beforePresentationCount: lastCursorExpected.presentation.presentationCount,
          afterPresentationCount: preAlternateExpectedStage.presentationCount,
          gridRowsReadDelta: 3,
          fullWalkDelta: 0,
          presentationCountDelta: 1,
          daemonProcessHmac: lastCursorExpected.daemonProcessHmac,
          daemonClockId: lastCursorExpected.daemonClockId,
        }),
        alternate: expectedStage(ansiBoot.alternate.stage),
        restored: expectedStage(ansiBoot.restored.stage),
        normalBeforeAlternateHmac: ansiBoot.baseline.stage.presentationHmac,
        workloadFinalities: ansiBoot.sustained.expectedWorkloadFinalities,
        resourceSamples: ansiBoot.sustained.expectedResources,
        resourceLifecycle: Object.freeze([
          Object.freeze({
            phase: "baseline",
            cycle: 0,
            operation: "post-fence",
            resourceEpochIdentityHmac: ansiResourceEpochIdentityHmac(
              ansiBoot.namespace.evidenceKey,
              ansiBoot.baseline.hostFrame,
            ),
            identityHmac: ansiResourceIdentityHmac(
              ansiBoot.namespace.evidenceKey,
              ansiBoot.baseline.hostFrame,
            ),
            stateHmac: ansiHmac(
              ansiBoot.namespace.evidenceKey,
              "state",
              ansiBoot.baseline.hostFrame.stateHash,
            ),
            processHmac: ansiBoot.baseline.stage.processHmac,
            clockId: ansiBoot.baseline.stage.clockId,
            lowWaterFirstSampleOrdinal: 1,
            lowWaterLastSampleOrdinal: 8,
            lowWaterSampleCount: 8,
          }),
          ...ansiBoot.sustained.expectedResourceCheckpoints,
          Object.freeze({
            phase: "idle",
            cycle: 25,
            operation: "idle",
            resourceEpochIdentityHmac: ansiResourceEpochIdentityHmac(
              ansiBoot.namespace.evidenceKey,
              ansiBoot.baseline.hostFrame,
            ),
            identityHmac: ansiResourceIdentityHmac(
              ansiBoot.namespace.evidenceKey,
              ansiBoot.sustained.latestFence,
            ),
            stateHmac: ansiHmac(
              ansiBoot.namespace.evidenceKey,
              "state",
              ansiBoot.sustained.latestFence.stateHash,
            ),
            processHmac: ansiBoot.baseline.stage.processHmac,
            clockId: ansiBoot.baseline.stage.clockId,
            lowWaterFirstSampleOrdinal: 1,
            lowWaterLastSampleOrdinal: 1,
            lowWaterSampleCount: 1,
          }),
        ]),
        web: ansiBoot.web.expected,
      });
      const assessment = assessAnsiCursorAltScreenEvidence(journeyEvidence, expected);
      if (!assessment.qualified) {
        publish({
          journeyEvidence: {
            ansiCursorAltScreen: journeyEvidence,
            ansiCursorAltScreenExpected: expected,
          },
        });
        const error = new Error("ANSI cursor/alternate-screen causal assessment failed");
        error.boundary = "ansi-causal-proof";
        const boundedNonnegative = (value, cap) =>
          Number.isFinite(value) && value >= 0 ? Math.min(value, cap) : null;
        const boundedSigned = (value, cap) =>
          Number.isFinite(value) ? Math.min(Math.max(value, -cap), cap) : null;
        const workloadFirstFailedPredicate =
          Object.entries(assessment.workloadPredicates).find(([, passed]) => !passed)?.[0] ?? null;
        error.observation = Object.freeze({
          operation: "ansi-cursor-alt-screen",
          firstFailedPredicate:
            Object.entries(assessment.predicates).find(([, passed]) => !passed)?.[0] ?? null,
          predicates: assessment.predicates,
          sampleCount: assessment.distribution.sampleCount,
          p95Micros: assessment.distribution.p95Micros,
          p99Micros: assessment.distribution.p99Micros,
          workloadFinalitySampleCount: assessment.workloadFinalities.sampleCount,
          workloadFirstInvalidOrdinal: assessment.workloadFinalities.firstInvalidOrdinal,
          workloadFirstFailedPredicate,
          workloadPredicates: assessment.workloadPredicates,
          workloadMetrics: Object.freeze({
            bytes: boundedNonnegative(journeyEvidence.workload?.bytes, 67_108_865),
            maxQueueDepth: boundedNonnegative(journeyEvidence.workload?.maxQueueDepth, 65),
            settledDeliveryQueueDepth: boundedNonnegative(
              journeyEvidence.workload?.settledDeliveryQueueDepth,
              65,
            ),
            representationCacheBytes: boundedNonnegative(
              journeyEvidence.workload?.representationCacheBytes,
              16_777_217,
            ),
            rawJournalBytes: boundedNonnegative(
              journeyEvidence.workload?.rawJournalBytes,
              4_194_305,
            ),
            eventLoopP99Ms: boundedNonnegative(journeyEvidence.workload?.eventLoopP99Ms, 34),
            rssSlopeBytesPerSample: boundedSigned(
              assessment.resources.rssSlopeBytesPerSample,
              67_108_865,
            ),
            heapSlopeBytesPerSample: boundedSigned(
              assessment.resources.heapSlopeBytesPerSample,
              33_554_433,
            ),
            rssGrowthBytes: boundedNonnegative(assessment.resources.rssGrowthBytes, 1_073_741_825),
            heapGrowthBytes: boundedNonnegative(assessment.resources.heapGrowthBytes, 536_870_913),
            rssPeakBytes: boundedNonnegative(assessment.resources.rssPeakBytes, 1_073_741_825),
            heapPeakBytes: boundedNonnegative(assessment.resources.heapPeakBytes, 536_870_913),
            resourceLifecycleExact: assessment.resourceLifecycle.qualified,
            resourceLifecycleSampleCount: Math.min(
              Math.max(assessment.resourceLifecycle.sampleCount ?? 0, 0),
              27,
            ),
          }),
          resourceSampleCount: assessment.resources.sampleCount,
          resourceFirstInvalidEndpointOrdinal: Number.isSafeInteger(
            assessment.resources.firstInvalidEndpointOrdinal,
          )
            ? Math.min(Math.max(assessment.resources.firstInvalidEndpointOrdinal, 1), 16)
            : null,
          resourceFirstInvalidPredicate: new Set([
            "endpoint-cardinality",
            "endpoint-shape-or-authority",
            "rss-growth",
            "heap-growth",
            "rss-absolute-cap",
            "heap-absolute-cap",
          ]).has(assessment.resources.firstInvalidPredicate)
            ? assessment.resources.firstInvalidPredicate
            : null,
          webStageCount: assessment.web.stageCount,
          webPredicates: Object.freeze({
            readinessExact: assessment.web.readinessExact === true,
            topologyExact: assessment.web.topologyExact === true,
            stageExact: assessment.web.stageExact === true,
            restorationExact: assessment.web.restorationExact === true,
          }),
          webRestorationPredicates: Object.freeze({
            normalRestoredDomRenditionExact:
              assessment.web.restorationPredicates?.normalRestoredDomRenditionExact === true,
            normalRestoredSemanticRenditionExact:
              assessment.web.restorationPredicates?.normalRestoredSemanticRenditionExact === true,
            normalRestoredCanonicalCursorExact:
              assessment.web.restorationPredicates?.normalRestoredCanonicalCursorExact === true,
            normalRestoredDomCursorExact:
              assessment.web.restorationPredicates?.normalRestoredDomCursorExact === true,
            normalBufferExact: assessment.web.restorationPredicates?.normalBufferExact === true,
            richDomDistinctFromNormalExact:
              assessment.web.restorationPredicates?.richDomDistinctFromNormalExact === true,
            richCursorDomRenditionExact:
              assessment.web.restorationPredicates?.richCursorDomRenditionExact === true,
            richCursorSemanticRenditionExact:
              assessment.web.restorationPredicates?.richCursorSemanticRenditionExact === true,
            cursorOnlyZeroGridExact:
              assessment.web.restorationPredicates?.cursorOnlyZeroGridExact === true,
            richCursorDistinctExact:
              assessment.web.restorationPredicates?.richCursorDistinctExact === true,
            alternateSemanticDistinct:
              assessment.web.restorationPredicates?.alternateSemanticDistinct === true,
            alternateBufferHiddenExact:
              assessment.web.restorationPredicates?.alternateBufferHiddenExact === true,
            rendererCanonicalDimensionsExact:
              assessment.web.restorationPredicates?.rendererCanonicalDimensionsExact === true,
          }),
          webFirstFailedRestorationPredicate: new Set([
            "normalRestoredDomRenditionExact",
            "normalRestoredSemanticRenditionExact",
            "normalRestoredCanonicalCursorExact",
            "normalRestoredDomCursorExact",
            "normalBufferExact",
            "richDomDistinctFromNormalExact",
            "richCursorDomRenditionExact",
            "richCursorSemanticRenditionExact",
            "cursorOnlyZeroGridExact",
            "richCursorDistinctExact",
            "alternateSemanticDistinct",
            "alternateBufferHiddenExact",
            "rendererCanonicalDimensionsExact",
          ]).has(assessment.web.firstFailedRestorationPredicate)
            ? assessment.web.firstFailedRestorationPredicate
            : null,
        });
        throw error;
      }
      publish({
        convergence: { workspaceClient: ansiBoot.web.workspaceClient },
        journeyEvidence: {
          ansiCursorAltScreen: journeyEvidence,
          ansiCursorAltScreenExpected: expected,
          ansiCursorAltScreenCorrelation: Object.freeze({
            fleetSessionId: ansiBoot.identity.fleetSessionId,
            catalogRevision: ansiBoot.identity.catalogRevision,
            semanticPaneId: ansiBoot.baseline.semanticPaneId,
          }),
        },
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
          const shell = await waitForProductApplicationShell(
            runningDaemon,
            namespace.session,
            (candidate) => productWindowResources(candidate).length === 2,
            10_000,
            2,
          );
          const resources = productWindowResources(shell);
          const publication = await provePreseededPanePublication(
            state,
            {
              marker: namespace.marker,
              paneId: namespace.seed.paneId,
              geometry: namespace.seed,
            },
            resources,
          );
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
          const delivery = await driveExactHostedInput(
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
          const down = await driveExactHostedInput(
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
            const delivery = await driveExactHostedInput(
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
          const delivery = await driveExactHostedInput(
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
          const conditionedPane = await conditionExactSinglePaneTmuxFixture(
            fleet.socketPath,
            session,
            initialPane.paneId,
          );
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
            geometry: conditionedPane,
          });
          return Object.freeze({
            session,
            seed: {
              marker,
              paneId: initialPane.paneId,
              geometry: Object.freeze({ ...initialPane, ...conditionedPane }),
            },
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
          const shell = await waitForProductApplicationShell(
            runningDaemon,
            namespace.session,
            (candidate) => productWindowResources(candidate).length === 1,
            10_000,
            1,
          );
          const shellResources = productWindowResources(shell);
          const publication = await provePreseededPanePublication(
            state,
            namespace.seed,
            shellResources,
          );
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
          const shell = await waitForProductApplicationShell(
            runningDaemon,
            namespace.session,
            (candidate) => productWindowResources(candidate).length === 1,
            10_000,
            1,
          );
          const publication = await provePreseededPanePublication(
            state,
            namespace.seed,
            productWindowResources(shell),
          );
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
          const shell = await waitForProductApplicationShell(
            runningDaemon,
            namespace.session,
            (candidate) => productWindowResources(candidate).length === 1,
            10_000,
            1,
          );
          const publication = await provePreseededPanePublication(
            state,
            namespace.seed,
            productWindowResources(shell),
          );
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
            const shell = await waitForProductApplicationShell(
              daemon,
              namespace.session,
              (candidate) => productWindowResources(candidate).length === 1,
              10_000,
              1,
            );
            const publication = await provePreseededPanePublication(
              state,
              namespace.seed,
              productWindowResources(shell),
            );
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
    const intendedTui = {
      hostSession: `_tmux-ide-product-rig-${slug}`,
      runtimeDir: join(rigRoot, "tui"),
      performanceTracePath: join(rigRoot, "tui", "performance-trace.jsonl"),
      daemonPerformanceTracePath: collectDaemonCausalTrace ? daemonPerformanceTracePath : null,
      ...(card5Journey
        ? {
            hostFocusControlRoot: fleet.root,
            hostFocusControlPath: join(fleet.root, "hf.sock"),
            hostFocusLifecyclePath: join(rigRoot, "tui", "performance.jsonl"),
          }
        : {}),
    };
    let tui;
    if (card5Journey) {
      tui = prepareOwnedTuiRuntime({
        ownership: { session, runtimeNamespace },
        intendedTui,
        ownedTuiRuntimeDirs: state.ownedTuiRuntimeDirs ?? [],
        publish,
        resolveProvenance: sourceTraceProvenance,
        createRuntimeDir: createIsolatedTargetedTuiCwd,
      });
    } else {
      const traceProvenance = sourceTraceProvenance();
      tui = {
        ...intendedTui,
        performanceTraceCommit: traceProvenance.commit,
        performanceTraceTree: traceProvenance.tree,
      };
      publish({ session, runtimeNamespace, tui });
    }
    if (card5Journey) {
      // Publish the private correlation key to this process-local map before
      // either production Web host can fail readiness. It never enters state
      // or artifacts; failure sealing uses it only to HMAC daemon request ids.
      productInputFingerprintKeys.set(tui.runtimeDir, card5InputFingerprintKey);
    }
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
    let page;
    if (card5Journey) {
      card5WebHostLease = createCard5ProductionWebHostLease({
        chromium,
        electron,
        pageUrl: devServer.pageUrl,
        runtimeRoot: fleet.root,
        electronUserData: join(fleet.root, "electron-user-data"),
        daemonInfoPath: join(fleet.daemonInfoDir, "daemon.json"),
        daemonInfoDir: fleet.daemonInfoDir,
        registryDir: fleet.environment.TMUX_IDE_REGISTRY_DIR,
        settingsDir: fleet.environment.TMUX_IDE_SETTINGS_DIR,
        cleanupToken,
        evidenceKey: card5InputFingerprintKey,
        electronEntry: join(repoRoot, "apps", "electron-shell", "dist", "main.cjs"),
        repoRoot,
        environment: { ...process.env, ...fleet.environment },
        signal: ownerAbort.signal,
      });
      card5WebHosts = await card5WebHostLease.ready;
      page = card5WebHosts.chromiumPage;
    } else {
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      page = await context.newPage();
    }
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
      const response = card5Journey
        ? null
        : await page.goto(devServer.pageUrl, { waitUntil: "domcontentloaded" });
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
    if (card5Journey) prepareIsolatedTargetedTuiCwd(state.tui.runtimeDir);
    const launchedTui = JSON.parse(
      tuiCommand(state, ["start", "--target", session, "--cols", "160", "--rows", "44", "--json"]),
    );
    if (!exactProductTuiLaunchReceipt(launchedTui, { target: session, cols: 160, rows: 44 }))
      throw new Error("Card5 OpenTUI launch receipt was invalid");
    if (card5Journey) card5TuiProcessPid = launchedTui.processId;
    tuiCommand(state, ["key", "F2"]);
    let tuiStatus = await waitForCoherentTui(state, 30_000, launchedTui.processId);
    if (card5Journey) {
      if (tuiStatus.processId !== card5TuiProcessPid)
        throw new Error("Card5 OpenTUI process identity changed before coherent readiness");
    }
    const initialHostPublication = await proveHostTerminalPublication(state, "boot");
    tuiStatus = JSON.parse(tuiCommand(state, ["status", "--json"]));
    const readiness = coherentReadiness({
      chromeMs: tuiStatus.readiness.appChromeFrameMs,
      terminalMs: initialHostPublication.elapsedMs,
    });
    publish({ tui: { ...tui, readiness } });
    event("tui-coherent-terminal-frame", readiness);
    if (card5Journey) {
      const evidenceKey = card5InputFingerprintKey;
      if (!state.tui.daemonPerformanceTracePath) {
        throw new Error("Card5 requires the detailed daemon delivery trace");
      }
      card5TuiEvidence = createCard5TuiEvidenceStream(
        state.tui.performanceTracePath,
        state.tui.daemonPerformanceTracePath,
        state.tui.hostFocusLifecyclePath,
      );
      let predecessorDescriptors = null;
      const observeInitialWeb = async () =>
        Promise.all([
          observeCard5WebCanonical(
            card5WebHosts.chromiumPage,
            evidenceKey,
            card5WebHosts.chromiumProcessIdentity,
          ),
          observeCard5WebCanonical(
            card5WebHosts.electronPage,
            evidenceKey,
            card5WebHosts.electronProcessIdentity,
          ),
        ]);
      const initialWebIdentity = await observeCard5WithinDeadline(observeInitialWeb, {
        deadline: performance.now() + 5_000,
      });
      const initialPaneId =
        initialWebIdentity.status === "ok"
          ? exactSharedCard5WebPane(initialWebIdentity.value)
          : null;
      const tuiIdentity =
        initialPaneId === null ? null : latestCard5TuiCanonical(card5TuiEvidence, initialPaneId);
      if (!tuiIdentity) throw new Error("Card5 OpenTUI lifecycle identity was unavailable");
      let acceptedConvergencePaneId = null;
      card5TuiEvidence.drain();
      const hostEvidence = Object.freeze({
        lifecycle: await waitForCard5ObservedHostLifecycle({
          reader: card5TuiEvidence.daemonReader,
          observeWeb: observeInitialWeb,
          failureIdentity: {
            stage: "initial-host-lifecycle",
            generation: tuiIdentity.generation,
            pane: tuiIdentity.semanticPaneId,
            evidenceKey,
          },
          assess: (daemonRecords, web) =>
            assessCard5ObservedHostLifecycle({
              stage: "initial-host-lifecycle",
              generation: tuiIdentity.generation,
              pane: tuiIdentity.semanticPaneId,
              tuiProcessId: tuiIdentity.processId,
              web,
              daemonRecords,
              evidenceKey,
            }),
        }),
      });
      let restartEvidence = null;
      let restartTuiMark = null;
      let restartStartedAt = null;
      const replaceDaemon = async (before) => {
        if (before?.generation !== tuiIdentity.generation) {
          throw new Error("Card5 predecessor generation changed before the replacement boundary");
        }
        predecessorDescriptors = await Promise.all([
          issueCard5PredecessorDescriptor(card5WebHosts.chromiumPage, {
            workspaceName: workspace,
            generation: before.generation,
            semanticPaneId: tuiIdentity.semanticPaneId,
          }),
          issueCard5PredecessorDescriptor(card5WebHosts.electronPage, {
            workspaceName: workspace,
            generation: before.generation,
            semanticPaneId: tuiIdentity.semanticPaneId,
          }),
        ]);
        if (predecessorDescriptors.some((descriptor) => descriptor === null)) {
          throw new Error(
            "Card5 could not issue predecessor descriptors through both host brokers",
          );
        }
        card5TuiEvidence.drain();
        restartTuiMark = card5TuiEvidence.reader.mark();
        const previousDaemonGeneration = daemon.record.instanceId;
        const startedAt = Date.now();
        restartStartedAt = startedAt;
        await daemon.stop();
        publish({ daemonLifecycle: "starting" });
        daemon = await startDaemon(fleet);
        publish({ daemonLifecycle: "started", daemon: daemon.record });
        const replacementWorkspace = await daemon.promote(session);
        await waitForReadinessLadder(daemon);
        publish({ daemon: daemon.record, workspace: replacementWorkspace });
        restartEvidence = Object.freeze({
          previousDaemonGeneration,
          daemonGeneration: daemon.record.instanceId,
          previousCanonicalGeneration: before.generation,
          elapsedMs: Date.now() - startedAt,
        });
        return restartEvidence;
      };
      const waitAfterReplacement = async (before) => {
        if (!Array.isArray(predecessorDescriptors) || predecessorDescriptors.length !== 2) {
          throw new Error(
            "Card5 predecessor descriptors were not issued at the replacement boundary",
          );
        }
        const after = await waitForCard5ProductionClientConvergence(
          state,
          card5WebHosts,
          evidenceKey,
          card5TuiEvidence,
          5_000,
          {
            expectedPane: acceptedConvergencePaneId,
            onStablePane: (semanticPaneId) => {
              acceptedConvergencePaneId = semanticPaneId;
            },
          },
        );
        let raw = null;
        const observeReplacementWeb = async () =>
          Promise.all([
            observeCard5WebCanonical(
              card5WebHosts.chromiumPage,
              evidenceKey,
              card5WebHosts.chromiumProcessIdentity,
            ),
            observeCard5WebCanonical(
              card5WebHosts.electronPage,
              evidenceKey,
              card5WebHosts.electronProcessIdentity,
            ),
          ]);
        card5TuiEvidence.drain();
        const replacementTuiIdentity = latestCard5TuiCanonical(
          card5TuiEvidence,
          acceptedConvergencePaneId,
        );
        if (!replacementTuiIdentity) {
          throw new Error("Card5 replacement OpenTUI identity was unavailable");
        }
        publish({
          card5ArtifactIdentity: await card5ArtifactIdentity(
            daemon,
            state.session,
            replacementTuiIdentity.semanticPaneId,
          ),
        });
        const replacementGeometryProof = await proveCard5PassiveGeometry(
          state,
          { ...card5WebHosts, tuiEvidence: card5TuiEvidence },
          evidenceKey,
          { activeChallenge: false, semanticPaneId: acceptedConvergencePaneId },
        );
        const replacementLifecycle = await waitForCard5ObservedHostLifecycle({
          reader: card5TuiEvidence.daemonReader,
          observeWeb: observeReplacementWeb,
          onStableWeb: (web) => {
            raw = web;
          },
          failureIdentity: {
            stage: "replacement-host-lifecycle",
            generation: after.generation,
            pane: replacementTuiIdentity.semanticPaneId,
            evidenceKey,
          },
          assess: (daemonRecords, web) =>
            assessCard5ObservedHostLifecycle({
              stage: "replacement-host-lifecycle",
              generation: after.generation,
              pane: replacementTuiIdentity.semanticPaneId,
              tuiProcessId: replacementTuiIdentity.processId,
              web,
              daemonRecords,
              evidenceKey,
            }),
        });
        const tuiReplacementRecords = restartTuiMark
          ? card5TuiEvidence.reader.recordsSince(restartTuiMark)
          : [];
        const tuiEvents = tuiReplacementRecords
          .filter(
            ({ type }) =>
              type === "performance.terminal-canonical-publication" ||
              type === "performance.terminal-canonical-update",
          )
          .map((record, acceptedOrdinal) => ({
            type: record.updateType === "terminal.seed" ? "terminal.seed" : "terminal.patch",
            generation: record.generation,
            acceptedOrdinal,
          }));
        const tuiBoundary = {
          predecessorGeneration: before.generation,
          replacementGeneration: after.generation,
          acceptedOrdinal: 0,
        };
        const staleResults = await Promise.all([
          rejectCard5PredecessorDescriptor(card5WebHosts.chromiumPage, predecessorDescriptors[0]),
          rejectCard5PredecessorDescriptor(card5WebHosts.electronPage, predecessorDescriptors[1]),
        ]);
        const replacement = assessCard5ReplacementEnvelopeEvidence({
          predecessorGeneration: before.generation,
          replacementGeneration: after.generation,
          staleRedemptions: staleResults,
          lanes: raw
            .map((entry) => ({
              events: entry?.envelopes ?? [],
              replacementBoundary: entry?.runtimeReplacement?.replacementBoundary ?? null,
              predecessorAcceptedAfterReplacement:
                entry?.runtimeReplacement?.predecessorAcceptedAfterReplacement ?? null,
              socketEvents: entry?.runtimeReplacement?.socketEvents ?? null,
            }))
            .concat({
              events: tuiEvents,
              replacementBoundary: tuiBoundary,
              predecessorAcceptedAfterReplacement: tuiEvents.filter(
                ({ generation, acceptedOrdinal }) =>
                  generation === before.generation &&
                  acceptedOrdinal >= tuiBoundary.acceptedOrdinal,
              ).length,
            }),
        });
        if (!replacement.passed) {
          throw new Error("Card5 replacement was not seed-first or accepted stale G1 output");
        }
        if (staleResults.some(({ rejected, typed }) => rejected !== true || typed !== true)) {
          throw new Error("Card5 predecessor descriptor remained redeemable after replacement");
        }
        const predecessorSocketOutcomes = raw.map((entry) => ({
          outcome: entry?.runtimeReplacement?.socketEvents?.some(
            ({ generation, outcome, ordinal }) =>
              generation === before.generation &&
              outcome === "closed" &&
              ordinal >=
                (entry?.runtimeReplacement?.replacementBoundary?.socketOrdinal ?? Infinity),
          )
            ? "predecessor-closed"
            : "predecessor-open",
        }));
        const authorityClients = raw[0]?.workspaceEvidence?.authority?.clients ?? [];
        const physicalClientIds = authorityClients.map(({ clientId }) => clientId);
        const replacementAuthority = raw[0]?.workspaceEvidence?.authority ?? null;
        const replacementAuthorityPeer = raw[1]?.workspaceEvidence?.authority ?? null;
        const replacementDaemonRecords = card5TuiEvidence.daemonReader.read();
        const replacementOpens = replacementDaemonRecords.filter(
          (record) =>
            record?.operation === "terminal-delivery-subscriber-lifecycle" &&
            record.terminalDelivery?.deliveryLifecycleEvent === "open" &&
            record.terminalDelivery?.canonicalGeneration === after.generation &&
            record.terminalDelivery?.semanticPaneId === replacementTuiIdentity.semanticPaneId,
        );
        const replacementRequest = (observed) => {
          const current = observed?.runtimeReplacement?.currentLifecycleRequest;
          return current?.status === "exact" && /^[0-9a-f]{64}$/u.test(current.requestHmac ?? "")
            ? current
            : null;
        };
        const replacementClientId = (surface, request) =>
          replacementOpens.find(
            ({ terminalDelivery }) =>
              terminalDelivery.deliverySurface === surface &&
              (surface === "opentui" ||
                (request !== null &&
                  card5EvidenceHmac("request", terminalDelivery.deliveryRequestId, evidenceKey) ===
                    request.requestHmac)),
          )?.terminalDelivery?.deliveryClientId ?? null;
        const replacementGeometryClients = [
          {
            client: "opentui",
            clientId: replacementClientId("opentui", null),
            observed: replacementTuiIdentity,
            passive: null,
            geometryOwner: null,
          },
          {
            client: "web-a",
            clientId: replacementClientId("web", replacementRequest(raw[0])),
            observed: raw[0],
            passive: raw[0]?.passive,
            geometryOwner: raw[0]?.geometryOwner,
          },
          {
            client: "web-b",
            clientId: replacementClientId("web", replacementRequest(raw[1])),
            observed: raw[1],
            passive: raw[1]?.passive,
            geometryOwner: raw[1]?.geometryOwner,
          },
        ];
        const replacementGeometry = Object.freeze({
          authorityEqual:
            replacementAuthority !== null &&
            JSON.stringify(replacementAuthority) === JSON.stringify(replacementAuthorityPeer),
          physicalClientCount: physicalClientIds.length,
          uniquePhysicalClientCount: new Set(physicalClientIds).size,
          authorityRevision: replacementAuthority?.revision ?? null,
          topologyHmac: replacementGeometryProof.samples[0]?.topologyHmac ?? null,
          samples: replacementGeometryProof.samples,
          clients: Object.freeze(
            replacementGeometryClients.map((entry) => {
              const ownsGeometry = replacementAuthority?.owners?.geometry === entry.clientId;
              return Object.freeze({
                client: entry.client,
                clientHmac: entry.clientId
                  ? card5EvidenceHmac("geometry-client", entry.clientId, evidenceKey)
                  : null,
                geometryOwner: ownsGeometry,
                passive: !ownsGeometry,
                observedGeometryOwner: entry.geometryOwner,
                observedPassive: entry.passive,
                cols: entry.observed?.cols ?? null,
                rows: entry.observed?.rows ?? null,
              });
            }),
          ),
        });
        const replacementSocketOutcomes = [
          {
            outcome:
              after.clients.opentui?.connected === true
                ? "replacement-open"
                : "replacement-missing",
          },
          ...raw.map((entry) => ({
            outcome: entry?.runtimeReplacement?.socketEvents?.some(
              ({ generation, outcome, ordinal }) =>
                generation === after.generation &&
                outcome === "open" &&
                ordinal <=
                  (entry?.runtimeReplacement?.replacementBoundary?.socketOrdinal ?? Infinity),
            )
              ? "replacement-open"
              : "replacement-missing",
          })),
        ];
        return Object.freeze({
          ...after,
          ...replacement,
          replacementLifecycle,
          staleResults,
          staleSocketRejected: predecessorSocketOutcomes.every(
            ({ outcome }) => outcome === "predecessor-closed",
          ),
          socketOutcomes: Object.freeze([
            ...predecessorSocketOutcomes,
            ...replacementSocketOutcomes,
          ]),
          reconnectedHosts: Object.values(after.clients).filter(
            ({ connected }) => connected === true,
          ).length,
          physicalClientCount: physicalClientIds.length,
          duplicatePhysicalClients: physicalClientIds.length - new Set(physicalClientIds).size,
          replacementGeometry,
          geometryFightCount:
            replacementGeometry.clients.filter(({ geometryOwner }) => geometryOwner).length === 1
              ? 0
              : 1,
          recoveryElapsedMs:
            restartStartedAt === null ? Number.POSITIVE_INFINITY : Date.now() - restartStartedAt,
        });
      };
      if (journeyId === "cross-client-handoff") {
        const proof = await runCrossClientHandoffOwnerBoot({
          onBoundary: (boundary) => {
            publish({ currentJourneyBoundary: boundary });
            event(boundary);
          },
          createProductionHosts: async () => hostEvidence,
          waitInitialConvergence: async () =>
            waitForCard5ProductionClientConvergence(
              state,
              card5WebHosts,
              evidenceKey,
              card5TuiEvidence,
              5_000,
              {
                expectedPane: initialPaneId,
                onStablePane: (semanticPaneId) => {
                  acceptedConvergencePaneId = semanticPaneId;
                },
              },
            ),
          driveAuthorityHandoff: async (_namespace, initial) =>
            driveCard5AuthorityHandoff(state, daemon, {
              ...card5WebHosts,
              evidenceKey,
              tuiEvidence: card5TuiEvidence,
              hostIdentity: launchedTui.hostIdentity,
              expectedPane: acceptedConvergencePaneId,
              focusedPaneEvidence: initial.focusedPaneEvidence,
              webPhysicalLifecycleEvidence: initial.webPhysicalLifecycleEvidence,
              inputFingerprintKey: card5InputFingerprintKey,
              recordNativeMarker: (marker) => {
                card5NativeExpectedMarker = marker;
              },
            }),
          provePassiveGeometry: async () =>
            proveCard5PassiveGeometry(
              state,
              { ...card5WebHosts, tuiEvidence: card5TuiEvidence },
              evidenceKey,
              { semanticPaneId: acceptedConvergencePaneId },
            ),
          proveSlowWebIsolation: async () =>
            proveCard5SlowWebIsolation(
              state,
              { ...card5WebHosts, inputFingerprintKey: card5InputFingerprintKey },
              evidenceKey,
              card5TuiEvidence,
              acceptedConvergencePaneId,
            ),
          restartDaemon: async (_namespace, initial) => replaceDaemon(initial),
          waitRestartConvergence: async (_namespace, initial) => waitAfterReplacement(initial),
          proveNativeObserver: async () =>
            proveCard5NativeObserver(
              state,
              evidenceKey,
              acceptedConvergencePaneId,
              card5NativeExpectedMarker,
            ),
          sealCorrelation: async (
            namespace,
            initial,
            handoff,
            geometry,
            slowWeb,
            restart,
            after,
            nativeObserver,
          ) =>
            sealCrossClientCorrelation(
              { namespace, initial, handoff, geometry, slowWeb, restart, after, nativeObserver },
              evidenceKey,
            ),
        });
        const journeyEvidence = Object.freeze({
          hosts: proof.namespace,
          generations: {
            before: proof.initial.generation,
            after: proof.after.generation,
          },
          before: {
            clients: proof.initial.clients,
            focusedPaneEvidence: proof.initial.focusedPaneEvidence,
          },
          after: { clients: proof.after.clients },
          handoff: proof.handoff,
          geometry: proof.geometry,
          slowWeb: proof.slowWeb,
          restart: {
            staleGenerationRejected: proof.after.predecessorEnvelopeAcceptedAfterReplace === false,
            staleRedemptions: Object.freeze(
              proof.after.staleResults.map(({ rejected, typed, reason }) =>
                Object.freeze({ rejected, typed, reason }),
              ),
            ),
            elapsedMs: proof.after.recoveryElapsedMs,
            replacementLifecycle: proof.after.replacementLifecycle,
          },
          nativeObserver: proof.nativeObserver,
          privacy: proof.correlation.privacy,
          correlation: proof.correlation.correlation,
        });
        publish({ journeyEvidence: { crossClientHandoff: journeyEvidence } });
      } else {
        let before = null;
        let after = null;
        const proof = await runDaemonRestartOwnerBoot({
          onBoundary: (boundary) => {
            publish({ currentJourneyBoundary: boundary });
            event(boundary);
          },
          createProductionHosts: async () => hostEvidence,
          waitBeforeConvergence: async () =>
            (before = await waitForCard5ProductionClientConvergence(
              state,
              card5WebHosts,
              evidenceKey,
              card5TuiEvidence,
              5_000,
              {
                expectedPane: initialPaneId,
                onStablePane: (semanticPaneId) => {
                  acceptedConvergencePaneId = semanticPaneId;
                },
              },
            )),
          replaceDaemon: async () => replaceDaemon(before),
          proveStaleFence: async () => Object.freeze({ awaitedReplacement: true }),
          waitHostsReconnected: async () => {
            const reconnected = await waitAfterReplacement(before);
            after = reconnected;
            return Object.freeze({
              reconnectedHosts: reconnected.reconnectedHosts,
              physicalClientCount: reconnected.physicalClientCount,
              duplicatePhysicalClients: reconnected.duplicatePhysicalClients,
              geometryFightCount: reconnected.geometryFightCount,
              replacementGeometry: reconnected.replacementGeometry,
              socketOutcomes: reconnected.socketOutcomes,
              replacementLifecycle: reconnected.replacementLifecycle,
            });
          },
          waitCanonicalConvergence: async () => after,
          sealRestartCorrelation: async (hosts, beforeSample, replacement, afterSample) =>
            sealDaemonRestartCorrelation(
              hosts,
              beforeSample,
              replacement,
              afterSample,
              evidenceKey,
            ),
        });
        const journeyEvidence = Object.freeze({
          hosts: proof.hosts,
          generations: { before: before.generation, after: after.generation },
          before: { clients: before.clients },
          after: { clients: after.clients },
          restart: {
            elapsedMs: after.recoveryElapsedMs,
            staleDescriptorRejected: after.staleResults.every(
              ({ rejected, typed }) => rejected && typed,
            ),
            staleRedemptions: Object.freeze(
              after.staleResults.map(({ rejected, typed, reason }) =>
                Object.freeze({ rejected, typed, reason }),
              ),
            ),
            staleSocketRejected: after.staleSocketRejected,
            staleGenerationError: after.staleGenerationError,
            replacementFirstEnvelope: after.replacementFirstEnvelope,
            replacementSeedGeneration: after.replacementSeedGeneration,
            predecessorEnvelopeAcceptedAfterReplace: after.predecessorEnvelopeAcceptedAfterReplace,
            reconnectedHosts: proof.reconnect.reconnectedHosts,
            physicalClientCount: proof.reconnect.physicalClientCount,
            duplicatePhysicalClients: proof.reconnect.duplicatePhysicalClients,
            geometryFightCount: proof.reconnect.geometryFightCount,
            replacementGeometry: proof.reconnect.replacementGeometry,
            socketOutcomes: proof.reconnect.socketOutcomes,
            replacementLifecycle: proof.reconnect.replacementLifecycle,
          },
          privacy: proof.correlation.privacy,
          correlation: proof.correlation.correlation,
        });
        publish({ journeyEvidence: { daemonRestart: journeyEvidence } });
      }
      const card5CaptureEvidence = await captureArtifacts(
        state,
        `card5-${journeyId}`,
        card5WebHosts.chromiumPage,
      );
      publish({ card5CaptureEvidence });
      publish({ status: "ready", readyAt: new Date().toISOString() });
      await new Promise(() => undefined);
      return;
    }
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
    let terminalFailure = productRigTerminalFailureState(error, "product-rig-startup");
    if (
      card5Journey &&
      terminalFailure.failureObservation?.operation === "card5-production-host-launch" &&
      ["chromium-readiness", "electron-readiness"].includes(
        terminalFailure.failureObservation.stage,
      )
    ) {
      terminalFailure = Object.freeze({
        ...terminalFailure,
        failureObservation: Object.freeze({
          ...terminalFailure.failureObservation,
          daemonPaneStreamLifecycle: await card5DaemonPaneStreamLifecycle(state),
        }),
      });
    }
    publish(terminalFailure);
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
