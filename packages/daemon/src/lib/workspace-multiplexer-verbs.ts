/**
 * The multiplexer mutation authority: split, kill, rename, zoom, select, swap
 * and resize.
 *
 * This is the tmux authority the m48 audit found missing. It follows the
 * `workspace.pane.create` discipline deliberately and in full — one serialized
 * queue per tmux session, operation-id idempotency with a request fingerprint, a pinned tmux
 * executable and socket resolved once per daemon generation, semantic-id
 * resolution that never trusts a renderer-supplied tmux target, and a read-back
 * verification after every mutation. Where creation proves a pane exists, these
 * verbs prove the thing they changed actually changed.
 *
 * Two refusals are policy rather than mechanics, and both fail closed:
 * `kill-window` on a session's last window and `kill-pane` on the last pane of
 * that last window are refused with a typed code instead of being allowed to
 * take the session down as a side effect. Killing a session is a real verb with
 * its own route and its own confirmation; a user closing a pane has not asked
 * for it, and tmux's own willingness to oblige is a trap rather than a feature.
 */
import { realpathSync, statSync } from "node:fs";

import {
  WorkspaceMultiplexerMutationRequestSchemaZ,
  WorkspaceMultiplexerMutationResultSchemaZ,
  type WorkspaceMultiplexerIntent,
  type WorkspaceMultiplexerMutationRequest,
  type WorkspaceMultiplexerMutationResult,
  type WorkspaceMultiplexerWindowTarget,
  type SessionRuntimePaneReadIntent,
  type Workspace,
} from "@tmux-ide/contracts";
import { TmuxError } from "@tmux-ide/tmux-bridge";

import {
  createPinnedWorkspaceTmuxRunner,
  resolveWorkspacePaneTmuxAuthority,
  semanticPaneIdForOperation,
  type WorkspacePaneTmuxAuthority,
} from "./workspace-pane-creation.ts";
import { getDefaultWorkspaceRegistry, type WorkspaceRegistry } from "./workspace-registry.ts";
import { internalInteractionOperationMarker } from "./tmux-external-interaction-observer.ts";
import {
  INTERNAL_READ_OPERATION_OPTION,
  INTERNAL_SEND_OPERATION_OPTION,
} from "./tmux-interaction-options.ts";

const MAX_OPERATIONS = 128;

const CREATION_OPTION = "@tmux_ide_creation_id";
const SEMANTIC_PANE_OPTION = "@tmux_ide_pane_id";
const SEMANTIC_WINDOW_OPTION = "@tmux_ide_window_id";
const DISPLAY_TITLE_OPTION = "@ide_name";

export type WorkspaceMultiplexerErrorCode =
  | "daemon_instance_mismatch"
  | "workspace_not_found"
  | "workspace_unavailable"
  | "pane_not_found"
  | "window_not_found"
  | "ambiguous_target"
  | "operation_conflict"
  | "operation_capacity"
  /** Refused: killing it would take the whole session with it. */
  | "last_window_refused"
  /** Refused: killing it would take the whole session with it. */
  | "last_pane_refused"
  | "mutation_failed"
  | "mutation_unverified"
  /** Refused: a one-pane window has no border to move. */
  | "single_pane_window"
  /** Refused: a zoomed pane fills its window, so its size is not the layout's. */
  | "zoomed_window_refused"
  /** Refused: direct manipulation may only reorder panes inside one window. */
  | "different_window_refused";

const ERROR_MESSAGES: Readonly<Record<WorkspaceMultiplexerErrorCode, string>> = {
  daemon_instance_mismatch: "The daemon generation changed before the verb ran.",
  workspace_not_found: "The requested workspace is not registered.",
  workspace_unavailable: "The requested workspace is not available for multiplexer verbs.",
  pane_not_found: "No pane in this workspace carries the requested semantic identity.",
  window_not_found: "No window in this workspace carries the requested identity.",
  ambiguous_target: "The requested identity names more than one live tmux object.",
  operation_conflict: "The operation id was already used for a different intent.",
  operation_capacity: "The daemon has reached its bounded multiplexer operation capacity.",
  last_window_refused:
    "This is the session's last window. Close the session instead if that is what you mean.",
  last_pane_refused:
    "This is the session's last pane. Close the session instead if that is what you mean.",
  mutation_failed: "tmux refused the requested change.",
  mutation_unverified: "tmux accepted the change but the result could not be verified.",
  single_pane_window: "This window has only one pane, so it has no border to move.",
  zoomed_window_refused: "Unzoom this window before resizing its panes.",
  different_window_refused: "Panes can only be swapped inside the same window.",
};

export class WorkspaceMultiplexerError extends Error {
  readonly code: WorkspaceMultiplexerErrorCode;
  readonly context: Readonly<Record<string, string>>;

