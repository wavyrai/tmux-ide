import { expect, it } from "vitest";
import type {
  CanonicalTerminalReplicaUpdate,
  TerminalDeliveryEnvelope,
  TerminalDeliveryServerMessage,
} from "@tmux-ide/contracts";
import {
  blankTerminalReplicaSnapshot,
  hashTerminalReplicaSnapshot,
  createTerminalDeliveryClientState,
  admitTerminalDeliveryEnvelope,
  admitTerminalDeliveryChunk,
  completeTerminalDelivery,
  commitTerminalDelivery,
  TerminalDeliveryAssembler,
} from "@tmux-ide/core";
import { SessionRuntimeTerminalDeliveryHub } from "./terminal-delivery-hub.ts";

const generation = "00000000-0000-4000-8000-000000000001";
const settle = async () => {
  for (let turn = 0; turn < 4; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
};

it("finishes an admitted hidden flight, then waits for reveal before delivering the latest state", async () => {
  let publish!: (update: CanonicalTerminalReplicaUpdate) => void;
  const hub = new SessionRuntimeTerminalDeliveryHub(generation, "workspace", () => ({
    subscribeSource: async (listener) => {
      publish = listener;
      return { generation, semanticPaneId: "pane-a", close: async () => {} };
    },
  }));
  const messages: TerminalDeliveryServerMessage[] = [];
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entry = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const connection = await hub.open(
    "observer",
    "pane-a",
    {
      protocolVersions: [1],
      encodings: ["semantic-v1"],
      richPlacements: false,
    },
    async (message) => {
      if (message.type === "terminal.delivery" && message.canonicalRevision === 0) {
        entered();
        await blocked;
      }
      messages.push(message);
    },
  );
  if (!connection.negotiation.accepted) throw new Error("Expected supported negotiation");
  let state = createTerminalDeliveryClientState(
    connection.negotiation.negotiated,
    "workspace",
    "pane-a",
  );
  const snapshots = ["A", "B", "C"].map((text) => {
    const snapshot = structuredClone(blankTerminalReplicaSnapshot(2, 1));
    snapshot.grid[0]!.cells[0]!.grapheme = text;
    return snapshot;
  });
  const emit = (revision: number) => {
    const snapshot = snapshots[revision]!;
    publish({
      type: "terminal.seed",
      workspaceName: "workspace",
      semanticPaneId: "pane-a",
      generation,
      incarnation: `${generation}:0`,
      revision,
      cols: 2,
      rows: 1,
      snapshot,
      stateHash: hashTerminalReplicaSnapshot(snapshot),
      hashAlgorithm: "fnv1a64-v1",
    });
  };
  const envelopes = () =>
    messages.filter(
      (message): message is TerminalDeliveryEnvelope => message.type === "terminal.delivery",
    );
  const consume = (envelope: TerminalDeliveryEnvelope, revision: number) => {
    let admission = admitTerminalDeliveryEnvelope(state, envelope);
    const assembler = new TerminalDeliveryAssembler(envelope);
    for (const message of messages) {
      if (
        message.type !== "terminal.delivery.chunk" ||
        message.transactionId !== envelope.transactionId
      )
        continue;
      admission = admitTerminalDeliveryChunk(admission, message);
      assembler.write(message);
    }
    const committed = commitTerminalDelivery(
      admission,
      completeTerminalDelivery(admission, assembler),
    );
    expect(committed.state.canonicalSnapshot).toEqual(snapshots[revision]);
    expect(envelope.canonicalStateHash).toBe(hashTerminalReplicaSnapshot(snapshots[revision]!));
    state = committed.state;
    connection.ack(committed.ack);
  };
  try {
    emit(0);
    await entry;
    connection.setVisibility("hidden");
    emit(1);
    expect(messages).toHaveLength(0);
    expect(hub.convergenceSnapshot().clients[0]).toMatchObject({
      visibility: "hidden",
      inFlightRevision: 0,
    });
    release();
    await settle();
    expect(envelopes().map((message) => message.canonicalRevision)).toEqual([0]);
    consume(envelopes()[0]!, 0);
    emit(2);
    await settle();
    expect(envelopes().map((message) => message.canonicalRevision)).toEqual([0]);
    expect(hub.convergenceSnapshot().clients[0]).toMatchObject({
      visibility: "hidden",
      inFlightRevision: null,
      queueDepth: 0,
      baselineRevision: 0,
      latestRevision: 2,
    });
    connection.setVisibility("visible");
    await settle();
    expect(envelopes().map((message) => message.canonicalRevision)).toEqual([0, 2]);
    consume(envelopes()[1]!, 2);
    expect(hub.convergenceSnapshot().clients[0]).toMatchObject({
      inFlightRevision: null,
      baselineRevision: 2,
    });
  } finally {
    release();
    await connection.close();
    await hub.close();
  }
});
