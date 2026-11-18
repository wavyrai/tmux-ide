import { describe, expect, it, vi } from "vitest";
import type {
  CanonicalTerminalReplicaUpdate,
  TerminalDeliveryEnvelope,
  TerminalDeliveryServerMessage,
  TerminalReplicaSnapshot,
} from "@tmux-ide/contracts";
import {
  TERMINAL_DELIVERY_MAX_PIPELINED,
  TERMINAL_DELIVERY_PIPELINING_CAPABILITY_VERSION,
} from "@tmux-ide/contracts";
import {
  admitTerminalDeliveryChunk,
  admitTerminalDeliveryEnvelope,
  blankTerminalReplicaSnapshot,
  commitTerminalDelivery,
  completeTerminalDelivery,
  createTerminalDeliveryClientState,
  hashTerminalReplicaSnapshot,
  TerminalDeliveryAssembler,
} from "@tmux-ide/core";
import {
  SessionRuntimeTerminalDeliveryHub,
  TERMINAL_DELIVERY_CONNECTION_UNACKED_BYTES,
  type TerminalDeliverySourceOwner,
} from "./terminal-delivery-hub.ts";

// Over a long link an echo commits while the previous echo's delivery is still
// unacknowledged. Waiting for that ACK costs up to one more round trip per key,
// so a visible pane sends small patches behind unacknowledged ones (bounded).
const generation = "00000000-0000-4000-8000-000000000001";
const incarnation = `${generation}:0`;

class Owner implements TerminalDeliverySourceOwner {
  listener: ((update: CanonicalTerminalReplicaUpdate) => void) | undefined;
  async subscribeSource(listener: (update: CanonicalTerminalReplicaUpdate) => void) {
    this.listener = listener;
    return { generation, semanticPaneId: "pane", close: async () => {} };
  }
  seed(snapshot: TerminalReplicaSnapshot, revision: number, at = incarnation) {
    this.listener!({
      type: "terminal.seed",
      workspaceName: "w",
      semanticPaneId: "pane",
      generation,
      incarnation: at,
      revision,
      cols: snapshot.cols,
      rows: snapshot.rows,
      snapshot,
      stateHash: hashTerminalReplicaSnapshot(snapshot),
      hashAlgorithm: "fnv1a64-v1",
    });
  }
  /** One typed character echoed at column `revision - 1` of the first row. */
  type(from: TerminalReplicaSnapshot, revision: number, char: string): TerminalReplicaSnapshot {
    const next = structuredClone(from);
    next.grid[0]!.cells[(revision - 1) % next.cols]!.grapheme = char;
    this.listener!({
      type: "terminal.patch",
      workspaceName: "w",
      semanticPaneId: "pane",
      generation,
      incarnation,
      baseRevision: revision - 1,
      revision,
      cols: next.cols,
      rows: next.rows,
      patch: { rows: [{ index: 0, row: structuredClone(next.grid[0]!) }] },
      stateHash: hashTerminalReplicaSnapshot(next),
      hashAlgorithm: "fnv1a64-v1",
    } as CanonicalTerminalReplicaUpdate);
    return next;
  }
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise<void>((r) => setImmediate(r));
};

function initial(historyRows = 20): TerminalReplicaSnapshot {
  const s = structuredClone(blankTerminalReplicaSnapshot(20, 4));
  s.history = Array.from({ length: historyRows }, (_, i) => ({
    ...structuredClone(s.grid[0]!),
    cells: s.grid[0]!.cells.map((c, j) => ({ ...c, grapheme: j === 0 ? String(i % 10) : " " })),
  }));
  return s;
}

type ClientState = ReturnType<typeof createTerminalDeliveryClientState>;

/** Apply one delivery to the client state machine, as a client does. */
function apply(
  state: ClientState,
  e: TerminalDeliveryEnvelope,
  m: TerminalDeliveryServerMessage[],
) {
  let admitted = admitTerminalDeliveryEnvelope(state, e);
  expect(admitted.failed).toBe(false);
  const a = new TerminalDeliveryAssembler(e);
  for (const c of m)
    if (c.type === "terminal.delivery.chunk" && c.transactionId === e.transactionId) {
      admitted = admitTerminalDeliveryChunk(admitted, c);
      a.write(c);
    }
  return commitTerminalDelivery(admitted, completeTerminalDelivery(admitted, a));
}

