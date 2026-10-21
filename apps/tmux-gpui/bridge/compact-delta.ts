import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { TerminalReplicaSnapshot } from "../../../packages/contracts/src/terminal-replica.ts";
import {
  decodeCompactSnapshot,
  encodeCompactSnapshot,
  type CompactRow,
  type CompactSnapshot,
} from "./compact-snapshot.ts";

export const COMPACT_DELTA_ENCODING = "rle-delta-v1" as const;
const sequence = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const epochSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/);
const identitySchema = z.object({ epoch: epochSchema, seq: sequence });
export type CompactFullFrame = CompactSnapshot & { epoch: string; seq: number };
export type CompactDeltaFrame = Omit<CompactFullFrame, "encoding" | "grid"> & {
  encoding: typeof COMPACT_DELTA_ENCODING;
  baseSeq: number;
  changedRows: [number, CompactRow][];
};
export type CompactFrame = CompactFullFrame | CompactDeltaFrame;
const deltaEnvelope = z
  .object({
    encoding: z.literal(COMPACT_DELTA_ENCODING),
    epoch: epochSchema,
    seq: sequence,
    baseSeq: sequence,
    cols: z.number().int().min(1).max(65535),
    rows: z.number().int().min(1).max(65535),
    changedRows: z.array(z.tuple([z.number().int().nonnegative(), z.unknown()])).max(262144),
    history: z.unknown(),
    cursor: z.unknown(),
    modes: z.unknown(),
    placements: z.unknown(),
    bootstrap: z.unknown(),
  })
  .strict();

/** A recoverable missing/stale baseline; malformed frames are ordinary errors. */
export class CompactBaselineError extends Error {}

// The encoder owns row/run arrays; these small metadata copies complete ownership.
function ownedCompact(snapshot: TerminalReplicaSnapshot): CompactSnapshot {
  const compact = encodeCompactSnapshot(snapshot);
  return {
    ...compact,
    cursor: { ...compact.cursor },
    modes: { ...compact.modes },
    bootstrap: { ...compact.bootstrap },
    placements: compact.placements.map((placement) => ({ ...placement })),
  };
}

/** One emitted baseline. Call commit only after write accepts the candidate bytes. */
export function createCompactDeltaProducer({ sequenceLimit = Number.MAX_SAFE_INTEGER } = {}) {
  sequence.parse(sequenceLimit);
  let baseline: CompactFullFrame | null = null;
  let baselineRowKeys: string[] = [];
  let identity: string | null = null;
  let generation = 0;
  return {
    reset() {
      baseline = null;
      identity = null;
      baselineRowKeys = [];
      generation++;
    },
    prepare(snapshot: TerminalReplicaSnapshot, nextIdentity: string) {
      const owned = ownedCompact(snapshot);
      const rowKeys = owned.grid.map((row) => JSON.stringify(row));
      const compatible =
        baseline !== null &&
        identity === nextIdentity &&
        baseline.cols === owned.cols &&
        baseline.rows === owned.rows &&
        baseline.modes.alternateScreen === owned.modes.alternateScreen &&
        baseline.seq < sequenceLimit;
      const full: CompactFullFrame = {
        ...owned,
        epoch: compatible ? baseline!.epoch : randomUUID(),
        seq: compatible ? baseline!.seq + 1 : 1,
      };
      let json = JSON.stringify(full);
      let encoding: CompactFrame["encoding"] = "rle-v1";
      if (compatible) {
        const { grid, encoding: _, ...metadata } = full;
        void _;
        const changedRows: CompactDeltaFrame["changedRows"] = [];
        for (const [index, row] of grid.entries())
          if (rowKeys[index] !== baselineRowKeys[index]) changedRows.push([index, row]);
        const delta: CompactDeltaFrame = {
          ...metadata,
          encoding: COMPACT_DELTA_ENCODING,
          baseSeq: baseline!.seq,
          changedRows,
        };
        const deltaJson = JSON.stringify(delta);
        if (Buffer.byteLength(deltaJson, "utf8") < Buffer.byteLength(json, "utf8")) {
          json = deltaJson;
          encoding = COMPACT_DELTA_ENCODING;
        }
      }
      const preparedAt = generation;
      let committed = false;
      return {
        get epoch() {
          return full.epoch;
        },
        get seq() {
          return full.seq;
        },
        get encoding() {
          return encoding;
        },
        get wire() {
          return JSON.parse(json) as CompactFrame;
        },
        json,
        commit() {
          if (committed || generation !== preparedAt)
            throw new Error("Stale compact producer candidate");
          // Do not retain the public candidate object: a consumer may mutate it.
          baseline = full;
          baselineRowKeys = rowKeys;
          identity = nextIdentity;
          generation++;
          committed = true;
        },
      };
    },
  };
}

/** One validated baseline. Outer publication validation must precede commit. */
export function createCompactDeltaStore() {
  let baseline: CompactFullFrame | null = null;
  let generation = 0;
  return {
    reset() {
      baseline = null;
      generation++;
    },
    prepare(value: unknown) {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid compact frame");
      const outline = value as Record<string, unknown>;
      const { epoch, seq } = identitySchema.parse(outline);
      let snapshot: TerminalReplicaSnapshot;
      if (outline.encoding === "rle-v1") {
        const { epoch: _, seq: __, ...compact } = outline;
        void _;
        void __;
        // Full frames can establish a new epoch; same-epoch stale frames cannot rewind.
        snapshot = decodeCompactSnapshot(compact);
        if (baseline?.epoch === epoch && seq <= baseline.seq)
          throw new CompactBaselineError("Stale compact full frame");
      } else {
        const delta = deltaEnvelope.parse(value);
        if (delta.seq !== delta.baseSeq + 1) throw new Error("Invalid compact delta sequence");
        if (
          !baseline ||
          baseline.epoch !== delta.epoch ||
          baseline.seq !== delta.baseSeq ||
          baseline.cols !== delta.cols ||
          baseline.rows !== delta.rows
        )
          throw new CompactBaselineError("Missing compact delta baseline");
        if (delta.changedRows.length > delta.rows) throw new Error("Too many compact changed rows");
        const grid = [...baseline.grid];
        let previous = -1;
        for (const [index, row] of delta.changedRows) {
          if (index <= previous || index >= delta.rows)
            throw new Error("Compact changed rows must be sorted and unique");
          previous = index;
          grid[index] = row as CompactRow;
        }
        const { baseSeq: _, changedRows: __, epoch: ___, seq: ____, ...metadata } = delta;
        void _;
        void __;
        void ___;
        void ____;
        snapshot = decodeCompactSnapshot({ ...metadata, encoding: "rle-v1", grid });
      }
      const full = { ...ownedCompact(snapshot), epoch, seq };
      if (
        baseline &&
        outline.encoding === COMPACT_DELTA_ENCODING &&
        baseline.modes.alternateScreen !== snapshot.modes.alternateScreen
      )
        throw new Error("Compact delta changed screen basis");
      const preparedAt = generation;
      let committed = false;
      return {
        snapshot,
        commit() {
          if (committed || generation !== preparedAt)
            throw new Error("Stale compact store candidate");
          baseline = full;
          generation++;
          committed = true;
        },
      };
    },
  };
}
