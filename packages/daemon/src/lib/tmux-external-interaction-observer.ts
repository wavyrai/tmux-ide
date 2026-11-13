import { execFile } from "node:child_process";

import { WorkspacePaneCreationReferenceSchemaZ } from "@tmux-ide/contracts";
import { z } from "zod";
import { TerminalAttachmentSemanticPaneIdSchemaZ } from "@tmux-ide/contracts";

import { logger } from "./log.ts";
import {
  boundedTmuxInteractionAppendCommand,
  tmuxInteractionOption,
  TMUX_INTERACTION_GAP_RECORD,
  TMUX_INTERACTION_MAX_DRAIN_BYTES,
} from "./tmux-interaction-retention.ts";
import type { WorkspacePaneTmuxAuthority } from "./workspace-pane-creation.ts";
import { createPinnedWorkspaceTmuxAsyncRunner } from "./workspace-pane-creation.ts";
import { getDefaultWorkspaceRegistry, type WorkspaceRegistry } from "./workspace-registry.ts";
import {
  AuthenticatedInternalReadVerifier,
  consumeInternalReadOperation,
  INTERNAL_READ_OPERATION_OPTION,
  INTERNAL_SEND_OPERATION_OPTION,
} from "./tmux-interaction-options.ts";

const HOOK_MARKER = "tmux-ide-interaction-v3";
const OWNED_HOOK_MARKER = "tmux-ide-interaction-v";
/** The retention name of one observer: the marker plus its daemon id. */
const OWNER_NAME =
  /tmux-ide-interaction-v3-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u;
const OWNER_RECORD = /^retention-owner pid=([1-9][0-9]{0,9})$/u;
/** Observers of THIS process that are installed and not yet disposed. */
const liveLocalObservers = new Set<string>();
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
const FIELD_SEPARATOR = "|tmux-ide-input-field-v1|";
const EVENT_SEPARATOR = "|tmux-ide-input-event-v1|";
export interface ExternalTmuxInteractionGap {
  readonly reason:
    | "overflow"
    | "read-failed"
    | "detach-failed"
    | "projection-failed"
    | "hooks-replaced"
    | "hook-repair-failed";
  readonly recovery: "future-observations-only";
}

const RUNTIME_PANE = /^%[0-9]+$/u;
const RETRY_MS = 1_000;
/**
 * Hooks are shared tmux state. A config reload, another client, or a debugging
 * command can replace them without killing the daemon, so waiting forever on
 * the old signal channel is not a sufficient health check. Every check costs
 * one tmux child process, so a check that keeps finding the hooks intact backs
 * off (doubling from `baseMs`, capped at `maxMs`); any repair, failure, or
 * signal-loop error returns the cadence to `baseMs`. Measured on an otherwise
 * idle daemon the fixed one-second cadence was the daemon's only recurring
 * spawn source (two `show-hooks` children per second).
 */
export interface HookHealthcheckSchedule {
  readonly baseMs: number;
  readonly maxMs: number;
}

export const DEFAULT_HOOK_HEALTHCHECK_SCHEDULE: HookHealthcheckSchedule = Object.freeze({
  baseMs: 1_000,
  // A healthy idle server is checked 12 times an hour, not 120. Since daemons
  // no longer remove each other's hooks, only a user action (a config reload,
  // `set-hook -gu`) can take them away; that is then noticed within 5 minutes.
  maxMs: 300_000,
});

export type HookHealthcheckOutcome = "healthy" | "repaired" | "failed";

/** Pure cadence rule: healthy checks double the wait up to the cap; anything else resets it. */
export function nextHookHealthcheckDelay(
  previousMs: number,
  outcome: HookHealthcheckOutcome,
  schedule: HookHealthcheckSchedule = DEFAULT_HOOK_HEALTHCHECK_SCHEDULE,
): number {
  const base = Math.max(1, Math.floor(schedule.baseMs));
  const max = Math.max(base, Math.floor(schedule.maxMs));
  if (outcome !== "healthy") return base;
  const previous = Number.isFinite(previousMs) ? Math.max(base, Math.floor(previousMs)) : base;
  return Math.min(previous * 2, max);
}

/**
 * True when `show-hooks` output lists an entry of `hookName` whose body carries
 * this observer's buffer name. Output may hold several hook arrays at once
 * (one combined `show-hooks -g a ; show-hooks -g b` client), so the check is
 * per hook line rather than a substring search over the whole output.
 */
export function ownedHookInstalled(output: string, hookName: string, bufferName: string): boolean {
  const row = new RegExp(`^${hookName}\\[([0-9]+)\\]\\s+(.+)$`, "u");
  for (const line of output.split("\n")) {
    const match = row.exec(line);
    if (match && match[2]!.includes(bufferName)) return true;
  }
  return false;
}

export { INTERNAL_READ_OPERATION_OPTION, INTERNAL_SEND_OPERATION_OPTION };

export interface ExternalTmuxInteraction {
  readonly workspaceName: string;
  readonly semanticPaneId: string;
  readonly operationKind: "workspace.pane.send" | "workspace.pane.read";
  /** Present only for this daemon generation's product-authored operation. */
  readonly operationId: string | null;
  readonly capturedTarget?: CapturedTmuxInteractionTarget;
}

