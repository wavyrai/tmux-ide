import { it, expect } from "vitest";
import {
  TerminalProjectionEnvelopeSchemaZ,
  TerminalProjectionReceiptSchemaZ,
  TerminalProjectionMaterializeSchemaZ,
} from "./terminal-projection.ts";
import {
  TerminalDeliveryAckSchemaZ,
  TerminalDeliveryEnvelopeSchemaZ,
} from "./terminal-delivery.ts";
const address = {
  workspaceName: "workspace",
  semanticPaneId: "pane-a",
  generation: "00000000-0000-4000-8000-000000000001",
  incarnation: "pane:1",
  deliveryNonce: "00000000-0000-4000-8000-000000000002",
};
const proof = {
  ...address,
  transactionId: "00000000-0000-4000-8000-000000000003",
  canonicalRevision: 1,
  canonicalStateHash: "0".repeat(16),
  projectionStateHash: "1".repeat(16),
  representationHash: "2".repeat(16),
};
const envelope = {
  ...proof,
  type: "terminal.projection",
  protocolVersion: 1,
  encoding: "alternate-projection-binary-v1",
  frame: "seed",
  baseRevision: null,
  representationBytes: 8,
  chunkCount: 1,
  canonicalEquivalent: false,
  history: "deferred",
  richPlacements: true,
};
it("keeps projection envelopes and receipts outside canonical truth", () => {
  expect(TerminalProjectionEnvelopeSchemaZ.safeParse(envelope).success).toBe(true);
  expect(TerminalDeliveryEnvelopeSchemaZ.safeParse(envelope).success).toBe(false);
  const receipt = { ...proof, type: "terminal.projection.receipt" };
  expect(TerminalProjectionReceiptSchemaZ.safeParse(receipt).success).toBe(true);
  expect(TerminalDeliveryAckSchemaZ.safeParse(receipt).success).toBe(false);
  for (const change of [
    { history: "complete" },
    { canonicalEquivalent: true },
    { chunkCount: 2 },
    { representationBytes: 16 * 1024 * 1024 + 1 },
    { canonicalRevision: Number.MAX_SAFE_INTEGER + 1 },
    { baseRevision: 0 },
    { unexpected: true },
  ])
    expect(TerminalProjectionEnvelopeSchemaZ.safeParse({ ...envelope, ...change }).success).toBe(
      false,
    );
});
it("binds materialization to a strict scoped projection proof", () => {
  const request = {
    ...address,
    type: "terminal.projection.materialize",
    requestId: proof.transactionId,
    canonicalRevision: 1,
    projectionStateHash: proof.projectionStateHash,
  };
  expect(TerminalProjectionMaterializeSchemaZ.safeParse(request).success).toBe(true);
  for (const change of [
    { projectionStateHash: "bad" },
    { requestId: "bad" },
    { canonicalRevision: -1 },
    { history: [] },
  ])
    expect(TerminalProjectionMaterializeSchemaZ.safeParse({ ...request, ...change }).success).toBe(
      false,
    );
});
