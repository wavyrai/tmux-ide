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
import { createHash, randomBytes } from "node:crypto";
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
      implementation: ["configless-cold-start", "coherent-first-pane"].includes(id)
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

  if (failure) {
    const failedResult = await operations.prepareFailure(failure, failureBoundary, cleanupReceipt);
    if (cleanupFailure) operations.appendCleanupFailure(failedResult, cleanupFailure);
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

export function createProductRigCleanupReceipt(entry, state, attempt) {
  const namespace = state?.runtimeNamespace;
  const cleanup = state?.cleanup;
  const ownedPaths = [
    namespace?.root,
    namespace?.tmuxSocketPath,
    namespace?.hostTmuxSocketPath,
    namespace?.daemonInfoDir,
  ];
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
    !Number.isSafeInteger(state?.daemon?.pid) ||
    typeof state.daemon.instanceId !== "string" ||
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
  const daemonDead = dead(state.daemon.pid);
  const pathsAbsent = ownedPaths.every((path) => !existsSync(path));
  const pathAbsence = {
    runtimeRoot: !existsSync(ownedPaths[0]),
    tmuxSocket: !existsSync(ownedPaths[1]),
    hostTmuxSocket: !existsSync(ownedPaths[2]),
    daemonInfo: !existsSync(ownedPaths[3]),
  };
  const receipt = {
    version: 1,
    runId: entry.runId,
    requestId: cleanup.requestId,
    attempt,
    passed: true,
    completedAt: cleanup.completedAt,
    ownerPid: state.ownerPid,
    daemon: { instanceId: state.daemon.instanceId, pid: state.daemon.pid },
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
  const valid =
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
    typeof receipt.daemon?.instanceId === "string" &&
    receipt.daemon.instanceId.length > 0 &&
    receipt.daemon.instanceId.length <= 128 &&
    Number.isSafeInteger(receipt.daemon.pid) &&
    receipt.daemon.pid > 0 &&
    /^[0-9a-f]{64}$/u.test(receipt.namespaceDigest ?? "") &&
    receipt.ownerDead === true &&
    receipt.daemonDead === true &&
    receipt.pathsAbsent === true &&
    receipt.pathAbsence?.runtimeRoot === true &&
    receipt.pathAbsence?.tmuxSocket === true &&
    receipt.pathAbsence?.hostTmuxSocket === true &&
    receipt.pathAbsence?.daemonInfo === true &&
    receipt.failureCount === 0;
  if (!valid) throw new Error("ProductRig cleanup receipt is missing, mismatched, or not passed");
  return Object.freeze({
    version: 1,
    runId: receipt.runId,
    requestId: receipt.requestId,
    attempt: receipt.attempt,
    passed: true,
    completedAt: receipt.completedAt,
    ownerPid: receipt.ownerPid,
    daemon: Object.freeze({ instanceId: receipt.daemon.instanceId, pid: receipt.daemon.pid }),
    namespaceDigest: receipt.namespaceDigest,
    ownerDead: true,
    daemonDead: true,
    pathsAbsent: true,
    pathAbsence: Object.freeze({
      runtimeRoot: true,
      tmuxSocket: true,
      hostTmuxSocket: true,
      daemonInfo: true,
    }),
    failureCount: 0,
  });
}

export function productRigCleanupBarrierFailures(
  state,
  requestId,
  { processAlive: isAlive, pathExists = existsSync },
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
  for (const [name, path] of [
    ["runtime-root", state.runtimeNamespace?.root],
    ["tmux-socket", state.runtimeNamespace?.tmuxSocketPath],
    ["host-tmux-socket", state.runtimeNamespace?.hostTmuxSocketPath],
    ["daemon-info", state.runtimeNamespace?.daemonInfoDir],
  ])
    if (typeof path === "string" && pathExists(path)) failures.push(`${name}-present`);
  return Object.freeze(failures);
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
