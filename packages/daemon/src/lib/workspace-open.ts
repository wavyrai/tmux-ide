import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";

import {
  WorkspaceOpenMutationRequestSchemaZ,
  WorkspaceOpenMutationResultSchemaZ,
  type Workspace,
  type WorkspaceOpenMutationRequest,
  type WorkspaceOpenMutationResult,
  type WorkspaceOpenedResource,
} from "@tmux-ide/contracts";
import { TmuxError } from "@tmux-ide/tmux-bridge";

import { resolveProjectConfigContext } from "./config-context.ts";
import {
  createPinnedWorkspaceTmuxRunner,
  resolveWorkspacePaneTmuxAuthority,
  type WorkspacePaneTmuxAuthority,
} from "./workspace-pane-creation.ts";
import {
  getDefaultWorkspaceRegistry,
  WorkspaceAlreadyExistsError,
  type AddWorkspaceInput,
} from "./workspace-registry.ts";
import { analyzeTrustedSemanticPaneCatalog } from "../terminal/attachments/semantic-pane-catalog.ts";

const MAX_OPERATIONS = 128;
const MAX_REPLAYABLE_FAILURES = 64;
const MAX_TMUX_OUTPUT_BYTES = 128 * 1024;
const SESSION_MARKER_OPTION = "@tmux_ide_workspace_open_v1";
const SESSION_WORKSPACE_OPTION = "@tmux_ide_workspace_name";
const SESSION_OPERATION_OPTION = "@tmux_ide_workspace_open_operation";
const SEMANTIC_PANE_OPTION = "@tmux_ide_pane_id";
const SEMANTIC_WINDOW_OPTION = "@tmux_ide_window_id";
const SESSION_FORMAT = [
  "#{session_name}",
  "#{session_id}",
  `#{${SESSION_MARKER_OPTION}}`,
  `#{${SESSION_WORKSPACE_OPTION}}`,
  `#{${SESSION_OPERATION_OPTION}}`,
].join("\t");
const PANE_FORMAT = [
  "#{session_name}",
  "#{session_id}",
  "#{window_id}",
  "#{window_name}",
  "#{window_panes}",
  "#{session_windows}",
  "#{pane_id}",
  `#{${SEMANTIC_PANE_OPTION}}`,
  `#{${SEMANTIC_WINDOW_OPTION}}`,
  "#{@ide_type}",
  "#{@ide_role}",
  "#{@ide_name}",
].join("\t");

export type WorkspaceOpenErrorCode =
  | "daemon_instance_mismatch"
  | "workspace_unavailable"
  | "workspace_conflict"
  | "session_conflict"
  | "operation_conflict"
  | "operation_capacity"
  | "workspace_creation_failed"
  | "workspace_cleanup_unproven"
  | "workspace_resource_changed";

const ERROR_MESSAGES: Readonly<Record<WorkspaceOpenErrorCode, string>> = {
  daemon_instance_mismatch: "The daemon generation changed before the workspace was opened.",
  workspace_unavailable: "The selected project is not available for config-free opening.",
  workspace_conflict: "The derived workspace identity is already owned by another project.",
  session_conflict: "The derived tmux session identity is already owned by another session.",
  operation_conflict: "The operation id was already used for another workspace intent.",
  operation_capacity: "The daemon has reached its bounded workspace-open operation capacity.",
  workspace_creation_failed: "tmux could not create and verify the config-free workspace.",
  workspace_cleanup_unproven: "The failed workspace mutation could not be rolled back safely.",
  workspace_resource_changed: "The opened workspace changed outside tmux-ide before the retry.",
};

export class WorkspaceOpenError extends Error {
  readonly code: WorkspaceOpenErrorCode;
  readonly context: Readonly<Record<string, string>>;

