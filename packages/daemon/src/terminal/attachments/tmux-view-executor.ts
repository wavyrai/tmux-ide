import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { runTmux, TmuxError } from "@tmux-ide/tmux-bridge";
import {
  GROUPED_TMUX_MAX_GENERATION,
  GROUPED_TMUX_VIEW_MARKER_OPTION,
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
  | { readonly status: "failed" };

/**
 * Synchronous by design. The final source proof, deadline decision, and tmux
 * process spawn must remain in one uninterrupted JavaScript critical section.
 */
export interface TmuxAttachmentCommandRunner {
  readonly run: (command: TmuxArgvPlan) => TmuxAttachmentCommandResult;
}

export type TmuxAttachmentViewExecutorErrorCode =
  | "invalid-request"
  | "invalid-tmux-output"
  | "tmux-command-failed"
  | "view-state-mismatch"
  | "mutation-outcome-uncertain";

const ERROR_MESSAGES: Record<TmuxAttachmentViewExecutorErrorCode, string> = {
  "invalid-request": "The guarded tmux attachment request is invalid.",
  "invalid-tmux-output": "Trusted tmux attachment discovery returned invalid output.",
  "tmux-command-failed": "The guarded tmux attachment command failed.",
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
  readonly target: string;
  readonly format: string;
}

/*
 * One queue is shared by every executor instance in this daemon process. A
 * lease manager has its own queue, but that is not enough when more than one
 * manager is alive during lifecycle transitions or tests.
 */
let serverWideAttachmentOperationTail: Promise<void> = Promise.resolve();

function serializeServerWide<T>(operation: () => T): Promise<T> {
  const run = serverWideAttachmentOperationTail.then(operation, operation);
  serverWideAttachmentOperationTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
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
    cleanup.markerOption !== GROUPED_TMUX_VIEW_MARKER_OPTION ||
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
  readonly #now: () => number;

  constructor(options: TmuxAttachmentViewExecutorOptions = {}) {
    this.#runner = options.runner ?? productionRunner;
    this.#now = options.now ?? Date.now;
  }

  guardedCleanup(cleanup: GuardedAttachmentCleanup): Promise<GuardedAttachmentCleanupResult> {
    return serializeServerWide(() => this.#guardedCleanup(cleanup));
  }

  executeGuardedViewOperation(
    operation: GuardedAttachmentViewOperation,
  ): Promise<GuardedAttachmentViewOperationResult> {
    return serializeServerWide(() => this.#executeGuardedViewOperation(operation));
  }

  enumerateMarkedViews(
    prefix: typeof GROUPED_TMUX_VIEW_SESSION_PREFIX,
    markerOption: typeof GROUPED_TMUX_VIEW_MARKER_OPTION,
  ): Promise<readonly EnumeratedMarkedAttachmentView[]> {
    return serializeServerWide(() => this.#enumerateMarkedViews(prefix, markerOption));
  }

  #command(command: TmuxArgvPlan): TmuxAttachmentCommandResult {
    if (command.executable !== "tmux") {
      throw new TmuxAttachmentViewExecutorError("invalid-request");
    }
    try {
      const result = this.#runner.run({ executable: "tmux", argv: [...command.argv] });
      if (result.status === "ok") boundedOutput(result.stdout);
      if (!["ok", "not-found", "failed"].includes(result.status)) {
        throw new TmuxAttachmentViewExecutorError("tmux-command-failed");
      }
      return result;
    } catch (error) {
      if (error instanceof TmuxAttachmentViewExecutorError) throw error;
      throw new TmuxAttachmentViewExecutorError("tmux-command-failed");
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

  #marker(exactTarget: `=${string}`): string | null {
    const result = this.#command(
      tmux(["list-panes", "-t", exactTarget, "-F", `#{${GROUPED_TMUX_VIEW_MARKER_OPTION}}`]),
    );
    if (result.status === "not-found") return null;
    if (result.status === "failed") {
      throw new TmuxAttachmentViewExecutorError("tmux-command-failed");
    }
    const markers = strictLines(result.stdout, MAX_SOURCE_PROOF_ROWS);
    if (markers.length === 0) return "";
    if (new Set(markers).size !== 1) {
      throw new TmuxAttachmentViewExecutorError("invalid-tmux-output");
    }
    return markers[0]!;
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
        `#{session_id}\t#{window_id}\t#{pane_id}\t#{window_panes}\t#{session_windows}\t#{${GROUPED_TMUX_VIEW_MARKER_OPTION}}`,
      ]),
    );
    if (result.status === "not-found") return null;
    if (result.status === "failed") {
      throw new TmuxAttachmentViewExecutorError("tmux-command-failed");
    }
    const rows = strictLines(result.stdout, MAX_SOURCE_PROOF_ROWS);
    if (rows.length !== 1) return null;
    const fields = rows[0]!.split("\t");
    if (fields.length !== 6) {
      throw new TmuxAttachmentViewExecutorError("invalid-tmux-output");
    }
    const [sessionId, windowId, paneId, paneCount, sessionWindowCount, marker] = fields;
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
      marker !== expectedMarker
    ) {
      return null;
    }
    return {
      target: `${sessionId}:${windowId}.${paneId}`,
      format: `#{&&:#{==:#{session_id},${sessionId}},#{&&:#{==:#{window_id},${windowId}},#{&&:#{==:#{window_panes},1},#{&&:#{==:#{session_windows},1},#{==:#{${GROUPED_TMUX_VIEW_MARKER_OPTION}},${expectedMarker}}}}}}`,
    };
  }

  #guardedCleanup(cleanup: GuardedAttachmentCleanup): GuardedAttachmentCleanupResult {
    const identity = parseCleanupIdentity(cleanup);
    if (!this.#viewExists(identity.exactTarget)) return "absent";
    const marker = this.#marker(identity.exactTarget);
    if (marker === null) return "absent";
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
    return this.#viewServerGuard(
      exactTarget,
      plan.identity.markerValue,
      plan.identity.durableSource.windowId,
    );
  }

  #runServerGuardedMutation(
    operation: GuardedAttachmentViewOperation,
    plan: GroupedTmuxAttachmentPlan,
    commands: readonly TmuxArgvPlan[],
    viewGuard: ViewServerGuard | null,
  ): GuardedAttachmentViewOperationResult {
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

  #bestEffortRollbackCreate(plan: GroupedTmuxAttachmentPlan): void {
    try {
      this.#guardedCleanup({
        exactViewSessionTarget: `=${plan.identity.viewSessionName}`,
        markerOption: GROUPED_TMUX_VIEW_MARKER_OPTION,
        expectedMarkerValue: plan.identity.markerValue,
        expectedWindowId: plan.identity.durableSource.windowId,
      });
    } catch {
      // The original static uncertain-outcome error is the only observable result.
    }
  }

  #executeGuardedViewOperation(
    operation: GuardedAttachmentViewOperation,
  ): GuardedAttachmentViewOperationResult {
    const plan = canonicalPlanFor(operation);
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
    markerOption: typeof GROUPED_TMUX_VIEW_MARKER_OPTION,
  ): readonly EnumeratedMarkedAttachmentView[] {
    if (
      prefix !== GROUPED_TMUX_VIEW_SESSION_PREFIX ||
      markerOption !== GROUPED_TMUX_VIEW_MARKER_OPTION
    ) {
      throw new TmuxAttachmentViewExecutorError("invalid-request");
    }
    const result = this.#command(
      tmux(["list-sessions", "-F", `#{session_name}\t#{${GROUPED_TMUX_VIEW_MARKER_OPTION}}`]),
    );
    if (result.status === "not-found") return [];
    if (result.status === "failed") {
      throw new TmuxAttachmentViewExecutorError("tmux-command-failed");
    }
    const rows = strictLines(result.stdout, MAX_ENUMERATED_VIEWS * 4);
    const found = new Map<string, { identity: ParsedViewIdentity; markerValue: string | null }>();
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
      const rawMarker = row.slice(separator + 1);
      let markerValue: string | null = null;
      const markerMatch = MarkerPattern.exec(rawMarker);
      if (markerMatch) {
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
