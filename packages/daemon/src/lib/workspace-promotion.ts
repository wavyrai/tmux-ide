/**
 * Workspace promotion — make an already-adopted tmux session ATTACHABLE by
 * admitting it into the workspace registry through an explicit, owner-initiated
 * action.
 *
 * This is a SEPARATE admission path from the m32 config-free open
 * ({@link ./workspace-open.ts}), which stays byte-identical. The two differ in
 * three ways that matter:
 *  - open CREATES a fresh single-window "Terminal" session it fully controls;
 *    promotion STAMPS an existing, arbitrary-topology session in place.
 *  - open's admission proof asserts the blessed initial-Terminal-window shape;
 *    promotion drops that assertion — a promoted session may have any number of
 *    windows and multi-pane windows. Per-pane attachability (the single-pane
 *    window rule) is enforced later, at attach time, by the semantic pane
 *    catalog — never here.
 *  - promoted sessions carry a DISTINCT provenance marker
 *    ({@link SESSION_PROMOTED_MARKER_OPTION}), never the m32 open marker.
 *
 * Every mutation is additive and inert: a `@tmux_ide_pane_id` stamp does not
 * change how a pane behaves, `@ide_*` are display metadata, and the session
 * options only name the workspace. `registry.add` runs ONLY after stamping and
 * verification succeed, so a mid-flight failure leaves the session harmless —
 * some additive stamps, no registry entry — and a retry (which never overwrites
 * a valid stamp) completes it.
 */
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";

import {
  WorkspacePromoteMutationRequestSchemaZ,
  WorkspacePromoteMutationResultSchemaZ,
  type Workspace,
  type WorkspacePromoteMutationRequest,
  type WorkspacePromoteMutationResult,
  type WorkspacePromotedResource,
} from "@tmux-ide/contracts";
import { TmuxError } from "@tmux-ide/tmux-bridge";

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
import { fleetSessionIdForName } from "../command-center/resources/fleet-catalog.ts";
import {
  harnessForPane,
  isAgentPane,
  resolveAgentPresentation,
  type ApplicationShellPanePresentationFacts,
} from "../command-center/resources/application-shell.ts";

const MAX_OPERATIONS = 128;
const MAX_REPLAYABLE_FAILURES = 64;
const MAX_TMUX_OUTPUT_BYTES = 128 * 1024;

// The durable adopt stamp (mirrors tui/chrome/front-door.ts ADOPTED_OPTION) and
// the tmux-ide identity options. The promotion marker is DELIBERATELY distinct
// from the m32 open marker so a promoted session is a separate provenance.
const ADOPTED_OPTION = "@tmux_ide_adopted";
const SESSION_PROMOTED_MARKER_OPTION = "@tmux_ide_workspace_promoted_v1";
const SESSION_WORKSPACE_OPTION = "@tmux_ide_workspace_name";
const SESSION_OPERATION_OPTION = "@tmux_ide_workspace_promote_operation";
const SEMANTIC_PANE_OPTION = "@tmux_ide_pane_id";
const SEMANTIC_WINDOW_OPTION = "@tmux_ide_window_id";

// Distinctive multi-char field/line delimiters — collision-resistant against
// arbitrary pane paths, window names and user-controlled `@agent_*` values,
// matching the fleet-discovery idiom. A value carrying a newline splits into a
// line without the trailing sentinel; the parser drops it, which surfaces as an
// honest verification failure rather than a silently unstamped pane.
const FIELD = "|tmux-ide-promote-field-v1|";
const SENTINEL = "tmux-ide-promote-v1";

const SESSION_FORMAT = [
  "#{session_name}",
  "#{session_id}",
  "#{session_path}",
  `#{${ADOPTED_OPTION}}`,
  SENTINEL,
].join(FIELD);

const PANE_SCAN_FORMAT = [
  "#{session_id}",
  "#{window_id}",
  "#{window_name}",
  "#{window_panes}",
  "#{session_windows}",
  "#{pane_id}",
  "#{pane_active}",
  "#{pane_current_path}",
  "#{pane_current_command}",
  `#{${SEMANTIC_PANE_OPTION}}`,
  `#{${SEMANTIC_WINDOW_OPTION}}`,
  "#{@ide_type}",
  "#{@ide_role}",
  "#{@ide_name}",
  "#{@agent_state}",
  "#{@agent_status_text}",
  "#{@agent_display_name}",
  SENTINEL,
].join(FIELD);

