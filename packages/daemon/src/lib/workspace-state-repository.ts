import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  WorkspaceStateV1SchemaZ,
  type WorkspaceProjectIdentity,
  type WorkspaceStateDiagnostic,
  type WorkspaceStateV1,
} from "@tmux-ide/contracts";

import {
  RevisionConflictError,
  type ProjectRuntimeRepository,
} from "./project-runtime-repository.ts";
import {
  cloneWorkspaceState,
  defaultWorkspaceState,
  migrateWorkspaceUiStateV2,
  parseWorkspaceStateValue,
  serializeWorkspaceState,
} from "./workspace-state.ts";

export const WORKSPACE_STATE_PATH = "workspace/state.json";
export const WORKSPACE_STATE_LOCK_FILENAME = ".state.lock";
const WORKSPACE_STATE_LOCK_MAX_BYTES = 4_096;
const WORKSPACE_STATE_PROCESS_INSTANCE_ID = randomUUID();

export type WorkspaceStateRepositoryDiagnosticCode =
  | WorkspaceStateDiagnostic["code"]
  | "MISSING"
  | "MIGRATED"
  | "READ_FAILED"
  | "WRITE_FAILED"
  | "WRITE_PROTECTED"
  | "STALE"
  | "LOCK_TIMEOUT"
  | "INVALID_STATE"
  | "CONFLICT"
  | "LOCK_RELEASE_FAILED";

export interface WorkspaceStateRepositoryDiagnostic {
  code: WorkspaceStateRepositoryDiagnosticCode;
  path: string;
  message: string;
}

export interface LoadedWorkspaceState {
  state: WorkspaceStateV1;
  revision: number | null;
  writeProtected: boolean;
  diagnostics: WorkspaceStateRepositoryDiagnostic[];
}

export interface LoadWorkspaceStateOptions {
  /** Optional, independently loaded ui/workspace.json V2 payload. It is never mutated. */
  legacyWorkspaceUiState?: unknown;
  checkoutKey?: string;
  projectRoot?: string;
  migratedAt?: string;
}

export interface WorkspaceStateLockOptions {
  timeoutMs?: number;
  pollMs?: number;
  /** @deprecated Existing locks are never reclaimed automatically. */
  staleAfterMs?: number;
}

export type WorkspaceCheckoutSubdomain = "live" | "workbench" | "focus" | "active-layout";

export interface WorkspaceStateMergeOptions {
  /** Explicit checkout field ownership; safe to merge across stale document revisions. */
  checkoutIntents?: ReadonlyMap<string, ReadonlySet<WorkspaceCheckoutSubdomain>>;
  deletedCheckoutKeys?: ReadonlySet<string>;
  /** Layout revision observed before the local edit (`null` for create). */
  layoutBaseRevisions?: ReadonlyMap<string, number | null>;
  documentIsStale?: boolean;
}

export interface WorkspaceStateSaveRequest {
  repository: ProjectRuntimeRepository;
  revision: number | null;
  next: WorkspaceStateV1;
  touchedLayoutIds: ReadonlySet<string>;
  deletedLayoutIds?: ReadonlySet<string>;
  checkoutIntents?: ReadonlyMap<string, ReadonlySet<WorkspaceCheckoutSubdomain>>;
  deletedCheckoutKeys?: ReadonlySet<string>;
  layoutBaseRevisions?: ReadonlyMap<string, number | null>;
  /**
   * @deprecated Use checkoutIntents. A legacy whole-checkout write is accepted
   * only against the document revision it loaded; stale replacement conflicts.
   */
  touchedCheckoutKeys?: ReadonlySet<string>;
  lock?: WorkspaceStateLockOptions;
  maxRevisionRetries?: number;
}

export interface WriteWorkspaceStateResult extends LoadedWorkspaceState {
  saved: boolean;
}

export interface WorkspaceStateLockOwnerInspection {
  version: 1;
  token: string;
  processInstanceId: string;
  pid: number;
  /** Unix epoch milliseconds, reported exactly from the lock's `createdAtMs` field. */
  createdAt: number;
}

export type WorkspaceStateLockInspection =
  | { status: "absent"; lockPath: string }
  | {
      status: "malformed";
      lockPath: string;
      device: number;
      inode: number;
      reason: string;
    }
  | {
      status: "valid";
      lockPath: string;
      owner: WorkspaceStateLockOwnerInspection;
      device: number;
      inode: number;
    };

export interface ClearWorkspaceStateLockOfflineOptions {
  expectedToken: string;
  expectedProcessInstanceId: string;
  expectedDevice: number;
  expectedInode: number;
  confirmAllWritersStopped: true;
}

export interface ClearedWorkspaceStateLock {
  cleared: true;
  lockPath: string;
  owner: WorkspaceStateLockOwnerInspection;
  device: number;
  inode: number;
}

