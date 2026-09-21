/** SSH-owned HTTP/upgrade relay. Credentials only cross a TCP connection whose identity matched. */
import {
  Agent,
  createServer,
  request,
  type ClientRequest,
  type ClientRequestArgs,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";
import { DaemonIdentitySchema, type DaemonIdentity } from "@tmux-ide/contracts";

export interface SshDaemonRelayOptions {
  upstreamPort: number;
  expected: DaemonIdentity;
  signal?: AbortSignal;
  probeTimeoutMs?: number;
  maxPending?: number;
  maxConnections?: number;
}
export interface SshDaemonRelay {
  baseUrl: string;
  closed: Promise<void>;
  dispose(): void;
}
const refused = () => new Error("SSH daemon relay unavailable");
class IdentityMismatch extends Error {}

/** One actual dial, even when an idle connection closes just before the next request. */
class VerifiedConnectionAgent extends Agent {
  socket: Duplex | null = null;
  private dialed = false;
  constructor(private readonly retain: (socket: Duplex) => void) {
    super({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  }
  override createConnection(
    options: ClientRequestArgs,
    callback?: (error: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    if (this.dialed) {
      queueMicrotask(() => callback?.(refused(), undefined!));
      return undefined;
    }
    this.dialed = true;
    const socket = super.createConnection(options, callback);
    if (socket) {
      this.socket = socket;
      this.retain(socket);
    }
    return socket;
  }
}
interface Lease {
  agent: VerifiedConnectionAgent;
  controller: AbortController;
  ready: Promise<void>;
  requests: Set<ClientRequest>;
  retired: boolean;
  admitted: number;
}
const bounded = (value: number | undefined, fallback: number, maximum: number) => {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw refused();
  return result;
};
function headers(source: IncomingHttpHeaders, upgrade = false): OutgoingHttpHeaders {
  const omit = new Set([
    "connection",
    "keep-alive",
    "proxy-connection",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    ...(source.connection ?? "").split(",").map((v) => v.trim().toLowerCase()),
  ]);
  const result: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(source)) if (!omit.has(name)) result[name] = value;
  if (upgrade) {
    result.connection = "Upgrade";
    result.upgrade = source.upgrade;
  }
  return result;
}
function sameIdentity(actual: DaemonIdentity, expected: DaemonIdentity): boolean {
  return (
    actual.pid === expected.pid &&
    actual.instanceId === expected.instanceId &&
    actual.startedAt === expected.startedAt &&
    actual.protocolVersion === expected.protocolVersion &&
    actual.productVersion === expected.productVersion &&
    actual.environmentId === expected.environmentId
  );
}

export async function createSshDaemonRelay(
  options: SshDaemonRelayOptions,
): Promise<SshDaemonRelay> {
  const upstreamPort = bounded(options.upstreamPort, 0, 65535);
  const expected = DaemonIdentitySchema.parse(options.expected);
  const probeTimeout = bounded(options.probeTimeoutMs, 1500, 15000);
  const maxPending = bounded(options.maxPending, 32, 1024);
  const maxConnections = bounded(options.maxConnections, 1024, 4096);
  const sockets = new Set<Duplex>();
  const clients = new Set<Duplex>();
  const leases = new Map<Duplex, Lease>();
  const requests = new Set<ClientRequest>();
  let disposed = false,
    starting = false,
    listenerClosed = false,
    pending = 0,
    admitted = 0;
  let finish!: () => void;
  const closed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const maybeClosed = () => {
    if (disposed && listenerClosed && sockets.size === 0 && pending === 0 && requests.size === 0)
      finish();
  };
  const retain = (socket: Duplex) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => {
      sockets.delete(socket);
      maybeClosed();
    });
    if (disposed) socket.destroy();
  };
  const retire = (lease: Lease) => {
    if (lease.retired) return;
    lease.retired = true;
    lease.controller.abort();
    for (const req of lease.requests) req.destroy();
    lease.agent.socket?.destroy();
    lease.agent.destroy();
  };
  const server = createServer({ maxHeaderSize: 16 * 1024 });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    options.signal?.removeEventListener("abort", dispose);
    for (const lease of leases.values()) retire(lease);
    for (const req of requests) req.destroy();
    for (const socket of sockets) socket.destroy();
    if (server.listening || starting)
      server.close(() => {
        listenerClosed = true;
        maybeClosed();
      });
    else {
      listenerClosed = true;
      maybeClosed();
    }
  };
  const ownRequest = (lease: Lease, req: ClientRequest) => {
    requests.add(req);
    lease.requests.add(req);
    req.once("close", () => {
      requests.delete(req);
      lease.requests.delete(req);
      maybeClosed();
    });
    return req;
  };
  const authenticate = async (lease: Lease) => {
    const timer = setTimeout(() => lease.controller.abort(), probeTimeout);
    try {
      const actual = await new Promise<DaemonIdentity>((resolve, reject) => {
        const req = ownRequest(
          lease,
          request(
            {
              hostname: "127.0.0.1",
              port: upstreamPort,
              path: "/identity",
              method: "GET",
              headers: { accept: "application/json", connection: "keep-alive" },
              agent: lease.agent,
              signal: lease.controller.signal,
            },
            (response) => {
              const chunks: Buffer[] = [];
              let bytes = 0;
              response.on("error", reject);
              response.on("data", (chunk: Buffer) => {
                bytes += chunk.length;
                if (bytes > 32 * 1024) {
                  req.destroy(refused());
                  return;
                }
                chunks.push(chunk);
              });
              response.once("end", () => {
                try {
                  if (
                    response.statusCode !== 200 ||
                    !response.complete ||
                    response.headers.connection === "close"
                  )
                    throw refused();
                  resolve(
                    DaemonIdentitySchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))),
                  );
                } catch {
                  reject(refused());
                }
              });
            },
          ),
        );
        req.once("error", reject);
        req.end();
      });
      if (!sameIdentity(actual, expected)) throw new IdentityMismatch();
      // Let normal Agent bookkeeping finish. Do not detach its parser or idle-data guard.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (
        lease.retired ||
        lease.controller.signal.aborted ||
        !lease.agent.socket ||
        lease.agent.socket.destroyed ||
        lease.agent.socket.readableLength !== 0
      )
        throw refused();
    } finally {
      clearTimeout(timer);
    }
  };
  const admission = (client: Duplex): Lease => {
    const existing = leases.get(client);
    if (existing) return existing;
    if (disposed || pending >= maxPending) throw refused();
    const lease: Lease = {
      agent: new VerifiedConnectionAgent(retain),
      controller: new AbortController(),
      ready: Promise.resolve(),
      requests: new Set(),
      retired: false,
      admitted: 0,
    };
    leases.set(client, lease);
    pending++;
    client.once("close", () => {
      retire(lease);
      leases.delete(client);
    });
    lease.ready = authenticate(lease)
      .catch((error: unknown) => {
        retire(lease);
        if (error instanceof IdentityMismatch) dispose();
        throw refused();
      })
      .finally(() => {
        pending--;
        maybeClosed();
      });
    return lease;
  };
  const prepare = async (
    incoming: IncomingMessage,
    lifetime: ServerResponse | Duplex,
  ): Promise<Lease> => {
    if (!incoming.url?.startsWith("/") || incoming.url.startsWith("//")) throw refused();
    const lease = admission(incoming.socket);
    // Reserve before awaiting identity: zero-body pipelined requests are parsed even while paused.
    if (lease.admitted >= 32 || admitted >= 2048) {
      incoming.socket.destroy();
      throw refused();
    }
    lease.admitted++;
    admitted++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      lease.admitted--;
      admitted--;
      lifetime.removeListener("close", release);
    };
    lifetime.once("close", release);
    try {
      await lease.ready;
      if (disposed || lease.retired || incoming.socket.destroyed || released) throw refused();
      return lease;
    } catch {
      release();
      throw refused();
    }
  };
  const forward = (incoming: IncomingMessage, lease: Lease, upgrade: boolean) =>
    ownRequest(
      lease,
      request({
        hostname: "127.0.0.1",
        port: upstreamPort,
        path: incoming.url,
        method: incoming.method,
        headers: headers(incoming.headers, upgrade),
        agent: lease.agent,
      }),
    );
  const rejectResponse = (response: ServerResponse) => {
    if (response.headersSent) response.destroy();
    else {
      response.writeHead(503, { connection: "close", "content-length": "0" });
      response.end();
    }
  };
  server.on("connection", (socket) => {
    if (disposed || clients.size >= maxConnections) {
      socket.destroy();
      return;
    }
    clients.add(socket);
    socket.once("close", () => clients.delete(socket));
    retain(socket);
  });
  server.on("error", dispose);
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("connect", (_request, socket) => socket.destroy());
  server.on("request", (incoming, response) => {
    incoming.pause();
    void prepare(incoming, response)
      .then(
        (lease) => {
          const outgoing = forward(incoming, lease, false);
          const cancel = () => outgoing.destroy();
          incoming.once("aborted", cancel);
          response.once("close", () => {
            if (!response.writableFinished) cancel();
          });
          outgoing.once("error", () => rejectResponse(response));
          outgoing.once("socket", (socket) => {
            if (lease.retired || socket !== lease.agent.socket || socket.destroyed) {
              outgoing.destroy(refused());
              return;
            }
            incoming.pipe(outgoing);
          });
          outgoing.once("response", (upstream) => {
            upstream.once("error", () => response.destroy());
            const responseHeaders = headers(upstream.headers);
            if (upstream.headers.connection === "close") responseHeaders.connection = "close";
            response.writeHead(upstream.statusCode ?? 502, responseHeaders);
            upstream.pipe(response);
          });
        },
        () => rejectResponse(response),
      )
      .catch(() => rejectResponse(response));
  });
  server.on("upgrade", (incoming, client, head) => {
    client.pause();
    if (head.length > 64 * 1024) {
      client.destroy();
      return;
    }
    void prepare(incoming, client)
      .then(
        (lease) => {
          const outgoing = forward(incoming, lease, true);
          outgoing.once("error", () => client.destroy());
          outgoing.once("socket", (socket) => {
            if (lease.retired || socket !== lease.agent.socket || socket.destroyed) {
              outgoing.destroy(refused());
              return;
            }
            outgoing.end();
          });
          outgoing.once("response", (upstream) => {
            upstream.destroy();
            client.destroy();
          });
          outgoing.once("upgrade", (upstream, socket, upstreamHead) => {
            if (lease.retired || socket !== lease.agent.socket || upstream.statusCode !== 101) {
              socket.destroy();
              client.destroy();
              return;
            }
            const accepted = headers(upstream.headers, true);
            const lines = Object.entries(accepted).flatMap(([name, value]) =>
              (Array.isArray(value) ? value : [value])
                .filter((v) => v !== undefined)
                .map((v) => `${name}: ${v}\r\n`),
            );
            client.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join("")}\r\n`);
            if (upstreamHead.length) client.write(upstreamHead);
            if (head.length) socket.write(head);
            socket.once("close", () => client.destroy());
            client.once("close", () => socket.destroy());
            socket.pipe(client).pipe(socket);
            socket.resume();
            client.resume();
          });
        },
        () => client.destroy(),
      )
      .catch(() => client.destroy());
  });
  options.signal?.addEventListener("abort", dispose, { once: true });
  if (options.signal?.aborted) {
    dispose();
    throw refused();
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const cancelled = () => done(refused());
      const done = (error?: Error) => {
        options.signal?.removeEventListener("abort", cancelled);
        server.removeListener("error", done);
        if (error) reject(error);
        else resolve();
      };
      server.once("error", done);
      options.signal?.addEventListener("abort", cancelled, { once: true });
      starting = true;
      server.listen(0, "127.0.0.1", () => {
        starting = false;
        done();
      });
    });
    if (disposed) {
      server.close();
      throw refused();
    }
    const address = server.address();
    if (!address || typeof address === "string") throw refused();
    return { baseUrl: `http://127.0.0.1:${address.port}`, closed, dispose };
  } catch {
    dispose();
    throw refused();
  }
}
