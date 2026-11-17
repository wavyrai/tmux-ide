// History on demand (capability 122) through the real delivery hub and the
// core client: partial seeds, trims taken from unloaded rows first, history
// frames newest first, new output ahead of history, and a property test.
import { afterAll, describe, expect, it } from "vitest";
import type {
  CanonicalTerminalReplicaUpdate,
  TerminalDeliveryEnvelope,
  TerminalDeliveryServerMessage,
  TerminalReplicaSnapshot,
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
  TERMINAL_DELIVERY_CONNECTION_UNACKED_BYTES,
  type TerminalDeliverySourceOwner,
} from "./terminal-delivery-hub.ts";

const generation = "00000000-0000-4000-8000-000000000001";
type Snap = TerminalReplicaSnapshot;
type Row = Snap["history"][number];

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
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** A canonical source: seeds and patches with exact full snapshots per revision. */
function source(owner: Owner) {
  let counter = 0;
  let revision = 0;
  let epoch = 0;
  const snapshots = new Map<number, Snap>();
  const row = (cols: number, tag: string): Row => {
    const base = blankTerminalReplicaSnapshot(cols, 1).grid[0]!;
    counter += 1;
    return structuredClone({
      ...base,
      cells: base.cells.map((cell, index) => ({
        ...cell,
        grapheme: index === 0 ? tag : index === 1 ? String(counter % 10) : " ",
      })),
    });
  };
  let cur: Snap = structuredClone(blankTerminalReplicaSnapshot(6, 3));
  const api = {
    row,
    get cur() {
      return cur;
    },
    get revision() {
      return revision;
    },
    snapshots,
    seed(snap: Snap, newIncarnation = false) {
      if (snapshots.size > 0) revision += 1;
      if (newIncarnation) epoch += 1;
      cur = snap;
      snapshots.set(revision, structuredClone(snap));
      owner.listener!({
        type: "terminal.seed",
        workspaceName: "w",
        semanticPaneId: "pane",
        generation,
        incarnation: `${generation}:${epoch}`,
        revision,
        cols: snap.cols,
        rows: snap.rows,
        snapshot: snap,
        stateHash: hashTerminalReplicaSnapshot(snap),
        hashAlgorithm: "fnv1a64-v1",
      });
    },
    patch(next: Snap, patch: Record<string, unknown>) {
      revision += 1;
      cur = next;
      snapshots.set(revision, structuredClone(next));
      owner.listener!({
        type: "terminal.patch",
        workspaceName: "w",
        semanticPaneId: "pane",
        generation,
        incarnation: `${generation}:${epoch}`,
        baseRevision: revision - 1,
        revision,
        cols: next.cols,
        rows: next.rows,
        patch,
        stateHash: hashTerminalReplicaSnapshot(next),
        hashAlgorithm: "fnv1a64-v1",
      } as CanonicalTerminalReplicaUpdate);
    },
    /** k lines scroll into history; the oldest rows go past `limit`. */
    scroll(k: number, limit: number) {
      const grid = [...cur.grid];
      const append: Row[] = [];
      for (let n = 0; n < k; n++) {
        append.push(grid.shift()!);
        grid.push(row(cur.cols, "s"));
      }
      const all = [...cur.history, ...append];
      const trim = Math.max(0, all.length - limit);
      const next = { ...cur, grid, history: all.slice(trim) };
      api.patch(structuredClone(next), {
        rows: grid.map((r, index) => ({ index, row: structuredClone(r) })),
        historyDelta: {
          trim: Math.min(trim, cur.history.length),
          append: structuredClone(append.slice(Math.max(0, trim - cur.history.length))),
        },
      });
    },
  };
  return api;
}