  constructor(
    code: WorkspaceOpenErrorCode,
    context: Readonly<Record<string, string>> = {},
    cause?: unknown,
  ) {
    super(ERROR_MESSAGES[code], cause === undefined ? undefined : { cause });
    this.name = "WorkspaceOpenError";
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}

interface WorkspaceOpenRegistry {
  list(): Workspace[];
  add(input: AddWorkspaceInput): Workspace;
}

export interface WorkspaceOpenIo {
  readonly resolveConfigFreeProjectDir: (projectDir: string) => Promise<string>;
  readonly canonicalRegisteredProjectDir: (projectDir: string) => string;
  readonly runTmux: (args: readonly string[]) => string;
  readonly isMissingTmuxTarget: (error: unknown) => boolean;
  readonly isTmuxUnavailable: (error: unknown) => boolean;
}

interface DerivedIdentity {
  readonly workspaceName: string;
  readonly sessionName: string;
  readonly projectKey: string;
  readonly initialPaneId: string;
  readonly initialWindowId: string;
}

interface SessionRecord {
  readonly sessionName: string;
  readonly sessionId: string;
  readonly projectKey: string;
  readonly workspaceName: string;
  readonly operationId: string;
}

interface RuntimeIdentity {
  readonly sessionName: string;
  readonly sessionId: string;
  readonly paneId: string;
  readonly windowId: string;
}

interface PaneRecord {
  readonly sessionName: string;
  readonly sessionId: string;
  readonly windowId: string;
  readonly windowName: string;
  readonly windowPaneCount: number;
  readonly sessionWindowCount: number;
  readonly paneId: string;
  readonly semanticPaneId: string;
  readonly semanticWindowId: string;
  readonly type: string;
  readonly role: string;
  readonly name: string;
}

interface SuccessfulOperation {
  readonly status: "success";
  readonly fingerprint: string;
  readonly result: WorkspaceOpenMutationResult;
  readonly identity: DerivedIdentity;
  readonly runtime: RuntimeIdentity;
  readonly canonicalRoot: string;
}

interface FailedOperation {
  readonly status: "error";
  readonly fingerprint: string;
  readonly error: WorkspaceOpenError;
}

type OperationRecord = SuccessfulOperation | FailedOperation;

function boundedAuthorityLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > MAX_OPERATIONS) {
    throw new TypeError(`authority limit must be an integer from 1 to ${MAX_OPERATIONS}`);
  }
  return value;
}

function boundedTmuxOutput(value: string): string {
  if (value.includes("\0") || Buffer.byteLength(value, "utf8") > MAX_TMUX_OUTPUT_BYTES) {
    throw new WorkspaceOpenError("workspace_unavailable", { reason: "invalid_tmux_output" });
  }
  return value.replace(/(?:\r?\n)+$/u, "");
}

function safeBaseName(projectDir: string): string {
  const value = basename(projectDir)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^[-_]+|[-_]+$/gu, "")
    .slice(0, 72);
  return value || "workspace";
}

/** Stable across path aliases because callers supply an already-canonical project root. */
export function deriveWorkspaceOpenIdentity(canonicalProjectDir: string): DerivedIdentity {
  const projectKey = createHash("sha256")
    .update("tmux-ide.workspace.open.v1\0", "utf8")
    .update(canonicalProjectDir, "utf8")
    .digest("hex")
    .slice(0, 32);
  const name = `${safeBaseName(canonicalProjectDir).slice(0, 64)}-${projectKey}`;
  return Object.freeze({
    workspaceName: name,
    sessionName: name,
    projectKey,
    initialPaneId: `pane.workspace.${projectKey}`,
    initialWindowId: `window.workspace.${projectKey}`,
  });
}

async function resolveConfigFreeProjectDir(projectDir: string): Promise<string> {
  if (!isAbsolute(projectDir)) {
    throw new WorkspaceOpenError("workspace_unavailable", {
      reason: "project_directory_not_absolute",
    });
  }
  let selected: string;
  try {
    selected = realpathSync(projectDir);
    if (!statSync(selected).isDirectory()) throw new Error("not a directory");
  } catch (cause) {
    throw new WorkspaceOpenError(
      "workspace_unavailable",
      { reason: "project_directory_unavailable" },
      cause,
    );
  }
  let context: Awaited<ReturnType<typeof resolveProjectConfigContext>>;
  try {
    context = await resolveProjectConfigContext(selected);
  } catch (cause) {
    throw new WorkspaceOpenError(
      "workspace_unavailable",
      { reason: "project_identity_unavailable" },
      cause,
    );
  }
  if (context.configKind !== "none") {
    throw new WorkspaceOpenError("workspace_unavailable", {
      reason: "project_is_not_config_free",
    });
  }
  try {
    const canonicalRoot = realpathSync(context.projectRoot);
    if (!statSync(canonicalRoot).isDirectory()) throw new Error("not a directory");
    return canonicalRoot;
  } catch (cause) {
    throw new WorkspaceOpenError(
      "workspace_unavailable",
      { reason: "project_root_unavailable" },
      cause,
    );
  }
}

