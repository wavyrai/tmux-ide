// History on demand (capability 122): the work one history frame costs the
// daemon's event loop. A frame encodes about the rows it sends, and rows the
// daemon owns are strictly validated once, not on every frame that sends them.
import { describe, expect, it, vi } from "vitest";
import {
  TerminalReplicaCellSchemaZ,
  type CanonicalTerminalReplicaUpdate,
  type TerminalDeliveryEnvelope,
  type TerminalDeliveryServerMessage,
  type TerminalReplicaSnapshot,
} from "@tmux-ide/contracts";
import {
  admitTerminalDeliveryChunk,
  admitTerminalDeliveryEnvelope,
  blankTerminalReplicaSnapshot,
  commitTerminalDelivery,
  completeTerminalDelivery,
  createTerminalDeliveryClientState,
  decodeSemanticTerminalHistory,
  hashTerminalReplicaSnapshot,
  TerminalDeliveryAssembler,
} from "@tmux-ide/core";
import {
  HISTORY_FRAME_MAX_BYTES,
  SessionRuntimeTerminalDeliveryHub,
  type TerminalDeliverySourceOwner,
} from "./terminal-delivery-hub.ts";

const encoded = vi.hoisted(() => ({ rows: 0 }));
/** True while the daemon works, false while the test's client decodes. */
const daemon = { working: false };
vi.mock("@tmux-ide/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@tmux-ide/core")>();
  return {
    ...core,
    encodeSemanticTerminalHistory: (
      ...args: Parameters<typeof core.encodeSemanticTerminalHistory>
    ) => {
      encoded.rows += args[0].rows.length;
      return core.encodeSemanticTerminalHistory(...args);
    },
  };
});

const generation = "00000000-0000-4000-8000-000000000001";
type Snap = TerminalReplicaSnapshot;

class Owner implements TerminalDeliverySourceOwner {
  listener: ((update: CanonicalTerminalReplicaUpdate) => void) | undefined;
  async subscribeSource(listener: (update: CanonicalTerminalReplicaUpdate) => void) {
    this.listener = listener;
    return { generation, semanticPaneId: "pane", close: async () => {} };
  }
}
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise<void>((r) => setImmediate(r));
};

/** 80 columns; dense rows fill every cell, sparse rows only the first 20. */
function snapshot(history: number, dense: (index: number) => boolean): Snap {
  const snap: Snap = structuredClone(blankTerminalReplicaSnapshot(80, 4));
  let k = 0;
  snap.history = Array.from({ length: history }, (_, index) => {
    const row = structuredClone(snap.grid[0]!);
    for (const [i, cell] of row.cells.entries())
      cell.grapheme =
        !dense(index) && i >= 20 ? " " : String.fromCharCode(0x21 + ((k++ * 7919) % 90));
    return row;
  });
  return snap;
}

async function client(hub: SessionRuntimeTerminalDeliveryHub, id: string, binary: boolean) {
  const messages: TerminalDeliveryServerMessage[] = [];
  const c = await hub.open(
    id,
    "pane",
    {
      protocolVersions: binary ? [1, 109, 122] : [1, 122],
      encodings: ["semantic-compact-v1"],
      richPlacements: false,
    },
    (m) => {
      messages.push(m);
    },
  );
  if (!c.negotiation.accepted) throw new Error("not negotiated");
  const nonce = c.negotiation.negotiated.deliveryNonce;
  let state = createTerminalDeliveryClientState(c.negotiation.negotiated, "w", "pane");
  let processed = 0;
  const historyRows: number[] = [];
  const historyBytes: number[] = [];
  const drain = () => {
    for (; processed < messages.length; processed++) {
      const m = messages[processed]!;
      if (m.type !== "terminal.delivery") continue;
      const e = m as TerminalDeliveryEnvelope;
      let admitted = admitTerminalDeliveryEnvelope(state, e);
      expect(admitted.failed).toBe(false);
      const a = new TerminalDeliveryAssembler(e);
      for (let j = processed + 1; j < messages.length; j++) {
        const chunk = messages[j]!;
        if (chunk.type === "terminal.delivery.chunk" && chunk.transactionId === e.transactionId) {
          admitted = admitTerminalDeliveryChunk(admitted, chunk);
          a.write(chunk);
        }
      }
      const staged = completeTerminalDelivery(admitted, a);
      if (e.frame === "history") {
        expect(e.representationBytes).toBeLessThanOrEqual(HISTORY_FRAME_MAX_BYTES);
        historyBytes.push(e.representationBytes);
        historyRows.push(
          decodeSemanticTerminalHistory(staged.bytes, e.encoding as "semantic-binary-v1").rows
            .length,
        );
      }
      const result = commitTerminalDelivery(admitted, staged);
      state = result.state;
      c.ack(result.ack);
    }
  };
  const self = {
    historyRows,
    historyBytes,
    get state() {
      return state;
    },
    async caughtUp(revision: number) {
      for (let i = 0; i < 1000 && state.appliedRevision !== revision; i++) {
        await settle();
        drain();
      }
      expect(state.appliedRevision).toBe(revision);
    },
    /** Ask for up to `maxRows` older rows and wait for the frame. */
    async loadHistory(maxRows: number) {
      const frames = historyRows.length;
      const envelopes = () => messages.filter((m) => m.type === "terminal.delivery").length;
      const before = envelopes();
      daemon.working = true;
      c.historyRequest!({
        type: "terminal.delivery.history-request",
        workspaceName: "w",
        semanticPaneId: "pane",
        generation,
        incarnation: state.incarnation!,
        deliveryNonce: nonce,
        canonicalRevision: state.appliedRevision,
        unloadedRows: state.historyUnloaded?.rows ?? 0,
        maxRows,
      });
      for (let i = 0; i < 1000 && envelopes() === before; i++) await settle();
      daemon.working = false;
      for (let i = 0; i < 1000 && historyRows.length === frames; i++) {
        await settle();
        drain();
      }
      expect(historyRows.length).toBe(frames + 1);
      return historyRows[frames]!;
    },
  };
  return self;
}