export interface CapturedTmuxInteractionTarget {
  readonly runtimePaneId: string;
  readonly sessionId: string;
  readonly semanticPaneId: string;
}

export interface ExternalTmuxInteractionObserverIo {
  readonly runTmux: (args: readonly string[], signal?: AbortSignal) => Promise<string>;
  readonly waitForSignal: (channel: string, signal: AbortSignal) => Promise<void>;
  readonly delay: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export interface ExternalTmuxObserverDiagnostic {
  readonly operation: "healthcheck" | "drain";
  readonly phase: "begin" | "event-loop-sentinel" | "end";
  readonly traceId: string;
  readonly processId: string;
  readonly clockId: "node-performance-now";
  readonly clockKind: "performance-now";
  readonly atMicros: number;
  readonly activeOperations: number;
  readonly succeeded?: boolean;
}

export interface ExternalTmuxObserverDiagnostics {
  readonly nowMicros: () => number;
  readonly createTraceId: () => string;
  readonly publish: (event: ExternalTmuxObserverDiagnostic) => void;
  readonly queueMicrotask?: (callback: () => void) => void;
}

export interface InternalReadHookEmission {
  readonly bufferName: string;
  readonly signalChannel: string;
  readonly record: string;
}

function socketArguments(authority: WorkspacePaneTmuxAuthority): readonly string[] {
  return authority.socketSelector.kind === "path"
    ? ["-S", authority.socketSelector.path]
    : ["-L", authority.socketSelector.name];
}

/**
 * Check unread state and register a waiter in the same non-yielding tmux queue.
 * `if-shell -F` inserts its branch immediately (cmd-if-shell.c); cmdq_next
 * executes that branch before servicing other clients (cmd-queue.c). Thus an
 * append is either visible to this check or happens after wait-for registers.
 * Signals alone are insufficient: two signals without a waiter cancel tmux's
 * latched wakeup. A stale latch can cause one empty drain, never a lost batch.
 */
export function tmuxInteractionWaitCommand(bufferName: string, channel: string): readonly string[] {
  const option = tmuxInteractionOption(bufferName);
  if (!/^[A-Za-z0-9._-]{1,300}$/u.test(channel)) throw new TypeError("Invalid observer channel");
  return ["if-shell", "-F", `#{==:#{${option}},}`, `wait-for '${channel}'`];
}

function defaultWaiter(
  authority: WorkspacePaneTmuxAuthority,
  bufferName: string,
): ExternalTmuxInteractionObserverIo["waitForSignal"] {
  const prefix = socketArguments(authority);
  return (channel, signal) =>
    waitForBlockingTmuxClient(
      authority.executablePath,
      [...prefix, ...tmuxInteractionWaitCommand(bufferName, channel)],
      signal,
    );
}

export const BLOCKING_CLIENT_KILL_GRACE_MS = 250;

/**
 * Run a tmux client that blocks until signalled (`wait-for`). It has no
 * deadline by design, so cancellation must not depend on the client's
 * cooperation: TERM on abort, KILL after a grace, and settle when the process
 * exits. Observer disposal awaits this, and with it every daemon stop (#839).
 */
export function waitForBlockingTmuxClient(
  executable: string,
  args: readonly string[],
  signal: AbortSignal,
  killGraceMs: number = BLOCKING_CLIENT_KILL_GRACE_MS,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let failure: Error | null = null;
    let escalation: ReturnType<typeof setTimeout> | null = null;
    const child = execFile(
      executable,
      [...args],
      { encoding: "utf8", windowsHide: true },
      (error) => {
        failure ??= error;
      },
    );
    const settle = (): void => {
      if (settled) return;
      settled = true;
      if (escalation) clearTimeout(escalation);
      signal.removeEventListener("abort", cancel);
      if (!failure || signal.aborted) resolve();
      else reject(failure);
    };
    const cancel = (): void => {
      if (escalation) return;
      child.kill("SIGTERM");
      escalation = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
    };
    signal.addEventListener("abort", cancel, { once: true });
    child.once("error", (error) => {
      failure ??= error;
      settle();
    });
    // "exit", not "close": a lingering holder of the pipes must not keep the
    // waiter, and so the stop, pending after the client itself is gone.
    child.once("exit", (code, exitSignal) => {
      if (code !== 0 && !failure)
        failure = new Error(`tmux wait client ended with ${exitSignal ?? `code ${String(code)}`}`);
      settle();
    });
  });
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      signal.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function isTmuxServerUnavailable(error: unknown): boolean {
  const details: string[] = [];
  const codes = new Set<string>();
  let cursor: unknown = error;
  for (let depth = 0; depth < 5 && cursor !== null && cursor !== undefined; depth += 1) {
    if (cursor instanceof Error) details.push(cursor.message);
    else details.push(String(cursor));
    if (typeof cursor === "object" && cursor !== null) {
      if ("stderr" in cursor) {
        const stderr = cursor.stderr;
        if (typeof stderr === "string") details.push(stderr);
        else if (Buffer.isBuffer(stderr)) details.push(stderr.toString("utf8"));
      }
      if ("code" in cursor) codes.add(String(cursor.code));
      cursor = "cause" in cursor ? cursor.cause : undefined;
    } else {
      cursor = undefined;
    }
  }
  const detail = details.join("\n").toLowerCase();
  return (
    codes.has("ECONNREFUSED") ||
    detail.includes("failed to connect to server") ||
    detail.includes("no server running") ||
    detail.includes("error connecting to") ||
    detail.includes("connection refused")
  );
}

