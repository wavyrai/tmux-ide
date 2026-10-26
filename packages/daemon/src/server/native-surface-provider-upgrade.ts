import type { Server, IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { TERMINAL_SURFACE_MAX_CONTROL_BYTES } from "@tmux-ide/contracts";
import { ownerBearerMatches } from "../command-center/owner-authority.ts";
import type { NativeSurfaceProviderRegistry } from "../terminal/graphics/native-surface-provider.ts";
import { NativeSurfaceProviderChannel } from "../terminal/graphics/native-surface-provider-channel.ts";

export const NATIVE_SURFACE_PROVIDER_PATH = "/v1/terminal/native-surface-provider";
const PROTOCOL = "tmux-ide-native-surface-provider-v1";

/** Separate owner-authenticated producer authority. Loopback, PID and Origin do
 * not grant access. At most one connection (including registration) is admitted.
 * Native kernel proof remains required independently of this control channel. */
export function attachNativeSurfaceProvider(
  server: Server,
  registry: NativeSurfaceProviderRegistry,
  ownerToken: string | null,
  isCurrent: () => boolean,
) {
  const wss = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    perMessageDeflate: false,
    maxPayload: TERMINAL_SURFACE_MAX_CONTROL_BYTES,
    handleProtocols: (values) => (values.size === 1 && values.has(PROTOCOL) ? PROTOCOL : false),
  });
  let active: WebSocket | null = null;
  let channel: NativeSurfaceProviderChannel | null = null;
  let closed = false;
  const upgrade = (request: IncomingMessage, socket: Socket, head: Buffer) => {
    if (request.url?.split("?", 1)[0] !== NATIVE_SURFACE_PROVIDER_PATH) return;
    const headers = (name: string) =>
      request.rawHeaders.filter((_, i) => i % 2 === 0).filter((key) => key.toLowerCase() === name)
        .length;
    const authorized =
      headers("authorization") === 1 &&
      ownerBearerMatches(request.headers.authorization, ownerToken);
    const status = !authorized
      ? 403
      : closed || !isCurrent()
        ? 410
        : active || registry.available
          ? 409
          : request.url !== NATIVE_SURFACE_PROVIDER_PATH ||
              headers("sec-websocket-protocol") !== 1 ||
              request.headers["sec-websocket-protocol"] !== PROTOCOL
            ? 400
            : 0;
    if (status) {
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      active = ws;
      const owner = new NativeSurfaceProviderChannel(
        registry,
        (message) => {
          if (
            !isCurrent() ||
            ws.readyState !== WebSocket.OPEN ||
            ws.bufferedAmount + Buffer.byteLength(message) > 64 * 1024
          )
            return false;
          ws.send(message, (error) => {
            if (error) owner.close();
          });
          return true;
        },
        () => ws.terminate(),
      );
      channel = owner;
      const timer = setTimeout(() => owner.close(), 5000);
      timer.unref();
      ws.on("message", (data, binary) => {
        if (binary || !isCurrent()) {
          owner.close();
          return;
        }
        owner.receive(data.toString());
        if (registry.available) clearTimeout(timer);
      });
      ws.on("error", () => owner.close());
      ws.on("close", () => {
        clearTimeout(timer);
        owner.close();
        if (active === ws) {
          active = null;
          channel = null;
        }
      });
    });
  };
  server.on("upgrade", upgrade);
  return {
    close: () => {
      closed = true;
      server.off("upgrade", upgrade);
      channel?.close();
      wss.close();
    },
  };
}
