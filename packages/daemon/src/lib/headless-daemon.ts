import {
  clearCanonicalDaemonInfo,
  isCanonicalDaemonAlive,
  readCanonicalDaemonInfo,
  warnOnDaemonVersionSkew,
  type CanonicalDaemonInfo,
} from "./canonical-daemon.ts";
import {
  startEmbeddedDaemon,
  type EmbeddedDaemonHandle,
  type EmbeddedDaemonOptions,
} from "./daemon-embed.ts";
import { DaemonStartupError, IdeError } from "./errors.ts";

export interface HeadlessDaemonOptions {
  readonly port?: string | number;
  readonly json?: boolean;
  /** @internal Compatibility only for the retired per-session daemon entrypoint. */
  readonly sessionName?: string;
  /** Product version is diagnostic only; protocol compatibility is authoritative. */
  readonly expectedVersion?: string;
  /**
   * Supplied by the canonical wire contract. It must throw an IdeError when an
   * already-running daemon is not compatible with this client.
   */
  readonly assertCompatible?: (info: CanonicalDaemonInfo) => void;
}

export interface HeadlessDaemonDependencies {
  readonly readCanonicalDaemonInfo: () => CanonicalDaemonInfo | null;
  readonly clearCanonicalDaemonInfo: () => void;
  readonly isCanonicalDaemonAlive: (info: CanonicalDaemonInfo) => Promise<boolean>;
  readonly startEmbeddedDaemon: (opts: EmbeddedDaemonOptions) => Promise<EmbeddedDaemonHandle>;
  readonly writeStdout: (line: string) => void;
  readonly onSignal: (signal: NodeJS.Signals, listener: () => void) => void;
  readonly offSignal: (signal: NodeJS.Signals, listener: () => void) => void;
}

const defaultDependencies: HeadlessDaemonDependencies = {
  readCanonicalDaemonInfo,
  clearCanonicalDaemonInfo,
  isCanonicalDaemonAlive,
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
  const hostname = info.bindHostname === "0.0.0.0" ? "127.0.0.1" : info.bindHostname;
  const apiBaseUrl = `http://${hostname}:${info.port}`;
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

function assertExistingDaemon(info: CanonicalDaemonInfo, options: HeadlessDaemonOptions): void {
  options.assertCompatible?.(info);
  if (options.expectedVersion) warnOnDaemonVersionSkew(info, options.expectedVersion);
}

async function findLiveCanonicalDaemon(
  deps: HeadlessDaemonDependencies,
  options: HeadlessDaemonOptions,
): Promise<CanonicalDaemonInfo | null> {
  const existing = deps.readCanonicalDaemonInfo();
  if (!existing) return null;
  if (!(await deps.isCanonicalDaemonAlive(existing))) {
    deps.clearCanonicalDaemonInfo();
    return null;
  }
  assertExistingDaemon(existing, options);
  return existing;
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
  const existing = await findLiveCanonicalDaemon(deps, options);
  if (existing) {
    emitStatus(deps, options.json === true, "already-running", existing);
    return "already-running";
  }

  let handle: EmbeddedDaemonHandle;
  try {
    handle = await deps.startEmbeddedDaemon({
      port,
      bindHostname: "127.0.0.1",
      authToken: null,
      silent: true,
      ...(options.sessionName ? { sessionName: options.sessionName } : {}),
      ...(options.expectedVersion ? { productVersion: options.expectedVersion } : {}),
    });
  } catch (error) {
    // Another owner can become visible between our preflight and the embedded
    // daemon's guard. Re-resolve it as reuse; never request implicit takeover.
    if (error instanceof DaemonStartupError && error.reason === "canonical_already_running") {
      const winner = await findLiveCanonicalDaemon(deps, options);
      if (winner) {
        emitStatus(deps, options.json === true, "already-running", winner);
        return "already-running";
      }
    }
    throw error;
  }

  const info = deps.readCanonicalDaemonInfo();
  if (!info) {
    await handle.stop().catch(() => undefined);
    throw new IdeError("Canonical daemon started without publishing daemon.json", {
      code: "DAEMON_INFO_MISSING",
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

  const requestStop = (): void => {
    void handle.stop().catch(() => undefined);
  };
  deps.onSignal("SIGINT", requestStop);
  deps.onSignal("SIGTERM", requestStop);
  emitStatus(deps, options.json === true, "ready", info);
  try {
    await stopped;
  } finally {
    deps.offSignal("SIGINT", requestStop);
    deps.offSignal("SIGTERM", requestStop);
  }
  if (stopFailure) throw stopFailure;
  return "stopped";
}
