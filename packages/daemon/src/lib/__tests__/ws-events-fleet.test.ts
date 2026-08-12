import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonEventServerFrameSchemaZ, type DaemonEventServerFrame } from "@tmux-ide/contracts";
import {
  _detachProjectRegistryListenerForTests,
  _pollFleetCompositionForTests,
  _stopAgentStatusWatcherForTests,
  _stopFleetPollerForTests,
  _stopSessionsPollerForTests,
  handleWsEventsConnection,
} from "../../command-center/ws-events.ts";
import { _setTmuxRunner } from "../../command-center/discovery.ts";

// Hermetic like ws-events-agent-status.test.ts: answer only the adopted-session
// listing the fleet poller issues and return "" for everything else, so no real
// tmux server is ever touched.
function pinAdoptedSessions(rows: () => string): () => void {
  return _setTmuxRunner((args) => {
    if (args[0] === "list-sessions") return rows();
    return "";
  });
}

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

function subscribeLegacy(socket: ProtocolWebSocket): void {
  socket.receive(JSON.stringify({ type: "subscribe", sessions: [] }));
}

let restoreTmuxRunner: (() => void) | null = null;

afterEach(() => {
  _stopFleetPollerForTests();
  _stopAgentStatusWatcherForTests();
  _stopSessionsPollerForTests();
  _detachProjectRegistryListenerForTests();
  restoreTmuxRunner?.();
  restoreTmuxRunner = null;
});

describe("/ws/events fleet composition invalidation", () => {
  it("emits fleet.changed when an adopted session appears", () => {
    let sessionRows = "alpha\t1";
    restoreTmuxRunner = pinAdoptedSessions(() => sessionRows);

    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity); // primes the baseline (alpha)
    subscribeLegacy(socket);
    socket.sent.length = 0;

    // A newly adopted, registry-independent session appears.
    sessionRows = ["alpha\t1", "beta\t1"].join("\n");
    _pollFleetCompositionForTests();

    expect(frames(socket).filter((frame) => frame.type === "fleet.changed")).toEqual([
      { type: "fleet.changed" },
    ]);

    socket.disconnect();
  });

  it("emits fleet.changed when an adopted session disappears", () => {
    let sessionRows = ["alpha\t1", "beta\t1"].join("\n");
    restoreTmuxRunner = pinAdoptedSessions(() => sessionRows);

    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity);
    subscribeLegacy(socket);
    socket.sent.length = 0;

    sessionRows = "alpha\t1"; // beta killed
    _pollFleetCompositionForTests();

    expect(frames(socket).filter((frame) => frame.type === "fleet.changed")).toEqual([
      { type: "fleet.changed" },
    ]);

    socket.disconnect();
  });

  it("does not emit when the adopted set is unchanged", () => {
    restoreTmuxRunner = pinAdoptedSessions(() => "alpha\t1");

    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity);
    subscribeLegacy(socket);
    socket.sent.length = 0;

    _pollFleetCompositionForTests();

    expect(frames(socket).filter((frame) => frame.type === "fleet.changed")).toEqual([]);

    socket.disconnect();
  });

  it("ignores internal and scratch sessions in composition", () => {
    let sessionRows = "alpha\t1";
    restoreTmuxRunner = pinAdoptedSessions(() => sessionRows);

    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity);
    subscribeLegacy(socket);
    socket.sent.length = 0;

    // Only filtered (`_`/`zz-`) sessions changed — the visible fleet is the same.
    sessionRows = ["alpha\t1", "_tmux-ide-chrome\t1", "zz-scratch\t1"].join("\n");
    _pollFleetCompositionForTests();

    expect(frames(socket).filter((frame) => frame.type === "fleet.changed")).toEqual([]);

    socket.disconnect();
  });

  it("stops the poller after the last client disconnects", () => {
    let sessionRows = "alpha\t1";
    restoreTmuxRunner = pinAdoptedSessions(() => sessionRows);

    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity);
    subscribeLegacy(socket);
    socket.disconnect();

    socket.sent.length = 0;
    sessionRows = ["alpha\t1", "beta\t1"].join("\n");
    _pollFleetCompositionForTests();
    expect(socket.sent).toEqual([]);
  });
});
