import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";

import {
  DAEMON_CHILD_OUTPUT_MAX_LINES,
  DAEMON_CHILD_OUTPUT_MAX_LINE_LENGTH,
  type CanonicalDaemonInfo,
  type DaemonChildOutputTail,
  type DesktopDaemonHostState,
  type DesktopDaemonSupervisorFatalReason,
} from "@tmux-ide/contracts";
import {
  DaemonBootstrapCoordinator,
  DaemonBootstrapError,
  type DaemonBootstrapProbe,
} from "@tmux-ide/daemon-client";

import {
  canonicalDaemonClaimAllowsStartupAttempt,
  inspectCanonicalDaemonInfo,
  isCanonicalDaemonRecordOwnerProvenDead,
  type CanonicalDaemonInfoState,
} from "../../../packages/daemon/src/canonical.ts";
import { runDaemonPreflight, type DaemonPreflight } from "./daemon-preflight.ts";
import {
  classifyDaemonStartFailure,
  daemonRestartDelayMs,
  supervisorHaltReason,
  DEFAULT_DAEMON_RESTART_POLICY,
  type DaemonRestartPolicy,
  type DaemonStartFailure,
} from "./daemon-supervision-policy.ts";

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_PROBE_TIMEOUT_MS = 1_000;
const MAX_CAPTURED_STREAM_BYTES = 64 * 1024;
const MAX_BACKOFF_MS = 400;

interface SpawnedDaemonChild {
  readonly pid?: number;
  readonly stdout: Pick<Readable, "on">;
  readonly stderr: Pick<Readable, "on">;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
}

export interface OwnedDaemonGeneration {
  readonly pid: number;
  readonly instanceId: string;
  readonly startedAt: string;
}

export interface DaemonChildDiagnostics {
  readonly pid: number | null;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface DaemonSupervisionDiagnostics {
  /** Failed start attempts since the last successful attach/own. */
  readonly consecutiveFailures: number;
  /** Fatal-classified failures in a row; the halt ceiling counts these. */
  readonly consecutiveFatalFailures: number;
  /** Set exactly when phase is "halted". */
  readonly fatalReason: DesktopDaemonSupervisorFatalReason | null;
}

export interface DesktopDaemonSupervisorSnapshot {
  readonly phase:
    | "idle"
    | "attached"
    | "starting"
    | "owned"
    | "unavailable"
    | "crashed"
    | "restarting"
    | "halted"
    | "stopped";
  readonly daemon: DesktopDaemonHostState | null;
  readonly ownedGeneration: OwnedDaemonGeneration | null;
  readonly child: DaemonChildDiagnostics | null;
  readonly supervision: DaemonSupervisionDiagnostics;
}

export interface DesktopDaemonSupervisorOptions {
  readonly preflight: DaemonPreflight;
  readonly childEntryPath: string;
  readonly productVersion: string;
  readonly startupTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly probeTimeoutMs?: number;
  readonly restartPolicy?: Partial<DaemonRestartPolicy>;
  readonly onOwnedDaemonCrash?: (snapshot: DesktopDaemonSupervisorSnapshot) => void;
  /**
   * Background supervision transitions (a restart attempt settling, the loop
   * halting). Fired outside start()/stopOwned() so the host can revalidate
   * its daemon connection; never fired after stopOwned() was requested.
   */
  readonly onSupervisedDaemonStateChanged?: (snapshot: DesktopDaemonSupervisorSnapshot) => void;
  /**
   * Forward the daemon child's stderr to this process's stderr as it arrives.
   * Defaults to the `TMUX_IDE_DAEMON_CHILD_LOG=1` environment opt-in.
   */
  readonly forwardChildLog?: boolean;
}

export interface DesktopDaemonSupervisorDependencies {
  readonly claimAllowsStartupAttempt: () => boolean;
  readonly inspectCanonical: () => CanonicalDaemonInfoState;
  readonly ownerProvenDead: (
    state: Exclude<CanonicalDaemonInfoState, { status: "missing" }>,
  ) => Promise<boolean>;
  readonly spawnChild: (childEntryPath: string, productVersion: string) => SpawnedDaemonChild;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly random: () => number;
  /** Where forwarded child stderr goes. Production writes this process's stderr. */
  readonly writeChildLog: (chunk: string) => void;
}

interface ChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface StartAttemptOutcome {
  readonly daemon: DesktopDaemonHostState;
  readonly terminal: "attached" | "owned" | "cancelled" | "failed";
  readonly failure: DaemonStartFailure | null;
}

class BoundedStreamCapture {
  #buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  #truncated = false;

