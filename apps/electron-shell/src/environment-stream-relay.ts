import { createServer } from "node:http";
import { Socket } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { z } from "zod";
import {
  PaneStreamIssueDescriptorSchemaZ,
  PaneStreamRedeemFrameSchemaZ,
  TerminalAttachmentIssueDescriptorSchemaZ,
  type PaneStreamIssueDescriptor,
  type TerminalAttachmentIssueDescriptor,
} from "@tmux-ide/contracts";

type Descriptor = PaneStreamIssueDescriptor | TerminalAttachmentIssueDescriptor;
const attachmentRedeem = z
  .object({
    type: z.literal("redeem"),
    protocolVersion: TerminalAttachmentIssueDescriptorSchemaZ.shape.protocolVersion,
    ticket: TerminalAttachmentIssueDescriptorSchemaZ.shape.redemptionTicket,
    requestId: TerminalAttachmentIssueDescriptorSchemaZ.shape.requestId,
    daemonInstanceId: TerminalAttachmentIssueDescriptorSchemaZ.shape.daemonInstanceId,
  })
  .strict();
interface Registration {
  descriptor: Descriptor;
  upstreamUrl: string;
  scope: string;
  renderer: string;
  isCurrent(): boolean;
}
interface Pair {
  downstream: WebSocket;
  upstream: WebSocket | null;
  registration: Registration | null;
  close(): void;
}