  constructor(
    code: WorkspaceMultiplexerErrorCode,
    context: Readonly<Record<string, string>> = {},
    cause?: unknown,
  ) {
    super(ERROR_MESSAGES[code], cause === undefined ? undefined : { cause });
    this.name = "WorkspaceMultiplexerError";
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}

/**
 * One pane of a workspace session, with the window facts the verbs need.
 *
 * Gathered in a single `list-panes -s` pass so that a decision like "is this
 * the session's last pane" is made against one consistent view rather than
 * against three queries a user could resize between.
 */
export interface MultiplexerPaneRow {
  readonly paneId: string;
  readonly paneIndex: number;
  readonly windowId: string;
  readonly semanticPaneId: string | null;
  readonly semanticWindowId: string | null;
  readonly windowPaneCount: number;
  readonly windowZoomed: boolean;
  readonly paneActive: boolean;
  readonly creationId: string | null;
}

const PANE_FIELDS = [
  "#{pane_id}",
  "#{pane_index}",
  "#{window_id}",
  `#{${SEMANTIC_PANE_OPTION}}`,
  `#{${SEMANTIC_WINDOW_OPTION}}`,
  "#{window_panes}",
  "#{?window_zoomed_flag,1,0}",
  "#{?pane_active,1,0}",
  `#{${CREATION_OPTION}}`,
].join("\t");

const RUNTIME_PANE = /^%(?:0|[1-9][0-9]*)$/u;
const RUNTIME_WINDOW = /^@(?:0|[1-9][0-9]*)$/u;

/**
 * Parse one `list-panes` pass. Exported for unit tests: this is where a tmux
 * output shape that no longer matches becomes a typed refusal rather than an
 * undefined that silently reads as "no panes".
 */
export function parseMultiplexerPaneRows(output: string): readonly MultiplexerPaneRow[] {
  if (output === "") return [];
  const rows: MultiplexerPaneRow[] = [];
  for (const line of output.split("\n")) {
    const fields = line.split("\t");
    if (fields.length !== 9) {
      throw new WorkspaceMultiplexerError("workspace_unavailable", {
        reason: "pane_listing_shape",
      });
    }
    const [
      paneId,
      paneIndex,
      windowId,
      paneStamp,
      windowStamp,
      paneCount,
      zoomed,
      active,
      creationId,
    ] = fields as [string, string, string, string, string, string, string, string, string];
    if (!RUNTIME_PANE.test(paneId) || !RUNTIME_WINDOW.test(windowId)) {
      throw new WorkspaceMultiplexerError("workspace_unavailable", {
        reason: "pane_listing_shape",
      });
    }
    const count = Number(paneCount);
    const index = Number(paneIndex);
    if (!Number.isInteger(count) || count < 1 || !Number.isInteger(index) || index < 0) {
      throw new WorkspaceMultiplexerError("workspace_unavailable", {
        reason: "pane_listing_shape",
      });
    }
    rows.push({
      paneId,
      paneIndex: index,
      windowId,
      semanticPaneId: paneStamp === "" ? null : paneStamp,
      semanticWindowId: windowStamp === "" ? null : windowStamp,
      windowPaneCount: count,
      windowZoomed: zoomed === "1",
      paneActive: active === "1",
      creationId: creationId === "" ? null : creationId,
    });
  }
  return rows;
}

/** Distinct windows in a pane listing, in first-seen order. */
export function windowIdsOf(rows: readonly MultiplexerPaneRow[]): readonly string[] {
  return [...new Set(rows.map((row) => row.windowId))];
}

/**
 * Resolve a semantic pane id against one listing.
 *
 * Exactly one match is required. Zero is `pane_not_found`; two is
 * `ambiguous_target` rather than a first-wins guess, because a duplicated stamp
 * means the daemon has lost track of which pane it is and killing the wrong one
 * is unrecoverable.
 */
export function resolvePaneRow(
  rows: readonly MultiplexerPaneRow[],
  semanticPaneId: string,
): MultiplexerPaneRow {
  const matches = rows.filter((row) => row.semanticPaneId === semanticPaneId);
  if (matches.length === 0) {
    throw new WorkspaceMultiplexerError("pane_not_found", { semanticPaneId });
  }
  if (matches.length > 1) {
    throw new WorkspaceMultiplexerError("ambiguous_target", { semanticPaneId });
  }
  return matches[0]!;
}

/** Resolve a window target named either by its own stamp or by a pane inside it. */
export function resolveWindowId(
  rows: readonly MultiplexerPaneRow[],
  target: WorkspaceMultiplexerWindowTarget,
): string {
  if (target.by === "pane") {
    return resolvePaneRow(rows, target.semanticPaneId).windowId;
  }
  const matches = new Set(
    rows
      .filter((row) => row.semanticWindowId === target.semanticWindowId)
      .map((row) => row.windowId),
  );
  if (matches.size === 0) {
    throw new WorkspaceMultiplexerError("window_not_found", {
      semanticWindowId: target.semanticWindowId,
    });
  }
  if (matches.size > 1) {
    throw new WorkspaceMultiplexerError("ambiguous_target", {
      semanticWindowId: target.semanticWindowId,
    });
  }
  return [...matches][0]!;
}

/** tmux command arguments may still be format-expanded; `##` is a literal `#`. */
function tmuxFormatLiteral(value: string): string {
  return value.replaceAll("#", "##");
}

interface OperationRecord {
  readonly fingerprint: string;
  readonly status: "success" | "error";
  readonly result?: WorkspaceMultiplexerMutationResult;
  readonly error?: WorkspaceMultiplexerError;
}

export interface WorkspaceMultiplexerIo {
  readonly runTmux: (args: readonly string[]) => string;
  readonly canonicalProjectDir: (path: string) => string;
  readonly isMissingTmuxTarget: (error: unknown) => boolean;
}

function canonicalProjectDir(path: string): string {
  const canonical = realpathSync(path);
  if (!statSync(canonical).isDirectory()) throw new Error("project root is not a directory");
  return canonical;
}

const DEFAULT_IO: Omit<WorkspaceMultiplexerIo, "runTmux"> = {
  canonicalProjectDir,
  isMissingTmuxTarget: (error) =>
    error instanceof TmuxError &&
    (error.code === "SESSION_NOT_FOUND" || error.code === "TMUX_UNAVAILABLE"),
};

export class WorkspaceMultiplexerAuthority {
  readonly #daemonInstanceId: string;
  readonly #registry: WorkspaceRegistry;
  readonly #io: WorkspaceMultiplexerIo;
  readonly #operations = new Map<string, OperationRecord>();
  readonly #tails = new Map<string, Promise<void>>();
  #disposed = false;