  append(chunk: string | Buffer): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bytes.length >= MAX_CAPTURED_STREAM_BYTES) {
      this.#buffer = bytes.subarray(bytes.length - MAX_CAPTURED_STREAM_BYTES);
      this.#truncated = true;
      return;
    }
    const overflow = this.#buffer.length + bytes.length - MAX_CAPTURED_STREAM_BYTES;
    if (overflow > 0) {
      this.#buffer = this.#buffer.subarray(overflow);
      this.#truncated = true;
    }
    this.#buffer = Buffer.concat([this.#buffer, bytes]);
  }

  text(): string {
    return this.#buffer.toString("utf8");
  }

  truncated(): boolean {
    return this.#truncated;
  }

  /** The last `maxLines` wire-safe lines of what was captured. */
  lines(maxLines: number): readonly string[] {
    return sanitizeDaemonChildOutputLines(this.text(), maxLines);
  }
}

/**
 * PURE. Turn raw captured child output into lines the renderer bridge accepts.
 *
 * Three guarantees, each matching a rule the contract enforces: control
 * characters are stripped (a daemon writing ANSI must not corrupt the shell's
 * UI), every line is bounded, and any line that looks like it carries a
 * credential is DROPPED rather than truncated — a diagnostic must never become
 * a credential leak. A leading partial line from a truncated capture is
 * discarded so no line is shown half-read.
 */
export function sanitizeDaemonChildOutputLines(
  text: string,
  maxLines: number,
  options: { readonly dropLeadingPartial?: boolean } = {},
): readonly string[] {
  const raw = text.split("\n");
  if (options.dropLeadingPartial && raw.length > 1) raw.shift();
  const lines: string[] = [];
  for (const line of raw) {
    const cleaned = [...line.replace(/\r/gu, "")]
      .filter((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 && code !== 127;
      })
      .join("")
      .trimEnd()
      .slice(0, DAEMON_CHILD_OUTPUT_MAX_LINE_LENGTH);
    if (cleaned.length === 0) continue;
    if (/(?:authorization|bearer\s+|owner.?token|redemptionticket|ta1_)/iu.test(cleaned)) continue;
    lines.push(cleaned);
  }
  return lines.slice(-maxLines);
}

/**
 * The child receives NO credential material: it mints its own bypass token
 * in-process and publishes it only through the owner-only daemon record.
 * Anything added to argv or env here is visible to every same-user process,
 * so this spawn must stay limited to non-secret configuration.
 */
