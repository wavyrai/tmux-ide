import { assertCanonicalDaemonServerIntent } from "./canonical-daemon-bootstrap.ts";
import { resolveTmuxServerIntent } from "./runtime-namespace.ts";
import {
  canonicalDaemonUrl,
  matchesCanonicalDaemonPredecessor,
  type CanonicalDaemonPredecessor,
  getCanonicalDaemonInfoPath,
  prepareCanonicalDaemonInfoForBootstrap,
  isCanonicalDaemonAlive,
  isCanonicalDaemonRecordOwnerProvenDead,
  probeCanonicalDaemonHealth,
  probeCanonicalDaemonIdentity,
  warnOnDaemonVersionSkew,
  type CanonicalDaemonInfoState,
  type CanonicalDaemonInfo,
} from "./canonical-daemon.ts";
import {
  DAEMON_WIRE_PROTOCOL_VERSION,
  isDaemonWireProtocolCompatible,
  type DaemonHealth,
  type DaemonIdentity,
} from "@tmux-ide/contracts";
import {
  startEmbeddedDaemon,
  type EmbeddedDaemonHandle,
  type EmbeddedDaemonOptions,
} from "./daemon-embed.ts";
import { DaemonStartupError, IdeError } from "./errors.ts";
import { logger } from "./log.ts";
import { generateAuthToken } from "./auth-token.ts";
import type { DaemonRestartRequest } from "./daemon-restart-request.ts";

export interface HeadlessDaemonOptions {
  readonly tmuxServerIntent?: ReturnType<typeof resolveTmuxServerIntent>;
  readonly supervisionId?: string;
  /** Managed launch receipt, only after this process wins election and is attachable. */
  readonly onOwnedReady?: (info: CanonicalDaemonInfo) => void;
  readonly port?: string | number;
  readonly json?: boolean;
  /** @internal Compatibility only for the retired per-session daemon entrypoint. */
  readonly sessionName?: string;
  /** Product version is diagnostic only; protocol compatibility is authoritative. */
  readonly expectedVersion?: string;
}

export interface HeadlessDaemonDependencies {
  readonly inspectCanonicalDaemonInfo: () => CanonicalDaemonInfoState;
  readonly isCanonicalDaemonAlive: (info: CanonicalDaemonInfo) => Promise<boolean>;
  readonly isCanonicalDaemonRecordOwnerProvenDead: (
    state: Exclude<CanonicalDaemonInfoState, { status: "missing" }>,
  ) => Promise<boolean>;
  readonly probeCanonicalDaemonHealth: (info: CanonicalDaemonInfo) => Promise<DaemonHealth | null>;
  readonly probeCanonicalDaemonIdentity: (
    info: CanonicalDaemonInfo,
    signal?: AbortSignal,
    includeTmuxServerProof?: boolean,
  ) => Promise<DaemonIdentity | null>;
  readonly startEmbeddedDaemon: (opts: EmbeddedDaemonOptions) => Promise<EmbeddedDaemonHandle>;
  readonly writeStdout: (line: string) => void;
  readonly onSignal: (signal: NodeJS.Signals, listener: () => void) => void;
  readonly offSignal: (signal: NodeJS.Signals, listener: () => void) => void;
  /** Ends the process when a signalled stop misses its deadline. Defaults to process.exit. */
  readonly exit?: (code: number) => void;
  /** How long a signalled stop may go without progress. Defaults to SIGNAL_STOP_DEADLINE_MS. */
  readonly signalStopDeadlineMs?: number;
  /** How long a signalled stop may take in all. Defaults to SIGNAL_STOP_MAX_MS. */
  readonly signalStopMaxMs?: number;
}

/**
 * A SIGTERM or SIGINT is a promise to the supervisor that this process ends.
 * A teardown that has not finished by then is abandoned: the daemon says what
 * was still open, withdraws daemon.json and exits non-zero (#839).
 */
export const SIGNAL_STOP_DEADLINE_MS = 10_000;
/**
 * A slow stop that still completes teardown steps is not hung: each step that
 * settles renews the deadline, up to this total. It stays under the 30 s the
 * launchd and systemd units grant before they kill the process themselves.
 */
export const SIGNAL_STOP_MAX_MS = 25_000;
export const SIGNAL_STOP_TIMEOUT_EXIT_CODE = 1;