const deliveries = (m: TerminalDeliveryServerMessage[]) =>
  m.filter((x): x is TerminalDeliveryEnvelope => x.type === "terminal.delivery");
const faults = (m: TerminalDeliveryServerMessage[]) =>
  m.filter((x) => x.type === "terminal.delivery.fault");

async function open(
  protocolVersions = [1],
  encoding = "semantic-v1" as const,
  /** The socket's accept: may hold a frame back until it resolves. */
  socket?: (m: TerminalDeliveryServerMessage) => void | Promise<void>,
) {
  const owner = new Owner();
  const hub = new SessionRuntimeTerminalDeliveryHub(generation, "w", () => owner);
  const messages: TerminalDeliveryServerMessage[] = [];
  const c = await hub.open(
    "client",
    "pane",
    {
      protocolVersions,
      encodings: [encoding as "semantic-v1" | "semantic-compact-v1"],
      richPlacements: false,
    },
    (m) => {
      messages.push(m);
      return socket?.(m);
    },
  );
  return { owner, hub, messages, c };
}

describe.each(["semantic-v1", "semantic-compact-v1"] as const)(
  "pipelined %s patches",
  (encoding) => {
    it("sends each echo while earlier patches are unacknowledged, up to the bound", async () => {
      const { owner, hub, messages, c } = await open([1, 124], encoding);
      try {
        let screen = initial();
        owner.seed(screen, 0);
        await vi.waitFor(() => expect(deliveries(messages)).toHaveLength(1));
        let client = apply(
          createTerminalDeliveryClientState(c.negotiation.negotiated, "w", "pane"),
          deliveries(messages)[0]!,
          messages,
        );
        c.ack(client.ack);
        await settle();

        const screens: TerminalReplicaSnapshot[] = [];
        for (let revision = 1; revision <= TERMINAL_DELIVERY_MAX_PIPELINED + 1; revision++) {
          screen = owner.type(screen, revision, String.fromCharCode(96 + revision));
          screens.push(screen);
          await settle();
        }
        // No ACK yet: the first MAX_PIPELINED echoes are all out, each patched
        // on the one before it; the next waits for an ACK.
        const sent = deliveries(messages).slice(1);
        expect(sent.map((e) => [e.frame, e.baseRevision, e.canonicalRevision])).toEqual(
          Array.from({ length: TERMINAL_DELIVERY_MAX_PIPELINED }, (_, i) => ["patch", i, i + 1]),
        );
        const acks = [];
        for (const e of sent) {
          client = apply(client.state, e, messages);
          acks.push(client.ack);
        }
        expect(client.state.canonicalSnapshot).toEqual(
          screens[TERMINAL_DELIVERY_MAX_PIPELINED - 1],
        );

        c.ack(acks[0]!);
        await vi.waitFor(() =>
          expect(deliveries(messages)).toHaveLength(TERMINAL_DELIVERY_MAX_PIPELINED + 2),
        );
        const last = deliveries(messages).at(-1)!;
        expect([last.frame, last.baseRevision, last.canonicalRevision]).toEqual([
          "patch",
          TERMINAL_DELIVERY_MAX_PIPELINED,
          TERMINAL_DELIVERY_MAX_PIPELINED + 1,
        ]);
        for (const ack of acks.slice(1)) c.ack(ack);
        client = apply(client.state, last, messages);
        c.ack(client.ack);
        await settle();
        expect(client.state.canonicalSnapshot).toEqual(screens.at(-1));
        expect(faults(messages)).toEqual([]);
      } finally {
        await c.close();
        await hub.close();
      }
    });

    it("an ACK that skips the oldest flight is still a protocol violation", async () => {
      const { owner, hub, messages, c } = await open([1, 124], encoding);
      try {
        let screen = initial();
        owner.seed(screen, 0);
        await vi.waitFor(() => expect(deliveries(messages)).toHaveLength(1));
        let client = apply(
          createTerminalDeliveryClientState(c.negotiation.negotiated, "w", "pane"),
          deliveries(messages)[0]!,
          messages,
        );
        c.ack(client.ack);
        screen = owner.type(screen, 1, "a");
        await settle();
        screen = owner.type(screen, 2, "b");
        await settle();
        const [first, second] = deliveries(messages).slice(1);
        client = apply(client.state, first!, messages);
        client = apply(client.state, second!, messages);
        c.ack(client.ack);
        await settle();
        expect(faults(messages)).toHaveLength(1);
      } finally {
        await c.close();
        await hub.close();
      }
    });

    it("a seed waits for every outstanding patch", async () => {
      const { owner, hub, messages, c } = await open([1, 124], encoding);
      try {
        let screen = initial();
        owner.seed(screen, 0);
        await vi.waitFor(() => expect(deliveries(messages)).toHaveLength(1));
        let client = apply(
          createTerminalDeliveryClientState(c.negotiation.negotiated, "w", "pane"),
          deliveries(messages)[0]!,
          messages,
        );
        c.ack(client.ack);
        screen = owner.type(screen, 1, "a");
        await settle();
        expect(deliveries(messages)).toHaveLength(2);
        // A new incarnation (a respawn, a resync) can only be a seed.
        const fresh = initial(3);
        owner.seed(fresh, 2, `${generation}:1`);
        await settle();
        await new Promise((r) => setTimeout(r, 50));
        expect(deliveries(messages)).toHaveLength(2);
        client = apply(client.state, deliveries(messages)[1]!, messages);
        c.ack(client.ack);
        await vi.waitFor(() => expect(deliveries(messages)).toHaveLength(3));
        expect(deliveries(messages)[2]).toMatchObject({ frame: "seed", canonicalRevision: 2 });
        client = apply(client.state, deliveries(messages)[2]!, messages);
        c.ack(client.ack);
        await settle();
        expect(client.state.canonicalSnapshot).toEqual(fresh);
        expect(faults(messages)).toEqual([]);
      } finally {
        await c.close();
        await hub.close();
      }
    });

    it("a NACK drops the pipelined patches; their own NACKs are inert; the pane reseeds", async () => {
      const { owner, hub, messages, c } = await open([1, 124], encoding);
      try {
        let screen = initial();
        owner.seed(screen, 0);
        await vi.waitFor(() => expect(deliveries(messages)).toHaveLength(1));
        let client = apply(
          createTerminalDeliveryClientState(c.negotiation.negotiated, "w", "pane"),
          deliveries(messages)[0]!,
          messages,
        );
        c.ack(client.ack);
        for (let revision = 1; revision <= TERMINAL_DELIVERY_MAX_PIPELINED; revision++) {
          screen = owner.type(screen, revision, "x");
          await settle();
        }
        const sent = deliveries(messages).slice(1);
        expect(sent).toHaveLength(TERMINAL_DELIVERY_MAX_PIPELINED);
        // The client fails the first patch, then rejects each pipelined one
        // (the shipped clients NACK each; the TUI mirror NACKs a chunk again).
        const nack = (e: TerminalDeliveryEnvelope) =>
          c.nack({
            type: "terminal.delivery.nack",
            workspaceName: "w",
            semanticPaneId: "pane",
            generation,
            incarnation: e.incarnation,
            deliveryNonce: e.deliveryNonce,
            transactionId: e.transactionId,
            reason: "hash-mismatch",
            appliedRevision: 0,
          });
        nack(sent[0]!);
        for (const e of sent.slice(1)) {
          nack(e);
          nack(e);
        }
        await vi.waitFor(() =>
          expect(deliveries(messages)).toHaveLength(TERMINAL_DELIVERY_MAX_PIPELINED + 2),
        );
        const reseed = deliveries(messages).at(-1)!;
        expect(reseed).toMatchObject({
          frame: "seed",
          canonicalRevision: TERMINAL_DELIVERY_MAX_PIPELINED,
        });
        const fresh = apply(
          createTerminalDeliveryClientState(c.negotiation.negotiated, "w", "pane"),
          reseed,
          messages,
        );
        c.ack(fresh.ack);
        screen = owner.type(screen, TERMINAL_DELIVERY_MAX_PIPELINED + 1, "y");
        await vi.waitFor(() =>
          expect(deliveries(messages)).toHaveLength(TERMINAL_DELIVERY_MAX_PIPELINED + 3),
        );
        const after = apply(fresh.state, deliveries(messages).at(-1)!, messages);
        expect(after.state.canonicalSnapshot).toEqual(screen);
        expect(faults(messages)).toEqual([]);
      } finally {
        await c.close();
        await hub.close();
      }
    });
  },
);

