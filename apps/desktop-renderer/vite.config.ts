import { randomUUID } from "node:crypto";
import { defineConfig, type Plugin, type ProxyOptions } from "vite";
import solid from "vite-plugin-solid";

import {
  consumeDevelopmentWebSocketSession,
  isExactDevelopmentPageOrigin,
  loopbackHttpOriginOrNull,
  webSocketOriginFor,
} from "./src/runtime/dev-web-host-config.ts";
import { DevelopmentHostSessionRegistry } from "./src/runtime/dev-host-session-registry.ts";

/**
 * Legacy direct mode needs one tightly scoped daemon `connect-src`. Gateway
 * mode needs none: HTTP and WebSockets stay on the Vite page origin and Vite
 * owns both the daemon endpoint and its reusable bearer.
 *
 * Fail-closed by construction: absent, malformed, or non-loopback direct-mode
 * values add nothing. This never affects `vite build` output — the packaged
 * renderer's CSP is owned by the Electron shell.
 */
function developmentDaemonConnectSources(): readonly string[] {
  if (process.env.VITE_TMUX_IDE_DEV_GATEWAY === "1") return [];
  const origin = loopbackHttpOriginOrNull(process.env.VITE_TMUX_IDE_DEV_DAEMON_URL);
  if (origin === null) {
    if (process.env.VITE_TMUX_IDE_DEV_DAEMON_URL) {
      throw new Error(
        "VITE_TMUX_IDE_DEV_DAEMON_URL must be a canonical loopback origin with a port " +
          `(for example http://127.0.0.1:8787); received ${JSON.stringify(process.env.VITE_TMUX_IDE_DEV_DAEMON_URL)}`,
      );
    }
    return [];
  }
  return [origin, webSocketOriginFor(origin)];
}

const DEVELOPMENT_HOST_SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
const DEVELOPMENT_HOST_SESSION_LIMIT = 128;
const developmentHostSessions = new DevelopmentHostSessionRegistry({
  now: Date.now,
  createToken: randomUUID,
  createHostClientId: () => `dev-web:${randomUUID()}`,
  ttlMs: DEVELOPMENT_HOST_SESSION_TTL_MS,
  limit: DEVELOPMENT_HOST_SESSION_LIMIT,
});

function activeDevelopmentHostSession(
  token: string | undefined,
): { readonly hostClientId: string; readonly expiresAt: number } | undefined {
  if (!token) return undefined;
  return developmentHostSessions.resolve(token);
}

function developmentHostBootstrap(): Plugin {
  return {
    name: "tmux-ide-dev-host-bootstrap",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pageOrigin = `http://127.0.0.1:${developmentServerPort()}`;
        const pathname = request.url?.split("?", 1)[0];
        const privilegedGatewayRequest =
          pathname === "/__tmux_ide_host_session" || pathname?.startsWith("/api");
        if (
          process.env.VITE_TMUX_IDE_DEV_GATEWAY === "1" &&
          privilegedGatewayRequest &&
          !isExactDevelopmentPageOrigin(request.headers.origin, pageOrigin)
        ) {
          response.statusCode = 404;
          response.end();
          return;
        }
        if (pathname !== "/__tmux_ide_host_session") {
          if (process.env.VITE_TMUX_IDE_DEV_GATEWAY === "1" && pathname?.startsWith("/api")) {
            const originalMethod = request.headers["x-tmux-ide-dev-original-method"];
            if (originalMethod !== undefined) {
              if (request.method !== "POST" || originalMethod !== "GET") {
                response.statusCode = 404;
                response.end();
                return;
              }
              // Same-origin GET fetches omit Origin in browsers. The renderer
              // therefore tunnels a logical GET through an origin-bearing POST;
              // restore the method only after the exact-origin check above.
              request.method = "GET";
              delete request.headers["x-tmux-ide-dev-original-method"];
            }
            const token = request.headers["x-tmux-ide-dev-host-session"];
            const session = activeDevelopmentHostSession(
              typeof token === "string" ? token : undefined,
            );
            if (!session) {
              response.statusCode = 401;
              response.setHeader("Content-Type", "application/json");
              response.setHeader("Cache-Control", "no-store");
              response.end(JSON.stringify({ code: "dev_host_session_invalid" }));
              return;
            }
            request.headers["x-tmux-ide-trusted-host-client-id"] = session.hostClientId;
          }
          next();
          return;
        }
        if (
          process.env.VITE_TMUX_IDE_DEV_GATEWAY !== "1" ||
          request.method !== "POST" ||
          !isExactDevelopmentPageOrigin(request.headers.origin, pageOrigin)
        ) {
          response.statusCode = 404;
          response.end();
          return;
        }
        const { token } = developmentHostSessions.mint();
        response.setHeader("Content-Type", "application/json");
        response.setHeader("Cache-Control", "no-store");
        response.end(JSON.stringify({ token }));
      });
    },
  };
}