async function seeded(full: Snap, binary: boolean) {
  const owner = new Owner();
  const hub = new SessionRuntimeTerminalDeliveryHub(generation, "w", () => owner);
  const first = await client(hub, "a", binary);
  await settle();
  owner.listener!({
    type: "terminal.seed",
    workspaceName: "w",
    semanticPaneId: "pane",
    generation,
    incarnation: `${generation}:0`,
    revision: 0,
    cols: full.cols,
    rows: full.rows,
    snapshot: full,
    stateHash: hashTerminalReplicaSnapshot(full),
    hashAlgorithm: "fnv1a64-v1",
  });
  await first.caughtUp(0);
  return { hub, first };
}

describe.each([false, true])("history frame cost (binary %s)", (binary) => {
  it.each([
    // Every row dense, or frames that cross a fourfold change in bytes per
    // row: sparse rows over dense older ones, and dense rows over sparse ones.
    ["dense", () => true, 1.1],
    ["sparse over dense", (index: number) => index < 1200, 2],
    ["dense over sparse", (index: number) => index >= 1200, 2],
  ] as const)(
    "encodes about the rows it sends (%s), under the frame byte cap",
    { timeout: 60_000 },
    async (_, dense, ratio) => {
      const full = snapshot(2000, dense);
      const { hub, first: cl } = await seeded(full, binary);
      encoded.rows = 0;
      let sent = 0;
      for (let frame = 0; frame < 8; frame++) sent += await cl.loadHistory(2000);
      expect(cl.historyRows.every((rows) => rows > 1)).toBe(true);
      // Each frame is well filled, so a scroll back takes few frames.
      expect(cl.historyBytes.every((bytes) => bytes >= HISTORY_FRAME_MAX_BYTES * 0.4)).toBe(true);
      // Before: every frame first encoded 128 KiB / 80 columns = 1638 rows.
      // Now: a 32-row sample once, then about the rows sent.
      expect(encoded.rows).toBeLessThanOrEqual(Math.ceil(sent * ratio) + 32);
      expect(cl.state.canonicalSnapshot!.history).toEqual(full.history.slice(-sent - 200));
      await hub.close();
    },
  );

  it(
    "strictly validates rows the daemon owns once, not again for the next client",
    { timeout: 60_000 },
    async () => {
      const full = snapshot(1000, () => true);
      const { hub, first: one } = await seeded(full, binary);
      let sent = 0;
      for (let frame = 0; frame < 3; frame++) sent += await one.loadHistory(2000);
      const two = await client(hub, "c", binary);
      await two.caughtUp(0);
      // The client validates what it decodes; count the daemon's work only.
      const run = TerminalReplicaCellSchemaZ._zod.run;
      let validated = 0;
      const calls = vi.spyOn(TerminalReplicaCellSchemaZ._zod, "run").mockImplementation(function (
        this: unknown,
        ...args: Parameters<typeof run>
      ) {
        if (daemon.working) validated += 1;
        return run.apply(this, args);
      });
      try {
        let again = 0;
        for (let frame = 0; frame < 3; frame++) again += await two.loadHistory(2000);
        expect(again).toBe(sent);
        expect(calls).toHaveBeenCalled();
        expect(validated).toBe(0);
      } finally {
        calls.mockRestore();
      }
      expect(two.state.canonicalSnapshot!.history).toEqual(full.history.slice(-sent - 200));
      await hub.close();
    },
  );
});
