import {
  constants as fsConstants,
  closeSync,
  chmodSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

export const PRODUCT_DIAGNOSTIC_BUNDLE_VERSION = 1;
export const PRODUCT_DIAGNOSTIC_BUNDLE_FILES = Object.freeze([
  "report.json",
  "alignment.json",
  "timeline.jsonl",
  "tmux-truth.json",
  "daemon-state.json",
  "client-state.json",
  "tui.ansi",
  "web.png",
  "stderr.log",
  "reproduction.sh",
]);

const GOLDEN_JOURNEYS = Object.freeze(
  [
    ["configless-cold-start", ["configless", "cold-start"]],
    ["coherent-first-pane", ["connect-coherent-frame", "coherent-frame", "terminal-pane"]],
    [
      "first-key-paste",
      [
        "key-input",
        "paste-input",
        "input-consumed-changed-cell",
        "queue-depth",
        "event-loop-delay",
        "dirty-rows",
      ],
    ],
    ["focus", ["focus", "blur"]],
    [
      "window-lifecycle",
      ["window-create", "window-switch", "window-rename", "switch-visible-frame"],
    ],
    [
      "keyboard-pointer-resize",
      ["keyboard-resize", "pointer-resize", "pointer-guide", "release-receipt"],
    ],
    ["selection-copy-app-mouse", ["selection", "copy", "application-mouse"]],
    [
      "ansi-cursor-alt-screen",
      ["ansi", "cursor", "alternate-screen", "unchanged-grid-walk", "memory-slope"],
    ],
    ["cross-client-handoff", ["opentui", "web", "native", "authority-handoff"]],
    ["daemon-restart", ["daemon-restart", "generation-recovery"]],
    ["session-recreate", ["session-kill", "session-recreate"]],
  ].map(([id, coverage]) =>
    Object.freeze({
      id,
      coverage: Object.freeze(coverage),
      executor: id,
      variants: Object.freeze(id === "first-key-paste" ? ["key", "paste"] : [null]),
      implementation: [
        "configless-cold-start",
        "coherent-first-pane",
        "first-key-paste",
        "focus",
        "window-lifecycle",
        "keyboard-pointer-resize",
        "selection-copy-app-mouse",
        "ansi-cursor-alt-screen",
        "cross-client-handoff",
        "daemon-restart",
      ].includes(id)
        ? "implemented"
        : "pending",
    }),
  ),
);

/**
 * The existing monolithic diagnosis remains selectable while it is split into
 * the golden journeys above. It does not claim the missing journey coverage.
 */
export const PRODUCT_JOURNEY_REGISTRY = Object.freeze([
  ...GOLDEN_JOURNEYS,
  Object.freeze({
    id: "runtime-qualification",
    executor: "runtime-qualification",
    variants: Object.freeze([null]),
    coverage: Object.freeze([
      "coherent-frame",
      "key-input",
      "pointer-resize",
      "window-switch",
      "opentui",
      "web",
      "daemon-restart",
      "memory",
      "idle-work",
    ]),
    implementation: "implemented",
  }),
]);

const JOURNEYS_BY_ID = new Map(PRODUCT_JOURNEY_REGISTRY.map((journey) => [journey.id, journey]));

export const PRODUCT_REQUIRED_JOURNEY_COVERAGE = Object.freeze([
  "configless",
  "cold-start",
  "connect-coherent-frame",
  "key-input",
  "paste-input",
  "input-consumed-changed-cell",
  "focus",
  "blur",
  "window-create",
  "window-switch",
  "window-rename",
  "switch-visible-frame",
  "keyboard-resize",
  "pointer-resize",
  "pointer-guide",
  "release-receipt",
  "selection",
  "copy",
  "application-mouse",
  "ansi",
  "cursor",
  "alternate-screen",
  "opentui",
  "web",
  "native",
  "authority-handoff",
  "daemon-restart",
  "generation-recovery",
  "session-kill",
  "session-recreate",
  "queue-depth",
  "dirty-rows",
  "unchanged-grid-walk",
  "event-loop-delay",
  "memory-slope",
]);

export function auditProductJourneyScope(registry = PRODUCT_JOURNEY_REGISTRY) {
  const covered = new Set(registry.flatMap(({ coverage }) => coverage));
  const missing = PRODUCT_REQUIRED_JOURNEY_COVERAGE.filter(
    (requirement) => !covered.has(requirement),
  );
  const pendingJourneyIds = registry
    .filter(({ implementation }) => implementation !== "implemented")
    .map(({ id }) => id);
  return Object.freeze({
    complete: missing.length === 0 && pendingJourneyIds.length === 0,
    declarationComplete: missing.length === 0,
    executableComplete: pendingJourneyIds.length === 0,
    missing: Object.freeze(missing),
    pendingJourneyIds: Object.freeze(pendingJourneyIds),
  });
}

export function parseProductDiagnoseOptions(args) {
  const journeyIds = [];
  let sawJourney = false;
  let repeat = 1;
  let variant = null;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--journey") {
      sawJourney = true;
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--journey requires a journey id");
      const tokens = value.split(",");
      if (tokens.some((token) => !/^[a-z0-9][a-z0-9-]*$/u.test(token)))
        throw new Error("--journey requires non-empty lowercase journey ids");
      journeyIds.push(...tokens);
      index += 1;
      continue;
    }
    if (argument === "--repeat") {
      const value = args[index + 1];
      if (!/^\d+$/u.test(value ?? "")) throw new Error("--repeat requires an integer from 1 to 10");
      repeat = Number(value);
      if (repeat < 1 || repeat > 10) throw new Error("--repeat requires an integer from 1 to 10");
      index += 1;
      continue;
    }
    if (argument === "--variant") {
      const value = args[index + 1];
      if (!/^(?:key|paste)$/u.test(value ?? "")) throw new Error("--variant requires key or paste");
      variant = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown diagnose option ${argument}`);
  }
  return Object.freeze({
    json,
    repeat,
    variant,
    journeyIds: Object.freeze(
      sawJourney ? journeyIds : journeyIds.length > 0 ? journeyIds : ["runtime-qualification"],
    ),
  });
}

export function resolveProductJourneyPlan({ journeyIds, repeat, variant = null }) {
  if (journeyIds.includes("all") && journeyIds.length !== 1)
    throw new Error("ProductRig journey all cannot be combined with another journey id");
  const selected = journeyIds.includes("all")
    ? GOLDEN_JOURNEYS
    : journeyIds.map((id) => JOURNEYS_BY_ID.get(id));
  const unknown = journeyIds.filter((id) => id !== "all" && !JOURNEYS_BY_ID.has(id));
  if (unknown.length > 0)
    throw new Error(
      `unknown ProductRig journey ${unknown.join(", ")}; available: ${PRODUCT_JOURNEY_REGISTRY.map(({ id }) => id).join(", ")}`,
    );
  if (variant && (selected.length !== 1 || selected[0]?.id !== "first-key-paste"))
    throw new Error("--variant is only valid with --journey first-key-paste");
  const pending = selected.filter((journey) => journey.implementation !== "implemented");
  if (pending.length > 0)
    throw new Error(
      `ProductRig journey not implemented: ${pending.map(({ id }) => id).join(", ")}; missing evidence is a failure`,
    );
  const expanded = expandProductJourneyEntries(selected, repeat);
  return variant ? Object.freeze(expanded.filter((entry) => entry.variant === variant)) : expanded;
}

export function expandProductJourneyEntries(journeys, repeat) {
  return Object.freeze(
    journeys.flatMap((journey) =>
      Array.from({ length: repeat }, (_, repetition) =>
        journey.variants.map((variant) =>
          Object.freeze({ journey, variant, repetition: repetition + 1, repeat }),
        ),
      ).flat(),
    ),
  );
}

export async function runProductJourneyPlan(plan, run) {
  if (!Array.isArray(plan) || plan.length === 0)
    throw new Error("ProductRig journey plan must contain at least one run");
  if (typeof run !== "function")
    throw new TypeError("ProductRig journey runner must be a function");
  const results = [];
  for (const entry of plan) results.push(await run(entry));
  return Object.freeze(results);
}

export async function dispatchProductJourneyExecutor(entry, executors) {
  const executor = executors[entry.journey.executor];
  if (typeof executor !== "function")
    throw new Error(`ProductRig journey executor is unavailable: ${entry.journey.executor}`);
  return executor(entry);
}

/** Exact cold-owner ordering seam used by the production ProductRig owner. */
export async function runConfiglessProductJourneyOwnerBoot(operations) {
  const namespace = await operations.createOrdinaryNamespace();
  await operations.assertNamespaceClean(namespace);
  await operations.buildBeforeMeasurement(namespace);
  const publicProcess = await operations.launchPublicNoArgumentEntry(namespace);
  const daemon = await operations.observeElectedDaemon(namespace, publicProcess);
  const discovered = await operations.observeOrdinarySessionDiscovery(namespace, daemon);
  const adopted = await operations.adoptThroughPublicApp(namespace, daemon, discovered);
  const coherent = await operations.proveCoherentPublication(namespace, daemon, adopted);
  const web = await operations.startWebAfterColdBoundary(namespace, daemon, coherent);
  return Object.freeze({ namespace, publicProcess, daemon, discovered, adopted, coherent, web });
}

/** Targeted coherent boot: preseed namespace → daemon/workspace → TUI → proof → Web. */
export async function runCoherentFirstPaneOwnerBoot(operations) {
  const atBoundary = async (boundary, operation) => {
    try {
      return await operation();
    } catch (error) {
      if (error && typeof error === "object" && error.boundary) throw error;
      const bounded = new Error(error instanceof Error ? error.message : String(error), {
        cause: error,
      });
      bounded.boundary = boundary;
      if (error?.observation) bounded.observation = error.observation;
      throw bounded;
    }
  };
  const namespace = await atBoundary("targeted-namespace-preseeded", () =>
    operations.createTargetedNamespace(),
  );
  const daemon = await atBoundary("targeted-daemon-ready", () =>
    operations.startCanonicalDaemon(namespace),
  );
  const identity = await atBoundary("targeted-daemon-ready", () =>
    operations.openCanonicalWorkspace(namespace, daemon),
  );
  await atBoundary("targeted-tui-connect", () => operations.buildBeforeMeasurement(namespace));
  await atBoundary("targeted-tui-connect", () => operations.prepareTargetedTuiCwd(namespace));
  const targetedProcess = await atBoundary("targeted-tui-connect", () =>
    operations.launchTargetedTui(namespace, daemon, identity),
  );
  const coherent = await atBoundary("coherent-terminal-publication", () =>
    operations.proveCoherentPublication(namespace, daemon, identity, targetedProcess),
  );
  const web = await atBoundary("web-started-after-coherent-boundary", () =>
    operations.startWebAfterCoherentBoundary(namespace, daemon, identity, coherent),
  );
  return Object.freeze({ namespace, identity, targetedProcess, coherent, web });
}

/** Dedicated first-input journey: one detailed first input, then a fresh timing host. */
export async function runFirstKeyPasteOwnerBoot(operations) {
  const atBoundary = async (boundary, operation) => {
    try {
      return await operation();
    } catch (error) {
      if (error && typeof error === "object" && error.boundary) throw error;
      const bounded = new Error(error instanceof Error ? error.message : String(error), {
        cause: error,
      });
      bounded.boundary = boundary;
      if (error?.observation) bounded.observation = error.observation;
      throw bounded;
    }
  };
  const namespace = await atBoundary("first-input-namespace-ready", () =>
    operations.createInputNamespace(),
  );
  const daemon = await atBoundary("first-input-daemon-ready", () =>
    operations.startCanonicalDaemon(namespace),
  );
  const identity = await atBoundary("first-input-daemon-ready", () =>
    operations.openCanonicalWorkspace(namespace, daemon),
  );
  await atBoundary("first-input-tui-coherent", () => operations.buildBeforeMeasurement(namespace));
  await atBoundary("first-input-tui-coherent", () => operations.prepareFirstTui(namespace));
  const firstProcess = await atBoundary("first-input-tui-coherent", () =>
    operations.launchFirstTui(namespace, daemon, identity),
  );
  const baseline = await atBoundary("first-input-no-prior-hosted-input", () =>
    operations.proveNoPriorHostedInput(namespace, daemon, identity, firstProcess),
  );
  const firstInput = await atBoundary("first-input-causal-paint", () =>
    operations.driveFirstInput(namespace, daemon, identity, firstProcess, baseline),
  );
  const distributionProcess = await atBoundary("distribution-lane-fresh", () =>
    operations.rehostDistributionTui(namespace, daemon, identity, firstProcess, firstInput),
  );
  const distribution = await atBoundary("distribution-samples", () =>
    operations.driveDistribution(namespace, daemon, identity, distributionProcess, firstInput),
  );
  const web = await atBoundary("first-input-web-correlation", () =>
    operations.startWebAfterInput(namespace, daemon, identity, distribution),
  );
  return Object.freeze({
    namespace,
    identity,
    firstProcess,
    firstInput,
    distributionProcess,
    distribution,
    web,
  });
}

/** Dedicated focus journey: coherent target → exact blur/yield → focus/reclaim → Web. */
export async function runFocusOwnerBoot(operations) {
  const atBoundary = async (boundary, operation) => {
    try {
      return await operation();
    } catch (error) {
      if (error && typeof error === "object" && error.boundary) throw error;
      const bounded = new Error(error instanceof Error ? error.message : String(error), {
        cause: error,
      });
      bounded.boundary = boundary;
      if (error?.observation) bounded.observation = error.observation;
      throw bounded;
    }
  };
  const namespace = await atBoundary("focus-namespace-ready", () =>
    operations.createFocusNamespace(),
  );
  const daemon = await atBoundary("focus-daemon-ready", () =>
    operations.startCanonicalDaemon(namespace),
  );
  const identity = await atBoundary("focus-daemon-ready", () =>
    operations.openCanonicalWorkspace(namespace, daemon),
  );
  await atBoundary("focus-tui-build", () => operations.buildBeforeMeasurement(namespace));
  const started = await atBoundary("focus-tui-started", () =>
    operations.launchFocusTui(namespace, daemon, identity),
  );
  const host = await atBoundary("focus-host-ready", () =>
    operations.waitForFocusHostReady(namespace, daemon, identity, started),
  );
  const process = await atBoundary("focus-tui-coherent", () =>
    operations.waitForFocusTuiCoherent(namespace, daemon, identity, started, host),
  );
  const baseline = await atBoundary("focus-baseline", () =>
    operations.proveFocusBaseline(namespace, daemon, identity, process),
  );
  const blur = await atBoundary("focus-blur-proved", () =>
    operations.driveBlur(namespace, daemon, identity, process, baseline),
  );
  const reclaim = await atBoundary("focus-reclaim-proved", () =>
    operations.driveFocus(namespace, daemon, identity, process, baseline, blur),
  );
  const web = await atBoundary("focus-web-correlation", () =>
    operations.startWebAfterFocus(namespace, daemon, identity, process, reclaim),
  );
  return Object.freeze({ namespace, identity, process, baseline, blur, reclaim, web });
}

/** Dedicated window lifecycle: coherent baseline → create → warm switches → rename → Web. */
export async function runWindowLifecycleOwnerBoot(operations) {
  const atBoundary = async (boundary, operation) => {
    operations.onBoundary?.(boundary);
    try {
      return await operation();
    } catch (error) {
      if (error && typeof error === "object" && error.boundary) throw error;
      const bounded = new Error(error instanceof Error ? error.message : String(error), {
        cause: error,
      });
      bounded.boundary = boundary;
      if (error?.observation) bounded.observation = error.observation;
      throw bounded;
    }
  };
  const namespace = await atBoundary("window-namespace-ready", () =>
    operations.createWindowNamespace(),
  );
  const daemon = await atBoundary("window-daemon-ready", () =>
    operations.startCanonicalDaemon(namespace),
  );
  const identity = await atBoundary("window-daemon-ready", () =>
    operations.openCanonicalWorkspace(namespace, daemon),
  );
  await atBoundary("window-tui-build", () => operations.buildBeforeMeasurement(namespace));
  const started = await atBoundary("window-tui-started", () =>
    operations.launchWindowTui(namespace, daemon, identity),
  );
  const host = await atBoundary("window-host-ready", () =>
    operations.waitForWindowHostReady(namespace, daemon, identity, started),
  );
  const process = await atBoundary("window-tui-coherent", () =>
    operations.waitForWindowTuiCoherent(namespace, daemon, identity, started, host),
  );
  const baseline = await atBoundary("window-baseline", () =>
    operations.proveWindowBaseline(namespace, daemon, identity, process),
  );
  const created = await atBoundary("window-create-proved", () =>
    operations.createWindow(namespace, daemon, identity, process, baseline),
  );
  const primed = await atBoundary("window-switch-visible", () =>
    operations.primeCreatedWindow(namespace, daemon, identity, process, baseline, created),
  );
  const renamed = await atBoundary("window-rename-visible", () =>
    operations.renameWindow(namespace, daemon, identity, process, baseline, created, primed),
  );
  const switches = await atBoundary("window-switch-distribution", () =>
    operations.driveWarmSwitches(namespace, daemon, identity, process, baseline, created, renamed),
  );
  const web = await atBoundary("window-web-correlation", () =>
    operations.startWebAfterWindowLifecycle(
      namespace,
      daemon,
      identity,
      process,
      baseline,
      created,
      switches,
      renamed,
    ),
  );
  return Object.freeze({
    namespace,
    identity,
    process,
    baseline,
    created,
    primed,
    switches,
    renamed,
    web,
  });
}

/** Dedicated resize journey: coherent two-pane baseline → keyboard → pointer previews/release → Web. */
export async function runKeyboardPointerResizeOwnerBoot(operations) {
  const atBoundary = async (boundary, operation) => {
    operations.onBoundary?.(boundary);
    try {
      return await operation();
    } catch (error) {
      if (error && typeof error === "object" && error.boundary) throw error;
      const bounded = new Error(error instanceof Error ? error.message : String(error), {
        cause: error,
      });
      bounded.boundary = boundary;
      bounded.observation =
        error?.observation ??
        Object.freeze({
          operation: "keyboard-pointer-resize-owner",
          reason: "operation-failed",
          stage: boundary,
        });
      throw bounded;
    }
  };
  const namespace = await atBoundary("resize-namespace-ready", operations.createResizeNamespace);
  const daemon = await atBoundary("resize-daemon-ready", () =>
    operations.startCanonicalDaemon(namespace),
  );
  const identity = await atBoundary("resize-daemon-ready", () =>
    operations.openCanonicalWorkspace(namespace, daemon),
  );
  await atBoundary("resize-tui-build", () => operations.buildBeforeMeasurement(namespace));
  const started = await atBoundary("resize-tui-started", () =>
    operations.launchResizeTui(namespace, daemon, identity),
  );
  const host = await atBoundary("resize-host-ready", () =>
    operations.waitForResizeHostReady(namespace, daemon, identity, started),
  );
  const process = await atBoundary("resize-tui-coherent", () =>
    operations.waitForResizeTuiCoherent(namespace, daemon, identity, started, host),
  );
  const baseline = await atBoundary("resize-baseline", () =>
    operations.proveResizeBaseline(namespace, daemon, identity, process),
  );
  const keyboard = await atBoundary("resize-keyboard-proved", () =>
    operations.driveKeyboardResize(namespace, daemon, identity, process, baseline),
  );
  const pointerPreviews = await atBoundary("resize-pointer-preview-distribution", () =>
    operations.drivePointerPreviews(namespace, daemon, identity, process, baseline, keyboard),
  );
  const pointerRelease = await atBoundary("resize-pointer-release-proved", () =>
    operations.drivePointerRelease(
      namespace,
      daemon,
      identity,
      process,
      baseline,
      keyboard,
      pointerPreviews,
    ),
  );
  const web = await atBoundary("resize-web-correlation", () =>
    operations.startWebAfterResize(
      namespace,
      daemon,
      identity,
      process,
      baseline,
      keyboard,
      pointerRelease,
    ),
  );
  return Object.freeze({
    namespace,
    identity,
    process,
    baseline,
    keyboard,
    pointerPreviews,
    pointerRelease,
    web,
  });
}

/** Dedicated selection journey: coherent pane → local selection/copy → app mouse → Web. */
export async function runSelectionCopyAppMouseOwnerBoot(operations) {
  const atBoundary = async (boundary, operation) => {
    operations.onBoundary?.(boundary);
    try {
      return await operation();
    } catch (error) {
      if (error && typeof error === "object" && error.boundary) throw error;
      const bounded = new Error(error instanceof Error ? error.message : String(error), {
        cause: error,
      });
      bounded.boundary = boundary;
      bounded.observation =
        error?.observation ??
        Object.freeze({ operation: "selection-copy-app-mouse-owner", stage: boundary });
      throw bounded;
    }
  };
  const namespace = await atBoundary("selection-namespace-ready", operations.createNamespace);
  const daemon = await atBoundary("selection-daemon-ready", () =>
    operations.startDaemon(namespace),
  );
  const identity = await atBoundary("selection-daemon-ready", () =>
    operations.openWorkspace(namespace, daemon),
  );
  await atBoundary("selection-tui-build", () => operations.build(namespace));
  const started = await atBoundary("selection-tui-started", () =>
    operations.launch(namespace, daemon, identity),
  );
  const host = await atBoundary("selection-host-ready", () =>
    operations.waitHost(namespace, daemon, identity, started),
  );
  const process = await atBoundary("selection-tui-coherent", () =>
    operations.waitCoherent(namespace, daemon, identity, started, host),
  );
  const baseline = await atBoundary("selection-baseline", () =>
    operations.proveBaseline(namespace, daemon, identity, process, host),
  );
  const selection = await atBoundary("selection-visible", () =>
    operations.driveSelection(namespace, daemon, identity, process, baseline),
  );
  const copy = await atBoundary("selection-copy-proved", () =>
    operations.driveCopy(namespace, daemon, identity, process, baseline, selection),
  );
  const appMouse = await atBoundary("application-mouse-forwarded", () =>
    operations.driveAppMouse(namespace, daemon, identity, process, baseline, copy),
  );
  const localMode = await atBoundary("selection-local-mode-proved", () =>
    operations.driveLocalMode(namespace, daemon, identity, process, baseline, appMouse),
  );
  const web = await atBoundary("selection-web-correlation", () =>
    operations.startWeb(namespace, daemon, identity, process, baseline, localMode),
  );
  return Object.freeze({
    namespace,
    identity,
    process,
    host,
    baseline,
    selection,
    copy,
    appMouse,
    localMode,
    web,
  });
}

/** Dedicated ANSI journey: normal baseline → cursor/ANSI → alternate buffer → exact restore. */
export async function runAnsiCursorAltScreenOwnerBoot(operations) {
  const atBoundary = async (boundary, operation) => {
    operations.onBoundary?.(boundary);
    try {
      return await operation();
    } catch (error) {
      if (error && typeof error === "object" && error.boundary) throw error;
      const bounded = new Error(error instanceof Error ? error.message : String(error), {
        cause: error,
      });
      bounded.boundary = boundary;
      bounded.observation =
        error?.observation ??
        Object.freeze({ operation: "ansi-cursor-alt-screen-owner", stage: boundary });
      throw bounded;
    }
  };
  const namespace = await atBoundary("ansi-namespace-ready", operations.createNamespace);
  const daemon = await atBoundary("ansi-daemon-ready", () => operations.startDaemon(namespace));
  const identity = await atBoundary("ansi-daemon-ready", () =>
    operations.openWorkspace(namespace, daemon),
  );
  await atBoundary("ansi-tui-build", () => operations.build(namespace));
  const started = await atBoundary("ansi-tui-started", () =>
    operations.launch(namespace, daemon, identity),
  );
  const host = await atBoundary("ansi-host-ready", () =>
    operations.waitHost(namespace, daemon, identity, started),
  );
  const process = await atBoundary("ansi-tui-coherent", () =>
    operations.waitCoherent(namespace, daemon, identity, started, host),
  );
  const baseline = await atBoundary("ansi-normal-baseline", () =>
    operations.proveNormalBaseline(namespace, daemon, identity, process, host),
  );
  const rich = await atBoundary("ansi-rich-presentation", () =>
    operations.driveRichAnsi(namespace, daemon, identity, process, baseline),
  );
  const cursor = await atBoundary("ansi-cursor-only-distribution", () =>
    operations.driveCursorDistribution(namespace, daemon, identity, process, baseline, rich),
  );
  const alternate = await atBoundary("ansi-alternate-screen", () =>
    operations.enterAlternateScreen(namespace, daemon, identity, process, baseline, cursor),
  );
  const restored = await atBoundary("ansi-normal-restored", () =>
    operations.restoreNormalScreen(namespace, daemon, identity, process, baseline, alternate),
  );
  const sustained = await atBoundary("ansi-sustained-workload", () =>
    operations.runSustainedWorkload(namespace, daemon, identity, process, baseline, restored),
  );
  const idle = await atBoundary("ansi-idle-quiescent", () =>
    operations.proveIdle(namespace, daemon, identity, process, baseline, sustained),
  );
  const web = await atBoundary("ansi-web-correlation", () =>
    operations.startWeb(namespace, daemon, identity, process, baseline, restored, idle),
  );
  return Object.freeze({
    namespace,
    identity,
    process,
    host,
    baseline,
    rich,
    cursor,
    alternate,
    restored,
    sustained,
    idle,
    web,
  });
}

/** Card5 proof: real adapters first, then authority/isolation, then one daemon replacement. */
export async function runCrossClientHandoffOwnerBoot(operations) {
  const atBoundary = async (boundary, operation) => {
    operations.onBoundary?.(boundary);
    try {
      return await operation();
    } catch (error) {
      if (error && typeof error === "object" && error.boundary) throw error;
      const bounded = new Error(error instanceof Error ? error.message : String(error), {
        cause: error,
      });
      bounded.boundary = boundary;
      bounded.observation =
        error?.observation ??
        Object.freeze({
          operation: "card5-cross-client-live-proof",
          reason: "operation-failed",
          boundary,
        });
      throw bounded;
    }
  };
  const namespace = await atBoundary(
    "cross-client-production-hosts",
    operations.createProductionHosts,
  );
  const initial = await atBoundary("cross-client-initial-convergence", () =>
    operations.waitInitialConvergence(namespace),
  );
  const handoff = await atBoundary("cross-client-authority-handoff", () =>
    operations.driveAuthorityHandoff(namespace, initial),
  );
  const geometry = await atBoundary("cross-client-passive-geometry", () =>
    operations.provePassiveGeometry(namespace, initial, handoff),
  );
  const slowWeb = await atBoundary("cross-client-slow-web-isolation", () =>
    operations.proveSlowWebIsolation(namespace, initial, handoff, geometry),
  );
  const restart = await atBoundary("cross-client-daemon-restart", () =>
    operations.restartDaemon(namespace, initial, slowWeb),
  );
  const after = await atBoundary("cross-client-restart-convergence", () =>
    operations.waitRestartConvergence(namespace, initial, restart),
  );
  const nativeObserver = await atBoundary("cross-client-native-observer", () =>
    operations.proveNativeObserver(namespace, after),
  );
  const correlation = await atBoundary("cross-client-correlation-privacy", () =>
    operations.sealCorrelation(
      namespace,
      initial,
      handoff,
      geometry,
      slowWeb,
      restart,
      after,
      nativeObserver,
    ),
  );
  return Object.freeze({
    namespace,
    initial,
    handoff,
    geometry,
    slowWeb,
    restart,
    after,
    nativeObserver,
    correlation,
  });
}

/** Card5 restart proof is independent from authority handoff despite shared host setup. */
export async function runDaemonRestartOwnerBoot(operations) {
  const atBoundary = async (boundary, operation) => {
    operations.onBoundary?.(boundary);
    try {
      return await operation();
    } catch (error) {
      if (error && typeof error === "object" && error.boundary) throw error;
      const bounded = new Error(error instanceof Error ? error.message : String(error), {
        cause: error,
      });
      bounded.boundary = boundary;
      bounded.observation =
        error?.observation ??
        Object.freeze({
          operation: "card5-daemon-restart-live-proof",
          reason: "operation-failed",
          boundary,
        });
      throw bounded;
    }
  };
  const hosts = await atBoundary(
    "daemon-restart-production-hosts",
    operations.createProductionHosts,
  );
  const before = await atBoundary("daemon-restart-before-convergence", () =>
    operations.waitBeforeConvergence(hosts),
  );
  const replacement = await atBoundary("daemon-restart-generation-replaced", () =>
    operations.replaceDaemon(hosts, before),
  );
  const staleFence = await atBoundary("daemon-restart-stale-authority-rejected", () =>
    operations.proveStaleFence(hosts, before, replacement),
  );
  const reconnect = await atBoundary("daemon-restart-hosts-reconnected", () =>
    operations.waitHostsReconnected(hosts, replacement, staleFence),
  );
  const after = await atBoundary("daemon-restart-canonical-convergence", () =>
    operations.waitCanonicalConvergence(hosts, replacement, reconnect),
  );
  const correlation = await atBoundary("daemon-restart-correlation-privacy", () =>
    operations.sealRestartCorrelation(hosts, before, replacement, after),
  );
  return Object.freeze({ hosts, before, replacement, staleFence, reconnect, after, correlation });
}

function exactTargetedTuiCwd(runtimeDir, { createMissing, hooks = {} }) {
  const fail = (reason, cause = undefined) => {
    const error = new Error(`targeted TUI isolated cwd preparation failed: ${reason}`, { cause });
    error.boundary = createMissing ? "targeted-namespace-preseeded" : "targeted-tui-connect";
    error.observation = Object.freeze({
      operation: createMissing ? "create-isolated-tui-cwd" : "prepare-isolated-tui-cwd",
      reason,
      runtimeKind: "product-rig-testdrive",
    });
    throw error;
  };
  if (
    typeof runtimeDir !== "string" ||
    !isAbsolute(runtimeDir) ||
    runtimeDir.length === 0 ||
    runtimeDir.length > 4_096 ||
    /[\0\r\n]/u.test(runtimeDir)
  )
    fail("malformed-runtime-directory");
  const exactRuntimeDir = resolve(runtimeDir);
  const cwd = join(exactRuntimeDir, "home");
  const assertDirectoryIdentity = (path, label, opened) => {
    let current;
    try {
      current = lstatSync(path);
    } catch (error) {
      fail(`${label}-identity-read-failed`, error);
    }
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino
    )
      fail(`${label}-identity-changed`);
    try {
      const expectedRealPath = join(realpathSync(dirname(path)), basename(path));
      if (realpathSync(path) !== expectedRealPath) fail(`${label}-resolved-path-mismatch`);
    } catch (error) {
      if (error?.boundary) throw error;
      fail(`${label}-resolved-path-read-failed`, error);
    }
  };
  const prepareDirectory = (path, label, parent = null) => {
    if (parent) assertDirectoryIdentity(parent.path, parent.label, parent.opened);
    let metadata;
    try {
      metadata = lstatSync(path);
    } catch (error) {
      if (error?.code !== "ENOENT") fail(`${label}-metadata-read-failed`, error);
      if (!createMissing) fail(`${label}-missing`);
      try {
        mkdirSync(path, { recursive: false, mode: 0o700 });
        metadata = lstatSync(path);
      } catch (createError) {
        fail(`${label}-create-failed`, createError);
      }
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail(`${label}-not-exact-directory`);
    let descriptor;
    try {
      descriptor = openSync(
        path,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      );
      const opened = fstatSync(descriptor);
      if (!opened.isDirectory()) fail(`${label}-opened-resource-not-directory`);
      if (parent) assertDirectoryIdentity(parent.path, parent.label, parent.opened);
      if (createMissing) fchmodSync(descriptor, 0o700);
      else if ((opened.mode & 0o777) !== 0o700) fail(`${label}-permission-mismatch`);
      assertDirectoryIdentity(path, label, opened);
      if (parent) assertDirectoryIdentity(parent.path, parent.label, parent.opened);
      return { descriptor, opened, path, label };
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (error?.boundary) throw error;
      fail(`${label}-open-or-permission-failed`, error);
    }
  };
  let runtime;
  let home;
  try {
    runtime = prepareDirectory(exactRuntimeDir, "runtime");
    try {
      hooks.afterRuntimeValidated?.();
    } catch (error) {
      fail("runtime-validation-hook-failed", error);
    }
    assertDirectoryIdentity(runtime.path, runtime.label, runtime.opened);
    home = prepareDirectory(cwd, "home", runtime);
    assertDirectoryIdentity(runtime.path, runtime.label, runtime.opened);
    return cwd;
  } finally {
    if (home?.descriptor !== undefined) closeSync(home.descriptor);
    if (runtime?.descriptor !== undefined) closeSync(runtime.descriptor);
  }
}

export function createIsolatedTargetedTuiCwd(runtimeDir) {
  return exactTargetedTuiCwd(runtimeDir, { createMissing: true });
}

export function prepareIsolatedTargetedTuiCwd(runtimeDir, hooks = {}) {
  return exactTargetedTuiCwd(runtimeDir, { createMissing: false, hooks });
}

export class ProductJourneyAttemptError extends Error {
  constructor(entry, boundary, bundle, cause) {
    super(
      `ProductRig journey ${entry.journey.id} repetition ${entry.repetition} failed at ${boundary}; evidence: ${bundle.runDir}`,
      { cause },
    );
    this.name = "ProductJourneyAttemptError";
    this.boundary = boundary;
    this.bundle = bundle;
    this.originalCause = cause;
  }
}

export function productJourneyFailureBoundary(error, fallback) {
  return typeof error?.boundary === "string" && error.boundary.length > 0
    ? error.boundary
    : fallback;
}

export function productRigTerminalFailureState(error, fallbackBoundary) {
  return Object.freeze({
    status: "failed",
    failure: error instanceof Error ? error.stack || error.message : String(error),
    firstBrokenBoundary: productJourneyFailureBoundary(error, fallbackBoundary),
    ...(error?.observation ? { failureObservation: error.observation } : {}),
  });
}

export function productRigTerminalFailureError(state) {
  const failure = new Error(state?.failure || "product rig failed");
  if (typeof state?.firstBrokenBoundary === "string") failure.boundary = state.firstBrokenBoundary;
  if (state?.failureObservation) failure.observation = state.failureObservation;
  return failure;
}

/** Deterministic lifecycle seam: clean → drive → clean → immutable publish. */
export async function runIsolatedProductJourneyAttempt(entry, operations) {
  let completed = null;
  let failure = null;
  let failureBoundary = null;
  let cleanupFailure = null;
  let validationFailure = null;
  let preCleanupFailureEvidence = null;
  let cleanupReceipt;
  const phase = (value) => operations.onPhase?.(value);

  phase("pre-attempt-cleanup");
  try {
    await operations.preCleanup();
    phase("product-rig-startup");
    completed = await operations.drive();
  } catch (error) {
    failure = error;
    failureBoundary = productJourneyFailureBoundary(error, operations.currentBoundary());
  }

  if (failure && operations.captureFailureEvidence) {
    phase("pre-cleanup-failure-evidence");
    const captureAbort = new AbortController();
    const capture = Promise.resolve().then(() =>
      operations.captureFailureEvidence(failure, failureBoundary, captureAbort.signal),
    );
    const settledCapture = capture.then(
      (value) => ({ status: "captured", value }),
      () => ({ status: "failed" }),
    );
    let timeout;
    const captureTimeoutMs =
      Number.isSafeInteger(operations.failureEvidenceTimeoutMs) &&
      operations.failureEvidenceTimeoutMs >= 1 &&
      operations.failureEvidenceTimeoutMs <= 1_000
        ? operations.failureEvidenceTimeoutMs
        : 1_000;
    const timeoutCapture = new Promise((resolve) => {
      timeout = setTimeout(() => resolve({ status: "timeout" }), captureTimeoutMs);
    });
    const outcome = await Promise.race([settledCapture, timeoutCapture]);
    clearTimeout(timeout);
    if (outcome.status === "timeout") {
      captureAbort.abort();
      let cancellationTimeout;
      await Promise.race([
        settledCapture,
        new Promise((resolve) => {
          cancellationTimeout = setTimeout(resolve, Math.min(captureTimeoutMs, 100));
        }),
      ]);
      clearTimeout(cancellationTimeout);
    }
    preCleanupFailureEvidence =
      outcome.status === "captured"
        ? outcome.value
        : Object.freeze({ available: false, reason: `pre-cleanup-${outcome.status}` });
  }

  phase("attempt-cleanup");
  try {
    cleanupReceipt = await operations.postCleanup();
  } catch (cleanupError) {
    phase("attempt-cleanup-retry");
    try {
      cleanupReceipt = await operations.retryCleanup(cleanupError);
    } catch (retryError) {
      throw new AggregateError(
        [cleanupError, retryError],
        "ProductRig exact cleanup barrier failed after bounded retry; evidence publication and later attempts are blocked",
        { cause: retryError },
      );
    }
    if (!failure) {
      failure = cleanupError;
      failureBoundary = "attempt-cleanup";
    } else {
      cleanupFailure = cleanupError;
    }
  }

  phase("post-cleanup-validation");
  try {
    await operations.validateAfterCleanup?.();
  } catch (validationError) {
    if (!failure) {
      failure = validationError;
      failureBoundary = productJourneyFailureBoundary(validationError, "post-cleanup-validation");
    } else {
      validationFailure = validationError;
    }
  }

  if (failure) {
    const failedResult = await operations.prepareFailure(
      failure,
      failureBoundary,
      cleanupReceipt,
      preCleanupFailureEvidence,
    );
    if (cleanupFailure) operations.appendCleanupFailure(failedResult, cleanupFailure);
    if (validationFailure) operations.appendValidationFailure?.(failedResult, validationFailure);
    phase("failure-bundle-publication");
    const bundle = await operations.publishFailure(failedResult, cleanupReceipt);
    throw new ProductJourneyAttemptError(entry, failureBoundary, bundle, failure);
  }
  phase("success-bundle-publication");
  try {
    return await operations.publishSuccess(completed, cleanupReceipt);
  } catch (publicationError) {
    const boundary = "success-bundle-publication";
    const publicationFailure = await operations.prepareFailure(
      publicationError,
      boundary,
      cleanupReceipt,
    );
    const bundle = await operations.publishFailure(publicationFailure, cleanupReceipt);
    throw new ProductJourneyAttemptError(entry, boundary, bundle, publicationError);
  }
}

function exactObjectKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

export function createProductRigCleanupReceipt(entry, state, attempt) {
  const namespace = state?.runtimeNamespace;
  const cleanup = state?.cleanup;
  const preflight = state?.diagnosticAttempt?.preflight;
  const exactNoResourcePreflight =
    exactObjectKeys(state?.diagnosticAttempt, [
      "runId",
      "resourcesCreated",
      "sourceProvenance",
      "preflight",
    ]) &&
    exactObjectKeys(state?.diagnosticAttempt?.sourceProvenance, [
      "commit",
      "tree",
      "manifestDigest",
    ]) &&
    /^[0-9a-f]{40,64}$/u.test(state?.diagnosticAttempt?.sourceProvenance?.commit ?? "") &&
    /^[0-9a-f]{40,64}$/u.test(state?.diagnosticAttempt?.sourceProvenance?.tree ?? "") &&
    /^[0-9a-f]{64}$/u.test(state?.diagnosticAttempt?.sourceProvenance?.manifestDigest ?? "") &&
    exactObjectKeys(preflight, [
      "operation",
      "stage",
      "outcome",
      "resourcesCreated",
      "pathsClaimed",
      "daemonStarted",
    ]) &&
    state?.diagnosticAttempt?.runId === entry?.runId &&
    state?.diagnosticAttempt?.resourcesCreated === false &&
    preflight?.operation === "product-rig-namespace-preflight" &&
    preflight?.stage === "ansi-initial-pane-command" &&
    preflight?.outcome === "command-rejected" &&
    preflight?.resourcesCreated === false &&
    preflight?.pathsClaimed === 0 &&
    preflight?.daemonStarted === false &&
    state?.firstBrokenBoundary === "ansi-namespace-ready" &&
    exactObjectKeys(state?.failureObservation, [
      "operation",
      "stage",
      "outcome",
      "resourcesCreated",
      "pathsClaimed",
      "daemonStarted",
    ]) &&
    state.failureObservation.operation === preflight.operation &&
    state.failureObservation.stage === preflight.stage &&
    state.failureObservation.outcome === preflight.outcome &&
    state.failureObservation.resourcesCreated === preflight.resourcesCreated &&
    state.failureObservation.pathsClaimed === preflight.pathsClaimed &&
    state.failureObservation.daemonStarted === preflight.daemonStarted &&
    !Object.prototype.hasOwnProperty.call(state ?? {}, "runtimeNamespace") &&
    !Object.prototype.hasOwnProperty.call(state ?? {}, "session") &&
    !Object.prototype.hasOwnProperty.call(state ?? {}, "tui") &&
    !Object.prototype.hasOwnProperty.call(state ?? {}, "daemon") &&
    state?.daemonLifecycle === "not-started";
  if (exactNoResourcePreflight) {
    if (
      !cleanup ||
      cleanup.status !== "passed" ||
      cleanup.cleanupToken !== null ||
      !Array.isArray(cleanup.failures) ||
      cleanup.failures.length !== 0 ||
      !Number.isSafeInteger(attempt) ||
      attempt < 1 ||
      attempt > 2 ||
      !Number.isSafeInteger(state.ownerPid)
    )
      throw new Error("ProductRig preflight cleanup receipt source is incomplete");
    const ownerDead = (() => {
      try {
        process.kill(state.ownerPid, 0);
        return false;
      } catch (error) {
        return error?.code === "ESRCH";
      }
    })();
    return validateProductRigCleanupReceipt(
      {
        version: 1,
        scope: "preflight-no-resources",
        runId: entry.runId,
        requestId: cleanup.requestId,
        attempt,
        passed: true,
        completedAt: cleanup.completedAt,
        ownerPid: state.ownerPid,
        daemon: { status: "not-started" },
        namespaceDigest: createHash("sha256")
          .update(`preflight-no-resources\0${entry.runId}`)
          .digest("hex"),
        ownerDead,
        daemonDead: true,
        resourcesCreated: false,
        pathsClaimed: 0,
        failureCount: 0,
      },
      entry.runId,
    );
  }
  const ownedPaths = [
    namespace?.root,
    namespace?.tmuxSocketPath,
    namespace?.hostTmuxSocketPath,
    namespace?.daemonInfoDir,
    ...(state?.ownedTuiRuntimeDirs ?? []),
  ];
  const hasDaemon = Object.prototype.hasOwnProperty.call(state ?? {}, "daemon");
  const daemonStarted = hasDaemon && state.daemon !== undefined && state.daemon !== null;
  if (
    !entry ||
    typeof entry.runId !== "string" ||
    !cleanup ||
    cleanup.status !== "passed" ||
    !Array.isArray(cleanup.failures) ||
    cleanup.failures.length !== 0 ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    attempt > 2 ||
    !Number.isSafeInteger(state?.ownerPid) ||
    (!daemonStarted && (hasDaemon || state?.daemonLifecycle !== "not-started")) ||
    (daemonStarted &&
      (state.daemonLifecycle !== "started" ||
        !Number.isSafeInteger(state.daemon.pid) ||
        typeof state.daemon.instanceId !== "string")) ||
    ownedPaths.some((path) => typeof path !== "string")
  )
    throw new Error("ProductRig cleanup receipt source is incomplete");
  const dead = (pid) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  };
  const ownerDead = dead(state.ownerPid);
  const daemonDead = daemonStarted ? dead(state.daemon.pid) : true;
  const pathsAbsent = ownedPaths.every((path) => !existsSync(path));
  const pathAbsence = {
    runtimeRoot: !existsSync(ownedPaths[0]),
    tmuxSocket: !existsSync(ownedPaths[1]),
    hostTmuxSocket: !existsSync(ownedPaths[2]),
    daemonInfo: !existsSync(ownedPaths[3]),
    tuiRuntime: ownedPaths.slice(4).every((path) => !existsSync(path)),
  };
  const receipt = {
    version: 1,
    runId: entry.runId,
    requestId: cleanup.requestId,
    attempt,
    passed: true,
    completedAt: cleanup.completedAt,
    ownerPid: state.ownerPid,
    daemon: daemonStarted
      ? { status: "started", instanceId: state.daemon.instanceId, pid: state.daemon.pid }
      : { status: "not-started" },
    namespaceDigest: createHash("sha256").update(JSON.stringify(ownedPaths)).digest("hex"),
    ownerDead,
    daemonDead,
    pathsAbsent,
    pathAbsence,
    failureCount: 0,
  };
  return validateProductRigCleanupReceipt(receipt, entry.runId);
}

export function validateProductRigCleanupReceipt(receipt, runId) {
  const daemonValid =
    (receipt?.daemon?.status === "started" &&
      typeof receipt.daemon.instanceId === "string" &&
      receipt.daemon.instanceId.length > 0 &&
      receipt.daemon.instanceId.length <= 128 &&
      Number.isSafeInteger(receipt.daemon.pid) &&
      receipt.daemon.pid > 0) ||
    (receipt?.daemon?.status === "not-started" &&
      !Object.prototype.hasOwnProperty.call(receipt.daemon, "instanceId") &&
      !Object.prototype.hasOwnProperty.call(receipt.daemon, "pid"));
  const commonValid =
    receipt?.version === 1 &&
    receipt.runId === runId &&
    typeof receipt.requestId === "string" &&
    /^[a-zA-Z0-9-]{1,128}$/u.test(receipt.requestId) &&
    (receipt.attempt === 1 || receipt.attempt === 2) &&
    receipt.passed === true &&
    typeof receipt.completedAt === "string" &&
    receipt.completedAt.length <= 64 &&
    Number.isFinite(Date.parse(receipt.completedAt)) &&
    Number.isSafeInteger(receipt.ownerPid) &&
    receipt.ownerPid > 0 &&
    daemonValid &&
    /^[0-9a-f]{64}$/u.test(receipt.namespaceDigest ?? "") &&
    receipt.ownerDead === true &&
    receipt.daemonDead === true &&
    receipt.failureCount === 0;
  const preflightValid =
    exactObjectKeys(receipt, [
      "version",
      "scope",
      "runId",
      "requestId",
      "attempt",
      "passed",
      "completedAt",
      "ownerPid",
      "daemon",
      "namespaceDigest",
      "ownerDead",
      "daemonDead",
      "resourcesCreated",
      "pathsClaimed",
      "failureCount",
    ]) &&
    receipt?.scope === "preflight-no-resources" &&
    exactObjectKeys(receipt.daemon, ["status"]) &&
    receipt.daemon?.status === "not-started" &&
    receipt.resourcesCreated === false &&
    receipt.pathsClaimed === 0 &&
    !Object.prototype.hasOwnProperty.call(receipt, "pathsAbsent") &&
    !Object.prototype.hasOwnProperty.call(receipt, "pathAbsence");
  const ownedNamespaceValid =
    !Object.prototype.hasOwnProperty.call(receipt ?? {}, "scope") &&
    receipt?.pathsAbsent === true &&
    receipt?.pathAbsence?.runtimeRoot === true &&
    receipt?.pathAbsence?.tmuxSocket === true &&
    receipt?.pathAbsence?.hostTmuxSocket === true &&
    receipt?.pathAbsence?.daemonInfo === true &&
    receipt?.pathAbsence?.tuiRuntime === true &&
    !Object.prototype.hasOwnProperty.call(receipt ?? {}, "resourcesCreated") &&
    !Object.prototype.hasOwnProperty.call(receipt ?? {}, "pathsClaimed");
  const valid = commonValid && (preflightValid || ownedNamespaceValid);
  if (!valid) throw new Error("ProductRig cleanup receipt is missing, mismatched, or not passed");
  if (preflightValid)
    return Object.freeze({
      version: 1,
      scope: "preflight-no-resources",
      runId: receipt.runId,
      requestId: receipt.requestId,
      attempt: receipt.attempt,
      passed: true,
      completedAt: receipt.completedAt,
      ownerPid: receipt.ownerPid,
      daemon: Object.freeze({ status: "not-started" }),
      namespaceDigest: receipt.namespaceDigest,
      ownerDead: true,
      daemonDead: true,
      resourcesCreated: false,
      pathsClaimed: 0,
      failureCount: 0,
    });
  return Object.freeze({
    version: 1,
    runId: receipt.runId,
    requestId: receipt.requestId,
    attempt: receipt.attempt,
    passed: true,
    completedAt: receipt.completedAt,
    ownerPid: receipt.ownerPid,
    daemon:
      receipt.daemon.status === "started"
        ? Object.freeze({
            status: "started",
            instanceId: receipt.daemon.instanceId,
            pid: receipt.daemon.pid,
          })
        : Object.freeze({ status: "not-started" }),
    namespaceDigest: receipt.namespaceDigest,
    ownerDead: true,
    daemonDead: true,
    pathsAbsent: true,
    pathAbsence: Object.freeze({
      runtimeRoot: true,
      tmuxSocket: true,
      hostTmuxSocket: true,
      daemonInfo: true,
      tuiRuntime: true,
    }),
    failureCount: 0,
  });
}

export function productRigCleanupBarrierFailures(
  state,
  requestId,
  { processAlive: isAlive, pathExists = existsSync, retainedProcessIdentityStatus = null },
) {
  const failures = [];
  if (!state || typeof state !== "object") return Object.freeze(["state-missing"]);
  if (state.cleanup?.requestId !== requestId) failures.push("cleanup-request-not-acknowledged");
  if (state.cleanup?.status !== "passed") failures.push("cleanup-not-passed");
  if (!["stopped", "failed"].includes(state.status))
    failures.push(`state-${state.status ?? "missing"}`);
  if ((state.cleanup?.cleanupToken ?? null) !== (state.runtimeNamespace?.cleanupToken ?? null))
    failures.push("cleanup-token-mismatch");
  for (const failure of state.cleanup?.failures ?? [])
    failures.push(`subsystem-${failure.subsystem ?? "unknown"}`);
  if (Number.isInteger(state.ownerPid) && isAlive(state.ownerPid))
    failures.push("owner-process-live");
  if (Number.isInteger(state.daemon?.pid) && isAlive(state.daemon.pid))
    failures.push("daemon-process-live");
  const terminalHostProcessCount = Math.max(
    (state.cleanup?.card5?.chromiumTerminalProcessCount ?? 0) +
      (state.cleanup?.card5?.electronTerminalProcessCount ?? 0),
    state.cleanup?.processReap?.terminalIdentityCount ?? 0,
  );
  if (terminalHostProcessCount > 0) {
    const status =
      typeof retainedProcessIdentityStatus === "function"
        ? retainedProcessIdentityStatus()
        : "invalid";
    if (status === "invalid") failures.push("owner-child-reap-unverified");
    else if (status !== "absent") failures.push("owner-child-process-live");
  }
  for (const [name, path] of [
    ["runtime-root", state.runtimeNamespace?.root],
    ["tmux-socket", state.runtimeNamespace?.tmuxSocketPath],
    ["host-tmux-socket", state.runtimeNamespace?.hostTmuxSocketPath],
    ["daemon-info", state.runtimeNamespace?.daemonInfoDir],
    ...(state.ownedTuiRuntimeDirs ?? []).map((path) => ["tui-runtime", path]),
  ])
    if (typeof path === "string" && pathExists(path)) failures.push(`${name}-present`);
  return Object.freeze(failures);
}

export function assessProductRigRetainedProcessAbsence(identities, rows) {
  const exactIdentity = (value) =>
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    Number.isSafeInteger(value.pgid) &&
    value.pgid > 0 &&
    typeof value.startToken === "string" &&
    value.startToken.length > 0 &&
    value.startToken.length <= 64;
  if (
    !Array.isArray(identities) ||
    identities.length < 1 ||
    identities.length > 65 ||
    !identities.every(exactIdentity) ||
    new Set(identities.map(({ pid }) => pid)).size !== identities.length ||
    !Array.isArray(rows) ||
    !rows.every(exactIdentity)
  )
    return "invalid";
  return identities.some((identity) =>
    rows.some(
      (row) =>
        row.pid === identity.pid &&
        row.pgid === identity.pgid &&
        row.startToken === identity.startToken,
    ),
  )
    ? "live"
    : "absent";
}

export function isProductRigPendingReapAck(state, request, journeyId) {
  return (
    request?.requestId === state?.cleanup?.requestId &&
    request?.ownerPid === state?.ownerPid &&
    request?.ownerToken === state?.ownerToken &&
    request?.cleanupToken === state?.runtimeNamespace?.cleanupToken &&
    state?.cleanup?.status === "passed" &&
    state?.cleanup?.processReap?.version === 1 &&
    ["cross-client-handoff", "daemon-restart"].includes(journeyId)
  );
}

export function retireProductRigCleanupProofFiles({ removeAck, removeLedger }) {
  if (typeof removeAck !== "function" || typeof removeLedger !== "function")
    throw new TypeError("ProductRig cleanup proof retirement contract was invalid");
  removeAck();
  removeLedger();
}

const exactLegacyProcessRow = (row) =>
  row !== null &&
  typeof row === "object" &&
  !Array.isArray(row) &&
  Number.isSafeInteger(row.pid) &&
  row.pid > 0 &&
  Number.isSafeInteger(row.ppid) &&
  row.ppid >= 0 &&
  Number.isSafeInteger(row.pgid) &&
  row.pgid > 0 &&
  typeof row.state === "string" &&
  row.state.length > 0 &&
  row.state.length <= 16 &&
  typeof row.startToken === "string" &&
  row.startToken.length > 0 &&
  row.startToken.length <= 64 &&
  typeof row.command === "string" &&
  row.command.length > 0 &&
  row.command.length <= 4096;

const exactLegacyProcessRoutingRow = (row) =>
  row !== null &&
  typeof row === "object" &&
  !Array.isArray(row) &&
  Number.isSafeInteger(row.pid) &&
  row.pid > 0 &&
  Number.isSafeInteger(row.ppid) &&
  row.ppid >= 0 &&
  Number.isSafeInteger(row.pgid) &&
  row.pgid > 0 &&
  typeof row.state === "string" &&
  typeof row.startToken === "string" &&
  typeof row.command === "string";

const sameLegacyProcessIdentity = (left, right) =>
  left.pid === right.pid &&
  left.ppid === right.ppid &&
  left.pgid === right.pgid &&
  left.startToken === right.startToken &&
  left.command === right.command &&
  left.ownership === right.ownership;

export function assessLegacyProductRigOwnerRetryCompatibility(
  state,
  authorization,
  firstRows,
  secondRows,
  { processAlive, pathExists },
) {
  const card5 = state?.cleanup?.card5;
  const exactRows = (rows) =>
    Array.isArray(rows) &&
    rows.length <= 4096 &&
    rows.every(exactLegacyProcessRoutingRow) &&
    new Set(rows.map(({ pid }) => pid)).size === rows.length;
  const selectOwner = (rows) => {
    const owner = rows.filter(({ pid }) => pid === state?.ownerPid);
    if (owner.length !== 1 || !exactLegacyProcessRow(owner[0])) return null;
    if (
      rows.some(
        (row) =>
          row.pid !== owner[0].pid &&
          (row.ppid === owner[0].pid ||
            (row.pgid === owner[0].pgid && row.command.includes(authorization.runtimeRoot))),
      )
    )
      return null;
    return { ...owner[0], ownership: "owner" };
  };
  const firstOwner = exactRows(firstRows) ? selectOwner(firstRows) : null;
  const secondOwner = exactRows(secondRows) ? selectOwner(secondRows) : null;
  const paths = [
    state?.runtimeNamespace?.root,
    state?.runtimeNamespace?.tmuxSocketPath,
    state?.runtimeNamespace?.hostTmuxSocketPath,
    state?.runtimeNamespace?.daemonInfoDir,
    ...(Array.isArray(state?.ownedTuiRuntimeDirs) ? state.ownedTuiRuntimeDirs : []),
  ];
  const exact =
    state?.status === "cleanup-failed" &&
    /^legacy-[0-9a-f]{24}$/u.test(authorization?.requestId ?? "") &&
    /^[0-9a-f]{48}$/u.test(authorization?.ownerToken ?? "") &&
    /^\/tmp\/tmi-e2e-[A-Za-z0-9._-]{1,160}$/u.test(authorization?.runtimeRoot ?? "") &&
    state?.diagnosticAttempt?.runId === authorization?.runId &&
    state?.ownerToken === authorization?.ownerToken &&
    state?.runtimeNamespace?.root === authorization?.runtimeRoot &&
    state?.diagnosticAttempt?.sourceProvenance?.commit === authorization?.commit &&
    state?.diagnosticAttempt?.sourceProvenance?.tree === authorization?.tree &&
    state?.diagnosticAttempt?.sourceProvenance?.manifestDigest === authorization?.manifestDigest &&
    state?.cleanup?.status === "failed" &&
    state.cleanup.failures?.length === 1 &&
    state.cleanup.failures[0]?.subsystem === "card5-cleanup-ledger" &&
    card5?.passed === false &&
    card5?.chromiumProcessCount === 0 &&
    card5?.chromiumDescendantCount === 0 &&
    (card5?.chromiumTerminalProcessCount ?? 0) === 0 &&
    card5?.electronProcessCount === 1 &&
    card5?.electronDescendantCount === 0 &&
    (card5?.electronTerminalProcessCount ?? 0) === 0 &&
    card5?.owners?.electron?.owned === true &&
    card5?.owners?.electron?.retired === false &&
    card5?.owners?.chromium?.retired === true &&
    card5?.owners?.opentui?.retired === true &&
    card5?.owners?.daemon?.retired === true &&
    card5?.owners?.namespace?.retired === true &&
    [
      "chromiumPageCount",
      "chromiumContextCount",
      "chromiumListenerCount",
      "electronWindowCount",
      "electronListenerCount",
      "electronOpenHandleCount",
      "socketResidueCount",
      "nativeObserverProcessCount",
      "pathResidueCount",
    ].every((key) => card5?.[key] === 0) &&
    firstOwner !== null &&
    secondOwner !== null &&
    sameLegacyProcessIdentity(firstOwner, secondOwner) &&
    typeof processAlive === "function" &&
    !processAlive(state?.daemon?.pid) &&
    typeof pathExists === "function" &&
    paths.every((path) => typeof path !== "string" || !pathExists(path));
  return Object.freeze({
    passed: exact === true,
    reason: exact ? null : "legacy-owner-retry-invalid",
  });
}

export function createLegacyProductRigOwnerRetryIntent(state, authorization, ownerIdentity) {
  if (
    !/^legacy-[0-9a-f]{24}$/u.test(authorization?.requestId ?? "") ||
    !/^[0-9a-f]{48}$/u.test(authorization?.ownerToken ?? "") ||
    state?.ownerToken !== authorization.ownerToken ||
    !exactLegacyProcessRow(ownerIdentity) ||
    ownerIdentity.pid !== state.ownerPid
  )
    return null;
  const payload = {
    version: 1,
    mode: "legacy-owner-retry-v1",
    requestId: authorization.requestId,
    runId: authorization.runId,
    ownerPid: state.ownerPid,
    ownerIdentity: {
      pid: ownerIdentity.pid,
      ppid: ownerIdentity.ppid,
      pgid: ownerIdentity.pgid,
      startToken: ownerIdentity.startToken,
      command: ownerIdentity.command,
    },
    cleanupToken: state.runtimeNamespace?.cleanupToken,
    provenance: {
      commit: authorization.commit,
      tree: authorization.tree,
      manifestDigest: authorization.manifestDigest,
    },
    runtimeRoot: authorization.runtimeRoot,
    initialCleanupHmac: createHmac("sha256", Buffer.from(authorization.ownerToken, "hex"))
      .update(JSON.stringify(state.cleanup))
      .digest("hex"),
  };
  return Object.freeze({
    ...payload,
    intentHmac: createHmac("sha256", Buffer.from(authorization.ownerToken, "hex"))
      .update(JSON.stringify(payload))
      .digest("hex"),
  });
}

export function acquireLegacyProductRigOwnerRetryIntent(authorization, intent) {
  if (
    intent?.version !== 1 ||
    intent?.mode !== "legacy-owner-retry-v1" ||
    intent.requestId !== authorization?.requestId ||
    intent.runId !== authorization?.runId ||
    intent.runtimeRoot !== authorization?.runtimeRoot ||
    intent.provenance?.commit !== authorization?.commit ||
    intent.provenance?.tree !== authorization?.tree ||
    intent.provenance?.manifestDigest !== authorization?.manifestDigest ||
    !Number.isSafeInteger(intent.ownerPid) ||
    intent.ownerPid < 1 ||
    !exactLegacyProcessRow({ ...intent.ownerIdentity, state: "S" }) ||
    intent.ownerIdentity.pid !== intent.ownerPid ||
    typeof intent.cleanupToken !== "string" ||
    !/^[0-9a-f]{64}$/u.test(intent.initialCleanupHmac ?? "") ||
    !/^[0-9a-f]{64}$/u.test(intent.intentHmac ?? "") ||
    !/^[0-9a-f]{48}$/u.test(authorization?.ownerToken ?? "")
  )
    return null;
  const { intentHmac, ...payload } = intent;
  const expected = createHmac("sha256", Buffer.from(authorization.ownerToken, "hex"))
    .update(JSON.stringify(payload))
    .digest("hex");
  return expected === intentHmac ? Object.freeze({ ...intent }) : null;
}

export function legacyProductRigOwnerRetryIntentMatchesOwnerRows(intent, rows) {
  if (!Array.isArray(rows) || !intent?.ownerIdentity) return false;
  const matches = rows.filter(({ pid }) => pid === intent.ownerPid);
  if (matches.length !== 1 || !exactLegacyProcessRow(matches[0])) return false;
  const identity = {
    pid: matches[0].pid,
    ppid: matches[0].ppid,
    pgid: matches[0].pgid,
    startToken: matches[0].startToken,
    command: matches[0].command,
  };
  return JSON.stringify(identity) === JSON.stringify(intent.ownerIdentity);
}

export function legacyProductRigOwnerRetryIntentMatchesState(state, authorization, intent) {
  const acquired = acquireLegacyProductRigOwnerRetryIntent(authorization, intent);
  if (
    acquired === null ||
    state?.status !== "cleanup-failed" ||
    state?.ownerPid !== acquired.ownerPid ||
    state?.ownerToken !== authorization?.ownerToken ||
    state?.diagnosticAttempt?.runId !== acquired.runId ||
    state?.runtimeNamespace?.root !== acquired.runtimeRoot ||
    state?.runtimeNamespace?.cleanupToken !== acquired.cleanupToken ||
    state?.diagnosticAttempt?.sourceProvenance?.commit !== acquired.provenance.commit ||
    state?.diagnosticAttempt?.sourceProvenance?.tree !== acquired.provenance.tree ||
    state?.diagnosticAttempt?.sourceProvenance?.manifestDigest !==
      acquired.provenance.manifestDigest
  )
    return false;
  const cleanupHmac = createHmac("sha256", Buffer.from(authorization.ownerToken, "hex"))
    .update(JSON.stringify(state.cleanup))
    .digest("hex");
  return cleanupHmac === acquired.initialCleanupHmac;
}

export function createLegacyProductRigOwnerRetryShutdownRequest(state, authorization, intent) {
  if (!legacyProductRigOwnerRetryIntentMatchesState(state, authorization, intent)) return null;
  return Object.freeze({
    version: 1,
    requestId: authorization.requestId,
    attempt: 1,
    ownerPid: state.ownerPid,
    ownerToken: state.ownerToken,
    cleanupToken: state.runtimeNamespace.cleanupToken,
  });
}

export function createLegacyProductRigOwnerRetryReceipt(intent, authorization) {
  const acquired = acquireLegacyProductRigOwnerRetryIntent(authorization, intent);
  if (acquired === null) return null;
  const payload = {
    version: 1,
    mode: "legacy-owner-retry-v1",
    requestId: acquired.requestId,
    runId: acquired.runId,
    ownerPid: acquired.ownerPid,
    provenance: acquired.provenance,
    runtimeRoot: acquired.runtimeRoot,
    intentHmac: acquired.intentHmac,
    status: "absent",
  };
  return Object.freeze({
    ...payload,
    receiptHmac: createHmac("sha256", Buffer.from(authorization.ownerToken, "hex"))
      .update(JSON.stringify(payload))
      .digest("hex"),
  });
}

export function acquireLegacyProductRigOwnerRetryReceipt(authorization, receipt, intent = null) {
  if (
    receipt?.version !== 1 ||
    receipt?.mode !== "legacy-owner-retry-v1" ||
    receipt.requestId !== authorization?.requestId ||
    receipt.runId !== authorization?.runId ||
    receipt.runtimeRoot !== authorization?.runtimeRoot ||
    receipt.provenance?.commit !== authorization?.commit ||
    receipt.provenance?.tree !== authorization?.tree ||
    receipt.provenance?.manifestDigest !== authorization?.manifestDigest ||
    !Number.isSafeInteger(receipt.ownerPid) ||
    receipt.ownerPid < 1 ||
    !/^[0-9a-f]{64}$/u.test(receipt.intentHmac ?? "") ||
    receipt.status !== "absent" ||
    !/^[0-9a-f]{64}$/u.test(receipt.receiptHmac ?? "") ||
    !/^[0-9a-f]{48}$/u.test(authorization?.ownerToken ?? "")
  )
    return null;
  if (intent !== null) {
    const acquiredIntent = acquireLegacyProductRigOwnerRetryIntent(authorization, intent);
    if (acquiredIntent === null || acquiredIntent.intentHmac !== receipt.intentHmac) return null;
  }
  const { receiptHmac, ...payload } = receipt;
  const expected = createHmac("sha256", Buffer.from(authorization.ownerToken, "hex"))
    .update(JSON.stringify(payload))
    .digest("hex");
  return expected === receiptHmac ? Object.freeze({ ...receipt }) : null;
}

export function assessLegacyProductRigOwnerRetryCompletion(
  initialState,
  finalState,
  requestId,
  { processAlive, pathExists, processRows },
) {
  const card5 = finalState?.cleanup?.card5;
  const owners = card5?.owners;
  const paths = [
    finalState?.runtimeNamespace?.root,
    finalState?.runtimeNamespace?.tmuxSocketPath,
    finalState?.runtimeNamespace?.hostTmuxSocketPath,
    finalState?.runtimeNamespace?.daemonInfoDir,
    ...(Array.isArray(finalState?.ownedTuiRuntimeDirs) ? finalState.ownedTuiRuntimeDirs : []),
  ];
  const requiredZeroAxes = [
    "chromiumProcessCount",
    "chromiumDescendantCount",
    "chromiumPageCount",
    "chromiumContextCount",
    "chromiumListenerCount",
    "electronProcessCount",
    "electronDescendantCount",
    "electronWindowCount",
    "electronListenerCount",
    "electronOpenHandleCount",
    "socketResidueCount",
    "nativeObserverProcessCount",
    "pathResidueCount",
  ];
  const exact =
    typeof requestId === "string" &&
    requestId.length > 0 &&
    finalState?.ownerPid === initialState?.ownerPid &&
    finalState?.ownerToken === initialState?.ownerToken &&
    finalState?.runtimeNamespace?.root === initialState?.runtimeNamespace?.root &&
    finalState?.runtimeNamespace?.cleanupToken === initialState?.runtimeNamespace?.cleanupToken &&
    finalState?.cleanup?.requestId === requestId &&
    finalState.cleanup.cleanupToken === initialState.runtimeNamespace.cleanupToken &&
    finalState.cleanup.status === "passed" &&
    Array.isArray(finalState.cleanup.failures) &&
    finalState.cleanup.failures.length === 0 &&
    ["failed", "stopped"].includes(finalState.status) &&
    card5?.passed === true &&
    requiredZeroAxes.every((key) => card5?.[key] === 0) &&
    ["chromiumTerminalProcessCount", "electronTerminalProcessCount"].every(
      (key) => card5?.[key] === undefined || card5[key] === 0,
    ) &&
    owners &&
    ["chromium", "electron", "opentui", "daemon", "namespace"].every(
      (name) => owners[name]?.retired === true,
    ) &&
    typeof processAlive === "function" &&
    !processAlive(finalState.ownerPid) &&
    !processAlive(finalState.daemon?.pid) &&
    Array.isArray(processRows) &&
    processRows.length <= 4096 &&
    processRows.every(exactLegacyProcessRoutingRow) &&
    new Set(processRows.map(({ pid }) => pid)).size === processRows.length &&
    !processRows.some(
      (row) =>
        row.pid === finalState.ownerPid ||
        row.ppid === finalState.ownerPid ||
        row.pgid === finalState.ownerPid ||
        row.command === "(Electron)" ||
        row.command.includes(finalState.runtimeNamespace.root),
    ) &&
    typeof pathExists === "function" &&
    paths.every((path) => typeof path !== "string" || !pathExists(path));
  return Object.freeze({
    passed: exact === true,
    reason: exact ? null : "legacy-owner-retry-incomplete",
  });
}

export function finalizeLegacyProductRigOwnerRetry(
  state,
  authorization,
  intent,
  existingReceipt,
  { processAlive, pathExists, processRows, writeReceipt, writeState, removeAck, removeIntent },
) {
  const receipt = existingReceipt
    ? acquireLegacyProductRigOwnerRetryReceipt(authorization, existingReceipt, intent)
    : intent
      ? createLegacyProductRigOwnerRetryReceipt(intent, authorization)
      : null;
  if (receipt === null)
    return Object.freeze({ passed: false, reason: "legacy-owner-retry-receipt-invalid" });
  const completion = assessLegacyProductRigOwnerRetryCompletion(
    {
      ownerPid: receipt.ownerPid,
      ownerToken: authorization?.ownerToken,
      runtimeNamespace: {
        root: receipt.runtimeRoot,
        cleanupToken: state?.runtimeNamespace?.cleanupToken,
      },
    },
    state,
    receipt.requestId,
    { processAlive, pathExists, processRows },
  );
  if (!completion.passed) return completion;
  if (typeof writeReceipt !== "function" || typeof writeState !== "function")
    return Object.freeze({ passed: false, reason: "legacy-owner-retry-writer-invalid" });
  if (!existingReceipt) writeReceipt(receipt);
  const completed = Object.freeze({
    ...state,
    cleanup: {
      ...state.cleanup,
      legacyOwnerRetry: {
        version: 1,
        requestId: receipt.requestId,
        intentHmac: receipt.intentHmac,
        receiptHmac: receipt.receiptHmac,
        status: "absent",
      },
    },
  });
  writeState(completed);
  retireProductRigCleanupProofFiles({ removeAck, removeLedger: removeIntent });
  return Object.freeze({ passed: true, reason: null, state: completed, receipt });
}

export async function captureLegacyProductRigCleanupLedger(
  state,
  authorization,
  { readProcessRows, yieldTurn = () => Promise.resolve() },
) {
  const provenance = state?.diagnosticAttempt?.sourceProvenance;
  if (
    state?.status !== "cleanup-failed" ||
    state?.diagnosticAttempt?.runId !== authorization?.runId ||
    state?.ownerToken !== authorization?.ownerToken ||
    state?.runtimeNamespace?.root !== authorization?.runtimeRoot ||
    provenance?.commit !== authorization?.commit ||
    provenance?.tree !== authorization?.tree ||
    provenance?.manifestDigest !== authorization?.manifestDigest ||
    !/^\/tmp\/tmi-e2e-[A-Za-z0-9._-]{1,160}$/u.test(authorization?.runtimeRoot ?? "") ||
    !/^legacy-[0-9a-f]{24}$/u.test(authorization?.requestId ?? "") ||
    !/^[0-9a-f]{48}$/u.test(authorization?.ownerToken ?? "") ||
    typeof readProcessRows !== "function"
  )
    return null;
  const select = (rows) => {
    if (
      !Array.isArray(rows) ||
      rows.length > 4096 ||
      !rows.every(exactLegacyProcessRoutingRow) ||
      new Set(rows.map(({ pid }) => pid)).size !== rows.length
    )
      return null;
    const owner = rows.filter(({ pid }) => pid === state.ownerPid);
    if (owner.length !== 1 || !exactLegacyProcessRow(owner[0])) return null;
    const selected = new Map([[owner[0].pid, { ...owner[0], ownership: "owner" }]]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (!selected.has(row.pid) && selected.has(row.ppid)) {
          if (!exactLegacyProcessRow(row)) return null;
          selected.set(row.pid, { ...row, ownership: "descendant" });
          changed = true;
        }
      }
    }
    for (const row of rows)
      if (
        !selected.has(row.pid) &&
        row.pgid === owner[0].pgid &&
        row.command.includes(authorization.runtimeRoot)
      ) {
        if (!exactLegacyProcessRow(row)) return null;
        selected.set(row.pid, { ...row, ownership: "scoped-pgid" });
      }
    const identities = [...selected.values()].sort((a, b) => a.pid - b.pid);
    if (
      identities.length > 65 ||
      new Set(identities.map(({ pid }) => pid)).size !== identities.length
    )
      return null;
    return identities;
  };
  const first = select(readProcessRows());
  if (!first) return null;
  const expectedHostCount = [
    "chromiumProcessCount",
    "chromiumDescendantCount",
    "chromiumTerminalProcessCount",
    "electronProcessCount",
    "electronDescendantCount",
    "electronTerminalProcessCount",
  ].reduce((sum, key) => sum + (state.cleanup?.card5?.[key] ?? 0), 0);
  if (first.length < 1 + expectedHostCount) return null;
  await yieldTurn();
  const second = select(readProcessRows());
  if (
    !second ||
    second.length > first.length ||
    !second.every((identity) => {
      const prior = first.find(({ pid }) => pid === identity.pid);
      return prior && sameLegacyProcessIdentity(prior, identity);
    }) ||
    !second.some(({ ownership }) => ownership === "owner")
  )
    return null;
  const identityHmac = createHmac("sha256", Buffer.from(authorization.ownerToken, "hex"))
    .update(JSON.stringify(first))
    .digest("hex");
  return Object.freeze({
    version: 1,
    mode: "legacy-cleanup-v1",
    requestId: authorization.requestId,
    runId: authorization.runId,
    ownerPid: state.ownerPid,
    cleanupToken: state.runtimeNamespace.cleanupToken,
    provenance: Object.freeze({ ...provenance }),
    runtimeRoot: authorization.runtimeRoot,
    identities: Object.freeze(first.map((identity) => Object.freeze(identity))),
    identityHmac,
  });
}

export function acquireLegacyProductRigCleanupLedger(state, authorization, ledger) {
  const provenance = state?.diagnosticAttempt?.sourceProvenance;
  const cleanupFailed =
    ["cleanup-failed", "failed"].includes(state?.status) && state?.cleanup?.status === "failed";
  const cleanupCompleted =
    state?.status === "failed" &&
    state?.cleanup?.status === "passed" &&
    state?.cleanup?.card5?.passed === true &&
    Array.isArray(state?.cleanup?.failures) &&
    state.cleanup.failures.length === 0 &&
    state?.cleanup?.processReap?.version === 1 &&
    state.cleanup.processReap.identityCount === ledger?.identities?.length &&
    state.cleanup.processReap.terminalIdentityCount === ledger?.identities?.length - 1 &&
    state.cleanup.processReap.identityHmac === ledger?.identityHmac;
  if (
    (!cleanupFailed && !cleanupCompleted) ||
    state?.diagnosticAttempt?.runId !== authorization?.runId ||
    state?.ownerToken !== authorization?.ownerToken ||
    state?.runtimeNamespace?.root !== authorization?.runtimeRoot ||
    ledger?.version !== 1 ||
    ledger?.mode !== "legacy-cleanup-v1" ||
    ledger.requestId !== authorization?.requestId ||
    ledger.runId !== authorization?.runId ||
    ledger.ownerPid !== state?.ownerPid ||
    ledger.cleanupToken !== state?.runtimeNamespace?.cleanupToken ||
    ledger.runtimeRoot !== authorization?.runtimeRoot ||
    ledger.provenance?.commit !== authorization?.commit ||
    ledger.provenance?.tree !== authorization?.tree ||
    ledger.provenance?.manifestDigest !== authorization?.manifestDigest ||
    provenance?.commit !== authorization?.commit ||
    provenance?.tree !== authorization?.tree ||
    provenance?.manifestDigest !== authorization?.manifestDigest ||
    !/^legacy-[0-9a-f]{24}$/u.test(authorization?.requestId ?? "") ||
    !Array.isArray(ledger.identities) ||
    ledger.identities.length < 1 ||
    ledger.identities.length > 65 ||
    !ledger.identities.every(
      (identity) =>
        exactLegacyProcessRow(identity) &&
        ["owner", "descendant", "scoped-pgid"].includes(identity.ownership),
    ) ||
    ledger.identities.filter(({ ownership }) => ownership === "owner").length !== 1 ||
    ledger.identities.find(({ ownership }) => ownership === "owner")?.pid !== state?.ownerPid ||
    new Set(ledger.identities.map(({ pid }) => pid)).size !== ledger.identities.length ||
    !/^[0-9a-f]{48}$/u.test(authorization?.ownerToken ?? "")
  )
    return null;
  const identityHmac = createHmac("sha256", Buffer.from(authorization.ownerToken, "hex"))
    .update(JSON.stringify(ledger.identities))
    .digest("hex");
  return identityHmac === ledger.identityHmac
    ? Object.freeze({
        ...ledger,
        provenance: Object.freeze({ ...ledger.provenance }),
        identities: Object.freeze(
          ledger.identities.map((identity) => Object.freeze({ ...identity })),
        ),
      })
    : null;
}

export function assessLegacyProductRigCleanupAdmission(
  state,
  ledger,
  { processAlive, pathExists },
) {
  const cleanup = state?.cleanup;
  const card5 = cleanup?.card5;
  const owners = card5?.owners;
  const failure = cleanup?.failures?.[0];
  const hostCount = (host) => {
    const values = [
      card5?.[`${host}ProcessCount`],
      card5?.[`${host}DescendantCount`],
      card5?.[`${host}TerminalProcessCount`] ?? 0,
    ];
    return values.every((value) => Number.isSafeInteger(value) && value >= 0)
      ? values.reduce((sum, value) => sum + value, 0)
      : -1;
  };
  const paths = [
    state?.runtimeNamespace?.root,
    state?.runtimeNamespace?.tmuxSocketPath,
    state?.runtimeNamespace?.hostTmuxSocketPath,
    state?.runtimeNamespace?.daemonInfoDir,
    ...(Array.isArray(state?.ownedTuiRuntimeDirs) ? state.ownedTuiRuntimeDirs : []),
  ];
  const exactOwners = ["chromium", "electron", "opentui", "daemon", "namespace"];
  const valid =
    acquireLegacyProductRigCleanupLedger(
      state,
      {
        requestId: ledger?.requestId,
        runId: ledger?.runId,
        ownerToken: state?.ownerToken,
        commit: ledger?.provenance?.commit,
        tree: ledger?.provenance?.tree,
        manifestDigest: ledger?.provenance?.manifestDigest,
        runtimeRoot: ledger?.runtimeRoot,
      },
      ledger,
    ) !== null &&
    cleanup?.status === "failed" &&
    Array.isArray(cleanup.failures) &&
    cleanup.failures.length === 1 &&
    failure?.subsystem === "card5-cleanup-ledger" &&
    typeof failure?.detail === "string" &&
    failure.detail.length > 0 &&
    failure.detail.length <= 256 &&
    card5?.passed === false &&
    owners &&
    Object.keys(owners).sort().join("\0") === [...exactOwners].sort().join("\0") &&
    exactOwners.every(
      (name) =>
        typeof owners[name]?.owned === "boolean" && typeof owners[name]?.retired === "boolean",
    ) &&
    owners.opentui.retired === true &&
    owners.daemon.retired === true &&
    owners.namespace.retired === true &&
    ["chromium", "electron"].every((host) => {
      const count = hostCount(host);
      return (
        count >= 0 && (count > 0 ? owners[host].owned === true : owners[host].retired === true)
      );
    }) &&
    [
      "chromiumPageCount",
      "chromiumContextCount",
      "chromiumListenerCount",
      "electronWindowCount",
      "electronListenerCount",
      "electronOpenHandleCount",
      "socketResidueCount",
      "nativeObserverProcessCount",
      "pathResidueCount",
    ].every((key) => card5?.[key] === 0) &&
    typeof processAlive === "function" &&
    !processAlive(state?.daemon?.pid) &&
    typeof pathExists === "function" &&
    paths.every((path) => typeof path !== "string" || !pathExists(path));
  return Object.freeze({
    passed: valid === true,
    reason: valid ? null : "legacy-admission-invalid",
  });
}

export async function retireLegacyProductRigCleanupIdentities(
  ledger,
  { readProcessRows, signalProcess, sleep, termWaitMs = 2_000, killWaitMs = 500 },
) {
  if (
    ledger?.version !== 1 ||
    ledger?.mode !== "legacy-cleanup-v1" ||
    !Array.isArray(ledger.identities) ||
    ledger.identities.length < 1 ||
    ledger.identities.length > 65 ||
    typeof readProcessRows !== "function" ||
    typeof signalProcess !== "function" ||
    typeof sleep !== "function"
  )
    return Object.freeze({ passed: false, reason: "legacy-ledger-invalid" });
  const same = (identity, row) =>
    row &&
    identity.pid === row.pid &&
    identity.ppid === row.ppid &&
    identity.pgid === row.pgid &&
    identity.startToken === row.startToken &&
    identity.command === row.command;
  const current = (identity) => {
    const rows = readProcessRows();
    if (!Array.isArray(rows) || !rows.every(exactLegacyProcessRow)) return "unavailable";
    const row = rows.find(({ pid }) => pid === identity.pid);
    return row ? (same(identity, row) ? row : "reused") : null;
  };
  const depth = (identity) => {
    let value = 0;
    let parent = identity.ppid;
    while (
      ledger.identities.some(({ pid }) => pid === parent) &&
      value <= ledger.identities.length
    ) {
      value += 1;
      parent = ledger.identities.find(({ pid }) => pid === parent)?.ppid;
    }
    return value;
  };
  const childrenFirst = [...ledger.identities].sort((a, b) => depth(b) - depth(a));
  const signalExact = (signal) => {
    for (const identity of childrenFirst) {
      const row = current(identity);
      if (row === "unavailable") return false;
      if (row === null || row === "reused" || /[EZ]/u.test(row.state)) continue;
      try {
        signalProcess(identity.pid, signal);
      } catch {
        // A retained process may retire after its immediate identity check.
      }
    }
    return true;
  };
  if (!signalExact("SIGTERM"))
    return Object.freeze({ passed: false, reason: "legacy-identity-unavailable" });
  await sleep(termWaitMs);
  if (!signalExact("SIGKILL"))
    return Object.freeze({ passed: false, reason: "legacy-identity-unavailable" });
  await sleep(killWaitMs);
  const rows = readProcessRows();
  const absence = assessProductRigRetainedProcessAbsence(ledger.identities, rows);
  return Object.freeze({
    passed: absence === "absent",
    reason: absence === "absent" ? null : `legacy-identity-${absence}`,
  });
}

/**
 * One-way compatibility for stopped ProductRig v1 state written before exact
 * cleanup receipts existed. This is admission only: start() retains ownership
 * of deleting the stale rig directory after the barrier passes.
 */
export function isCleanLegacyStoppedProductRigState(
  state,
  { processAlive: isAlive, pathExists = existsSync },
) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return false;
  if (Object.prototype.hasOwnProperty.call(state, "cleanup") || state.cleanup !== undefined)
    return false;
  if (
    state.version !== 1 ||
    state.status !== "stopped" ||
    Object.prototype.hasOwnProperty.call(state, "ownerToken") ||
    state.ownerToken !== undefined
  )
    return false;
  if (!Number.isSafeInteger(state.ownerPid) || state.ownerPid <= 0 || isAlive(state.ownerPid))
    return false;
  if (
    !state.daemon ||
    typeof state.daemon !== "object" ||
    !Number.isSafeInteger(state.daemon.pid) ||
    state.daemon.pid <= 0 ||
    isAlive(state.daemon.pid) ||
    typeof state.daemon.instanceId !== "string" ||
    state.daemon.instanceId.length === 0 ||
    state.daemon.instanceId.length > 128
  )
    return false;
  const namespace = state.runtimeNamespace;
  if (
    !namespace ||
    typeof namespace !== "object" ||
    typeof namespace.cleanupToken !== "string" ||
    namespace.cleanupToken.length === 0 ||
    namespace.cleanupToken.length > 256
  )
    return false;
  const root = namespace.root;
  const childPaths = [
    namespace.tmuxSocketPath,
    namespace.hostTmuxSocketPath,
    namespace.daemonInfoDir,
  ];
  if (
    typeof root !== "string" ||
    !isAbsolute(root) ||
    root === sep ||
    resolve(root) !== root ||
    pathExists(root) ||
    childPaths.some(
      (ownedPath) =>
        typeof ownedPath !== "string" ||
        !isAbsolute(ownedPath) ||
        resolve(ownedPath) !== ownedPath ||
        !ownedPath.startsWith(`${root}${sep}`) ||
        pathExists(ownedPath),
    )
  )
    return false;
  return true;
}

export function productRigCleanupAcknowledgesRequest(state, requestId) {
  if (!state || typeof state !== "object") return false;
  if (state.cleanup?.requestId === requestId) return true;
  return (
    state.cleanup?.status === "passed" &&
    typeof state.cleanup?.requestId === "string" &&
    ["stopped", "failed"].includes(state.status)
  );
}

export async function collectProductRigCleanupFailures(steps, { detailLimit = 4_000 } = {}) {
  const failures = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      const detail = String(error instanceof Error ? error.message : error);
      failures.push(
        Object.freeze({
          subsystem: step.subsystem,
          detail: detail.length <= detailLimit ? detail : detail.slice(-detailLimit),
        }),
      );
    }
  }
  return Object.freeze(failures);
}

export function bufferOwnedTuiRuntimeEvidence({
  ownedRuntimeDirs,
  activeTui,
  artifactDir,
  pathExists,
  ensureArtifactDir,
  moveRuntimeDir,
  onActiveTuiRelocated = () => undefined,
}) {
  let bufferedTui = activeTui;
  ensureArtifactDir(artifactDir);
  const relocateActiveTui = (runtimeDir, bufferedRuntimeDir) => {
    if (bufferedTui?.runtimeDir !== runtimeDir) return;
    const relocate = (path) =>
      typeof path === "string" && path.startsWith(`${runtimeDir}${sep}`)
        ? join(bufferedRuntimeDir, path.slice(runtimeDir.length + 1))
        : path;
    bufferedTui = Object.freeze({
      ...bufferedTui,
      runtimeDir: bufferedRuntimeDir,
      performanceTracePath: relocate(bufferedTui.performanceTracePath),
    });
    onActiveTuiRelocated(bufferedTui);
  };
  for (const [index, runtimeDir] of ownedRuntimeDirs.entries()) {
    const bufferedRuntimeDir = join(artifactDir, `tui-runtime-${index + 1}`);
    const sourceExists = pathExists(runtimeDir);
    const destinationExists = pathExists(bufferedRuntimeDir);
    if (!sourceExists && destinationExists) {
      relocateActiveTui(runtimeDir, bufferedRuntimeDir);
      continue;
    }
    if (!sourceExists) continue;
    if (destinationExists) throw new Error("buffered TUI evidence destination already exists");
    moveRuntimeDir(runtimeDir, bufferedRuntimeDir);
    relocateActiveTui(runtimeDir, bufferedRuntimeDir);
  }
  return bufferedTui;
}

export function prepareOwnedTuiRuntime({
  ownership,
  intendedTui,
  ownedTuiRuntimeDirs = [],
  publish,
  resolveProvenance,
  createRuntimeDir,
}) {
  const ownedRuntimeDirs = [...new Set([...ownedTuiRuntimeDirs, intendedTui.runtimeDir])];
  publish({ ...ownership, tui: intendedTui, ownedTuiRuntimeDirs: ownedRuntimeDirs });
  const provenance = resolveProvenance();
  const tui = Object.freeze({
    ...intendedTui,
    performanceTraceCommit: provenance.commit,
    performanceTraceTree: provenance.tree,
    performanceTraceManifestDigest: provenance.manifestDigest ?? null,
  });
  publish({ tui });
  createRuntimeDir(tui.runtimeDir);
  return tui;
}

export async function startOwnedProductRigDaemon({ start, publish, waitUntilReady }) {
  publish({ daemonLifecycle: "starting" });
  const daemon = await start();
  publish({ daemonLifecycle: "started", daemon: daemon.record });
  await waitUntilReady(daemon);
  return daemon;
}

/**
 * Internal owner failures may try cleanup immediately, but a failed attempt
 * must keep the token-valid owner alive for the controller's exact retry.
 */
export async function settleInternalProductRigCleanup({
  cleanup,
  maxImmediateAttempts,
  onTerminal,
  onRetryable,
}) {
  let result = null;
  for (let attempt = 1; attempt <= maxImmediateAttempts; attempt += 1) {
    result = await cleanup(attempt);
    if (result?.passed === true) {
      await onTerminal(result);
      return Object.freeze({ passed: true, attempts: attempt, result });
    }
  }
  await onRetryable(result);
  return Object.freeze({ passed: false, attempts: maxImmediateAttempts, result });
}

export function productDiagnosticRunId({ journeyId, variant = null, repetition, now, nonce }) {
  const timestamp = new Date(now).toISOString().replaceAll(/[-:.TZ]/gu, "");
  const safeJourney = String(journeyId)
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/gu, "-");
  const safeNonce = String(nonce)
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/gu, "")
    .slice(0, 16);
  if (!safeNonce) throw new Error("diagnostic run id requires a non-empty nonce");
  const safeVariant = variant
    ? `-${String(variant)
        .toLowerCase()
        .replaceAll(/[^a-z0-9-]/gu, "-")}`
    : "";
  return `${timestamp}-${safeJourney}${safeVariant}-r${repetition}-${safeNonce}`;
}

export function prepareProductDiagnosticBundlePublication({
  root,
  runId,
  report,
  evidence,
  cleanupReceipt,
}) {
  const exactCleanupReceipt = validateProductRigCleanupReceipt(cleanupReceipt, runId);
  const reportPath = join(root, runId, "report.json");
  if (
    report?.reportPath !== null &&
    report?.reportPath !== undefined &&
    report.reportPath !== reportPath
  )
    throw new Error("diagnostic reportPath does not match its immutable bundle destination");
  const sealedReport = Object.freeze({
    ...report,
    reportPath,
    cleanupReceipt: exactCleanupReceipt,
  });
  return Object.freeze({
    report: sealedReport,
    reportPath,
    evidence: Object.freeze({
      ...evidence,
      report: sealedReport,
      alignment: Object.freeze({
        ...evidence.alignment,
        reportPath,
        cleanupReceipt: exactCleanupReceipt,
      }),
    }),
  });
}

function writeExclusive(path, value, mode = 0o600) {
  const handle = openSync(path, "wx", mode);
  try {
    writeSync(handle, value);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Write the complete evidence set once; an existing run id fails closed. */
export function createProductDiagnosticBundle({ root, runId, evidence }) {
  if (!/^[a-z0-9][a-z0-9-]{0,159}$/u.test(runId))
    throw new Error("diagnostic bundle run id must be a bounded lowercase slug");
  for (const field of ["timeline", "tuiAnsi", "stderr", "reproduction"])
    if (typeof evidence?.[field] !== "string")
      throw new TypeError(`diagnostic bundle ${field} must be a string`);
  for (const field of ["report", "alignment", "tmuxTruth", "daemonState", "clientState"])
    if (!evidence?.[field] || typeof evidence[field] !== "object" || Array.isArray(evidence[field]))
      throw new TypeError(`diagnostic bundle ${field} must be an object`);
  if (typeof evidence.report.runId === "string") {
    const receipt = validateProductRigCleanupReceipt(evidence.report.cleanupReceipt, runId);
    if (JSON.stringify(evidence.alignment.cleanupReceipt) !== JSON.stringify(receipt))
      throw new Error("diagnostic bundle cleanup receipt diverges between report and alignment");
  }
  const webPng = Buffer.isBuffer(evidence.webPng)
    ? evidence.webPng
    : typeof evidence.webPngPath === "string" && existsSync(evidence.webPngPath)
      ? readFileSync(evidence.webPngPath)
      : null;
  if (!webPng) throw new Error("diagnostic bundle web PNG evidence is missing");
  const signature = webPng.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a")
    throw new Error("diagnostic bundle web PNG source is not a PNG");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const runDir = join(root, runId);
  if (existsSync(runDir)) throw new Error(`diagnostic bundle already exists: ${runId}`);
  const temporary = join(root, `.${runId}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  mkdirSync(temporary, { recursive: false, mode: 0o700 });
  try {
    writeExclusive(join(temporary, "report.json"), json(evidence.report));
    writeExclusive(join(temporary, "alignment.json"), json(evidence.alignment));
    writeExclusive(join(temporary, "timeline.jsonl"), evidence.timeline);
    writeExclusive(join(temporary, "tmux-truth.json"), json(evidence.tmuxTruth));
    writeExclusive(join(temporary, "daemon-state.json"), json(evidence.daemonState));
    writeExclusive(join(temporary, "client-state.json"), json(evidence.clientState));
    writeExclusive(join(temporary, "tui.ansi"), evidence.tuiAnsi);
    const copiedPng = join(temporary, "web.png");
    writeExclusive(copiedPng, webPng);
    const pngHandle = openSync(copiedPng, "r");
    try {
      fsyncSync(pngHandle);
    } finally {
      closeSync(pngHandle);
    }
    writeExclusive(join(temporary, "stderr.log"), evidence.stderr);
    writeExclusive(join(temporary, "reproduction.sh"), evidence.reproduction, 0o700);
    for (const file of PRODUCT_DIAGNOSTIC_BUNDLE_FILES) {
      const path = join(temporary, file);
      chmodSync(path, file === "reproduction.sh" ? 0o500 : 0o400);
      const fileHandle = openSync(path, "r");
      try {
        fsyncSync(fileHandle);
      } finally {
        closeSync(fileHandle);
      }
    }
    chmodSync(temporary, 0o500);
    const temporaryHandle = openSync(temporary, "r");
    try {
      fsyncSync(temporaryHandle);
    } finally {
      closeSync(temporaryHandle);
    }
    renameSync(temporary, runDir);
    const rootHandle = openSync(root, "r");
    try {
      fsyncSync(rootHandle);
    } finally {
      closeSync(rootHandle);
    }
  } catch (error) {
    try {
      chmodSync(temporary, 0o700);
    } catch {
      // The temporary may already have been atomically renamed.
    }
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  return Object.freeze({ version: PRODUCT_DIAGNOSTIC_BUNDLE_VERSION, runId, runDir });
}