export function internalInteractionOperationMarker(
  daemonInstanceId: string,
  operationId: string,
): string {
  return `${daemonInstanceId}:${operationId}`;
}

export interface TmuxInputHookRecord {
  readonly runtimePaneId: string;
  readonly operationMarker: string | null;
  readonly operationKind: "workspace.pane.send" | "workspace.pane.read";
  readonly capturedTarget?: CapturedTmuxInteractionTarget;
}

/** Parse only the closed metadata written by our tmux hook. */
export function parseTmuxInputHookRecords(raw: string): readonly TmuxInputHookRecord[] {
  const records: TmuxInputHookRecord[] = [];
  for (const encoded of raw.split(EVENT_SEPARATOR)) {
    if (!encoded) continue;
    const fields = encoded.split(FIELD_SEPARATOR);
    if ((fields.length !== 3 && fields.length !== 5) || !RUNTIME_PANE.test(fields[0]!)) continue;
    const marker = fields[1]!;
    if (marker.length > 160 || /[\r\n]/u.test(marker)) continue;
    const operationKind = fields[2];
    if (operationKind !== "workspace.pane.send" && operationKind !== "workspace.pane.read") {
      continue;
    }
    records.push({
      runtimePaneId: fields[0]!,
      operationMarker: marker || null,
      operationKind,
      ...(fields.length === 5 &&
      /^\$(?:0|[1-9][0-9]*)$/u.test(fields[3]!) &&
      TerminalAttachmentSemanticPaneIdSchemaZ.safeParse(fields[4]).success
        ? {
            capturedTarget: {
              runtimePaneId: fields[0]!,
              sessionId: fields[3]!,
              semanticPaneId: fields[4]!,
            },
          }
        : {}),
    });
  }
  return records;
}

/** Every tmux-ide hook of this array, with the observer it belongs to (null: a legacy hook). */
function ownedHooks(
  output: string,
  hookName: "after-send-keys" | "after-capture-pane",
): readonly { readonly index: number; readonly owner: string | null }[] {
  const row = new RegExp(`^${hookName}\\[([0-9]+)\\]\\s+(.+)$`, "u");
  const hooks: { index: number; owner: string | null }[] = [];
  for (const line of output.split("\n")) {
    const match = row.exec(line);
    if (match && match[2]!.includes(OWNED_HOOK_MARKER))
      hooks.push({ index: Number(match[1]!), owner: OWNER_NAME.exec(match[2]!)?.[0] ?? null });
  }
  return hooks;
}

/**
 * Event-driven adapter from tmux's native send/capture hooks into the semantic
 * interaction spine. Hooks write only runtime identity, operation kind, and an
 * internal-operation marker to bounded tmux option storage, then signal a blocked
 * `wait-for` client. No terminal input or captured output crosses this boundary.
 */
