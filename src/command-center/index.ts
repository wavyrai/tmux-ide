import { createServer, type Server, type IncomingMessage } from "node:http";
import { parse as parseUrl } from "node:url";
import { getRequestListener } from "@hono/node-server";
import { WebSocketServer, type WebSocket } from "ws";
import { createApp } from "./server.ts";
import { discoverSessions } from "./discovery.ts";
import {
  spawnWidget,
  connectClient,
  resizeWidget,
  killAll,
  getSession,
} from "./pty-manager.ts";
import {
  startMirror,
  handleInput as mirrorHandleInput,
  handleResize as mirrorHandleResize,
  stopAll as stopAllMirrors,
} from "./pane-mirror.ts";
import { listSessionPanes } from "../widgets/lib/pane-comms.ts";

export interface CommandCenterOptions {
  port?: number;
  hostname?: string;
}

/**
 * Attach WebSocket upgrade handling to an HTTP server.
 * Clients connect to /ws/{widgetType} to get a PTY terminal stream.
 */
export function attachWebSockets(
  server: Server,
  session: string,
  dir: string,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    // Use raw URL to preserve %N pane IDs (url.parse decodes %36 → '6')
    const rawPath = (req.url ?? "/").split("?")[0]!;

    // Match mirror WebSocket: /ws/mirror/{sessionName}/{paneId}
    const mirrorMatch = rawPath.match(/^\/ws\/mirror\/([^/]+)\/(.+)$/);
    if (mirrorMatch) {
      const mirrorSession = decodeURIComponent(mirrorMatch[1]!);
      // Don't decode paneId — tmux uses %N format (literal percent + number)
      const paneId = mirrorMatch[2]!;

      // Validate session and pane exist
      try {
        const panes = listSessionPanes(mirrorSession);
        const paneExists = panes.some((p) => p.id === paneId);
        if (!paneExists) {
          socket.destroy();
          return;
        }
      } catch {
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        startMirror(mirrorSession, paneId, ws);

        ws.on("message", (data: Buffer | string) => {
          const str = typeof data === "string" ? data : data.toString("utf-8");

          if (str.startsWith("{")) {
            try {
              const msg = JSON.parse(str) as { type?: string; cols?: number; rows?: number };
              if (msg.type === "resize" && msg.cols && msg.rows) {
                mirrorHandleResize(paneId, msg.cols, msg.rows);
                return;
              }
            } catch {
              // Not JSON — fall through to input
            }
          }

          mirrorHandleInput(paneId, str);
        });

        wss.emit("connection", ws, req);
      });
      return;
    }

    // Match widget WebSocket: /ws/{widgetType}
    const match = rawPath.match(/^\/ws\/([a-z-]+)$/);

    if (!match) {
      socket.destroy();
      return;
    }

    const widgetType = match[1]!;

    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      // Parse initial size from query params (e.g. /ws/warroom?cols=120&rows=40)
      const query = parseUrl(req.url ?? "/", true).query;
      const cols = parseInt(query.cols as string, 10) || 80;
      const rows = parseInt(query.rows as string, 10) || 24;

      // Spawn PTY if not already running for this widget type
      if (!getSession(widgetType)) {
        try {
          spawnWidget(widgetType, session, dir, cols, rows);
        } catch (err) {
          console.error(`[pty] Failed to spawn ${widgetType}:`, (err as Error).message);
          ws.close(1011, "PTY spawn failed");
          return;
        }
      }

      // Connect this WebSocket client to the PTY session
      const connected = connectClient(widgetType, ws);
      if (!connected) {
        ws.close(1011, "Failed to connect to PTY session");
        return;
      }

      // Override the default message handler from connectClient to handle
      // resize messages (JSON with type:"resize") vs raw keyboard input
      ws.removeAllListeners("message");
      ws.on("message", (data: Buffer | string) => {
        const str = typeof data === "string" ? data : data.toString("utf-8");

        // Try to parse as JSON control message
        if (str.startsWith("{")) {
          try {
            const msg = JSON.parse(str) as { type?: string; cols?: number; rows?: number };
            if (msg.type === "resize" && msg.cols && msg.rows) {
              resizeWidget(widgetType, msg.cols, msg.rows);
              return;
            }
          } catch {
            // Not JSON — fall through to keyboard input
          }
        }

        // Forward as keyboard/mouse input to PTY
        const ptySession = getSession(widgetType);
        if (ptySession) {
          ptySession.process.write(str);
        }
      });

      wss.emit("connection", ws, req);
    });
  });

  return wss;
}

export async function startCommandCenter(options: CommandCenterOptions = {}): Promise<Server> {
  const port = options.port ?? 4000;
  const hostname = options.hostname ?? "0.0.0.0";
  const app = createApp();

  const listener = getRequestListener(app.fetch);
  const server = createServer(listener);

  // Discover the first active tmux-ide session for PTY context
  const sessions = discoverSessions();
  const activeSession = sessions[0];
  const session = activeSession?.name ?? "";
  const dir = activeSession?.dir ?? process.cwd();

  // Attach WebSocket upgrade handler for PTY terminals
  attachWebSockets(server, session, dir);

  // Cleanup PTYs and mirrors on server close
  server.on("close", () => {
    killAll();
    stopAllMirrors();
  });

  return new Promise((resolve) => {
    server.listen(port, hostname, () => {
      console.log(`Command Center API on http://${hostname}:${port}`);
      if (session) {
        console.log(`WebSocket PTY terminals available at ws://${hostname}:${port}/ws/{widgetType}`);
      }
      resolve(server);
    });
  });
}