type Hub = SessionRuntimeTerminalDeliveryHub;
async function client(hub: Hub, id: string, partial = true, encoding = "semantic-compact-v1") {
  const messages: TerminalDeliveryServerMessage[] = [];
  const c = await hub.open(
    id,
    "pane",
    {
      protocolVersions: partial
        ? encoding === "semantic-binary-v1"
          ? [1, 109, 122]
          : [1, 122]
        : [1],
      encodings: ["semantic-compact-v1"],
      richPlacements: false,
    },
    (m) => {
      messages.push(m);
    },
  );
  if (!c.negotiation.accepted) throw new Error("not negotiated");
  const self = {
    c,
    messages,
    state: createTerminalDeliveryClientState(c.negotiation.negotiated, "w", "pane"),
    processed: 0,
    pendingAck: null as unknown,
    envelopes: [] as TerminalDeliveryEnvelope[],
    historyRows: [] as number[],
    unloadedTrims: 0,
    /** Commit every new delivery; keep its ACK to send later. */
    drain() {
      for (; self.processed < messages.length; self.processed++) {
        const m = messages[self.processed]!;
        if (m.type !== "terminal.delivery") continue;
        const e = m as TerminalDeliveryEnvelope;
        let admitted = admitTerminalDeliveryEnvelope(self.state, e);
        expect(admitted.failed, `admit ${e.frame} at ${e.canonicalRevision}`).toBe(false);
        const a = new TerminalDeliveryAssembler(e);
        for (const chunk of messages)
          if (chunk.type === "terminal.delivery.chunk" && chunk.transactionId === e.transactionId) {
            admitted = admitTerminalDeliveryChunk(admitted, chunk);
            a.write(chunk);
          }
        const staged = completeTerminalDelivery(admitted, a);
        if (e.frame === "history")
          self.historyRows.push(
            decodeSemanticTerminalHistory(staged.bytes, e.encoding as "semantic-binary-v1").rows
              .length,
          );
        if (
          e.frame === "patch" &&
          e.historyUnloaded &&
          e.historyUnloaded.rows < (self.state.historyUnloaded?.rows ?? 0)
        )
          self.unloadedTrims += 1;
        const result = commitTerminalDelivery(admitted, staged);
        self.state = result.state;
        self.envelopes.push(e);
        self.pendingAck = result.ack;
      }
    },
    ack() {
      if (!self.pendingAck) return false;
      c.ack(self.pendingAck as never);
      self.pendingAck = null;
      return true;
    },
    requestHistory(maxRows: number) {
      const s = self.state;
      c.historyRequest!({
        type: "terminal.delivery.history-request",
        workspaceName: "w",
        semanticPaneId: "pane",
        generation,
        incarnation: s.incarnation!,
        deliveryNonce: c.negotiation.accepted ? c.negotiation.negotiated.deliveryNonce : "",
        canonicalRevision: s.appliedRevision,
        unloadedRows: s.historyUnloaded?.rows ?? 0,
        maxRows,
      });
    },
  };
  return self;
}

async function converge(clients: Awaited<ReturnType<typeof client>>[]) {
  // Fixed rounds: deliveries may take several turns of the event loop.
  for (let round = 0; round < 30; round++) {
    await settle();
    for (const cl of clients) {
      cl.drain();
      cl.ack();
    }
  }
  await settle();
  for (const cl of clients) cl.drain();
}

function withHistory(src: ReturnType<typeof source>, rows: number, alternate = false): Snap {
  const snap: Snap = structuredClone(blankTerminalReplicaSnapshot(6, 3));
  snap.grid = snap.grid.map(() => src.row(6, "g"));
  snap.history = Array.from({ length: rows }, () => src.row(6, "h"));
  if (alternate) snap.modes = { ...snap.modes, alternateScreen: true };
  return snap;
}

