import { z } from "zod";
import { TerminalDeliveryNegotiationResultSchemaZ } from "@tmux-ide/contracts";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  blankTerminalReplicaSnapshot,
  decodeCompactSemanticTerminalUpdate,
  decodeBinarySemanticTerminalUpdate,
  encodeBinarySemanticTerminalUpdate,
  encodeBinarySemanticTerminalUpdateCooperatively,
  hashTerminalDeliveryRepresentation,
  negotiateTerminalDelivery,
} from "./index.ts";
import { BinaryTerminalWriter, decodeBinaryTerminalTuple } from "./terminal-delivery-binary.ts";

const vectors = JSON.parse(
  readFileSync(
    new URL(
      "../../../apps/tmux-gpui/upstream/crates/herdr-client/src/tmux_delivery/tests/binary-vectors.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { wire: string; bytes: number[]; representationHash: string }[];
describe("binary semantic delivery", () => {
  it.each([109, 110, 111, 112])("requires an explicit projection offer (%s)", (capability) => {
    const result = negotiateTerminalDelivery(
      {
        protocolVersions: [1, capability],
        encodings: ["semantic-compact-v1"],
        richPlacements: true,
      },
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    );
    expect(result.accepted).toBe(true);
    if (!result.accepted) throw new Error("negotiation failed");
    expect(result.negotiated.encoding).toBe("semantic-binary-v1");
    expect(result.negotiated.alternateScreenProjection).toBe(
      capability >= 111 ? "deferred-history-v1" : undefined,
    );
    expect(TerminalDeliveryNegotiationResultSchemaZ.safeParse(result).success).toBe(true);
  });

  it("matches shared Rust lifecycle vectors and canonical compact updates", () => {
    for (const vector of vectors) {
      const update = decodeCompactSemanticTerminalUpdate(new TextEncoder().encode(vector.wire));
      const bytes = encodeBinarySemanticTerminalUpdate(update);
      expect([...bytes]).toEqual(vector.bytes);
      expect(hashTerminalDeliveryRepresentation(bytes)).toBe(vector.representationHash);
      expect(decodeBinarySemanticTerminalUpdate(bytes)).toEqual(update);
      for (let length = 0; length < bytes.length; length++)
        expect(() => decodeBinarySemanticTerminalUpdate(bytes.subarray(0, length))).toThrow();
    }
  });
  it("negotiates only explicit compatible bundles", () => {
    for (const capability of [109, 110]) {
      const legacyOfferSchema = z
        .object({
          protocolVersions: z.array(z.number().int().positive()).min(1).max(8),
          encodings: z
            .array(z.enum(["semantic-compact-v1", "semantic-v1", "ansi-diff-v1", "ansi-raw-v1"]))
            .min(1)
            .max(4),
          richPlacements: z.boolean(),
        })
        .strict();
      const result = negotiateTerminalDelivery(
        legacyOfferSchema.parse({
          protocolVersions: [1, 101, 102, 103, 104, 105, 106, capability],
          encodings: ["semantic-compact-v1"],
          richPlacements: true,
        }),
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
      );
      expect(TerminalDeliveryNegotiationResultSchemaZ.parse(result)).toMatchObject({
        accepted: true,
        negotiated: { encoding: "semantic-binary-v1" },
      });
    }
    expect(
      negotiateTerminalDelivery(
        {
          protocolVersions: [1, 101, 107],
          encodings: ["semantic-compact-v1"],
          richPlacements: false,
        },
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
      ),
    ).toMatchObject({ accepted: true, negotiated: { encoding: "semantic-compact-v1" } });
  });
  it("accepts strongly compressed state within the fixed expanded bound", () => {
    const update = {
      frame: "seed" as const,
      revision: 0,
      snapshot: blankTerminalReplicaSnapshot(4096, 100),
    };
    const bytes = encodeBinarySemanticTerminalUpdate(update);
    expect(bytes.length * 64).toBeLessThan(409600);
    expect(decodeBinarySemanticTerminalUpdate(bytes)).toEqual(update);
  });
  it("cooperates within one wide row and cancels before completing it", async () => {
    const update = {
      frame: "seed" as const,
      revision: 0,
      snapshot: blankTerminalReplicaSnapshot(4096, 1),
    };
    let checkpoints = 0;
    expect(
      await encodeBinarySemanticTerminalUpdateCooperatively(update, {
        yieldControl: async () => {
          checkpoints++;
        },
      }),
    ).toEqual(encodeBinarySemanticTerminalUpdate(update));
    expect(checkpoints).toBeGreaterThanOrEqual(16);
    const wide = update.snapshot.grid[0]!;
    const giant = {
      ...update,
      snapshot: {
        ...update.snapshot,
        grid: [
          { ...wide, cells: wide.cells.map((cell) => ({ ...cell, grapheme: "x".repeat(1024) })) },
        ],
      },
    };
    const abort = new AbortController();
    await expect(
      encodeBinarySemanticTerminalUpdateCooperatively(giant, {
        signal: abort.signal,
        yieldControl: async () => {
          abort.abort();
        },
      }),
    ).rejects.toThrow();
  });
  it("rejects expanded cell budgets before allocating overflowing row", () => {
    const bytes = encodeBinarySemanticTerminalUpdate({
      frame: "seed",
      revision: 0,
      snapshot: blankTerminalReplicaSnapshot(4096, 1),
    });
    const tuple = decodeBinaryTerminalTuple(bytes).value as unknown[];
    tuple[1] = 246;
    tuple[2] = Array(246).fill((tuple[2] as unknown[])[0]);
    const writer = new BinaryTerminalWriter();
    writer.header("seed", 0);
    writer.value(tuple);
    expect(() => decodeBinarySemanticTerminalUpdate(writer.finish())).toThrow();
    const tomb = new BinaryTerminalWriter();
    tomb.header("tombstone", 1, 0);
    tomb.value(["pane-closed"]);
    expect(() => decodeBinarySemanticTerminalUpdate(tomb.finish())).toThrow();
  });
  it("preserves a literal leading BOM inside cell strings", () => {
    const snapshot = blankTerminalReplicaSnapshot(1, 1);
    const row = snapshot.grid[0]!;
    const update = {
      frame: "seed" as const,
      revision: 0,
      snapshot: {
        ...snapshot,
        grid: [{ ...row, cells: [{ ...row.cells[0]!, grapheme: "\ufeff" }] }],
      },
    };
    expect(decodeBinarySemanticTerminalUpdate(encodeBinarySemanticTerminalUpdate(update))).toEqual(
      update,
    );
  });
  it("rejects noncanonical integers, bad UTF8, trailing bytes and unsafe array sizes", () => {
    for (const bytes of [
      [84, 67, 66, 49, 0, 128, 0, 0],
      [84, 67, 66, 49, 0, 0, 2, 1, 255],
      [84, 67, 66, 49, 0, 0, 0, 0],
      [84, 67, 66, 49, 0, 0, 3, 255, 255, 127],
    ])
      expect(() => decodeBinaryTerminalTuple(Uint8Array.from(bytes))).toThrow();
    const writer = new BinaryTerminalWriter();
    expect(() => writer.value("\ud800")).toThrow();
  });
});
