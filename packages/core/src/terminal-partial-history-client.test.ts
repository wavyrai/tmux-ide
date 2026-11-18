// History on demand (capability 122), client side: negotiation, partial seeds
// and patches verified against the full canonical hash, and history frames.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  TerminalDeliveryEnvelope,
  TerminalDeliveryHistoryCommitment,
  TerminalReplicaSnapshot,
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

type Snap = TerminalReplicaSnapshot;
type Row = Snap["history"][number];
const generation = "00000000-0000-4000-8000-000000000001";
const nonce = "00000000-0000-4000-8000-000000000002";
const incarnation = `${generation}:0`;

let counter = 0;
function row(cols: number, tag: string): Row {
  const base = blankTerminalReplicaSnapshot(cols, 1).grid[0]!;
  counter += 1;
  return structuredClone({
    ...base,
    cells: base.cells.map((cell, index) => ({
      ...cell,
      grapheme: index === 0 ? tag : index === 1 ? String(counter % 10) : " ",
    })),
  });
}
function full(history: number): Snap {
  const snapshot = structuredClone(blankTerminalReplicaSnapshot(6, 3));
  snapshot.grid = snapshot.grid.map(() => row(6, "g"));
  snapshot.history = Array.from({ length: history }, () => row(6, "h"));
  return snapshot;
}

