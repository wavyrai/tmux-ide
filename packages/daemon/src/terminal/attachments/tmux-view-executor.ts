import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { runTmux, TmuxError } from "@tmux-ide/tmux-bridge";
import {
  TerminalAttachmentViewerModeSchemaZ,
  TerminalAttachmentViewportSchemaZ,
} from "@tmux-ide/contracts";
import {
  GROUPED_TMUX_MAX_GENERATION,
  GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT,
  GROUPED_TMUX_VIEW_SESSION_PREFIX,
  groupedTmuxViewSessionName,
  planGroupedTmuxAttachment,
  type GroupedTmuxAttachmentPlan,
  type TmuxArgvPlan,
} from "./grouped-tmux.ts";
import type {
  AttachmentViewExecutor,
  EnumeratedMarkedAttachmentView,
  GuardedAttachmentCleanup,
  GuardedAttachmentCleanupResult,
  GuardedAttachmentViewOperation,
  GuardedAttachmentViewOperationResult,
} from "./lease-manager.ts";

const MAX_TMUX_OUTPUT_BYTES = 128 * 1024;
const MAX_ENUMERATED_VIEWS = 256;
const MAX_ENUMERATED_WINDOWS_PER_VIEW = 16;
const MAX_SOURCE_PROOF_ROWS = 8;
const MAX_MARKER_OUTPUT_ROWS = 1;
const SOURCE_PROOF_MISMATCH_SENTINEL = "__tmux_ide_source_proof_mismatch_v1__";
const VIEW_PROOF_MISMATCH_SENTINEL = "__tmux_ide_view_proof_mismatch_v1__";

const RuntimeSessionIdSchemaZ = z
  .string()
  .max(32)
  .regex(/^\$(?:0|[1-9][0-9]*)$/u);
const RuntimeWindowIdSchemaZ = z
  .string()
  .max(32)
  .regex(/^@(?:0|[1-9][0-9]*)$/u);
const RuntimePaneIdSchemaZ = z
  .string()
  .max(32)
  .regex(/^%(?:0|[1-9][0-9]*)$/u);
const MarkerPattern =
  /^v1:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):(0|[1-9][0-9]*)$/u;
const ViewNamePattern = /^_tmux-ide-view-v1-([0-9a-f]{32})-([0-9a-z]+)$/u;

export type TmuxAttachmentCommandResult =
  | { readonly status: "ok"; readonly stdout: string }
  | { readonly status: "not-found" }
  | { readonly status: "variable-not-found" }
  | { readonly status: "failed" };
type TmuxAttachmentStandardCommandResult = Exclude<
  TmuxAttachmentCommandResult,
  { readonly status: "variable-not-found" }
>;

/**
 * Synchronous by design. The final source proof, deadline decision, and tmux
 * process spawn must remain in one uninterrupted JavaScript critical section.
 */
export interface TmuxAttachmentCommandRunner {
  readonly run: (command: TmuxArgvPlan) => TmuxAttachmentCommandResult;
}

export type TmuxAttachmentClientTransportOutcome =
  | { readonly status: "executed" }
  | { readonly status: "source-proof-mismatch" }
  | { readonly status: "view-proof-mismatch" }
  | { readonly status: "failed" };

export interface TmuxAttachmentClientTransportInput {
  readonly operation: "attach" | "recover";
  readonly identity: {
    readonly attachmentId: string;
    readonly generation: number;
    readonly viewSessionName: string;
    readonly markerValue: string;
    readonly expectedSourceSessionId: string;
    readonly expectedViewSessionId: string;
    readonly expectedWindowId: string;
    readonly expectedPaneId: string;
  };
  readonly viewport: {
    readonly cols: number;
    readonly rows: number;
  };
  readonly viewerMode: GroupedTmuxAttachmentPlan["viewerMode"];
}

export interface TmuxAttachmentClientTransportAttempt {
  readonly status: "claimed";
  readonly attemptId: string;
  readonly attachmentId: string;
  readonly generation: number;
  readonly outcome: Promise<TmuxAttachmentClientTransportOutcome>;
}

export type TmuxAttachmentClientTransportErrorCode = "read_only_unavailable";

export class TmuxAttachmentClientTransportError extends Error {
  readonly code: TmuxAttachmentClientTransportErrorCode;

  constructor(code: TmuxAttachmentClientTransportErrorCode) {
    super("The requested terminal attachment transport mode is unavailable.");
    this.name = "TmuxAttachmentClientTransportError";
    this.code = code;
  }
}

/**
 * Explicit capability for commands which create a live tmux client. The
 * ordinary daemon command runner is intentionally not treated as this
 * capability: `attach-session` requires a real PTY-owned tmux client. The
 * transport must not report `executed` until daemon-side tmux discovery
 * proves that exact client attached to the expected view.
 */
export interface TmuxAttachmentClientTransport {
  readonly beginGuardedAttach: (
    input: TmuxAttachmentClientTransportInput,
  ) => TmuxAttachmentClientTransportAttempt;
}

