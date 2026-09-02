import { randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { connect as connectTcp } from "node:net";
import { dirname } from "node:path";

import { CanonicalDaemonInfoSchema, type CanonicalDaemonInfo } from "@tmux-ide/contracts";

const MAX_RECORD_BYTES = 64 * 1024;

export interface GenerationGateway {
  readonly origin: string;
  readonly bearer: string;
  readonly stop: () => Promise<void>;
}

export interface GenerationGatewayExpectation {
  readonly protocolVersion: number;
  readonly productVersion: string;
  readonly environmentId?: string;
}

/**
 * Stable test/dev authority in front of a generation-changing local daemon.
 *
 * The browser-facing Vite gateway retains one unguessable bearer and one
 * origin. This hop securely rereads the isolated canonical record for every
 * HTTP request and WebSocket upgrade, replaces that bearer with the current
 * daemon owner token, and forwards only to the record's loopback endpoint.
 * Existing browser capabilities therefore survive daemon restarts without
 * ever learning a daemon token or port.
 */
export async function startGenerationGateway(
  daemonInfoPath: string,
  expected: GenerationGatewayExpectation,
): Promise<GenerationGateway> {
  const bearer = randomUUID();
  const server = createServer((incoming, response) => {
    if (!authorized(incoming.headers.authorization, bearer)) {
      response.writeHead(401, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ code: "generation_gateway_unauthorized" }));
      return;
    }
    let daemon: CanonicalDaemonInfo;
    try {
      daemon = trustedRecord(daemonInfoPath, expected);
    } catch {
      response.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ code: "canonical_daemon_unavailable" }));
      return;
    }
    const upstream = httpRequest({
      hostname: "127.0.0.1",
      port: daemon.port,
      method: incoming.method,
      path: incoming.url,
      headers: forwardedHeaders(incoming.headers, daemon),
    });
    upstream.on("response", (source) => {
      response.writeHead(source.statusCode ?? 502, source.headers);
      source.pipe(response);
    });
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    incoming.pipe(upstream);
  });

  server.on("upgrade", (incoming, downstream, head) => {
    if (!authorized(incoming.headers.authorization, bearer)) {
      downstream.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    let daemon: CanonicalDaemonInfo;
    try {
      daemon = trustedRecord(daemonInfoPath, expected);
    } catch {
      downstream.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = connectTcp(daemon.port, "127.0.0.1");
    upstream.once("connect", () => {
      const headers = forwardedHeaders(incoming.headers, daemon);
      upstream.write(`${incoming.method ?? "GET"} ${incoming.url ?? "/"} HTTP/1.1\r\n`);
      for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) continue;
        upstream.write(`${name}: ${Array.isArray(value) ? value.join(", ") : value}\r\n`);
      }
      upstream.write("\r\n");
      if (head.length > 0) upstream.write(head);
      downstream.pipe(upstream).pipe(downstream);
    });
    upstream.on("error", () => downstream.destroy());
    downstream.on("error", () => upstream.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("generation gateway did not bind");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    bearer,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function trustedRecord(path: string, expected: GenerationGatewayExpectation): CanonicalDaemonInfo {
  const parent = lstatSync(dirname(path));
  const pathStat = lstatSync(path);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    !pathStat.isFile() ||
    pathStat.isSymbolicLink() ||
    pathStat.size > MAX_RECORD_BYTES
  ) {
    throw new Error("canonical daemon publication is not a bounded regular file");
  }
  if (
    typeof process.getuid === "function" &&
    (parent.uid !== process.getuid() || pathStat.uid !== process.getuid())
  ) {
    throw new Error("canonical daemon publication has another owner");
  }
  if ((parent.mode & 0o077) !== 0 || (pathStat.mode & 0o077) !== 0) {
    throw new Error("canonical daemon publication permissions are unsafe");
  }
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let daemon: CanonicalDaemonInfo;
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== pathStat.dev ||
      opened.ino !== pathStat.ino ||
      opened.size !== pathStat.size ||
      opened.mtimeMs !== pathStat.mtimeMs ||
      (typeof process.getuid === "function" && opened.uid !== process.getuid()) ||
      (opened.mode & 0o077) !== 0
    ) {
      throw new Error("canonical daemon publication changed while opening");
    }
    daemon = CanonicalDaemonInfoSchema.parse(JSON.parse(readFileSync(descriptor, "utf8")));
  } finally {
    closeSync(descriptor);
  }
  if (daemon.bindHostname !== "127.0.0.1" || daemon.authToken === null) {
    throw new Error("canonical daemon record is not a local owner endpoint");
  }
  if (
    daemon.protocolVersion !== expected.protocolVersion ||
    daemon.productVersion !== expected.productVersion ||
    (expected.environmentId !== undefined && daemon.environmentId !== expected.environmentId)
  ) {
    throw new Error("canonical daemon record changed product or environment authority");
  }
  return daemon;
}

function forwardedHeaders(
  headers: IncomingHttpHeaders,
  daemon: CanonicalDaemonInfo,
): IncomingHttpHeaders {
  return {
    ...headers,
    host: `127.0.0.1:${daemon.port}`,
    authorization: `Bearer ${daemon.authToken}`,
    connection: headers.connection,
  };
}

function authorized(value: string | undefined, bearer: string): boolean {
  if (!value?.startsWith("Bearer ")) return false;
  const received = Buffer.from(value.slice("Bearer ".length));
  const expected = Buffer.from(bearer);
  return received.length === expected.length && timingSafeEqual(received, expected);
}