interface HeadlessLifecycle {
  restart?: DaemonRestartRequest;
  predecessor?: CanonicalDaemonPredecessor;
  generations: number;
  /** Why the next generation starts: "initial", or what retired the previous one. */
  startReason: string;
}

function activeResourceCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  try {
    for (const name of process.getActiveResourcesInfo()) counts[name] = (counts[name] ?? 0) + 1;
  } catch {
    /* Diagnostics only. */
  }
  return counts;
}

const defaultDependencies: HeadlessDaemonDependencies = {
  inspectCanonicalDaemonInfo: prepareCanonicalDaemonInfoForBootstrap,
  isCanonicalDaemonAlive,
  isCanonicalDaemonRecordOwnerProvenDead,
  probeCanonicalDaemonHealth,
  probeCanonicalDaemonIdentity,
  startEmbeddedDaemon,
  writeStdout: (line) => process.stdout.write(`${line}\n`),
  onSignal: (signal, listener) => process.on(signal, listener),
  offSignal: (signal, listener) => process.off(signal, listener),
};

function parsePort(value: string | number | undefined): number | undefined {
  if (value == null) return undefined;
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new IdeError(`Invalid daemon port: ${String(value)}`, {
      code: "USAGE",
      exitCode: 2,
    });
  }
  return port;
}

function emitStatus(
  deps: HeadlessDaemonDependencies,
  json: boolean,
  status: "ready" | "already-running",
  info: Pick<CanonicalDaemonInfo, "pid" | "port" | "bindHostname">,
): void {
  const apiBaseUrl = canonicalDaemonUrl("http", info.bindHostname, info.port);
  if (json) {
    deps.writeStdout(JSON.stringify({ status, pid: info.pid, port: info.port, apiBaseUrl }));
    return;
  }
  if (status === "already-running") {
    deps.writeStdout(`Canonical daemon already running: ${apiBaseUrl} (pid ${info.pid})`);
  } else {
    deps.writeStdout(`Canonical daemon ready: ${apiBaseUrl} (pid ${info.pid})`);
  }
}

function assertProtocolCompatible(info: CanonicalDaemonInfo, health: DaemonHealth): void {
  if (info.protocolVersion !== health.protocolVersion) {
    throw new IdeError(
      `Canonical daemon protocol disagreement: daemon.json reports ${info.protocolVersion}, ` +
        `/health reports ${health.protocolVersion}. Refusing takeover.`,
      { code: "DAEMON_PROTOCOL_MISMATCH", exitCode: 2 },
    );
  }
  if (!isDaemonWireProtocolCompatible(info.protocolVersion)) {
    throw new IdeError(
      `Canonical daemon protocol ${info.protocolVersion} is incompatible with ` +
        `this CLI (expected ${DAEMON_WIRE_PROTOCOL_VERSION}). Refusing takeover.`,
      { code: "DAEMON_PROTOCOL_MISMATCH", exitCode: 2 },
    );
  }
}

function assertIdentityMatches(info: CanonicalDaemonInfo, identity: DaemonIdentity): void {
  if (
    identity.instanceId !== info.instanceId ||
    identity.pid !== info.pid ||
    identity.protocolVersion !== info.protocolVersion ||
    identity.startedAt !== info.startedAt
  ) {
    throw new IdeError(
      "Canonical daemon identity probe does not match daemon.json. Refusing takeover or reuse.",
      { code: "DAEMON_IDENTITY_MISMATCH", exitCode: 2 },
    );
  }
  if (identity.productVersion !== info.productVersion) {
    console.warn(
      `[tmux-ide] canonical daemon product-version metadata differs: daemon.json reports ` +
        `"${info.productVersion}" but /identity reports "${identity.productVersion}". ` +
        `Product version is diagnostic; compatibility is governed by protocol and instance identity.`,
    );
  }
}

