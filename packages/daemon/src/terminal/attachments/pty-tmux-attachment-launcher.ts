import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { runTmux, TmuxError } from "@tmux-ide/tmux-bridge";
import { z } from "zod";
import { defaultNodePtyAdapter } from "../NodePtyAdapter.ts";
import type { PtyAdapter, PtyExitEvent, PtyProcess } from "../PtyAdapter.ts";
import {
  GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT,
  groupedTmuxViewSessionName,
  type GroupedTmuxAttachmentPlan,
  type TmuxArgvPlan,
} from "./grouped-tmux.ts";
import {
  TmuxAttachmentClientTransportError,
  type TmuxAttachmentClientTransport,
  type TmuxAttachmentClientTransportAttempt,
  type TmuxAttachmentClientTransportInput,
  type TmuxAttachmentClientTransportOutcome,
  type TmuxAttachmentCommandResult,
  type TmuxAttachmentCommandRunner,
} from "./tmux-view-executor.ts";

const MAX_PROOF_OUTPUT_BYTES = 64 * 1024;
const MAX_PROOF_CLIENTS = 256;
const PROOF_MISMATCH_SENTINEL = "__tmux_ide_pty_view_proof_mismatch_v1__";
const RuntimeWindowIdSchemaZ = z.string().regex(/^@(?:0|[1-9][0-9]*)$/u);
const RuntimePaneIdSchemaZ = z.string().regex(/^%(?:0|[1-9][0-9]*)$/u);
const SafeTerminalValue = /^(?:xterm|screen|tmux|rxvt|vt100|ansi)[A-Za-z0-9+._-]{0,58}$/u;
const SafeColorTerminalValue = /^(?:truecolor|24bit)$/u;
const SafeLocaleValue = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/u;

export type DaemonTmuxSocketSelector =
  | { readonly kind: "name"; readonly name: string }
  | { readonly kind: "path"; readonly path: string };

export interface ClaimedPtyTmuxAttachment {
  readonly attemptId: string;
  readonly attachmentId: string;
  readonly generation: number;
  readonly pid: number;
  /**
   * Intentionally unsupported until the PTY adapter exposes public drain or
   * pending-capacity semantics. node-pty's public `write(): void` can enqueue
   * without bound when tmux stops reading.
   */
  write(data: string | Uint8Array): never;
  resize(cols: number, rows: number): void;
  onData(callback: (data: Buffer) => void): () => void;
  onExit(callback: (event: PtyExitEvent) => void): () => void;
  /** Terminates only this tmux client process; it never kills a tmux session. */
  dispose(): void;
}

export interface PtyTmuxAttachmentClaimKey {
  readonly attachmentId: string;
  readonly generation: number;
  readonly attemptId: string;
}

export interface PtyTmuxAttachmentLauncherOptions {
  /** The socket selector is daemon configuration, never attachment input. */
  readonly socketSelector: DaemonTmuxSocketSelector;
  /** A daemon-owned existing cwd. It is never accepted from a transport caller. */
  readonly trustedCwd: string;
  readonly ptyAdapter?: PtyAdapter;
  readonly proofRunner?: TmuxAttachmentCommandRunner;
  readonly tmuxExecutable?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly readinessTimeoutMs?: number;
  readonly readinessPollIntervalMs?: number;
  readonly maxEarlyOutputBytes?: number;
  readonly maxEarlyOutputFrames?: number;
  readonly maxOwnedAttempts?: number;
  readonly now?: () => number;
  readonly schedule?: (callback: () => void, delayMs: number) => () => void;
}

interface OwnedAttempt {
  readonly attemptId: string;
  readonly attachmentId: string;
  readonly generation: number;
  readonly viewSessionName: string;
  readonly markerValue: string;
  readonly expectedWindowId: string;
  readonly expectedPaneId: string;
  readonly viewerMode: GroupedTmuxAttachmentPlan["viewerMode"];
  readonly process: PtyProcess;
  readonly outcome: Promise<TmuxAttachmentClientTransportOutcome>;
  readonly resolveOutcome: (outcome: TmuxAttachmentClientTransportOutcome) => void;
  readonly earlyFrames: Buffer[];
  readonly dataListeners: Set<(data: Buffer) => void>;
  readonly exitListeners: Set<(event: PtyExitEvent) => void>;
  earlyBytes: number;
  claimed: boolean;
  ready: boolean;
  closed: boolean;
  outcomeSettled: boolean;
  exitEvent: PtyExitEvent | null;
  cancelPoll: (() => void) | null;
}