const PANE_VERIFY_FORMAT = [
  "#{session_id}",
  "#{window_id}",
  "#{window_name}",
  "#{window_panes}",
  "#{session_windows}",
  "#{pane_id}",
  `#{${SEMANTIC_PANE_OPTION}}`,
  `#{${SEMANTIC_WINDOW_OPTION}}`,
  SENTINEL,
].join(FIELD);

export type WorkspacePromotionErrorCode =
  | "daemon_instance_mismatch"
  | "session_not_found"
  | "session_not_adopted"
  | "session_internal"
  | "workspace_conflict"
  | "stamp_failed"
  | "promotion_verification_failed"
  | "operation_conflict"
  | "operation_capacity";

const ERROR_MESSAGES: Readonly<Record<WorkspacePromotionErrorCode, string>> = {
  daemon_instance_mismatch: "The daemon generation changed before the session was promoted.",
  session_not_found: "No adopted fleet session matches the requested session identity.",
  session_not_adopted: "The requested session is not adopted and cannot be promoted.",
  session_internal: "Internal tmux-ide sessions cannot be promoted.",
  workspace_conflict: "The derived workspace identity is already owned by another session.",
  stamp_failed: "tmux could not durably stamp the session for promotion.",
  promotion_verification_failed: "The promoted session did not pass admission verification.",
  operation_conflict: "The operation id was already used for another promotion intent.",
  operation_capacity: "The daemon has reached its bounded workspace-promote operation capacity.",
};

export class WorkspacePromotionError extends Error {
  readonly code: WorkspacePromotionErrorCode;
  readonly context: Readonly<Record<string, string>>;

  constructor(
    code: WorkspacePromotionErrorCode,
    context: Readonly<Record<string, string>> = {},
    cause?: unknown,
  ) {
    super(ERROR_MESSAGES[code], cause === undefined ? undefined : { cause });
    this.name = "WorkspacePromotionError";
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}

interface WorkspacePromotionRegistry {
  list(): Workspace[];
  add(input: AddWorkspaceInput): Workspace;
}

export interface WorkspacePromotionIo {
  readonly runTmux: (args: readonly string[]) => string;
  readonly canonicalProjectDir: (path: string) => string;
  readonly isMissingTmuxTarget: (error: unknown) => boolean;
  readonly isTmuxUnavailable: (error: unknown) => boolean;
  readonly now: () => number;
}

interface SessionRecord {
  readonly sessionName: string;
  readonly sessionId: string;
  readonly sessionPath: string;
  readonly adopted: boolean;
}

interface ScanPane {
  readonly sessionId: string;
  readonly windowId: string;
  readonly paneId: string;
  readonly active: boolean;
  readonly currentPath: string;
  readonly currentCommand: string;
  readonly semanticPaneId: string;
  readonly semanticWindowId: string;
  readonly ideType: string;
  readonly ideRole: string;
  readonly ideName: string;
  readonly agentStateRaw: string;
  readonly agentStatusTextRaw: string;
  readonly agentDisplayNameRaw: string;
}

interface VerifyPane {
  readonly sessionId: string;
  readonly windowId: string;
  readonly windowName: string;
  readonly windowPaneCount: number;
  readonly sessionWindowCount: number;
  readonly paneId: string;
  readonly semanticPaneId: string;
  readonly semanticWindowId: string;
}

interface PromotionIdentity {
  readonly workspaceName: string;
  readonly sessionName: string;
}

interface SuccessfulOperation {
  readonly status: "success";
  readonly fingerprint: string;
  readonly result: WorkspacePromoteMutationResult;
  readonly workspaceName: string;
  readonly sessionName: string;
}

interface FailedOperation {
  readonly status: "error";
  readonly fingerprint: string;
  readonly error: WorkspacePromotionError;
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
    throw new WorkspacePromotionError("promotion_verification_failed", {
      reason: "invalid_tmux_output",
    });
  }
  return value.replace(/(?:\r?\n)+$/u, "");
}

function safeBaseName(name: string): string {
  const value = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^[-_]+|[-_]+$/gu, "")
    .slice(0, 64);
  return value || "session";
}

