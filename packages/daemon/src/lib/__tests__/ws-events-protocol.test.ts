import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonEventServerFrameSchemaZ, type DaemonEventServerFrame } from "@tmux-ide/contracts";
import {
  _detachProjectRegistryListenerForTests,
  _stopSessionsPollerForTests,
  handleWsEventsConnection,
} from "../../command-center/ws-events.ts";

const daemonIdentity = {
  protocolVersion: 1,
  productVersion: "2.8.0",
  instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
  startedAt: "2026-07-21T00:00:00.000Z",
} as const;

class ProtocolWebSocket extends EventEmitter {
  readyState = 1;
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  receive(data: string): void {
    this.emit("message", data, false);
  }

  disconnect(): void {
    this.readyState = 3;
    this.emit("close");
  }
}

function frames(socket: ProtocolWebSocket): DaemonEventServerFrame[] {
  return socket.sent.map((value) => DaemonEventServerFrameSchemaZ.parse(JSON.parse(value)));
}

afterEach(() => {
  _stopSessionsPollerForTests();
  _detachProjectRegistryListenerForTests();
});

describe("/ws/events client frame protocol", () => {
  it("binds the initial hello to the supplied daemon generation", () => {
    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity);

    expect(frames(socket)[0]).toMatchObject({ type: "hello", daemon: daemonIdentity });
    socket.disconnect();
  });

  it("reports malformed JSON deterministically and keeps the socket usable", () => {
    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity);
    socket.sent.length = 0;

    socket.receive("not-json");
    socket.receive(JSON.stringify({ type: "ping" }));

    expect(frames(socket)).toEqual([
      {
        type: "protocol.error",
        code: "invalid-json",
        message: "Client frame must be valid JSON.",
      },
      { type: "pong" },
    ]);
    socket.disconnect();
  });

  it("rejects malformed subscribe frames without throwing or changing subscription state", () => {
    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity);
    socket.sent.length = 0;

    expect(() => socket.receive(JSON.stringify({ type: "subscribe" }))).not.toThrow();
    expect(() =>
      socket.receive(JSON.stringify({ type: "subscribe", sessions: "tmux-ide", unexpected: true })),
    ).not.toThrow();
    socket.receive(JSON.stringify({ type: "ping" }));

    expect(frames(socket)).toEqual([
      {
        type: "protocol.error",
        code: "invalid-frame",
        message: "Client frame does not match the daemon event protocol.",
      },
      {
        type: "protocol.error",
        code: "invalid-frame",
        message: "Client frame does not match the daemon event protocol.",
      },
      { type: "pong" },
    ]);
    socket.disconnect();
  });

  it("rejects unknown and extra client fields rather than accepting structural lookalikes", () => {
    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity);
    socket.sent.length = 0;

    socket.receive(JSON.stringify({ type: "ping", extra: true }));
    socket.receive(JSON.stringify({ type: "future.event" }));

    expect(frames(socket).map(({ type }) => type)).toEqual(["protocol.error", "protocol.error"]);
    socket.disconnect();
  });
});
