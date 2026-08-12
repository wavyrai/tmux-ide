import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonEventServerFrameSchemaZ, type DaemonEventServerFrame } from "@tmux-ide/contracts";
import {
  _detachProjectRegistryListenerForTests,
  _pollFleetFactsObserverForTests,
  _setFleetFactsReadersForTests,
  _stopFleetFactsObserverForTests,
  handleWsEventsConnection,
} from "../../command-center/ws-events.ts";
import { _setTmuxRunner } from "../../command-center/discovery.ts";
import { agentIdForPaneStamp } from "../../command-center/resources/application-shell.ts";
import { parseAgentStateFacts } from "../../command-center/daemon-fleet-facts-observer.ts";

// Hermetic like ws-events-protocol.test.ts: the connection eagerly discovers
// sessions and starts pollers that would otherwise spawn `tmux` against the
// caller's real socket. This runner answers only the watcher's agent-state
// query (session \t %pane \t @tmux_ide_pane_id \t @agent_state) and returns ""
// for everything else (empty session discovery), so no real tmux server is
// ever touched.
function pinAgentStates(rows: () => string): () => void {
  const restore = _setTmuxRunner(() => "");
  _setFleetFactsReadersForTests({
    readSessions: async () => ({ sessions: [], adopted: [] }),
    readAgents: async () => parseAgentStateFacts(rows()),
  });
  return () => {
    _setFleetFactsReadersForTests(null);
    restore();
  };
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
  _stopFleetFactsObserverForTests();
  _detachProjectRegistryListenerForTests();
  restoreTmuxRunner?.();
  restoreTmuxRunner = null;
});

describe("/ws/events agent-status invalidation", () => {
  it("emits exactly one agent-status.changed frame when a pane state transitions", async () => {
    let agentRows = "zz-fleet\t%1\t\tworking:1000";
    restoreTmuxRunner = pinAgentStates(() => agentRows);

    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity); // primes the baseline (working)
    subscribeLegacy(socket);
    await _pollFleetFactsObserverForTests();
    socket.sent.length = 0;

    // A genuine transition: working -> blocked on the same pane.
    agentRows = "zz-fleet\t%1\t\tblocked:1001";
    await _pollFleetFactsObserverForTests();

    const agentFrames = frames(socket).filter((frame) => frame.type === "agent-status.changed");
    expect(agentFrames).toEqual([{ type: "agent-status.changed", sessionName: "zz-fleet" }]);

    socket.disconnect();
  });

  it("does not emit for an epoch-only re-stamp of the same state word", async () => {
    let agentRows = "zz-fleet\t%1\t\tworking:1000";
    restoreTmuxRunner = pinAgentStates(() => agentRows);

    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity);
    subscribeLegacy(socket);
    await _pollFleetFactsObserverForTests();
    socket.sent.length = 0;

    agentRows = "zz-fleet\t%1\t\tworking:2000"; // same word, new epoch
    await _pollFleetFactsObserverForTests();

    expect(frames(socket).filter((frame) => frame.type === "agent-status.changed")).toEqual([]);
    expect(frames(socket).filter((frame) => frame.type === "agent.turn-completed")).toEqual([]);

    socket.disconnect();
  });

  it("coalesces multiple panes flipping in one tick into a single frame per session", async () => {
    let agentRows = ["zz-fleet\t%1\t\tidle:1", "zz-fleet\t%2\t\tidle:1"].join("\n");
    restoreTmuxRunner = pinAgentStates(() => agentRows);

    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity);
    subscribeLegacy(socket);
    await _pollFleetFactsObserverForTests();
    socket.sent.length = 0;

    agentRows = ["zz-fleet\t%1\t\tworking:2", "zz-fleet\t%2\t\tblocked:2"].join("\n");
    await _pollFleetFactsObserverForTests();

    expect(frames(socket).filter((frame) => frame.type === "agent-status.changed")).toEqual([
      { type: "agent-status.changed", sessionName: "zz-fleet" },
    ]);

    socket.disconnect();
  });

  it("stops the watcher after the last client disconnects", async () => {
    restoreTmuxRunner = pinAgentStates(() => "zz-fleet\t%1\t\tworking:1");

    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity);
    subscribeLegacy(socket);
    await _pollFleetFactsObserverForTests();
    socket.disconnect();

    // With no clients, a poll cycle must be inert — no watcher, no frames.
    socket.sent.length = 0;
    await _pollFleetFactsObserverForTests();
    expect(socket.sent).toEqual([]);
  });
});

