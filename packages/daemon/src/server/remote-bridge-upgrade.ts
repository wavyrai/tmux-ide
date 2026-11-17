import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  REMOTE_BRIDGE_FEATURES,
  REMOTE_BRIDGE_MAX_CLIENT_FRAME_BYTES,
  REMOTE_BRIDGE_PATH,
  REMOTE_BRIDGE_SUBPROTOCOL,
  REMOTE_BRIDGE_VERSION,
  RemoteBridgeClientFrameSchemaZ,
  type RemoteBridgeServerFrame,
  type RemoteClipboardEvent,
} from "@tmux-ide/contracts";
import { ownerBearerMatches } from "../command-center/owner-authority.ts";
import type { RemoteClipboardHub } from "../terminal/remote-bridge/clipboard-hub.ts";
import { daemonWebSocketHeartbeat, type WebSocketHeartbeat } from "./websocket-heartbeat.ts";

/** Reports are dropped, never queued, once this much waits for one app. */
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
const HELLO_TIMEOUT_MS = 5000;
const POLICY = 1008;
const GOING_AWAY = 1001;

export interface RemoteBridgeOptions {
  readonly ownerToken: string | null;
  readonly hub: Pick<RemoteClipboardHub, "subscribe">;
  readonly isCurrent: () => boolean;
  readonly heartbeat?: WebSocketHeartbeat;
  readonly helloTimeoutMs?: number;
}

export interface RemoteBridgeBoundary {
  close(): void;
  stats(): { readonly connections: number; readonly dropped: number };
}

function headerCount(request: IncomingMessage, name: string): number {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2)
    if (request.rawHeaders[index]?.toLowerCase() === name) count += 1;
  return count;
}

function reject(socket: Socket, status: 400 | 403 | 410): void {
  const phrase = status === 400 ? "Bad Request" : status === 403 ? "Forbidden" : "Gone";
  try {
    socket.end(`HTTP/1.1 ${status} ${phrase}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    socket.destroy();
  }
}

function frameText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data as ArrayBuffer).toString("utf8");
}

/**
 * `GET /api/v2/bridge`: the per-machine bridge, owner-authenticated like the
 * native surface provider. After the app's hello the daemon only reports;
 * it never asks the app for anything.
 */
export function attachRemoteBridge(
  server: Server,
  options: RemoteBridgeOptions,
): RemoteBridgeBoundary {
  const heartbeat = options.heartbeat ?? daemonWebSocketHeartbeat();
  const helloTimeoutMs = options.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
  const wss = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    perMessageDeflate: false,
    maxPayload: REMOTE_BRIDGE_MAX_CLIENT_FRAME_BYTES,
    handleProtocols: (offered) =>
      offered.size === 1 && offered.has(REMOTE_BRIDGE_SUBPROTOCOL)
        ? REMOTE_BRIDGE_SUBPROTOCOL
        : false,
  });
  wss.on("headers", (headers) => heartbeat.advertise(headers));
  const open = new Set<WebSocket>();
  let dropped = 0;
  let closed = false;

  const send = (ws: WebSocket, frame: RemoteBridgeServerFrame): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const text = JSON.stringify(frame);
    if (ws.bufferedAmount + Buffer.byteLength(text) > MAX_BUFFERED_BYTES) {
      dropped += 1;
      return;
    }
    ws.send(text);
  };

  const serve = (ws: WebSocket): void => {
    open.add(ws);
    heartbeat.watch(ws, "remote-bridge");
    let unsubscribe: (() => void) | null = null;
    const timer = setTimeout(() => ws.close(POLICY, "hello required"), helloTimeoutMs);
    timer.unref?.();
    const end = (): void => {
      clearTimeout(timer);
      unsubscribe?.();
      unsubscribe = null;
      open.delete(ws);
    };
    ws.on("message", (data, binary) => {
      let hello = false;
      if (!binary && !unsubscribe) {
        try {
          hello = RemoteBridgeClientFrameSchemaZ.safeParse(JSON.parse(frameText(data))).success;
        } catch {
          hello = false;
        }
      }
      if (!hello || !options.isCurrent()) {
        end();
        ws.close(POLICY, "unexpected frame");
        return;
      }
      clearTimeout(timer);
      send(ws, {
        type: "ready",
        version: REMOTE_BRIDGE_VERSION,
        features: [...REMOTE_BRIDGE_FEATURES],
      });
      unsubscribe = options.hub.subscribe((event: RemoteClipboardEvent) => send(ws, event));
    });
    ws.on("close", end);
    ws.on("error", end);
  };

  const upgrade = (request: IncomingMessage, socket: Socket, head: Buffer): void => {
    const url = request.url ?? "";
    if (url.split("?", 1)[0] !== REMOTE_BRIDGE_PATH) return;
    const authorized =
      headerCount(request, "authorization") === 1 &&
      ownerBearerMatches(request.headers.authorization, options.ownerToken);
    if (!authorized) return reject(socket, 403);
    if (closed || !options.isCurrent()) return reject(socket, 410);
    if (
      url !== REMOTE_BRIDGE_PATH ||
      headerCount(request, "sec-websocket-protocol") !== 1 ||
      request.headers["sec-websocket-protocol"] !== REMOTE_BRIDGE_SUBPROTOCOL
    )
      return reject(socket, 400);
    try {
      wss.handleUpgrade(request, socket, head, serve);
    } catch {
      socket.destroy();
    }
  };

  server.on("upgrade", upgrade);
  return {
    close: () => {
      closed = true;
      server.off("upgrade", upgrade);
      for (const ws of [...open]) ws.close(GOING_AWAY, "daemon-shutdown");
      wss.close();
    },
    stats: () => ({ connections: open.size, dropped }),
  };
}
