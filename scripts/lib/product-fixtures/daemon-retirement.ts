import { createConnection } from "node:net";
import { performance } from "node:perf_hooks";
import { processIsAlive } from "./harness-process.ts";

export interface DaemonRetirementIdentity {
  readonly instanceId: string;
  readonly pid: number;
  readonly port: number;
}

export function daemonPortRefusesConnections(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (refused: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(refused);
    };
    socket.setTimeout(100, () => finish(false));
    socket.once("connect", () => finish(false));
    socket.once("error", (error: NodeJS.ErrnoException) => finish(error.code === "ECONNREFUSED"));
  });
}

/** Call after stopping the owned daemon, before starting any replacement. */
export async function verifyDaemonRetirement(
  identity: DaemonRetirementIdentity,
  options: {
    readonly timeoutMs?: number;
    readonly processAlive?: (pid: number) => boolean;
    readonly portRefusesConnections?: (port: number) => Promise<boolean>;
  } = {},
) {
  const timeoutMs = options.timeoutMs ?? 2_000;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      identity.instanceId,
    ) ||
    !Number.isSafeInteger(identity.pid) ||
    identity.pid < 1 ||
    !Number.isSafeInteger(identity.port) ||
    identity.port < 1 ||
    identity.port > 65_535 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 5_000
  )
    throw new TypeError("Daemon retirement identity or deadline is invalid");
  const processAlive = options.processAlive ?? processIsAlive;
  const refuses = options.portRefusesConnections ?? daemonPortRefusesConnections;
  const start = performance.now();
  const deadline = start + timeoutMs;
  while (performance.now() < deadline) {
    if (
      !processAlive(identity.pid) &&
      (await refuses(identity.port)) &&
      !processAlive(identity.pid) &&
      performance.now() < deadline
    ) {
      return Object.freeze({
        generation: identity.instanceId,
        pid: identity.pid,
        port: identity.port,
        processAbsent: true as const,
        connectionRefused: true as const,
        elapsedMs: Math.ceil(performance.now() - start),
      });
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(25, Math.max(0, deadline - performance.now()))),
    );
  }
  throw new Error("The predecessor daemon process and listener did not retire before the deadline");
}
