import type { Server } from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer } from "ws";
import { PANE_STREAM_REDEEM_PATH, PANE_STREAM_WEBSOCKET_SUBPROTOCOL } from "@tmux-ide/contracts";
import type { DirectTerminalSocket } from "../terminal/attachments/direct-websocket.ts";
import { daemonWebSocketHeartbeat, type WebSocketHeartbeat } from "./websocket-heartbeat.ts";
import {
  PANE_STREAM_MAX_CONTROL_BYTES,
  PANE_STREAM_MAX_REDEMPTION_BYTES,
  type PaneStreamAdmissionCoordinator,
} from "../terminal/pane-stream/pane-stream-websocket.ts";

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

/**
 * attach-rtt: the client may carry its redeem frame in the upgrade request
 * (base64url of the frame's JSON text), so the daemon answers the 101 and the
 * seed without waiting a round trip for the frame. The 101 says so with
 * `X-Tmux-Ide-Redeem: accepted`; a client that sees no such header sends the
 * frame as before. Absent, the upgrade is exactly as it was.
 */
export const PANE_STREAM_REDEEM_HEADER = "x-tmux-ide-redeem";

/** The frame a redeem header carries, `null` for none, or "invalid". */
function upgradeRedeemFrame(
  request: import("node:http").IncomingMessage,
): Buffer | null | "invalid" {
  const values = rawHeaderValues(request, PANE_STREAM_REDEEM_HEADER);
  if (values.length === 0) return null;
  const value = values[0]!;
  if (
    values.length > 1 ||
    value.length === 0 ||
    value.length > Math.ceil((PANE_STREAM_MAX_REDEMPTION_BYTES * 4) / 3) ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  )
    return "invalid";
  const frame = Buffer.from(value, "base64url");
  return frame.byteLength === 0 || frame.byteLength > PANE_STREAM_MAX_REDEMPTION_BYTES
    ? "invalid"
    : frame;
}

function rejectUpgrade(socket: Socket, status: number): void {
  const phrase =
    status === 403
      ? "Forbidden"
      : status === 404
        ? "Not Found"
        : status === 410
          ? "Gone"
          : status === 426
            ? "Upgrade Required"
            : "Service Unavailable";
  try {
    socket.end(`HTTP/1.1 ${status} ${phrase}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    socket.destroy();
  }
}

export interface PaneStreamWebSocketBoundary {
  close(): Promise<void>;
}

/**
 * Thin Node/ws integration for the pane-stream admission state machine — the
 * sibling of the direct terminal attachment boundary. All path, protocol,
 * Origin, and pre-auth capacity decisions happen before `handleUpgrade`, so
 * rejected requests never become WebSockets.
 */
export function attachPaneStreamWebSocket(
  server: Server,
  coordinator: PaneStreamAdmissionCoordinator,
  redemptionPath: string = PANE_STREAM_REDEEM_PATH,
  isCurrent: () => boolean = () => true,
  heartbeat: WebSocketHeartbeat = daemonWebSocketHeartbeat(),
): PaneStreamWebSocketBoundary {
  const wss = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    perMessageDeflate: false,
    // Client frames are small JSON (redeem/input/consumed); one shared bound.
    maxPayload: Math.max(PANE_STREAM_MAX_REDEMPTION_BYTES, PANE_STREAM_MAX_CONTROL_BYTES),
    handleProtocols(offered) {
      return offered.size === 1 && offered.has(PANE_STREAM_WEBSOCKET_SUBPROTOCOL)
        ? PANE_STREAM_WEBSOCKET_SUBPROTOCOL
        : false;
    },
  });

  // Old clients ignore the header and answer the pings by protocol.
  const redeemed = new WeakSet<import("node:http").IncomingMessage>();
  wss.on("headers", (headers, request) => {
    heartbeat.advertise(headers);
    if (redeemed.has(request)) headers.push("X-Tmux-Ide-Redeem: accepted");
  });

  const upgrade = (
    request: import("node:http").IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): void => {
    const rawPath = request.url ?? "";
    const pathname = rawPath.split("?", 1)[0] ?? "";
    if (
      redemptionPath === PANE_STREAM_REDEEM_PATH &&
      pathname.startsWith("/v1/terminal/pane-streams/")
    ) {
      rejectUpgrade(socket, 426);
      return;
    }
    if (redemptionPath !== PANE_STREAM_REDEEM_PATH && pathname !== redemptionPath) return;
    if (
      redemptionPath === PANE_STREAM_REDEEM_PATH &&
      !pathname.startsWith("/v2/terminal/pane-streams/")
    )
      return;
    if (pathname !== redemptionPath) {
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
    const hostClientHeaders = rawHeaderValues(request, "x-tmux-ide-host-client-id");
    if (hostClientHeaders.length > 1) {
      rejectUpgrade(socket, 403);
      return;
    }
    const requestIdHeaders = rawHeaderValues(request, "x-tmux-ide-request-id");
    if (requestIdHeaders.length > 1) {
      rejectUpgrade(socket, 403);
      return;
    }
    const redeemFrame = upgradeRedeemFrame(request);
    if (redeemFrame === "invalid") {
      rejectUpgrade(socket, 403);
      return;
    }
    if (!isCurrent()) {
      rejectUpgrade(socket, 410);
      return;
    }
    const decision = coordinator.reserveUpgrade({
      path: rawPath,
      protocols: protocols(protocolHeaders[0]),
      origin: originHeaders[0],
      ...(hostClientHeaders[0] ? { hostClientId: hostClientHeaders[0] } : {}),
      ...(requestIdHeaders[0] ? { requestId: requestIdHeaders[0] } : {}),
    });
    if (!decision.accepted) {
      rejectUpgrade(socket, decision.httpStatus);
      return;
    }
    const cancelUnbound = (): void => decision.admission.cancelBeforeBind();
    socket.once("close", cancelUnbound);
    socket.once("error", cancelUnbound);
    if (redeemFrame) redeemed.add(request);
    try {
      wss.handleUpgrade(request, socket, head, (ws) => {
        socket.off("close", cancelUnbound);
        socket.off("error", cancelUnbound);
        heartbeat.watch(ws, `pane-stream ${redemptionPath}`);
        decision.admission.bind(ws as unknown as DirectTerminalSocket);
        if (redeemFrame) decision.admission.redeemFromUpgrade(redeemFrame);
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