describe("pipelining behind a large patch", () => {
  it(
    "holds the echo behind a patch over the byte budget, then keeps envelopes and chunks in order",
    { timeout: 60_000 },
    async () => {
      const owner = new Owner();
      const hub = new SessionRuntimeTerminalDeliveryHub(generation, "w", () => owner);
      const messages: TerminalDeliveryServerMessage[] = [];
      // The socket takes one frame at a time; chunks can be held back.
      let hold: (() => void) | null = null;
      let holding = false;
      const c = await hub.open(
        "client",
        "pane",
        { protocolVersions: [1, 124], encodings: ["semantic-v1"], richPlacements: false },
        (m) => {
          messages.push(m);
          if (holding && m.type === "terminal.delivery.chunk")
            return new Promise<void>((resolve) => (hold = resolve));
        },
      );
      try {
        const blank = structuredClone(blankTerminalReplicaSnapshot(300, 30));
        blank.history = Array.from({ length: 400 }, () => structuredClone(blank.grid[0]!));
        let screen = blank;
        owner.seed(screen, 0);
        await vi.waitFor(() => expect(deliveries(messages)).toHaveLength(1), { timeout: 20_000 });
        let client = apply(
          createTerminalDeliveryClientState(c.negotiation.negotiated, "w", "pane"),
          deliveries(messages)[0]!,
          messages,
        );
        c.ack(client.ack);
        await settle();
        // A full-screen redraw: a patch of several chunks.
        const redraw = structuredClone(screen);
        for (const [y, row] of redraw.grid.entries())
          for (const [x, cell] of row.cells.entries()) {
            cell.grapheme = String.fromCharCode(65 + ((x + y) % 26));
            cell.foreground = { kind: "rgb", value: 0xabcdef };
            cell.background = { kind: "rgb", value: 0x123456 };
          }
        holding = true;
        owner.listener!({
          type: "terminal.patch",
          workspaceName: "w",
          semanticPaneId: "pane",
          generation,
          incarnation,
          baseRevision: 0,
          revision: 1,
          cols: redraw.cols,
          rows: redraw.rows,
          patch: { rows: redraw.grid.map((row, index) => ({ index, row: structuredClone(row) })) },
          stateHash: hashTerminalReplicaSnapshot(redraw),
          hashAlgorithm: "fnv1a64-v1",
        } as CanonicalTerminalReplicaUpdate);
        screen = redraw;
        await vi.waitFor(() => expect(hold).not.toBeNull(), { timeout: 20_000 });
        const big = deliveries(messages)[1]!;
        expect(big).toMatchObject({ frame: "patch" });
        expect(big.chunkCount).toBeGreaterThan(1);
        // An echo commits while the redraw's chunks are still going out.
        screen = owner.type(screen, 2, "e");
        await settle();
        holding = false;
        for (let i = 0; i < 20 && hold; i++) {
          const release: () => void = hold;
          hold = null;
          release();
          await settle();
        }
        await new Promise((r) => setTimeout(r, 100));
        // The redraw alone fills the connection's unacknowledged budget.
        expect(big.representationBytes).toBeGreaterThanOrEqual(
          TERMINAL_DELIVERY_CONNECTION_UNACKED_BYTES,
        );
        expect(deliveries(messages)).toHaveLength(2);
        client = apply(client.state, big, messages);
        c.ack(client.ack);
        await vi.waitFor(() => expect(deliveries(messages)).toHaveLength(3), { timeout: 20_000 });
        // Every envelope's chunks follow it with no other envelope between.
        let open: TerminalDeliveryEnvelope | null = null;
        let received = 0;
        for (const m of messages) {
          if (m.type === "terminal.delivery") {
            expect(open === null || received === open.chunkCount).toBe(true);
            open = m;
            received = 0;
          } else if (m.type === "terminal.delivery.chunk") {
            expect(m.transactionId).toBe(open!.transactionId);
            received += 1;
          }
        }
        client = apply(client.state, deliveries(messages)[2]!, messages);
        c.ack(client.ack);
        expect(client.state.canonicalSnapshot).toEqual(screen);
        expect(faults(messages)).toEqual([]);
      } finally {
        await c.close();
        await hub.close();
      }
    },
  );
});