/** Strip control/DEL, collapse whitespace, clamp — a clean `@ide_name` default. */
function sanitizeLabel(value: string, fallback: string): string {
  const stripped = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159) ? " " : character;
  }).join("");
  const normalized = stripped.replace(/\s+/gu, " ").trim().slice(0, 80);
  return normalized || fallback;
}

/**
 * Whether a session belongs in the visible fleet. Mirrors discovery's
 * `isVisibleFleetSession`: `_`-prefixed sessions are internal plumbing and
 * `zz-`-prefixed sessions are development scratch — neither is promotable.
 */
function isInternalSession(name: string): boolean {
  return name.startsWith("_") || name.startsWith("zz-");
}

const VALID_SEMANTIC_PANE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const RESERVED_DISCOVERED_PREFIX = "terminal.discovered.";

function hasValidPaneStamp(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 128 &&
    VALID_SEMANTIC_PANE_ID.test(value) &&
    !value.startsWith(RESERVED_DISCOVERED_PREFIX)
  );
}

/** Derive a stable, session-keyed workspace identity for a promoted session. */
function derivePromotionIdentity(sessionName: string): PromotionIdentity {
  const key = createHash("sha256")
    .update("tmux-ide.workspace.promote.v1\0", "utf8")
    .update(sessionName, "utf8")
    .digest("hex")
    .slice(0, 32);
  return Object.freeze({
    workspaceName: `${safeBaseName(sessionName)}-${key}`,
    sessionName,
  });
}