/** Experimental main-process relay; never accepts owner credentials or arbitrary renderer routes. */
export async function startEnvironmentStreamRelay(options: {
  trustedOrigin: string;
  maxSockets?: number;
  maxTickets?: number;
  maxQueuedBytes?: number;
  firstMessageTimeoutMs?: number;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const maxSockets = options.maxSockets ?? 64;
  const maxTickets = options.maxTickets ?? 256;
  const maxQueued = options.maxQueuedBytes ?? 16 * 1024 * 1024;
  const deadline = options.firstMessageTimeoutMs ?? 5000;
  for (const value of [maxSockets, maxTickets, maxQueued, deadline])
    if (!Number.isSafeInteger(value) || value < 1) throw Error("Invalid relay limit");
  const tickets = new Map<string, Registration>();
  const sockets = new Set<Socket>();
  const pairs = new Set<Pair>();
  const server = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  server.on("connection", (socket) => {
    if (sockets.size >= maxSockets) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(deadline, () => socket.destroy());
  });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    perMessageDeflate: false,
  });
  let disposed = false;
  const expire = () => {
    for (const [key, value] of tickets)
      if (value.descriptor.expiresAt <= now() || !isCurrent(value)) tickets.delete(key);
  };
  server.on("upgrade", (request, socket, head) => {
    const path = request.url;
    const expectedProtocol =
      path === "/v1/terminal/pane-streams/redeem"
        ? "tmux-ide-pane-stream.v1"
        : "tmux-ide-terminal.v1";
    if (
      disposed ||
      pairs.size >= maxSockets ||
      request.headers.origin !== options.trustedOrigin ||
      request.headers["sec-websocket-protocol"] !== expectedProtocol ||
      !["/v1/terminal/pane-streams/redeem", "/v1/terminal/attachments/redeem"].includes(path ?? "")
    ) {
      socket.destroy();
      return;
    }
    if (socket instanceof Socket) socket.setTimeout(0);
    try {
      wss.handleUpgrade(request, socket, head, (downstream) => {
        const pair: Pair = { downstream, upstream: null, registration: null, close: () => {} };
        const timer = setTimeout(() => pair.close(), deadline);
        timer.unref();
        let closed = false;
        pair.close = () => {
          if (closed) return;
          closed = true;
          clearTimeout(timer);
          pairs.delete(pair);
          downstream.terminate();
          pair.upstream?.terminate();
        };
        pairs.add(pair);
        const forward = (target: WebSocket, data: RawData, binary: boolean) => {
          if (
            !isCurrent(pair.registration) ||
            target.readyState !== WebSocket.OPEN ||
            target.bufferedAmount + dataLength(data) > maxQueued
          ) {
            pair.close();
            return;
          }
          target.send(data, { binary }, (error) => {
            if (error) pair.close();
          });
        };
        downstream.on("error", pair.close);
        downstream.on("close", pair.close);
        downstream.on("message", (data, binary) => {
          if (pair.registration) {
            if (pair.upstream) forward(pair.upstream, data, binary);
            else pair.close();
            return;
          }
          if (binary || dataLength(data) > 4096) {
            pair.close();
            return;
          }
          let frame;
          try {
            frame = (
              path === "/v1/terminal/pane-streams/redeem"
                ? PaneStreamRedeemFrameSchemaZ
                : attachmentRedeem
            ).parse(JSON.parse(data.toString()));
          } catch {
            pair.close();
            return;
          }
          expire();
          const registration = tickets.get(frame.ticket);
          if (
            !registration ||
            registration.descriptor.requestId !== frame.requestId ||
            registration.descriptor.daemonInstanceId !== frame.daemonInstanceId ||
            new URL(registration.descriptor.webSocketUrl).pathname !== path ||
            registration.descriptor.subprotocol !== downstream.protocol
          ) {
            pair.close();
            return;
          }
          tickets.delete(frame.ticket);
          pair.registration = registration;
          const upstream = (pair.upstream = new WebSocket(
            registration.upstreamUrl,
            registration.descriptor.subprotocol,
            {
              origin: options.trustedOrigin,
              maxPayload: 16 * 1024 * 1024,
              perMessageDeflate: false,
              handshakeTimeout: deadline,
            },
          ));
          upstream.on("error", pair.close);
          upstream.on("close", pair.close);
          upstream.on("message", (bytes, isBinary) => forward(downstream, bytes, isBinary));
          upstream.once("open", () => {
            clearTimeout(timer);
            forward(upstream, data, false);
          });
        });
      });
    } catch {
      socket.destroy();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Relay failed to listen");
  const origin = `ws://127.0.0.1:${address.port}`;
  const retire = (predicate: (entry: Registration) => boolean) => {
    for (const [key, entry] of tickets) if (predicate(entry)) tickets.delete(key);
    for (const pair of pairs) if (pair.registration && predicate(pair.registration)) pair.close();
  };
  return {
    origin,
    register<T extends Descriptor>(
      descriptor: T,
      routing: { upstreamUrl: string; scope: string; renderer: string; isCurrent(): boolean },
    ): T {
      if (disposed) throw Error("Relay disposed");
      const parsed = z
        .union([PaneStreamIssueDescriptorSchemaZ, TerminalAttachmentIssueDescriptorSchemaZ])
        .parse(descriptor);
      const upstream = new URL(routing.upstreamUrl);
      const rewritten = { ...parsed, webSocketUrl: routing.upstreamUrl };
      z.union([PaneStreamIssueDescriptorSchemaZ, TerminalAttachmentIssueDescriptorSchemaZ]).parse(
        rewritten,
      );
      if (
        upstream.pathname !== new URL(parsed.webSocketUrl).pathname ||
        !isCurrent(routing) ||
        parsed.expiresAt <= now() ||
        parsed.expiresAt - now() > 60_000
      )
        throw Error("Invalid relay registration");
      expire();
      if (tickets.size >= maxTickets || tickets.has(parsed.redemptionTicket))
        throw Error("Relay ticket capacity exceeded or ticket duplicate");
      tickets.set(parsed.redemptionTicket, { ...routing, descriptor: parsed });
      return { ...descriptor, webSocketUrl: `${origin}${upstream.pathname}` };
    },
    retireScope: (scope: string) => retire((entry) => entry.scope === scope),
    releaseRenderer: (renderer: string) => {
      retire((entry) => entry.renderer === renderer);
      for (const pair of pairs) if (!pair.registration) pair.close();
    },
    diagnostics: () => ({ tickets: tickets.size, sockets: pairs.size }),
    async dispose() {
      if (disposed) return;
      disposed = true;
      tickets.clear();
      for (const pair of pairs) pair.close();
      wss.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
function dataLength(data: RawData): number {
  return Array.isArray(data)
    ? data.reduce((sum, part) => sum + part.length, 0)
    : data instanceof ArrayBuffer
      ? data.byteLength
      : data.length;
}

function isCurrent(value: { isCurrent(): boolean } | null): boolean {
  try {
    return value?.isCurrent() === true;
  } catch {
    return false;
  }
}