describe("pipelined patches with partial history (capability 122)", () => {
  it("patches each pipelined echo on the history the client will hold", async () => {
    const { owner, hub, messages, c } = await open([1, 122, 124], "semantic-compact-v1");
    try {
      let screen = initial(500);
      owner.seed(screen, 0);
      await vi.waitFor(() => expect(deliveries(messages)).toHaveLength(1));
      const seed = deliveries(messages)[0]!;
      expect(seed.historyUnloaded!.rows).toBeGreaterThan(0);
      let client = apply(
        createTerminalDeliveryClientState(c.negotiation.negotiated, "w", "pane"),
        seed,
        messages,
      );
      c.ack(client.ack);
      await settle();
      for (let revision = 1; revision <= 3; revision++) {
        screen = owner.type(screen, revision, "z");
        await settle();
      }
      const sent = deliveries(messages).slice(1);
      expect(sent.map((e) => [e.frame, e.baseRevision])).toEqual([
        ["patch", 0],
        ["patch", 1],
        ["patch", 2],
      ]);
      for (const e of sent) {
        expect(e.historyUnloaded).toEqual(seed.historyUnloaded);
        client = apply(client.state, e, messages);
        c.ack(client.ack);
      }
      await settle();
      expect(client.state.canonicalSnapshot!.grid).toEqual(screen.grid);
      expect(faults(messages)).toEqual([]);
    } finally {
      await c.close();
      await hub.close();
    }
  });
});

