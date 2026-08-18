import {
  closeSync,
  chmodSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

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
      implementation: "pending",
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
  return Object.freeze({ complete: missing.length === 0, missing: Object.freeze(missing) });
}

export function parseProductDiagnoseOptions(args) {
  const journeyIds = [];
  let sawJourney = false;
  let repeat = 1;
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
    throw new Error(`unknown diagnose option ${argument}`);
  }
  return Object.freeze({
    json,
    repeat,
    journeyIds: Object.freeze(
      sawJourney ? journeyIds : journeyIds.length > 0 ? journeyIds : ["runtime-qualification"],
    ),
  });
}

export function resolveProductJourneyPlan({ journeyIds, repeat }) {
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
  const pending = selected.filter((journey) => journey.implementation !== "implemented");
  if (pending.length > 0)
    throw new Error(
      `ProductRig journey not implemented: ${pending.map(({ id }) => id).join(", ")}; missing evidence is a failure`,
    );
  return Object.freeze(
    selected.flatMap((journey) =>
      Array.from({ length: repeat }, (_, repetition) =>
        Object.freeze({ journey, repetition: repetition + 1, repeat }),
      ),
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

/** Deterministic lifecycle seam: clean → drive → clean → immutable publish. */
export async function runIsolatedProductJourneyAttempt(entry, operations) {
  let completed = null;
  let failure = null;
  let failureBoundary = null;
  let cleanupFailure = null;
  const phase = (value) => operations.onPhase?.(value);

  phase("pre-attempt-cleanup");
  try {
    await operations.preCleanup();
    phase("product-rig-startup");
    completed = await operations.drive();
  } catch (error) {
    failure = error;
    failureBoundary = operations.currentBoundary();
  }

  phase("attempt-cleanup");
  try {
    await operations.postCleanup();
  } catch (cleanupError) {
    phase("attempt-cleanup-retry");
    try {
      await operations.retryCleanup(cleanupError);
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
    const failedResult = await operations.prepareFailure(failure, failureBoundary);
    if (cleanupFailure) operations.appendCleanupFailure(failedResult, cleanupFailure);
    phase("failure-bundle-publication");
    const bundle = await operations.publishFailure(failedResult);
    throw new ProductJourneyAttemptError(entry, failureBoundary, bundle, failure);
  }
  phase("success-bundle-publication");
  try {
    return await operations.publishSuccess(completed);
  } catch (publicationError) {
    const boundary = "success-bundle-publication";
    const publicationFailure = await operations.prepareFailure(publicationError, boundary);
    const bundle = await operations.publishFailure(publicationFailure);
    throw new ProductJourneyAttemptError(entry, boundary, bundle, publicationError);
  }
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

export function productDiagnosticRunId({ journeyId, repetition, now, nonce }) {
  const timestamp = new Date(now).toISOString().replaceAll(/[-:.TZ]/gu, "");
  const safeJourney = String(journeyId)
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/gu, "-");
  const safeNonce = String(nonce)
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/gu, "")
    .slice(0, 16);
  if (!safeNonce) throw new Error("diagnostic run id requires a non-empty nonce");
  return `${timestamp}-${safeJourney}-r${repetition}-${safeNonce}`;
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
