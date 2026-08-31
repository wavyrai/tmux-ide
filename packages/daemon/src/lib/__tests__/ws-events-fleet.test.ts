import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonEventServerFrameSchemaZ, type DaemonEventServerFrame } from "@tmux-ide/contracts";
import {
  _detachProjectRegistryListenerForTests,
  _pollFleetFactsObserverForTests,
  _setFleetFactsReadersForTests,
  _stopFleetFactsObserverForTests,
  handleWsEventsConnection,
  setFleetFactsTmuxRunner,
} from "../../command-center/ws-events.ts";
import { _setTmuxRunner } from "../../command-center/discovery.ts";
import {
  AGENT_STATE_TMUX_ARGS,
  parseSessionCompositionFacts,
  SESSION_COMPOSITION_TMUX_ARGS,
} from "../../command-center/daemon-fleet-facts-observer.ts";

// Hermetic like ws-events-agent-status.test.ts: answer only the adopted-session
// listing the fleet poller issues and return "" for everything else, so no real
// tmux server is ever touched.
function pinAdoptedSessions(rows: () => string): () => void {
  const restore = _setTmuxRunner(() => "");
  _setFleetFactsReadersForTests({
    readSessions: async () => parseSessionCompositionFacts(rows()),
    readAgents: async () => new Map(),
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
  setFleetFactsTmuxRunner(null);
  restoreTmuxRunner?.();
  restoreTmuxRunner = null;
});

describe("/ws/events fleet composition invalidation", () => {
  it("pins Home catalog invalidation to its daemon tmux authority", async () => {
    let sessionRows = "alpha\t0\t41\t$0\t100\t@1\t%1\t1\t1\tpane.a\twindow.a";
    const runTmux = (args: readonly string[]) => {
      expect(args).toEqual(SESSION_COMPOSITION_TMUX_ARGS);
      return sessionRows;
    };
    setFleetFactsTmuxRunner(runTmux);

    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity, { mode: "semantic" });
    socket.receive(
      JSON.stringify({
        type: "subscribe",
        sessions: [],
        interests: [{ resource: "workspace-catalog", workspaceName: null }],
        legacyEvents: false,
        interestRevision: 1,
      }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    socket.sent.length = 0;

    sessionRows = "alpha\t0\t42\t$0\t101\t@1\t%1\t1\t1\tpane.a\twindow.a";
    await _pollFleetFactsObserverForTests();
    expect(
      frames(socket).filter(
        (frame) => frame.type === "resource.changed" && frame.resource === "workspace-catalog",
      ),
    ).toHaveLength(1);
    socket.disconnect();
  });

  it("pins application-shell agent readiness to its daemon tmux authority", async () => {
    const calls: string[][] = [];
    setFleetFactsTmuxRunner((args) => {
      calls.push([...args]);
      return args === AGENT_STATE_TMUX_ARGS ? "alpha\t%1\tpane.a\tIDLE\tcodex" : "";
    });

    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity, { mode: "semantic" });
    socket.receive(
      JSON.stringify({
        type: "subscribe",
        sessions: [],
        interests: [{ resource: "application-shell", workspaceName: "alpha" }],
        legacyEvents: false,
        interestRevision: 1,
      }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(calls).toContainEqual([...AGENT_STATE_TMUX_ARGS]);
    expect(
      frames(socket).some(
        (frame) => frame.type === "resource.interests-ack" && frame.interestRevision === 1,
      ),
    ).toBe(true);
    socket.disconnect();
  });

  it("keeps session composition to one compact tmux query", () => {
    expect(SESSION_COMPOSITION_TMUX_ARGS).toEqual([
      "list-panes",
      "-a",
      "-F",
      "#{session_name}\t#{@tmux_ide_adopted}\t#{pid}\t#{session_id}\t#{session_created}\t#{window_id}\t#{pane_id}\t#{window_panes}\t#{session_windows}\t#{@tmux_ide_pane_id}\t#{@tmux_ide_window_id}",
    ]);
  });

  it("emits fleet.changed when an adopted session appears", async () => {
    let sessionRows = "alpha\t1";
    restoreTmuxRunner = pinAdoptedSessions(() => sessionRows);

    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity); // primes the baseline (alpha)
    subscribeLegacy(socket);
    await _pollFleetFactsObserverForTests();
    socket.sent.length = 0;

    // A newly adopted, registry-independent session appears.
    sessionRows = ["alpha\t1", "beta\t1"].join("\n");
    await _pollFleetFactsObserverForTests();

    expect(frames(socket).filter((frame) => frame.type === "fleet.changed")).toEqual([
      { type: "fleet.changed" },
    ]);

    socket.disconnect();
  });

  it("emits fleet.changed when an adopted session disappears", async () => {
    let sessionRows = ["alpha\t1", "beta\t1"].join("\n");
    restoreTmuxRunner = pinAdoptedSessions(() => sessionRows);

    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity);
    subscribeLegacy(socket);
    await _pollFleetFactsObserverForTests();
    socket.sent.length = 0;

    sessionRows = "alpha\t1"; // beta killed
    await _pollFleetFactsObserverForTests();

    expect(frames(socket).filter((frame) => frame.type === "fleet.changed")).toEqual([
      { type: "fleet.changed" },
    ]);

    socket.disconnect();
  });

  it("does not emit when the adopted set is unchanged", async () => {
    restoreTmuxRunner = pinAdoptedSessions(() => "alpha\t1");

    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity);
    subscribeLegacy(socket);
    await _pollFleetFactsObserverForTests();
    socket.sent.length = 0;

    await _pollFleetFactsObserverForTests();

    expect(frames(socket).filter((frame) => frame.type === "fleet.changed")).toEqual([]);

    socket.disconnect();
  });

  it("ignores internal and scratch sessions in composition", async () => {
    let sessionRows = "alpha\t1";
    restoreTmuxRunner = pinAdoptedSessions(() => sessionRows);

    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity);
    subscribeLegacy(socket);
    await _pollFleetFactsObserverForTests();
    socket.sent.length = 0;

    // Only filtered (`_`/`zz-`) sessions changed — the visible fleet is the same.
    sessionRows = ["alpha\t1", "_tmux-ide-chrome\t1", "zz-scratch\t1"].join("\n");
    await _pollFleetFactsObserverForTests();

    expect(frames(socket).filter((frame) => frame.type === "fleet.changed")).toEqual([]);

    socket.disconnect();
  });

  it("stops the poller after the last client disconnects", async () => {
    let sessionRows = "alpha\t1";
    restoreTmuxRunner = pinAdoptedSessions(() => sessionRows);

    const socket = new ProtocolWebSocket();
    handleWsEventsConnection(socket, daemonIdentity);
    subscribeLegacy(socket);
    await _pollFleetFactsObserverForTests();
    socket.disconnect();

    socket.sent.length = 0;
    sessionRows = ["alpha\t1", "beta\t1"].join("\n");
    await _pollFleetFactsObserverForTests();
    expect(socket.sent).toEqual([]);
  });
});
