import { describe, expect, it } from "vitest";
import {
  TerminalDeliveryEnvelopeSchemaZ,
  type TerminalDeliveryEnvelope,
} from "@tmux-ide/contracts";
import {
  admitTerminalDeliveryChunk,
  admitTerminalDeliveryEnvelope,
  blankTerminalReplicaSnapshot,
  commitTerminalDelivery,
  completeTerminalDelivery,
  createTerminalDeliveryClientState,
  encodeAnsiTerminalPatchRepresentation,
  encodeSemanticTerminalUpdate,
  hashTerminalDeliveryRepresentation,
  hashTerminalReplicaSnapshot,
  negotiateTerminalDelivery,
  nackTerminalDelivery,
  splitTerminalDeliveryChunks,
  TerminalDeliveryAssembler,
} from "./index.ts";

const generation = "00000000-0000-4000-8000-000000000001";
const nonce = "00000000-0000-4000-8000-000000000002";
const tx = "00000000-0000-4000-8000-000000000003";

function seedEnvelope(): { envelope: TerminalDeliveryEnvelope; bytes: Uint8Array } {
  const snapshot = blankTerminalReplicaSnapshot(2, 1);
  const bytes = encodeSemanticTerminalUpdate({ frame: "seed", revision: 0, snapshot });
  return {
    bytes,
    envelope: TerminalDeliveryEnvelopeSchemaZ.parse({
      type: "terminal.delivery",
      workspaceName: "workspace",
      semanticPaneId: "pane-a",
      generation,
      incarnation: `${generation}:0`,
      deliveryNonce: nonce,
      transactionId: tx,
      protocolVersion: 1,
      encoding: "semantic-v1",
      frame: "seed",
      baseRevision: null,
      canonicalRevision: 0,
      canonicalStateHash: hashTerminalReplicaSnapshot(snapshot),
      representationHash: hashTerminalDeliveryRepresentation(bytes),
      representationBytes: bytes.byteLength,
      chunkCount: Math.max(1, Math.ceil(bytes.byteLength / (256 * 1024))),
      canonicalEquivalent: true,
      history: "complete",
      richPlacements: false,
    }),
  };
}

