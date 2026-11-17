// History on demand (capability 122): a client holding the newest rows plus a
// commitment to the older rows verifies against the full canonical state hash,
// and loading every chunk gives exactly the snapshot a fresh full seed gives.
import { describe, expect, it } from "vitest";
import {
  TerminalDeliveryHistoryCommitmentSchemaZ,
  type TerminalReplicaSnapshot,
} from "@tmux-ide/contracts";
import {
  blankTerminalReplicaSnapshot,
  decodeBinarySemanticTerminalUpdate,
  decodeCompactSemanticTerminalUpdate,
  decodeSemanticTerminalHistory,
  encodeCompactSemanticTerminalUpdate,
  encodeSemanticTerminalHistory,
  hashTerminalReplicaRows,
  hashTerminalReplicaSnapshot,
} from "./index.ts";
import {
  concatTerminalHistoryDigest,
  dropTerminalHistoryCommitmentPrefix,
  popTerminalHistoryCommitmentSuffix,
  hashPartialTerminalReplicaSnapshot,
  prependVerifiedTerminalHistory,
  splitTerminalHistory,
  takeTerminalHistoryChunk,
  terminalHistoryPrefixCommitment,
} from "./terminal-partial-history.ts";

type Snap = TerminalReplicaSnapshot;
type Row = Snap["history"][number];

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

let counter = 0;
function row(cols: number, tag: string): Row {
  const base = blankTerminalReplicaSnapshot(cols, 1).grid[0]!;
  counter += 1;
  return structuredClone({
    ...base,
    wrapped: counter % 7 === 0,
    cells: base.cells.map((cell, index) => ({
      ...cell,
      grapheme: index === 0 ? tag : index === 1 ? String(counter % 10) : " ",
    })),
  });
}

