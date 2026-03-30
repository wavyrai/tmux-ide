import { createServer, type Server, type IncomingMessage } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { WebSocketServer, type WebSocket } from "ws";
import { createApp } from "./server.ts";
import { discoverSessions } from "./discovery.ts";
import {
  startMirror,
  handleInput as mirrorHandleInput,
  stopAll as stopAllMirrors,
} from "./pane-mirror.ts";
import { listSessionPanes } from "../widgets/lib/pane-comms.ts";

export interface CommandCenterOptions {
  port?: number;
  hostname?: string;
}

/**
 * Attach WebSocket upgrade handling to an HTTP server.
 * Clients connect to /ws/mirror/{session}/{paneId} to mirror a tmux pane.
 */
export function attachWebSockets(server: Server, _session: string, _dir: string): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    // Use raw URL to preserve %N pane IDs (url.parse decodes %36 → '6')
    const rawPath = (req.url ?? "/").split("?")[0]!;

    // Match mirror WebSocket: /ws/mirror/{sessionName}/{paneId}
    const mirrorMatch = rawPath.match(/^\/ws\/mirror\/([^/]+)\/(.+)$/);
    if (!mirrorMatch) {
      socket.destroy();
      return;
    }

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

        // Ignore JSON control messages (resize not supported — would shrink tmux for all clients)
        if (str.startsWith("{")) return;

        mirrorHandleInput(paneId, str);
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

  // Discover the first active tmux-ide session for context
  const sessions = discoverSessions();
  const activeSession = sessions[0];
  const session = activeSession?.name ?? "";
  const dir = activeSession?.dir ?? process.cwd();

  // Attach WebSocket upgrade handler for pane mirrors
  attachWebSockets(server, session, dir);

  // Cleanup mirrors on server close
  server.on("close", () => {
    stopAllMirrors();
  });

  return new Promise((resolve) => {
    server.listen(port, hostname, () => {
      console.log(`Command Center API on http://${hostname}:${port}`);
      if (session) {
        console.log(
          `WebSocket pane mirrors at ws://${hostname}:${port}/ws/mirror/{session}/{paneId}`,
        );
      }
      resolve(server);
    });
  });
}
