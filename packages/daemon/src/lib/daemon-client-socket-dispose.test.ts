import { createServer, type Socket } from "node:net";
import { createHash } from "node:crypto";
import { once } from "node:events";
import WebSocket from "ws";
import { afterEach, expect, it } from "vitest";
import { DAEMON_WIRE_PROTOCOL_VERSION } from "@tmux-ide/contracts";
import { createDirectLoopbackDaemonTransport } from "@tmux-ide/daemon-client/direct-application-shell-transport";
import {
  connectIssuedPaneStreamRuntimeClient,
  type PaneStreamClientSocket,
} from "@tmux-ide/daemon-client/pane-stream-client";

// Production builds these sockets with `ws`, an EventEmitter. Closing a `ws`
// socket emits 'error' when it is still connecting, or when the peer sends a
// bad frame after the close; with no 'error' listener left, that error is an
// uncaught exception in the host process (card #868, after PR #469).

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const daemon = {
  protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
  productVersion: "test-peer",
  instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
  startedAt: "2026-11-25T12:00:00.000Z",
};

const eventHandlers = {
  onVerifiedOpen: () => undefined,
  onInvalidate: () => undefined,
  onMalformedFrame: () => undefined,
  onPeerMismatch: () => undefined,
  onProtocolError: () => undefined,
  onClose: () => undefined,
  onError: () => undefined,
};

// A peer that accepts TCP and then runs `onConnection`; by default it never
// answers the upgrade, which keeps the client socket CONNECTING.
async function peer(onConnection: (connection: Socket) => void = () => undefined) {
  const held: Socket[] = [];
  const server = createServer((connection) => {
    held.push(connection);
    onConnection(connection);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const accepted = once(server, "connection");
  cleanups.push(async () => {
    for (const connection of held) connection.destroy();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No peer address");
  return { port: address.port, accepted };
}

// Records an 'error' emitted while the socket has no 'error' listener, which
// is what would kill the host process, instead of throwing it.
function trackUnhandledErrors(socket: WebSocket) {
  const unhandled: unknown[] = [];
  const emit = socket.emit.bind(socket);
  socket.emit = ((type: string | symbol, ...args: unknown[]) => {
    if (type === "error" && socket.listenerCount("error") === 0) {
      unhandled.push(args[0]);
      return false;
    }
    return emit(type, ...args);
  }) as typeof socket.emit;
  // Not events.once: it adds its own 'error' listener and would hide the bug.
  const closed = new Promise<void>((done) => socket.once("close", () => done()));
  return { unhandled, closed };
}

function textFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const header = Buffer.from([0x81, 126, 0, 0]);
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

it("closes a fallback event connection whose socket is still connecting without an unhandled error", async () => {
  const silent = await peer();
  let socket!: WebSocket;
  const transport = createDirectLoopbackDaemonTransport({
    descriptor: { ...daemon, apiBaseUrl: `http://127.0.0.1:${silent.port}/` },
    resolveSessionName: () => "alpha",
    createWebSocket: (url) => {
      socket = new WebSocket(url);
      return socket as never;
    },
    fetch: () => Promise.reject(new Error("no fetch")),
  });
  const connection = transport.connectEvents({ daemon, workspaceName: "alpha" }, eventHandlers);
  const { unhandled, closed } = trackUnhandledErrors(socket);
  await silent.accepted;
  expect(socket.readyState).toBe(WebSocket.CONNECTING);
  connection.close();
  await closed;
  expect(unhandled.map(String)).toEqual([]);
});

// The mismatch close runs from a message handler, so this socket is OPEN,
// never CONNECTING. A peer that then sends a bad frame makes `ws` emit 'error'.
it("closes an event connection on a daemon mismatch without an unhandled error when the peer then sends a bad frame", async () => {
  const mismatched = await peer((connection) => {
    connection.once("data", (request) => {
      const key = /sec-websocket-key: *(\S+)/i.exec(request.toString())?.[1] ?? "";
      const accept = createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      const hello = JSON.stringify({
        type: "hello",
        daemon: { ...daemon, instanceId: "00000000-0000-4000-8000-000000000000" },
        sessions: [],
        eventSequence: 0,
      });
      connection.write(
        Buffer.concat([
          Buffer.from(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
              `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
          ),
          textFrame(hello),
          // Opcode 3 is reserved: the client's frame parser rejects it.
          Buffer.from([0x83, 0x00]),
        ]),
      );
    });
  });
  let socket!: WebSocket;
  const mismatches: string[] = [];
  const transport = createDirectLoopbackDaemonTransport({
    descriptor: { ...daemon, apiBaseUrl: `http://127.0.0.1:${mismatched.port}/` },
    resolveSessionName: () => "alpha",
    createWebSocket: (url) => {
      socket = new WebSocket(url);
      return socket as never;
    },
    fetch: () => Promise.reject(new Error("no fetch")),
  });
  transport.connectEvents(
    { daemon, workspaceName: "alpha" },
    { ...eventHandlers, onPeerMismatch: (reason) => void mismatches.push(reason) },
  );
  const { unhandled, closed } = trackUnhandledErrors(socket);
  await closed;
  expect(mismatches).toEqual(["Daemon event hello did not match the desktop host descriptor."]);
  expect(unhandled.map(String)).toEqual([]);
});

it("aborts a pane-stream connection whose socket is still connecting without an unhandled error", async () => {
  const silent = await peer();
  let socket!: WebSocket;
  const abort = new AbortController();
  const connecting = connectIssuedPaneStreamRuntimeClient(
    {
      origin: "http://127.0.0.1",
      hostClientId: "tui:one",
      signal: abort.signal,
      stream: {
        protocolVersion: 2,
        workspaceName: "alpha",
        panes: ["pane.editor"],
        viewerMode: "interactive",
        terminalDelivery: {
          protocolVersions: [1],
          encodings: ["semantic-v1"],
          richPlacements: false,
        },
      },
      createSocket: (descriptor, headers) => {
        socket = new WebSocket(descriptor.webSocketUrl, descriptor.subprotocol, { headers });
        return socket as unknown as PaneStreamClientSocket;
      },
    },
    {
      protocolVersion: 2,
      webSocketUrl: `ws://127.0.0.1:${silent.port}/v2/terminal/pane-streams/redeem`,
      subprotocol: "tmux-ide-pane-stream.v2",
      redemptionTicket: `ps2_${"a".repeat(43)}`,
      daemonInstanceId: daemon.instanceId,
      requestId: "22222222-2222-4222-8222-222222222222",
      expiresAt: Date.now() + 5_000,
      panes: ["pane.editor"],
      effectiveViewerMode: "interactive",
    },
  );
  const { unhandled, closed } = trackUnhandledErrors(socket);
  await silent.accepted;
  expect(socket.readyState).toBe(WebSocket.CONNECTING);
  abort.abort(new Error("test aborted"));
  await expect(connecting).rejects.toThrow("test aborted");
  await closed;
  expect(unhandled.map(String)).toEqual([]);
});
