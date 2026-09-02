import { randomUUID } from "node:crypto";
import { createReadStream, lstatSync, readFileSync, realpathSync } from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { connect as connectTcp, type Socket } from "node:net";
import { extname, resolve, sep } from "node:path";

import type { CanonicalDaemonInfo } from "@tmux-ide/contracts";
import { ensureCanonicalDaemon } from "../../../packages/daemon/src/lib/canonical-daemon-bootstrap.ts";
import { getCanonicalDaemonInfoPath } from "../../../packages/daemon/src/lib/canonical-daemon.ts";
import { consumeDevelopmentWebSocketSession } from "../src/runtime/dev-web-host-config.ts";
import { openSelectedDevelopmentProject } from "./dev-native-folder-host.ts";
import { startGenerationGateway, type GenerationGateway } from "./generation-gateway.ts";

const DOCUMENT_SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
const DOCUMENT_SESSION_LIMIT = 128;
const MAX_PROXY_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_PROXY_REQUEST_BYTES = 16 * 1024 * 1024;

const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "style-src-elem 'self' 'unsafe-inline'",
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join("; "),
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});

type DocumentSession = {
  readonly hostClientId: string;
  readonly expiresAt: number;
};

export interface ProductionWebServerOptions {
  readonly staticRoot: string;
  readonly cliEntryPath: string;
  readonly cwd?: string;
  readonly port?: number;
  readonly gateway?: GenerationGateway;
  readonly daemonInfoPath?: string;
  readonly ensureDaemon?: () => Promise<{ readonly candidate: CanonicalDaemonInfo }>;
  readonly openProject?: typeof openSelectedDevelopmentProject;
}

export interface ProductionWebServer {
  readonly url: string;
  readonly stop: () => Promise<void>;
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

function exactOrigin(request: IncomingMessage, origin: string): boolean {
  return request.headers.origin === origin;
}

function mimeType(path: string): string {
  switch (extname(path)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

function safeStaticFile(staticRoot: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const root = realpathSync(staticRoot);
  const candidate = resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null;
  let stat;
  let canonical;
  try {
    stat = lstatSync(candidate);
    canonical = realpathSync(candidate);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  // `candidate` may contain an intermediate directory symlink even when its
  // final entry is a regular file. Canonicalize the whole path and keep it
  // beneath the canonical static root before serving any bytes.
  if (canonical !== root && !canonical.startsWith(`${root}${sep}`)) return null;
  return canonical;
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function proxyRequestHeaders(request: IncomingMessage): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  delete headers["x-tmux-ide-dev-host-session"];
  delete headers["x-tmux-ide-dev-original-method"];
  delete headers["content-length"];
  return headers;
}

function proxyResponseHeaders(
  source: IncomingMessage,
  payload: Buffer,
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(source.headers)) {
    if (
      value === undefined ||
      HOP_BY_HOP_HEADERS.has(name.toLowerCase()) ||
      name.toLowerCase() === "content-length"
    )
      continue;
    headers[name] = value;
  }
  headers["content-length"] = String(payload.length);
  return headers;
}

function generationGatewayUnavailable(status: number | undefined, payload: Buffer): boolean {
  if (status === 502 && payload.length === 0) return true;
  if (status !== 503) return false;
  try {
    return JSON.parse(payload.toString("utf8")).code === "canonical_daemon_unavailable";
  } catch {
    return false;
  }
}

function responseBody(source: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    source.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PROXY_RESPONSE_BYTES) {
        source.destroy(new Error("gateway response is too large"));
        return;
      }
      chunks.push(chunk);
    });
    source.once("end", () => resolveBody(Buffer.concat(chunks)));
    source.once("error", reject);
  });
}

function requestBody(source: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    source.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PROXY_REQUEST_BYTES) {
        source.destroy(new Error("gateway request is too large"));
        return;
      }
      chunks.push(chunk);
    });
    source.once("end", () => resolveBody(Buffer.concat(chunks)));
    source.once("error", reject);
  });
}

