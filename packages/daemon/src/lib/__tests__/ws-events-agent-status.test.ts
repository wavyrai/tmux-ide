import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonEventServerFrameSchemaZ, type DaemonEventServerFrame } from "@tmux-ide/contracts";
import {
  _detachProjectRegistryListenerForTests,
  _stopAgentStatusWatcherForTests,
  _stopSessionsPollerForTests,
  _tickAgentStatusWatcherForTests,
  handleWsEventsConnection,
} from "../../command-center/ws-events.ts";
import { _setTmuxRunner } from "../../command-center/discovery.ts";

// Hermetic like ws-events-protocol.test.ts: the connection eagerly discovers
// sessions and starts pollers that would otherwise spawn `tmux` against the
// caller's real socket. This runner answers only the watcher's agent-state
// query and returns "" for everything else (empty session discovery), so no
// real tmux server is ever touched.
function pinAgentStates(rows: () => string): () => void {
  return _setTmuxRunner((args) => {
    if (args[0] === "list-panes" && args[1] === "-a") return rows();
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

  disconnect(): void {
    this.readyState = 3;
    this.emit("close");
  }
}

function frames(socket: ProtocolWebSocket): DaemonEventServerFrame[] {
  return socket.sent.map((value) => DaemonEventServerFrameSchemaZ.parse(JSON.parse(value)));
}

let restoreTmuxRunner: (() => void) | null = null;

afterEach(() => {
  _stopAgentStatusWatcherForTests();
  _stopSessionsPollerForTests();
  _detachProjectRegistryListenerForTests();
  restoreTmuxRunner?.();
  restoreTmuxRunner = null;
});

describe("/ws/events agent-status invalidation", () => {
  it("emits exactly one agent-status.changed frame when a pane state transitions", () => {
    let agentRows = "zz-fleet\t%1\tworking:1000";
    restoreTmuxRunner = pinAgentStates(() => agentRows);

    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity); // primes the baseline (working)
    socket.sent.length = 0;

    // A genuine transition: working -> done on the same pane.
    agentRows = "zz-fleet\t%1\tdone:1001";
    _tickAgentStatusWatcherForTests();

    const agentFrames = frames(socket).filter((frame) => frame.type === "agent-status.changed");
    expect(agentFrames).toEqual([{ type: "agent-status.changed", sessionName: "zz-fleet" }]);

    socket.disconnect();
  });

  it("does not emit for an epoch-only re-stamp of the same state word", () => {
    let agentRows = "zz-fleet\t%1\tworking:1000";
    restoreTmuxRunner = pinAgentStates(() => agentRows);

    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity);
    socket.sent.length = 0;

    agentRows = "zz-fleet\t%1\tworking:2000"; // same word, new epoch
    _tickAgentStatusWatcherForTests();

    expect(frames(socket).filter((frame) => frame.type === "agent-status.changed")).toEqual([]);

    socket.disconnect();
  });

  it("coalesces multiple panes flipping in one tick into a single frame per session", () => {
    let agentRows = ["zz-fleet\t%1\tidle:1", "zz-fleet\t%2\tidle:1"].join("\n");
    restoreTmuxRunner = pinAgentStates(() => agentRows);

    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity);
    socket.sent.length = 0;

    agentRows = ["zz-fleet\t%1\tworking:2", "zz-fleet\t%2\tblocked:2"].join("\n");
    _tickAgentStatusWatcherForTests();

    expect(frames(socket).filter((frame) => frame.type === "agent-status.changed")).toEqual([
      { type: "agent-status.changed", sessionName: "zz-fleet" },
    ]);

    socket.disconnect();
  });

  it("stops the watcher after the last client disconnects", () => {
    restoreTmuxRunner = pinAgentStates(() => "zz-fleet\t%1\tworking:1");

    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity);
    socket.disconnect();

    // With no clients, a poll cycle must be inert — no watcher, no frames.
    socket.sent.length = 0;
    _tickAgentStatusWatcherForTests();
    expect(socket.sent).toEqual([]);
  });
});