describe("history on demand through the delivery hub (capability 122)", () => {
  it("seeds the screen plus 200 rows and commits to the rest; a full client is unchanged", async () => {
    const owner = new Owner();
    const hub = new SessionRuntimeTerminalDeliveryHub(generation, "w", () => owner);
    const partial = await client(hub, "partial");
    const full = await client(hub, "full", false);
    const src = source(owner);
    await settle();
    src.seed(withHistory(src, 1000));
    await converge([partial, full]);
    const seed = partial.envelopes[0]!;
    expect(seed).toMatchObject({ frame: "seed", history: "partial" });
    expect(seed.historyUnloaded!.rows).toBe(800);
    expect(partial.state.canonicalSnapshot!.history).toEqual(src.cur.history.slice(800));
    expect(partial.state.appliedHash).toBe(hashTerminalReplicaSnapshot(src.cur));
    expect(full.envelopes[0]).toMatchObject({ frame: "seed", history: "complete" });
    expect(full.envelopes[0]!.historyUnloaded).toBeUndefined();
    expect(full.state.canonicalSnapshot).toEqual(src.cur);
    await hub.close();
  });

  it("seeds no history rows for the alternate screen", async () => {
    const owner = new Owner();
    const hub = new SessionRuntimeTerminalDeliveryHub(generation, "w", () => owner);
    const partial = await client(hub, "partial", true, "semantic-compact-v1");
    const src = source(owner);
    await settle();
    src.seed(withHistory(src, 300, true));
    await converge([partial]);
    expect(partial.envelopes[0]!.historyUnloaded!.rows).toBe(300);
    expect(partial.state.canonicalSnapshot!.history).toEqual([]);
    await hub.close();
  });

  it("sends the 200-row tail unasked when the pane leaves the alternate screen", async () => {
    const owner = new Owner();
    const hub = new SessionRuntimeTerminalDeliveryHub(generation, "w", () => owner);
    const partial = await client(hub, "partial");
    const src = source(owner);
    await settle();
    src.seed(withHistory(src, 300, true));
    await converge([partial]);
    expect(partial.state.canonicalSnapshot!.history).toEqual([]);
    const normal = { ...src.cur, modes: { ...src.cur.modes, alternateScreen: false } };
    src.patch(structuredClone(normal), { rows: [], modes: normal.modes });
    await converge([partial]);
    expect(partial.historyRows).toEqual([200]);
    expect(partial.state.historyUnloaded!.rows).toBe(100);
    expect(partial.state.canonicalSnapshot!.history).toEqual(src.cur.history.slice(100));
    await hub.close();
  });

  it("takes a trim at the history limit from the unloaded rows first", async () => {
    const owner = new Owner();
    const hub = new SessionRuntimeTerminalDeliveryHub(generation, "w", () => owner);
    const partial = await client(hub, "partial");
    const src = source(owner);
    await settle();
    src.seed(withHistory(src, 1000));
    await converge([partial]);
    const loaded = partial.state.canonicalSnapshot!.history;
    src.scroll(3, 1000);
    await converge([partial]);
    const patch = partial.envelopes.at(-1)!;
    expect(patch).toMatchObject({ frame: "patch", history: "partial" });
    expect(patch.historyUnloaded!.rows).toBe(797);
    // Every row the client had loaded is still there; three new rows follow.
    expect(partial.state.canonicalSnapshot!.history.slice(0, 200)).toEqual(loaded);
    expect(partial.state.canonicalSnapshot!.history).toHaveLength(203);
    expect(partial.state.appliedHash).toBe(hashTerminalReplicaSnapshot(src.cur));
    await hub.close();
  });

  it("serves history newest first in the requested sizes until the client holds everything", async () => {
    const owner = new Owner();
    const hub = new SessionRuntimeTerminalDeliveryHub(generation, "w", () => owner);
    const partial = await client(hub, "partial");
    const src = source(owner);
    await settle();
    src.seed(withHistory(src, 3000));
    await converge([partial]);
    partial.requestHistory(500);
    await converge([partial]);
    expect(partial.historyRows).toEqual([500]);
    expect(partial.state.historyUnloaded!.rows).toBe(2300);
    while (partial.state.historyUnloaded!.rows > 0) {
      partial.requestHistory(2000);
      await converge([partial]);
    }
    expect(partial.historyRows).toEqual([500, 2000, 300]);
    expect(partial.state.canonicalSnapshot).toEqual(src.cur);
    // Nothing more to load: a request is ignored.
    const before = partial.envelopes.length;
    partial.requestHistory(10);
    await converge([partial]);
    expect(partial.envelopes).toHaveLength(before);
    await hub.close();
  });

  it("sends new output ahead of pending history", async () => {
    const owner = new Owner();
    const hub = new SessionRuntimeTerminalDeliveryHub(generation, "w", () => owner);
    const partial = await client(hub, "partial");
    const src = source(owner);
    await settle();
    src.seed(withHistory(src, 1000));
    await converge([partial]);
    // A patch is in flight, history is asked for, and newer output arrives.
    src.scroll(1, 2000);
    await settle();
    partial.drain();
    expect(partial.envelopes.at(-1)!.frame).toBe("patch");
    partial.requestHistory(300);
    src.scroll(1, 2000);
    await settle();
    partial.drain();
    partial.ack();
    await settle();
    partial.drain();
    expect(partial.envelopes.map((e) => e.frame).slice(-2)).toEqual(["patch", "patch"]);
    partial.ack();
    await settle();
    partial.drain();
    expect(partial.envelopes.at(-1)!.frame).toBe("history");
    await converge([partial]);
    expect(partial.historyRows).toEqual([300]);
    expect(partial.state.appliedHash).toBe(hashTerminalReplicaSnapshot(src.cur));
    await hub.close();
  });

  it("reseeds a reflowed history at the depth the client held (review of #435)", async () => {
    const owner = new Owner();
    const hub = new SessionRuntimeTerminalDeliveryHub(generation, "w", () => owner);
    const partial = await client(hub, "partial");
    const src = source(owner);
    await settle();
    src.seed(withHistory(src, 1500));
    await converge([partial]);
    partial.requestHistory(700);
    await converge([partial]);
    expect(partial.state.historyUnloaded!.rows).toBe(600);
    // A resize reflows every row: the same incarnation, new row objects, more rows.
    src.seed(withHistory(src, 2400));
    await converge([partial]);
    const last = partial.envelopes.at(-1)!;
    expect(last.frame).toBe("seed");
    expect(last.historyUnloaded!.rows).toBe(1500);
    expect(partial.messages.some((m) => m.type === "terminal.delivery.fault")).toBe(false);
    expect(partial.state.appliedHash).toBe(hashTerminalReplicaSnapshot(src.cur));
    await hub.close();
  });

  it("faults a history request that names another pane, serving nothing", async () => {
    const owner = new Owner();
    const hub = new SessionRuntimeTerminalDeliveryHub(generation, "w", () => owner);
    const partial = await client(hub, "partial");
    const src = source(owner);
    await settle();
    src.seed(withHistory(src, 3000));
    await converge([partial]);
    const s = partial.state;
    partial.c.historyRequest!({
      type: "terminal.delivery.history-request",
      workspaceName: "w",
      semanticPaneId: "other",
      generation,
      incarnation: s.incarnation!,
      deliveryNonce: partial.c.negotiation.accepted
        ? partial.c.negotiation.negotiated.deliveryNonce
        : "",
      canonicalRevision: s.appliedRevision,
      unloadedRows: s.historyUnloaded!.rows,
      maxRows: 10,
    });
    await converge([partial]);
    expect(partial.messages.some((m) => m.type === "terminal.delivery.fault")).toBe(true);
    expect(partial.historyRows).toEqual([]);
    await hub.close();
  });

  it(
    "keeps every history frame well under the connection's byte budget",
    { timeout: 120_000 },
    async () => {
      const owner = new Owner();
      const hub = new SessionRuntimeTerminalDeliveryHub(generation, "w", () => owner);
      const partial = await client(hub, "partial");
      const src = source(owner);
      await settle();
      // Dense 80-column rows: the cell count alone would allow a frame of megabytes.
      const snap: Snap = structuredClone(blankTerminalReplicaSnapshot(80, 24));
      let k = 0;
      snap.history = Array.from({ length: 5000 }, () => {
        const r = structuredClone(snap.grid[0]!);
        for (const cell of r.cells) cell.grapheme = String.fromCharCode(0x21 + ((k++ * 7919) % 90));
        return r;
      });
      src.seed(snap);
      await converge([partial]);
      while (partial.state.historyUnloaded!.rows > 0) {
        partial.requestHistory(2000);
        await converge([partial]);
      }
      const frames = partial.envelopes.filter((e) => e.frame === "history");
      expect(frames.length).toBeGreaterThan(1);
      for (const frame of frames)
        expect(frame.representationBytes).toBeLessThanOrEqual(HISTORY_FRAME_MAX_BYTES);
      expect(HISTORY_FRAME_MAX_BYTES).toBeLessThanOrEqual(
        TERMINAL_DELIVERY_CONNECTION_UNACKED_BYTES / 2,
      );
      expect(partial.state.canonicalSnapshot).toEqual(src.cur);
      await hub.close();
    },
  );

  it("refuses a history request from a client without the capability", async () => {
    const owner = new Owner();
    const hub = new SessionRuntimeTerminalDeliveryHub(generation, "w", () => owner);
    const full = await client(hub, "full", false);
    const src = source(owner);
    await settle();
    src.seed(withHistory(src, 100));
    await converge([full]);
    full.requestHistory(50);
    await settle();
    expect(full.messages.some((m) => m.type === "terminal.delivery.fault")).toBe(true);
    await hub.close();
  });
});

