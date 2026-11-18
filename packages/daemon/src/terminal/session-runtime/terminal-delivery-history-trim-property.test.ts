// Property test for #423, written by its reviewer (review-393).
// A client that lags (coalesced deliveries) must end with exactly the snapshot a
// fresh seed of the delivered revision gives, after any sequence of scrolls at
// the history limit, appends, grid edits, history clears, resizes, reseeds with
// fresh or shared row identity, and reconnects.
import { afterAll, describe, expect, it } from "vitest";
import type {
  CanonicalTerminalReplicaUpdate,
  TerminalReplicaSnapshot,
  TerminalDeliveryEnvelope,
  TerminalDeliveryServerMessage,
} from "@tmux-ide/contracts";
import {
  blankTerminalReplicaSnapshot,
  decodeCompactSemanticTerminalUpdate,
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
  for (let i = 0; i < 6; i++) await new Promise<void>((r) => setImmediate(r));
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

// What the runs exercised: the coalesced trim patch must actually occur.
const exercised = { coalescedTrimPatches: 0, checked: 0 };
afterAll(() => {
  expect(exercised.checked).toBeGreaterThan(0);
  expect(exercised.coalescedTrimPatches).toBeGreaterThan(0);
});

describe.each(["semantic-v1", "semantic-compact-v1"] as const)(
  "review fuzz: coalesced %s deliveries equal a fresh seed",
  (encoding) => {
    it.each(Array.from({ length: 40 }, (_, i) => i + 1))(
      "seed %i",
      async (seed) => {
        const rand = rng(seed * 7919 + (encoding === "semantic-v1" ? 1 : 2));
        const int = (n: number) => Math.floor(rand() * n);
        const LIMIT = 30;
        const owner = new Owner();
        const hub = new SessionRuntimeTerminalDeliveryHub(generation, "w", () => owner);
        let counter = 0;
        const mkRow = (cols: number, tag: string): Row => {
          const base = blankTerminalReplicaSnapshot(cols, 1).grid[0]!;
          counter += 1;
          return structuredClone({
            ...base,
            cells: base.cells.map((c, j) => ({
              ...c,
              grapheme: j === 0 ? tag : j === 1 ? String(counter % 10) : " ",
            })),
          });
        };
        let incarnationEpoch = 0;
        let revision = 0;
        const snapshots = new Map<number, Snap>();
        let cur: Snap = structuredClone(blankTerminalReplicaSnapshot(5, 3));
        cur.grid = cur.grid.map(() => mkRow(5, "g"));
        cur.history = Array.from({ length: int(LIMIT + 1) }, () => mkRow(5, "h"));
        const emitSeed = (snap: Snap) => {
          cur = snap;
          snapshots.set(revision, structuredClone(snap));
          owner.listener!({
            type: "terminal.seed",
            workspaceName: "w",
            semanticPaneId: "pane",
            generation,
            incarnation: `${generation}:${incarnationEpoch}`,
            revision,
            cols: snap.cols,
            rows: snap.rows,
            snapshot: snap,
            stateHash: hashTerminalReplicaSnapshot(snap),
            hashAlgorithm: "fnv1a64-v1",
          });
        };
        const emitPatch = (next: Snap, patch: Record<string, unknown>) => {
          revision += 1;
          cur = next;
          snapshots.set(revision, structuredClone(next));
          owner.listener!({
            type: "terminal.patch",
            workspaceName: "w",
            semanticPaneId: "pane",
            generation,
            incarnation: `${generation}:${incarnationEpoch}`,
            baseRevision: revision - 1,
            revision,
            cols: next.cols,
            rows: next.rows,
            patch,
            stateHash: hashTerminalReplicaSnapshot(next),
            hashAlgorithm: "fnv1a64-v1",
          } as CanonicalTerminalReplicaUpdate);
        };

        type Client = {
          c: Awaited<ReturnType<typeof hub.open>>;
          messages: TerminalDeliveryServerMessage[];
          state: ReturnType<typeof createTerminalDeliveryClientState> | null;
          processed: number;
          /** ACKs not yet sent, oldest first: a client ACKs every delivery, in order. */
          pendingAcks: unknown[];
          id: string;
        };
        const open = async (id: string): Promise<Client> => {
          const messages: TerminalDeliveryServerMessage[] = [];
          const c = await hub.open(
            id,
            "pane",
            { protocolVersions: [1], encodings: [encoding], richPlacements: false },
            (m) => {
              messages.push(m);
            },
          );
          return {
            c,
            messages,
            state: createTerminalDeliveryClientState(c.negotiation.negotiated, "w", "pane"),
            processed: 0,
            pendingAcks: [],
            id,
          };
        };
        const stats = {
          patches: 0,
          seeds: 0,
          trims: 0,
          checked: 0,
          coalescedTrimPatches: 0,
          adjacentTrimPatches: 0,
        };
        // Commit every new delivery; check it; keep the ack to send later (lag).
        const drain = (cl: Client) => {
          for (; cl.processed < cl.messages.length; cl.processed++) {
            const m = cl.messages[cl.processed]!;
            if (m.type !== "terminal.delivery") continue;
            const e = m as TerminalDeliveryEnvelope;
            let admitted = admitTerminalDeliveryEnvelope(cl.state!, e);
            const a = new TerminalDeliveryAssembler(e);
            for (const c of cl.messages)
              if (c.type === "terminal.delivery.chunk" && c.transactionId === e.transactionId) {
                admitted = admitTerminalDeliveryChunk(admitted, c);
                a.write(c);
              }
            const result = commitTerminalDelivery(admitted, completeTerminalDelivery(admitted, a));
            cl.state = result.state;
            if (e.frame === "patch") {
              stats.patches += 1;
              const bytes = a.complete();
              const body =
                e.encoding === "semantic-compact-v1"
                  ? decodeCompactSemanticTerminalUpdate(bytes)
                  : JSON.parse(new TextDecoder().decode(bytes));
              const t = body.patch?.historyDelta?.trim ?? 0;
              if (t > 0 && e.baseRevision !== e.canonicalRevision - 1)
                stats.coalescedTrimPatches += 1;
              if (t > 0 && e.baseRevision === e.canonicalRevision - 1)
                stats.adjacentTrimPatches += 1;
            }
            if (e.frame === "seed") stats.seeds += 1;
            const expected = snapshots.get(e.canonicalRevision);
            expect(expected, `revision ${e.canonicalRevision} known`).toBeDefined();
            expect(result.state.canonicalSnapshot).toEqual(expected);
            stats.checked += 1;
            cl.pendingAcks.push(result.ack);
          }
        };

        let clients = [await open("a"), await open("b")];
        await settle();
        emitSeed(cur);
        await settle();
        try {
          for (let step = 0; step < 60; step++) {
            const op = int(100);
            if (op < 45) {
              // scroll k rows at the history limit (trim)
              const k = 1 + int(4);
              const grid = [...cur.grid];
              const append: Row[] = [];
              for (let n = 0; n < k; n++) {
                append.push(grid.shift()!);
                grid.push(mkRow(cur.cols, "s"));
              }
              const all = [...cur.history, ...append];
              const trim = Math.max(0, all.length - LIMIT);
              const history = all.slice(trim);
              const next = { ...cur, grid, history };
              if (trim) stats.trims += 1;
              emitPatch(structuredClone(next), {
                rows: grid.map((row, index) => ({ index, row: structuredClone(row) })),
                historyDelta: {
                  trim: Math.min(trim, cur.history.length),
                  append: structuredClone(append.slice(Math.max(0, trim - cur.history.length))),
                },
              });
            } else if (op < 60) {
              const index = int(cur.rows);
              const grid = [...cur.grid];
              grid[index] = mkRow(cur.cols, "e");
              emitPatch(structuredClone({ ...cur, grid }), {
                rows: [{ index, row: structuredClone(grid[index]) }],
              });
            } else if (op < 66) {
              emitPatch(structuredClone({ ...cur, history: [] }), { rows: [], history: [] });
            } else if (op < 72) {
              // resize: new dimensions, reflowed (fresh) history
              const cols = 4 + int(4);
              const rows = 2 + int(3);
              const snap = structuredClone(blankTerminalReplicaSnapshot(cols, rows));
              snap.grid = snap.grid.map(() => mkRow(cols, "r"));
              snap.history = cur.history
                .slice(int(cur.history.length + 1))
                .map(() => mkRow(cols, "r"));
              revision += 1;
              emitSeed(snap);
            } else if (op < 78) {
              // same-dimension reseed: same content, fresh identity (a reseed)
              revision += 1;
              emitSeed(structuredClone(cur));
            } else if (op < 82) {
              // same-dimension reseed that SHARES and REPEATS row objects:
              // adversarial identity (a blank row object recurring, rows shifted)
              const pool = cur.history.length ? cur.history : [mkRow(cur.cols, "p")];
              const shared = pool[int(pool.length)]!;
              const history: Row[] = [];
              const n = int(LIMIT + 1);
              for (let i = 0; i < n; i++)
                history.push(rand() < 0.5 ? shared : pool[int(pool.length)]!);
              revision += 1;
              emitSeed({ ...cur, history, grid: [...cur.grid] });
            } else if (op < 85) {
              // new incarnation (session restart) with the same rows
              incarnationEpoch += 1;
              revision += 1;
              emitSeed(structuredClone(cur));
            } else if (op < 90) {
              // reconnect: a client goes and a new one comes
              const gone = clients.shift()!;
              await gone.c.close();
              clients.push(await open(`c${step}`));
            }
            await settle();
            for (const cl of clients) drain(cl);
            // Ack only sometimes, so deliveries coalesce over skipped revisions.
            for (const cl of clients)
              if (cl.pendingAcks.length && rand() < 0.35) {
                cl.c.ack(cl.pendingAcks.shift() as never);
              }
            await settle();
            for (const cl of clients) drain(cl);
          }
          // Converge: ack until each client holds the latest revision.
          for (let round = 0; round < 20; round++) {
            for (const cl of clients)
              while (cl.pendingAcks.length) {
                cl.c.ack(cl.pendingAcks.shift() as never);
              }
            await settle();
            for (const cl of clients) drain(cl);
          }
          for (const cl of clients)
            expect(cl.state!.canonicalSnapshot).toEqual(snapshots.get(revision));
          exercised.coalescedTrimPatches += stats.coalescedTrimPatches;
          exercised.checked += stats.checked;
        } finally {
          for (const cl of clients) await cl.c.close();
          await hub.close();
        }
      },
      60_000,
    );
  },
);
