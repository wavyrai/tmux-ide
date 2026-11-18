// History on demand (capability 122): what one history frame costs. The
// encoder strictly validates a row the daemon owns once; the client verifies a
// frame from its commitment and the chunk, without reading the loaded rows.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  TerminalReplicaCellSchemaZ,
  TerminalSemanticHistoryPayloadSchemaZ,
  type TerminalDeliveryEnvelope,
  type TerminalDeliveryHistoryCommitment,
  type TerminalReplicaSnapshot,
} from "@tmux-ide/contracts";
import {
  admitTerminalDeliveryChunk,
  admitTerminalDeliveryEnvelope,
  blankTerminalReplicaSnapshot,
  commitTerminalDelivery,
  completeTerminalDelivery,
  createTerminalDeliveryClientState,
  encodeBinarySemanticTerminalUpdate,
  encodeCompactSemanticTerminalUpdate,
  encodeSemanticTerminalHistory,
  hashTerminalDeliveryRepresentation,
  hashTerminalReplicaSnapshot,
  negotiateTerminalDelivery,
  splitTerminalDeliveryChunks,
  TerminalDeliveryAssembler,
  type TerminalDeliveryClientState,
} from "./index.ts";
import { splitTerminalHistory, takeTerminalHistoryChunk } from "./terminal-partial-history.ts";
import { freezeOwnedTerminalReplicaRow } from "./terminal-replica-owned-row.ts";

type Snap = TerminalReplicaSnapshot;
type Row = Snap["history"][number];
const generation = "00000000-0000-4000-8000-000000000001";
const nonce = "00000000-0000-4000-8000-000000000002";
const incarnation = `${generation}:0`;
const encodings = ["semantic-v1", "semantic-compact-v1", "semantic-binary-v1"] as const;

let counter = 0;
function row(cols: number): Row {
  const base = blankTerminalReplicaSnapshot(cols, 1).grid[0]!;
  return structuredClone({
    ...base,
    cells: base.cells.map((cell) => ({
      ...cell,
      grapheme: String.fromCharCode(0x21 + (counter++ % 90)),
    })),
  });
}
const issues = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (error) {
    return (error as { issues?: unknown }).issues ?? String(error);
  }
};

describe("history frame encoding", () => {
  it.each(encodings)("strictly validates an owned row once, with unchanged bytes (%s)", (enc) => {
    const rows = Array.from({ length: 3 }, () => freezeOwnedTerminalReplicaRow(row(12)));
    const reference = encodeSemanticTerminalHistory(
      { frame: "history", revision: 4, rows: structuredClone(rows) },
      enc,
    );
    const calls = vi.spyOn(TerminalReplicaCellSchemaZ._zod, "run");
    try {
      const fresh = rows.map((owned) => freezeOwnedTerminalReplicaRow(structuredClone(owned)));
      expect(
        encodeSemanticTerminalHistory({ frame: "history", revision: 4, rows: fresh }, enc),
      ).toEqual(reference);
      expect(calls).toHaveBeenCalledTimes(36);
      calls.mockClear();
      expect(
        encodeSemanticTerminalHistory({ frame: "history", revision: 4, rows: fresh }, enc),
      ).toEqual(reference);
      expect(calls).toHaveBeenCalledTimes(0);
      // A frozen row the encoder does not own is validated every time.
      const foreign = Object.freeze(structuredClone(fresh[0]!));
      for (let i = 0; i < 2; i++) {
        calls.mockClear();
        encodeSemanticTerminalHistory({ frame: "history", revision: 4, rows: [foreign] }, enc);
        expect(calls).toHaveBeenCalledTimes(12);
      }
    } finally {
      calls.mockRestore();
    }
  });

  it.each(encodings)(
    "rejects malformed owned rows and payloads like the strict schema (%s)",
    (enc) => {
      const good = freezeOwnedTerminalReplicaRow(row(4));
      const badCell = freezeOwnedTerminalReplicaRow({
        ...row(4),
        cells: row(4).cells.map((cell, index) => (index === 1 ? { ...cell, width: 7 as 1 } : cell)),
      });
      const badWrapped = freezeOwnedTerminalReplicaRow({
        ...row(4),
        wrapped: 4 as unknown as boolean,
      });
      for (const payload of [
        { frame: "history" as const, revision: 1, rows: [good, badCell] },
        { frame: "history" as const, revision: 1, rows: [badWrapped] },
        { frame: "history" as const, revision: 1, rows: [] },
        { frame: "history" as const, revision: -1, rows: [good] },
        { frame: "history" as const, revision: 1, rows: [good], extra: 1 },
        { frame: "history" as const, revision: 1, rows: Array.from({ length: 2001 }, () => good) },
      ]) {
        const expected = issues(() => TerminalSemanticHistoryPayloadSchemaZ.parse(payload));
        expect(expected).not.toBeNull();
        expect(issues(() => encodeSemanticTerminalHistory(payload, enc))).toEqual(expected);
        // Twice: a rejected owned row is not remembered as valid.
        expect(issues(() => encodeSemanticTerminalHistory(payload, enc))).toEqual(expected);
      }
    },
  );
});