export type TmuxAttachmentViewExecutorErrorCode =
  | "invalid-request"
  | "invalid-tmux-output"
  | "tmux-command-failed"
  | "attachment-transport-unavailable"
  | "read_only_unavailable"
  | "view-state-mismatch"
  | "mutation-outcome-uncertain";

const ERROR_MESSAGES: Record<TmuxAttachmentViewExecutorErrorCode, string> = {
  "invalid-request": "The guarded tmux attachment request is invalid.",
  "invalid-tmux-output": "Trusted tmux attachment discovery returned invalid output.",
  "tmux-command-failed": "The guarded tmux attachment command failed.",
  "attachment-transport-unavailable":
    "A tmux client transport is required for this attachment operation.",
  read_only_unavailable: "Read-only terminal attachment is not proven safe on this daemon.",
  "view-state-mismatch": "The guarded tmux attachment view no longer matches its proof.",
  "mutation-outcome-uncertain": "The guarded tmux attachment mutation outcome is uncertain.",
};

/** Static, serialization-safe errors: raw tmux stderr/stdout is never retained. */
export class TmuxAttachmentViewExecutorError extends Error {
  readonly code: TmuxAttachmentViewExecutorErrorCode;

  constructor(code: TmuxAttachmentViewExecutorErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "TmuxAttachmentViewExecutorError";
    this.code = code;
  }
}

export interface TmuxAttachmentViewExecutorOptions {
  readonly runner?: TmuxAttachmentCommandRunner;
  readonly clientTransport?: TmuxAttachmentClientTransport;
  readonly operationSerializer?: TmuxAttachmentOperationSerializer;
  readonly now?: () => number;
}

interface ParsedViewIdentity {
  readonly attachmentId: string;
  readonly generation: number;
  readonly viewSessionName: string;
  readonly markerValue: string;
  readonly exactTarget: `=${string}`;
}

interface ViewServerGuard {
  readonly sessionId: string;
  readonly windowId: string;
  readonly paneId: string;
  readonly target: string;
  readonly format: string;
}

/** Instance-owned queue shared explicitly by attachment executors for one tmux authority. */
export class TmuxAttachmentOperationSerializer {
  #tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    const run: Promise<T> = this.#tail.then(operation, operation);
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  barrier(): Promise<void> {
    return this.#tail;
  }
}

const productionRunner: TmuxAttachmentCommandRunner = {
  run(command) {
    try {
      const stdout = runTmux([...command.argv], {
        encoding: "utf8",
        maxBuffer: MAX_TMUX_OUTPUT_BYTES,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: "ok", stdout: String(stdout) };
    } catch (error) {
      if (error instanceof TmuxError && error.code === "SESSION_NOT_FOUND") {
        return { status: "not-found" };
      }
      if (error instanceof TmuxError && error.code === "ENVIRONMENT_VARIABLE_NOT_FOUND") {
        return { status: "variable-not-found" };
      }
      return { status: "failed" };
    }
  },
};

function tmux(argv: readonly string[]): TmuxArgvPlan {
  return { executable: "tmux", argv };
}

function quoteTmuxCommandArgument(value: string): string {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new TmuxAttachmentViewExecutorError("invalid-request");
  }
  // JSON's double-quoted escaping is a strict subset of tmux's command parser
  // for the bounded ASCII argv produced by the canonical planner. Quoting
  // every token also keeps runtime ids such as `$12` literal.
  return JSON.stringify(value);
}

function tmuxCommandString(command: TmuxArgvPlan): string {
  if (command.executable !== "tmux") {
    throw new TmuxAttachmentViewExecutorError("invalid-request");
  }
  return command.argv
    .map((argument) => (argument === ";" ? ";" : quoteTmuxCommandArgument(argument)))
    .join(" ");
}

function tmuxCommandListString(commands: readonly TmuxArgvPlan[]): string {
  return commands.map(tmuxCommandString).join(" ; ");
}

function sourcePaneTarget(operation: GuardedAttachmentViewOperation): string {
  return `${operation.source.sessionId}:${operation.source.windowId}.${operation.source.runtimePaneId}`;
}

function sourceProofFormat(operation: GuardedAttachmentViewOperation): string {
  const source = operation.source;
  // The target itself includes the globally unique runtime pane id. tmux's
  // format comparator treats a `%N` rhs specially, so re-check the enclosing
  // session/window/count while target resolution proves the pane identity.
  return `#{&&:#{==:#{session_id},${source.sessionId}},#{&&:#{==:#{window_id},${source.windowId}},#{==:#{window_panes},1}}}`;
}

const TmuxAttachmentClientTransportInputSchemaZ = z
  .object({
    operation: z.enum(["attach", "recover"]),
    identity: z
      .object({
        attachmentId: z.uuid(),
        generation: z.number().int().min(0).max(GROUPED_TMUX_MAX_GENERATION),
        viewSessionName: z.string(),
        markerValue: z.string(),
        expectedSourceSessionId: RuntimeSessionIdSchemaZ,
        expectedViewSessionId: RuntimeSessionIdSchemaZ,
        expectedWindowId: RuntimeWindowIdSchemaZ,
        expectedPaneId: RuntimePaneIdSchemaZ,
      })
      .strict(),
    viewport: TerminalAttachmentViewportSchemaZ,
    viewerMode: TerminalAttachmentViewerModeSchemaZ,
  })
  .strict();

