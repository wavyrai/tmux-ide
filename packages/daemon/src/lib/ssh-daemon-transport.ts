import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import type { Readable } from "node:stream";
import { z } from "zod";
import {
  CanonicalDaemonInfoSchema,
  DAEMON_WIRE_PROTOCOL_VERSION,
  DaemonIdentitySchema,
  SavedMachineSchema,
  DesktopDaemonCapabilitiesResultSchemaZ,
} from "@tmux-ide/contracts";

/** The remote CLI emits this over SSH stdout; it must never be logged or persisted. */
export const RemoteDaemonHandshakeSchema = z
  .object({
    version: z.literal(1),
    daemon: CanonicalDaemonInfoSchema.strict().extend({
      bindHostname: z.enum(["127.0.0.1", "localhost", "::1", "0.0.0.0", "::"]),
      authToken: z.string().min(1).max(4096),
    }),
  })
  .strict();
export type RemoteDaemonHandshake = z.infer<typeof RemoteDaemonHandshakeSchema>;
type RemoteDaemon = RemoteDaemonHandshake["daemon"];
export type SshTransportChild = Pick<ChildProcess, "once" | "kill" | "exitCode" | "signalCode"> & {
  stdout: Readable | null;
  stderr: Readable | null;
};
export interface SshDaemonTransportDependencies {
  spawn(args: string[]): SshTransportChild;
  allocatePort(): Promise<number>;
  /** Must authenticate and compare the complete expected daemon identity. */
  probe(baseUrl: string, daemon: RemoteDaemon, signal: AbortSignal): Promise<boolean>;
}

class SshConnectionError extends Error {}
function failure(message: string): Error {
  return new SshConnectionError(`SSH daemon connection: ${message}`);
}
const stoppedChildren = new WeakSet<SshTransportChild>();
function stop(child: SshTransportChild): void {
  if (stoppedChildren.has(child) || child.exitCode !== null || child.signalCode !== null) return;
  stoppedChildren.add(child);
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 250);
  timer.unref();
  child.once("close", () => clearTimeout(timer));
}
async function allocatePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(failure("could not allocate local port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 32 * 1024) throw failure("identity response exceeded limit");
      chunks.push(next.value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function probeSshDaemonIdentity(
  baseUrl: string,
  daemon: RemoteDaemon,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<boolean> {
  const matches = (actual: {
    instanceId: string;
    startedAt: string;
    protocolVersion: number;
    productVersion: string;
    environmentId?: string;
  }) =>
    actual.instanceId === daemon.instanceId &&
    actual.startedAt === daemon.startedAt &&
    actual.protocolVersion === daemon.protocolVersion &&
    actual.productVersion === daemon.productVersion &&
    actual.environmentId === daemon.environmentId;
  // Port allocation necessarily releases its reservation before ssh binds. Never send a bearer
  // credential until the listener proves the nonce obtained over authenticated SSH.
  const identity = DaemonIdentitySchema.safeParse(
    await boundedJson(await request(`${baseUrl}/identity`, { signal, redirect: "error" })),
  );
  if (!identity.success || identity.data.pid !== daemon.pid || !matches(identity.data))
    return false;
  const response = await request(`${baseUrl}/api/v2/capabilities`, {
    method: "POST",
    headers: { Authorization: `Bearer ${daemon.authToken}`, "Content-Type": "application/json" },
    body: "{}",
    signal,
    redirect: "error",
  });
  const parsed = DesktopDaemonCapabilitiesResultSchemaZ.safeParse(await boundedJson(response));
  return parsed.success && parsed.data.status === "ok" && matches(parsed.data.daemon);
}
function cancellable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(failure("cancelled or timed out"));
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

const defaults: SshDaemonTransportDependencies = {
  spawn: (args) => spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] }),
  allocatePort,
  probe: probeSshDaemonIdentity,
};
function discover(child: SshTransportChild, signal: AbortSignal): Promise<RemoteDaemon> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error, daemon?: RemoteDaemon) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      chunks.length = 0;
      if (error) {
        stop(child);
        reject(error);
      } else resolve(daemon!);
    };
    const abort = () => finish(failure("cancelled or timed out"));
    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > 32 * 1024) {
        finish(failure("discovery response exceeded limit"));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    // Drain without capturing: SSH banners/errors may contain confidential remote information.
    child.stderr?.resume();
    child.once("error", () => finish(failure("could not start OpenSSH")));
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(
          failure(
            "discovery failed; check SSH authentication, host trust, and remote tmux-ide installation",
          ),
        );
        return;
      }
      try {
        const parsed = RemoteDaemonHandshakeSchema.parse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))),
        );
        if (parsed.daemon.protocolVersion !== DAEMON_WIRE_PROTOCOL_VERSION) throw new Error();
        finish(undefined, parsed.daemon);
      } catch {
        finish(failure("invalid or incompatible remote daemon descriptor"));
      }
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
function delay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, 50);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}

/** Owns only its two OpenSSH subprocesses, never remote daemon lifetime. */
export async function openSshDaemonTransport(
  options: { alias: string; signal?: AbortSignal; timeoutMs?: number },
  dependencies: SshDaemonTransportDependencies = defaults,
): Promise<{ daemon: RemoteDaemon; baseUrl: string; closed: Promise<void>; dispose(): void }> {
  if (!SavedMachineSchema.shape.sshTarget.safeParse(options.alias).success) {
    throw failure("invalid SSH destination");
  }
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    throw failure("invalid timeout");
  const controller = new AbortController();
  const abort = () => controller.abort();
  const signal = controller.signal;
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  let child: SshTransportChild | undefined;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    controller.abort();
    if (child) stop(child);
  };
  signal.addEventListener("abort", dispose, { once: true });
  try {
    if (signal.aborted) throw failure("cancelled or timed out");
    child = dependencies.spawn([
      "-T",
      "-o",
      "BatchMode=yes",
      "--",
      options.alias,
      "tmux-ide",
      "remote-daemon-info",
      "--json",
    ]);
    const daemon = await discover(child, signal);
    const port = await cancellable(dependencies.allocatePort(), signal);
    if (signal.aborted) throw failure("cancelled or timed out");
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw failure("invalid local port");
    const host =
      daemon.bindHostname === "::" || daemon.bindHostname === "::1"
        ? "[::1]"
        : daemon.bindHostname === "localhost"
          ? "localhost"
          : "127.0.0.1";
    child = dependencies.spawn([
      "-N",
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-L",
      `127.0.0.1:${port}:${host}:${daemon.port}`,
      "--",
      options.alias,
    ]);
    child.stdout?.resume();
    child.stderr?.resume();
    child.once("exit", dispose);
    const closed = new Promise<void>((resolve) => {
      child!.once("close", () => {
        dispose();
        resolve();
      });
      child!.once("error", () => {
        dispose();
        resolve();
      });
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    while (!signal.aborted) {
      try {
        if (await cancellable(dependencies.probe(baseUrl, daemon, signal), signal)) {
          if (signal.aborted || child.exitCode !== null || child.signalCode !== null) break;
          clearTimeout(timer);
          return { daemon, baseUrl, closed, dispose };
        }
      } catch {
        /* Retry bounded by the shared deadline, never expose token-bearing errors. */
      }
      await delay(signal);
    }
    throw failure(
      "tunnel could not authenticate the expected daemon before cancellation or timeout",
    );
  } catch (error) {
    dispose();
    // Only our fixed messages may cross the boundary; spawn/probe failures can contain secrets.
    if (error instanceof SshConnectionError) throw error;
    throw failure("could not establish transport");
  }
}
