import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";

import type { CanonicalDaemonInfo, DesktopDaemonHostState } from "@tmux-ide/contracts";

import {
  canonicalDaemonClaimAllowsStartupAttempt,
  inspectCanonicalDaemonInfo,
  isCanonicalDaemonRecordOwnerProvenDead,
  type CanonicalDaemonInfoState,
} from "../../../packages/daemon/src/canonical.ts";
import { runDaemonPreflight, type DaemonPreflight } from "./daemon-preflight.ts";

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

export interface DesktopDaemonSupervisorSnapshot {
  readonly phase:
    | "idle"
    | "attached"
    | "starting"
    | "owned"
    | "unavailable"
    | "crashed"
    | "stopped";
  readonly daemon: DesktopDaemonHostState | null;
  readonly ownedGeneration: OwnedDaemonGeneration | null;
  readonly child: DaemonChildDiagnostics | null;
}

export interface DesktopDaemonSupervisorOptions {
  readonly preflight: DaemonPreflight;
  readonly childEntryPath: string;
  readonly productVersion: string;
  readonly startupTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly probeTimeoutMs?: number;
  readonly onOwnedDaemonCrash?: (snapshot: DesktopDaemonSupervisorSnapshot) => void;
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
}

interface ChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
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
 */
export class DesktopDaemonSupervisor {
  readonly #options: DesktopDaemonSupervisorOptions;
  readonly #dependencies: DesktopDaemonSupervisorDependencies;
  readonly #stdout = new BoundedStreamCapture();
  readonly #stderr = new BoundedStreamCapture();

  #phase: DesktopDaemonSupervisorSnapshot["phase"] = "idle";
  #daemon: DesktopDaemonHostState | null = null;
  #ownedGeneration: OwnedDaemonGeneration | null = null;
  #child: SpawnedDaemonChild | null = null;
  #childExit: ChildExit | null = null;
  #childExitPromise: Promise<ChildExit> | null = null;
  #expectedStop = false;
  #startPromise: Promise<DesktopDaemonHostState> | null = null;
  #stopPromise: Promise<void> | null = null;

  constructor(
    options: DesktopDaemonSupervisorOptions,
    dependencies: Partial<DesktopDaemonSupervisorDependencies> = {},
  ) {
    this.#options = options;
    this.#dependencies = { ...defaultDependencies, ...dependencies };
  }

  start(): Promise<DesktopDaemonHostState> {
    if (!this.#startPromise) this.#startPromise = this.#start();
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
    };
  }

  stopOwned(): Promise<void> {
    if (!this.#stopPromise) this.#stopPromise = this.#stopOwned();
    return this.#stopPromise;
  }

  async #start(): Promise<DesktopDaemonHostState> {
    const initial = await runDaemonPreflight(
      this.#options.preflight,
      this.#options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    );
    this.#daemon = initial;
    if (initial.status === "connected") {
      this.#phase = "attached";
      return initial;
    }
    if (
      initial.status === "degraded" ||
      (initial.code !== "record-missing" && initial.code !== "process-not-running")
    ) {
      this.#phase = "unavailable";
      return initial;
    }

    const spawnIsSafe = await this.#spawnIsSafe(initial.code);
    if (!spawnIsSafe) {
      const current = await runDaemonPreflight(
        this.#options.preflight,
        this.#options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      );
      this.#daemon = current;
      this.#phase = current.status === "connected" ? "attached" : "unavailable";
      return current;
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
      return failure;
    }
    this.#child = child;
    this.#phase = "starting";
    child.stdout.on("data", (chunk: string | Buffer) => this.#stdout.append(chunk));
    child.stderr.on("data", (chunk: string | Buffer) => this.#stderr.append(chunk));
    this.#childExitPromise = new Promise<ChildExit>((resolve) => {
      let settled = false;
      const finish = (exit: ChildExit): void => {
        if (settled) return;
        settled = true;
        this.#childExit = exit;
        resolve(exit);
        this.#onChildExit(exit);
      };
      child.once("exit", (code, signal) => finish({ code, signal }));
      child.once("error", () => finish({ code: null, signal: null }));
    });
    if (!Number.isInteger(child.pid) || (child.pid ?? 0) < 1) {
      await this.#stopSpawnedChild();
      const failure = startupFailure("The bundled daemon process did not publish a process ID.");
      this.#daemon = failure;
      this.#phase = "unavailable";
      return failure;
    }

    return this.#waitUntilReady(child.pid!);
  }

  async #spawnIsSafe(code: "record-missing" | "process-not-running"): Promise<boolean> {
    if (!this.#dependencies.claimAllowsStartupAttempt()) return false;
    const current = this.#dependencies.inspectCanonical();
    if (code === "record-missing") return current.status === "missing";
    if (current.status !== "valid") return false;
    return this.#dependencies.ownerProvenDead(current);
  }

  async #waitUntilReady(childPid: number): Promise<DesktopDaemonHostState> {
    const timeoutMs = this.#options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    const deadline = this.#dependencies.now() + timeoutMs;
    let backoffMs = 25;
    while (this.#dependencies.now() < deadline) {
      const daemon = await runDaemonPreflight(
        this.#options.preflight,
        this.#options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      );
      if (daemon.status === "connected") {
        const canonical = this.#dependencies.inspectCanonical();
        if (canonical.status !== "valid" || !canonicalMatchesDaemon(canonical.info, daemon)) {
          await this.#stopSpawnedChild();
          const failure = startupFailure(
            "Canonical daemon identity changed during the desktop readiness barrier.",
          );
          this.#daemon = failure;
          this.#phase = "unavailable";
          return failure;
        }
        this.#daemon = daemon;
        if (canonical.info.pid === childPid) {
          if (this.#childExit) {
            const failure: DesktopDaemonHostState = {
              status: "unavailable",
              code: "process-not-running",
              reason: "The bundled daemon exited during the desktop readiness barrier.",
            };
            this.#daemon = failure;
            this.#phase = "unavailable";
            return failure;
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
        return daemon;
      }
      if (daemon.status === "degraded") {
        await this.#stopSpawnedChild();
        this.#daemon = daemon;
        this.#phase = "unavailable";
        return daemon;
      }
      if (this.#childExit) {
        const current = await runDaemonPreflight(
          this.#options.preflight,
          this.#options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
        );
        this.#daemon = current;
        this.#phase = current.status === "connected" ? "attached" : "unavailable";
        return current;
      }
      await this.#dependencies.sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }

    await this.#stopSpawnedChild();
    const failure = startupTimeout(timeoutMs);
    this.#daemon = failure;
    this.#phase = "unavailable";
    return failure;
  }

  async #stopOwned(): Promise<void> {
    this.#expectedStop = true;
    if (!this.#ownedGeneration || !this.#child) {
      this.#phase = "stopped";
      return;
    }
    await this.#stopSpawnedChild();
    this.#ownedGeneration = null;
    this.#phase = "stopped";
  }

  async #stopSpawnedChild(): Promise<void> {
    const child = this.#child;
    const exit = this.#childExitPromise;
    if (!child || !exit || this.#childExit) return;
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

  #onChildExit(exit: ChildExit): void {
    if (this.#expectedStop || this.#phase !== "owned" || !this.#ownedGeneration) return;
    this.#phase = "crashed";
    this.#daemon = startupFailure(
      `The owned daemon process exited unexpectedly${
        exit.signal ? ` after ${exit.signal}` : ` with code ${exit.code ?? "unknown"}`
      }.`,
    );
    this.#options.onOwnedDaemonCrash?.(this.snapshot());
  }
}

export type { SpawnedDaemonChild };