const exercised = { history: 0, trims: 0 };
afterAll(() => {
  // The runs must exercise history frames and trims taken from unloaded rows.
  expect(exercised.history).toBeGreaterThan(0);
  expect(exercised.trims).toBeGreaterThan(0);
});
describe.each(["semantic-compact-v1", "semantic-binary-v1"] as const)(
  "property: partial clients equal a fresh full seed (%s)",
  (encoding) => {
    it.each(Array.from({ length: 30 }, (_, i) => i + 1))(
      "seed %i",
      async (seed) => {
        const rand = rng(seed * 6007 + (encoding === "semantic-binary-v1" ? 1 : 0));
        const int = (n: number) => Math.floor(rand() * n);
        const LIMIT = 250 + int(400);
        const owner = new Owner();
        const hub = new SessionRuntimeTerminalDeliveryHub(generation, "w", () => owner);
        const src = source(owner);
        const open = (id: string) => client(hub, id, true, encoding);
        const clients = [await open("a"), await open("b"), await client(hub, "full", false)];
        await settle();
        src.seed(withHistory(src, int(LIMIT)));
        try {
          for (let step = 0; step < 50; step++) {
            const op = int(100);
            if (op < 45) src.scroll(1 + int(12), LIMIT);
            else if (op < 55) {
              const grid = [...src.cur.grid];
              const index = int(grid.length);
              grid[index] = src.row(src.cur.cols, "e");
              src.patch(structuredClone({ ...src.cur, grid }), {
                rows: [{ index, row: structuredClone(grid[index]) }],
              });
            } else if (op < 60) {
              src.patch(structuredClone({ ...src.cur, history: [] }), { rows: [], history: [] });
            } else if (op < 64) {
              src.seed(structuredClone(src.cur));
            } else if (op < 67) {
              src.seed(structuredClone(src.cur), true);
            }
            // Clients ask for history at random sizes.
            for (const cl of clients.slice(0, 2))
              if (rand() < 0.3 && (cl.state.historyUnloaded?.rows ?? 0) > 0)
                cl.requestHistory(1 + int(600));
            await settle();
            for (const cl of clients) {
              cl.drain();
              if (rand() < 0.4) cl.ack();
            }
            await settle();
            for (const cl of clients) cl.drain();
            // Every committed partial state verifies against the full canonical hash
            // (commit checks it) and holds exactly the newest rows of the full history.
            for (const cl of clients.slice(0, 2)) {
              const s = cl.state;
              if (!s.canonicalSnapshot) continue;
              const full = src.snapshots.get(s.appliedRevision)!;
              expect(s.appliedHash).toBe(hashTerminalReplicaSnapshot(full));
              expect(s.canonicalSnapshot.history).toEqual(
                full.history.slice(s.historyUnloaded!.rows),
              );
              expect(s.canonicalSnapshot.grid).toEqual(full.grid);
            }
          }
          await converge(clients);
          // Load every chunk: each partial client then equals a fresh full seed.
          for (const cl of clients.slice(0, 2)) {
            for (let round = 0; round < 50 && (cl.state.historyUnloaded?.rows ?? 0) > 0; round++) {
              cl.requestHistory(2000);
              await converge(clients);
            }
            exercised.history += cl.historyRows.length;
            exercised.trims += cl.unloadedTrims;
            expect(cl.state.historyUnloaded!.rows).toBe(0);
            expect(cl.state.canonicalSnapshot).toEqual(src.cur);
            expect(cl.state.canonicalSnapshot).toEqual(clients[2]!.state.canonicalSnapshot);
          }
        } finally {
          for (const cl of clients) await cl.c.close();
          await hub.close();
        }
      },
      60_000,
    );
  },
);