describe.each(["semantic-compact-v1", "semantic-binary-v1"] as const)(
  "history frame commit (%s)",
  (encoding) => {
    const negotiation = negotiateTerminalDelivery(
      {
        protocolVersions: encoding === "semantic-binary-v1" ? [1, 109, 111, 122] : [1, 122],
        encodings: ["semantic-compact-v1"],
        richPlacements: false,
      },
      generation,
      nonce,
    );
    if (!negotiation.accepted) throw new Error("not negotiated");
    const negotiated = negotiation.negotiated;

    function admit(
      state: TerminalDeliveryClientState,
      fields: Pick<
        TerminalDeliveryEnvelope,
        "frame" | "baseRevision" | "canonicalRevision" | "canonicalStateHash"
      > & { historyUnloaded: TerminalDeliveryHistoryCommitment },
      bytes: Uint8Array,
    ) {
      const transactionId = randomUUID();
      const envelope: TerminalDeliveryEnvelope = {
        type: "terminal.delivery",
        workspaceName: "w",
        semanticPaneId: "pane",
        generation,
        incarnation,
        deliveryNonce: nonce,
        transactionId,
        protocolVersion: 1,
        encoding,
        ...fields,
        representationHash: hashTerminalDeliveryRepresentation(bytes),
        representationBytes: bytes.byteLength,
        chunkCount: Math.max(1, Math.ceil(bytes.byteLength / (256 * 1024))),
        canonicalEquivalent: true,
        history: "partial",
        richPlacements: false,
      };
      let admitted = admitTerminalDeliveryEnvelope(state, envelope);
      expect(admitted.failed).toBe(false);
      const assembler = new TerminalDeliveryAssembler(envelope);
      for (const chunk of splitTerminalDeliveryChunks(transactionId, bytes)) {
        admitted = admitTerminalDeliveryChunk(admitted, chunk);
        assembler.write(chunk);
      }
      return { admitted, staged: completeTerminalDelivery(admitted, assembler) };
    }
    const historyBytes = (rows: readonly Row[]) =>
      encodeSemanticTerminalHistory({ frame: "history", revision: 0, rows: [...rows] }, encoding);

    /** A client holding the newest `loaded` rows of `full` at revision 0. */
    function seeded(full: Snap, loaded: number) {
      const split = splitTerminalHistory(full, loaded);
      const { admitted, staged } = admit(
        createTerminalDeliveryClientState(negotiated, "w", "pane"),
        {
          frame: "seed",
          baseRevision: null,
          canonicalRevision: 0,
          canonicalStateHash: hashTerminalReplicaSnapshot(full),
          historyUnloaded: split.unloaded,
        },
        (encoding === "semantic-binary-v1"
          ? encodeBinarySemanticTerminalUpdate
          : encodeCompactSemanticTerminalUpdate)({
          frame: "seed",
          revision: 0,
          snapshot: split.snapshot,
        }),
      );
      return commitTerminalDelivery(admitted, staged).state;
    }
    const full = (history: number, cols = 6): Snap => {
      const snapshot = structuredClone(blankTerminalReplicaSnapshot(cols, 3));
      snapshot.history = Array.from({ length: history }, () => row(cols));
      return snapshot;
    };

    it("commits a history frame without reading a loaded row", () => {
      const fullSnap = full(400);
      const state = seeded(fullSnap, 300);
      const chunk = takeTerminalHistoryChunk(fullSnap.history, state.historyUnloaded!.rows, 60);
      const { admitted, staged } = admit(
        state,
        {
          frame: "history",
          baseRevision: 0,
          canonicalRevision: 0,
          canonicalStateHash: hashTerminalReplicaSnapshot(fullSnap),
          historyUnloaded: chunk.unloaded,
        },
        historyBytes(chunk.rows),
      );
      let reads = 0;
      const watched = admitted.canonicalSnapshot!.history.map(
        (loaded) =>
          new Proxy(loaded, {
            get(target, key, receiver) {
              reads += 1;
              return Reflect.get(target, key, receiver);
            },
          }),
      );
      const watchedState = {
        ...admitted,
        canonicalSnapshot: { ...admitted.canonicalSnapshot!, history: watched },
      };
      const committed = commitTerminalDelivery(watchedState, staged).state;
      expect(reads).toBe(0);
      expect(committed.failed).toBe(false);
      expect(committed.historyUnloaded).toEqual(chunk.unloaded);
      const history = committed.canonicalSnapshot!.history;
      expect(history).toHaveLength(360);
      expect(history.slice(60).every((loaded, index) => loaded === watched[index])).toBe(true);
      expect(Object.isFrozen(committed.canonicalSnapshot)).toBe(true);
      expect(Object.isFrozen(history)).toBe(true);
      for (const added of history.slice(0, 60)) {
        expect(Object.isFrozen(added)).toBe(true);
        expect(Object.isFrozen(added.cells)).toBe(true);
        expect(added.cells.every((cell) => Object.isFrozen(cell))).toBe(true);
      }
      expect(history.slice(0, 60)).toEqual(chunk.rows);
    });

    it.each([
      ["another width", () => row(5)],
      [
        "a wide cell without its continuation",
        () => {
          const wide = row(6);
          wide.cells[2] = { ...wide.cells[2]!, width: 2 };
          return wide;
        },
      ],
    ])("refuses a chunk that chains to the commitment with rows of %s", (_, bad) => {
      // A daemon that committed to malformed rows: the digest chains, the rows
      // still have to be valid rows of this snapshot.
      const fullSnap = full(100);
      const forged = {
        ...fullSnap,
        history: [...Array.from({ length: 10 }, bad), ...fullSnap.history.slice(10)],
      };
      const state = seeded(forged, 50);
      const chunk = takeTerminalHistoryChunk(forged.history, state.historyUnloaded!.rows, 50);
      const { admitted, staged } = admit(
        state,
        {
          frame: "history",
          baseRevision: 0,
          canonicalRevision: 0,
          canonicalStateHash: hashTerminalReplicaSnapshot(forged),
          historyUnloaded: chunk.unloaded,
        },
        historyBytes(chunk.rows),
      );
      expect(() => commitTerminalDelivery(admitted, staged)).toThrow(/Malformed/u);
    });

    it("refuses a history frame whose hash is not the committed state's", () => {
      const fullSnap = full(200);
      const state = seeded(fullSnap, 100);
      const chunk = takeTerminalHistoryChunk(fullSnap.history, state.historyUnloaded!.rows, 50);
      const { admitted, staged } = admit(
        state,
        {
          frame: "history",
          baseRevision: 0,
          canonicalRevision: 0,
          canonicalStateHash: hashTerminalReplicaSnapshot(fullSnap),
          historyUnloaded: chunk.unloaded,
        },
        historyBytes(chunk.rows),
      );
      // The admitted envelope names the committed hash; a state that claims
      // another one (never produced by admit) still cannot commit the frame.
      expect(() =>
        commitTerminalDelivery({ ...admitted, appliedHash: "0123456789abcdef" }, staged),
      ).toThrow(/hash mismatch/u);
    });
  },
);