async function assertAttachableDaemon(
  deps: HeadlessDaemonDependencies,
  info: CanonicalDaemonInfo,
  options: HeadlessDaemonOptions,
): Promise<void> {
  const identity = await deps.probeCanonicalDaemonIdentity(
    info,
    undefined,
    Boolean(options.tmuxServerIntent),
  );
  if (!identity) {
    throw new IdeError(
      `Canonical daemon PID ${info.pid} is alive but its identity endpoint is unavailable. ` +
        "Refusing takeover.",
      { code: "DAEMON_IDENTITY_UNAVAILABLE", exitCode: 1 },
    );
  }
  assertIdentityMatches(info, identity);
  await assertCanonicalDaemonServerIntent(info, options.tmuxServerIntent ?? null, {
    identity: async () => identity,
  });
  const health = await deps.probeCanonicalDaemonHealth(info);
  if (!health) {
    throw new IdeError(
      `Canonical daemon PID ${info.pid} is alive but its health endpoint is unavailable. ` +
        `Refusing takeover.`,
      { code: "DAEMON_UNHEALTHY", exitCode: 1 },
    );
  }
  assertProtocolCompatible(info, health);
  if (options.expectedVersion) warnOnDaemonVersionSkew(info, options.expectedVersion);
  if (health.productVersion !== info.productVersion) {
    console.warn(
      `[tmux-ide] canonical daemon product-version metadata differs: daemon.json reports ` +
        `"${info.productVersion}" but /health reports "${health.productVersion}". ` +
        `Wire compatibility is governed independently by protocolVersion.`,
    );
  }
}

async function findLiveCanonicalDaemon(
  deps: HeadlessDaemonDependencies,
  options: HeadlessDaemonOptions,
  predecessor?: CanonicalDaemonPredecessor,
): Promise<CanonicalDaemonInfo | null> {
  const existing = deps.inspectCanonicalDaemonInfo();
  if (options.supervisionId) {
    const binding =
      existing.status === "reserved"
        ? existing.reservation.supervisionId
        : existing.status === "valid"
          ? existing.info.supervisionId
          : undefined;
    if (binding !== options.supervisionId)
      throw new IdeError("Matching supervisor reservation is required before startup", {
        code: "DAEMON_SUPERVISOR_RESERVATION_REQUIRED",
        exitCode: 1,
      });
    if (
      existing.status === "reserved" ||
      matchesCanonicalDaemonPredecessor(existing, predecessor, options.supervisionId)
    )
      return null;
  }
  if (existing.status === "missing") return null;
  if (existing.status === "invalid" || existing.status === "reserved") {
    if (await deps.isCanonicalDaemonRecordOwnerProvenDead(existing)) {
      // The process which wins the atomic startup claim removes stale state.
      return null;
    }
    throw new IdeError(
      `Canonical daemon metadata at ${getCanonicalDaemonInfoPath()} is ${existing.reason}. ` +
        (existing.recoveryDetail
          ? `Permission recovery refused: ${existing.recoveryDetail}. `
          : "") +
        "Its owner is not proven dead, so another daemon will not be started.",
      { code: "DAEMON_INFO_INVALID", exitCode: 1 },
    );
  }
  if (!(await deps.isCanonicalDaemonAlive(existing.info))) {
    // The process which wins the atomic startup claim removes stale state.
    return null;
  }
  await assertAttachableDaemon(deps, existing.info, options);
  return existing.info;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DAEMON_ATTACHABILITY_TIMEOUT_MS = 15_000;
const DAEMON_ATTACHABILITY_POLL_MS = 25;

function isTransientAttachabilityError(error: unknown): error is IdeError {
  return (
    error instanceof IdeError &&
    (error.code === "DAEMON_IDENTITY_UNAVAILABLE" || error.code === "DAEMON_UNHEALTHY")
  );
}

async function waitForAttachableDaemon(
  deps: HeadlessDaemonDependencies,
  info: CanonicalDaemonInfo,
  options: HeadlessDaemonOptions,
  timeoutMs = DAEMON_ATTACHABILITY_TIMEOUT_MS,
  shouldAbort: () => boolean = () => false,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await assertAttachableDaemon(deps, info, options);
      return;
    } catch (error) {
      if (!isTransientAttachabilityError(error)) throw error;
      if (shouldAbort() || Date.now() >= deadline) throw error;
    }
    await delay(DAEMON_ATTACHABILITY_POLL_MS);
  }
}

function publishedStartupGraceMs(state: CanonicalDaemonInfoState): number {
  if (state.status !== "valid") return 0;
  const startedAt = Date.parse(state.info.startedAt);
  if (!Number.isFinite(startedAt)) return 0;
  return Math.max(0, DAEMON_ATTACHABILITY_TIMEOUT_MS - Math.max(0, Date.now() - startedAt));
}