/**
 * Reconstructs the only normal-client argv accepted by the PTY launcher. No
 * caller-authored tmux argv crosses the transport boundary.
 */
export function planCanonicalTmuxAttachmentClientCommand(
  input: TmuxAttachmentClientTransportInput,
): TmuxArgvPlan {
  const parsed = TmuxAttachmentClientTransportInputSchemaZ.parse(input);
  const identity = parsed.identity;
  if (
    groupedTmuxViewSessionName(identity.attachmentId, identity.generation) !==
      identity.viewSessionName ||
    identity.markerValue !== `v1:${identity.attachmentId.toLowerCase()}:${identity.generation}`
  ) {
    throw new TmuxAttachmentViewExecutorError("invalid-request");
  }
  const exactViewTarget = `=${identity.viewSessionName}`;
  const attach = tmux(
    parsed.viewerMode === "read-only"
      ? ["attach-session", "-E", "-r", "-t", exactViewTarget]
      : ["attach-session", "-E", "-t", exactViewTarget],
  );
  const commands =
    parsed.operation === "attach"
      ? [attach]
      : [
          tmux(["select-window", "-t", `${identity.viewSessionName}:${identity.expectedWindowId}`]),
          tmux(["set-option", "-t", identity.viewSessionName, "status", "off"]),
          tmux(["set-option", "-t", identity.viewSessionName, "destroy-unattached", "off"]),
          attach,
        ];
  const mutation = tmuxCommandListString(commands);
  const viewTarget = `${identity.expectedViewSessionId}:${identity.expectedWindowId}.${identity.expectedPaneId}`;
  const viewFormat = `#{&&:#{==:#{session_id},${identity.expectedViewSessionId}},#{&&:#{==:#{window_id},${identity.expectedWindowId}},#{&&:#{==:#{window_panes},1},#{&&:#{==:#{session_windows},1},#{==:#{${GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT}},${identity.markerValue}}}}}}`;
  const viewGuardedMutation = tmuxCommandString(
    tmux([
      "if-shell",
      "-F",
      "-t",
      viewTarget,
      viewFormat,
      mutation,
      tmuxCommandString(tmux(["display-message", "-p", VIEW_PROOF_MISMATCH_SENTINEL])),
    ]),
  );
  const sourceTarget = `${identity.expectedSourceSessionId}:${identity.expectedWindowId}.${identity.expectedPaneId}`;
  const sourceFormat = `#{&&:#{==:#{session_id},${identity.expectedSourceSessionId}},#{&&:#{==:#{window_id},${identity.expectedWindowId}},#{==:#{window_panes},1}}}`;
  return tmux([
    "if-shell",
    "-F",
    "-t",
    sourceTarget,
    sourceFormat,
    viewGuardedMutation,
    tmuxCommandString(tmux(["display-message", "-p", SOURCE_PROOF_MISMATCH_SENTINEL])),
  ]);
}

function boundedOutput(stdout: string): string {
  if (
    typeof stdout !== "string" ||
    stdout.includes("\0") ||
    Buffer.byteLength(stdout, "utf8") > MAX_TMUX_OUTPUT_BYTES
  ) {
    throw new TmuxAttachmentViewExecutorError("invalid-tmux-output");
  }
  return stdout.replace(/(?:\r?\n)+$/u, "");
}

function strictLines(stdout: string, maximum: number): readonly string[] {
  const normalized = boundedOutput(stdout);
  if (normalized === "") return [];
  const lines = normalized.split("\n");
  if (lines.length > maximum || lines.some((line) => line.includes("\r"))) {
    throw new TmuxAttachmentViewExecutorError("invalid-tmux-output");
  }
  return lines;
}