describe.each(["semantic-compact-v1", "semantic-binary-v1"] as const)(
  "partial history client (%s)",
  (encoding) => {
    const offer = {
      protocolVersions: encoding === "semantic-binary-v1" ? [1, 109, 111, 122] : [1, 122],
      encodings: ["semantic-compact-v1" as const],
      richPlacements: false,
    };
    const negotiation = negotiateTerminalDelivery(offer, generation, nonce);
    if (!negotiation.accepted) throw new Error("not negotiated");
    const negotiated = negotiation.negotiated;

    const encodeUpdate = (payload: Parameters<typeof encodeCompactSemanticTerminalUpdate>[0]) =>
      encoding === "semantic-binary-v1"
        ? encodeBinarySemanticTerminalUpdate(payload)
        : encodeCompactSemanticTerminalUpdate(payload);

    function deliver(
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
      if (admitted.failed) return { state: admitted, ack: null };
      const assembler = new TerminalDeliveryAssembler(envelope);
      for (const chunk of splitTerminalDeliveryChunks(transactionId, bytes)) {
        admitted = admitTerminalDeliveryChunk(admitted, chunk);
        assembler.write(chunk);
      }
      return commitTerminalDelivery(admitted, completeTerminalDelivery(admitted, assembler));
    }

    it("negotiates partial history and drops the alternate-screen projection", () => {
      expect(negotiated.partialHistory).toBe("tail-v1");
      expect(negotiated.alternateScreenProjection).toBeUndefined();
      expect(negotiated.encoding).toBe(encoding);
      const without = negotiateTerminalDelivery(
        { ...offer, protocolVersions: offer.protocolVersions.filter((v) => v !== 122) },
        generation,
        nonce,
      );
      expect(without.accepted && without.negotiated.partialHistory).toBeFalsy();
    });

    it("commits a partial seed, a patch and history chunks, each verified by the full hash", () => {
      let fullSnap = full(500);
      const split = splitTerminalHistory(fullSnap, 200);
      let state = createTerminalDeliveryClientState(negotiated, "w", "pane");
      const seeded = deliver(
        state,
        {
          frame: "seed",
          baseRevision: null,
          canonicalRevision: 0,
          canonicalStateHash: hashTerminalReplicaSnapshot(fullSnap),
          historyUnloaded: split.unloaded,
        },
        encodeUpdate({ frame: "seed", revision: 0, snapshot: split.snapshot }),
      );
      state = seeded.state;
      expect(state.failed).toBe(false);
      expect(state.historyUnloaded).toEqual(split.unloaded);
      expect(state.canonicalSnapshot!.history).toHaveLength(200);

      // A scroll at the limit: 20 rows trimmed (all unloaded), 20 appended.
      const append = Array.from({ length: 20 }, () => row(6, "s"));
      const nextFull = { ...fullSnap, history: [...fullSnap.history.slice(20), ...append] };
      const nextUnloaded = splitTerminalHistory(nextFull, 220).unloaded;
      const patched = deliver(
        state,
        {
          frame: "patch",
          baseRevision: 0,
          canonicalRevision: 1,
          canonicalStateHash: hashTerminalReplicaSnapshot(nextFull),
          historyUnloaded: nextUnloaded,
        },
        encodeUpdate({
          frame: "patch",
          baseRevision: 0,
          revision: 1,
          patch: { rows: [], historyDelta: { trim: 0, append } },
        }),
      );
      state = patched.state;
      fullSnap = nextFull;
      expect(state.failed).toBe(false);
      expect(state.historyUnloaded).toEqual(nextUnloaded);

      // Load everything, newest first.
      while (state.historyUnloaded!.rows > 0) {
        const chunk = takeTerminalHistoryChunk(fullSnap.history, state.historyUnloaded!.rows, 120);
        const loaded = deliver(
          state,
          {
            frame: "history",
            baseRevision: 1,
            canonicalRevision: 1,
            canonicalStateHash: hashTerminalReplicaSnapshot(fullSnap),
            historyUnloaded: chunk.unloaded,
          },
          encodeSemanticTerminalHistory(
            { frame: "history", revision: 1, rows: [...chunk.rows] },
            encoding,
          ),
        );
        expect(loaded.state.failed).toBe(false);
        expect(loaded.ack).toMatchObject({ canonicalRevision: 1 });
        state = loaded.state;
      }
      expect(state.canonicalSnapshot).toEqual(fullSnap);
      expect(state.appliedRevision).toBe(1);
    });

    it("refuses a history chunk with a wrong row, and a commitment that grows", () => {
      const fullSnap = full(300);
      const split = splitTerminalHistory(fullSnap, 50);
      const hash = hashTerminalReplicaSnapshot(fullSnap);
      const state = deliver(
        createTerminalDeliveryClientState(negotiated, "w", "pane"),
        {
          frame: "seed",
          baseRevision: null,
          canonicalRevision: 0,
          canonicalStateHash: hash,
          historyUnloaded: split.unloaded,
        },
        encodeUpdate({ frame: "seed", revision: 0, snapshot: split.snapshot }),
      ).state;
      const chunk = takeTerminalHistoryChunk(fullSnap.history, split.unloaded.rows, 40);
      const rows = [...chunk.rows];
      rows[3] = row(6, "x");
      expect(() =>
        deliver(
          state,
          {
            frame: "history",
            baseRevision: 0,
            canonicalRevision: 0,
            canonicalStateHash: hash,
            historyUnloaded: chunk.unloaded,
          },
          encodeSemanticTerminalHistory({ frame: "history", revision: 0, rows }, encoding),
        ),
      ).toThrow(/history chunk/u);
      // A patch may not claim more unloaded rows than the client had.
      expect(() =>
        deliver(
          state,
          {
            frame: "patch",
            baseRevision: 0,
            canonicalRevision: 1,
            canonicalStateHash: hash,
            historyUnloaded: { rows: split.unloaded.rows + 1, digest: split.unloaded.digest },
          },
          encodeUpdate({ frame: "patch", baseRevision: 0, revision: 1, patch: { rows: [] } }),
        ),
      ).toThrow(/unloaded/u);
      // A history frame must name the client's committed state exactly.
      expect(
        deliver(
          state,
          {
            frame: "history",
            baseRevision: 0,
            canonicalRevision: 0,
            canonicalStateHash: "0123456789abcdef",
            historyUnloaded: chunk.unloaded,
          },
          encodeSemanticTerminalHistory(
            { frame: "history", revision: 0, rows: [...chunk.rows] },
            encoding,
          ),
        ).state.failed,
      ).toBe(true);
      // A history frame is refused before any seed, or at another revision.
      const fresh = createTerminalDeliveryClientState(negotiated, "w", "pane");
      expect(
        deliver(
          fresh,
          {
            frame: "history",
            baseRevision: 0,
            canonicalRevision: 0,
            canonicalStateHash: hash,
            historyUnloaded: chunk.unloaded,
          },
          encodeSemanticTerminalHistory(
            { frame: "history", revision: 0, rows: [...chunk.rows] },
            encoding,
          ),
        ).state.failed,
      ).toBe(true);
    });

    it("refuses a partial envelope on a stream that did not negotiate it", () => {
      const plain = negotiateTerminalDelivery(
        { ...offer, protocolVersions: offer.protocolVersions.filter((v) => v !== 122) },
        generation,
        nonce,
      );
      if (!plain.accepted) throw new Error("not negotiated");
      const fullSnap = full(10);
      const split = splitTerminalHistory(fullSnap, 5);
      expect(
        deliver(
          createTerminalDeliveryClientState(plain.negotiated, "w", "pane"),
          {
            frame: "seed",
            baseRevision: null,
            canonicalRevision: 0,
            canonicalStateHash: hashTerminalReplicaSnapshot(fullSnap),
            historyUnloaded: split.unloaded,
          },
          encodeUpdate({ frame: "seed", revision: 0, snapshot: split.snapshot }),
        ).state.failed,
      ).toBe(true);
    });
  },
);