async function waitForCanonicalWinner(
  deps: HeadlessDaemonDependencies,
  options: HeadlessDaemonOptions,
  timeoutMs = 15_000,
): Promise<CanonicalDaemonInfo | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const winner = await findLiveCanonicalDaemon(deps, options);
      if (winner) return winner;
    } catch (error) {
      if (!isTransientAttachabilityError(error)) throw error;
      // The claim winner has published enough metadata to identify its PID but
      // has not completed the endpoint handshake yet.
    }
    await delay(25);
  }
  return null;
}

/**
 * Own the canonical daemon in the current foreground process.
 *
 * This function never forks. A desktop host should spawn the installed
 * executable with argv `["--headless"]`, wait for daemon.json + `/health`, and
 * retain the child as its daemon owner. SIGINT/SIGTERM and the daemon shutdown
 * action converge on the same idempotent EmbeddedDaemonHandle.stop() path.
 */
export async function runHeadlessDaemon(
  options: HeadlessDaemonOptions = {},
  deps: HeadlessDaemonDependencies = defaultDependencies,
): Promise<"stopped" | "already-running"> {
  options = {
    ...options,
    tmuxServerIntent:
      options.tmuxServerIntent === undefined ? resolveTmuxServerIntent() : options.tmuxServerIntent,
  };
  let restoreTmuxWorkspaces = false;
  const lifecycle: HeadlessLifecycle = { generations: 0, startReason: "initial" };
  while (true) {
    const result = await runHeadlessDaemonGeneration(
      options,
      deps,
      restoreTmuxWorkspaces,
      lifecycle,
    );
    if (result !== "restart") return result;
    restoreTmuxWorkspaces = true;
  }
}