// Review of #454 (review-454): history request, visibility and late ACKs under pipelining.

const historyRequest = (
  c: Awaited<ReturnType<typeof open>>["c"],
  s: ClientState,
  maxRows: number,
) =>
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

describe("review #454 adversarial", () => {
  it("R1 a history request while patches are pipelined: no more pipelining, frame after the ACKs, client applies all", async () => {
    const { owner, hub, messages, c } = await open([1, 122, 124], "semantic-compact-v1");
    try {
      let screen = initial(500);
      owner.seed(screen, 0);
      await vi.waitFor(() => expect(deliveries(messages)).toHaveLength(1));
      let client = apply(
        createTerminalDeliveryClientState(c.negotiation.negotiated, "w", "pane"),
        deliveries(messages)[0]!,
        messages,
      );
      c.ack(client.ack);
      await settle();
      screen = owner.type(screen, 1, "a");
      await settle();
      screen = owner.type(screen, 2, "b");
      await settle();
      expect(deliveries(messages)).toHaveLength(3);
      // The client applied patch 1 and asks for history before ACKing anything.
      const p1 = deliveries(messages)[1]!;
      client = apply(client.state, p1, messages);
      historyRequest(c, client.state, 50);
      screen = owner.type(screen, 3, "c");
      await settle();
      expect(deliveries(messages)).toHaveLength(3); // no pipelining with a history request pending
      c.ack(client.ack);
      await settle();
      const p2 = deliveries(messages)[2]!;
      client = apply(client.state, p2, messages);
      c.ack(client.ack);
      await vi.waitFor(() => expect(deliveries(messages).length).toBeGreaterThanOrEqual(4));
      for (let guard = 0; guard < 6; guard++) {
        const pending = deliveries(messages).slice(3 + guard);
        if (!pending.length) break;
        client = apply(client.state, pending[0]!, messages);
        c.ack(client.ack);
        await settle();
      }
      expect(
        deliveries(messages)
          .slice(3)
          .map((e) => e.frame),
      ).toContain("history");
      expect(client.state.canonicalSnapshot!.grid).toEqual(screen.grid);
      expect(faults(messages)).toEqual([]);
    } finally {
      await c.close();
      await hub.close();
    }
  });

  it("R2 a pane hidden mid-pipeline sends nothing more; visible again catches up", async () => {
    const { owner, hub, messages, c } = await open([1, 124], "semantic-v1");
    try {
      let screen = initial();
      owner.seed(screen, 0);
      await vi.waitFor(() => expect(deliveries(messages)).toHaveLength(1));
      let client = apply(
        createTerminalDeliveryClientState(c.negotiation.negotiated, "w", "pane"),
        deliveries(messages)[0]!,
        messages,
      );
      c.ack(client.ack);
      screen = owner.type(screen, 1, "a");
      await settle();
      c.setVisibility("hidden");
      screen = owner.type(screen, 2, "b");
      screen = owner.type(screen, 3, "c");
      await settle();
      expect(deliveries(messages)).toHaveLength(2);
      client = apply(client.state, deliveries(messages)[1]!, messages);
      c.ack(client.ack);
      await settle();
      expect(deliveries(messages)).toHaveLength(2);
      c.setVisibility("visible");
      await vi.waitFor(() => expect(deliveries(messages)).toHaveLength(3));
      client = apply(client.state, deliveries(messages)[2]!, messages);
      c.ack(client.ack);
      expect(client.state.canonicalSnapshot).toEqual(screen);
      expect(faults(messages)).toEqual([]);
    } finally {
      await c.close();
      await hub.close();
    }
  });

  it("R3 a client that ACKs late sees every patch apply in order across many keys (no fault, no seed)", async () => {
    const { owner, hub, messages, c } = await open([1, 124], "semantic-compact-v1");
    try {
      let screen = initial();
      owner.seed(screen, 0);
      await vi.waitFor(() => expect(deliveries(messages)).toHaveLength(1));
      let client = apply(
        createTerminalDeliveryClientState(c.negotiation.negotiated, "w", "pane"),
        deliveries(messages)[0]!,
        messages,
      );
      c.ack(client.ack);
      let applied = 1;
      const acks: ReturnType<typeof apply>["ack"][] = [];
      for (let revision = 1; revision <= 40; revision++) {
        screen = owner.type(screen, revision, String.fromCharCode(97 + (revision % 26)));
        await settle();
        for (const e of deliveries(messages).slice(applied)) {
          client = apply(client.state, e, messages);
          acks.push(client.ack);
          applied += 1;
        }
        // ACKs arrive one key late: the link is longer than the key gap.
        if (acks.length > 1) c.ack(acks.shift()!);
        expect(acks.length).toBeLessThanOrEqual(3);
      }
      while (acks.length) {
        c.ack(acks.shift()!);
        await settle();
        for (const e of deliveries(messages).slice(applied)) {
          client = apply(client.state, e, messages);
          acks.push(client.ack);
          applied += 1;
        }
      }
      expect(
        deliveries(messages)
          .slice(1)
          .every((e) => e.frame === "patch"),
      ).toBe(true);
      expect(client.state.canonicalSnapshot).toEqual(screen);
      expect(faults(messages)).toEqual([]);
    } finally {
      await c.close();
      await hub.close();
    }
  });
});

