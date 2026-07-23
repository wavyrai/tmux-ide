import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";

import type {
  CanonicalDaemonInfo,
  DesktopDaemonHostState,
  DesktopDaemonSupervisorFatalReason,
} from "@tmux-ide/contracts";

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
  }

  start(): Promise<DesktopDaemonHostState> {
    if (!this.#startPromise) {
      this.#startPromise = this.#stopRequested
        ? Promise.resolve(this.#finishCancelledStartup())
        : this.#superviseFirstAttempt();
    }
    return this.#startPromise;
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
    const initial = await runDaemonPreflight(
      this.#options.preflight,
      this.#options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    );
    this.#daemon = initial;
    if (this.#stopRequested) return this.#cancelledOutcome();
    if (initial.status === "connected") {
      this.#phase = "attached";
      return { daemon: initial, terminal: "attached", failure: null };
    }
    if (
      initial.status === "degraded" ||
      (initial.code !== "record-missing" && initial.code !== "process-not-running")
    ) {
      this.#phase = "unavailable";
      return { daemon: initial, terminal: "failed", failure: preflightFailure(initial) };
    }

    const spawnIsSafe = await this.#spawnIsSafe(initial.code);
    if (this.#stopRequested) return this.#cancelledOutcome();
    if (!spawnIsSafe) {
      const current = await runDaemonPreflight(
        this.#options.preflight,
        this.#options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      );
      this.#daemon = current;
      if (this.#stopRequested) return this.#cancelledOutcome();
      if (current.status === "connected") {
        this.#phase = "attached";
        return { daemon: current, terminal: "attached", failure: null };
      }
      this.#phase = "unavailable";
      return { daemon: current, terminal: "failed", failure: preflightFailure(current) };
    }

    let child: SpawnedDaemonChild;
    try {
      child = this.#dependencies.spawnChild(
        this.#options.childEntryPath,
        this.#options.productVersion,
      );
    } catch {
      const failure = startupFailure("The bundled daemon process could not be started.");
      this.#daemon = failure;
      this.#phase = "unavailable";
      return { daemon: failure, terminal: "failed", failure: { kind: "spawn-failed" } };
    }
    this.#adoptSpawnedChild(child);
    this.#phase = "starting";
    if (this.#stopRequested) {
      await this.#stopSpawnedChild();
      return this.#cancelledOutcome();
    }
    if (!Number.isInteger(child.pid) || (child.pid ?? 0) < 1) {
      await this.#stopSpawnedChild();
      const failure = startupFailure("The bundled daemon process did not publish a process ID.");
      this.#daemon = failure;
      this.#phase = "unavailable";
      return { daemon: failure, terminal: "failed", failure: { kind: "spawn-failed" } };
    }

    return this.#waitUntilReady(child.pid!);
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
      if (this.#child === child) this.#stderr.append(chunk);
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

  async #waitUntilReady(childPid: number): Promise<StartAttemptOutcome> {
    const timeoutMs = this.#options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    const deadline = this.#dependencies.now() + timeoutMs;
    let backoffMs = 25;
    while (this.#dependencies.now() < deadline) {
      if (this.#stopRequested) {
        await this.#stopSpawnedChild();
        return this.#cancelledOutcome();
      }
      const daemon = await runDaemonPreflight(
        this.#options.preflight,
        this.#options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      );
      if (this.#stopRequested) {
        await this.#stopSpawnedChild();
        return this.#cancelledOutcome();
      }
      if (daemon.status === "connected") {
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
        this.#daemon = daemon;
        if (canonical.info.pid === childPid) {
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
            pid: childPid,
            instanceId: canonical.info.instanceId,
            startedAt: canonical.info.startedAt,
          };
          this.#phase = "owned";
        } else {
          await this.#stopSpawnedChild();
          this.#phase = "attached";
        }
        return {
          daemon,
          terminal: this.#phase === "owned" ? "owned" : "attached",
          failure: null,
        };
      }
      if (daemon.status === "degraded") {
        await this.#stopSpawnedChild();
        this.#daemon = daemon;
        this.#phase = "unavailable";
        return { daemon, terminal: "failed", failure: preflightFailure(daemon) };
      }
      if (this.#childExit) {
        const exit = this.#childExit;
        const current = await runDaemonPreflight(
          this.#options.preflight,
          this.#options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
        );
        this.#daemon = current;
        if (current.status === "connected") {
          this.#phase = "attached";
          return { daemon: current, terminal: "attached", failure: null };
        }
        this.#phase = "unavailable";
        return {
          daemon: current,
          terminal: "failed",
          failure: { kind: "child-exit", exitCode: exit.code, signal: exit.signal },
        };
      }
      await this.#dependencies.sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }

    await this.#stopSpawnedChild();
    const failure = startupTimeout(timeoutMs);
    this.#daemon = failure;
    this.#phase = "unavailable";
    return { daemon: failure, terminal: "failed", failure: { kind: "readiness-timeout" } };
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
