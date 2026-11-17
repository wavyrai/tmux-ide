import { describe, expect, it } from "vitest";
import {
  TerminalDeliveryEnvelopeSchemaZ,
  TerminalDeliveryNegotiatedSchemaZ,
  TerminalDeliveryOfferSchemaZ,
  TerminalDeliveryHistoryRequestSchemaZ,
  TerminalSemanticHistoryPayloadSchemaZ,
  TerminalSemanticDeliveryPayloadSchemaZ,
  TERMINAL_DELIVERY_PARTIAL_HISTORY_CAPABILITY_VERSION,
  TERMINAL_DELIVERY_HISTORY_TAIL_ROWS,
  TERMINAL_DELIVERY_HISTORY_CHUNK_MAX_ROWS,
} from "../terminal-delivery.ts";

const address = {
  workspaceName: "workspace",
  semanticPaneId: "pane-a",
  generation: "00000000-0000-4000-8000-000000000001",
  incarnation: "incarnation:1",
  deliveryNonce: "00000000-0000-4000-8000-000000000002",
} as const;

describe("terminal delivery contracts", () => {
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

  describe("history on demand (capability 122)", () => {
    const negotiated = {
      protocolVersion: 1,
      encoding: "semantic-compact-v1",
      partialHistory: "tail-v1",
      richPlacements: false,
      generation: address.generation,
      deliveryNonce: address.deliveryNonce,
    } as const;
    const envelope = {
      type: "terminal.delivery",
      ...address,
      transactionId: "00000000-0000-4000-8000-000000000003",
      protocolVersion: 1,
      encoding: "semantic-compact-v1",
      frame: "seed",
      baseRevision: null,
      canonicalRevision: 4,
      canonicalStateHash: "0000000000000000",
      representationHash: "0000000000000000",
      representationBytes: 0,
      chunkCount: 1,
      canonicalEquivalent: true,
      history: "partial",
      historyUnloaded: { rows: 1800, digest: "0123456789abcdef" },
      richPlacements: false,
    } as const;
    const row = {
      cells: [
        {
          grapheme: "a",
          width: 1,
          foreground: { kind: "default" },
          background: { kind: "default" },
          attributes: 0,
        },
      ],
      wrapped: false,
    };

    it("publishes its numbers", () => {
      expect(TERMINAL_DELIVERY_PARTIAL_HISTORY_CAPABILITY_VERSION).toBe(122);
      expect(TERMINAL_DELIVERY_HISTORY_TAIL_ROWS).toBe(200);
      expect(TERMINAL_DELIVERY_HISTORY_CHUNK_MAX_ROWS).toBe(2000);
    });

    it("negotiates partial history only for compact or binary semantic delivery, never with the projection", () => {
      expect(TerminalDeliveryNegotiatedSchemaZ.parse(negotiated).partialHistory).toBe("tail-v1");
      expect(
        TerminalDeliveryNegotiatedSchemaZ.parse({ ...negotiated, encoding: "semantic-binary-v1" })
          .partialHistory,
      ).toBe("tail-v1");
      for (const encoding of ["semantic-v1", "ansi-diff-v1"])
        expect(
          TerminalDeliveryNegotiatedSchemaZ.safeParse({ ...negotiated, encoding }).success,
        ).toBe(false);
      expect(
        TerminalDeliveryNegotiatedSchemaZ.safeParse({
          ...negotiated,
          encoding: "semantic-binary-v1",
          alternateScreenProjection: "deferred-history-v1",
        }).success,
      ).toBe(false);
    });

    it("binds a partial history to its unloaded commitment", () => {
      expect(TerminalDeliveryEnvelopeSchemaZ.parse(envelope)).toEqual(envelope);
      const { historyUnloaded: _unloaded, ...missing } = envelope;
      void _unloaded;
      expect(TerminalDeliveryEnvelopeSchemaZ.safeParse(missing).success).toBe(false);
      expect(
        TerminalDeliveryEnvelopeSchemaZ.safeParse({ ...envelope, history: "complete" }).success,
      ).toBe(false);
      expect(
        TerminalDeliveryEnvelopeSchemaZ.safeParse({
          ...envelope,
          historyUnloaded: { rows: 1, digest: "xyz" },
        }).success,
      ).toBe(false);
      expect(
        TerminalDeliveryEnvelopeSchemaZ.safeParse({
          ...envelope,
          frame: "tombstone",
          baseRevision: 3,
        }).success,
      ).toBe(false);
    });

    it("carries a history frame at the client's revision, never advancing it", () => {
      const history = { ...envelope, frame: "history", baseRevision: 4 } as const;
      expect(TerminalDeliveryEnvelopeSchemaZ.parse(history).frame).toBe("history");
      expect(
        TerminalDeliveryEnvelopeSchemaZ.safeParse({ ...history, baseRevision: 3 }).success,
      ).toBe(false);
      expect(
        TerminalDeliveryEnvelopeSchemaZ.safeParse({ ...history, baseRevision: null }).success,
      ).toBe(false);
      const { historyUnloaded: _u, ...complete } = history;
      void _u;
      expect(
        TerminalDeliveryEnvelopeSchemaZ.safeParse({ ...complete, history: "complete" }).success,
      ).toBe(false);
    });

    it("bounds a history payload to 1-2000 rows", () => {
      const payload = (rows: number) => ({
        frame: "history",
        revision: 4,
        rows: Array.from({ length: rows }, () => row),
      });
      expect(TerminalSemanticHistoryPayloadSchemaZ.parse(payload(1)).frame).toBe("history");
      expect(TerminalSemanticHistoryPayloadSchemaZ.safeParse(payload(2000)).success).toBe(true);
      expect(TerminalSemanticHistoryPayloadSchemaZ.safeParse(payload(0)).success).toBe(false);
      expect(TerminalSemanticHistoryPayloadSchemaZ.safeParse(payload(2001)).success).toBe(false);
      // The seed, patch and tombstone union never takes a history payload.
      expect(TerminalSemanticDeliveryPayloadSchemaZ.safeParse(payload(1)).success).toBe(false);
    });

    it("names the client's baseline in a history request", () => {
      const request = {
        type: "terminal.delivery.history-request",
        ...address,
        canonicalRevision: 4,
        unloadedRows: 1800,
        maxRows: 500,
      } as const;
      expect(TerminalDeliveryHistoryRequestSchemaZ.parse(request)).toEqual(request);
      for (const mutation of [{ maxRows: 0 }, { maxRows: 2001 }, { unloadedRows: -1 }, { x: 1 }])
        expect(
          TerminalDeliveryHistoryRequestSchemaZ.safeParse({ ...request, ...mutation }).success,
        ).toBe(false);
    });
  });
});
