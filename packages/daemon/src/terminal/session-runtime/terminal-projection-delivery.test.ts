import { describe, expect, it } from "vitest";
import {
  blankTerminalReplicaSnapshot,
  commitTerminalProjection,
  decodeBinarySemanticTerminalUpdate,
  encodeBinarySemanticTerminalUpdate,
  hashTerminalReplicaSnapshot,
  type TerminalProjectionState,
} from "@tmux-ide/core";
import type {
  CanonicalTerminalReplicaUpdate,
  TerminalDeliveryAck,
  TerminalDeliveryEnvelope,
  TerminalDeliveryServerMessage,
  TerminalProjectionEnvelope,
  TerminalReplicaSnapshot,
} from "@tmux-ide/contracts";
import {
  SessionRuntimeTerminalDeliveryHub,
  type TerminalDeliverySourceOwner,
} from "./terminal-delivery-hub.ts";
const generation = "00000000-0000-4000-8000-000000000001";
const incarnation = `${generation}:0`;
const offer = {
  protocolVersions: [1, 111],
  encodings: ["semantic-compact-v1" as const],
  richPlacements: true,
};
function fixture() {
  let emit: (value: CanonicalTerminalReplicaUpdate) => void = () => {
    throw Error("not subscribed");
  };
  const owner: TerminalDeliverySourceOwner = {
    async subscribeSource(listener) {
      emit = listener;
      return { generation, semanticPaneId: "pane-a", close: async () => {} };
    },
  };
  const hub = new SessionRuntimeTerminalDeliveryHub(generation, "workspace", () => owner);
  const publish = (snapshot: TerminalReplicaSnapshot, revision: number) =>
    emit({
      type: "terminal.seed",
      workspaceName: "workspace",
      semanticPaneId: "pane-a",
      generation,
      incarnation,
      revision,
      cols: snapshot.cols,
      rows: snapshot.rows,
      stateHash: hashTerminalReplicaSnapshot(snapshot),
      hashAlgorithm: "fnv1a64-v1",
      snapshot,
    });
  return { hub, publish };
}
function snapshot() {
  const blank = blankTerminalReplicaSnapshot(80, 24);
  return {
    ...blank,
    modes: { ...blank.modes, alternateScreen: true },
    history: Array.from({ length: 1000 }, () => blank.grid[0]!),
  };
}
async function take(messages: TerminalDeliveryServerMessage[]) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const envelope = messages.find(
      (m) => m.type === "terminal.delivery" || m.type === "terminal.projection",
    );
    if (
      envelope &&
      (envelope.type === "terminal.delivery" || envelope.type === "terminal.projection")
    ) {
      const chunks = messages.filter(
        (m) => m.type === "terminal.delivery.chunk" && m.transactionId === envelope.transactionId,
      );
      if (chunks.length === envelope.chunkCount) {
        messages.splice(0, messages.length);
        return {
          envelope,
          bytes: Buffer.concat(
            chunks.map((m) => {
              if (m.type !== "terminal.delivery.chunk") throw Error("chunk");
              return Buffer.from(m.bytes);
            }),
          ),
        };
      }
    }
    if (messages.some((m) => m.type === "terminal.delivery.fault"))
      throw Error(JSON.stringify(messages));
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw Error("delivery timeout");
}
function project(current: TerminalProjectionState | null, frame: Awaited<ReturnType<typeof take>>) {
  expect(frame.envelope.type).toBe("terminal.projection");
  return commitTerminalProjection(
    current,
    frame.envelope as TerminalProjectionEnvelope,
    frame.bytes,
  );
}
function ack(envelope: TerminalDeliveryEnvelope | TerminalProjectionEnvelope): TerminalDeliveryAck {
  const {
    workspaceName,
    semanticPaneId,
    generation,
    incarnation,
    deliveryNonce,
    transactionId,
    canonicalRevision,
    canonicalStateHash,
    representationHash,
  } = envelope;
  return {
    type: "terminal.delivery.ack",
    workspaceName,
    semanticPaneId,
    generation,
    incarnation,
    deliveryNonce,
    transactionId,
    canonicalRevision,
    canonicalStateHash,
    representationHash,
  };
}
function materialize(current: TerminalProjectionState) {
  const {
    workspaceName,
    semanticPaneId,
    generation,
    incarnation,
    deliveryNonce,
    canonicalRevision,
    projectionStateHash,
  } = current.receipt;
  return {
    type: "terminal.projection.materialize" as const,
    requestId: "00000000-0000-4000-8000-000000000099",
    workspaceName,
    semanticPaneId,
    generation,
    incarnation,
    deliveryNonce,
    canonicalRevision,
    projectionStateHash,
  };
}
describe("deferred alternate-screen history", () => {
  it("omits cold history, patches changed rows, then promotes only through a complete normal seed", async () => {
    const { hub, publish } = fixture();
    const messages: TerminalDeliveryServerMessage[] = [];
    const connection = await hub.open("projection", "pane-a", offer, (m) => {
      messages.push(m);
    });
    try {
      let source = snapshot();
      publish(source, 0);
      const first = await take(messages);
      let state = project(null, first);
      expect(state.projection).not.toHaveProperty("history");
      expect(state.projection?.deferredHistory.rows).toBe(1000);
      expect(first.bytes.length).toBeLessThan(
        encodeBinarySemanticTerminalUpdate({ frame: "seed", revision: 0, snapshot: source })
          .length / 10,
      );
      connection.projectionReceipt!(state.receipt);
      expect(hub.convergenceSnapshot().clients[0]?.baselineRevision).toBe(-1);
      source = {
        ...source,
        grid: source.grid.map((r, i) =>
          i === 2
            ? { ...r, cells: r.cells.map((c, j) => (j === 0 ? { ...c, grapheme: "X" } : c)) }
            : r,
        ),
      };
      publish(source, 1);
      const next = await take(messages);
      expect(next.envelope.frame).toBe("patch");
      const old = state.projection!;
      state = project(state, next);
      connection.projectionReceipt!(state.receipt);
      expect(state.projection?.grid[0]).toBe(old.grid[0]);
      source = { ...source, modes: { ...source.modes, alternateScreen: false } };
      publish(source, 2);
      const complete = await take(messages);
      expect(complete.envelope.type).toBe("terminal.delivery");
      expect(complete.envelope.frame).toBe("seed");
      const decoded = decodeBinarySemanticTerminalUpdate(complete.bytes);
      expect(decoded.frame).toBe("seed");
      if (decoded.frame === "seed")
        expect(hashTerminalReplicaSnapshot(decoded.snapshot)).toBe(
          hashTerminalReplicaSnapshot(source),
        );
      connection.ack(ack(complete.envelope));
      expect(hub.convergenceSnapshot().clients[0]?.baselineRevision).toBe(2);
    } finally {
      await connection.close();
      await hub.close();
    }
  });
  it("replaces a resized projection with a seed while keeping history deferred", async () => {
    const { hub, publish } = fixture();
    const messages: TerminalDeliveryServerMessage[] = [];
    const connection = await hub.open("projection", "pane-a", offer, (m) => {
      messages.push(m);
    });
    try {
      publish(snapshot(), 0);
      const first = project(null, await take(messages));
      connection.projectionReceipt!(first.receipt);
      const blank = blankTerminalReplicaSnapshot(100, 30);
      publish(
        {
          ...blank,
          modes: { ...blank.modes, alternateScreen: true },
          history: Array.from({ length: 1000 }, () => blank.grid[0]!),
        },
        1,
      );
      const frame = await take(messages);
      expect(frame.envelope.frame).toBe("seed");
      const resized = project(first, frame);
      expect(resized.projection?.cols).toBe(100);
      expect(resized.projection?.rows).toBe(30);
      expect(resized.projection?.deferredHistory.rows).toBe(1000);
      connection.projectionReceipt!(resized.receipt);
      expect(hub.convergenceSnapshot().clients[0]?.baselineRevision).toBe(-1);
    } finally {
      await connection.close();
      await hub.close();
    }
  });

  it("materializes at the same revision and never downgrades a complete client", async () => {
    const { hub, publish } = fixture();
    const messages: TerminalDeliveryServerMessage[] = [];
    const connection = await hub.open("projection", "pane-a", offer, (m) => {
      messages.push(m);
    });
    try {
      const source = snapshot();
      publish(source, 0);
      const state = project(null, await take(messages));
      connection.projectionReceipt!(state.receipt);
      const request = materialize(state);
      connection.materialize!(request);
      const complete = await take(messages);
      expect(complete.envelope.type).toBe("terminal.delivery");
      expect(complete.envelope.canonicalRevision).toBe(0);
      connection.ack(ack(complete.envelope));
      connection.materialize!(request);
      publish({ ...source, cursor: { ...source.cursor, x: 1 } }, 1);
      expect((await take(messages)).envelope.type).toBe("terminal.delivery");
    } finally {
      await connection.close();
      await hub.close();
    }
  });
  it("never accepts a canonical ACK for a projection", async () => {
    const { hub, publish } = fixture();
    const messages: TerminalDeliveryServerMessage[] = [];
    const c = await hub.open("projection", "pane-a", offer, (m) => {
      messages.push(m);
    });
    try {
      publish(snapshot(), 0);
      const first = await take(messages);
      c.ack(ack(first.envelope));
      await new Promise((r) => setTimeout(r, 10));
      expect(
        messages.some(
          (m) => m.type === "terminal.delivery.fault" && m.reason === "protocol-violation",
        ),
      ).toBe(true);
    } finally {
      await c.close();
      await hub.close();
    }
  });
  it("keeps complete and projected subscribers independent while deferred history changes", async () => {
    const { hub, publish } = fixture();
    const partial: TerminalDeliveryServerMessage[] = [],
      full: TerminalDeliveryServerMessage[] = [];
    const p = await hub.open("projection", "pane-a", offer, (m) => {
      partial.push(m);
    });
    const c = await hub.open(
      "complete",
      "pane-a",
      { ...offer, protocolVersions: [1, 109] },
      (m) => {
        full.push(m);
      },
    );
    try {
      let source = snapshot();
      publish(source, 0);
      let state = project(null, await take(partial));
      p.projectionReceipt!(state.receipt);
      const complete = await take(full);
      expect(complete.envelope.type).toBe("terminal.delivery");
      c.ack(ack(complete.envelope));
      source = { ...source, history: [...source.history, source.grid[0]!] };
      publish(source, 1);
      state = project(state, await take(partial));
      expect(state.projection?.deferredHistory.rows).toBe(1001);
      p.projectionReceipt!(state.receipt);
      const completePatch = await take(full);
      expect(completePatch.envelope.type).toBe("terminal.delivery");
      c.ack(ack(completePatch.envelope));
      expect(
        hub
          .convergenceSnapshot()
          .clients.map((c) => c.baselineRevision)
          .sort(),
      ).toEqual([-1, 1]);
    } finally {
      await p.close();
      await c.close();
      await hub.close();
    }
  });
  it("waits for an in-flight projection receipt before materializing the latest revision", async () => {
    const { hub, publish } = fixture();
    const messages: TerminalDeliveryServerMessage[] = [];
    const c = await hub.open("projection", "pane-a", offer, (m) => {
      messages.push(m);
    });
    try {
      const source = snapshot();
      publish(source, 0);
      const first = project(null, await take(messages));
      c.projectionReceipt!(first.receipt);
      publish({ ...source, cursor: { ...source.cursor, x: 2 } }, 1);
      const flight = await take(messages);
      c.materialize!(materialize(first));
      expect(messages).toHaveLength(0);
      const next = project(first, flight);
      c.projectionReceipt!(next.receipt);
      const full = await take(messages);
      expect(full.envelope.type).toBe("terminal.delivery");
      expect(full.envelope.frame).toBe("seed");
      expect(full.envelope.canonicalRevision).toBe(1);
      c.ack(ack(full.envelope));
      expect(hub.metrics().inFlight).toBe(0);
    } finally {
      await c.close();
      await hub.close();
    }
  });
  it.each(["projectionStateHash", "canonicalStateHash", "deliveryNonce"] as const)(
    "rejects corrupted %s receipts",
    async (field) => {
      const { hub, publish } = fixture();
      const messages: TerminalDeliveryServerMessage[] = [];
      const c = await hub.open("projection", "pane-a", offer, (m) => {
        messages.push(m);
      });
      try {
        publish(snapshot(), 0);
        const state = project(null, await take(messages));
        c.projectionReceipt!({
          ...state.receipt,
          [field]:
            field === "deliveryNonce" ? "00000000-0000-4000-8000-000000000077" : "0000000000000000",
        });
        await new Promise((r) => setTimeout(r, 10));
        expect(
          messages.some(
            (m) => m.type === "terminal.delivery.fault" && m.reason === "protocol-violation",
          ),
        ).toBe(true);
      } finally {
        await c.close();
        await hub.close();
      }
    },
  );
});
