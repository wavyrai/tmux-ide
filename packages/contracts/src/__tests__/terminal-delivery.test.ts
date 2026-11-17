import { describe, expect, it } from "vitest";
import {
  TerminalDeliveryEnvelopeSchemaZ,
  TerminalDeliveryNegotiatedSchemaZ,
  TerminalDeliveryOfferSchemaZ,
} from "../terminal-delivery.ts";

const address = {
  workspaceName: "workspace",
  semanticPaneId: "pane-a",
  generation: "00000000-0000-4000-8000-000000000001",
  incarnation: "incarnation:1",
  deliveryNonce: "00000000-0000-4000-8000-000000000002",
} as const;

describe("terminal delivery contracts", () => {
  it("takes up to 16 capability numbers in an offer", () => {
    const offer = (count: number) => ({
      protocolVersions: [1, ...Array.from({ length: count - 1 }, (_, index) => 100 + index)],
      encodings: ["semantic-compact-v1"],
      richPlacements: true,
    });
    for (const count of [9, 10, 16])
      expect(TerminalDeliveryOfferSchemaZ.parse(offer(count)).protocolVersions).toHaveLength(count);
    expect(TerminalDeliveryOfferSchemaZ.safeParse(offer(17)).success).toBe(false);
    expect(
      TerminalDeliveryOfferSchemaZ.safeParse({ ...offer(1), protocolVersions: [] }).success,
    ).toBe(false);
  });

  it("rejects duplicate negotiation offers and impossible capabilities", () => {
    expect(() =>
      TerminalDeliveryOfferSchemaZ.parse({
        protocolVersions: [1, 1],
        encodings: ["semantic-v1"],
        richPlacements: false,
      }),
    ).toThrow();
    expect(() =>
      TerminalDeliveryNegotiatedSchemaZ.parse({
        protocolVersion: 1,
        encoding: "ansi-diff-v1",
        richPlacements: true,
        generation: address.generation,
        deliveryNonce: address.deliveryNonce,
      }),
    ).toThrow();
  });

  it("binds chunk count, base revision, equivalence, history and rich claims", () => {
    const valid = {
      type: "terminal.delivery",
      ...address,
      transactionId: "00000000-0000-4000-8000-000000000003",
      performanceTraceId: "00000000-0000-4000-8000-000000000004",
      protocolVersion: 1,
      encoding: "semantic-v1",
      frame: "seed",
      baseRevision: null,
      canonicalRevision: 0,
      canonicalStateHash: "0000000000000000",
      representationHash: "0000000000000000",
      representationBytes: 0,
      chunkCount: 1,
      canonicalEquivalent: true,
      history: "complete",
      richPlacements: false,
    } as const;
    expect(TerminalDeliveryEnvelopeSchemaZ.parse(valid)).toEqual(valid);
    expect(() =>
      TerminalDeliveryEnvelopeSchemaZ.parse({ ...valid, performanceTraceId: "not-a-uuid" }),
    ).toThrow();
    for (const mutation of [
      { chunkCount: 2 },
      { baseRevision: 0 },
      { canonicalEquivalent: false },
      { history: "truncated" },
    ])
      expect(() => TerminalDeliveryEnvelopeSchemaZ.parse({ ...valid, ...mutation })).toThrow();
  });

  it("allows canonical tombstones only with no history", () => {
    const tombstone = {
      type: "terminal.delivery",
      ...address,
      transactionId: "00000000-0000-4000-8000-000000000003",
      protocolVersion: 1,
      encoding: "semantic-v1",
      frame: "tombstone",
      baseRevision: 0,
      canonicalRevision: 1,
      canonicalStateHash: "0000000000000000",
      representationHash: "0000000000000000",
      representationBytes: 0,
      chunkCount: 1,
      canonicalEquivalent: true,
      history: "not-applicable",
      richPlacements: false,
    } as const;
    expect(TerminalDeliveryEnvelopeSchemaZ.parse(tombstone).history).toBe("not-applicable");
  });
});