function positiveInteger(value: string): number | null {
  if (!/^[1-9][0-9]*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseSessionRecords(output: string): SessionRecord[] {
  const normalized = boundedTmuxOutput(output);
  if (!normalized) return [];
  const records: SessionRecord[] = [];
  for (const line of normalized.split("\n")) {
    const fields = line.split(FIELD);
    if (fields.length !== 5 || fields[4] !== SENTINEL || !/^\$[0-9]+$/u.test(fields[1]!)) {
      continue;
    }
    records.push({
      sessionName: fields[0]!,
      sessionId: fields[1]!,
      sessionPath: fields[2]!,
      adopted: fields[3] === "1",
    });
  }
  return records;
}

function parseScanPanes(output: string): ScanPane[] {
  const normalized = boundedTmuxOutput(output);
  if (!normalized) return [];
  const panes: ScanPane[] = [];
  for (const line of normalized.split("\n")) {
    const fields = line.split(FIELD);
    if (
      fields.length !== 18 ||
      fields[17] !== SENTINEL ||
      !/^\$[0-9]+$/u.test(fields[0]!) ||
      !/^@[0-9]+$/u.test(fields[1]!) ||
      !/^%[0-9]+$/u.test(fields[5]!)
    ) {
      throw new WorkspacePromotionError("promotion_verification_failed", {
        reason: "invalid_tmux_pane_inventory",
      });
    }
    panes.push({
      sessionId: fields[0]!,
      windowId: fields[1]!,
      paneId: fields[5]!,
      active: fields[6] === "1",
      currentPath: fields[7]!,
      currentCommand: fields[8]!,
      semanticPaneId: fields[9]!,
      semanticWindowId: fields[10]!,
      ideType: fields[11]!,
      ideRole: fields[12]!,
      ideName: fields[13]!,
      agentStateRaw: fields[14]!,
      agentStatusTextRaw: fields[15]!,
      agentDisplayNameRaw: fields[16]!,
    });
  }
  return panes;
}

function parseVerifyPanes(output: string): VerifyPane[] {
  const normalized = boundedTmuxOutput(output);
  if (!normalized) return [];
  const panes: VerifyPane[] = [];
  for (const line of normalized.split("\n")) {
    const fields = line.split(FIELD);
    const windowPaneCount = positiveInteger(fields[3] ?? "");
    const sessionWindowCount = positiveInteger(fields[4] ?? "");
    if (
      fields.length !== 9 ||
      fields[8] !== SENTINEL ||
      !/^\$[0-9]+$/u.test(fields[0]!) ||
      !/^@[0-9]+$/u.test(fields[1]!) ||
      !/^%[0-9]+$/u.test(fields[5]!) ||
      windowPaneCount === null ||
      sessionWindowCount === null
    ) {
      throw new WorkspacePromotionError("promotion_verification_failed", {
        reason: "invalid_tmux_pane_inventory",
      });
    }
    panes.push({
      sessionId: fields[0]!,
      windowId: fields[1]!,
      windowName: fields[2]!,
      windowPaneCount,
      sessionWindowCount,
      paneId: fields[5]!,
      semanticPaneId: fields[6]!,
      semanticWindowId: fields[7]!,
    });
  }
  return panes;
}

function resource(workspaceName: string): WorkspacePromotedResource {
  return { resourceVersion: 1, workspaceName };
}

function requestFingerprint(request: WorkspacePromoteMutationRequest): string {
  return JSON.stringify(request);
}

const DEFAULT_IO: Omit<WorkspacePromotionIo, "runTmux"> = {
  canonicalProjectDir: (path) => {
    const canonical = realpathSync(path);
    if (!statSync(canonical).isDirectory()) throw new Error("project root is not a directory");
    return canonical;
  },
  isMissingTmuxTarget: (error) => error instanceof TmuxError && error.code === "SESSION_NOT_FOUND",
  isTmuxUnavailable: (error) => error instanceof TmuxError && error.code === "TMUX_UNAVAILABLE",
  now: () => Date.now(),
};

/**
 * Owner-capability-gated admission that turns an adopted tmux session into a
 * registry workspace. Idempotent and serialized exactly like
 * {@link ../lib/workspace-open.ts}'s authority — a repeated operation id replays,
 * and an already-registered session resolves to a `replayed` outcome.
 */
export class WorkspacePromotionAuthority {
  readonly #daemonInstanceId: string;
  readonly #registry: WorkspacePromotionRegistry;
  readonly #io: WorkspacePromotionIo;
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
    registry?: WorkspacePromotionRegistry;
    io?: Partial<WorkspacePromotionIo>;
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

  promote(raw: WorkspacePromoteMutationRequest): Promise<WorkspacePromoteMutationResult> {
    if (this.#disposed) return Promise.reject(this.#disposedError());
    if (this.#pendingOperations >= this.#maxPendingOperations) {
      return Promise.reject(
        new WorkspacePromotionError("operation_capacity", { reason: "admission_queue_full" }),
      );
    }
    this.#pendingOperations += 1;
    const run = this.#tail.then(
      () => this.#promote(raw),
      () => this.#promote(raw),
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

  async #promote(raw: WorkspacePromoteMutationRequest): Promise<WorkspacePromoteMutationResult> {
    this.#assertActive();
    const request = WorkspacePromoteMutationRequestSchemaZ.parse(raw);
    if (request.expectedDaemonInstanceId !== this.#daemonInstanceId) {
      throw new WorkspacePromotionError("daemon_instance_mismatch", {
        operationId: request.operationId,
      });
    }
    const fingerprint = requestFingerprint(request);
    const existing =
      this.#operations.get(request.operationId) ?? this.#failures.get(request.operationId);
    if (existing) return this.#replay(existing, request, fingerprint);
    this.#retireClosedOperations();
    if (this.#operations.size >= this.#maxOperations) {
      throw new WorkspacePromotionError("operation_capacity", { operationId: request.operationId });
    }

    try {
      const session = this.#resolveSession(request.intent.sessionId);

      // Already a registry workspace — including an app-created (m32) session —
      // is idempotent, not an error: it is already attachable. Resolve to a
      // `replayed` outcome against the existing workspace name.
      const alreadyRegistered = this.#registry
        .list()
        .find((workspace) => workspace.sessionName === session.sessionName);
      if (alreadyRegistered) {
        return this.#succeed(request, fingerprint, alreadyRegistered.name, session.sessionName, {
          replayed: true,
        });
      }

      const identity = derivePromotionIdentity(session.sessionName);
      this.#assertConflictFreeIdentity(identity);

      const canonicalRoot = this.#stampSession(request, session, identity);
      this.#assertActive(request.operationId);
      this.#verifyPromotedInventory(session.sessionId, identity);

      let registered: Workspace;
      try {
        registered = this.#registry.add({
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
          const raced = this.#registry
            .list()
            .find((workspace) => workspace.name === identity.workspaceName);
          if (raced && raced.sessionName === identity.sessionName) {
            return this.#succeed(request, fingerprint, raced.name, identity.sessionName, {
              replayed: true,
            });
          }
          throw new WorkspacePromotionError("workspace_conflict", {
            operationId: request.operationId,
            workspaceName: identity.workspaceName,
          });
        }
        throw error;
      }

      return this.#succeed(request, fingerprint, registered.name, identity.sessionName, {
        replayed: false,
      });
    } catch (error) {
      return this.#rememberFailure(request, fingerprint, this.#mapFailure(error, request));
    }
  }

  #resolveSession(sessionId: string): SessionRecord {
    const records = this.#listSessions();
    const matches = records.filter(
      (record) => fleetSessionIdForName(record.sessionName) === sessionId,
    );
    if (matches.length !== 1) {
      throw new WorkspacePromotionError("session_not_found", { sessionId });
    }
    const match = matches[0]!;
    if (isInternalSession(match.sessionName)) {
      throw new WorkspacePromotionError("session_internal", { sessionId });
    }
    if (!match.adopted) {
      throw new WorkspacePromotionError("session_not_adopted", { sessionId });
    }
    return match;
  }

  #listSessions(): SessionRecord[] {
    try {
      return parseSessionRecords(this.#io.runTmux(["list-sessions", "-F", SESSION_FORMAT]));
    } catch (error) {
      if (this.#io.isTmuxUnavailable(error)) return [];
      throw error;
    }
  }

  #assertConflictFreeIdentity(identity: PromotionIdentity): void {
    for (const workspace of this.#registry.list()) {
      if (
        workspace.name === identity.workspaceName &&
        workspace.sessionName !== identity.sessionName
      ) {
        throw new WorkspacePromotionError("workspace_conflict", {
          workspaceName: identity.workspaceName,
        });
      }
    }
  }

  /**
   * Stamp the session in place — additive, never overwriting a valid pane stamp
   * — and return the canonical project dir captured from its active pane. Every
   * `set-option` failure maps to `stamp_failed`; the caller has not yet touched
   * the registry, so a failure here leaves the session harmless.
   */
  #stampSession(
    request: WorkspacePromoteMutationRequest,
    session: SessionRecord,
    identity: PromotionIdentity,
  ): string {
    let scanned: ScanPane[];
    try {
      scanned = parseScanPanes(
        this.#io.runTmux(["list-panes", "-s", "-t", session.sessionId, "-F", PANE_SCAN_FORMAT]),
      );
    } catch (error) {
      if (error instanceof WorkspacePromotionError) throw error;
      if (this.#io.isMissingTmuxTarget(error)) {
        throw new WorkspacePromotionError("promotion_verification_failed", {
          reason: "session_vanished_before_stamp",
        });
      }
      throw error;
    }
    if (scanned.length === 0 || scanned.some((pane) => pane.sessionId !== session.sessionId)) {
      throw new WorkspacePromotionError("promotion_verification_failed", {
        reason: "empty_or_foreign_pane_inventory",
      });
    }

    const nowSec = Math.floor(this.#io.now() / 1000);
    const stampedWindows = new Set<string>();
    try {
      for (const pane of scanned) {
        if (!hasValidPaneStamp(pane.semanticPaneId)) {
          const paneStamp = `pane.promoted.${digest(`${session.sessionName}\0${pane.paneId}`)}`;
          this.#io.runTmux([
            "set-option",
            "-p",
            "-t",
            pane.paneId,
            SEMANTIC_PANE_OPTION,
            paneStamp,
          ]);
          for (const [option, value] of this.#ideDefaults(pane, nowSec)) {
            // Additive: only fill an empty `@ide_*`, never clobber existing intent.
            if (value === null) continue;
            this.#io.runTmux(["set-option", "-p", "-t", pane.paneId, option, value]);
          }
        }
        if (pane.semanticWindowId.length === 0 && !stampedWindows.has(pane.windowId)) {
          stampedWindows.add(pane.windowId);
          const windowStamp = `window.promoted.${digest(`${session.sessionName}\0${pane.windowId}`)}`;
          this.#io.runTmux([
            "set-option",
            "-w",
            "-t",
            pane.windowId,
            SEMANTIC_WINDOW_OPTION,
            windowStamp,
          ]);
        }
      }
      for (const [option, value] of [
        [SESSION_OPERATION_OPTION, request.operationId],
        [SESSION_WORKSPACE_OPTION, identity.workspaceName],
        [SESSION_PROMOTED_MARKER_OPTION, "1"],
      ] as const) {
        this.#io.runTmux(["set-option", "-t", session.sessionId, option, value]);
      }
    } catch (error) {
      throw new WorkspacePromotionError(
        "stamp_failed",
        { operationId: request.operationId, workspaceName: identity.workspaceName },
        error,
      );
    }

    return this.#resolveProjectDir(session, scanned);
  }

  /**
   * Resolve a durable project root for the workspace registry. Real fleets
   * routinely contain panes whose cwd is a DELETED directory (a pruned git
   * worktree, a removed checkout) — a dead pane cwd must never block promotion.
   * Resolution walks a bounded candidate list, taking the first that realpaths
   * to a live directory:
   *   (a) the tmux `session_path` (stable, session-level, survives pane churn);
   *   (b) then the active pane's cwd, then the remaining panes in scan order;
   *   (c) only when NOTHING resolves does promotion fail.
   */
  #resolveProjectDir(session: SessionRecord, scanned: readonly ScanPane[]): string {
    const active = scanned.find((pane) => pane.active);
    const candidates = [
      session.sessionPath,
      active?.currentPath ?? "",
      ...scanned.filter((pane) => pane !== active).map((pane) => pane.currentPath),
    ];
    for (const candidate of candidates) {
      if (candidate.length === 0) continue;
      try {
        return this.#io.canonicalProjectDir(candidate);
      } catch {
        // A dead or non-directory cwd (a pruned worktree) is expected; try the
        // next candidate rather than failing the whole promotion.
      }
    }
    throw new WorkspacePromotionError("promotion_verification_failed", {
      reason: "project_directory_unavailable",
    });
  }

  #ideDefaults(pane: ScanPane, nowSec: number): ReadonlyArray<readonly [string, string | null]> {
    const facts: ApplicationShellPanePresentationFacts = {
      semanticPaneId: null,
      index: 0,
      title: "",
      currentCommand: pane.currentCommand,
      active: pane.active,
      role: pane.ideRole === "" ? null : pane.ideRole,
      name: pane.ideName === "" ? null : pane.ideName,
      type: pane.ideType === "" ? null : pane.ideType,
      agentStateRaw: pane.agentStateRaw === "" ? null : pane.agentStateRaw,
      agentStatusTextRaw: pane.agentStatusTextRaw === "" ? null : pane.agentStatusTextRaw,
      agentDisplayNameRaw: pane.agentDisplayNameRaw === "" ? null : pane.agentDisplayNameRaw,
      // Authority-only: promotion never scrapes. `null` keeps presentation on
      // the ground-truth path without a capture round-trip.
      agentScrapeState: null,
    };
    const isAgent = isAgentPane(facts);
    const type = isAgent ? "agent" : "shell";
    const role = isAgent ? "agent" : "shell";
    let name: string;
    if (isAgent) {
      const presentation = resolveAgentPresentation(facts, nowSec);
      const detected = presentation.displayName ?? pane.currentCommand;
      name = sanitizeLabel(detected, harnessForPane(facts));
    } else {
      name = "Terminal";
    }
    return [
      ["@ide_type", pane.ideType === "" ? type : null],
      ["@ide_role", pane.ideRole === "" ? role : null],
      ["@ide_name", pane.ideName === "" ? name : null],
    ];
  }

  /**
   * Promotion-mode admission. Runs the SAME catalog-integrity and topology
   * checks m32 uses (no missing/duplicate/invalid stamps, inventory captured
   * twice unchanged, consistent per-window shape) but WITHOUT the m32
   * initial-Terminal-window assertion — a promoted session may have any number
   * of windows and multi-pane windows.
   */
  #verifyPromotedInventory(sessionId: string, identity: PromotionIdentity): void {
    let panes: VerifyPane[];
    try {
      const args = ["list-panes", "-s", "-t", sessionId, "-F", PANE_VERIFY_FORMAT] as const;
      const before = boundedTmuxOutput(this.#io.runTmux(args));
      const after = boundedTmuxOutput(this.#io.runTmux(args));
      if (before !== after) {
        throw new WorkspacePromotionError("promotion_verification_failed", {
          reason: "inventory_changed_during_proof",
        });
      }
      panes = parseVerifyPanes(after);
    } catch (error) {
      if (error instanceof WorkspacePromotionError) throw error;
      if (this.#io.isMissingTmuxTarget(error)) {
        throw new WorkspacePromotionError("promotion_verification_failed", {
          reason: "session_vanished_during_proof",
        });
      }
      throw error;
    }

    if (panes.length === 0 || panes.some((pane) => pane.sessionId !== sessionId)) {
      throw new WorkspacePromotionError("promotion_verification_failed", {
        reason: "empty_or_foreign_pane_inventory",
      });
    }
    if (panes.some((pane) => pane.semanticWindowId.length === 0)) {
      throw new WorkspacePromotionError("promotion_verification_failed", {
        reason: "missing_window_stamp",
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
      throw new WorkspacePromotionError("promotion_verification_failed", {
        reason: "semantic_pane_catalog_rejected_inventory",
      });
    }

    const windows = new Map<string, VerifyPane[]>();
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
      throw new WorkspacePromotionError("promotion_verification_failed", {
        reason: "inconsistent_tmux_topology",
      });
    }
  }

  #succeed(
    request: WorkspacePromoteMutationRequest,
    fingerprint: string,
    workspaceName: string,
    sessionName: string,
    options: { readonly replayed: boolean },
  ): WorkspacePromoteMutationResult {
    const result = WorkspacePromoteMutationResultSchemaZ.parse({
      operationId: request.operationId,
      daemonInstanceId: this.#daemonInstanceId,
      outcome: options.replayed ? "replayed" : "promoted",
      resource: resource(workspaceName),
    });
    this.#operations.set(request.operationId, {
      status: "success",
      fingerprint,
      result,
      workspaceName,
      sessionName,
    });
    return result;
  }

  #replay(
    existing: OperationRecord,
    request: WorkspacePromoteMutationRequest,
    fingerprint: string,
  ): WorkspacePromoteMutationResult {
    if (existing.fingerprint !== fingerprint) {
      throw new WorkspacePromotionError("operation_conflict", { operationId: request.operationId });
    }
    if (existing.status === "error") throw existing.error;
    const stillRegistered = this.#registry
      .list()
      .some(
        (workspace) =>
          workspace.name === existing.workspaceName &&
          workspace.sessionName === existing.sessionName,
      );
    if (!stillRegistered) {
      throw new WorkspacePromotionError("promotion_verification_failed", {
        operationId: request.operationId,
        reason: "registry_mapping_missing",
      });
    }
    return WorkspacePromoteMutationResultSchemaZ.parse({
      ...existing.result,
      outcome: "replayed",
    });
  }

  #retireClosedOperations(): void {
    if (this.#operations.size < this.#maxOperations) return;
    let live: Set<string>;
    try {
      live = new Set(this.#registry.list().map((workspace) => workspace.name));
    } catch {
      return;
    }
    for (const [operationId, operation] of this.#operations) {
      if (!live.has(operation.workspaceName)) this.#operations.delete(operationId);
    }
  }

  #rememberFailure(
    request: WorkspacePromoteMutationRequest,
    fingerprint: string,
    error: WorkspacePromotionError,
  ): never {
    if (this.#failures.size >= MAX_REPLAYABLE_FAILURES) {
      const oldest = this.#failures.keys().next().value as string | undefined;
      if (oldest) this.#failures.delete(oldest);
    }
    this.#failures.set(request.operationId, { status: "error", fingerprint, error });
    throw error;
  }

  #mapFailure(error: unknown, request: WorkspacePromoteMutationRequest): WorkspacePromotionError {
    if (error instanceof WorkspacePromotionError) return error;
    return new WorkspacePromotionError(
      "promotion_verification_failed",
      { operationId: request.operationId, reason: "unexpected_failure" },
      error,
    );
  }

  #assertActive(operationId?: string): void {
    if (this.#disposed) throw this.#disposedError(operationId);
  }

  #disposedError(operationId?: string): WorkspacePromotionError {
    return new WorkspacePromotionError("promotion_verification_failed", {
      ...(operationId ? { operationId } : {}),
      reason: "authority_disposed",
    });
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

export type WorkspacePromotionBackend = Pick<WorkspacePromotionAuthority, "promote">;