describe("terminal delivery client", () => {
  it("encodes ordinary ANSI deltas from dirty rows without inspecting the full grid", () => {
    const snapshot = blankTerminalReplicaSnapshot(4, 3);
    const inaccessibleGrid = new Proxy(snapshot.grid, {
      get() {
        throw new Error("unchanged grid row was inspected");
      },
    });
    const target = { ...snapshot, grid: inaccessibleGrid };
    const bytes = encodeAnsiTerminalPatchRepresentation(
      { rows: [{ index: 1, row: snapshot.grid[1]! }] },
      target,
    );
    expect(new TextDecoder().decode(bytes)).toContain("\u001b[2;1H");
  });
  it("negotiates deterministically and rejects unsupported rich ANSI", () => {
    expect(
      negotiateTerminalDelivery(
        { protocolVersions: [2], encodings: ["semantic-v1"], richPlacements: false },
        generation,
        nonce,
      ),
    ).toEqual({ accepted: false, reason: "protocol-version-mismatch" });
    expect(
      negotiateTerminalDelivery(
        { protocolVersions: [1], encodings: ["ansi-diff-v1"], richPlacements: true },
        generation,
        nonce,
      ),
    ).toEqual({ accepted: false, reason: "unsupported-capability-combination" });
  });

  it("ACKs only after exact chunks decode, apply and canonical hash verification", () => {
    const negotiated = negotiateTerminalDelivery(
      { protocolVersions: [1], encodings: ["semantic-v1"], richPlacements: false },
      generation,
      nonce,
    );
    if (!negotiated.accepted) throw new Error("negotiation failed");
    const { envelope, bytes } = seedEnvelope();
    let state = admitTerminalDeliveryEnvelope(
      createTerminalDeliveryClientState(negotiated.negotiated, "workspace", "pane-a"),
      envelope,
    );
    if (!state.inFlight) throw new Error("not admitted");
    const assembler = new TerminalDeliveryAssembler(state.inFlight);
    for (const chunk of splitTerminalDeliveryChunks(tx, bytes)) {
      state = admitTerminalDeliveryChunk(state, chunk);
      assembler.write(chunk);
    }
    const committed = commitTerminalDelivery(state, completeTerminalDelivery(state, assembler));
    expect(committed.ack.canonicalRevision).toBe(0);
    expect(committed.state.canonicalSnapshot).not.toBeNull();
    expect(committed.semanticUpdate).toMatchObject({ frame: "seed", revision: 0 });
  });

  it("rejects representation corruption and semantic frame confusion", () => {
    const { envelope, bytes } = seedEnvelope();
    const corrupt = new TerminalDeliveryAssembler(envelope);
    const chunks = splitTerminalDeliveryChunks(tx, bytes);
    chunks[0]!.bytes[0] = (chunks[0]!.bytes[0] ?? 0) ^ 1;
    for (const chunk of chunks) corrupt.write(chunk);
    expect(() => corrupt.complete()).toThrow(/hash mismatch/u);
    const negotiated = negotiateTerminalDelivery(
      { protocolVersions: [1], encodings: ["semantic-v1"], richPlacements: false },
      generation,
      nonce,
    );
    if (!negotiated.accepted) throw new Error("negotiation failed");
    let state = admitTerminalDeliveryEnvelope(
      createTerminalDeliveryClientState(negotiated.negotiated, "workspace", "pane-a"),
      envelope,
    );
    if (!state.inFlight) throw new Error("not admitted");
    const seedAssembler = new TerminalDeliveryAssembler(state.inFlight);
    for (const chunk of splitTerminalDeliveryChunks(tx, bytes)) {
      state = admitTerminalDeliveryChunk(state, chunk);
      seedAssembler.write(chunk);
    }
    state = commitTerminalDelivery(state, completeTerminalDelivery(state, seedAssembler)).state;
    const snapshot = blankTerminalReplicaSnapshot(2, 1);
    const patchBytes = encodeSemanticTerminalUpdate({
      frame: "seed",
      revision: 1,
      snapshot,
    });
    const confused = TerminalDeliveryEnvelopeSchemaZ.parse({
      ...envelope,
      transactionId: "00000000-0000-4000-8000-000000000004",
      frame: "patch",
      baseRevision: 0,
      canonicalRevision: 1,
      representationHash: hashTerminalDeliveryRepresentation(patchBytes),
      representationBytes: patchBytes.byteLength,
    });
    state = admitTerminalDeliveryEnvelope(state, confused);
    if (!state.inFlight) throw new Error("confused delivery not admitted");
    const assembler = new TerminalDeliveryAssembler(state.inFlight);
    for (const chunk of splitTerminalDeliveryChunks(confused.transactionId, patchBytes)) {
      state = admitTerminalDeliveryChunk(state, chunk);
      assembler.write(chunk);
    }
    const staged = completeTerminalDelivery(state, assembler);
    expect(() => commitTerminalDelivery(state, staged)).toThrow(/frame or revision/u);
  });

  it("bounds allocation at the schema boundary and requires ANSI presentation before ACK", () => {
    const { envelope } = seedEnvelope();
    expect(
      () =>
        new TerminalDeliveryAssembler({
          ...envelope,
          representationBytes: Number.NaN,
        } as TerminalDeliveryEnvelope),
    ).toThrow();
    const bytes = new TextEncoder().encode("\u001b[2J");
    const ansiEnvelope = TerminalDeliveryEnvelopeSchemaZ.parse({
      ...envelope,
      encoding: "ansi-diff-v1",
      canonicalEquivalent: false,
      history: "complete",
      representationHash: hashTerminalDeliveryRepresentation(bytes),
      representationBytes: bytes.byteLength,
    });
    const negotiated = negotiateTerminalDelivery(
      { protocolVersions: [1], encodings: ["ansi-diff-v1"], richPlacements: false },
      generation,
      nonce,
    );
    if (!negotiated.accepted) throw new Error("negotiation failed");
    let state = admitTerminalDeliveryEnvelope(
      createTerminalDeliveryClientState(negotiated.negotiated, "workspace", "pane-a"),
      ansiEnvelope,
    );
    if (!state.inFlight) throw new Error("not admitted");
    const assembler = new TerminalDeliveryAssembler(state.inFlight);
    for (const chunk of splitTerminalDeliveryChunks(tx, bytes)) {
      state = admitTerminalDeliveryChunk(state, chunk);
      assembler.write(chunk);
    }
    const staged = completeTerminalDelivery(state, assembler);
    expect(() => commitTerminalDelivery(state, staged)).toThrow(/presentation/u);
    expect(
      commitTerminalDelivery(state, staged, { presentationApplied: true }).ack.canonicalRevision,
    ).toBe(0);
  });

  it("never advances a baseline on NACK", () => {
    const negotiated = negotiateTerminalDelivery(
      { protocolVersions: [1], encodings: ["semantic-v1"], richPlacements: false },
      generation,
      nonce,
    );
    if (!negotiated.accepted) throw new Error("negotiation failed");
    const initial = createTerminalDeliveryClientState(negotiated.negotiated, "workspace", "pane-a");
    const rejected = nackTerminalDelivery(initial, {
      type: "terminal.delivery.nack",
      workspaceName: "workspace",
      semanticPaneId: "pane-a",
      generation,
      incarnation: `${generation}:0`,
      deliveryNonce: nonce,
      transactionId: null,
      reason: "gap",
      appliedRevision: -1,
    });
    expect(rejected.appliedRevision).toBe(-1);
    expect(rejected.reseedRequired).toBe(true);
  });
});
