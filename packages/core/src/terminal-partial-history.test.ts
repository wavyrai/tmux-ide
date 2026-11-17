// History on demand (capability 122): a client holding the newest rows plus a
// commitment to the older rows verifies against the full canonical state hash,
// and loading every chunk gives exactly the snapshot a fresh full seed gives.
import { describe, expect, it } from "vitest";
import type { TerminalReplicaSnapshot } from "@tmux-ide/contracts";
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
});