function defaultSchedule(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected <= 0 || selected > maximum) {
    throw new TypeError("PTY attachment launcher limit is invalid");
  }
  return selected;
}

function selectorArgv(selector: DaemonTmuxSocketSelector): readonly string[] {
  if (selector.kind === "name") {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(selector.name)) {
      throw new TypeError("tmux socket name is invalid");
    }
    return ["-L", selector.name];
  }
  if (
    selector.kind !== "path" ||
    !isAbsolute(selector.path) ||
    selector.path.length > 4096 ||
    /[\0\r\n]/u.test(selector.path)
  ) {
    throw new TypeError("tmux socket path is invalid");
  }
  return ["-S", selector.path];
}

function resolveTmuxExecutable(pathValue = process.env.PATH): string {
  for (const directory of (pathValue ?? "").split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    const candidate = join(directory, "tmux");
    try {
      accessSync(candidate, constants.X_OK);
      if (!statSync(candidate).isFile()) continue;
      return realpathSync(candidate);
    } catch {
      // Continue to the next daemon-owned PATH entry.
    }
  }
  throw new TypeError("tmux executable could not be resolved");
}

function validateTmuxExecutable(value: string): string {
  if (!isAbsolute(value) || value.length > 4096 || /[\0\r\n]/u.test(value)) {
    throw new TypeError("tmux executable must be an absolute daemon-owned path");
  }
  return value;
}

function terminalEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    TERM: SafeTerminalValue.test(source.TERM ?? "") ? source.TERM : "xterm-256color",
  };
  if (SafeColorTerminalValue.test(source.COLORTERM ?? "")) result.COLORTERM = source.COLORTERM;
  for (const name of ["LANG", "LC_ALL", "LC_CTYPE"] as const) {
    const value = source[name];
    if (value && SafeLocaleValue.test(value)) result[name] = value;
  }
  return result;
}

function quoteTmuxArgument(value: string): string {
  if (/[\0\r\n]/u.test(value)) throw new TypeError("invalid tmux proof argument");
  return JSON.stringify(value);
}

function tmuxCommandString(argv: readonly string[]): string {
  return argv.map(quoteTmuxArgument).join(" ");
}