function defaultSpawnChild(childEntryPath: string, productVersion: string): SpawnedDaemonChild {
  const environment = { ...process.env };
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  return spawn(process.execPath, [childEntryPath], {
    env: {
      ...environment,
      ELECTRON_RUN_AS_NODE: "1",
      TMUX_IDE_DESKTOP_PRODUCT_VERSION: productVersion,
      TMUX_IDE_TEMPLATES_DIR: join(dirname(childEntryPath), "templates"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const defaultDependencies: DesktopDaemonSupervisorDependencies = {
  claimAllowsStartupAttempt: canonicalDaemonClaimAllowsStartupAttempt,
  inspectCanonical: inspectCanonicalDaemonInfo,
  ownerProvenDead: isCanonicalDaemonRecordOwnerProvenDead,
  spawnChild: defaultSpawnChild,
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  random: () => Math.random(),
  writeChildLog: (chunk) => {
    try {
      process.stderr.write(chunk);
    } catch {
      // A closed stderr must never destabilize supervision.
    }
  },
};

function startupFailure(reason: string): DesktopDaemonHostState {
  return { status: "unavailable", code: "probe-failed", reason };
}

function startupTimeout(timeoutMs: number): DesktopDaemonHostState {
  return {
    status: "unavailable",
    code: "probe-timeout",
    reason: `Bundled daemon startup timed out after ${timeoutMs}ms.`,
  };
}

function preflightFailure(
  state: Exclude<DesktopDaemonHostState, { status: "connected" }>,
): DaemonStartFailure {
  return { kind: "preflight", status: state.status, code: state.code };
}

function canonicalMatchesDaemon(
  info: CanonicalDaemonInfo,
  daemon: Extract<DesktopDaemonHostState, { status: "connected" }>,
): boolean {
  return (
    info.instanceId === daemon.descriptor.instanceId &&
    info.startedAt === daemon.descriptor.startedAt &&
    info.protocolVersion === daemon.descriptor.protocolVersion &&
    info.productVersion === daemon.descriptor.productVersion
  );
}

/**
 * Electron-owned lifecycle wrapper around the canonical foreground daemon.
 *
 * The canonical daemon remains the authority for startup claims and record
 * cleanup. This wrapper may signal only the exact child process it spawned and
 * records ownership only after that PID and canonical generation both pass the
 * existing secure preflight.
 *
 * Supervision: an owned child that crashes, and a start attempt that fails,
 * are retried with bounded, jittered exponential backoff. Failures classified
 * as FATAL (structurally broken daemon: incompatible protocol, corrupt record,
 * non-loopback endpoint, unstartable bundle, structural child exit) stop the
 * loop after a small consecutive ceiling and surface a typed reason instead of
 * retrying a broken backend forever. Transient failures retry indefinitely at
 * the capped delay.
 */
export class DesktopDaemonSupervisor {
  readonly #options: DesktopDaemonSupervisorOptions;
  readonly #dependencies: DesktopDaemonSupervisorDependencies;
  readonly #restartPolicy: DaemonRestartPolicy;
  readonly #forwardChildLog: boolean;

  #stdout = new BoundedStreamCapture();
  #stderr = new BoundedStreamCapture();
  #phase: DesktopDaemonSupervisorSnapshot["phase"] = "idle";
  #daemon: DesktopDaemonHostState | null = null;
  #ownedGeneration: OwnedDaemonGeneration | null = null;
  #child: SpawnedDaemonChild | null = null;
  #childExit: ChildExit | null = null;
  #childExitPromise: Promise<ChildExit> | null = null;
  #childStopPromise: Promise<void> | null = null;
  #expectedStop = false;
  #stopRequested = false;
  #startPromise: Promise<DesktopDaemonHostState> | null = null;
  #stopPromise: Promise<void> | null = null;
  #restartTask: Promise<void> | null = null;
  #cancelBackoffWait: (() => void) | null = null;
  #consecutiveFailures = 0;
  #consecutiveFatalFailures = 0;
  #fatalReason: DesktopDaemonSupervisorFatalReason | null = null;

  constructor(
    options: DesktopDaemonSupervisorOptions,
    dependencies: Partial<DesktopDaemonSupervisorDependencies> = {},
  ) {
    this.#options = options;
    this.#dependencies = { ...defaultDependencies, ...dependencies };
    this.#restartPolicy = { ...DEFAULT_DAEMON_RESTART_POLICY, ...options.restartPolicy };
    this.#forwardChildLog =
      options.forwardChildLog ?? process.env.TMUX_IDE_DAEMON_CHILD_LOG === "1";
  }

  start(): Promise<DesktopDaemonHostState> {
    if (!this.#startPromise) {
      this.#startPromise = this.#stopRequested
        ? Promise.resolve(this.#finishCancelledStartup())
        : this.#superviseFirstAttempt();
    }
    return this.#startPromise;
  }

  /**
   * The daemon child's own last words, bounded and wire-safe, or null when this
   * generation spawned no child or it printed nothing usable.
   *
   * This exists because the capture above used to be write-only: a child that
   * died with a clear message on stderr reached the user as a blank "connection
   * failed". The tail travels with the disconnected state so a stuck readiness
   * rung arrives with the child's explanation attached.
   */
  childOutputTail(): DaemonChildOutputTail | null {
    if (!this.#child) return null;
    const lines = sanitizeDaemonChildOutputLines(
      this.#stderr.text(),
      DAEMON_CHILD_OUTPUT_MAX_LINES,
      {
        dropLeadingPartial: this.#stderr.truncated(),
      },
    );
    if (lines.length === 0) return null;
    const signal = this.#childExit?.signal ?? null;
    return {
      stream: "stderr",
      lines: [...lines],
      truncated: this.#stderr.truncated(),
      exitCode: this.#childExit?.code ?? null,
      signal: signal !== null && /^SIG[A-Z0-9]{1,12}$/u.test(signal) ? signal : null,
    };
  }

  snapshot(): DesktopDaemonSupervisorSnapshot {
    const child = this.#child;
    return {
      phase: this.#phase,
      daemon: this.#daemon,
      ownedGeneration: this.#ownedGeneration,
      child: child
        ? {
            pid: child.pid ?? null,
            exitCode: this.#childExit?.code ?? null,
            signal: this.#childExit?.signal ?? null,
            stdout: this.#stdout.text(),
            stderr: this.#stderr.text(),
            stdoutTruncated: this.#stdout.truncated(),
            stderrTruncated: this.#stderr.truncated(),
          }
        : null,
      supervision: {
        consecutiveFailures: this.#consecutiveFailures,
        consecutiveFatalFailures: this.#consecutiveFatalFailures,
        fatalReason: this.#fatalReason,
      },
    };
  }

  stopOwned(): Promise<void> {
    // Cancellation is synchronous so every await boundary in a start attempt
    // observes shutdown before it can spawn or adopt a canonical generation.
    this.#stopRequested = true;
    this.#expectedStop = true;
    this.#cancelBackoffWait?.();
    if (!this.#stopPromise) this.#stopPromise = this.#stopOwned();
    return this.#stopPromise;
  }

  async #superviseFirstAttempt(): Promise<DesktopDaemonHostState> {
    const outcome = await this.#attemptStart();
    this.#settleOutcome(outcome, { notify: false });
    return outcome.daemon;
  }

  /**
   * Digest one settled attempt: reset streaks on success, classify a failure,
   * halt at the fatal ceiling, otherwise schedule the next bounded retry.
   */
  #settleOutcome(outcome: StartAttemptOutcome, options: { notify: boolean }): void {
    if (outcome.terminal === "cancelled" || this.#stopRequested) return;
    if (outcome.terminal === "attached" || outcome.terminal === "owned") {
      this.#consecutiveFailures = 0;
      this.#consecutiveFatalFailures = 0;
      if (options.notify) this.#notifySupervisedChange();
      return;
    }

    this.#consecutiveFailures += 1;
    const failure = outcome.failure ?? { kind: "readiness-timeout" as const };
    const classification = classifyDaemonStartFailure(failure);
    if (classification.severity === "fatal") {
      this.#consecutiveFatalFailures += 1;
      if (this.#consecutiveFatalFailures >= this.#restartPolicy.fatalFailureCeiling) {
        this.#halt(classification.reason, outcome.daemon);
        this.#notifySupervisedChange();
        return;
      }
    } else {
      this.#consecutiveFatalFailures = 0;
    }
    if (options.notify) this.#notifySupervisedChange();
    this.#scheduleRestart();
  }

  #halt(
    reason: DesktopDaemonSupervisorFatalReason,
    lastDaemon: DesktopDaemonHostState | null,
  ): void {
    this.#fatalReason = reason;
    this.#phase = "halted";
    const lastFailureReason =
      lastDaemon && lastDaemon.status !== "connected" ? lastDaemon.reason : "";
    this.#daemon = {
      status: "degraded",
      code: "supervisor-halted",
      reason: supervisorHaltReason(
        reason,
        this.#restartPolicy.fatalFailureCeiling,
        lastFailureReason,
      ),
    };
  }

  #scheduleRestart(): void {
    if (this.#stopRequested || this.#phase === "halted") return;
    const delayMs = daemonRestartDelayMs(
      Math.max(0, this.#consecutiveFailures - 1),
      this.#restartPolicy,
      this.#dependencies.random,
    );
    this.#phase = "restarting";
    this.#restartTask = this.#runScheduledRestart(delayMs).catch(() => undefined);
  }

  async #runScheduledRestart(delayMs: number): Promise<void> {
    const wait = await this.#backoffWait(delayMs);
    if (wait === "cancelled" || this.#stopRequested) return;
    const outcome = await this.#attemptStart();
    this.#settleOutcome(outcome, { notify: true });
  }

  /** Interruptible backoff so quit never waits out a pending restart delay. */
  #backoffWait(delayMs: number): Promise<"elapsed" | "cancelled"> {
    if (this.#stopRequested) return Promise.resolve("cancelled");
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: "elapsed" | "cancelled"): void => {
        if (settled) return;
        settled = true;
        if (this.#cancelBackoffWait === cancel) this.#cancelBackoffWait = null;
        resolve(result);
      };
      const cancel = (): void => finish("cancelled");
      this.#cancelBackoffWait = cancel;
      void this.#dependencies.sleep(delayMs).then(() => finish("elapsed"));
    });
  }

  #notifySupervisedChange(): void {
    if (this.#stopRequested) return;
    try {
      this.#options.onSupervisedDaemonStateChanged?.(this.snapshot());
    } catch {
      // Observation must never destabilize supervision.
    }
  }

  async #attemptStart(): Promise<StartAttemptOutcome> {
    type Connected = Extract<DesktopDaemonHostState, { status: "connected" }>;
    type Unready = Exclude<DesktopDaemonHostState, { status: "connected" }>;
    const timeoutMs = this.#options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    let lastUnready: Unready | null = null;
    let spawnAttempted = false;
    let spawnedPid: number | null = null;

    const probe = async (): Promise<DaemonBootstrapProbe<Connected, Unready>> => {
      const state = await runDaemonPreflight(
        this.#options.preflight,
        this.#options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      );
      this.#daemon = state;
      if (state.status === "connected") return { status: "compatible", candidate: state };
      lastUnready = state;
      // Child ownership remains Electron-specific. Surface its exit through the
      // coordinator probe rather than letting a frozen/test clock (or a very
      // large timeout) keep polling a generation that can no longer publish.
      if (spawnedPid !== null && this.#childExit) {
        throw new Error("The bundled daemon exited before readiness.");
      }
      if (
        state.status === "unavailable" &&
        (state.code === "record-missing" || state.code === "process-not-running")
      ) {
        return { status: "absent-or-stale" };
      }
      return { status: "incompatible", reason: state };
    };

    const coordinator = new DaemonBootstrapCoordinator<Connected, never, Unready>({
      probe,
      timeoutMs,
      now: this.#dependencies.now,
      sleep: this.#dependencies.sleep,
      pollMs: (poll) => Math.min(25 * 2 ** poll, MAX_BACKOFF_MS),
      onPhaseChanged: ({ phase }) => {
        if (phase === "spawning" || phase === "control-ready") this.#phase = "starting";
      },
      spawn: async () => {
        if (this.#stopRequested) throw new Error("Desktop daemon startup was cancelled.");
        const state = lastUnready;
        if (
          !state ||
          state.status !== "unavailable" ||
          (state.code !== "record-missing" && state.code !== "process-not-running") ||
          !(await this.#spawnIsSafe(state.code))
        ) {
          // The coordinator performs one final probe after this throw, allowing
          // a concurrent canonical winner to turn the local loss into attach.
          throw new Error("Canonical startup authority is no longer available.");
        }
        if (this.#stopRequested) throw new Error("Desktop daemon startup was cancelled.");
        spawnAttempted = true;
        const child = this.#dependencies.spawnChild(
          this.#options.childEntryPath,
          this.#options.productVersion,
        );
        this.#adoptSpawnedChild(child);
        if (!Number.isInteger(child.pid) || (child.pid ?? 0) < 1) {
          await this.#stopSpawnedChild();
          throw new Error("The bundled daemon process did not publish a process ID.");
        }
        spawnedPid = child.pid!;
      },
    });

    try {
      const result = await coordinator.ensure();
      if (this.#stopRequested) {
        await this.#stopSpawnedChild();
        return this.#cancelledOutcome();
      }
      const daemon = result.candidate;
      this.#daemon = daemon;
      if (spawnedPid === null) {
        this.#phase = "attached";
        return { daemon, terminal: "attached", failure: null };
      }

      const canonical = this.#dependencies.inspectCanonical();
      if (canonical.status !== "valid" || !canonicalMatchesDaemon(canonical.info, daemon)) {
        await this.#stopSpawnedChild();
        const failure = startupFailure(
          "Canonical daemon identity changed during the desktop readiness barrier.",
        );
        this.#daemon = failure;
        this.#phase = "unavailable";
        return { daemon: failure, terminal: "failed", failure: { kind: "identity-changed" } };
      }
      if (canonical.info.pid !== spawnedPid) {
        await this.#stopSpawnedChild();
        this.#phase = "attached";
        return { daemon, terminal: "attached", failure: null };
      }
      if (this.#childExit) {
        const exit = this.#childExit;
        const failure: DesktopDaemonHostState = {
          status: "unavailable",
          code: "process-not-running",
          reason: "The bundled daemon exited during the desktop readiness barrier.",
        };
        this.#daemon = failure;
        this.#phase = "unavailable";
        return {
          daemon: failure,
          terminal: "failed",
          failure: { kind: "child-exit", exitCode: exit.code, signal: exit.signal },
        };
      }
      this.#ownedGeneration = {
        pid: spawnedPid,
        instanceId: canonical.info.instanceId,
        startedAt: canonical.info.startedAt,
      };
      this.#phase = "owned";
      return { daemon, terminal: "owned", failure: null };
    } catch (error) {
      if (this.#stopRequested) {
        await this.#stopSpawnedChild();
        return this.#cancelledOutcome();
      }
      if (this.#childExit) {
        const exit = this.#childExit;
        const state = lastUnready ?? startupFailure("The bundled daemon exited before readiness.");
        this.#daemon = state;
        this.#phase = "unavailable";
        return {
          daemon: state,
          terminal: "failed",
          failure: { kind: "child-exit", exitCode: exit.code, signal: exit.signal },
        };
      }
      if (error instanceof DaemonBootstrapError && error.code === "incompatible" && error.reason) {
        this.#daemon = error.reason;
        this.#phase = "unavailable";
        return {
          daemon: error.reason,
          terminal: "failed",
          failure: preflightFailure(error.reason),
        };
      }
      await this.#stopSpawnedChild();
      if (error instanceof DaemonBootstrapError && error.code === "control-timeout") {
        const failure = startupTimeout(timeoutMs);
        this.#daemon = failure;
        this.#phase = "unavailable";
        return { daemon: failure, terminal: "failed", failure: { kind: "readiness-timeout" } };
      }
      const failure =
        lastUnready && !spawnAttempted
          ? lastUnready
          : startupFailure("The bundled daemon process could not be started.");
      this.#daemon = failure;
      this.#phase = "unavailable";
      return {
        daemon: failure,
        terminal: "failed",
        failure:
          lastUnready && !spawnAttempted ? preflightFailure(lastUnready) : { kind: "spawn-failed" },
      };
    }
  }

  /** Reset per-generation child state and wire capture/exit for a new child. */
  #adoptSpawnedChild(child: SpawnedDaemonChild): void {
    this.#child = child;
    this.#childExit = null;
    this.#childStopPromise = null;
    this.#expectedStop = this.#stopRequested;
    this.#stdout = new BoundedStreamCapture();
    this.#stderr = new BoundedStreamCapture();
    child.stdout.on("data", (chunk: string | Buffer) => {
      if (this.#child === child) this.#stdout.append(chunk);
    });
    child.stderr.on("data", (chunk: string | Buffer) => {
      if (this.#child !== child) return;
      this.#stderr.append(chunk);
      // Opt-in live passthrough. The capture below is a bounded tail meant for
      // the renderer; when a developer needs the child's full running commentary
      // it has to reach a terminal, and this is the only place that can do it.
      if (this.#forwardChildLog) {
        this.#dependencies.writeChildLog(
          typeof chunk === "string" ? chunk : chunk.toString("utf8"),
        );
      }
    });
    this.#childExitPromise = new Promise<ChildExit>((resolve) => {
      let settled = false;
      const finish = (exit: ChildExit): void => {
        if (settled) return;
        settled = true;
        // A superseded generation's late exit must not clobber the current one.
        if (this.#child === child) {
          this.#childExit = exit;
          resolve(exit);
          this.#onChildExit(exit);
          return;
        }
        resolve(exit);
      };
      child.once("exit", (code, signal) => finish({ code, signal }));
      child.once("error", () => finish({ code: null, signal: null }));
    });
  }

  async #spawnIsSafe(code: "record-missing" | "process-not-running"): Promise<boolean> {
    if (!this.#dependencies.claimAllowsStartupAttempt()) return false;
    const current = this.#dependencies.inspectCanonical();
    if (code === "record-missing") return current.status === "missing";
    if (current.status !== "valid") return false;
    return this.#dependencies.ownerProvenDead(current);
  }

  async #stopOwned(): Promise<void> {
    // The exact child reference is sufficient authority to terminate a child
    // that is still inside the readiness barrier. Waiting for
    // ownedGeneration here would leak a daemon when quit races that handoff.
    await this.#stopSpawnedChild();
    await this.#startPromise?.catch(() => undefined);
    await this.#restartTask?.catch(() => undefined);
    // An attempt may have crossed the synchronous spawn boundary immediately
    // before cancellation. Re-check after everything settles and use the same
    // deduplicated exact-child termination.
    await this.#stopSpawnedChild();
    this.#ownedGeneration = null;
    this.#phase = "stopped";
  }

  #stopSpawnedChild(): Promise<void> {
    const child = this.#child;
    const exit = this.#childExitPromise;
    if (!child || !exit || this.#childExit) return Promise.resolve();
    if (!this.#childStopPromise) this.#childStopPromise = this.#terminateSpawnedChild(child, exit);
    return this.#childStopPromise;
  }

  async #terminateSpawnedChild(child: SpawnedDaemonChild, exit: Promise<ChildExit>): Promise<void> {
    this.#expectedStop = true;
    child.kill("SIGTERM");
    const timeoutMs = this.#options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    const finished = await Promise.race([
      exit.then(() => true),
      this.#dependencies.sleep(timeoutMs).then(() => false),
    ]);
    if (finished || this.#childExit) return;
    child.kill("SIGKILL");
    await Promise.race([exit, this.#dependencies.sleep(250)]);
  }

  #cancelledOutcome(): StartAttemptOutcome {
    return { daemon: this.#finishCancelledStartup(), terminal: "cancelled", failure: null };
  }

  #finishCancelledStartup(): DesktopDaemonHostState {
    const daemon =
      this.#daemon ??
      startupFailure("Bundled daemon startup was cancelled during desktop shutdown.");
    this.#daemon = daemon;
    this.#ownedGeneration = null;
    this.#phase = "stopped";
    return daemon;
  }

  #onChildExit(exit: ChildExit): void {
    if (this.#expectedStop || this.#phase !== "owned" || !this.#ownedGeneration) return;
    this.#phase = "crashed";
    this.#daemon = startupFailure(
      `The owned daemon process exited unexpectedly${
        exit.signal ? ` after ${exit.signal}` : ` with code ${exit.code ?? "unknown"}`
      }.`,
    );
    this.#options.onOwnedDaemonCrash?.(this.snapshot());
    // A crash joins the failure streak so the first restart waits the initial
    // backoff and subsequent failed attempts keep doubling from there. The
    // streak was reset to zero when this generation reached "owned".
    this.#consecutiveFailures += 1;
    this.#ownedGeneration = null;
    this.#scheduleRestart();
  }
}

export type { SpawnedDaemonChild };
export { defaultSpawnChild };