export class TmuxExternalInteractionObserver {
  readonly #daemonInstanceId: string;
  readonly #registry: WorkspaceRegistry;
  readonly #io: ExternalTmuxInteractionObserverIo;
  readonly #onObserved: (interaction: ExternalTmuxInteraction) => boolean;
  readonly #resolveCapturedTarget?: (
    target: CapturedTmuxInteractionTarget,
  ) => { workspaceName: string; semanticPaneId: string } | null;
  readonly #onUnresolvedObservation?: (record: TmuxInputHookRecord) => void;
  readonly #bufferName: string;
  readonly #signalChannel: string;
  readonly #abort = new AbortController();
  #active = false;
  #installed = false;
  #loop: Promise<void> | null = null;
  #starting: Promise<void> | null = null;
  #hookHealthcheck: ReturnType<typeof setTimeout> | null = null;
  readonly #healthcheckSchedule: HookHealthcheckSchedule;
  #healthcheckDelayMs: number;
  #lastHealthcheckOutcome: HookHealthcheckOutcome = "failed";
  readonly #onAvailability: ((available: boolean) => void) | undefined;
  readonly #onGap: ((gap: ExternalTmuxInteractionGap) => void) | undefined;
  #tmuxWork: Promise<unknown> = Promise.resolve();
  #reconcile: Promise<void> | null = null;
  #diagnostics: ExternalTmuxObserverDiagnostics | null;
  #diagnosticActiveOperations = 0;
  readonly #authenticatedInternalReads: AuthenticatedInternalReadVerifier;
  readonly #ownerProcess: { readonly pid: number; readonly isAlive: (pid: number) => boolean };

  constructor(options: {
    daemonInstanceId: string;
    tmuxAuthority: WorkspacePaneTmuxAuthority;
    internalReadOwnerToken?: string | null;
    registry?: WorkspaceRegistry;
    io?: Partial<ExternalTmuxInteractionObserverIo>;
    /**
     * Returns true only when a live, product-authored operation consumed the
     * observation. Internal-looking metadata is not authority: a false return
     * must fall through to the caller's honest external-observation path.
     */
    onObserved: (interaction: ExternalTmuxInteraction) => boolean;
    /** Supplying this disables late pane lookup, including for retained legacy records. */
    resolveCapturedTarget?: (
      target: CapturedTmuxInteractionTarget,
    ) => { workspaceName: string; semanticPaneId: string } | null;
    onUnresolvedObservation?: (record: TmuxInputHookRecord) => void;
    diagnostics?: ExternalTmuxObserverDiagnostics;
    onAvailability?: (available: boolean) => void;
    onGap?: (gap: ExternalTmuxInteractionGap) => void;
    /** Health-check cadence bounds. Tests inject small values; production uses the default. */
    healthcheck?: Partial<HookHealthcheckSchedule>;
    /** This daemon's process and the liveness test for another's. Tests inject both. */
    ownerProcess?: { readonly pid: number; readonly isAlive: (pid: number) => boolean };
  }) {
    this.#ownerProcess = options.ownerProcess ?? { pid: process.pid, isAlive: processIsAlive };
    this.#daemonInstanceId = options.daemonInstanceId;
    this.#healthcheckSchedule = Object.freeze({
      baseMs: options.healthcheck?.baseMs ?? DEFAULT_HOOK_HEALTHCHECK_SCHEDULE.baseMs,
      maxMs: options.healthcheck?.maxMs ?? DEFAULT_HOOK_HEALTHCHECK_SCHEDULE.maxMs,
    });
    this.#healthcheckDelayMs = this.#healthcheckSchedule.baseMs;
    this.#registry = options.registry ?? getDefaultWorkspaceRegistry();
    this.#onObserved = options.onObserved;
    this.#resolveCapturedTarget = options.resolveCapturedTarget;
    this.#onUnresolvedObservation = options.onUnresolvedObservation;
    this.#onGap = options.onGap;
    this.#onAvailability = options.onAvailability;
    this.#authenticatedInternalReads = new AuthenticatedInternalReadVerifier({
      daemonInstanceId: options.daemonInstanceId,
      ownerToken: options.internalReadOwnerToken,
    });
    this.#bufferName = `${HOOK_MARKER}-${options.daemonInstanceId}`;
    this.#signalChannel = `${this.#bufferName}-ready`;
    this.#diagnostics = options.diagnostics ?? null;
    this.#io = {
      runTmux: options.io?.runTmux ?? createPinnedWorkspaceTmuxAsyncRunner(options.tmuxAuthority),
      waitForSignal:
        options.io?.waitForSignal ?? defaultWaiter(options.tmuxAuthority, this.#bufferName),
      delay: options.io?.delay ?? abortableDelay,
    };
  }

  /** Private synchronous equivalent of the installed after-capture hook.
   * Recovery hook bodies run with NOHOOKS, so they append this exact bounded
   * record and signal the already-owned observer drain explicitly. */
  internalReadHookEmission(runtimePaneId: string, marker: string): InternalReadHookEmission {
    if (!RUNTIME_PANE.test(runtimePaneId))
      throw new TypeError("internal read hook emission requires a runtime pane id");
    if (!/^[A-Za-z0-9:._-]{16,256}$/u.test(marker))
      throw new TypeError("internal read hook emission requires a bounded marker");
    return Object.freeze({
      bufferName: this.#bufferName,
      signalChannel: this.#signalChannel,
      record:
        `${runtimePaneId}${FIELD_SEPARATOR}${marker}${FIELD_SEPARATOR}` +
        `workspace.pane.read${EVENT_SEPARATOR}`,
    });
  }

  start(): Promise<void> {
    if (this.#starting) return this.#starting;
    if (this.#active) return Promise.resolve();
    const work = this.#start();
    const settled = work.finally(() => {
      if (this.#starting === settled) this.#starting = null;
    });
    this.#starting = settled;
    return settled;
  }

  async #start(): Promise<void> {
    this.#active = true;
    try {
      await this.install();
    } catch (error) {
      await this.#serializeTmux(async () => {
        await this.#removeOwnedHooks();
        await this.#deleteRetention();
      });
      if (!isTmuxServerUnavailable(error)) {
        this.#active = false;
        liveLocalObservers.delete(this.#bufferName);
        throw error;
      }
      // A configless first run legitimately has no tmux server yet. Keep the
      // observer alive: its retry loop installs the hooks as soon as the first
      // session creates the pinned socket. The HTTP control plane must not be
      // held hostage by optional, currently absent tmux global state.
      this.#setInstalled(false);
    }
    if (!this.#active || this.#abort.signal.aborted) {
      await this.#serializeTmux(async () => {
        await this.#removeOwnedHooks();
        await this.#deleteRetention();
      });
      liveLocalObservers.delete(this.#bufferName);
      throw new Error("tmux external interaction observer was disposed during startup");
    }
    this.#loop = this.#run();
    this.#scheduleHealthcheck();
  }

  /** Wait before the next scheduled hook health check. Exposed for tests. */
  get healthcheckDelayMs(): number {
    return this.#healthcheckDelayMs;
  }

  #scheduleHealthcheck(): void {
    if (this.#hookHealthcheck) clearTimeout(this.#hookHealthcheck);
    this.#hookHealthcheck = null;
    if (!this.#active || this.#abort.signal.aborted) return;
    const timer = setTimeout(() => {
      if (this.#hookHealthcheck === timer) this.#hookHealthcheck = null;
      void this.#runScheduledHealthcheck();
    }, this.#healthcheckDelayMs);
    timer.unref?.();
    this.#hookHealthcheck = timer;
  }

  async #runScheduledHealthcheck(): Promise<void> {
    const delayBefore = this.#healthcheckDelayMs;
    let outcome: HookHealthcheckOutcome;
    try {
      await this.reconcileHooks();
      outcome = this.#lastHealthcheckOutcome;
    } catch {
      if (!this.#abort.signal.aborted) this.#reportGap("hook-repair-failed");
      outcome = "failed";
    }
    // A signal-path reset that landed during this check wins over the outcome.
    if (this.#healthcheckDelayMs === delayBefore) {
      this.#healthcheckDelayMs = nextHookHealthcheckDelay(
        delayBefore,
        outcome,
        this.#healthcheckSchedule,
      );
    }
    if (this.#hookHealthcheck === null) this.#scheduleHealthcheck();
  }

  /** Something failed on the signal path: verify the hooks promptly again. */
  #resetHealthcheckBackoff(): void {
    const base = this.#healthcheckSchedule.baseMs;
    if (this.#healthcheckDelayMs === base) return;
    this.#healthcheckDelayMs = base;
    if (this.#hookHealthcheck) this.#scheduleHealthcheck();
  }

  setDiagnostics(diagnostics: ExternalTmuxObserverDiagnostics | null): void {
    this.#diagnostics = diagnostics;
  }

  async dispose(): Promise<void> {
    // From here on another observer of this process may clear what this one leaves.
    liveLocalObservers.delete(this.#bufferName);
    if (!this.#active && !this.#loop && !this.#starting && !this.#installed) return;
    const starting = this.#starting;
    this.#active = false;
    this.#abort.abort();
    if (this.#hookHealthcheck) clearTimeout(this.#hookHealthcheck);
    this.#hookHealthcheck = null;
    await Promise.allSettled([starting, this.#loop]);
    this.#loop = null;
    await this.#serializeTmux(async () => {
      await this.#removeOwnedHooks();
      await this.#deleteRetention();
    });
  }

  /** Install the hook once. Public for hermetic lifecycle tests. */
  install(): Promise<void> {
    return this.#serializeTmux(() => this.#install(this.#abort.signal));
  }

  async #install(signal?: AbortSignal): Promise<void> {
    const others = await this.#liveOtherObservers(signal);
    await this.#removeOwnedHooks(signal, others);
    await this.#deleteOwnedBuffers(signal, others);
    signal?.throwIfAborted();
    liveLocalObservers.add(this.#bufferName);
    // The small named buffer indexes retention options for crash cleanup and
    // names the owning process: another daemon on this server leaves these
    // hooks alone while that process lives, and clears them once it is gone.
    // Event data lives only in bounded options, never in this buffer.
    await this.#io.runTmux(
      [
        "set-buffer",
        "-b",
        this.#bufferName,
        `retention-owner pid=${String(this.#ownerProcess.pid)}`,
      ],
      signal,
    );
    const hook = (
      operationKind: ExternalTmuxInteraction["operationKind"],
      markerOption: string,
      consumeMarker: boolean,
    ) => {
      // Reject arbitrary option text before expansion into a tmux command.
      // Bound markers at the producer, including across multibyte input.
      const validMarker = `#{&&:#{m/r:^[A-Za-z0-9:._-]*$,#{${markerOption}}},#{e|<=:#{n:${markerOption}},160}}`;
      const marker = `#{?${validMarker},#{${markerOption}},}`;
      const stampOption = "@tmux_ide_pane_id";
      const validStamp = `#{&&:#{m/r:^[A-Za-z0-9][A-Za-z0-9._-]*$,#{${stampOption}}},#{e|<=:#{n:${stampOption}},128}}`;
      const stamp = `#{?${validStamp},#{${stampOption}},}`;
      const data = `#{pane_id}${FIELD_SEPARATOR}${marker}${FIELD_SEPARATOR}${operationKind}${FIELD_SEPARATOR}#{session_id}${FIELD_SEPARATOR}${stamp}${EVENT_SEPARATOR}`;
      // Expand pane/marker identity at hook invocation, then schedule the
      // append+signal as a background tmux-native command list. No shell and
      // no second tmux client sit on the invoking command queue. The tiny
      // synchronous native cleanup runs only after the record string has been
      // captured, so a marker is single-use without racing the async drain.
      // Escape only the retention format for evaluation in the queued native
      // command; capture pane and marker immediately, before consuming it.
      const append = boundedTmuxInteractionAppendCommand(this.#bufferName, "RECORD")
        .replace("#{=", "##{=")
        .replace("RECORD", data);
      const publish = `run-shell -b -C "${append} ; wait-for -S '${this.#signalChannel}'"`;
      // Hook commands inherit the triggering pane as their target, so cleanup
      // needs neither format expansion nor a nested command queue.
      const consume = consumeMarker ? ` ; set-option -pu '${markerOption}'` : "";
      return `${publish}${consume}`;
    };
    await this.#io.runTmux(
      [
        "set-hook",
        "-ag",
        "after-send-keys",
        hook("workspace.pane.send", INTERNAL_SEND_OPERATION_OPTION, true),
      ],
      signal,
    );
    signal?.throwIfAborted();
    await this.#io.runTmux(
      [
        "set-hook",
        "-ag",
        "after-capture-pane",
        hook("workspace.pane.read", INTERNAL_READ_OPERATION_OPTION, true),
      ],
      signal,
    );
    signal?.throwIfAborted();
    this.#setInstalled(true);
  }

  /**
   * Restore product hooks when external tmux configuration removed them.
   * Public only so the lifecycle is hermetically testable; the production
   * observer invokes it from the backed-off health check.
   */
  reconcileHooks(options: { readonly allowInactive?: boolean } = {}): Promise<void> {
    if (!this.#active && options.allowInactive !== true) return Promise.resolve();
    if (this.#reconcile) return this.#reconcile;
    const work = this.#serializeTmux(async () => {
      const finish = this.#beginDiagnostic("healthcheck");
      try {
        const hooks = await this.#ownedHooksPresent(this.#abort.signal);
        if (hooks === "present") {
          this.#lastHealthcheckOutcome = "healthy";
          finish(true);
          return;
        }
        if (hooks === "unknown") {
          // The check could not be made (tmux timed out or could not be
          // started). That says nothing about the hooks: leave them, report
          // no gap, and ask again at the base cadence.
          this.#lastHealthcheckOutcome = "failed";
          finish(false);
          return;
        }
        // Hooks that were installed and are now gone dropped every interaction
        // since their removal; the repair restores future observation only.
        if (this.#installed) this.#reportGap("hooks-replaced");
        this.#setInstalled(false);
        try {
          await this.#install(this.#abort.signal);
        } catch {
          this.#setInstalled(false);
        }
        this.#lastHealthcheckOutcome = this.#installed ? "repaired" : "failed";
        finish(this.#installed);
      } catch (error) {
        finish(false);
        throw error;
      }
    });
    const settled = work.finally(() => {
      if (this.#reconcile === settled) this.#reconcile = null;
    });
    this.#reconcile = settled;
    return settled;
  }

  /** Snapshot and consume a matching prefix of the bounded event batch. */
  drain(): Promise<boolean> {
    return this.#serializeTmux(() => this.#drain());
  }

  async #drain(): Promise<boolean> {
    const finish = this.#beginDiagnostic("drain");
    const option = tmuxInteractionOption(this.#bufferName);
    // A reusable snapshot bounds storage. User after-set-option hooks may
    // yield, so snapshot and clear are NOT an atomic command pair. Consume
    // only the matching prefix in a later single native mutation.
    const drainName = `${option}-drain`;
    // if-shell -F does not yield or invoke user hooks. Its branch removes
    // exactly the snapshot prefix; an append after the snapshot survives.
    // An overflowing producer can replace that prefix: do not project stale
    // data or clear the new batch, report the gap and retry on the next turn.
    const snapshotLength = `#{n:${drainName}}`;
    const remainingLength = `#{e|-:#{n:${option}},${snapshotLength}}`;
    const prefixMatches = `#{==:#{=/${snapshotLength}/:${option}},#{${drainName}}}`;
    const emptySnapshot = `#{==:#{${drainName}},}`;
    const suffix = `#{?${emptySnapshot},#{${option}},#{?#{==:${remainingLength},0},,#{=/-${remainingLength}/:${option}}}}`;
    let acknowledged: string;
    try {
      acknowledged = await this.#io.runTmux(
        [
          "set-option",
          "-gF",
          drainName,
          `#{${option}}`,
          ";",
          "if-shell",
          "-F",
          `#{||:${emptySnapshot},${prefixMatches}}`,
          `set-option -gF '${option}' '${suffix}' ; display-message -p tmux-ide-drain-consumed`,
          "display-message -p tmux-ide-drain-retry",
        ],
        this.#abort.signal,
      );
    } catch {
      // Mutation may have happened. Never retry/project this snapshot without
      // acknowledgement: that would invent success after uncertain delivery.
      this.#reportGap("detach-failed");
      finish(false);
      // Unread work may remain. The unread-aware waiter would immediately
      // retry otherwise, so persistent transport failures must also back off.
      await this.#io.delay(RETRY_MS, this.#abort.signal);
      return false;
    }
    const acknowledgement = acknowledged.trimEnd().split("\n").at(-1);
    if (acknowledgement !== "tmux-ide-drain-consumed") {
      await this.#deleteOption(drainName);
      this.#reportGap(acknowledgement === "tmux-ide-drain-retry" ? "overflow" : "detach-failed");
      finish(false);
      // One bounded attempt per drain; prevent churn under continuous overflow.
      await this.#io.delay(RETRY_MS, this.#abort.signal);
      return false;
    }
    let raw: string | undefined;
    // Retry the same immutable detached batch once. Never accumulate an
    // unbounded collection of failed batches or spin until a server recovers.
    for (let attempt = 0; attempt < 2 && !this.#abort.signal.aborted; attempt += 1) {
      try {
        raw = await this.#io.runTmux(["show-options", "-gv", drainName], this.#abort.signal);
        break;
      } catch {
        // Exhaustion is surfaced below, without terminal content or errors.
      }
    }
    await this.#deleteOption(drainName);
    if (raw === undefined) {
      this.#reportGap("read-failed");
      finish(false);
      return false;
    }
    if (Buffer.byteLength(raw, "utf8") > TMUX_INTERACTION_MAX_DRAIN_BYTES) {
      this.#reportGap("overflow");
      finish(false);
      return false;
    }
    if (raw.includes(TMUX_INTERACTION_GAP_RECORD)) this.#reportGap("overflow");
    let consumed = false;
    try {
      for (const record of parseTmuxInputHookRecords(raw)) {
        consumed = (await this.#project(record)) || consumed;
      }
    } catch (error) {
      this.#reportGap("projection-failed");
      finish(false);
      throw error;
    }
    finish(true);
    return consumed;
  }

  async #run(): Promise<void> {
    while (this.#active && !this.#abort.signal.aborted) {
      try {
        if (!this.#installed) await this.install();
        // The native waiter checks unread retention before blocking. Treat
        // wait-for signals as hints, not a counted or reliably latched queue.
        await this.#io.waitForSignal(this.#signalChannel, this.#abort.signal);
        if (!this.#active || this.#abort.signal.aborted) break;
        await this.drain();
      } catch {
        this.#setInstalled(false);
        this.#resetHealthcheckBackoff();
        await this.#io.delay(RETRY_MS, this.#abort.signal);
      }
    }
  }

  async #project(record: TmuxInputHookRecord): Promise<boolean> {
    if (
      consumeInternalReadOperation(
        record.operationMarker,
        record.runtimePaneId,
        record.operationKind,
      ) ||
      this.#authenticatedInternalReads.consume(
        record.operationMarker,
        record.runtimePaneId,
        record.operationKind,
      )
    ) {
      return true;
    }
    const ownPrefix = `${this.#daemonInstanceId}:`;
    const authoredOperationId = record.operationMarker?.startsWith(ownPrefix)
      ? record.operationMarker.slice(ownPrefix.length)
      : null;
    const operationId = z.uuid().safeParse(authoredOperationId);
    if (this.#resolveCapturedTarget) {
      const target = record.capturedTarget
        ? this.#resolveCapturedTarget(record.capturedTarget)
        : null;
      if (!target) {
        this.#onUnresolvedObservation?.(record);
        return false;
      }
      return this.#onObserved({
        ...target,
        operationKind: record.operationKind,
        operationId: operationId.success ? operationId.data : null,
        capturedTarget: record.capturedTarget,
      });
    }
    let identity: string;
    try {
      identity = await this.#io.runTmux(
        [
          "display-message",
          "-p",
          "-t",
          record.runtimePaneId,
          `#{session_name}\t#{${"@tmux_ide_pane_id"}}`,
        ],
        this.#abort.signal,
      );
    } catch {
      return false;
    }
    const separator = identity.indexOf("\t");
    if (separator < 1) return false;
    const sessionName = identity.slice(0, separator);
    const semanticPaneId = identity.slice(separator + 1);
    if (!WorkspacePaneCreationReferenceSchemaZ.safeParse(semanticPaneId).success) return false;
    const workspace = this.#registry.list().find((entry) => entry.sessionName === sessionName);
    if (!workspace) return false;
    return this.#onObserved({
      workspaceName: workspace.name,
      semanticPaneId,
      operationKind: record.operationKind,
      operationId: operationId.success ? operationId.data : null,
      ...(record.capturedTarget ? { capturedTarget: record.capturedTarget } : {}),
    });
  }

  /**
   * The other observers on this tmux server whose owner is alive: another
   * daemon process, or another owner generation of this one. Their hooks,
   * buffers and options are not ours to remove. Null when the server would
   * not say; then nothing foreign is touched at all.
   */
  async #liveOtherObservers(signal?: AbortSignal): Promise<ReadonlySet<string> | null> {
    let output: string;
    try {
      output = await this.#io.runTmux(["list-buffers", "-F", "#{buffer_name}"], signal);
    } catch {
      return null;
    }
    const live = new Set<string>();
    for (const name of output.split("\n")) {
      if (name === this.#bufferName || OWNER_NAME.exec(name)?.[0] !== name) continue;
      let record: string;
      try {
        record = (await this.#io.runTmux(["show-buffer", "-b", name], signal)).trim();
      } catch {
        continue;
      }
      const pid = Number(OWNER_RECORD.exec(record)?.[1]);
      // A marker without a pid was written by an older daemon; as before, it is cleared.
      if (!Number.isSafeInteger(pid)) continue;
      if (
        pid === this.#ownerProcess.pid
          ? liveLocalObservers.has(name)
          : this.#ownerProcess.isAlive(pid)
      )
        live.add(name);
    }
    return live;
  }

  /**
   * Remove this observer's hooks, and those nobody alive owns (a crashed
   * daemon's, legacy ones). Never another live observer's: two daemons on one
   * tmux server would otherwise keep taking each other's hooks away.
   */
  async #removeOwnedHooks(
    signal?: AbortSignal,
    others?: ReadonlySet<string> | null,
  ): Promise<void> {
    const live = others === undefined ? await this.#liveOtherObservers(signal) : others;
    for (const hookName of ["after-send-keys", "after-capture-pane"] as const) {
      let output: string;
      try {
        output = await this.#io.runTmux(["show-hooks", "-g", hookName], signal);
      } catch {
        continue;
      }
      for (const { index, owner } of ownedHooks(output, hookName)) {
        if (owner !== this.#bufferName && (live === null || (owner !== null && live.has(owner))))
          continue;
        try {
          await this.#io.runTmux(["set-hook", "-gu", `${hookName}[${index}]`], signal);
        } catch {
          // Best-effort retirement. A dead tmux server already retired the hook.
        }
      }
    }
    this.#setInstalled(false);
  }

  async #ownedHooksPresent(signal?: AbortSignal): Promise<"present" | "missing" | "unknown"> {
    // One client verifies both hook arrays: tmux runs the `;`-separated list in
    // a single command queue and prints each array's lines in order.
    let output: string;
    try {
      output = await this.#io.runTmux(
        ["show-hooks", "-g", "after-send-keys", ";", "show-hooks", "-g", "after-capture-pane"],
        signal,
      );
    } catch {
      return "unknown";
    }
    return ownedHookInstalled(output, "after-send-keys", this.#bufferName) &&
      ownedHookInstalled(output, "after-capture-pane", this.#bufferName)
      ? "present"
      : "missing";
  }

  get available(): boolean {
    return this.#installed;
  }
  #setInstalled(available: boolean): void {
    if (this.#installed === available) return;
    this.#installed = available;
    try {
      this.#onAvailability?.(available);
    } catch {
      /* observer status is not authority */
    }
  }

  #reportGap(reason: ExternalTmuxInteractionGap["reason"]): void {
    if (this.#abort.signal.aborted) return;
    const gap: ExternalTmuxInteractionGap = { reason, recovery: "future-observations-only" };
    logger.warn(
      "tmux-interaction-observer",
      "Interaction observation gap; missing history cannot be replayed",
      {
        daemonInstanceId: this.#daemonInstanceId,
        ...gap,
      },
    );
    try {
      this.#onGap?.(gap);
    } catch {
      /* Reporting cannot create operation authority. */
    }
  }

  async #deleteOption(name: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.#io.runTmux(["set-option", "-gu", name], signal);
    } catch {
      /* Best effort. */
    }
  }

  async #deleteRetention(): Promise<void> {
    const option = tmuxInteractionOption(this.#bufferName);
    await this.#deleteOption(option);
    await this.#deleteOption(`${option}-drain`);
    await this.#deleteBuffer(this.#bufferName);
  }

  async #deleteOwnedBuffers(
    signal: AbortSignal | undefined,
    live: ReadonlySet<string> | null,
  ): Promise<void> {
    if (live === null) return;
    let output: string;
    try {
      output = await this.#io.runTmux(["list-buffers", "-F", "#{buffer_name}"], signal);
    } catch {
      return;
    }
    for (const name of output.split("\n")) {
      if (!name.startsWith(OWNED_HOOK_MARKER) || name === this.#bufferName) continue;
      if (live.has(name)) continue;
      if (/^[A-Za-z0-9._-]{1,256}$/u.test(name)) {
        await this.#deleteOption(tmuxInteractionOption(name), signal);
        await this.#deleteOption(`${tmuxInteractionOption(name)}-drain`, signal);
      }
      await this.#deleteBuffer(name, signal);
    }
  }

  async #deleteBuffer(name: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.#io.runTmux(["delete-buffer", "-b", name], signal);
    } catch {
      // Missing buffers are the ordinary idle case.
    }
  }

  #serializeTmux<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#tmuxWork.then(operation, operation);
    this.#tmuxWork = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  #beginDiagnostic(
    operation: ExternalTmuxObserverDiagnostic["operation"],
  ): (succeeded: boolean) => void {
    const diagnostics = this.#diagnostics;
    if (!diagnostics) return () => undefined;
    let traceId: string;
    let startedAtMicros: number;
    try {
      traceId = diagnostics.createTraceId();
      startedAtMicros = diagnostics.nowMicros();
    } catch {
      return () => undefined;
    }
    this.#diagnosticActiveOperations += 1;
    const publish = (
      phase: ExternalTmuxObserverDiagnostic["phase"],
      atMicros: number,
      succeeded?: boolean,
    ): void => {
      try {
        diagnostics.publish({
          operation,
          phase,
          traceId,
          processId: `daemon:${process.pid}`,
          clockId: "node-performance-now",
          clockKind: "performance-now",
          atMicros,
          activeOperations: this.#diagnosticActiveOperations,
          ...(succeeded === undefined ? {} : { succeeded }),
        });
      } catch {
        // Diagnostics never alter observer authority or lifecycle.
      }
    };
    publish("begin", startedAtMicros);
    try {
      (diagnostics.queueMicrotask ?? queueMicrotask)(() => {
        try {
          publish("event-loop-sentinel", diagnostics.nowMicros());
        } catch {
          // Diagnostics are fail-open.
        }
      });
    } catch {
      // Diagnostics are fail-open.
    }
    let finished = false;
    return (succeeded) => {
      if (finished) return;
      finished = true;
      let atMicros = startedAtMicros;
      try {
        atMicros = diagnostics.nowMicros();
      } catch {
        // Preserve the operation even when the optional clock fails.
      }
      publish("end", atMicros, succeeded);
      this.#diagnosticActiveOperations = Math.max(0, this.#diagnosticActiveOperations - 1);
    };
  }
}