const DEFAULT_IO: Omit<WorkspaceOpenIo, "runTmux"> = {
  resolveConfigFreeProjectDir,
  canonicalRegisteredProjectDir: (projectDir) => realpathSync(projectDir),
  isMissingTmuxTarget: (error) => error instanceof TmuxError && error.code === "SESSION_NOT_FOUND",
  isTmuxUnavailable: (error) => error instanceof TmuxError && error.code === "TMUX_UNAVAILABLE",
};

function requestFingerprint(request: WorkspaceOpenMutationRequest): string {
  return JSON.stringify(request);
}

function parseSessionRecords(output: string): SessionRecord[] {
  const normalized = boundedTmuxOutput(output);
  if (!normalized) return [];
  const records: SessionRecord[] = [];
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const line of normalized.split("\n")) {
    const fields = line.split("\t");
    if (
      fields.length !== 5 ||
      !/^\$[0-9]+$/u.test(fields[1]!) ||
      names.has(fields[0]!) ||
      ids.has(fields[1]!)
    ) {
      throw new WorkspaceOpenError("workspace_unavailable", { reason: "invalid_tmux_output" });
    }
    names.add(fields[0]!);
    ids.add(fields[1]!);
    records.push({
      sessionName: fields[0]!,
      sessionId: fields[1]!,
      projectKey: fields[2]!,
      workspaceName: fields[3]!,
      operationId: fields[4]!,
    });
  }
  return records;
}

function parseCreatedRuntime(output: string, sessionName: string): RuntimeIdentity {
  const match = /^(\$[0-9]+)\t(%[0-9]+)\t(@[0-9]+)$/u.exec(boundedTmuxOutput(output));
  if (!match) {
    throw new WorkspaceOpenError("workspace_cleanup_unproven", {
      reason: "created_identity_unavailable",
    });
  }
  return {
    sessionName,
    sessionId: match[1]!,
    paneId: match[2]!,
    windowId: match[3]!,
  };
}

