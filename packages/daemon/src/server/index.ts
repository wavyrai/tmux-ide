import { createServer, type Server } from "node:http";
import { parse } from "node:url";
import { Hono } from "hono";
import { getRequestListener } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { handlePtyWebSocket, shutdownPtyBridges } from "./ws-route.ts";

const DEFAULT_PORT = 6070;
export const SERVER_BIND_HOST = "127.0.0.1";

export interface StartedTmuxIdeServer {
  port: number;
  server: Server;
  close(): Promise<void>;
}

export function resolvePort(port?: number): number {
  const raw = port ?? Number.parseInt(process.env.TMUX_IDE_PORT ?? String(DEFAULT_PORT), 10);
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new Error(`Invalid server port: ${String(port ?? process.env.TMUX_IDE_PORT)}`);
  }
  return raw;
}

export function createApp(): Hono {
  const app = new Hono();

  app.get("/", (c) => c.text("tmux-ide server"));
  app.get("/health", (c) => c.json({ ok: true }));

  return app;
}

export async function start(port?: number): Promise<StartedTmuxIdeServer> {
  const resolvedPort = resolvePort(port);
  const app = createApp();
  const server = createServer(getRequestListener(app.fetch));
  const ptyWss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = parse(req.url ?? "/", true);
    const match = pathname?.match(/^\/ws\/pty\/([^/]+)$/);

    if (!match) {
      socket.destroy();
      return;
    }

    const id = decodeURIComponent(match[1] ?? "");
    ptyWss.handleUpgrade(req, socket, head, (ws) => {
      handlePtyWebSocket(ws, id);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(resolvedPort, SERVER_BIND_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });

  console.warn(
    "[tmux-ide] `tmux-ide server` is deprecated; use `tmux-ide --headless` for the supported daemon.",
  );
  console.log(`tmux-ide server listening on http://${SERVER_BIND_HOST}:${resolvedPort}`);

  return {
    port: resolvedPort,
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        shutdownPtyBridges();
        ptyWss.close();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