describe("/ws/events agent.turn-completed receipts", () => {
  it("emits a typed receipt with the minted durable agent id on working -> done", async () => {
    const stamp = "pane.promoted.aaaaaaaaaaaaaaaaaaaa";
    let agentRows = `zz-fleet\t%1\t${stamp}\tworking:1000`;
    restoreTmuxRunner = pinAgentStates(() => agentRows);

    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity);
    subscribeLegacy(socket);
    await _pollFleetFactsObserverForTests();
    socket.sent.length = 0;

    agentRows = `zz-fleet\t%1\t${stamp}\tdone:1001`;
    await _pollFleetFactsObserverForTests();

    const receipts = frames(socket).filter((frame) => frame.type === "agent.turn-completed");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      type: "agent.turn-completed",
      sessionName: "zz-fleet",
      agentId: agentIdForPaneStamp(stamp),
      fromStatus: "working",
      toStatus: "done",
    });
    // The invalidation still fires alongside the receipt — receipts are
    // additive, not a replacement for the re-fetch hint.
    expect(frames(socket).filter((frame) => frame.type === "agent-status.changed")).toEqual([
      { type: "agent-status.changed", sessionName: "zz-fleet" },
    ]);

    socket.disconnect();
  });

  it("emits a receipt with a null agent id for an unstamped pane on working -> idle", async () => {
    let agentRows = "zz-fleet\t%1\t\tworking:1000";
    restoreTmuxRunner = pinAgentStates(() => agentRows);

    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity);
    subscribeLegacy(socket);
    await _pollFleetFactsObserverForTests();
    socket.sent.length = 0;

    agentRows = "zz-fleet\t%1\t\tidle:1001";
    await _pollFleetFactsObserverForTests();

    const receipts = frames(socket).filter((frame) => frame.type === "agent.turn-completed");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      sessionName: "zz-fleet",
      agentId: null,
      fromStatus: "working",
      toStatus: "idle",
    });

    socket.disconnect();
  });

  it("emits no receipt for a non-completing transition", async () => {
    let agentRows = "zz-fleet\t%1\t\tworking:1000";
    restoreTmuxRunner = pinAgentStates(() => agentRows);

    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity);
    subscribeLegacy(socket);
    await _pollFleetFactsObserverForTests();
    socket.sent.length = 0;

    agentRows = "zz-fleet\t%1\t\tblocked:1001"; // needs attention, turn not over
    await _pollFleetFactsObserverForTests();

    expect(frames(socket).filter((frame) => frame.type === "agent.turn-completed")).toEqual([]);

    socket.disconnect();
  });

  it("wire audit: a receipt never carries a raw tmux id, a raw stamp, or a path", async () => {
    const stamp = "pane.promoted.bbbbbbbbbbbbbbbbbbbb";
    let agentRows = `zz-fleet\t%7\t${stamp}\tworking:1000`;
    restoreTmuxRunner = pinAgentStates(() => agentRows);

    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity);
    subscribeLegacy(socket);
    await _pollFleetFactsObserverForTests();
    socket.sent.length = 0;

    agentRows = `zz-fleet\t%7\t${stamp}\tdone:1001`;
    await _pollFleetFactsObserverForTests();

    const receipts = socket.sent.filter((raw) => raw.includes("agent.turn-completed"));
    expect(receipts).toHaveLength(1);
    // No tmux runtime id (%7, $N, @N), no raw pane stamp, no filesystem path.
    expect(receipts[0]).not.toMatch(/[$%@][0-9]+/u);
    expect(receipts[0]).not.toContain(stamp);
    expect(receipts[0]).not.toContain("/");

    socket.disconnect();
  });
});