export type WorkspaceStateLockRecoveryErrorCode =
  | "CONFIRMATION_REQUIRED"
  | "LOCK_ABSENT"
  | "LOCK_MALFORMED"
  | "OWNER_MISMATCH"
  | "LOCK_CHANGED"
  | "RECOVERY_FAILED";

export class WorkspaceStateLockRecoveryError extends Error {
  readonly code: WorkspaceStateLockRecoveryErrorCode;
  readonly lockPath: string;

  constructor(code: WorkspaceStateLockRecoveryErrorCode, lockPath: string, message: string) {
    super(message);
    this.name = "WorkspaceStateLockRecoveryError";
    this.code = code;
    this.lockPath = lockPath;
  }
}

export class WorkspaceStateLockTimeoutError extends Error {
  readonly lockPath: string;
  readonly timeoutMs: number;

  constructor(lockPath: string, timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for workspace-state lock "${lockPath}"`);
    this.name = "WorkspaceStateLockTimeoutError";
    this.lockPath = lockPath;
    this.timeoutMs = timeoutMs;
  }
}

export class WorkspaceStateMergeConflictError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = "WorkspaceStateMergeConflictError";
    this.path = path;
  }
}

export function workspaceProjectIdentity(
  repository: ProjectRuntimeRepository,
): WorkspaceProjectIdentity {
  return {
    identityKey: repository.metadata.identityKey,
    identitySource: repository.metadata.identitySource,
    identityAnchor: repository.metadata.identityAnchor,
  };
}

/** Checkout bindings are deliberately path-scoped even when linked worktrees share identity. */
export function workspaceCheckoutKey(projectRoot: string): string {
  const digest = createHash("sha256").update(resolve(projectRoot)).digest("hex").slice(0, 32);
  return `checkout-${digest}`;
}

export function loadWorkspaceState(
  repository: ProjectRuntimeRepository,
  options: LoadWorkspaceStateOptions = {},
): LoadedWorkspaceState {
  const project = workspaceProjectIdentity(repository);
  let document;
  try {
    document = repository.readDocument<unknown>(WORKSPACE_STATE_PATH);
  } catch (error) {
    return {
      state: defaultWorkspaceState(project),
      revision: null,
      writeProtected: true,
      diagnostics: [
        diagnostic(
          "READ_FAILED",
          WORKSPACE_STATE_PATH,
          `workspace state could not be read safely: ${(error as Error).message}`,
        ),
      ],
    };
  }
  if (!document.found) {
    if (options.legacyWorkspaceUiState !== undefined) {
      try {
        const projectRoot = options.projectRoot ?? repository.metadata.projectRoot;
        const checkoutKey = options.checkoutKey ?? workspaceCheckoutKey(projectRoot);
        const migratedAt = options.migratedAt;
        if (!migratedAt) throw new Error("a deterministic migratedAt timestamp is required");
        return {
          state: migrateWorkspaceUiStateV2(
            project,
            checkoutKey,
            projectRoot,
            options.legacyWorkspaceUiState,
            migratedAt,
          ),
          revision: null,
          writeProtected: false,
          diagnostics: [
            diagnostic(
              "MIGRATED",
              WORKSPACE_STATE_PATH,
              "workspace domain was deterministically seeded from ui/workspace.json V2",
            ),
          ],
        };
      } catch (error) {
        return {
          state: defaultWorkspaceState(project),
          revision: null,
          writeProtected: false,
          diagnostics: [
            diagnostic("MISSING", WORKSPACE_STATE_PATH, "workspace state is absent"),
            diagnostic(
              "INVALID_STATE",
              "ui/workspace.json",
              `workspace UI state was not eligible for migration: ${(error as Error).message}`,
            ),
          ],
        };
      }
    }
    return {
      state: defaultWorkspaceState(project),
      revision: null,
      writeProtected: false,
      diagnostics: [diagnostic("MISSING", WORKSPACE_STATE_PATH, "workspace state is absent")],
    };
  }
  const parsed = parseWorkspaceStateValue(document.payload, project);
  const structuralCorruption = parsed.diagnostics.some((entry) =>
    ["MALFORMED", "INVALID_FIELD", "OVERSIZED", "IDENTITY_MISMATCH"].includes(entry.code),
  );
  return {
    state: parsed.state,
    revision: document.revision,
    writeProtected: parsed.writeProtected || structuralCorruption,
    diagnostics: parsed.diagnostics,
  };
}

/**
 * Revision merge is field-domain based: shared named layouts merge independently
 * from checkout-scoped live topology/bindings. Layout deletion also clears any
 * active reference so the merged document remains referentially valid.
 */
export function mergeWorkspaceStateForSave(
  latest: WorkspaceStateV1,
  local: WorkspaceStateV1,
  touchedLayoutIds: ReadonlySet<string>,
  deletedLayoutIds: ReadonlySet<string> = new Set(),
  touchedCheckoutKeys: ReadonlySet<string> = new Set(),
  options: WorkspaceStateMergeOptions = {},
): WorkspaceStateV1 {
  if (latest.project.identityKey !== local.project.identityKey) {
    throw new Error("cannot merge workspace states from different project identities");
  }
  assertLayoutMergeIsSafe(latest, local, touchedLayoutIds, deletedLayoutIds, options);
  const next = cloneWorkspaceState(latest);
  for (const id of [...touchedLayoutIds].sort()) {
    const layout = local.layouts[id];
    if (layout) next.layouts[id] = structuredClone(layout);
    else delete next.layouts[id];
  }
  for (const id of [...deletedLayoutIds].sort()) delete next.layouts[id];
  mergeCheckoutSubdomains(next, local, touchedCheckoutKeys, options);
  for (const checkout of Object.values(next.checkouts)) {
    if (checkout.activeLayoutId && !next.layouts[checkout.activeLayoutId]) {
      checkout.activeLayoutId = null;
    }
  }
  return JSON.parse(serializeWorkspaceState(next)) as WorkspaceStateV1;
}

function assertLayoutMergeIsSafe(
  latest: WorkspaceStateV1,
  local: WorkspaceStateV1,
  touchedLayoutIds: ReadonlySet<string>,
  deletedLayoutIds: ReadonlySet<string>,
  options: WorkspaceStateMergeOptions,
): void {
  for (const id of new Set([...touchedLayoutIds, ...deletedLayoutIds])) {
    const latestRevision = latest.layouts[id]?.revision ?? null;
    const localLayout = local.layouts[id];
    const hasBase = options.layoutBaseRevisions?.has(id) === true;
    const baseRevision = hasBase ? (options.layoutBaseRevisions?.get(id) ?? null) : undefined;
    if (hasBase && baseRevision !== latestRevision) {
      throw new WorkspaceStateMergeConflictError(
        `$.layouts.${id}`,
        `layout "${id}" changed from base revision ${String(baseRevision)} to ${String(
          latestRevision,
        )}`,
      );
    }
    if (
      options.documentIsStale &&
      !hasBase &&
      !(latestRevision === null && localLayout?.revision === 1 && !deletedLayoutIds.has(id))
    ) {
      throw new WorkspaceStateMergeConflictError(
        `$.layouts.${id}`,
        `stale edit to layout "${id}" requires its base layout revision`,
      );
    }
    if (
      hasBase &&
      localLayout &&
      ((baseRevision === null && localLayout.revision !== 1) ||
        (baseRevision !== undefined &&
          baseRevision !== null &&
          localLayout.revision <= baseRevision))
    ) {
      throw new WorkspaceStateMergeConflictError(
        `$.layouts.${id}.revision`,
        `layout "${id}" revision does not advance its declared base`,
      );
    }
  }
}

function mergeCheckoutSubdomains(
  next: WorkspaceStateV1,
  local: WorkspaceStateV1,
  legacyTouchedCheckoutKeys: ReadonlySet<string>,
  options: WorkspaceStateMergeOptions,
): void {
  for (const key of legacyTouchedCheckoutKeys) {
    if (options.checkoutIntents?.has(key)) {
      throw new WorkspaceStateMergeConflictError(
        `$.checkouts.${key}`,
        `checkout "${key}" cannot use both legacy replacement and explicit subdomain intents`,
      );
    }
  }
  for (const key of [...(options.deletedCheckoutKeys ?? [])].sort()) {
    if (options.documentIsStale && next.checkouts[key]) {
      throw new WorkspaceStateMergeConflictError(
        `$.checkouts.${key}`,
        `stale deletion of checkout "${key}" is not safe`,
      );
    }
    delete next.checkouts[key];
  }
  for (const key of [...legacyTouchedCheckoutKeys].sort()) {
    const localCheckout = local.checkouts[key];
    if (options.documentIsStale && next.checkouts[key]) {
      throw new WorkspaceStateMergeConflictError(
        `$.checkouts.${key}`,
        `stale whole-checkout replacement for "${key}" requires explicit subdomain intents`,
      );
    }
    if (localCheckout) next.checkouts[key] = structuredClone(localCheckout);
    else delete next.checkouts[key];
  }
  for (const [key, requestedDomains] of [...(options.checkoutIntents ?? new Map()).entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const domains = validateCheckoutDomains(key, requestedDomains);
    const localCheckout = local.checkouts[key];
    if (!localCheckout) {
      throw new WorkspaceStateMergeConflictError(
        `$.checkouts.${key}`,
        `checkout "${key}" is absent from the local state; use deletedCheckoutKeys to delete it`,
      );
    }
    const latestCheckout = next.checkouts[key];
    if (!latestCheckout) {
      next.checkouts[key] = structuredClone(localCheckout);
      continue;
    }
    if (latestCheckout.projectRoot !== localCheckout.projectRoot) {
      throw new WorkspaceStateMergeConflictError(
        `$.checkouts.${key}.projectRoot`,
        `checkout "${key}" project root changed unexpectedly`,
      );
    }
    if (domains.has("live")) {
      latestCheckout.topology = structuredClone(localCheckout.topology);
      latestCheckout.bindings = structuredClone(localCheckout.bindings);
      latestCheckout.recovery = structuredClone(localCheckout.recovery);
      if (
        latestCheckout.focusedPaneId &&
        !latestCheckout.topology.panes[latestCheckout.focusedPaneId]
      ) {
        latestCheckout.focusedPaneId = null;
      }
    }
    if (domains.has("workbench")) {
      latestCheckout.workbench = structuredClone(localCheckout.workbench);
    }
    if (domains.has("focus")) {
      if (
        localCheckout.focusedPaneId &&
        !latestCheckout.topology.panes[localCheckout.focusedPaneId]
      ) {
        throw new WorkspaceStateMergeConflictError(
          `$.checkouts.${key}.focusedPaneId`,
          `checkout "${key}" cannot focus pane "${localCheckout.focusedPaneId}" because it no longer exists in the latest live topology`,
        );
      }
      latestCheckout.focusedPaneId = localCheckout.focusedPaneId;
    }
    if (domains.has("active-layout")) {
      latestCheckout.activeLayoutId = localCheckout.activeLayoutId;
    }
  }
}

function validateCheckoutDomains(
  checkoutKey: string,
  domains: ReadonlySet<WorkspaceCheckoutSubdomain>,
): ReadonlySet<WorkspaceCheckoutSubdomain> {
  if (domains.size === 0) {
    throw new WorkspaceStateMergeConflictError(
      `$.checkouts.${checkoutKey}`,
      `checkout "${checkoutKey}" has no declared save subdomain`,
    );
  }
  const allowed = new Set<WorkspaceCheckoutSubdomain>([
    "live",
    "workbench",
    "focus",
    "active-layout",
  ]);
  for (const domain of domains) {
    if (!allowed.has(domain)) {
      throw new WorkspaceStateMergeConflictError(
        `$.checkouts.${checkoutKey}`,
        `checkout "${checkoutKey}" uses unknown save subdomain "${String(domain)}"`,
      );
    }
  }
  return domains;
}

export function writeWorkspaceStateWithRetry(
  request: WorkspaceStateSaveRequest,
): WriteWorkspaceStateResult {
  const validation = WorkspaceStateV1SchemaZ.safeParse(request.next);
  if (!validation.success) {
    const loaded = loadWorkspaceState(request.repository);
    return {
      ...loaded,
      saved: false,
      diagnostics: [
        ...loaded.diagnostics,
        diagnostic(
          "INVALID_STATE",
          WORKSPACE_STATE_PATH,
          validation.error.issues.map((issue) => issue.message).join("; "),
        ),
      ],
    };
  }

  try {
    const outcome = withWorkspaceStateLockOutcome<WriteWorkspaceStateResult>(
      request.repository,
      request.lock,
      () => {
        const diagnostics: WorkspaceStateRepositoryDiagnostic[] = [];
        const retries = boundedInteger(request.maxRevisionRetries, 2, 0, 8);
        for (let attempt = 0; attempt <= retries; attempt += 1) {
          const latest = loadWorkspaceState(request.repository);
          if (latest.writeProtected) {
            return {
              ...latest,
              saved: false,
              diagnostics: [
                ...latest.diagnostics,
                diagnostic(
                  "WRITE_PROTECTED",
                  WORKSPACE_STATE_PATH,
                  "workspace state was preserved because its current payload is not safe to overwrite",
                ),
              ],
            };
          }
          if (
            request.revision !== latest.revision &&
            !diagnostics.some((entry) => entry.code === "STALE")
          ) {
            diagnostics.push(
              diagnostic(
                "STALE",
                WORKSPACE_STATE_PATH,
                `merged stale revision ${String(request.revision)} with current revision ${String(
                  latest.revision,
                )}`,
              ),
            );
          }
          let merged: WorkspaceStateV1;
          try {
            merged = mergeWorkspaceStateForSave(
              latest.state,
              validation.data,
              request.touchedLayoutIds,
              request.deletedLayoutIds,
              request.touchedCheckoutKeys,
              {
                checkoutIntents: request.checkoutIntents,
                deletedCheckoutKeys: request.deletedCheckoutKeys,
                layoutBaseRevisions: request.layoutBaseRevisions,
                documentIsStale: request.revision !== latest.revision,
              },
            );
          } catch (error) {
            if (error instanceof WorkspaceStateMergeConflictError) {
              return {
                ...latest,
                saved: false,
                diagnostics: [
                  ...latest.diagnostics,
                  ...diagnostics,
                  diagnostic("CONFLICT", error.path, error.message),
                ],
              };
            }
            throw error;
          }
          const mergedValidation = WorkspaceStateV1SchemaZ.safeParse(merged);
          if (!mergedValidation.success) {
            return {
              ...latest,
              saved: false,
              diagnostics: [
                ...latest.diagnostics,
                ...diagnostics,
                diagnostic(
                  "INVALID_STATE",
                  WORKSPACE_STATE_PATH,
                  mergedValidation.error.issues.map((issue) => issue.message).join("; "),
                ),
              ],
            };
          }
          try {
            const written = request.repository.writeDocument(
              WORKSPACE_STATE_PATH,
              JSON.parse(serializeWorkspaceState(mergedValidation.data)),
              { expectedRevision: latest.revision },
            );
            return {
              state: mergedValidation.data,
              revision: written.revision,
              writeProtected: false,
              saved: true,
              diagnostics: [
                ...latest.diagnostics.filter((entry) => entry.code !== "MISSING"),
                ...diagnostics,
              ],
            };
          } catch (error) {
            if (error instanceof RevisionConflictError && attempt < retries) continue;
            return {
              ...latest,
              saved: false,
              diagnostics: [
                ...latest.diagnostics,
                ...diagnostics,
                diagnostic(
                  "WRITE_FAILED",
                  WORKSPACE_STATE_PATH,
                  `workspace state could not be written: ${(error as Error).message}`,
                ),
              ],
            };
          }
        }
        throw new Error("unreachable workspace-state retry exhaustion");
      },
    );
    if (!outcome.releaseError) return outcome.value;
    return {
      ...outcome.value,
      diagnostics: [
        ...outcome.value.diagnostics,
        diagnostic(
          "LOCK_RELEASE_FAILED",
          WORKSPACE_STATE_PATH,
          `workspace state lock was abandoned after the operation completed: ${outcome.releaseError.message}`,
        ),
      ],
    };
  } catch (error) {
    const loaded = loadWorkspaceState(request.repository);
    const code = error instanceof WorkspaceStateLockTimeoutError ? "LOCK_TIMEOUT" : "WRITE_FAILED";
    return {
      ...loaded,
      saved: false,
      diagnostics: [
        ...loaded.diagnostics,
        diagnostic(code, WORKSPACE_STATE_PATH, (error as Error).message),
      ],
    };
  }
}

/**
 * Inspect the project-scoped workspace writer lock without reclaiming it.
 * Valid ownership values and filesystem identity are returned exactly so an
 * operator can pass the same owner identity to the offline clear operation.
 * PID and age are evidence only; neither is used to infer that a lock is stale.
 */
export function inspectWorkspaceStateLock(
  repository: ProjectRuntimeRepository,
): WorkspaceStateLockInspection {
  const lockPath = resolveWorkspaceStateLockPath(repository, false);
  return inspectWorkspaceLockArtifact(lockPath);
}

/**
 * Explicit offline crash recovery. Before calling this function, every
 * tmux-ide process that can write beneath this repository's runtime root must
 * be stopped. The caller must inspect the lock, provide its exact token,
 * process-instance id, device, and inode, and affirm that offline precondition.
 * There is no PID-liveness or age-based inference and malformed locks are never
 * cleared.
 */
export function clearWorkspaceStateLockOffline(
  repository: ProjectRuntimeRepository,
  options: ClearWorkspaceStateLockOfflineOptions,
): ClearedWorkspaceStateLock {
  const lockPath = resolveWorkspaceStateLockPath(repository, false);
  if (options?.confirmAllWritersStopped !== true) {
    throw new WorkspaceStateLockRecoveryError(
      "CONFIRMATION_REQUIRED",
      lockPath,
      "offline workspace-lock recovery requires confirmation that all tmux-ide writers for this runtime root are stopped",
    );
  }

  const inspected = inspectWorkspaceLockArtifact(lockPath);
  if (inspected.status === "absent") {
    throw new WorkspaceStateLockRecoveryError(
      "LOCK_ABSENT",
      lockPath,
      `workspace-state lock "${lockPath}" is absent`,
    );
  }
  if (inspected.status === "malformed") {
    throw new WorkspaceStateLockRecoveryError(
      "LOCK_MALFORMED",
      lockPath,
      `workspace-state lock "${lockPath}" is malformed and was preserved: ${inspected.reason}`,
    );
  }
  if (
    inspected.owner.token !== options.expectedToken ||
    inspected.owner.processInstanceId !== options.expectedProcessInstanceId
  ) {
    throw new WorkspaceStateLockRecoveryError(
      "OWNER_MISMATCH",
      lockPath,
      `workspace-state lock "${lockPath}" does not match the inspected owner identity`,
    );
  }
  if (inspected.device !== options.expectedDevice || inspected.inode !== options.expectedInode) {
    throw new WorkspaceStateLockRecoveryError(
      "LOCK_CHANGED",
      lockPath,
      `workspace-state lock "${lockPath}" no longer has the inspected filesystem identity and was preserved`,
    );
  }

  const revalidated = inspectWorkspaceLockArtifact(lockPath);
  if (revalidated.status !== "valid" || !sameInspectedLock(inspected, revalidated)) {
    throw new WorkspaceStateLockRecoveryError(
      "LOCK_CHANGED",
      lockPath,
      `workspace-state lock "${lockPath}" changed before offline recovery and was preserved`,
    );
  }

  let quarantine: WorkspaceStateLockQuarantine;
  try {
    quarantine = reserveWorkspaceLockQuarantine(lockPath);
  } catch (error) {
    throw new WorkspaceStateLockRecoveryError(
      "RECOVERY_FAILED",
      lockPath,
      `unable to reserve a unique quarantine for workspace-state lock "${lockPath}": ${(error as Error).message}`,
    );
  }

  try {
    renameSync(lockPath, quarantine.path);
  } catch (error) {
    removeEmptyQuarantineDirectory(quarantine.directory);
    throw new WorkspaceStateLockRecoveryError(
      "RECOVERY_FAILED",
      lockPath,
      `unable to quarantine workspace-state lock "${lockPath}": ${(error as Error).message}`,
    );
  }

  const moved = inspectWorkspaceLockArtifact(quarantine.path);
  if (moved.status !== "valid" || !sameInspectedLock(inspected, moved)) {
    const restored = preserveUnexpectedQuarantinedLock(lockPath, quarantine, moved);
    throw new WorkspaceStateLockRecoveryError(
      "LOCK_CHANGED",
      lockPath,
      restored
        ? `workspace-state lock changed during offline recovery; the unexpected artifact was restored at "${lockPath}"`
        : `workspace-state lock changed during offline recovery; the unexpected artifact was preserved at "${quarantine.path}"`,
    );
  }

  try {
    rmSync(quarantine.path, { force: false });
    rmdirSync(quarantine.directory);
  } catch (error) {
    throw new WorkspaceStateLockRecoveryError(
      "RECOVERY_FAILED",
      lockPath,
      `verified workspace-state lock quarantine could not be removed safely: ${(error as Error).message}`,
    );
  }
  return {
    cleared: true,
    lockPath,
    owner: inspected.owner,
    device: inspected.device,
    inode: inspected.inode,
  };
}

export function withWorkspaceStateLock<T>(
  repository: ProjectRuntimeRepository,
  options: WorkspaceStateLockOptions | undefined,
  action: () => T,
): T {
  const outcome = withWorkspaceStateLockOutcome(repository, options, action);
  if (outcome.releaseError) throw outcome.releaseError;
  return outcome.value;
}

interface WorkspaceStateLockOutcome<T> {
  value: T;
  releaseError: Error | null;
}

function withWorkspaceStateLockOutcome<T>(
  repository: ProjectRuntimeRepository,
  options: WorkspaceStateLockOptions | undefined,
  action: () => T,
): WorkspaceStateLockOutcome<T> {
  const timeoutMs = boundedInteger(options?.timeoutMs, 2_000, 1, 60_000);
  const pollMs = boundedInteger(options?.pollMs, 10, 1, 250);
  const lockPath = resolveWorkspaceStateLockPath(repository);
  const owner: WorkspaceStateLockOwner = {
    version: 1,
    token: randomUUID(),
    processInstanceId: WORKSPACE_STATE_PROCESS_INSTANCE_ID,
    pid: process.pid,
    createdAtMs: Date.now(),
  };
  const candidatePath = prepareWorkspaceLockCandidate(lockPath, owner);
  const startedAt = Date.now();
  let installed = false;

  try {
    for (;;) {
      try {
        linkSync(candidatePath, lockPath);
        installed = true;
      } catch (error) {
        if (!isLockContentionError(error)) throw error;
        if (Date.now() - startedAt >= timeoutMs) {
          throw new WorkspaceStateLockTimeoutError(lockPath, timeoutMs);
        }
        sleepSync(Math.min(pollMs, Math.max(1, timeoutMs - (Date.now() - startedAt))));
        continue;
      }
      try {
        removeLockArtifact(candidatePath);
      } catch (error) {
        const releaseError = releaseOwnedLock(lockPath, owner);
        installed = releaseError !== null;
        if (releaseError) {
          throw new Error(
            `workspace lock candidate cleanup failed and the installed lock was abandoned: ${releaseError.message}`,
            { cause: error },
          );
        }
        throw error;
      }
      let value: T;
      try {
        value = action();
      } catch (error) {
        const releaseError = releaseOwnedLock(lockPath, owner);
        if (releaseError) {
          throw new Error(
            `workspace action failed and its lock was abandoned: ${releaseError.message}`,
            { cause: error },
          );
        }
        throw error;
      }
      return { value, releaseError: releaseOwnedLock(lockPath, owner) };
    }
  } finally {
    if (!installed) removeLockArtifact(candidatePath);
  }
}

interface WorkspaceStateLockOwner {
  version: 1;
  token: string;
  processInstanceId: string;
  pid: number;
  createdAtMs: number;
}

interface WorkspaceStateLockSnapshot {
  owner: WorkspaceStateLockOwner;
  device: number;
  inode: number;
}

interface WorkspaceStateLockQuarantine {
  directory: string;
  path: string;
}

/**
 * The workspace domain has one writer boundary. Generic runtime document writes
 * must not target WORKSPACE_STATE_PATH; callers use writeWorkspaceStateWithRetry
 * so revision merge and this project-scoped lock cannot be bypassed accidentally.
 */
function resolveWorkspaceStateLockPath(
  repository: ProjectRuntimeRepository,
  createDirectories = true,
): string {
  const runtimeRoot = resolve(repository.runtimeRoot);
  const workspaceDirectory = resolve(runtimeRoot, "workspace");
  const relativePath = relative(runtimeRoot, workspaceDirectory);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error("workspace lock path escapes the project runtime root");
  }
  if (createDirectories) {
    mkdirSync(runtimeRoot, { recursive: true });
    assertWorkspaceLockDirectory(runtimeRoot);
    mkdirSync(workspaceDirectory, { recursive: true });
    assertWorkspaceLockDirectory(workspaceDirectory);
  } else {
    const runtimeStat = lstatIfPresent(runtimeRoot);
    if (runtimeStat) assertWorkspaceLockDirectory(runtimeRoot, runtimeStat);
    const workspaceStat = runtimeStat ? lstatIfPresent(workspaceDirectory) : null;
    if (workspaceStat) assertWorkspaceLockDirectory(workspaceDirectory, workspaceStat);
  }
  return join(workspaceDirectory, WORKSPACE_STATE_LOCK_FILENAME);
}

function assertWorkspaceLockDirectory(path: string, stat = lstatSync(path)): void {
  if (stat.isSymbolicLink()) {
    throw new Error(`workspace lock path must not traverse symbolic link "${path}"`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`workspace lock path component must be a directory "${path}"`);
  }
}

function lstatIfPresent(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function prepareWorkspaceLockCandidate(lockPath: string, owner: WorkspaceStateLockOwner): string {
  const candidatePath = `${lockPath}.candidate-${owner.token}`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(candidatePath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    return candidatePath;
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original setup error.
      }
    }
    removeLockArtifact(candidatePath);
    throw error;
  }
}

function releaseOwnedLock(lockPath: string, owner: WorkspaceStateLockOwner): Error | null {
  try {
    const snapshot = inspectWorkspaceLock(lockPath);
    if (
      !snapshot ||
      snapshot.owner.token !== owner.token ||
      snapshot.owner.processInstanceId !== owner.processInstanceId
    ) {
      return new Error(`workspace lock ownership was lost before release of "${lockPath}"`);
    }
    const releasedPath = `${lockPath}.released-${owner.token}`;
    renameSync(lockPath, releasedPath);
    const moved = inspectWorkspaceLock(releasedPath);
    if (!moved || !sameLockSnapshot(snapshot, moved)) {
      return new Error(`workspace lock ownership changed while releasing "${lockPath}"`);
    }
    removeLockArtifact(releasedPath);
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function inspectWorkspaceLock(lockPath: string): WorkspaceStateLockSnapshot | null {
  const inspected = inspectWorkspaceLockArtifact(lockPath);
  if (inspected.status !== "valid") return null;
  return {
    owner: {
      version: inspected.owner.version,
      token: inspected.owner.token,
      processInstanceId: inspected.owner.processInstanceId,
      pid: inspected.owner.pid,
      createdAtMs: inspected.owner.createdAt,
    },
    device: inspected.device,
    inode: inspected.inode,
  };
}

function inspectWorkspaceLockArtifact(lockPath: string): WorkspaceStateLockInspection {
  const stat = lstatIfPresent(lockPath);
  if (!stat) return { status: "absent", lockPath };
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return {
      status: "malformed",
      lockPath,
      device: stat.dev,
      inode: stat.ino,
      reason: "lock artifact is not a regular file",
    };
  }
  if (stat.size > WORKSPACE_STATE_LOCK_MAX_BYTES) {
    return {
      status: "malformed",
      lockPath,
      device: stat.dev,
      inode: stat.ino,
      reason: `lock owner exceeds ${WORKSPACE_STATE_LOCK_MAX_BYTES} bytes`,
    };
  }
  const raw = readFileSync(lockPath, "utf8");
  const afterRead = lstatIfPresent(lockPath);
  if (!afterRead) return { status: "absent", lockPath };
  if (
    afterRead.dev !== stat.dev ||
    afterRead.ino !== stat.ino ||
    !afterRead.isFile() ||
    afterRead.isSymbolicLink()
  ) {
    return {
      status: "malformed",
      lockPath,
      device: afterRead.dev,
      inode: afterRead.ino,
      reason: "lock artifact changed while it was being inspected",
    };
  }
  if (Buffer.byteLength(raw, "utf8") > WORKSPACE_STATE_LOCK_MAX_BYTES) {
    return {
      status: "malformed",
      lockPath,
      device: afterRead.dev,
      inode: afterRead.ino,
      reason: `lock owner exceeds ${WORKSPACE_STATE_LOCK_MAX_BYTES} bytes`,
    };
  }
  const owner = parseWorkspaceLockOwner(raw);
  if (!owner) {
    return {
      status: "malformed",
      lockPath,
      device: afterRead.dev,
      inode: afterRead.ino,
      reason: "lock owner is not a valid version 1 owner record",
    };
  }
  return {
    status: "valid",
    lockPath,
    owner: {
      version: owner.version,
      token: owner.token,
      processInstanceId: owner.processInstanceId,
      pid: owner.pid,
      createdAt: owner.createdAtMs,
    },
    device: afterRead.dev,
    inode: afterRead.ino,
  };
}

function parseWorkspaceLockOwner(raw: string): WorkspaceStateLockOwner | null {
  try {
    const value = JSON.parse(raw) as Partial<WorkspaceStateLockOwner>;
    if (
      value.version !== 1 ||
      typeof value.token !== "string" ||
      !/^[0-9a-f-]{36}$/iu.test(value.token) ||
      typeof value.processInstanceId !== "string" ||
      !/^[0-9a-f-]{36}$/iu.test(value.processInstanceId) ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid ?? 0) < 1 ||
      typeof value.createdAtMs !== "number" ||
      !Number.isSafeInteger(value.createdAtMs) ||
      value.createdAtMs < 0
    ) {
      return null;
    }
    return value as WorkspaceStateLockOwner;
  } catch {
    return null;
  }
}

function sameLockSnapshot(
  left: WorkspaceStateLockSnapshot,
  right: WorkspaceStateLockSnapshot,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.owner.version === right.owner.version &&
    left.owner.token === right.owner.token &&
    left.owner.processInstanceId === right.owner.processInstanceId &&
    left.owner.pid === right.owner.pid &&
    left.owner.createdAtMs === right.owner.createdAtMs
  );
}

function sameInspectedLock(
  left: Extract<WorkspaceStateLockInspection, { status: "valid" }>,
  right: Extract<WorkspaceStateLockInspection, { status: "valid" }>,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.owner.version === right.owner.version &&
    left.owner.token === right.owner.token &&
    left.owner.processInstanceId === right.owner.processInstanceId &&
    left.owner.pid === right.owner.pid &&
    left.owner.createdAt === right.owner.createdAt
  );
}

function reserveWorkspaceLockQuarantine(lockPath: string): WorkspaceStateLockQuarantine {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const directory = `${lockPath}.offline-quarantine-${randomUUID()}`;
    try {
      mkdirSync(directory, { mode: 0o700 });
      return { directory, path: join(directory, WORKSPACE_STATE_LOCK_FILENAME) };
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error("unable to allocate a unique workspace-lock quarantine path");
}

function preserveUnexpectedQuarantinedLock(
  lockPath: string,
  quarantine: WorkspaceStateLockQuarantine,
  moved: WorkspaceStateLockInspection,
): boolean {
  try {
    linkSync(quarantine.path, lockPath);
  } catch {
    return false;
  }
  const restored = inspectWorkspaceLockArtifact(lockPath);
  const safelyRestored =
    moved.status === "valid" && restored.status === "valid"
      ? sameInspectedLock(moved, restored)
      : moved.status === "malformed" &&
        restored.status === "malformed" &&
        moved.device === restored.device &&
        moved.inode === restored.inode;
  if (!safelyRestored) return false;
  try {
    rmSync(quarantine.path, { force: false });
    removeEmptyQuarantineDirectory(quarantine.directory);
    return true;
  } catch {
    return false;
  }
}

function removeEmptyQuarantineDirectory(directory: string): void {
  try {
    rmdirSync(directory);
  } catch {
    // A non-empty or replaced quarantine is evidence and must be preserved.
  }
}

function removeLockArtifact(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function isLockContentionError(error: unknown): boolean {
  return (
    isNodeError(error) && ["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"].includes(error.code ?? "")
  );
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function diagnostic(
  code: WorkspaceStateRepositoryDiagnosticCode,
  path: string,
  message: string,
): WorkspaceStateRepositoryDiagnostic {
  return { code, path, message };
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