function productionProofRunner(): TmuxAttachmentCommandRunner {
  return {
    run(command) {
      try {
        const stdout = runTmux([...command.argv], {
          encoding: "utf8",
          maxBuffer: MAX_PROOF_OUTPUT_BYTES,
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
}

function validateIdentity(input: TmuxAttachmentClientTransportInput): void {
  const identity = input.identity;
  if (
    !z.uuid().safeParse(identity.attachmentId).success ||
    groupedTmuxViewSessionName(identity.attachmentId, identity.generation) !==
      identity.viewSessionName ||
    identity.markerValue !== `v1:${identity.attachmentId.toLowerCase()}:${identity.generation}` ||
    !RuntimeWindowIdSchemaZ.safeParse(identity.expectedWindowId).success ||
    !RuntimePaneIdSchemaZ.safeParse(identity.expectedPaneId).success ||
    input.command.executable !== "tmux" ||
    input.command.argv.length === 0 ||
    input.command.argv[0] !== "if-shell" ||
    input.command.argv.includes("-C") ||
    input.command.argv.includes("run-shell") ||
    input.command.argv.length > 128 ||
    input.command.argv.some(
      (argument) =>
        typeof argument !== "string" ||
        Buffer.byteLength(argument, "utf8") > 16 * 1024 ||
        /[\0\r\n]/u.test(argument),
    ) ||
    !Number.isInteger(input.viewport.cols) ||
    input.viewport.cols <= 0 ||
    !Number.isInteger(input.viewport.rows) ||
    input.viewport.rows <= 0 ||
    !["interactive", "read-only"].includes(input.viewerMode)
  ) {
    throw new TypeError("guarded PTY attachment input is invalid");
  }
}

/**
 * A real, daemon-owned normal tmux client transport. It deliberately has no
 * URL, renderer, shell-command, cwd, or arbitrary-environment input surface.
 */
export class PtyTmuxAttachmentLauncher implements TmuxAttachmentClientTransport {
  readonly #ptyAdapter: PtyAdapter;
  readonly #proofRunner: TmuxAttachmentCommandRunner;
  readonly #tmuxExecutable: string;
  readonly #socketArgv: readonly string[];
  readonly #trustedCwd: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #timeoutMs: number;
  readonly #pollIntervalMs: number;
  readonly #maxEarlyBytes: number;
  readonly #maxEarlyFrames: number;
  readonly #maxOwnedAttempts: number;
  readonly #now: () => number;
  readonly #schedule: (callback: () => void, delayMs: number) => () => void;
  readonly #ownedByAttachment = new Map<string, OwnedAttempt>();
  readonly #reservedAttachments = new Set<string>();
  #lifecycleEpoch = 0;

  constructor(options: PtyTmuxAttachmentLauncherOptions) {
    this.#ptyAdapter = options.ptyAdapter ?? defaultNodePtyAdapter;
    this.#proofRunner = options.proofRunner ?? productionProofRunner();
    this.#tmuxExecutable = validateTmuxExecutable(
      options.tmuxExecutable ?? resolveTmuxExecutable(options.environment?.PATH),
    );
    this.#socketArgv = selectorArgv(options.socketSelector);
    if (!isAbsolute(options.trustedCwd) || /[\0\r\n]/u.test(options.trustedCwd)) {
      throw new TypeError("trusted cwd must be an absolute daemon-owned path");
    }
    this.#trustedCwd = options.trustedCwd;
    this.#environment = terminalEnvironment(options.environment ?? process.env);
    this.#timeoutMs = boundedPositiveInteger(options.readinessTimeoutMs, 2_000, 30_000);
    this.#pollIntervalMs = boundedPositiveInteger(options.readinessPollIntervalMs, 20, 1_000);
    this.#maxEarlyBytes = boundedPositiveInteger(
      options.maxEarlyOutputBytes,
      256 * 1024,
      4 * 1024 * 1024,
    );
    this.#maxEarlyFrames = boundedPositiveInteger(options.maxEarlyOutputFrames, 256, 4_096);
    this.#maxOwnedAttempts = boundedPositiveInteger(options.maxOwnedAttempts, 32, 256);
    this.#now = options.now ?? Date.now;
    this.#schedule = options.schedule ?? defaultSchedule;
  }

  beginGuardedAttach(
    input: TmuxAttachmentClientTransportInput,
  ): TmuxAttachmentClientTransportAttempt {
    validateIdentity(input);
    if (input.viewerMode === "read-only") {
      // Read-only tmux clients are not geometry-neutral without a proven
      // installed-version gate and continuously held interactive size owner.
      // This slice owns neither dependency, so it fails before PTY spawn.
      throw new TmuxAttachmentClientTransportError("read_only_unavailable");
    }
    const existing = this.#ownedByAttachment.get(input.identity.attachmentId);
    if (existing && input.identity.generation <= existing.generation) {
      throw new TypeError("attachment generation is stale or already owned");
    }
    if (this.#reservedAttachments.has(input.identity.attachmentId)) {
      throw new TypeError("attachment is already being synchronously claimed");
    }
    if (
      !existing &&
      this.#ownedByAttachment.size + this.#reservedAttachments.size >= this.#maxOwnedAttempts
    ) {
      throw new TypeError("PTY attachment capacity is exhausted");
    }
    if (existing) this.#dispose(existing);
    this.#reservedAttachments.add(input.identity.attachmentId);
    const lifecycleEpoch = this.#lifecycleEpoch;

    const attemptId = randomUUID();
    let resolveOutcome!: (outcome: TmuxAttachmentClientTransportOutcome) => void;
    const outcome = new Promise<TmuxAttachmentClientTransportOutcome>((resolve) => {
      resolveOutcome = resolve;
    });
    const earlyFrames: Buffer[] = [];
    let earlyBytes = 0;
    let earlyOverflow = false;
    let synchronousExit: PtyExitEvent | null = null;
    let state: OwnedAttempt | null = null;

    const receiveData = (data: Buffer): void => {
      if (state) {
        this.#receiveData(state, data);
        return;
      }
      if (
        earlyOverflow ||
        earlyFrames.length + 1 > this.#maxEarlyFrames ||
        data.byteLength > this.#maxEarlyBytes - earlyBytes
      ) {
        earlyOverflow = true;
        return;
      }
      const copy = Buffer.from(data);
      earlyFrames.push(copy);
      earlyBytes += copy.byteLength;
    };
    const receiveExit = (event: PtyExitEvent): void => {
      if (state) this.#receiveExit(state, event);
      else synchronousExit = { ...event };
    };

    let process: PtyProcess;
    try {
      // This is intentionally synchronous. The executor's final proof and
      // deadline decision cannot yield before this real PTY client is spawned.
      process = this.#ptyAdapter.spawnSync(
        {
          shell: this.#tmuxExecutable,
          args: [...this.#socketArgv, ...input.command.argv],
          cwd: this.#trustedCwd,
          cols: input.viewport.cols,
          rows: input.viewport.rows,
          env: { ...this.#environment },
          name: this.#environment.TERM,
          encoding: null,
        },
        { onData: receiveData, onExit: receiveExit },
      );
    } catch (error) {
      this.#reservedAttachments.delete(input.identity.attachmentId);
      throw error;
    }
    if (lifecycleEpoch !== this.#lifecycleEpoch) {
      this.#reservedAttachments.delete(input.identity.attachmentId);
      try {
        process.kill("SIGTERM");
      } catch {
        // A concurrent daemon shutdown already owns cleanup.
      }
      throw new TypeError("PTY attachment launch was cancelled");
    }
    if (!Number.isSafeInteger(process.pid) || process.pid <= 0) {
      this.#reservedAttachments.delete(input.identity.attachmentId);
      try {
        process.kill("SIGTERM");
      } catch {
        // Invalid handles are never retained.
      }
      throw new TypeError("PTY adapter returned an invalid process id");
    }

    state = {
      attemptId,
      attachmentId: input.identity.attachmentId,
      generation: input.identity.generation,
      viewSessionName: input.identity.viewSessionName,
      markerValue: input.identity.markerValue,
      expectedWindowId: input.identity.expectedWindowId,
      expectedPaneId: input.identity.expectedPaneId,
      viewerMode: input.viewerMode,
      process,
      outcome,
      resolveOutcome,
      earlyFrames,
      earlyBytes,
      dataListeners: new Set(),
      exitListeners: new Set(),
      claimed: false,
      ready: false,
      closed: false,
      outcomeSettled: false,
      exitEvent: synchronousExit,
      cancelPoll: null,
    };
    this.#ownedByAttachment.set(state.attachmentId, state);
    this.#reservedAttachments.delete(state.attachmentId);

    if (earlyOverflow || synchronousExit) {
      this.#fail(state);
    } else {
      const deadline = this.#now() + this.#timeoutMs;
      queueMicrotask(() => this.#pollReadiness(state!, deadline));
    }

    return {
      status: "claimed",
      attemptId,
      attachmentId: state.attachmentId,
      generation: state.generation,
      outcome,
    };
  }

  /** Exactly-once adoption of a proof-ready daemon-owned client. */
  claim(key: PtyTmuxAttachmentClaimKey): ClaimedPtyTmuxAttachment | null {
    const state = this.#ownedByAttachment.get(key.attachmentId);
    if (
      !state ||
      state.generation !== key.generation ||
      state.attemptId !== key.attemptId ||
      !state.ready ||
      state.closed ||
      state.claimed
    ) {
      return null;
    }
    state.claimed = true;
    return this.#clientHandle(state);
  }

  disposeAll(): void {
    this.#lifecycleEpoch += 1;
    this.#reservedAttachments.clear();
    for (const state of [...this.#ownedByAttachment.values()]) this.#dispose(state);
  }

  #clientHandle(state: OwnedAttempt): ClaimedPtyTmuxAttachment {
    return Object.freeze({
      attemptId: state.attemptId,
      attachmentId: state.attachmentId,
      generation: state.generation,
      pid: state.process.pid,
      write: (_data: string | Uint8Array): never => {
        if (state.viewerMode === "read-only") {
          throw new TypeError("read-only terminal attachments reject input");
        }
        throw new PtyTmuxAttachmentInputUnavailableError();
      },
      resize: (cols: number, rows: number) => {
        if (state.viewerMode === "read-only") {
          throw new TypeError("read-only terminal attachments reject resize");
        }
        if (!Number.isInteger(cols) || cols <= 0 || !Number.isInteger(rows) || rows <= 0) {
          throw new RangeError("terminal dimensions must be positive integers");
        }
        if (!state.closed) state.process.resize(cols, rows);
      },
      onData: (callback: (data: Buffer) => void) => {
        if (state.closed) return () => undefined;
        state.dataListeners.add(callback);
        if (state.dataListeners.size === 1) {
          const buffered = state.earlyFrames.splice(0);
          state.earlyBytes = 0;
          for (const frame of buffered) this.#notifyData(state, frame);
          if (state.closed) return () => undefined;
          try {
            state.process.resume();
          } catch {
            this.#dispose(state);
          }
        }
        return () => {
          state.dataListeners.delete(callback);
          if (!state.closed && state.dataListeners.size === 0) {
            try {
              state.process.pause();
            } catch {
              this.#dispose(state);
            }
          }
        };
      },
      onExit: (callback: (event: PtyExitEvent) => void) => {
        if (state.exitEvent) {
          const event = { ...state.exitEvent };
          queueMicrotask(() => callback(event));
          return () => undefined;
        }
        state.exitListeners.add(callback);
        return () => state.exitListeners.delete(callback);
      },
      dispose: () => this.#dispose(state),
    });
  }

  #receiveData(state: OwnedAttempt, data: Buffer): void {
    if (state.closed) return;
    if (state.ready && state.claimed && state.dataListeners.size > 0) {
      this.#notifyData(state, data);
      return;
    }
    if (
      state.earlyFrames.length + 1 > this.#maxEarlyFrames ||
      data.byteLength > this.#maxEarlyBytes - state.earlyBytes
    ) {
      this.#fail(state);
      return;
    }
    state.earlyFrames.push(Buffer.from(data));
    state.earlyBytes += data.byteLength;
  }

  #notifyData(state: OwnedAttempt, data: Buffer): void {
    for (const listener of state.dataListeners) {
      try {
        listener(Buffer.from(data));
      } catch {
        // One consumer cannot break sibling terminal consumers or ownership.
      }
    }
  }

  #receiveExit(state: OwnedAttempt, event: PtyExitEvent): void {
    if (state.exitEvent) return;
    state.exitEvent = { ...event };
    if (!state.ready) this.#settle(state, { status: "failed" });
    state.closed = true;
    state.cancelPoll?.();
    state.cancelPoll = null;
    state.dataListeners.clear();
    state.earlyFrames.length = 0;
    state.earlyBytes = 0;
    if (this.#ownedByAttachment.get(state.attachmentId) === state) {
      this.#ownedByAttachment.delete(state.attachmentId);
    }
    const listeners = [...state.exitListeners];
    state.exitListeners.clear();
    for (const listener of listeners) {
      try {
        listener({ ...event });
      } catch {
        // Exit fan-out is isolated.
      }
    }
  }

  #pollReadiness(state: OwnedAttempt, deadline: number): void {
    if (state.closed || state.outcomeSettled) return;
    if (this.#now() >= deadline) {
      this.#fail(state);
      return;
    }
    const proof = this.#proveAttached(state);
    if (proof === "attached") {
      try {
        state.process.pause();
      } catch {
        this.#fail(state);
        return;
      }
      state.ready = true;
      this.#settle(state, { status: "executed" });
      return;
    }
    if (proof === "view-proof-mismatch") {
      this.#settle(state, { status: "view-proof-mismatch" });
      this.#dispose(state);
      return;
    }
    if (proof === "failed") {
      this.#fail(state);
      return;
    }
    state.cancelPoll = this.#schedule(
      () => this.#pollReadiness(state, deadline),
      this.#pollIntervalMs,
    );
  }

  #proveAttached(state: OwnedAttempt): "attached" | "pending" | "view-proof-mismatch" | "failed" {
    const exactTarget = `=${state.viewSessionName}`;
    const proofTarget = `${exactTarget}:${state.expectedWindowId}.${state.expectedPaneId}`;
    const guard = `#{&&:#{==:#{window_id},${state.expectedWindowId}},#{&&:#{==:#{window_panes},1},#{&&:#{==:#{session_windows},1},#{==:#{${GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT}},${state.markerValue}}}}}`;
    const command: TmuxArgvPlan = {
      executable: "tmux",
      argv: [
        ...this.#socketArgv,
        "if-shell",
        "-F",
        "-t",
        proofTarget,
        guard,
        tmuxCommandString([
          "list-clients",
          "-t",
          exactTarget,
          "-F",
          "#{client_pid}\t#{session_name}",
        ]),
        tmuxCommandString(["display-message", "-p", PROOF_MISMATCH_SENTINEL]),
      ],
    };
    let result: TmuxAttachmentCommandResult;
    try {
      result = this.#proofRunner.run(command);
    } catch {
      return "failed";
    }
    if (result.status === "not-found") return "view-proof-mismatch";
    if (result.status !== "ok") return "failed";
    if (
      typeof result.stdout !== "string" ||
      result.stdout.includes("\0") ||
      Buffer.byteLength(result.stdout, "utf8") > MAX_PROOF_OUTPUT_BYTES
    ) {
      return "failed";
    }
    const normalized = result.stdout.replace(/(?:\r?\n)+$/u, "");
    if (normalized === PROOF_MISMATCH_SENTINEL) return "view-proof-mismatch";
    if (normalized === "") return "pending";
    const lines = normalized.split("\n");
    if (lines.length > MAX_PROOF_CLIENTS || lines.some((line) => line.includes("\r"))) {
      return "failed";
    }
    let matches = 0;
    for (const line of lines) {
      const fields = line.split("\t");
      if (fields.length !== 2 || !/^(?:0|[1-9][0-9]*)$/u.test(fields[0]!)) return "failed";
      if (Number(fields[0]) === state.process.pid) {
        if (fields[1] !== state.viewSessionName) return "failed";
        matches += 1;
      }
    }
    if (matches > 1) return "failed";
    return matches === 1 ? "attached" : "pending";
  }

  #settle(state: OwnedAttempt, outcome: TmuxAttachmentClientTransportOutcome): void {
    if (state.outcomeSettled) return;
    state.outcomeSettled = true;
    state.cancelPoll?.();
    state.cancelPoll = null;
    state.resolveOutcome(outcome);
  }

  #fail(state: OwnedAttempt): void {
    this.#settle(state, { status: "failed" });
    this.#dispose(state);
  }

  #dispose(state: OwnedAttempt): void {
    if (state.closed) {
      if (this.#ownedByAttachment.get(state.attachmentId) === state) {
        this.#ownedByAttachment.delete(state.attachmentId);
      }
      return;
    }
    state.closed = true;
    state.cancelPoll?.();
    state.cancelPoll = null;
    if (!state.outcomeSettled) this.#settle(state, { status: "failed" });
    if (this.#ownedByAttachment.get(state.attachmentId) === state) {
      this.#ownedByAttachment.delete(state.attachmentId);
    }
    state.dataListeners.clear();
    state.earlyFrames.length = 0;
    state.earlyBytes = 0;
    if (!state.exitEvent) {
      state.exitEvent = { exitCode: 0, signal: null };
      for (const listener of state.exitListeners) {
        try {
          listener({ ...state.exitEvent });
        } catch {
          // Disposal fan-out is isolated.
        }
      }
    }
    state.exitListeners.clear();
    try {
      state.process.kill("SIGTERM");
    } catch {
      // The client already exited. The tmux view and durable source remain.
    }
  }
}

export class PtyTmuxAttachmentInputUnavailableError extends Error {
  readonly code = "input-backpressure-unavailable" as const;

  constructor() {
    super("PTY input is unavailable until the adapter exposes bounded drain semantics.");
    this.name = "PtyTmuxAttachmentInputUnavailableError";
  }
}

/** Canonical identity passed by the executor without parsing guarded argv. */
export function ptyAttachmentIdentityFromPlan(plan: GroupedTmuxAttachmentPlan) {
  return {
    attachmentId: plan.identity.attachmentId,
    generation: plan.identity.generation,
    viewSessionName: plan.identity.viewSessionName,
    markerValue: plan.identity.markerValue,
    expectedWindowId: plan.identity.durableSource.windowId,
    expectedPaneId: plan.identity.durableSource.runtimePaneId,
  } as const;
}