function uuidFromCompactHex(value: string): string {
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function parseViewSessionName(value: string): Omit<ParsedViewIdentity, "markerValue"> | null {
  const match = ViewNamePattern.exec(value);
  if (!match) return null;
  const attachmentId = uuidFromCompactHex(match[1]!);
  if (!z.uuid().safeParse(attachmentId).success) return null;
  const generation = Number.parseInt(match[2]!, 36);
  if (
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    generation > GROUPED_TMUX_MAX_GENERATION ||
    generation.toString(36) !== match[2]
  ) {
    return null;
  }
  if (groupedTmuxViewSessionName(attachmentId, generation) !== value) return null;
  return {
    attachmentId,
    generation,
    viewSessionName: value,
    exactTarget: `=${value}`,
  };
}

function canonicalMarker(attachmentId: string, generation: number): string {
  return `v1:${attachmentId}:${generation}`;
}

function parseCleanupIdentity(cleanup: GuardedAttachmentCleanup): ParsedViewIdentity {
  if (
    cleanup.markerEnvironment !== GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT ||
    !cleanup.exactViewSessionTarget.startsWith("=")
  ) {
    throw new TmuxAttachmentViewExecutorError("invalid-request");
  }
  const parsedName = parseViewSessionName(cleanup.exactViewSessionTarget.slice(1));
  if (!parsedName) throw new TmuxAttachmentViewExecutorError("invalid-request");
  const markerValue = canonicalMarker(parsedName.attachmentId, parsedName.generation);
  if (
    cleanup.expectedMarkerValue !== markerValue ||
    !RuntimeWindowIdSchemaZ.safeParse(cleanup.expectedWindowId).success
  ) {
    throw new TmuxAttachmentViewExecutorError("invalid-request");
  }
  return { ...parsedName, markerValue };
}

function canonicalPlanFor(operation: GuardedAttachmentViewOperation): GroupedTmuxAttachmentPlan {
  try {
    if (
      !Number.isSafeInteger(operation.deadline) ||
      operation.deadline < 0 ||
      !["create", "attach", "recover"].includes(operation.operation)
    ) {
      throw new TmuxAttachmentViewExecutorError("invalid-request");
    }
    const canonical = planGroupedTmuxAttachment({
      attachmentId: operation.plan.identity.attachmentId,
      generation: operation.plan.identity.generation,
      target: operation.plan.identity.semanticTarget,
      viewerMode: operation.plan.viewerMode,
      viewport: operation.plan.viewport,
      source: operation.source,
    });
    if (
      operation.exactViewSessionTarget !== `=${canonical.identity.viewSessionName}` ||
      !isDeepStrictEqual(operation.plan, canonical)
    ) {
      throw new TmuxAttachmentViewExecutorError("invalid-request");
    }
    return canonical;
  } catch {
    throw new TmuxAttachmentViewExecutorError("invalid-request");
  }
}

/**
 * Production executor for the grouped-tmux attachment lease boundary. It does
 * not create a second PTY/runtime model: every command targets tmux itself.
 */
export class TmuxAttachmentViewExecutor implements AttachmentViewExecutor {
  readonly #runner: TmuxAttachmentCommandRunner;
  readonly #clientTransport: TmuxAttachmentClientTransport | null;
  readonly #operationSerializer: TmuxAttachmentOperationSerializer;
  readonly #now: () => number;

  constructor(options: TmuxAttachmentViewExecutorOptions = {}) {
    this.#runner = options.runner ?? productionRunner;
    this.#clientTransport = options.clientTransport ?? null;
    this.#operationSerializer =
      options.operationSerializer ?? new TmuxAttachmentOperationSerializer();
    this.#now = options.now ?? Date.now;
  }

  guardedCleanup(cleanup: GuardedAttachmentCleanup): Promise<GuardedAttachmentCleanupResult> {
    return this.#operationSerializer.run(() => this.#guardedCleanup(cleanup));
  }

  executeGuardedViewOperation(
    operation: GuardedAttachmentViewOperation,
  ): Promise<GuardedAttachmentViewOperationResult> {
    return this.#operationSerializer.run(() => this.#executeGuardedViewOperation(operation));
  }

  enumerateMarkedViews(
    prefix: typeof GROUPED_TMUX_VIEW_SESSION_PREFIX,
    markerEnvironment: typeof GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT,
  ): Promise<readonly EnumeratedMarkedAttachmentView[]> {
    return this.#operationSerializer.run(() =>
      this.#enumerateMarkedViews(prefix, markerEnvironment),
    );
  }

  #command(command: TmuxArgvPlan): TmuxAttachmentStandardCommandResult;
  #command(
    command: TmuxArgvPlan,
    options: { readonly allowVariableNotFound: true },
  ): TmuxAttachmentCommandResult;
  #command(
    command: TmuxArgvPlan,
    options: { readonly allowVariableNotFound?: boolean } = {},
  ): TmuxAttachmentCommandResult {
    if (command.executable !== "tmux") {
      throw new TmuxAttachmentViewExecutorError("invalid-request");
    }
    try {
      const result = this.#runner.run({ executable: "tmux", argv: [...command.argv] });
      if (result.status === "ok") boundedOutput(result.stdout);
      if (
        !["ok", "not-found", "variable-not-found", "failed"].includes(result.status) ||
        (result.status === "variable-not-found" && !options.allowVariableNotFound)
      ) {
        throw new TmuxAttachmentViewExecutorError("tmux-command-failed");
      }
      return result;
    } catch (error) {
      if (error instanceof TmuxAttachmentViewExecutorError) throw error;
      throw new TmuxAttachmentViewExecutorError("tmux-command-failed");
    }
  }

  #clientCommand(
    command: TmuxArgvPlan,
    operation: "attach" | "recover",
    plan: GroupedTmuxAttachmentPlan,
    viewGuard: ViewServerGuard,
  ): TmuxAttachmentClientTransportAttempt {
    if (!this.#clientTransport) {
      throw new TmuxAttachmentViewExecutorError("attachment-transport-unavailable");
    }
    try {
      const input: TmuxAttachmentClientTransportInput = {
        operation,
        identity: {
          attachmentId: plan.identity.attachmentId,
          generation: plan.identity.generation,
          viewSessionName: plan.identity.viewSessionName,
          markerValue: plan.identity.markerValue,
          expectedSourceSessionId: plan.identity.durableSource.sessionId,
          expectedViewSessionId: viewGuard.sessionId,
          expectedWindowId: plan.identity.durableSource.windowId,
          expectedPaneId: plan.identity.durableSource.runtimePaneId,
        },
        viewport: { ...plan.viewport },
        viewerMode: plan.viewerMode,
      };
      if (!isDeepStrictEqual(command, planCanonicalTmuxAttachmentClientCommand(input))) {
        throw new TmuxAttachmentViewExecutorError("invalid-request");
      }
      const result = this.#clientTransport.beginGuardedAttach(input);
      if (
        result.status !== "claimed" ||
        !z.uuid().safeParse(result.attemptId).success ||
        result.attachmentId !== plan.identity.attachmentId ||
        result.generation !== plan.identity.generation ||
        !(result.outcome instanceof Promise)
      ) {
        throw new TmuxAttachmentViewExecutorError("mutation-outcome-uncertain");
      }
      return result;
    } catch (error) {
      if (error instanceof TmuxAttachmentViewExecutorError) throw error;
      if (
        error instanceof TmuxAttachmentClientTransportError &&
        error.code === "read_only_unavailable"
      ) {
        throw new TmuxAttachmentViewExecutorError("read_only_unavailable");
      }
      throw new TmuxAttachmentViewExecutorError("mutation-outcome-uncertain");
    }
  }

  #viewExists(exactTarget: `=${string}`): boolean {
    const result = this.#command(tmux(["has-session", "-t", exactTarget]));
    if (result.status === "not-found") return false;
    if (result.status === "failed") {
      throw new TmuxAttachmentViewExecutorError("tmux-command-failed");
    }
    return true;
  }

  #sessionMarker(sessionId: string): string | null {
    if (!RuntimeSessionIdSchemaZ.safeParse(sessionId).success) {
      throw new TmuxAttachmentViewExecutorError("invalid-tmux-output");
    }
    const result = this.#command(
      tmux(["show-environment", "-t", sessionId, GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT]),
      { allowVariableNotFound: true },
    );
    if (result.status === "not-found") return null;
    if (result.status === "variable-not-found") return null;
    if (result.status === "failed") {
      throw new TmuxAttachmentViewExecutorError("tmux-command-failed");
    }
    const rows = strictLines(result.stdout, MAX_MARKER_OUTPUT_ROWS);
    const assignmentPrefix = `${GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT}=`;
    if (rows.length !== 1 || !rows[0]!.startsWith(assignmentPrefix)) {
      throw new TmuxAttachmentViewExecutorError("invalid-tmux-output");
    }
    return rows[0]!.slice(assignmentPrefix.length);
  }

  #marker(exactTarget: `=${string}`): string | null {
    const result = this.#command(tmux(["list-panes", "-t", exactTarget, "-F", "#{session_id}"]));
    if (result.status === "not-found") return null;
    if (result.status === "failed") {
      throw new TmuxAttachmentViewExecutorError("tmux-command-failed");
    }
    const sessionIds = strictLines(result.stdout, MAX_SOURCE_PROOF_ROWS);
    if (
      sessionIds.length === 0 ||
      new Set(sessionIds).size !== 1 ||
      !RuntimeSessionIdSchemaZ.safeParse(sessionIds[0]).success
    ) {
      throw new TmuxAttachmentViewExecutorError("invalid-tmux-output");
    }
    return this.#sessionMarker(sessionIds[0]!);
  }

  #windowIds(exactTarget: `=${string}`): readonly string[] | null {
    const result = this.#command(tmux(["list-windows", "-t", exactTarget, "-F", "#{window_id}"]));
    if (result.status === "not-found") return null;
    if (result.status === "failed") {
      throw new TmuxAttachmentViewExecutorError("tmux-command-failed");
    }
    const lines = strictLines(result.stdout, MAX_ENUMERATED_WINDOWS_PER_VIEW);
    if (
      lines.some((line) => !RuntimeWindowIdSchemaZ.safeParse(line).success) ||
      new Set(lines).size !== lines.length
    ) {
      throw new TmuxAttachmentViewExecutorError("invalid-tmux-output");
    }
    return lines;
  }

  #viewServerGuard(
    exactTarget: `=${string}`,
    expectedMarker: string,
    expectedWindowId: string,
  ): ViewServerGuard | null {
    const result = this.#command(
      tmux([
        "list-panes",
        "-t",
        exactTarget,
        "-F",
        "#{session_id}\t#{window_id}\t#{pane_id}\t#{window_panes}\t#{session_windows}",
      ]),
    );
    if (result.status === "not-found") return null;
    if (result.status === "failed") {
      throw new TmuxAttachmentViewExecutorError("tmux-command-failed");
    }
    const rows = strictLines(result.stdout, MAX_SOURCE_PROOF_ROWS);
    if (rows.length !== 1) return null;
    const fields = rows[0]!.split("\t");
    if (fields.length !== 5) {
      throw new TmuxAttachmentViewExecutorError("invalid-tmux-output");
    }
    const [sessionId, windowId, paneId, paneCount, sessionWindowCount] = fields;
    if (
      !RuntimeSessionIdSchemaZ.safeParse(sessionId).success ||
      !RuntimeWindowIdSchemaZ.safeParse(windowId).success ||
      !RuntimePaneIdSchemaZ.safeParse(paneId).success ||
      !/^(?:0|[1-9][0-9]*)$/u.test(paneCount!) ||
      !/^(?:0|[1-9][0-9]*)$/u.test(sessionWindowCount!)
    ) {
      throw new TmuxAttachmentViewExecutorError("invalid-tmux-output");
    }
    if (
      windowId !== expectedWindowId ||
      paneCount !== "1" ||
      sessionWindowCount !== "1" ||
      this.#sessionMarker(sessionId!) !== expectedMarker
    ) {
      return null;
    }
    return {
      sessionId: sessionId!,
      windowId: windowId!,
      paneId: paneId!,
      target: `${sessionId}:${windowId}.${paneId}`,
      format: `#{&&:#{==:#{session_id},${sessionId}},#{&&:#{==:#{window_id},${windowId}},#{&&:#{==:#{window_panes},1},#{&&:#{==:#{session_windows},1},#{==:#{${GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT}},${expectedMarker}}}}}}`,
    };
  }

  #guardedCleanup(cleanup: GuardedAttachmentCleanup): GuardedAttachmentCleanupResult {
    const identity = parseCleanupIdentity(cleanup);
    if (!this.#viewExists(identity.exactTarget)) return "absent";
    const marker = this.#marker(identity.exactTarget);
    if (marker === null) {
      return this.#viewExists(identity.exactTarget) ? "ownership-mismatch" : "absent";
    }
    if (marker !== identity.markerValue) return "ownership-mismatch";
    const windows = this.#windowIds(identity.exactTarget);
    if (windows === null) return "absent";
    if (windows.length !== 1 || windows[0] !== cleanup.expectedWindowId) {
      return "topology-mismatch";
    }
    const viewGuard = this.#viewServerGuard(
      identity.exactTarget,
      identity.markerValue,
      cleanup.expectedWindowId,
    );
    if (!viewGuard) return "topology-mismatch";

    // `if-shell -F` inserts the selected command immediately after itself in
    // the same tmux client command queue; both guard and branch are synchronous
    // queue items. This removes the daemon-side check/use gap. The process-wide
    // queue above separately serializes every in-daemon manager/executor.
    let killed: TmuxAttachmentCommandResult;
    try {
      killed = this.#command(
        tmux([
          "if-shell",
          "-F",
          "-t",
          viewGuard.target,
          viewGuard.format,
          tmuxCommandString(tmux(["kill-session", "-t", identity.exactTarget])),
          tmuxCommandString(tmux(["display-message", "-p", VIEW_PROOF_MISMATCH_SENTINEL])),
        ]),
      );
    } catch {
      throw new TmuxAttachmentViewExecutorError("mutation-outcome-uncertain");
    }
    if (killed.status === "not-found") return "absent";
    if (killed.status !== "ok") {
      throw new TmuxAttachmentViewExecutorError("mutation-outcome-uncertain");
    }
    if (boundedOutput(killed.stdout) === VIEW_PROOF_MISMATCH_SENTINEL) {
      if (this.#marker(identity.exactTarget) !== identity.markerValue) {
        return "ownership-mismatch";
      }
      return "topology-mismatch";
    }
    return "cleaned";
  }

  #sourceProofMatches(operation: GuardedAttachmentViewOperation): boolean {
    const source = operation.source;
    if (
      !RuntimeSessionIdSchemaZ.safeParse(source.sessionId).success ||
      !RuntimeWindowIdSchemaZ.safeParse(source.windowId).success ||
      !RuntimePaneIdSchemaZ.safeParse(source.runtimePaneId).success ||
      source.paneCount !== 1
    ) {
      throw new TmuxAttachmentViewExecutorError("invalid-request");
    }
    const result = this.#command(
      tmux([
        "list-panes",
        "-t",
        `${source.sessionId}:${source.windowId}`,
        "-F",
        "#{session_id}\t#{window_id}\t#{pane_id}\t#{window_panes}",
      ]),
    );
    if (result.status === "not-found") return false;
    if (result.status === "failed") {
      throw new TmuxAttachmentViewExecutorError("tmux-command-failed");
    }
    const rows = strictLines(result.stdout, MAX_SOURCE_PROOF_ROWS);
    if (rows.length !== 1) return false;
    const fields = rows[0]!.split("\t");
    if (fields.length !== 4) {
      throw new TmuxAttachmentViewExecutorError("invalid-tmux-output");
    }
    const [sessionId, windowId, paneId, paneCount] = fields;
    if (
      !RuntimeSessionIdSchemaZ.safeParse(sessionId).success ||
      !RuntimeWindowIdSchemaZ.safeParse(windowId).success ||
      !RuntimePaneIdSchemaZ.safeParse(paneId).success ||
      !/^(?:0|[1-9][0-9]*)$/u.test(paneCount!)
    ) {
      throw new TmuxAttachmentViewExecutorError("invalid-tmux-output");
    }
    return (
      sessionId === source.sessionId &&
      windowId === source.windowId &&
      paneId === source.runtimePaneId &&
      paneCount === "1"
    );
  }

  #viewMatchesPlan(plan: GroupedTmuxAttachmentPlan): ViewServerGuard | null {
    const exactTarget = `=${plan.identity.viewSessionName}` as const;
    if (!this.#viewExists(exactTarget)) return null;
    if (this.#marker(exactTarget) !== plan.identity.markerValue) return null;
    const windows = this.#windowIds(exactTarget);
    if (windows?.length !== 1 || windows[0] !== plan.identity.durableSource.windowId) return null;
    const guard = this.#viewServerGuard(
      exactTarget,
      plan.identity.markerValue,
      plan.identity.durableSource.windowId,
    );
    return guard?.paneId === plan.identity.durableSource.runtimePaneId ? guard : null;
  }

  #runServerGuardedMutation(
    operation: GuardedAttachmentViewOperation,
    plan: GroupedTmuxAttachmentPlan,
    commands: readonly TmuxArgvPlan[],
    viewGuard: ViewServerGuard | null,
  ): GuardedAttachmentViewOperationResult | Promise<GuardedAttachmentViewOperationResult> {
    const mutation = tmuxCommandListString(commands);
    const viewGuardedMutation =
      operation.operation === "create"
        ? mutation
        : tmuxCommandString(
            tmux([
              "if-shell",
              "-F",
              "-t",
              viewGuard!.target,
              viewGuard!.format,
              mutation,
              tmuxCommandString(tmux(["display-message", "-p", VIEW_PROOF_MISMATCH_SENTINEL])),
            ]),
          );
    const guarded = tmux([
      "if-shell",
      "-F",
      "-t",
      sourcePaneTarget(operation),
      sourceProofFormat(operation),
      viewGuardedMutation,
      tmuxCommandString(tmux(["display-message", "-p", SOURCE_PROOF_MISMATCH_SENTINEL])),
    ]);
    if (operation.operation === "create") {
      let result: TmuxAttachmentCommandResult;
      try {
        result = this.#command(guarded);
      } catch {
        throw new TmuxAttachmentViewExecutorError("mutation-outcome-uncertain");
      }
      if (result.status !== "ok") {
        throw new TmuxAttachmentViewExecutorError("mutation-outcome-uncertain");
      }
      const output = boundedOutput(result.stdout);
      if (output === SOURCE_PROOF_MISMATCH_SENTINEL) return "source-proof-mismatch";
      if (output === VIEW_PROOF_MISMATCH_SENTINEL) {
        throw new TmuxAttachmentViewExecutorError("view-state-mismatch");
      }
      return "executed";
    }

    let attempt: TmuxAttachmentClientTransportAttempt;
    try {
      attempt = this.#clientCommand(guarded, operation.operation, plan, viewGuard!);
    } catch (error) {
      if (error instanceof TmuxAttachmentViewExecutorError) throw error;
      throw new TmuxAttachmentViewExecutorError("mutation-outcome-uncertain");
    }
    return attempt.outcome.then(
      (result) => {
        if (
          !result ||
          !["executed", "source-proof-mismatch", "view-proof-mismatch", "failed"].includes(
            result.status,
          )
        ) {
          throw new TmuxAttachmentViewExecutorError("mutation-outcome-uncertain");
        }
        switch (result.status) {
          case "executed":
            return {
              status: "executed" as const,
              clientClaim: {
                attachmentId: attempt.attachmentId,
                generation: attempt.generation,
                attemptId: attempt.attemptId,
              },
            };
          case "source-proof-mismatch":
            return "source-proof-mismatch" as const;
          case "view-proof-mismatch":
            throw new TmuxAttachmentViewExecutorError("view-state-mismatch");
          case "failed":
            throw new TmuxAttachmentViewExecutorError("mutation-outcome-uncertain");
        }
      },
      () => {
        throw new TmuxAttachmentViewExecutorError("mutation-outcome-uncertain");
      },
    );
  }

  #bestEffortRollbackCreate(plan: GroupedTmuxAttachmentPlan): void {
    try {
      this.#guardedCleanup({
        exactViewSessionTarget: `=${plan.identity.viewSessionName}`,
        markerEnvironment: GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT,
        expectedMarkerValue: plan.identity.markerValue,
        expectedWindowId: plan.identity.durableSource.windowId,
      });
    } catch {
      // The original static uncertain-outcome error is the only observable result.
    }
  }

  #executeGuardedViewOperation(
    operation: GuardedAttachmentViewOperation,
  ): GuardedAttachmentViewOperationResult | Promise<GuardedAttachmentViewOperationResult> {
    const plan = canonicalPlanFor(operation);
    if (operation.operation !== "create" && !this.#clientTransport) {
      throw new TmuxAttachmentViewExecutorError("attachment-transport-unavailable");
    }
    let viewGuard: ViewServerGuard | null = null;

    if (operation.operation === "create") {
      if (this.#viewExists(operation.exactViewSessionTarget)) {
        throw new TmuxAttachmentViewExecutorError("view-state-mismatch");
      }
    } else {
      viewGuard = this.#viewMatchesPlan(plan);
      if (!viewGuard) throw new TmuxAttachmentViewExecutorError("view-state-mismatch");
    }

    if (!this.#sourceProofMatches(operation)) return "source-proof-mismatch";
    if (this.#now() >= operation.deadline) return "lease-expired";

    // The validated command call is immediate: there is no await between the
    // proof/deadline decision above and spawning a single tmux command list.
    // That server-side list repeats source proof (and, for attach/recover, view
    // proof) immediately before the selected mutation in the same queue.
    try {
      switch (operation.operation) {
        case "create":
          return this.#runServerGuardedMutation(operation, plan, [plan.create.command], null);
        case "attach":
          return this.#runServerGuardedMutation(operation, plan, [plan.attach], viewGuard);
        case "recover":
          return this.#runServerGuardedMutation(
            operation,
            plan,
            [...plan.recover.reconcile, plan.recover.attach],
            viewGuard,
          );
      }
    } catch (error) {
      if (operation.operation === "create") this.#bestEffortRollbackCreate(plan);
      if (error instanceof TmuxAttachmentViewExecutorError) throw error;
      throw new TmuxAttachmentViewExecutorError("mutation-outcome-uncertain");
    }
  }

  #enumerateMarkedViews(
    prefix: typeof GROUPED_TMUX_VIEW_SESSION_PREFIX,
    markerEnvironment: typeof GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT,
  ): readonly EnumeratedMarkedAttachmentView[] {
    if (
      prefix !== GROUPED_TMUX_VIEW_SESSION_PREFIX ||
      markerEnvironment !== GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT
    ) {
      throw new TmuxAttachmentViewExecutorError("invalid-request");
    }
    const result = this.#command(tmux(["list-sessions", "-F", "#{session_name}\t#{session_id}"]));
    if (result.status === "not-found") return [];
    if (result.status === "failed") {
      throw new TmuxAttachmentViewExecutorError("tmux-command-failed");
    }
    const rows = strictLines(result.stdout, MAX_ENUMERATED_VIEWS * 4);
    const found = new Map<string, { identity: ParsedViewIdentity; markerValue: string | null }>();
    const runtimeSessionIds = new Set<string>();
    for (const row of rows) {
      const separator = row.indexOf("\t");
      if (separator < 0 || row.indexOf("\t", separator + 1) >= 0) {
        throw new TmuxAttachmentViewExecutorError("invalid-tmux-output");
      }
      const sessionName = row.slice(0, separator);
      if (!sessionName.startsWith(prefix)) continue;
      const parsedName = parseViewSessionName(sessionName);
      if (!parsedName || found.has(sessionName)) {
        throw new TmuxAttachmentViewExecutorError("invalid-tmux-output");
      }
      const sessionId = row.slice(separator + 1);
      if (
        !RuntimeSessionIdSchemaZ.safeParse(sessionId).success ||
        runtimeSessionIds.has(sessionId)
      ) {
        throw new TmuxAttachmentViewExecutorError("invalid-tmux-output");
      }
      runtimeSessionIds.add(sessionId);
      const rawMarker = this.#sessionMarker(sessionId);
      let markerValue: string | null = null;
      const markerMatch = rawMarker === null ? null : MarkerPattern.exec(rawMarker);
      if (rawMarker !== null && markerMatch) {
        const generation = Number.parseInt(markerMatch[2]!, 10);
        if (
          Number.isSafeInteger(generation) &&
          generation <= GROUPED_TMUX_MAX_GENERATION &&
          canonicalMarker(markerMatch[1]!, generation) === rawMarker
        ) {
          markerValue = rawMarker;
        }
      }
      found.set(sessionName, {
        identity: {
          ...parsedName,
          markerValue: canonicalMarker(parsedName.attachmentId, parsedName.generation),
        },
        markerValue,
      });
      if (found.size > MAX_ENUMERATED_VIEWS) {
        throw new TmuxAttachmentViewExecutorError("invalid-tmux-output");
      }
    }

    const enumerated: EnumeratedMarkedAttachmentView[] = [];
    for (const candidate of found.values()) {
      const windowIds = this.#windowIds(candidate.identity.exactTarget);
      if (windowIds === null) continue;
      enumerated.push({
        viewSessionName: candidate.identity.viewSessionName,
        markerValue: candidate.markerValue,
        windowIds,
      });
    }
    return enumerated;
  }
}