describe("partial terminal history", () => {
  it("splits the rows digest exactly: H(A ++ B) = H(A)·P^|B| + H(B)", () => {
    const rows = Array.from({ length: 37 }, (_, index) => row(6, `r${index % 10}`));
    for (const cut of [0, 1, 18, 36, 37])
      expect(
        concatTerminalHistoryDigest(hashTerminalReplicaRows(rows.slice(0, cut)), rows.slice(cut)),
      ).toBe(hashTerminalReplicaRows(rows));
  });

  it("rejects a chunk with one wrong row", () => {
    const full = structuredClone(blankTerminalReplicaSnapshot(6, 3));
    full.history = Array.from({ length: 50 }, () => row(6, "h"));
    const { snapshot, unloaded } = splitTerminalHistory(full, 10);
    const chunk = takeTerminalHistoryChunk(full.history, unloaded.rows, 20);
    expect(() =>
      prependVerifiedTerminalHistory(snapshot, unloaded, chunk.rows, chunk.unloaded),
    ).not.toThrow();
    const tampered = [...chunk.rows];
    tampered[5] = row(6, "x");
    expect(() =>
      prependVerifiedTerminalHistory(snapshot, unloaded, tampered, chunk.unloaded),
    ).toThrow(/history chunk/u);
    // A chunk that claims more rows were loaded than it carries.
    expect(() =>
      prependVerifiedTerminalHistory(snapshot, unloaded, chunk.rows.slice(1), chunk.unloaded),
    ).toThrow(/history chunk/u);
  });

  it.each(Array.from({ length: 60 }, (_, index) => index + 1))(
    "seed %i: random histories, chunk loads and trims always verify, and loading all equals a fresh seed",
    (seed) => {
      const rand = rng(seed * 104729);
      const int = (n: number) => Math.floor(rand() * n);
      const cols = 3 + int(6);
      let full: Snap = structuredClone(blankTerminalReplicaSnapshot(cols, 2 + int(4)));
      full.grid = full.grid.map(() => row(cols, "g"));
      full.history = Array.from({ length: int(400) }, () => row(cols, "h"));
      const split = splitTerminalHistory(full, int(60));
      let client = split.snapshot;
      let unloaded = split.unloaded;
      const check = () => {
        expect(unloaded).toEqual(terminalHistoryPrefixCommitment(full.history, unloaded.rows));
        expect(client.history).toEqual(full.history.slice(unloaded.rows));
        expect(hashPartialTerminalReplicaSnapshot(client, unloaded)).toBe(
          hashTerminalReplicaSnapshot(full),
        );
      };
      check();
      for (let step = 0; step < 40; step++) {
        const op = int(100);
        if (op < 35 && unloaded.rows > 0) {
          // The client loads the newest rows of what it lacks.
          const chunk = takeTerminalHistoryChunk(full.history, unloaded.rows, 1 + int(80));
          client = prependVerifiedTerminalHistory(client, unloaded, chunk.rows, chunk.unloaded);
          unloaded = chunk.unloaded;
        } else if (op < 75) {
          // Output scrolls: the daemon trims t of the oldest rows and appends a;
          // the trim takes unloaded rows first, then loaded ones.
          const trim = int(Math.min(full.history.length, 60) + 1);
          const append = Array.from({ length: int(30) }, () => row(cols, "s"));
          full = { ...full, history: [...full.history.slice(trim), ...append] };
          const fromUnloaded = Math.min(trim, unloaded.rows);
          const nextUnloaded = terminalHistoryPrefixCommitment(
            full.history,
            unloaded.rows - fromUnloaded,
          );
          client = {
            ...client,
            history: [...client.history.slice(trim - fromUnloaded), ...append],
          };
          unloaded = nextUnloaded;
        } else if (op < 85) {
          const index = int(full.rows);
          const grid = [...full.grid];
          grid[index] = row(cols, "e");
          full = { ...full, grid };
          client = { ...client, grid };
        } else {
          // A reseed with a new tail.
          const reseed = splitTerminalHistory(full, int(80));
          client = reseed.snapshot;
          unloaded = reseed.unloaded;
        }
        check();
      }
      while (unloaded.rows > 0) {
        const chunk = takeTerminalHistoryChunk(full.history, unloaded.rows, 2000);
        client = prependVerifiedTerminalHistory(client, unloaded, chunk.rows, chunk.unloaded);
        unloaded = chunk.unloaded;
      }
      expect(unloaded).toEqual({ rows: 0, digest: hashTerminalReplicaRows([]) });
      expect(client).toEqual(full);
      expect(hashTerminalReplicaSnapshot(client)).toBe(hashTerminalReplicaSnapshot(full));
      expect(
        encodeCompactSemanticTerminalUpdate({ frame: "seed", revision: 1, snapshot: client }),
      ).toEqual(
        encodeCompactSemanticTerminalUpdate({ frame: "seed", revision: 1, snapshot: full }),
      );
    },
  );

  it.each(["semantic-v1", "semantic-compact-v1", "semantic-binary-v1"] as const)(
    "round-trips a history payload in %s, and the seed and patch decoders refuse it",
    (encoding) => {
      const rows = Array.from({ length: 30 }, (_, index) => row(7, `c${index % 10}`));
      const payload = { frame: "history" as const, revision: 12, rows };
      const bytes = encodeSemanticTerminalHistory(payload, encoding);
      expect(decodeSemanticTerminalHistory(bytes, encoding)).toEqual(payload);
      if (encoding === "semantic-binary-v1") {
        expect(bytes[4]).toBe(3);
        expect(() => decodeBinarySemanticTerminalUpdate(bytes)).toThrow();
      }
      if (encoding === "semantic-compact-v1")
        expect(() => decodeCompactSemanticTerminalUpdate(bytes)).toThrow();
      expect(() => encodeSemanticTerminalHistory({ ...payload, rows: [] }, encoding)).toThrow();
    },
  );

  // Review of #435 (review-435): P is odd, so any wrong rows R have a "next"
  // digest that chains to the current one. Only pinning the last commitment
  // ({rows: 0} is H of no rows) makes the per-chunk check an induction proof.
  it("refuses a forged chunk chain that ends in a nonzero empty commitment", () => {
    const M = 1n << 64n;
    const P = 0x100000001b3n;
    const inverse = (a: bigint) => {
      let x = a;
      for (let i = 0; i < 6; i++) x = (x * (2n - a * x)) % M;
      return ((x % M) + M) % M;
    };
    const hex = (v: bigint) => (((v % M) + M) % M).toString(16).padStart(16, "0");
    const full = structuredClone(blankTerminalReplicaSnapshot(4, 2));
    full.history = [row(4, "a"), row(4, "b"), row(4, "c")];
    const { snapshot, unloaded } = splitTerminalHistory(full, 1);
    const x = row(4, "X");
    const y = row(4, "Y");
    const n =
      ((BigInt(`0x${unloaded.digest}`) - BigInt(`0x${hashTerminalReplicaRows([x])}`)) *
        inverse(P)) %
      M;
    const middle = { rows: 1, digest: hex(n) };
    const forged = prependVerifiedTerminalHistory(snapshot, unloaded, [x], middle);
    const last = {
      rows: 0,
      digest: hex(((n - BigInt(`0x${hashTerminalReplicaRows([y])}`)) * inverse(P)) % M),
    };
    expect(last.digest).not.toBe("0000000000000000");
    expect(() => prependVerifiedTerminalHistory(forged, middle, [y], last)).toThrow(
      /history chunk/u,
    );
    // The same pin on the wire.
    expect(TerminalDeliveryHistoryCommitmentSchemaZ.safeParse(last).success).toBe(false);
    expect(
      TerminalDeliveryHistoryCommitmentSchemaZ.safeParse({ rows: 0, digest: "0000000000000000" })
        .success,
    ).toBe(true);
  });

  it("refuses a chunk whose rows do not account for the unloaded rows it consumes", () => {
    const full = structuredClone(blankTerminalReplicaSnapshot(4, 2));
    full.history = Array.from({ length: 6 }, () => row(4, "h"));
    const { snapshot, unloaded } = splitTerminalHistory(full, 2);
    const chunk = takeTerminalHistoryChunk(full.history, unloaded.rows, 2);
    // Right rows and digest, but the commitment claims one row fewer remains.
    expect(() =>
      prependVerifiedTerminalHistory(snapshot, unloaded, chunk.rows, {
        ...chunk.unloaded,
        rows: chunk.unloaded.rows - 1,
      }),
    ).toThrow(/history chunk/u);
  });

  it("updates a commitment in O(trim): dropping its oldest rows or its newest chunk", () => {
    const history = Array.from({ length: 300 }, (_, index) => row(5, `d${index % 10}`));
    for (const unloaded of [0, 1, 150, 300])
      for (const dropped of [0, 1, 37, unloaded]) {
        if (dropped > unloaded) continue;
        const before = terminalHistoryPrefixCommitment(history, unloaded);
        expect(dropTerminalHistoryCommitmentPrefix(before, history.slice(0, dropped))).toEqual(
          terminalHistoryPrefixCommitment(history.slice(dropped), unloaded - dropped),
        );
        expect(
          popTerminalHistoryCommitmentSuffix(before, history.slice(unloaded - dropped, unloaded)),
        ).toEqual(terminalHistoryPrefixCommitment(history, unloaded - dropped));
      }
  });

  it("refuses a compact history payload with extra or reordered keys", () => {
    const payload = { frame: "history" as const, revision: 3, rows: [row(5, "k")] };
    const wire = JSON.parse(
      new TextDecoder().decode(encodeSemanticTerminalHistory(payload, "semantic-compact-v1")),
    ) as Record<string, unknown>;
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    expect(decodeSemanticTerminalHistory(encode(wire), "semantic-compact-v1")).toEqual(payload);
    expect(() =>
      decodeSemanticTerminalHistory(encode({ ...wire, x: 1 }), "semantic-compact-v1"),
    ).toThrow();
    const { f, h, k, r, v } = wire;
    expect(() =>
      decodeSemanticTerminalHistory(encode({ h, f, k, r, v }), "semantic-compact-v1"),
    ).toThrow();
  });
});