async function runHeadlessDaemonGeneration(
  options: HeadlessDaemonOptions,
  deps: HeadlessDaemonDependencies,
  restoreTmuxWorkspaces: boolean,
  lifecycle: HeadlessLifecycle,
): Promise<"stopped" | "already-running" | "restart"> {
  const port = parsePort(lifecycle.restart?.port ?? options.port);
  const generation = (lifecycle.generations += 1);
  const startReason = lifecycle.startReason;
  const generationStartedAt = performance.now();
  let restartRequested = false;
  let stopStarted = false;
  let handle: EmbeddedDaemonHandle | null = null;
  let signalRequested = false;
  /** What asked this generation to retire; logged with the timings. */
  let retireTrigger: string | null = null;
  const deadlineMs = deps.signalStopDeadlineMs ?? SIGNAL_STOP_DEADLINE_MS;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let rejectDeadline!: (error: Error) => void;
  const deadlineExceeded = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  deadlineExceeded.catch(() => undefined);
  const maxMs = Math.max(deadlineMs, deps.signalStopMaxMs ?? SIGNAL_STOP_MAX_MS);
  let signalledAt = 0;
  let lastProgress = "";
  const readStop = () => {
    try {
      return handle?.stopDiagnostics?.() ?? null;
    } catch {
      return null; // Diagnostics never block the exit.
    }
  };
  const progressOf = (stop: ReturnType<typeof readStop>): string =>
    stop ? `${stop.completed.length}:${stop.stepsSettled}` : "";
  const stopDeadlineExceeded = (signal: NodeJS.Signals): void => {
    const stop = readStop();
    const waitedMs = Math.round(performance.now() - signalledAt);
    const progress = progressOf(stop);
    if (progress !== lastProgress && waitedMs + deadlineMs <= maxMs) {
      // Steps settled since the last look: slow, not hung. Give it another window.
      lastProgress = progress;
      deadlineTimer = setTimeout(() => stopDeadlineExceeded(signal), deadlineMs);
      return;
    }
    logger.error("daemon-lifecycle", "stop missed the signal deadline; exiting anyway", {
      signal,
      deadlineMs,
      maxMs,
      waitedMs,
      generation,
      startReason,
      generationInstanceId: handle?.instanceId ?? null,
      phase: !handle ? "starting" : stopStarted ? "stopping" : "running",
      stuckStage: stop?.stage ?? null,
      stuckStageMs: stop?.stageMs ?? null,
      openSteps: stop?.openSteps ?? [],
      stepsSettled: stop?.stepsSettled ?? 0,
      completedStages: stop?.completed ?? [],
      activeResources: activeResourceCounts(),
    });
    try {
      handle?.abandon?.();
    } catch {
      /* The exit below still ends the owner. */
    }
    (deps.exit ?? ((code: number) => process.exit(code)))(SIGNAL_STOP_TIMEOUT_EXIT_CODE);
    rejectDeadline(
      new IdeError(`Daemon stop did not finish within ${deadlineMs}ms of ${signal}`, {
        code: "DAEMON_STOP_TIMEOUT",
        exitCode: SIGNAL_STOP_TIMEOUT_EXIT_CODE,
      }),
    );
  };
  const requestStop = (signal: NodeJS.Signals): void => {
    signalRequested = true;
    retireTrigger ??= `signal:${signal}`;
    // Deliberately not unref'd: a hung teardown must not outlive the deadline.
    if (!deadlineTimer) {
      signalledAt = performance.now();
      lastProgress = progressOf(readStop());
      deadlineTimer = setTimeout(() => stopDeadlineExceeded(signal), deadlineMs);
    }
    if (handle) void handle.stop().catch(() => undefined);
  };
  const onSigint = (): void => requestStop("SIGINT");
  const onSigterm = (): void => requestStop("SIGTERM");
  deps.onSignal("SIGINT", onSigint);
  deps.onSignal("SIGTERM", onSigterm);
  const runGeneration = async (): Promise<"stopped" | "already-running" | "restart"> => {
    let existing: CanonicalDaemonInfo | null;
    try {
      existing = await findLiveCanonicalDaemon(deps, options, lifecycle.predecessor);
    } catch (error) {
      if (!isTransientAttachabilityError(error)) throw error;

      // A freshly published owner may still be starting its HTTP accept loop,
      // especially when many CLI bundles cold-start together. Give only that
      // young generation a bounded stabilization window; an older unhealthy
      // owner remains a fail-fast error and is never silently replaced.
      const startupGraceMs = publishedStartupGraceMs(deps.inspectCanonicalDaemonInfo());
      if (startupGraceMs <= 0) throw error;
      existing = await waitForCanonicalWinner(deps, options, startupGraceMs);
      if (!existing) {
        // Distinguish a winner which died during startup (safe to claim) from
        // one which remains alive but unavailable (must still be refused).
        existing = await findLiveCanonicalDaemon(deps, options, lifecycle.predecessor);
      }
    }
    if (existing) {
      emitStatus(deps, options.json === true, "already-running", existing);
      return "already-running";
    }

    for (let startAttempt = 0; startAttempt < 2 && !handle; startAttempt += 1) {
      try {
        handle = await deps.startEmbeddedDaemon({
          launcher: "headless",
          plugins: true,
          ...(options.supervisionId
            ? { supervisionId: options.supervisionId, predecessor: lifecycle.predecessor }
            : {}),
          ...(restoreTmuxWorkspaces ? { restoreTmuxWorkspaces: true } : {}),
          port,
          bindHostname: lifecycle.restart?.bindHostname ?? "127.0.0.1",
          // Persisted only in the owner-only daemon record. This capability is
          // independent from the remotely shared access token.
          authToken: lifecycle.restart?.token ?? null,
          requestRestart: async (request) => {
            if (!handle || stopStarted || signalRequested) return;
            lifecycle.restart = request;
            restartRequested = true;
            retireTrigger ??= `restart-request:${"kind" in request ? request.kind : "settings"}`;
            await handle.stop();
          },
          localBypassToken: generateAuthToken(),
          silent: true,
          ...(options.sessionName ? { sessionName: options.sessionName } : {}),
          ...(options.expectedVersion ? { productVersion: options.expectedVersion } : {}),
        });
      } catch (error) {
        // Another process may hold the complete startup claim before its
        // daemon.json and endpoints are visible. Wait for that exact winner;
        // if it dies before publication, retry the claim once.
        if (
          error instanceof DaemonStartupError &&
          (error.reason === "canonical_already_running" || error.reason === "canonical_claim_busy")
        ) {
          const winner = await waitForCanonicalWinner(deps, options);
          if (winner) {
            emitStatus(deps, options.json === true, "already-running", winner);
            return "already-running";
          }
          if (startAttempt === 0) continue;
        }
        throw error;
      }
    }
    if (!handle) {
      throw new IdeError("Canonical daemon startup claim did not produce an owner", {
        code: "DAEMON_STARTUP_TIMEOUT",
        exitCode: 1,
      });
    }

    let resolveStopped!: () => void;
    const stopped = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });
    let stopFailure: unknown;
    let ownedPublication: CanonicalDaemonPredecessor | undefined;
    const originalStop = handle.stop.bind(handle);
    const mutableHandle = handle as { stop: EmbeddedDaemonHandle["stop"] };
    mutableHandle.stop = async (stopOptions) => {
      if (!stopStarted) {
        retireTrigger ??= "stop-requested";
        // An ordinary stop is routine (debug); an in-place restart is not (info).
        logger[restartRequested && !signalRequested ? "info" : "debug"](
          "daemon-lifecycle",
          "generation retiring",
          {
            generation,
            generationInstanceId: handle?.instanceId ?? null,
            trigger: retireTrigger,
            uptimeMs: Math.round(performance.now() - generationStartedAt),
          },
        );
      }
      stopStarted = true;
      try {
        await originalStop(
          restartRequested && !signalRequested ? { ...stopOptions, restarting: true } : stopOptions,
        );
        if (restartRequested && !signalRequested && options.supervisionId && ownedPublication)
          lifecycle.predecessor = ownedPublication;
      } catch (error) {
        stopFailure = error;
        throw error;
      } finally {
        resolveStopped();
      }
    };

    if (signalRequested) {
      await handle.stop();
      if (stopFailure) throw stopFailure;
      return "stopped";
    }

    const published = deps.inspectCanonicalDaemonInfo();
    if (published.status !== "valid") {
      await handle.stop().catch(() => undefined);
      throw new IdeError("Canonical daemon started without publishing daemon.json", {
        code: "DAEMON_INFO_MISSING",
        exitCode: 1,
      });
    }
    const info = published.info;
    if (
      info.instanceId !== handle.instanceId ||
      info.pid !== handle.pid ||
      info.port !== handle.port
    ) {
      await handle.stop().catch(() => undefined);
      throw new IdeError("Started daemon handle does not own the canonical published instance", {
        code: "DAEMON_IDENTITY_MISMATCH",
        exitCode: 2,
      });
    }
    if (options.supervisionId && info.supervisionId !== options.supervisionId) {
      await handle.stop().catch(() => undefined);
      throw new IdeError("Published supervisor binding differs from startup", {
        code: "DAEMON_IDENTITY_MISMATCH",
        exitCode: 2,
      });
    }
    ownedPublication = structuredClone(published);
    lifecycle.predecessor = undefined;
    try {
      // Publication precedes the external handshake. Under CPU or module-load
      // contention, one 750ms loopback probe is not a sound reason for the
      // elected owner to tear itself down and trigger generation churn.
      await waitForAttachableDaemon(
        deps,
        info,
        options,
        DAEMON_ATTACHABILITY_TIMEOUT_MS,
        () => signalRequested,
      );
      options.onOwnedReady?.(info);
    } catch (error) {
      await handle.stop().catch(() => undefined);
      if (signalRequested) {
        if (stopFailure) throw stopFailure;
        return "stopped";
      }
      throw error;
    }

    emitStatus(deps, options.json === true, "ready", info);
    // The first generation already says so with its status line on stdout.
    logger[generation > 1 ? "info" : "debug"]("daemon-lifecycle", "generation ready", {
      generation,
      startReason,
      generationInstanceId: info.instanceId,
      port: info.port,
      startMs: Math.round(performance.now() - generationStartedAt),
    });
    let probing = false;
    const timer = handle.tmuxAuthorityReplaced
      ? setInterval(() => {
          if (probing || stopStarted) return;
          probing = true;
          void handle!.tmuxAuthorityReplaced!()
            .then((replaced) => {
              if (!replaced || stopStarted || signalRequested) return;
              restartRequested = true;
              retireTrigger ??= "tmux-authority-replaced";
              return handle!.stop();
            })
            .catch(() => undefined)
            .finally(() => {
              probing = false;
            });
        }, 1_000)
      : null;
    timer?.unref();
    try {
      await stopped;
    } finally {
      if (timer) clearInterval(timer);
    }
    if (stopFailure) throw stopFailure;
    const outcome = restartRequested && !signalRequested ? "restart" : "stopped";
    if (outcome === "restart") lifecycle.startReason = retireTrigger ?? "restart";
    return outcome;
  };
  try {
    return await Promise.race([runGeneration(), deadlineExceeded]);
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    deps.offSignal("SIGINT", onSigint);
    deps.offSignal("SIGTERM", onSigterm);
  }
}