function positiveInteger(value: string): number | null {
  if (!/^[1-9][0-9]*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parsePaneRecords(output: string): PaneRecord[] {
  const normalized = boundedTmuxOutput(output);
  if (!normalized) return [];
  const records: PaneRecord[] = [];
  for (const line of normalized.split("\n")) {
    const fields = line.split("\t");
    const windowPaneCount = positiveInteger(fields[4] ?? "");
    const sessionWindowCount = positiveInteger(fields[5] ?? "");
    if (
      fields.length !== 12 ||
      !/^\$[0-9]+$/u.test(fields[1]!) ||
      !/^@[0-9]+$/u.test(fields[2]!) ||
      !/^%[0-9]+$/u.test(fields[6]!) ||
      windowPaneCount === null ||
      sessionWindowCount === null
    ) {
      throw new WorkspaceOpenError("workspace_resource_changed", {
        reason: "invalid_tmux_pane_inventory",
      });
    }
    records.push({
      sessionName: fields[0]!,
      sessionId: fields[1]!,
      windowId: fields[2]!,
      windowName: fields[3]!,
      windowPaneCount,
      sessionWindowCount,
      paneId: fields[6]!,
      semanticPaneId: fields[7]!,
      semanticWindowId: fields[8]!,
      type: fields[9]!,
      role: fields[10]!,
      name: fields[11]!,
    });
  }
  return records;
}

function registryRecordIsConfigFree(workspace: Workspace): boolean {
  return (
    workspace.configKind === "none" &&
    workspace.configPath == null &&
    workspace.ideConfigPath === null &&
    workspace.hasWorkspaceConfig === false
  );
}

function resource(identity: DerivedIdentity): WorkspaceOpenedResource {
  return {
    resourceVersion: 1,
    workspaceName: identity.workspaceName,
    initialPaneId: identity.initialPaneId,
  };
}

export class WorkspaceOpenAuthority {
  readonly #daemonInstanceId: string;
  readonly #registry: WorkspaceOpenRegistry;
  readonly #io: WorkspaceOpenIo;
  readonly #operations = new Map<string, SuccessfulOperation>();
  readonly #failures = new Map<string, FailedOperation>();
  readonly #maxOperations: number;
  readonly #maxPendingOperations: number;
  #tail: Promise<void> = Promise.resolve();
  #pendingOperations = 0;
  #disposed = false;
  #disposePromise: Promise<void> | null = null;

  constructor(options: {
    daemonInstanceId: string;
    registry?: WorkspaceOpenRegistry;
    io?: Partial<WorkspaceOpenIo>;
    maxOperations?: number;
    maxPendingOperations?: number;
    tmuxAuthority?: WorkspacePaneTmuxAuthority;
  }) {
    this.#daemonInstanceId = options.daemonInstanceId;
    this.#registry = options.registry ?? getDefaultWorkspaceRegistry();
    this.#io = {
      ...DEFAULT_IO,
      ...options.io,
      runTmux:
        options.io?.runTmux ??
        createPinnedWorkspaceTmuxRunner(
          options.tmuxAuthority ?? resolveWorkspacePaneTmuxAuthority(),
        ),
    };
    this.#maxOperations = boundedAuthorityLimit(options.maxOperations, MAX_OPERATIONS);
    this.#maxPendingOperations = boundedAuthorityLimit(
      options.maxPendingOperations,
      MAX_OPERATIONS,
    );
  }

  open(raw: WorkspaceOpenMutationRequest): Promise<WorkspaceOpenMutationResult> {
    if (this.#disposed) return Promise.reject(this.#disposedError());
    if (this.#pendingOperations >= this.#maxPendingOperations) {
      return Promise.reject(
        new WorkspaceOpenError("operation_capacity", { reason: "admission_queue_full" }),
      );
    }
    this.#pendingOperations += 1;
    const run = this.#tail.then(
      () => this.#open(raw),
      () => this.#open(raw),
    );
    const admitted = run.finally(() => {
      this.#pendingOperations -= 1;
    });
    this.#tail = admitted.then(
      () => undefined,
      () => undefined,
    );
    return admitted;
  }

  dispose(): Promise<void> {
    this.#disposed = true;
    this.#disposePromise ??= this.#tail.then(() => {
      this.#operations.clear();
      this.#failures.clear();
    });
    return this.#disposePromise;
  }

  async #open(raw: WorkspaceOpenMutationRequest): Promise<WorkspaceOpenMutationResult> {
    this.#assertActive();
    const request = WorkspaceOpenMutationRequestSchemaZ.parse(raw);
    if (request.expectedDaemonInstanceId !== this.#daemonInstanceId) {
      throw new WorkspaceOpenError("daemon_instance_mismatch", {
        operationId: request.operationId,
      });
    }
    const fingerprint = requestFingerprint(request);
    const existing =
      this.#operations.get(request.operationId) ?? this.#failures.get(request.operationId);
    if (existing) return this.#replay(existing, request, fingerprint);
    this.#retireClosedOperations();
    if (this.#operations.size >= this.#maxOperations) {
      throw new WorkspaceOpenError("operation_capacity", { operationId: request.operationId });
    }

    let canonicalRoot: string;
    try {
      canonicalRoot = await this.#io.resolveConfigFreeProjectDir(request.intent.projectDir);
    } catch (error) {
      return this.#rememberFailure(request, fingerprint, this.#mapFailure(error, request));
    }
    this.#assertActive(request.operationId);
    const identity = deriveWorkspaceOpenIdentity(canonicalRoot);

    let registryRecord: Workspace | null;
    try {
      registryRecord = this.#compatibleRegistryRecord(identity, canonicalRoot);
    } catch (error) {
      return this.#rememberFailure(request, fingerprint, this.#mapFailure(error, request));
    }

    let createdRuntime: RuntimeIdentity | null = null;
    try {
      const existingSession = this.#sessionByName(identity.sessionName);
      let runtime: RuntimeIdentity;
      let outcome: "created" | "reopened";
      if (existingSession) {
        runtime = this.#compatibleRuntime(existingSession, identity);
        outcome = "reopened";
      } else {
        const opened = this.#createOrReopenSession(request, identity, canonicalRoot);
        runtime = opened.runtime;
        createdRuntime = opened.created ? runtime : null;
        outcome = opened.created ? "created" : "reopened";
      }
      this.#assertActive(request.operationId);

      if (!registryRecord) {
        try {
          registryRecord = this.#registry.add({
            name: identity.workspaceName,
            sessionName: identity.sessionName,
            projectDir: canonicalRoot,
            ideConfigPath: null,
            configKind: "none",
            configPath: null,
            hasWorkspaceConfig: false,
          });
        } catch (error) {
          if (error instanceof WorkspaceAlreadyExistsError) {
            registryRecord = this.#compatibleRegistryRecord(identity, canonicalRoot);
          } else {
            throw error;
          }
        }
        if (!registryRecord) {
          throw new WorkspaceOpenError("workspace_conflict", {
            operationId: request.operationId,
          });
        }
      }

      const result = WorkspaceOpenMutationResultSchemaZ.parse({
        operationId: request.operationId,
        daemonInstanceId: this.#daemonInstanceId,
        outcome,
        resource: resource(identity),
      });
      this.#operations.set(request.operationId, {
        status: "success",
        fingerprint,
        result,
        identity,
        runtime,
        canonicalRoot,
      });
      return result;
    } catch (error) {
      const mapped = this.#mapFailure(error, request);
      if (
        createdRuntime &&
        !this.#cleanupCreatedSession(createdRuntime, identity, request.operationId)
      ) {
        return this.#rememberFailure(
          request,
          fingerprint,
          new WorkspaceOpenError(
            "workspace_cleanup_unproven",
            { operationId: request.operationId },
            mapped,
          ),
        );
      }
      return this.#rememberFailure(request, fingerprint, mapped);
    }
  }

  #compatibleRegistryRecord(identity: DerivedIdentity, canonicalRoot: string): Workspace | null {
    const records = this.#registry.list();
    let candidate: Workspace | null = null;
    for (const record of records) {
      const nameMatches = record.name === identity.workspaceName;
      const sessionMatches = record.sessionName === identity.sessionName;
      let recordRoot: string;
      try {
        recordRoot = this.#io.canonicalRegisteredProjectDir(record.projectDir);
      } catch (cause) {
        if (nameMatches || sessionMatches) {
          throw new WorkspaceOpenError(
            "workspace_conflict",
            { workspaceName: identity.workspaceName, reason: "registered_project_unavailable" },
            cause,
          );
        }
        // An unrelated stale registry path cannot claim this canonical project.
        continue;
      }

      const rootMatches = recordRoot === canonicalRoot;
      if (!nameMatches && !sessionMatches && !rootMatches) continue;

      const exactMatch =
        nameMatches && sessionMatches && rootMatches && registryRecordIsConfigFree(record);
      if (!exactMatch || candidate) {
        throw new WorkspaceOpenError("workspace_conflict", {
          workspaceName: identity.workspaceName,
          reason: rootMatches
            ? "project_alias_registered_under_another_identity"
            : "workspace_identity_collision",
        });
      }
      candidate = record;
    }
    return candidate;
  }

  #listSessions(): SessionRecord[] {
    try {
      return parseSessionRecords(this.#io.runTmux(["list-sessions", "-F", SESSION_FORMAT]));
    } catch (error) {
      if (this.#io.isTmuxUnavailable(error)) return [];
      throw error;
    }
  }

  #sessionByName(sessionName: string): SessionRecord | null {
    return this.#listSessions().find((record) => record.sessionName === sessionName) ?? null;
  }

  #compatibleRuntime(session: SessionRecord, identity: DerivedIdentity): RuntimeIdentity {
    if (
      session.sessionName !== identity.sessionName ||
      session.projectKey !== identity.projectKey ||
      session.workspaceName !== identity.workspaceName
    ) {
      throw new WorkspaceOpenError("session_conflict", {
        workspaceName: identity.workspaceName,
      });
    }
    let output: string;
    try {
      const args = ["list-panes", "-s", "-t", session.sessionId, "-F", PANE_FORMAT] as const;
      const before = boundedTmuxOutput(this.#io.runTmux(args));
      const after = boundedTmuxOutput(this.#io.runTmux(args));
      if (before !== after) {
        throw new WorkspaceOpenError("workspace_resource_changed", {
          workspaceName: identity.workspaceName,
          reason: "tmux_pane_inventory_changed_during_proof",
        });
      }
      output = after;
    } catch (error) {
      if (this.#io.isMissingTmuxTarget(error)) {
        throw new WorkspaceOpenError("workspace_resource_changed", {
          workspaceName: identity.workspaceName,
        });
      }
      throw error;
    }
    const panes = parsePaneRecords(output);
    if (
      panes.length === 0 ||
      panes.some(
        (pane) => pane.sessionName !== identity.sessionName || pane.sessionId !== session.sessionId,
      )
    ) {
      throw new WorkspaceOpenError("workspace_resource_changed", {
        workspaceName: identity.workspaceName,
      });
    }

    const catalog = analyzeTrustedSemanticPaneCatalog(
      panes.map((pane) => ({
        workspaceName: identity.workspaceName,
        semanticPaneId: pane.semanticPaneId === "" ? null : pane.semanticPaneId,
        sessionId: pane.sessionId,
        windowId: pane.windowId,
        runtimePaneId: pane.paneId,
        windowPaneCount: pane.windowPaneCount,
        sessionWindowCount: pane.sessionWindowCount,
      })),
    );
    if (
      catalog.invalidRuntimeProof ||
      catalog.missingSemanticStamp ||
      catalog.duplicateSemanticStamp ||
      catalog.duplicateRuntimePaneBinding
    ) {
      throw new WorkspaceOpenError("workspace_resource_changed", {
        workspaceName: identity.workspaceName,
        reason: "semantic_pane_catalog_rejected_inventory",
      });
    }

    const windows = new Map<string, PaneRecord[]>();
    for (const pane of panes) {
      const rows = windows.get(pane.windowId) ?? [];
      rows.push(pane);
      windows.set(pane.windowId, rows);
    }

    const sessionWindowCount = panes[0]!.sessionWindowCount;
    if (
      windows.size !== sessionWindowCount ||
      panes.some((pane) => pane.sessionWindowCount !== sessionWindowCount) ||
      [...windows.values()].some(
        (rows) =>
          rows.length !== rows[0]!.windowPaneCount ||
          rows.some(
            (row) =>
              row.windowPaneCount !== rows.length ||
              row.windowName !== rows[0]!.windowName ||
              row.semanticWindowId !== rows[0]!.semanticWindowId,
          ),
      )
    ) {
      throw new WorkspaceOpenError("workspace_resource_changed", {
        workspaceName: identity.workspaceName,
        reason: "inconsistent_tmux_topology",
      });
    }

    const initialWindows = [...windows.values()].filter(
      (rows) => rows[0]!.semanticWindowId === identity.initialWindowId,
    );
    const initialRows = initialWindows[0];
    if (
      initialWindows.length !== 1 ||
      !initialRows ||
      initialRows.length !== 1 ||
      initialRows[0]!.windowPaneCount !== 1
    ) {
      throw new WorkspaceOpenError("workspace_resource_changed", {
        workspaceName: identity.workspaceName,
        reason: "initial_window_topology_changed",
      });
    }
    const initial = initialRows[0]!;
    if (
      initial.semanticPaneId !== identity.initialPaneId ||
      initial.windowName !== "Terminal" ||
      initial.type !== "shell" ||
      initial.role !== "shell" ||
      initial.name !== "Terminal"
    ) {
      throw new WorkspaceOpenError("workspace_resource_changed", {
        workspaceName: identity.workspaceName,
        reason: "initial_pane_metadata_changed",
      });
    }
    return {
      sessionName: session.sessionName,
      sessionId: session.sessionId,
      paneId: initial.paneId,
      windowId: initial.windowId,
    };
  }

  #createOrReopenSession(
    request: WorkspaceOpenMutationRequest,
    identity: DerivedIdentity,
    canonicalRoot: string,
  ): { readonly runtime: RuntimeIdentity; readonly created: boolean } {
    let output: string;
    try {
      output = this.#io.runTmux([
        "new-session",
        "-d",
        "-P",
        "-F",
        "#{session_id}\t#{pane_id}\t#{window_id}",
        "-s",
        identity.sessionName,
        "-c",
        canonicalRoot,
        "-n",
        "Terminal",
      ]);
    } catch (cause) {
      try {
        const raced = this.#sessionByName(identity.sessionName);
        if (raced) return { runtime: this.#compatibleRuntime(raced, identity), created: false };
      } catch (raceInspectionError) {
        if (raceInspectionError instanceof WorkspaceOpenError) throw raceInspectionError;
      }
      throw new WorkspaceOpenError(
        "workspace_creation_failed",
        { operationId: request.operationId },
        cause,
      );
    }
    const runtime = parseCreatedRuntime(output, identity.sessionName);
    try {
      for (const [option, value] of [
        [SESSION_OPERATION_OPTION, request.operationId],
        [SESSION_MARKER_OPTION, identity.projectKey],
        [SESSION_WORKSPACE_OPTION, identity.workspaceName],
      ] as const) {
        this.#io.runTmux(["set-option", "-t", runtime.sessionId, option, value]);
      }
      for (const [option, value] of [
        [SEMANTIC_PANE_OPTION, identity.initialPaneId],
        ["@ide_type", "shell"],
        ["@ide_role", "shell"],
        ["@ide_name", "Terminal"],
      ] as const) {
        this.#io.runTmux(["set-option", "-p", "-t", runtime.paneId, option, value]);
      }
      this.#io.runTmux([
        "set-option",
        "-w",
        "-t",
        runtime.windowId,
        SEMANTIC_WINDOW_OPTION,
        identity.initialWindowId,
      ]);
      this.#io.runTmux(["select-pane", "-t", runtime.paneId, "-T", "Terminal"]);
      const session = this.#listSessions().find(
        (candidate) => candidate.sessionId === runtime.sessionId,
      );
      if (!session || session.sessionName !== identity.sessionName) {
        throw new WorkspaceOpenError("workspace_creation_failed", {
          operationId: request.operationId,
        });
      }
      const verified = this.#compatibleRuntime(session, identity);
      if (verified.paneId !== runtime.paneId || verified.windowId !== runtime.windowId) {
        throw new WorkspaceOpenError("workspace_creation_failed", {
          operationId: request.operationId,
        });
      }
      return { runtime: { ...runtime, paneId: verified.paneId }, created: true };
    } catch (error) {
      const mapped =
        error instanceof WorkspaceOpenError
          ? error
          : new WorkspaceOpenError(
              "workspace_creation_failed",
              { operationId: request.operationId },
              error,
            );
      if (!this.#cleanupCreatedSession(runtime, identity, request.operationId)) {
        throw new WorkspaceOpenError(
          "workspace_cleanup_unproven",
          { operationId: request.operationId },
          mapped,
        );
      }
      throw mapped;
    }
  }

  #cleanupCreatedSession(
    runtime: RuntimeIdentity,
    identity: DerivedIdentity,
    operationId: string,
  ): boolean {
    try {
      const session = this.#listSessions().find(
        (candidate) => candidate.sessionId === runtime.sessionId,
      );
      if (!session) return true;
      if (
        session.sessionName !== runtime.sessionName ||
        session.operationId !== operationId ||
        (session.projectKey !== "" && session.projectKey !== identity.projectKey) ||
        (session.workspaceName !== "" && session.workspaceName !== identity.workspaceName)
      ) {
        return false;
      }
      const panes = boundedTmuxOutput(
        this.#io.runTmux([
          "list-panes",
          "-s",
          "-t",
          runtime.sessionId,
          "-F",
          "#{session_id}\t#{pane_id}",
        ]),
      );
      if (panes !== `${runtime.sessionId}\t${runtime.paneId}`) return false;
      try {
        this.#io.runTmux(["kill-session", "-t", runtime.sessionId]);
      } catch (error) {
        if (!this.#io.isMissingTmuxTarget(error)) {
          const stillLive = this.#listSessions().some(
            (candidate) => candidate.sessionId === runtime.sessionId,
          );
          if (stillLive) return false;
        }
      }
      return !this.#listSessions().some((candidate) => candidate.sessionId === runtime.sessionId);
    } catch {
      return false;
    }
  }

  #replay(
    existing: OperationRecord,
    request: WorkspaceOpenMutationRequest,
    fingerprint: string,
  ): WorkspaceOpenMutationResult {
    if (existing.fingerprint !== fingerprint) {
      throw new WorkspaceOpenError("operation_conflict", { operationId: request.operationId });
    }
    if (existing.status === "error") throw existing.error;
    let registryRecord: Workspace | null;
    try {
      registryRecord = this.#compatibleRegistryRecord(existing.identity, existing.canonicalRoot);
    } catch (cause) {
      throw new WorkspaceOpenError(
        "workspace_resource_changed",
        { operationId: request.operationId, reason: "registry_mapping_changed" },
        cause,
      );
    }
    if (!registryRecord) {
      throw new WorkspaceOpenError("workspace_resource_changed", {
        operationId: request.operationId,
        reason: "registry_mapping_missing",
      });
    }
    const session = this.#listSessions().find(
      (candidate) => candidate.sessionId === existing.runtime.sessionId,
    );
    if (!session) {
      throw new WorkspaceOpenError("workspace_resource_changed", {
        operationId: request.operationId,
      });
    }
    let runtime: RuntimeIdentity;
    try {
      runtime = this.#compatibleRuntime(session, existing.identity);
    } catch (cause) {
      throw new WorkspaceOpenError(
        "workspace_resource_changed",
        { operationId: request.operationId, reason: "live_workspace_proof_changed" },
        cause,
      );
    }
    if (
      runtime.paneId !== existing.runtime.paneId ||
      runtime.windowId !== existing.runtime.windowId
    ) {
      throw new WorkspaceOpenError("workspace_resource_changed", {
        operationId: request.operationId,
      });
    }
    return WorkspaceOpenMutationResultSchemaZ.parse({
      ...existing.result,
      outcome: "replayed",
    });
  }

  #retireClosedOperations(): void {
    if (this.#operations.size < this.#maxOperations) return;
    let sessions: SessionRecord[];
    try {
      sessions = this.#listSessions();
    } catch {
      return;
    }
    const live = new Set(sessions.map(({ sessionId }) => sessionId));
    for (const [operationId, operation] of this.#operations) {
      if (!live.has(operation.runtime.sessionId)) this.#operations.delete(operationId);
    }
  }

  #rememberFailure(
    request: WorkspaceOpenMutationRequest,
    fingerprint: string,
    error: WorkspaceOpenError,
  ): never {
    if (this.#failures.size >= MAX_REPLAYABLE_FAILURES) {
      const oldest = this.#failures.keys().next().value as string | undefined;
      if (oldest) this.#failures.delete(oldest);
    }
    this.#failures.set(request.operationId, { status: "error", fingerprint, error });
    throw error;
  }

  #mapFailure(error: unknown, request: WorkspaceOpenMutationRequest): WorkspaceOpenError {
    if (error instanceof WorkspaceOpenError) return error;
    return new WorkspaceOpenError(
      "workspace_unavailable",
      { operationId: request.operationId },
      error,
    );
  }

  #assertActive(operationId?: string): void {
    if (this.#disposed) throw this.#disposedError(operationId);
  }

  #disposedError(operationId?: string): WorkspaceOpenError {
    return new WorkspaceOpenError("workspace_unavailable", {
      ...(operationId ? { operationId } : {}),
      reason: "authority_disposed",
    });
  }
}

export type WorkspaceOpenBackend = Pick<WorkspaceOpenAuthority, "open">;
