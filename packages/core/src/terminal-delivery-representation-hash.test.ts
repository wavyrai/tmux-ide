import { describe, expect, it } from "vitest";
import {
  hashTerminalDeliveryRepresentation,
  splitTerminalDeliveryChunks,
  TerminalDeliveryAssembler,
} from "./terminal-delivery.ts";
import type { TerminalDeliveryEnvelope } from "@tmux-ide/contracts";

// Independent integer arithmetic oracle for the existing two-lane wire digest.
function referenceHash(bytes: Uint8Array): string {
  let high = 0x811c9dc5n;
  let low = 0x9e3779b9n;
  for (const byte of bytes) {
    high = ((high ^ BigInt(byte)) * 0x01000193n) & 0xffffffffn;
    low = ((low ^ BigInt(byte)) * 0x85ebca6bn) & 0xffffffffn;
  }
  return high.toString(16).padStart(8, "0") + low.toString(16).padStart(8, "0");
}
function slicedBytes(length: number): Uint8Array {
  const backing = Uint8Array.from({ length: length + 19 }, (_, index) => (index * 131 + 17) % 256);
  return backing.subarray(7, length + 7);
}
function envelope(bytes: Uint8Array, hash: string): TerminalDeliveryEnvelope {
  return {
    type: "terminal.delivery",
    workspaceName: "hash-parity",
    semanticPaneId: "pane-a",
    generation: "00000000-0000-4000-8000-000000000001",
    incarnation: "00000000-0000-4000-8000-000000000001:0",
    deliveryNonce: "00000000-0000-4000-8000-000000000002",
    transactionId: "00000000-0000-4000-8000-000000000003",
    protocolVersion: 1,
    encoding: "semantic-v1",
    frame: "seed",
    baseRevision: null,
    canonicalRevision: 0,
    canonicalStateHash: "0000000000000000",
    representationHash: hash,
    representationBytes: bytes.byteLength,
    chunkCount: Math.ceil(bytes.byteLength / (256 * 1024)),
    canonicalEquivalent: true,
    history: "complete",
    richPlacements: false,
  };
}

describe("terminal delivery wire hash parity", () => {
  it("preserves unsigned lane arithmetic for empty, sliced and chunk-boundary bytes", () => {
    expect(hashTerminalDeliveryRepresentation(new Uint8Array())).toBe("811c9dc59e3779b9");
    for (const length of [1, 255, 256, 65_537, 262_143, 262_144, 262_145]) {
      const bytes = slicedBytes(length);
      expect(bytes.byteOffset).toBe(7);
      expect(hashTerminalDeliveryRepresentation(bytes)).toBe(referenceHash(bytes));
    }
  });

  it("preserves incremental assembly across full and partial chunks and refuses corruption", () => {
    const bytes = slicedBytes(2 * 256 * 1024 + 17);
    const expected = referenceHash(bytes);
    const metadata = envelope(bytes, expected);
    const chunks = splitTerminalDeliveryChunks(metadata.transactionId, bytes);
    expect(chunks.map((chunk) => chunk.bytes.length)).toEqual([262_144, 262_144, 17]);
    const valid = new TerminalDeliveryAssembler(metadata);
    for (const chunk of chunks) valid.write(chunk);
    expect(valid.complete()).toEqual(bytes);
    expect(hashTerminalDeliveryRepresentation(valid.complete())).toBe(expected);

    const corrupt = new TerminalDeliveryAssembler(metadata);
    for (const chunk of chunks) {
      const changed = new Uint8Array(chunk.bytes.length + 9).subarray(9);
      changed.set(chunk.bytes);
      if (chunk.index === 1) changed[changed.length - 1]! ^= 1;
      corrupt.write({ ...chunk, bytes: changed });
    }
    expect(() => corrupt.complete()).toThrow("representation hash mismatch");
  });
});
