import { describe, expect, it, vi } from "vitest";
import type {
  CanonicalTerminalReplicaUpdate,
  TerminalDeliveryEnvelope,
  TerminalDeliveryServerMessage,
} from "@tmux-ide/contracts";
import {
  blankTerminalReplicaSnapshot,
  hashTerminalReplicaSnapshot,
  TerminalDeliveryAssembler,
  createTerminalDeliveryClientState,
  admitTerminalDeliveryEnvelope,
  admitTerminalDeliveryChunk,
  completeTerminalDelivery,
  commitTerminalDelivery,
} from "@tmux-ide/core";
import {
  SessionRuntimeTerminalDeliveryHub,
  TERMINAL_DELIVERY_CONNECTION_UNACKED_BYTES,
  type TerminalDeliverySourceOwner,
} from "./terminal-delivery-hub.ts";

const generation = "00000000-0000-4000-8000-000000000001";

class Owner implements TerminalDeliverySourceOwner {
  listener: ((update: CanonicalTerminalReplicaUpdate) => void) | undefined;
  constructor(readonly pane: string) {}
  async subscribeSource(listener: (update: CanonicalTerminalReplicaUpdate) => void) {
    this.listener = listener;
    return { generation, semanticPaneId: this.pane, close: async () => {} };
  }
  /** A seed big enough that one in flight fills the connection's budget. */
  emit(revision: number, mark: string) {
    const snapshot = structuredClone(blankTerminalReplicaSnapshot(80, 24));
    snapshot.history = Array.from({ length: 400 }, () => {
      const row = structuredClone(snapshot.grid[0]!);
      for (const cell of row.cells) cell.grapheme = mark;
      return row;
    });
    this.listener!({
      type: "terminal.seed",
      workspaceName: "w",
      semanticPaneId: this.pane,
      generation,
      incarnation: `${generation}:0`,
      revision,
      cols: snapshot.cols,
      rows: snapshot.rows,
      snapshot,
      stateHash: hashTerminalReplicaSnapshot(snapshot),
      hashAlgorithm: "fnv1a64-v1",
    });
  }
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise<void>((r) => setImmediate(r));
};
/** Long enough for a cooperative seed encoding to finish and be sent. */
const quiet = () => new Promise<void>((r) => setTimeout(r, 300));

function ackFor(
  connection: Awaited<ReturnType<SessionRuntimeTerminalDeliveryHub["open"]>>,
  pane: string,
  messages: TerminalDeliveryServerMessage[],
) {
  const envelope = messages.find(
    (m): m is TerminalDeliveryEnvelope =>
      m.type === "terminal.delivery" && m.semanticPaneId === pane,
  )!;
  let admitted = admitTerminalDeliveryEnvelope(
    createTerminalDeliveryClientState(connection.negotiation.negotiated, "w", pane),
    envelope,
  );
  const assembler = new TerminalDeliveryAssembler(envelope);
  for (const m of messages)
    if (m.type === "terminal.delivery.chunk" && m.transactionId === envelope.transactionId) {
      admitted = admitTerminalDeliveryChunk(admitted, m);
      assembler.write(m);
    }
  return commitTerminalDelivery(admitted, completeTerminalDelivery(admitted, assembler)).ack;
}

const deliveredPanes = (messages: TerminalDeliveryServerMessage[]) =>
  messages
    .filter((m): m is TerminalDeliveryEnvelope => m.type === "terminal.delivery")
    .map((m) => m.semanticPaneId);

describe("one connection's unacknowledged delivery bytes", () => {
  async function setup() {
    const owners = new Map([
      ["pane-a", new Owner("pane-a")],
      ["pane-b", new Owner("pane-b")],
    ]);
    const hub = new SessionRuntimeTerminalDeliveryHub(generation, "w", (pane) => owners.get(pane)!);
    const messages: TerminalDeliveryServerMessage[] = [];
    const offer = { protocolVersions: [1], encodings: ["semantic-v1"], richPlacements: false };
    const sink = (m: TerminalDeliveryServerMessage) => {
      messages.push(m);
    };
    const b = await hub.open("client", "pane-b", offer, sink);
    const a = await hub.open("client", "pane-a", offer, sink);
    return { owners, hub, messages, a, b };
  }

  it("holds a background pane while another pane's bulk is unacknowledged", async () => {
    const { owners, hub, messages, a, b } = await setup();
    try {
      owners.get("pane-b")!.emit(0, "b");
      await settle();
      await vi.waitFor(() => expect(deliveredPanes(messages)).toEqual(["pane-b"]));
      const first = messages.find(
        (m) => m.type === "terminal.delivery",
      ) as TerminalDeliveryEnvelope;
      expect(first.representationBytes).toBeGreaterThanOrEqual(
        TERMINAL_DELIVERY_CONNECTION_UNACKED_BYTES,
      );
      owners.get("pane-a")!.emit(0, "a");
      await quiet();
      // pane-b's bytes are still in the pipe: pane-a waits instead of queueing behind them.
      expect(deliveredPanes(messages)).toEqual(["pane-b"]);
      b.ack(ackFor(b, "pane-b", messages));
      await settle();
      await vi.waitFor(() => expect(deliveredPanes(messages)).toEqual(["pane-b", "pane-a"]));
    } finally {
      await a.close();
      await b.close();
      await hub.close();
    }
  });

  it("never holds the pane the client types into", async () => {
    const { owners, hub, messages, a, b } = await setup();
    try {
      a.prioritize!();
      owners.get("pane-b")!.emit(0, "b");
      await settle();
      await vi.waitFor(() => expect(deliveredPanes(messages)).toEqual(["pane-b"]));
      owners.get("pane-a")!.emit(0, "a");
      await settle();
      await vi.waitFor(() => expect(deliveredPanes(messages)).toEqual(["pane-b", "pane-a"]));
    } finally {
      await a.close();
      await b.close();
      await hub.close();
    }
  });

  it("delivers a held pane once the bulk's connection closes", async () => {
    const { owners, hub, messages, a, b } = await setup();
    try {
      owners.get("pane-b")!.emit(0, "b");
      await settle();
      await vi.waitFor(() => expect(deliveredPanes(messages)).toEqual(["pane-b"]));
      owners.get("pane-a")!.emit(0, "a");
      await quiet();
      expect(deliveredPanes(messages)).toEqual(["pane-b"]);
      await b.close();
      await settle();
      await vi.waitFor(() => expect(deliveredPanes(messages)).toEqual(["pane-b", "pane-a"]));
    } finally {
      await a.close();
      await hub.close();
    }
  });
});
