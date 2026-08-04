import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

import { loopbackHttpOriginOrNull, webSocketOriginFor } from "./src/runtime/dev-web-host-config.ts";

/**
 * The one extra `connect-src` the browser-only development host needs (m44.2).
 *
 * The development server's CSP is the gate that stops an ordinary browser tab
 * from reaching a daemon: without this, `connect-src 'self' ws://127.0.0.1:5173`
 * refuses every daemon fetch and every daemon WebSocket, and the renderer falls
 * back to its honest preview surface. Setting
 * `VITE_TMUX_IDE_DEV_DAEMON_URL=http://127.0.0.1:<port>` widens it by exactly
 * one loopback origin (its `http:` and `ws:` forms), for the development server
 * only.
 *
 * Fail-closed by construction: absent, malformed, or non-loopback values add
 * nothing, so a typo or a stray remote URL cannot open the page up. This never
 * affects `vite build` output — the packaged renderer's CSP is owned by
 * `apps/electron-shell/src/packaged-renderer-protocol.ts` — and production never
 * sets this variable.
 */
function developmentDaemonConnectSources(): readonly string[] {
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
