import type { Server } from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer } from "ws";
import {
  TERMINAL_ATTACHMENT_REDEEM_PATH,
  TERMINAL_ATTACHMENT_MAX_REDEMPTION_BYTES,
  TERMINAL_ATTACHMENT_WEBSOCKET_PROTOCOL,
  type DirectTerminalSocket,
  type TerminalAttachmentAdmissionCoordinator,
} from "../terminal/attachments/direct-websocket.ts";

function protocols(value: string | string[] | undefined): readonly string[] {
  if (typeof value !== "string") return [];
  return value.split(",").map((entry) => entry.trim());
}

function rawHeaderValues(
  request: import("node:http").IncomingMessage,
  expectedName: string,
): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === expectedName) {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  return values;
}

function rejectUpgrade(socket: Socket, status: number): void {
  const phrase =
    status === 403
      ? "Forbidden"
      : status === 404
        ? "Not Found"
        : status === 426
          ? "Upgrade Required"
          : "Service Unavailable";
  try {
    socket.end(`HTTP/1.1 ${status} ${phrase}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    socket.destroy();
  }
}

export interface TerminalAttachmentWebSocketBoundary {
  close(): Promise<void>;
}

/**
 * Thin Node/ws integration for the direct terminal state machine. It performs
 * all path, protocol, Origin, and pre-auth capacity decisions before calling
 * `handleUpgrade`, so rejected requests never become WebSockets.
 */
export function attachTerminalAttachmentWebSocket(
  server: Server,
  coordinator: TerminalAttachmentAdmissionCoordinator,
): TerminalAttachmentWebSocketBoundary {
  const wss = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    perMessageDeflate: false,
    maxPayload: TERMINAL_ATTACHMENT_MAX_REDEMPTION_BYTES,
    handleProtocols(offered) {
      return offered.size === 1 && offered.has(TERMINAL_ATTACHMENT_WEBSOCKET_PROTOCOL)
        ? TERMINAL_ATTACHMENT_WEBSOCKET_PROTOCOL
        : false;
    },
  });

  const upgrade = (
    request: import("node:http").IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): void => {
    const rawPath = request.url ?? "";
    const pathname = rawPath.split("?", 1)[0] ?? "";
    if (!pathname.startsWith("/v1/terminal/attachments/")) return;
    if (pathname !== TERMINAL_ATTACHMENT_REDEEM_PATH) {
      rejectUpgrade(socket, 404);
      return;
    }
    const originHeaders = rawHeaderValues(request, "origin");
    if (originHeaders.length !== 1) {
      rejectUpgrade(socket, 403);
      return;
    }
    const protocolHeaders = rawHeaderValues(request, "sec-websocket-protocol");
    if (protocolHeaders.length !== 1) {
      rejectUpgrade(socket, 426);
      return;
    }
    const decision = coordinator.reserveUpgrade({
      path: rawPath,
      protocols: protocols(protocolHeaders[0]),
      origin: originHeaders[0],
    });
    if (!decision.accepted) {
      rejectUpgrade(socket, decision.httpStatus);
      return;
    }
    const cancelUnbound = (): void => decision.admission.cancelBeforeBind();
    socket.once("close", cancelUnbound);
    socket.once("error", cancelUnbound);
    try {
      wss.handleUpgrade(request, socket, head, (ws) => {
        socket.off("close", cancelUnbound);
        socket.off("error", cancelUnbound);
        decision.admission.bind(ws as unknown as DirectTerminalSocket);
      });
    } catch {
      socket.off("close", cancelUnbound);
      socket.off("error", cancelUnbound);
      decision.admission.cancelBeforeBind();
      socket.destroy();
    }
  };

  server.on("upgrade", upgrade);
  return {
    close: async () => {
      server.off("upgrade", upgrade);
      await coordinator.shutdown();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
