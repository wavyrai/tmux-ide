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
  TERMINAL_DELIVERY_CONNECTION_HOLD_MS,
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
  async function setup(connectionHoldMs = 60_000, connectionCongestedMs = 0) {
    const owners = new Map([
      ["pane-a", new Owner("pane-a")],
      ["pane-b", new Owner("pane-b")],
    ]);
    const hub = new SessionRuntimeTerminalDeliveryHub(
      generation,
      "w",
      (pane) => owners.get(pane)!,
      { connectionHoldMs, connectionCongestedMs },
    );
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

  it("holds a history frame (capability 122) behind another pane's unacknowledged bulk", async () => {
    const owners = new Map([
      ["pane-a", new Owner("pane-a")],
      ["pane-b", new Owner("pane-b")],
    ]);
    const hub = new SessionRuntimeTerminalDeliveryHub(
      generation,
      "w",
      (pane) => owners.get(pane)!,
      {
        connectionHoldMs: 60_000,
        connectionCongestedMs: 0,
      },
    );
    const messages: TerminalDeliveryServerMessage[] = [];
    const sink = (m: TerminalDeliveryServerMessage) => {
      messages.push(m);
    };
    const a = await hub.open(
      "client",
      "pane-a",
      { protocolVersions: [1, 122], encodings: ["semantic-compact-v1"], richPlacements: false },
      sink,
    );
    const b = await hub.open(
      "client",
      "pane-b",
      { protocolVersions: [1], encodings: ["semantic-v1"], richPlacements: false },
      sink,
    );
    try {
      owners.get("pane-a")!.emit(0, "a");
      await quiet();
      const seed = messages.find(
        (m): m is TerminalDeliveryEnvelope =>
          m.type === "terminal.delivery" && m.semanticPaneId === "pane-a",
      )!;
      expect(seed.historyUnloaded!.rows).toBe(200);
      a.ack(ackFor(a, "pane-a", messages));
      owners.get("pane-b")!.emit(0, "b");
      await quiet();
      expect(deliveredPanes(messages)).toEqual(["pane-a", "pane-b"]);
      a.historyRequest!({
        type: "terminal.delivery.history-request",
        workspaceName: "w",
        semanticPaneId: "pane-a",
        generation,
        incarnation: seed.incarnation,
        deliveryNonce: seed.deliveryNonce,
        canonicalRevision: 0,
        unloadedRows: 200,
        maxRows: 200,
      });
      await quiet();
      // pane-b's bulk is still unacknowledged: the history waits behind it.
      expect(deliveredPanes(messages)).toEqual(["pane-a", "pane-b"]);
      b.ack(ackFor(b, "pane-b", messages));
      await vi.waitFor(() =>
        expect(deliveredPanes(messages)).toEqual(["pane-a", "pane-b", "pane-a"]),
      );
      expect(messages.filter((m) => m.type === "terminal.delivery").at(-1)).toMatchObject({
        frame: "history",
      });
    } finally {
      await a.close();
      await b.close();
      await hub.close();
    }
  });

  it("never holds another pane's live output behind an unacknowledged history frame (review of #435)", async () => {
    const owners = new Map([
      ["pane-a", new Owner("pane-a")],
      ["pane-b", new Owner("pane-b")],
    ]);
    const hub = new SessionRuntimeTerminalDeliveryHub(
      generation,
      "w",
      (pane) => owners.get(pane)!,
      {
        connectionHoldMs: 60_000,
        connectionCongestedMs: 0,
      },
    );
    const messages: TerminalDeliveryServerMessage[] = [];
    const sink = (m: TerminalDeliveryServerMessage) => {
      messages.push(m);
    };
    const offer = {
      protocolVersions: [1, 122],
      encodings: ["semantic-compact-v1" as const],
      richPlacements: false,
    };
    const a = await hub.open("client", "pane-a", offer, sink);
    const b = await hub.open("client", "pane-b", offer, sink);
    const dense = (pane: string, rows: number, revision: number) => {
      const snapshot = structuredClone(blankTerminalReplicaSnapshot(80, 24));
      let k = 0;
      snapshot.history = Array.from({ length: rows }, () => {
        const row = structuredClone(snapshot.grid[0]!);
        for (const cell of row.cells)
          cell.grapheme = String.fromCharCode(0x21 + ((k++ * 7919) % 90));
        return row;
      });
      owners.get(pane)!.listener!({
        type: "terminal.seed",
        workspaceName: "w",
        semanticPaneId: pane,
        generation,
        incarnation: `${generation}:0`,
        revision,
        cols: 80,
        rows: 24,
        snapshot,
        stateHash: hashTerminalReplicaSnapshot(snapshot),
        hashAlgorithm: "fnv1a64-v1",
      });
    };
    const last = (pane: string) =>
      messages.findLast(
        (m): m is TerminalDeliveryEnvelope =>
          m.type === "terminal.delivery" && m.semanticPaneId === pane,
      )!;
    const ackLast = (connection: typeof a, pane: string) =>
      connection.ack(ackFor(connection, pane, messages.slice(messages.indexOf(last(pane)))));
    try {
      dense("pane-a", 100, 0);
      dense("pane-b", 5000, 0);
      await vi.waitFor(() => expect(last("pane-a")).toBeDefined(), { timeout: 10_000 });
      ackLast(a, "pane-a");
      await vi.waitFor(() => expect(last("pane-b")).toBeDefined(), { timeout: 10_000 });
      ackLast(b, "pane-b");
      const seed = last("pane-b");
      b.historyRequest!({
        type: "terminal.delivery.history-request",
        workspaceName: "w",
        semanticPaneId: "pane-b",
        generation,
        incarnation: seed.incarnation,
        deliveryNonce: seed.deliveryNonce,
        canonicalRevision: 0,
        unloadedRows: seed.historyUnloaded!.rows,
        maxRows: 2000,
      });
      await vi.waitFor(() => expect(last("pane-b").frame).toBe("history"), { timeout: 10_000 });
      // The history frame is unacknowledged; pane-a's live output still goes out.
      dense("pane-a", 101, 1);
      await quiet();
      expect(last("pane-b").frame).toBe("history");
      expect(last("pane-a").canonicalRevision).toBe(1);
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

  const bulkEnvelope = (messages: TerminalDeliveryServerMessage[]) =>
    messages.find(
      (m): m is TerminalDeliveryEnvelope =>
        m.type === "terminal.delivery" && m.semanticPaneId === "pane-b",
    )!;

  it.each(["nack", "fault"] as const)(
    "releases a held pane when the bulk is answered by a %s",
    async (answer) => {
      const { owners, hub, messages, a, b } = await setup();
      try {
        owners.get("pane-b")!.emit(0, "b");
        await settle();
        await vi.waitFor(() => expect(deliveredPanes(messages)).toEqual(["pane-b"]));
        owners.get("pane-a")!.emit(0, "a");
        await quiet();
        expect(deliveredPanes(messages)).toEqual(["pane-b"]);
        const e = bulkEnvelope(messages);
        if (answer === "nack")
          b.nack({
            type: "terminal.delivery.nack",
            workspaceName: e.workspaceName,
            semanticPaneId: e.semanticPaneId,
            generation: e.generation,
            incarnation: e.incarnation,
            deliveryNonce: e.deliveryNonce,
            transactionId: e.transactionId,
            reason: "decode-failed",
            appliedRevision: -1,
          });
        // An ACK naming another transaction is a protocol fault for pane-b.
        else b.ack({ ...ackFor(b, "pane-b", messages), transactionId: crypto.randomUUID() });
        await settle();
        await vi.waitFor(() => expect(deliveredPanes(messages)).toContain("pane-a"));
      } finally {
        await a.close();
        await b.close();
        await hub.close();
      }
    },
  );

  it("never holds a pane longer than the bound while bulk keeps coming", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const { owners, hub, messages, a, b } = await setup(TERMINAL_DELIVERY_CONNECTION_HOLD_MS);
    try {
      b.prioritize!();
      owners.get("pane-b")!.emit(0, "b");
      await vi.waitFor(() => expect(deliveredPanes(messages)).toEqual(["pane-b"]));
      owners.get("pane-a")!.emit(0, "a");
      // pane-b (typed into) stays unacknowledged: without a bound pane-a
      // would wait for as long as pane-b's bulk does.
      await vi.advanceTimersByTimeAsync(TERMINAL_DELIVERY_CONNECTION_HOLD_MS - 10);
      expect(deliveredPanes(messages)).toEqual(["pane-b"]);
      await vi.advanceTimersByTimeAsync(20);
      await vi.waitFor(() => expect(deliveredPanes(messages)).toEqual(["pane-b", "pane-a"]));
    } finally {
      vi.useRealTimers();
      await a.close();
      await b.close();
      await hub.close();
    }
  });

  it("does not hold while the bulk in flight is younger than a congested link's", async () => {
    // A fast link acks bulk within a few round trips; holding then only
    // bunches panes up. Only bulk that stays unacked marks the link congested.
    const { owners, hub, messages, a, b } = await setup(60_000, 60_000);
    try {
      owners.get("pane-b")!.emit(0, "b");
      await settle();
      await vi.waitFor(() => expect(deliveredPanes(messages)).toEqual(["pane-b"]));
      owners.get("pane-a")!.emit(0, "a");
      await vi.waitFor(() => expect(deliveredPanes(messages)).toEqual(["pane-b", "pane-a"]));
    } finally {
      await a.close();
      await b.close();
      await hub.close();
    }
  });

  it("counts the bound from the first hold, across a release and a re-hold", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const owners = new Map(["pane-b", "pane-c", "pane-a"].map((p) => [p, new Owner(p)]));
    const hub = new SessionRuntimeTerminalDeliveryHub(
      generation,
      "w",
      (pane) => owners.get(pane)!,
      {
        connectionHoldMs: TERMINAL_DELIVERY_CONNECTION_HOLD_MS,
        connectionCongestedMs: 0,
      },
    );
    const messages: TerminalDeliveryServerMessage[] = [];
    const offer = { protocolVersions: [1], encodings: ["semantic-v1"], richPlacements: false };
    const sink = (m: TerminalDeliveryServerMessage) => {
      messages.push(m);
    };
    // Fake time moves only when this test moves it.
    const until = async (done: () => boolean) => {
      for (let n = 0; n < 2000 && !done(); n++) await vi.advanceTimersByTimeAsync(1);
      expect(done()).toBe(true);
    };
    // Opened in this order, so a release tries pane-c before pane-a.
    const b = await hub.open("client", "pane-b", offer, sink);
    const c = await hub.open("client", "pane-c", offer, sink);
    const a = await hub.open("client", "pane-a", offer, sink);
    try {
      b.prioritize!();
      owners.get("pane-b")!.emit(0, "b");
      await until(() => deliveredPanes(messages).length === 1);
      owners.get("pane-c")!.emit(0, "c");
      owners.get("pane-a")!.emit(0, "a");
      await vi.advanceTimersByTimeAsync(5);
      const firstHold = Date.now();
      await vi.advanceTimersByTimeAsync(95);
      expect(deliveredPanes(messages)).toEqual(["pane-b"]);
      // pane-b's ack releases both; pane-c goes first and its bulk holds
      // pane-a again. That second hold must not restart pane-a's bound.
      b.ack(ackFor(b, "pane-b", messages));
      await until(() => deliveredPanes(messages).length >= 2);
      expect(deliveredPanes(messages)).toEqual(["pane-b", "pane-c"]);
      await until(() => deliveredPanes(messages).length === 3);
      expect(deliveredPanes(messages)).toEqual(["pane-b", "pane-c", "pane-a"]);
      expect(Date.now() - firstHold).toBeLessThanOrEqual(TERMINAL_DELIVERY_CONNECTION_HOLD_MS + 10);
    } finally {
      vi.useRealTimers();
      await a.close();
      await b.close();
      await c.close();
      await hub.close();
    }
  });
});