function developmentDaemonProxy(devServerPort: number): Record<string, ProxyOptions> | undefined {
  if (process.env.VITE_TMUX_IDE_DEV_GATEWAY !== "1") return undefined;
  const rawOrigin = process.env.TMUX_IDE_DEV_DAEMON_URL;
  const origin = loopbackHttpOriginOrNull(rawOrigin);
  if (origin === null) {
    throw new Error(
      "TMUX_IDE_DEV_DAEMON_URL must name the canonical loopback daemon origin in gateway mode",
    );
  }
  const ownerToken = process.env.TMUX_IDE_DEV_OWNER_TOKEN;
  if (!ownerToken) {
    throw new Error("TMUX_IDE_DEV_OWNER_TOKEN is required in gateway mode");
  }
  const pageOrigin = `http://127.0.0.1:${devServerPort}`;
  const acceptsOrigin = (value: string | undefined): boolean =>
    isExactDevelopmentPageOrigin(value, pageOrigin);
  // Keep the proxy surface explicit. In particular, this is not a catch-all
  // forwarder that turns the browser origin into arbitrary daemon authority.
  const options = (webSocket: boolean): ProxyOptions => ({
    target: origin,
    changeOrigin: false,
    ws: webSocket,
    configure(proxy) {
      proxy.on("proxyReq", (request, incoming) => {
        if (!acceptsOrigin(incoming.headers.origin)) {
          request.destroy(new Error("cross-origin daemon gateway request refused"));
          return;
        }
        const hostClientId = incoming.headers["x-tmux-ide-trusted-host-client-id"];
        if (typeof hostClientId !== "string") return;
        request.removeHeader("X-Tmux-Ide-Dev-Host-Session");
        request.removeHeader("X-Tmux-Ide-Trusted-Host-Client-Id");
        request.setHeader("Authorization", `Bearer ${ownerToken}`);
        request.setHeader("X-Tmux-Ide-Host-Client-Id", hostClientId);
      });
      proxy.on("proxyReqWs", (request, incoming) => {
        const capability = consumeDevelopmentWebSocketSession(incoming.url);
        const session = activeDevelopmentHostSession(capability?.token);
        if (!acceptsOrigin(incoming.headers.origin) || !capability || !session) {
          request.destroy(new Error("cross-origin daemon gateway socket refused"));
          return;
        }
        // The query capability exists only between this document and Vite. It
        // is removed from both sides of the proxy request before daemon sees
        // the handshake, while the trusted stable host identity is injected.
        incoming.url = capability.forwardPath;
        request.path = capability.forwardPath;
        request.removeHeader("X-Tmux-Ide-Dev-Host-Session");
        request.setHeader("Authorization", `Bearer ${ownerToken}`);
        request.setHeader("X-Tmux-Ide-Host-Client-Id", session.hostClientId);
      });
    },
  });
  return {
    "/api": options(false),
    "/ws": options(true),
    "/v1/terminal/attachments/redeem": options(true),
    "/v1/terminal/pane-streams/redeem": options(true),
  };
}

/**
 * The development server port. Overridable so an automated harness can run its
 * own instance without colliding with a developer's 5173. The HMR `connect-src`
 * below is derived from the same value — a bare `--port` override would
 * otherwise serve a CSP that refuses the page's own HMR socket.
 */
function developmentServerPort(): number {
  const raw = process.env.TMUX_IDE_DEV_SERVER_PORT;
  if (raw === undefined || raw === "") return 5173;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`TMUX_IDE_DEV_SERVER_PORT must be a TCP port; received ${JSON.stringify(raw)}`);
  }
  return port;
}

const devServerPort = developmentServerPort();

export default defineConfig({
  base: "./",
  plugins: [solid(), developmentHostBootstrap()],
  build: {
    target: "es2022",
    sourcemap: false,
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: devServerPort,
    strictPort: true,
    proxy: developmentDaemonProxy(devServerPort),
    headers: {
      "Content-Security-Policy": [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "style-src-elem 'self' 'unsafe-inline'",
        "style-src-attr 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        [
          `connect-src 'self' ws://127.0.0.1:${devServerPort}`,
          ...developmentDaemonConnectSources(),
        ].join(" "),
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "form-action 'none'",
      ].join("; "),
    },
  },
});
