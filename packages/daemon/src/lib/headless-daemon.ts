import {
  canonicalDaemonUrl,
  inspectCanonicalDaemonInfo,
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
import { generateAuthToken } from "./auth-token.ts";

export interface HeadlessDaemonOptions {
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
  ) => Promise<DaemonIdentity | null>;
  readonly startEmbeddedDaemon: (opts: EmbeddedDaemonOptions) => Promise<EmbeddedDaemonHandle>;
  readonly writeStdout: (line: string) => void;
  readonly onSignal: (signal: NodeJS.Signals, listener: () => void) => void;
  readonly offSignal: (signal: NodeJS.Signals, listener: () => void) => void;
}

const defaultDependencies: HeadlessDaemonDependencies = {
  inspectCanonicalDaemonInfo,
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
  const identity = await deps.probeCanonicalDaemonIdentity(info);
  if (!identity) {
    throw new IdeError(
      `Canonical daemon PID ${info.pid} is alive but its identity endpoint is unavailable. ` +
        "Refusing takeover.",
      { code: "DAEMON_IDENTITY_UNAVAILABLE", exitCode: 1 },
    );
  }
  assertIdentityMatches(info, identity);
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
): Promise<CanonicalDaemonInfo | null> {
  const existing = deps.inspectCanonicalDaemonInfo();
  if (existing.status === "missing") return null;
  if (existing.status === "invalid") {
    if (await deps.isCanonicalDaemonRecordOwnerProvenDead(existing)) {
      // The process which wins the atomic startup claim removes stale state.
      return null;
    }
    throw new IdeError(
      `Canonical daemon metadata is ${existing.reason}: ${existing.detail}. ` +
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
      if (
        !(error instanceof IdeError) ||
        (error.code !== "DAEMON_IDENTITY_UNAVAILABLE" && error.code !== "DAEMON_UNHEALTHY")
      ) {
        throw error;
      }
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
  const port = parsePort(options.port);
  let handle: EmbeddedDaemonHandle | null = null;
  let signalRequested = false;
  const requestStop = (): void => {
    signalRequested = true;
    if (handle) void handle.stop().catch(() => undefined);
  };
  deps.onSignal("SIGINT", requestStop);
  deps.onSignal("SIGTERM", requestStop);
  try {
    const existing = await findLiveCanonicalDaemon(deps, options);
    if (existing) {
      emitStatus(deps, options.json === true, "already-running", existing);
      return "already-running";
    }

    for (let startAttempt = 0; startAttempt < 2 && !handle; startAttempt += 1) {
      try {
        handle = await deps.startEmbeddedDaemon({
          port,
          bindHostname: "127.0.0.1",
          // Persisted only in the owner-only daemon record. This capability is
          // independent from the remotely shared access token.
          authToken: null,
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
    const originalStop = handle.stop.bind(handle);
    const mutableHandle = handle as { stop: EmbeddedDaemonHandle["stop"] };
    mutableHandle.stop = async (stopOptions) => {
      try {
        await originalStop(stopOptions);
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
    try {
      await assertAttachableDaemon(deps, info, options);
    } catch (error) {
      await handle.stop().catch(() => undefined);
      if (signalRequested) {
        if (stopFailure) throw stopFailure;
        return "stopped";
      }
      throw error;
    }

    emitStatus(deps, options.json === true, "ready", info);
    await stopped;
    if (stopFailure) throw stopFailure;
    return "stopped";
  } finally {
    deps.offSignal("SIGINT", requestStop);
    deps.offSignal("SIGTERM", requestStop);
  }
}
