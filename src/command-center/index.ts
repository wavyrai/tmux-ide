import { createServer, type Server } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { createApp } from "./server.ts";
import { discoverSessions } from "./discovery.ts";
import { spawnWidget, connectClient, killAll } from "./pty-manager.ts";

export interface CommandCenterOptions {
  port?: number;
  hostname?: string;
}

export function attachWebSockets(server: Server, session: string, dir: string): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url!, `http://${request.headers.host}`);
    const match = url.pathname.match(/^\/ws\/(\w[\w-]*)$/);

    if (match) {
      const widgetType = match[1]!;

      wss.handleUpgrade(request, socket, head, (ws) => {
        // Spawn widget if not already running (default 80x24, clients resize later)
        spawnWidget(widgetType, session, dir, 80, 24)
          .then(() => {
            connectClient(widgetType, ws);
          })
          .catch(() => {
            ws.close();
          });
      });
    } else {
      socket.destroy();
    }
  });
}

export async function startCommandCenter(options: CommandCenterOptions = {}): Promise<Server> {
  const port = options.port ?? 4000;
  const hostname = options.hostname ?? "0.0.0.0";
  const app = createApp();

  // Create Node HTTP server with Hono as the handler
  const listener = getRequestListener(app.fetch);
  const server = createServer(listener);

  // Auto-discover active tmux-ide session for widget spawning
  const sessions = discoverSessions();
  const activeSession = sessions[0];

  if (activeSession) {
    attachWebSockets(server, activeSession.name, activeSession.dir);
    console.log(`Widgets connected to session: ${activeSession.name}`);
  }

  // Cleanup PTYs on shutdown
  const cleanup = () => {
    killAll();
    server.close();
  };

  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);

  return new Promise((resolve) => {
    server.listen(port, hostname, () => {
      console.log(`Command Center on http://${hostname}:${port}`);
      resolve(server);
    });
  });
}