export async function startProductionWebServer(
  options: ProductionWebServerOptions,
): Promise<ProductionWebServer> {
  const staticRoot = realpathSync(options.staticRoot);
  const indexPath = safeStaticFile(staticRoot, "/");
  if (!indexPath) throw new Error(`packaged Web GUI is missing ${staticRoot}/index.html`);

  const bootstrap =
    options.ensureDaemon ??
    (() =>
      ensureCanonicalDaemon({
        entryPath: options.cliEntryPath,
        cwd: options.cwd,
      }));
  const openProject = options.openProject ?? openSelectedDevelopmentProject;
  let daemon = (await bootstrap()).candidate;
  if (!daemon.authToken) throw new Error("canonical daemon did not publish an owner credential");

  const gateway =
    options.gateway ??
    (await startGenerationGateway(options.daemonInfoPath ?? getCanonicalDaemonInfoPath(), {
      protocolVersion: daemon.protocolVersion,
      productVersion: daemon.productVersion,
      ...(daemon.environmentId ? { environmentId: daemon.environmentId } : {}),
    }));
  const gatewayUrl = new URL(gateway.origin);
  const sessions = new Map<string, DocumentSession>();
  const sockets = new Set<Socket>();
  let ensureInFlight: Promise<void> | null = null;
  let stopped = false;

  const ensureDaemon = (): Promise<void> => {
    if (ensureInFlight) return ensureInFlight;
    const pending = bootstrap().then(({ candidate }) => {
      daemon = candidate;
    });
    const tracked = pending.finally(() => {
      if (ensureInFlight === tracked) ensureInFlight = null;
    });
    ensureInFlight = tracked;
    return tracked;
  };

  const expireSessions = (): void => {
    const now = Date.now();
    for (const [token, session] of sessions) {
      if (session.expiresAt <= now) sessions.delete(token);
    }
    while (sessions.size >= DOCUMENT_SESSION_LIMIT) {
      const oldest = sessions.keys().next().value as string | undefined;
      if (!oldest) break;
      sessions.delete(oldest);
    }
  };
  const mintSession = (): string => {
    expireSessions();
    const token = randomUUID();
    sessions.set(token, {
      hostClientId: `web:${randomUUID()}`,
      expiresAt: Date.now() + DOCUMENT_SESSION_TTL_MS,
    });
    return token;
  };
  const resolveSession = (request: IncomingMessage): DocumentSession | null => {
    const token = request.headers["x-tmux-ide-dev-host-session"];
    if (typeof token !== "string") return null;
    expireSessions();
    return sessions.get(token) ?? null;
  };

  let pageOrigin = "";
  const proxyHttp = async (
    request: IncomingMessage,
    response: ServerResponse,
    session: DocumentSession,
    requestPayload: Buffer,
    retry = true,
  ): Promise<void> => {
    const originalMethod = request.headers["x-tmux-ide-dev-original-method"];
    const method = originalMethod === "GET" && request.method === "POST" ? "GET" : request.method;
    const headers = proxyRequestHeaders(request);
    headers.authorization = `Bearer ${gateway.bearer}`;
    headers["x-tmux-ide-host-client-id"] = session.hostClientId;
    headers.host = gatewayUrl.host;
    if (method !== "GET" && method !== "HEAD" && requestPayload.length > 0) {
      headers["content-length"] = String(requestPayload.length);
    }
    const upstream = httpRequest({
      hostname: gatewayUrl.hostname,
      port: Number(gatewayUrl.port),
      method,
      path: request.url,
      headers,
    });
    upstream.end(method === "GET" || method === "HEAD" ? undefined : requestPayload);
    try {
      const source = await new Promise<IncomingMessage>((resolveSource, reject) => {
        upstream.once("response", resolveSource);
        upstream.once("error", reject);
      });
      const responsePayload = await responseBody(source);
      if (retry && generationGatewayUnavailable(source.statusCode, responsePayload)) {
        await ensureDaemon();
        await proxyHttp(request, response, session, requestPayload, false);
        return;
      }
      response.writeHead(source.statusCode ?? 502, {
        ...proxyResponseHeaders(source, responsePayload),
        ...SECURITY_HEADERS,
        "Cache-Control": "no-store",
      });
      response.end(responsePayload);
    } catch {
      if (retry) {
        await ensureDaemon();
        await proxyHttp(request, response, session, requestPayload, false);
        return;
      }
      json(response, 502, { code: "generation_gateway_unavailable" });
    }
  };

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", pageOrigin || "http://127.0.0.1");
      if (url.pathname === "/api/dev/host-session") {
        if (request.method !== "POST" || !exactOrigin(request, pageOrigin)) {
          json(response, 404, { code: "not_found" });
          return;
        }
        json(response, 200, { token: mintSession() });
        return;
      }
      if (url.pathname === "/api/dev/open-project-directory") {
        const session = resolveSession(request);
        if (request.method !== "POST" || !session || !exactOrigin(request, pageOrigin)) {
          json(response, session ? 404 : 401, { code: "dev_host_session_invalid" });
          return;
        }
        await ensureDaemon();
        const result = await openProject({
          daemonOrigin: gateway.origin,
          ownerToken: gateway.bearer,
          hostClientId: session.hostClientId,
        });
        json(response, 200, result);
        return;
      }
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/terminal/")) {
        const session = resolveSession(request);
        if (!session || !exactOrigin(request, pageOrigin)) {
          json(response, 401, { code: "dev_host_session_invalid" });
          return;
        }
        await proxyHttp(request, response, session, await requestBody(request));
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        json(response, 405, { code: "method_not_allowed" });
        return;
      }
      const file = safeStaticFile(staticRoot, url.pathname);
      if (!file) {
        json(response, 404, { code: "not_found" });
        return;
      }
      if (file === indexPath) {
        const capability = mintSession();
        const html = readFileSync(indexPath, "utf8").replace(
          "</head>",
          `<meta name="tmux-ide-dev-host-session" content="${capability}"></head>`,
        );
        response.writeHead(200, {
          ...SECURITY_HEADERS,
          "Cache-Control": "no-store",
          "Content-Type": "text/html; charset=utf-8",
        });
        response.end(request.method === "HEAD" ? undefined : html);
        return;
      }
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        "Cache-Control": url.pathname.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
        "Content-Type": mimeType(file),
      });
      if (request.method === "HEAD") response.end();
      else createReadStream(file).pipe(response);
    })().catch(() => {
      if (!response.headersSent) json(response, 500, { code: "web_host_failed" });
      else response.end();
    });
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, downstream, head) => {
    void (async () => {
      const capability = consumeDevelopmentWebSocketSession(request.url);
      expireSessions();
      const session = capability ? sessions.get(capability.token) : undefined;
      if (
        !capability ||
        !session ||
        (request.headers.origin && request.headers.origin !== pageOrigin)
      ) {
        downstream.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      await ensureDaemon();
      const upstream = connectTcp(Number(gatewayUrl.port), gatewayUrl.hostname);
      sockets.add(upstream);
      upstream.once("close", () => sockets.delete(upstream));
      upstream.once("connect", () => {
        const headers = proxyRequestHeaders(request);
        headers.host = gatewayUrl.host;
        headers.authorization = `Bearer ${gateway.bearer}`;
        headers["x-tmux-ide-host-client-id"] = session.hostClientId;
        headers.connection = "Upgrade";
        headers.upgrade = "websocket";
        upstream.write(`${request.method ?? "GET"} ${capability.forwardPath} HTTP/1.1\r\n`);
        for (const [name, value] of Object.entries(headers)) {
          if (value === undefined) continue;
          upstream.write(`${name}: ${Array.isArray(value) ? value.join(", ") : value}\r\n`);
        }
        upstream.write("\r\n");
        if (head.length > 0) upstream.write(head);
        downstream.pipe(upstream).pipe(downstream);
      });
      upstream.once("error", () => downstream.destroy());
      downstream.once("error", () => upstream.destroy());
    })().catch(() => downstream.destroy());
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Web GUI did not bind");
  pageOrigin = `http://127.0.0.1:${address.port}`;

  return {
    url: `${pageOrigin}/`,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      if (!options.gateway) await gateway.stop();
    },
  };
}
