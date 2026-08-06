import { defineConfig, type ProxyOptions } from "vite";
import solid from "vite-plugin-solid";

import { loopbackHttpOriginOrNull, webSocketOriginFor } from "./src/runtime/dev-web-host-config.ts";

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
    value === undefined || value === pageOrigin;
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
        request.setHeader("Authorization", `Bearer ${ownerToken}`);
      });
      proxy.on("proxyReqWs", (request, incoming) => {
        if (!acceptsOrigin(incoming.headers.origin)) {
          request.destroy(new Error("cross-origin daemon gateway socket refused"));
          return;
        }
        request.setHeader("Authorization", `Bearer ${ownerToken}`);
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
  plugins: [solid()],
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