  constructor(options: {
    daemonInstanceId: string;
    registry?: WorkspaceRegistry;
    io?: Partial<WorkspaceMultiplexerIo>;
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
  }

  /** Serialized per tmux session: read-decide-mutate never interleaves locally. */
  mutate(raw: WorkspaceMultiplexerMutationRequest): Promise<WorkspaceMultiplexerMutationResult> {
    return Promise.resolve().then(() => {
      const request = WorkspaceMultiplexerMutationRequestSchemaZ.parse(raw);
      const session = this.#registry.get(request.intent.workspaceName)?.sessionName;
      const queue = session ?? `missing:${request.intent.workspaceName}`;
      const previous = this.#tails.get(queue) ?? Promise.resolve();
      const run = previous.then(
        () => this.#mutate(request),
        () => this.#mutate(request),
      );
      const tail = run.then(
        () => undefined,
        () => undefined,
      );
      this.#tails.set(queue, tail);
      void tail.finally(() => {
        if (this.#tails.get(queue) === tail) this.#tails.delete(queue);
      });
      return run;
    });
  }

  /**
   * Capture a semantically addressed pane for an authored read. The tmux
   * after-capture hook is the completion authority; this method only performs
   * the command-list and verifies that its semantic target survived it.
   * SessionRuntimeRegistry serializes this lane with authored sends.
   */
  async readPane(operationId: string, intent: SessionRuntimePaneReadIntent): Promise<void> {
    if (this.#disposed) {
      throw new WorkspaceMultiplexerError("workspace_unavailable", {
        reason: "authority_disposed",
      });
    }
    const workspace = this.#registry.get(intent.workspaceName);
    if (!workspace) {
      throw new WorkspaceMultiplexerError("workspace_not_found", {
        operationId,
        workspaceName: intent.workspaceName,
      });
    }
    const pane = resolvePaneRow(this.#panes(workspace.sessionName), intent.semanticPaneId);
    try {
      this.#io.runTmux([
        "set-option",
        "-p",
        "-t",
        pane.paneId,
        INTERNAL_READ_OPERATION_OPTION,
        internalInteractionOperationMarker(this.#daemonInstanceId, operationId),
        ";",
        "capture-pane",
        "-p",
        "-e",
        "-J",
        "-S",
        "-2000",
        "-t",
        pane.paneId,
      ]);
    } catch (error) {
      try {
        this.#io.runTmux(["set-option", "-pu", "-t", pane.paneId, INTERNAL_READ_OPERATION_OPTION]);
      } catch {
        // The pane may have disappeared with the failed capture.
      }
      throw error;
    }
    const observed = resolvePaneRow(this.#panes(workspace.sessionName), intent.semanticPaneId);
    if (observed.paneId !== pane.paneId) {
      throw new WorkspaceMultiplexerError("mutation_unverified", {
        operationId,
        reason: "pane_identity_changed_during_read",
      });
    }
  }

  dispose(): Promise<void> {
    this.#disposed = true;
    return Promise.allSettled(this.#tails.values()).then(() => {
      this.#tails.clear();
      this.#operations.clear();
    });
  }

  async #mutate(
    raw: WorkspaceMultiplexerMutationRequest,
  ): Promise<WorkspaceMultiplexerMutationResult> {
    if (this.#disposed) {
      throw new WorkspaceMultiplexerError("workspace_unavailable", {
        reason: "authority_disposed",
      });
    }
    const request = WorkspaceMultiplexerMutationRequestSchemaZ.parse(raw);
    if (request.expectedDaemonInstanceId !== this.#daemonInstanceId) {
      throw new WorkspaceMultiplexerError("daemon_instance_mismatch", {
        operationId: request.operationId,
      });
    }
    const requestFingerprint = JSON.stringify(request);
    const existing = this.#operations.get(request.operationId);
    if (existing) {
      if (existing.fingerprint !== requestFingerprint) {
        throw new WorkspaceMultiplexerError("operation_conflict", {
          operationId: request.operationId,
        });
      }
      if (existing.status === "error") throw existing.error!;
      return WorkspaceMultiplexerMutationResultSchemaZ.parse({
        ...existing.result!,
        outcome: "replayed",
      });
    }
    if (this.#operations.size >= MAX_OPERATIONS) {
      // Bounded FIFO. An evicted id loses only its replay guarantee; the world
      // it already changed is unaffected.
      const oldest = this.#operations.keys().next().value as string | undefined;
      if (oldest !== undefined) this.#operations.delete(oldest);
    }

    const workspace = this.#registry.get(request.intent.workspaceName);
    if (!workspace) {
      const error = new WorkspaceMultiplexerError("workspace_not_found", {
        operationId: request.operationId,
        workspaceName: request.intent.workspaceName,
      });
      this.#operations.set(request.operationId, {
        fingerprint: requestFingerprint,
        status: "error",
        error,
      });
      throw error;
    }