describe("capability 124 and the pipelining guards", () => {
  /** A seeded, ACKed client; `typed` echoes go out unacknowledged. */
  async function seeded(
    protocolVersions: number[],
    socket?: (m: TerminalDeliveryServerMessage) => void | Promise<void>,
    screen = initial(),
  ) {
    const opened = await open(protocolVersions, "semantic-v1", socket);
    opened.owner.seed(screen, 0);
    await vi.waitFor(() => expect(deliveries(opened.messages)).toHaveLength(1), {
      timeout: 20_000,
    });
    const client = apply(
      createTerminalDeliveryClientState(opened.c.negotiation.negotiated, "w", "pane"),
      deliveries(opened.messages)[0]!,
      opened.messages,
    );
    opened.c.ack(client.ack);
    await settle();
    return { ...opened, client, screen };
  }
  const nackOf = (e: TerminalDeliveryEnvelope) => ({
    type: "terminal.delivery.nack" as const,
    workspaceName: "w",
    semanticPaneId: "pane",
    generation,
    incarnation: e.incarnation,
    deliveryNonce: e.deliveryNonce,
    transactionId: e.transactionId,
    reason: "hash-mismatch" as const,
    appliedRevision: 0,
  });

  it("keeps one delivery in flight for a client that does not offer 124", async () => {
    const { owner, hub, messages, c, client, screen } = await seeded([1]);
    try {
      const one = owner.type(screen, 1, "a");
      await settle();
      const two = owner.type(one, 2, "b");
      await settle();
      expect(deliveries(messages)).toHaveLength(2);
      const first = apply(client.state, deliveries(messages)[1]!, messages);
      c.ack(first.ack);
      await vi.waitFor(() => expect(deliveries(messages)).toHaveLength(3));
      expect(deliveries(messages)[2]).toMatchObject({ baseRevision: 1, canonicalRevision: 2 });
      expect(
        apply(first.state, deliveries(messages)[2]!, messages).state.canonicalSnapshot,
      ).toEqual(two);
      expect(TERMINAL_DELIVERY_PIPELINING_CAPABILITY_VERSION).toBe(124);
    } finally {
      await c.close();
      await hub.close();
    }
  });

  it("never pipelines behind a seed in flight", async () => {
    const opened = await open([1, 124]);
    const { owner, hub, messages, c } = opened;
    try {
      const screen = initial();
      owner.seed(screen, 0);
      await vi.waitFor(() => expect(deliveries(messages)).toHaveLength(1));
      owner.type(screen, 1, "a");
      await settle();
      await new Promise((r) => setTimeout(r, 50));
      expect(deliveries(messages)).toHaveLength(1);
      const seeded = apply(
        createTerminalDeliveryClientState(c.negotiation.negotiated, "w", "pane"),
        deliveries(messages)[0]!,
        messages,
      );
      c.ack(seeded.ack);
      await vi.waitFor(() => expect(deliveries(messages)).toHaveLength(2));
      expect(deliveries(messages)[1]).toMatchObject({ frame: "patch", baseRevision: 0 });
    } finally {
      await c.close();
      await hub.close();
    }
  });

  it("an ACK for a dropped flight is inert, and the dropped set clears on the next ACK", async () => {
    const { owner, hub, messages, c, screen } = await seeded([1, 124]);
    try {
      let next = screen;
      for (let revision = 1; revision <= 2; revision++) {
        next = owner.type(next, revision, "x");
        await settle();
      }
      const [first, second] = deliveries(messages).slice(1);
      expect(second).toBeDefined();
      c.nack(nackOf(first!));
      // A late ACK naming the dropped flight (it raced the NACK) is ignored.
      c.ack({
        type: "terminal.delivery.ack",
        workspaceName: "w",
        semanticPaneId: "pane",
        generation,
        incarnation: second!.incarnation,
        deliveryNonce: second!.deliveryNonce,
        transactionId: second!.transactionId,
        canonicalRevision: second!.canonicalRevision,
        canonicalStateHash: second!.canonicalStateHash,
        representationHash: second!.representationHash,
      });
      await vi.waitFor(() => expect(deliveries(messages)).toHaveLength(4));
      expect(faults(messages)).toEqual([]);
      const reseed = apply(
        createTerminalDeliveryClientState(c.negotiation.negotiated, "w", "pane"),
        deliveries(messages)[3]!,
        messages,
      );
      c.ack(reseed.ack);
      await settle();
      // After an accepted ACK the old transaction is no longer excused.
      c.nack(nackOf(second!));
      await vi.waitFor(() => expect(faults(messages)).toHaveLength(1));
    } finally {
      await c.close();
      await hub.close();
    }
  });

  it("counts every pipelined byte toward the pane's own budget", async () => {
    const wide = structuredClone(blankTerminalReplicaSnapshot(300, 30));
    const { owner, hub, messages, c, screen } = await seeded([1, 124], undefined, wide);
    try {
      // Redraw `rows` rows with heavy cells: one ~100-200 KiB patch.
      const redraw = (from: TerminalReplicaSnapshot, revision: number, rows: number) => {
        const next = structuredClone(from);
        for (let y = 0; y < rows; y++)
          for (const [x, cell] of next.grid[y]!.cells.entries()) {
            cell.grapheme = String.fromCharCode(65 + ((x + y + revision) % 26));
            cell.foreground = { kind: "rgb", value: 0xabcdef - revision };
            cell.background = { kind: "rgb", value: 0x123456 + revision };
          }
        owner.listener!({
          type: "terminal.patch",
          workspaceName: "w",
          semanticPaneId: "pane",
          generation,
          incarnation,
          baseRevision: revision - 1,
          revision,
          cols: next.cols,
          rows: next.rows,
          patch: {
            rows: next.grid
              .slice(0, rows)
              .map((row, index) => ({ index, row: structuredClone(row) })),
          },
          stateHash: hashTerminalReplicaSnapshot(next),
          hashAlgorithm: "fnv1a64-v1",
        } as CanonicalTerminalReplicaUpdate);
        return next;
      };
      let next = redraw(screen, 1, 4);
      await vi.waitFor(() => expect(deliveries(messages)).toHaveLength(2));
      next = redraw(next, 2, 4);
      await vi.waitFor(() => expect(deliveries(messages)).toHaveLength(3));
      const [a, b] = deliveries(messages).slice(1);
      expect(a!.chunkCount).toBe(1);
      expect(a!.representationBytes).toBeLessThan(TERMINAL_DELIVERY_CONNECTION_UNACKED_BYTES);
      expect(a!.representationBytes + b!.representationBytes).toBeGreaterThanOrEqual(
        TERMINAL_DELIVERY_CONNECTION_UNACKED_BYTES,
      );
      // A third delivery would fit the depth, not the bytes: it waits.
      owner.type(next, 3, "z");
      await settle();
      await new Promise((r) => setTimeout(r, 50));
      expect(deliveries(messages)).toHaveLength(3);
      expect(faults(messages)).toEqual([]);
    } finally {
      await c.close();
      await hub.close();
    }
  });

  it("sends a waiting echo as soon as the previous delivery's chunks are out", async () => {
    let hold: (() => void) | null = null;
    let holding = false;
    const { owner, hub, messages, c, screen } = await seeded([1, 124], (m) => {
      if (holding && m.type === "terminal.delivery")
        return new Promise<void>((resolve) => (hold = resolve));
    });
    try {
      holding = true;
      const one = owner.type(screen, 1, "a");
      await vi.waitFor(() => expect(hold).not.toBeNull());
      holding = false;
      // Echo 2 commits while echo 1's envelope is still on the socket and its
      // chunk not yet sent: it cannot go out yet.
      owner.type(one, 2, "b");
      await settle();
      expect(deliveries(messages)).toHaveLength(2);
      const release: () => void = hold!;
      release();
      // No ACK: echo 2 goes out once echo 1's last chunk is handed over.
      await vi.waitFor(() => expect(deliveries(messages)).toHaveLength(3));
      expect(deliveries(messages)[2]).toMatchObject({ baseRevision: 1, canonicalRevision: 2 });
    } finally {
      await c.close();
      await hub.close();
    }
  });
});