    try {
      const result = await this.#perform(request, workspace);
      const parsed = WorkspaceMultiplexerMutationResultSchemaZ.parse(result);
      this.#operations.set(request.operationId, {
        fingerprint: requestFingerprint,
        status: "success",
        result: parsed,
      });
      return parsed;
    } catch (error) {
      const mapped =
        error instanceof WorkspaceMultiplexerError
          ? error
          : new WorkspaceMultiplexerError(
              "mutation_failed",
              {
                operationId: request.operationId,
                workspaceName: request.intent.workspaceName,
              },
              error,
            );
      this.#operations.set(request.operationId, {
        fingerprint: requestFingerprint,
        status: "error",
        error: mapped,
      });
      throw mapped;
    }
  }

  #panes(sessionName: string): readonly MultiplexerPaneRow[] {
    let output: string;
    try {
      output = this.#io.runTmux(["list-panes", "-s", "-t", `=${sessionName}`, "-F", PANE_FIELDS]);
    } catch (cause) {
      throw new WorkspaceMultiplexerError(
        "workspace_unavailable",
        { sessionName, reason: "session_unreachable" },
        cause,
      );
    }
    return parseMultiplexerPaneRows(output);
  }

  async #perform(
    request: WorkspaceMultiplexerMutationRequest,
    workspace: Workspace,
  ): Promise<WorkspaceMultiplexerMutationResult> {
    const intent = request.intent;
    const sessionName = workspace.sessionName;
    const envelope = {
      operationId: request.operationId,
      daemonInstanceId: this.#daemonInstanceId,
      workspaceName: intent.workspaceName,
    } as const;

    switch (intent.verb) {
      case "workspace.window.split":
        return this.#split(request, workspace, envelope);
      case "workspace.window.kill":
        return this.#killWindow(intent, sessionName, envelope);
      case "workspace.pane.kill":
        return this.#killPane(intent, sessionName, envelope);
      case "workspace.session.kill":
        return this.#killSession(sessionName, envelope);
      case "workspace.rename":
        return this.#rename(intent, workspace, envelope);
      case "workspace.pane.zoom.toggle":
        return this.#zoom(intent, sessionName, envelope);
      case "workspace.pane.select":
        return this.#select(intent, sessionName, envelope);
      case "workspace.pane.send":
        return this.#send(intent, sessionName, envelope);
      case "workspace.pane.swap":
        return this.#swap(intent, sessionName, envelope);
      case "workspace.pane.resize":
        return this.#resize(intent, sessionName, envelope);
    }
  }

  // -------------------------------------------------------------------------
  // split
  // -------------------------------------------------------------------------

  #split(
    request: WorkspaceMultiplexerMutationRequest,
    workspace: Workspace,
    envelope: { operationId: string; daemonInstanceId: string; workspaceName: string },
  ): WorkspaceMultiplexerMutationResult {
    const intent = request.intent;
    if (intent.verb !== "workspace.window.split") throw new TypeError("wrong intent");
    const sessionName = workspace.sessionName;
    const semanticPaneId = semanticPaneIdForOperation(request.operationId);
    const displayTitle = intent.displayTitle ?? "Terminal";

    const rows = this.#panes(sessionName);
    // Crash recovery: a split whose stamping completed but whose answer never
    // reached the host is a completed operation, not a reason to split twice.
    const already = rows.find((row) => row.creationId === request.operationId);
    if (already) {
      return {
        ...envelope,
        verb: "workspace.window.split",
        outcome: "replayed",
        direction: intent.direction,
        semanticPaneId,
        displayTitle,
      };
    }

    const source = resolvePaneRow(rows, intent.semanticPaneId);
    const canonicalRoot = this.#io.canonicalProjectDir(workspace.projectDir);
    const created = this.#io.runTmux([
      "split-window",
      intent.direction === "right" ? "-h" : "-v",
      "-d",
      "-P",
      "-F",
      "#{pane_id}\t#{window_id}",
      "-t",
      source.paneId,
      "-c",
      canonicalRoot,
    ]);
    const match = /^(%[0-9]+)\t(@[0-9]+)$/u.exec(created);
    if (!match) {
      throw new WorkspaceMultiplexerError("mutation_unverified", {
        operationId: request.operationId,
        reason: "split_output_unparseable",
      });
    }
    const paneId = match[1]!;

    try {
      // Same stamps a created pane carries, from the same generator, so a split
      // pane is addressable by every route that addresses a created one.
      for (const [option, value] of [
        [CREATION_OPTION, request.operationId],
        [SEMANTIC_PANE_OPTION, semanticPaneId],
        ["@ide_type", "shell"],
        ["@ide_role", "shell"],
        [DISPLAY_TITLE_OPTION, displayTitle],
      ] as const) {
        this.#io.runTmux(["set-option", "-p", "-t", paneId, option, value]);
      }
      const inspected = this.#io.runTmux([
        "display-message",
        "-p",
        "-t",
        paneId,
        [
          "#{pane_id}",
          `#{${SEMANTIC_PANE_OPTION}}`,
          `#{${CREATION_OPTION}}`,
          `#{${DISPLAY_TITLE_OPTION}}`,
        ].join("\t"),
      ]);
      if (inspected !== [paneId, semanticPaneId, request.operationId, displayTitle].join("\t")) {
        throw new WorkspaceMultiplexerError("mutation_unverified", {
          operationId: request.operationId,
          reason: "split_stamp_mismatch",
        });
      }
    } catch (error) {
      // Only ever kill a pane this operation is proven to own.
      this.#cleanupOwnedPane(paneId, request.operationId);
      throw error;
    }

    return {
      ...envelope,
      verb: "workspace.window.split",
      outcome: "applied",
      direction: intent.direction,
      semanticPaneId,
      displayTitle,
    };
  }

  #cleanupOwnedPane(paneId: string, operationId: string): void {
    try {
      const proof = this.#io.runTmux([
        "display-message",
        "-p",
        "-t",
        paneId,
        `#{pane_id}\t#{${CREATION_OPTION}}`,
      ]);
      if (proof !== `${paneId}\t${operationId}`) return;
      this.#io.runTmux(["kill-pane", "-t", paneId]);
    } catch {
      // The pane is already gone, or tmux is unreachable. Either way there is
      // nothing this operation is entitled to kill.
    }
  }

  // -------------------------------------------------------------------------
  // kill
  // -------------------------------------------------------------------------

  #killWindow(
    intent: Extract<WorkspaceMultiplexerIntent, { verb: "workspace.window.kill" }>,
    sessionName: string,
    envelope: { operationId: string; daemonInstanceId: string; workspaceName: string },
  ): WorkspaceMultiplexerMutationResult {
    const rows = this.#panes(sessionName);
    const windowId = resolveWindowId(rows, intent.target);
    const windows = windowIdsOf(rows);
    if (windows.length <= 1) {
      throw new WorkspaceMultiplexerError("last_window_refused", {
        operationId: envelope.operationId,
        workspaceName: envelope.workspaceName,
      });
    }
    this.#io.runTmux(["kill-window", "-t", windowId]);
    const after = windowIdsOf(this.#panes(sessionName));
    if (after.includes(windowId)) {
      throw new WorkspaceMultiplexerError("mutation_unverified", {
        operationId: envelope.operationId,
        reason: "window_still_present",
      });
    }
    return {
      ...envelope,
      verb: "workspace.window.kill",
      outcome: "applied",
      remainingWindowCount: after.length,
    };
  }

  #killPane(
    intent: Extract<WorkspaceMultiplexerIntent, { verb: "workspace.pane.kill" }>,
    sessionName: string,
    envelope: { operationId: string; daemonInstanceId: string; workspaceName: string },
  ): WorkspaceMultiplexerMutationResult {
    const rows = this.#panes(sessionName);
    const pane = resolvePaneRow(rows, intent.semanticPaneId);
    const windows = windowIdsOf(rows);
    // Killing the last pane of a window closes that window — which is fine
    // unless it is also the session's last, in which case tmux would end the
    // session. That is a different verb and it needs its own confirmation.
    const closesWindow = pane.windowPaneCount === 1;
    if (closesWindow && windows.length <= 1) {
      throw new WorkspaceMultiplexerError("last_pane_refused", {
        operationId: envelope.operationId,
        workspaceName: envelope.workspaceName,
      });
    }
    this.#io.runTmux(["kill-pane", "-t", pane.paneId]);
    const after = this.#panes(sessionName);
    if (after.some((row) => row.paneId === pane.paneId)) {
      throw new WorkspaceMultiplexerError("mutation_unverified", {
        operationId: envelope.operationId,
        reason: "pane_still_present",
      });
    }
    return {
      ...envelope,
      verb: "workspace.pane.kill",
      outcome: "applied",
      windowClosed: closesWindow,
      remainingWindowCount: windowIdsOf(after).length,
    };
  }

  #killSession(
    sessionName: string,
    envelope: { operationId: string; daemonInstanceId: string; workspaceName: string },
  ): WorkspaceMultiplexerMutationResult {
    let existed = true;
    try {
      this.#io.runTmux(["has-session", "-t", `=${sessionName}`]);
    } catch (error) {
      if (!this.#io.isMissingTmuxTarget(error)) throw error;
      existed = false;
    }
    if (existed) {
      this.#io.runTmux(["kill-session", "-t", `=${sessionName}`]);
      let stillPresent = true;
      try {
        this.#io.runTmux(["has-session", "-t", `=${sessionName}`]);
      } catch {
        // A missing session is exactly the proof this verb wanted.
        stillPresent = false;
      }
      if (stillPresent) {
        throw new WorkspaceMultiplexerError("mutation_unverified", {
          operationId: envelope.operationId,
          reason: "session_still_present",
        });
      }
    }
    return {
      ...envelope,
      verb: "workspace.session.kill",
      // `unchanged` is the honest answer for a session that was already gone:
      // the user's goal holds, but this call is not what achieved it.
      outcome: existed ? "applied" : "unchanged",
    };
  }

  // -------------------------------------------------------------------------
  // rename
  // -------------------------------------------------------------------------

  #rename(
    intent: Extract<WorkspaceMultiplexerIntent, { verb: "workspace.rename" }>,
    workspace: Workspace,
    envelope: { operationId: string; daemonInstanceId: string; workspaceName: string },
  ): WorkspaceMultiplexerMutationResult {
    const sessionName = workspace.sessionName;
    if (intent.scope === "session") {
      if (sessionName === intent.name) {
        return {
          ...envelope,
          verb: "workspace.rename",
          outcome: "unchanged",
          scope: "session",
          name: intent.name,
        };
      }
      this.#io.runTmux(["rename-session", "-t", `=${sessionName}`, tmuxFormatLiteral(intent.name)]);
      // The trailing colon matters: `-t "=name"` is read as a pane target and
      // resolves to nothing, so the verification would fail on a rename that
      // actually succeeded. `-t "=name:"` is the session form.
      const observed = this.#io.runTmux([
        "display-message",
        "-p",
        "-t",
        `=${intent.name}:`,
        "#{session_name}",
      ]);
      if (observed !== intent.name) {
        throw new WorkspaceMultiplexerError("mutation_unverified", {
          operationId: envelope.operationId,
          reason: "session_name_mismatch",
        });
      }
      // The registry must follow or the workspace is orphaned on next load.
      this.#registry.renameSession(workspace.name, intent.name);
      return {
        ...envelope,
        verb: "workspace.rename",
        outcome: "applied",
        scope: "session",
        name: intent.name,
      };
    }

    const rows = this.#panes(sessionName);
    const windowId = resolveWindowId(rows, intent.target);
    this.#io.runTmux(["rename-window", "-t", windowId, tmuxFormatLiteral(intent.name)]);
    const observed = this.#io.runTmux(["display-message", "-p", "-t", windowId, "#{window_name}"]);
    if (observed !== intent.name) {
      throw new WorkspaceMultiplexerError("mutation_unverified", {
        operationId: envelope.operationId,
        reason: "window_name_mismatch",
      });
    }
    // The display-title record is per-PANE. Following it on rename is right for
    // a single-pane window, where the window and its one pane are the same
    // object to the user; on a split window each pane keeps its own title
    // rather than being overwritten by the window's.
    const panesOfWindow = rows.filter((row) => row.windowId === windowId);
    if (panesOfWindow.length === 1) {
      this.#io.runTmux([
        "set-option",
        "-p",
        "-t",
        panesOfWindow[0]!.paneId,
        DISPLAY_TITLE_OPTION,
        intent.name,
      ]);
    }
    return {
      ...envelope,
      verb: "workspace.rename",
      outcome: "applied",
      scope: "window",
      name: intent.name,
    };
  }

  // -------------------------------------------------------------------------
  // zoom / select
  // -------------------------------------------------------------------------

  #zoom(
    intent: Extract<WorkspaceMultiplexerIntent, { verb: "workspace.pane.zoom.toggle" }>,
    sessionName: string,
    envelope: { operationId: string; daemonInstanceId: string; workspaceName: string },
  ): WorkspaceMultiplexerMutationResult {
    const rows = this.#panes(sessionName);
    const pane = resolvePaneRow(rows, intent.semanticPaneId);
    const target = intent.desired === "toggle" ? !pane.windowZoomed : intent.desired === "zoomed";
    if (target === pane.windowZoomed) {
      return {
        ...envelope,
        verb: "workspace.pane.zoom.toggle",
        outcome: "unchanged",
        semanticPaneId: intent.semanticPaneId,
        zoomed: pane.windowZoomed,
      };
    }
    this.#io.runTmux(["resize-pane", "-Z", "-t", pane.paneId]);
    const observed = this.#io.runTmux([
      "display-message",
      "-p",
      "-t",
      pane.paneId,
      "#{?window_zoomed_flag,1,0}",
    ]);
    const zoomed = observed === "1";
    if (zoomed !== target) {
      throw new WorkspaceMultiplexerError("mutation_unverified", {
        operationId: envelope.operationId,
        reason: "zoom_state_mismatch",
      });
    }
    return {
      ...envelope,
      verb: "workspace.pane.zoom.toggle",
      outcome: "applied",
      semanticPaneId: intent.semanticPaneId,
      zoomed,
    };
  }

  #select(
    intent: Extract<WorkspaceMultiplexerIntent, { verb: "workspace.pane.select" }>,
    sessionName: string,
    envelope: { operationId: string; daemonInstanceId: string; workspaceName: string },
  ): WorkspaceMultiplexerMutationResult {
    const rows = this.#panes(sessionName);
    const pane = resolvePaneRow(rows, intent.semanticPaneId);
    const wasActive =
      this.#io.runTmux([
        "display-message",
        "-p",
        "-t",
        pane.paneId,
        "#{?pane_active,1,0}\t#{?window_active,1,0}",
      ]) === "1\t1";
    // Both halves matter: select-pane alone moves the cursor inside a window
    // that may not be the one on screen, so an attached client would see
    // nothing move. This is the pair that makes GUI focus reach tmux.
    this.#io.runTmux(["select-window", "-t", pane.windowId]);
    this.#io.runTmux(["select-pane", "-t", pane.paneId]);
    const observed = this.#io.runTmux([
      "display-message",
      "-p",
      "-t",
      pane.paneId,
      "#{?pane_active,1,0}\t#{?window_active,1,0}",
    ]);
    if (observed !== "1\t1") {
      throw new WorkspaceMultiplexerError("mutation_unverified", {
        operationId: envelope.operationId,
        reason: "pane_not_active",
      });
    }
    return {
      ...envelope,
      verb: "workspace.pane.select",
      outcome: wasActive ? "unchanged" : "applied",
      semanticPaneId: intent.semanticPaneId,
    };
  }

  // -------------------------------------------------------------------------
  // send
  // -------------------------------------------------------------------------

  /**
   * Deliver literal bytes to a semantically addressed pane. A successful tmux
   * command plus a post-send identity read-back proves that the resolved pane
   * survived the operation; terminal output remains the independent observation
   * lane and is intentionally not parsed for prompt content.
   */
  #send(
    intent: Extract<WorkspaceMultiplexerIntent, { verb: "workspace.pane.send" }>,
    sessionName: string,
    envelope: { operationId: string; daemonInstanceId: string; workspaceName: string },
  ): WorkspaceMultiplexerMutationResult {
    const before = this.#panes(sessionName);
    const pane = resolvePaneRow(before, intent.semanticPaneId);
    const sourcePane = intent.sourceSemanticPaneId
      ? resolvePaneRow(before, intent.sourceSemanticPaneId)
      : null;
    this.#io.runTmux([
      "set-option",
      "-p",
      "-t",
      pane.paneId,
      INTERNAL_SEND_OPERATION_OPTION,
      internalInteractionOperationMarker(this.#daemonInstanceId, envelope.operationId),
    ]);
    try {
      this.#io.runTmux(["send-keys", "-t", pane.paneId, "-l", "--", intent.text]);
      if (intent.submit) this.#io.runTmux(["send-keys", "-t", pane.paneId, "Enter"]);
    } finally {
      try {
        this.#io.runTmux(["set-option", "-pu", "-t", pane.paneId, INTERNAL_SEND_OPERATION_OPTION]);
      } catch {
        // The pane may have exited while input was delivered. Read-back below
        // still decides whether the overall mutation can be verified.
      }
    }

    const observed = resolvePaneRow(this.#panes(sessionName), intent.semanticPaneId);
    if (observed.paneId !== pane.paneId) {
      throw new WorkspaceMultiplexerError("mutation_unverified", {
        operationId: envelope.operationId,
        reason: "pane_identity_changed_during_send",
      });
    }
    return {
      ...envelope,
      verb: "workspace.pane.send",
      outcome: "applied",
      sourceSemanticPaneId: sourcePane?.semanticPaneId ?? null,
      semanticPaneId: intent.semanticPaneId,
      origin: intent.origin,
      characterCount: Array.from(intent.text).length,
      byteCount: Buffer.byteLength(intent.text, "utf8"),
      submitted: intent.submit,
    };
  }

  // -------------------------------------------------------------------------
  // swap
  // -------------------------------------------------------------------------

  /** Exchange two semantic panes without exposing a tmux target to the caller. */
  #swap(
    intent: Extract<WorkspaceMultiplexerIntent, { verb: "workspace.pane.swap" }>,
    sessionName: string,
    envelope: { operationId: string; daemonInstanceId: string; workspaceName: string },
  ): WorkspaceMultiplexerMutationResult {
    const rows = this.#panes(sessionName);
    const source = resolvePaneRow(rows, intent.sourceSemanticPaneId);
    const target = resolvePaneRow(rows, intent.targetSemanticPaneId);
    if (source.paneId === target.paneId) {
      return {
        ...envelope,
        verb: "workspace.pane.swap",
        outcome: "unchanged",
        sourceSemanticPaneId: intent.sourceSemanticPaneId,
        targetSemanticPaneId: intent.targetSemanticPaneId,
      };
    }
    if (source.windowId !== target.windowId) {
      throw new WorkspaceMultiplexerError("different_window_refused", {
        sourceSemanticPaneId: intent.sourceSemanticPaneId,
        targetSemanticPaneId: intent.targetSemanticPaneId,
      });
    }

    this.#io.runTmux(["swap-pane", "-s", source.paneId, "-t", target.paneId]);

    // Prove the two exact runtime panes exchanged positions. Their semantic
    // stamps follow their processes, while the indices are the layout slots a
    // direct-manipulation surface asked to exchange.
    const after = this.#panes(sessionName);
    const sourceAfter = resolvePaneRow(after, intent.sourceSemanticPaneId);
    const targetAfter = resolvePaneRow(after, intent.targetSemanticPaneId);
    if (
      sourceAfter.paneId !== source.paneId ||
      targetAfter.paneId !== target.paneId ||
      sourceAfter.windowId !== source.windowId ||
      targetAfter.windowId !== target.windowId ||
      sourceAfter.paneIndex !== target.paneIndex ||
      targetAfter.paneIndex !== source.paneIndex
    ) {
      throw new WorkspaceMultiplexerError("mutation_unverified", {
        operationId: envelope.operationId,
        reason: "pane_positions_not_swapped",
      });
    }
    return {
      ...envelope,
      verb: "workspace.pane.swap",
      outcome: "applied",
      sourceSemanticPaneId: intent.sourceSemanticPaneId,
      targetSemanticPaneId: intent.targetSemanticPaneId,
    };
  }

  // -------------------------------------------------------------------------
  // resize
  // -------------------------------------------------------------------------

  /** The pane's own size on one axis, in cells, read straight from tmux. */
  #paneCells(paneId: string, axis: "cols" | "rows"): number {
    const observed = this.#io.runTmux([
      "display-message",
      "-p",
      "-t",
      paneId,
      axis === "cols" ? "#{pane_width}" : "#{pane_height}",
    ]);
    const cells = Number(observed);
    if (!Number.isInteger(cells) || cells < 1) {
      throw new WorkspaceMultiplexerError("mutation_unverified", { reason: "pane_size_shape" });
    }
    return cells;
  }

  /**
   * Move one pane border.
   *
   * The result reports what tmux SETTLED ON rather than what was asked for. A
   * layout has a per-pane minimum and a fixed total, so tmux clamps constantly —
   * and a drag that hit a floor has to read as having stopped there. Reporting
   * the requested number instead would make the view disagree with the layout
   * frame that arrives a moment later, which is the class of divergence this
   * whole view exists to remove.
   */
  #resize(
    intent: Extract<WorkspaceMultiplexerIntent, { verb: "workspace.pane.resize" }>,
    sessionName: string,
    envelope: { operationId: string; daemonInstanceId: string; workspaceName: string },
  ): WorkspaceMultiplexerMutationResult {
    const rows = this.#panes(sessionName);
    const pane = resolvePaneRow(rows, intent.semanticPaneId);
    if (pane.windowPaneCount < 2) {
      throw new WorkspaceMultiplexerError("single_pane_window", {
        semanticPaneId: intent.semanticPaneId,
      });
    }
    if (pane.windowZoomed) {
      // A zoomed pane fills its window; tmux has no border to move, and the size
      // it would report belongs to the zoom rather than to the layout.
      throw new WorkspaceMultiplexerError("zoomed_window_refused", {
        semanticPaneId: intent.semanticPaneId,
      });
    }
    const before = this.#paneCells(pane.paneId, intent.axis);
    if (before === intent.cells) {
      return {
        ...envelope,
        verb: "workspace.pane.resize",
        outcome: "unchanged",
        semanticPaneId: intent.semanticPaneId,
        axis: intent.axis,
        cells: before,
      };
    }
    this.#io.runTmux([
      "resize-pane",
      "-t",
      pane.paneId,
      intent.axis === "cols" ? "-x" : "-y",
      String(intent.cells),
    ]);
    const after = this.#paneCells(pane.paneId, intent.axis);
    return {
      ...envelope,
      verb: "workspace.pane.resize",
      outcome: after === before ? "unchanged" : "applied",
      semanticPaneId: intent.semanticPaneId,
      axis: intent.axis,
      cells: after,
    };
  }
}
