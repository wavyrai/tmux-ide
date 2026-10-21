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

type Baseline = { wire: CompactFullFrame; snapshot: TerminalReplicaSnapshot };
function equalRow(a: CompactRow, b: CompactRow): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** One emitted baseline. Call commit only after write accepts the candidate bytes. */
export function createCompactDeltaProducer({ sequenceLimit = Number.MAX_SAFE_INTEGER } = {}) {
  sequence.parse(sequenceLimit);
  let baseline: CompactFullFrame | null = null;
  let identity: string | null = null;
  let generation = 0;
  return {
    reset() {
      baseline = null;
      identity = null;
      generation++;
    },
    prepare(snapshot: TerminalReplicaSnapshot, nextIdentity: string) {
      const compact = encodeCompactSnapshot(snapshot);
      // Own the candidate data independently of caller mutation before admission.
      const owned = JSON.parse(JSON.stringify(compact)) as CompactSnapshot;
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
      if (compatible) {
        const { grid, encoding: _, ...metadata } = full;
        void _;
        const changedRows: CompactDeltaFrame["changedRows"] = [];
        for (const [index, row] of grid.entries())
          if (!equalRow(row, baseline!.grid[index]!)) changedRows.push([index, row]);
        const delta: CompactDeltaFrame = {
          ...metadata,
          encoding: COMPACT_DELTA_ENCODING,
          baseSeq: baseline!.seq,
          changedRows,
        };
        const deltaJson = JSON.stringify(delta);
        if (Buffer.byteLength(deltaJson, "utf8") < Buffer.byteLength(json, "utf8")) {
          json = deltaJson;
        }
      }
      const preparedAt = generation;
      let committed = false;
      return {
        wire: JSON.parse(json) as CompactFrame,
        json,
        commit() {
          if (committed || generation !== preparedAt)
            throw new Error("Stale compact producer candidate");
          // Do not retain the public candidate object: a consumer may mutate it.
          baseline = JSON.parse(JSON.stringify(full)) as CompactFullFrame;
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
  let baseline: Baseline | null = null;
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
      let full: CompactFullFrame;
      if (outline.encoding === "rle-v1") {
        const { epoch: _, seq: __, ...compact } = outline;
        void _;
        void __;
        // Full frames can establish a new epoch; same-epoch stale frames cannot rewind.
        const snapshot = decodeCompactSnapshot(compact);
        if (baseline?.wire.epoch === epoch && seq <= baseline.wire.seq)
          throw new CompactBaselineError("Stale compact full frame");
        full = { ...encodeCompactSnapshot(snapshot), epoch, seq };
      } else {
        const delta = deltaEnvelope.parse(value);
        if (delta.seq !== delta.baseSeq + 1) throw new Error("Invalid compact delta sequence");
        if (
          !baseline ||
          baseline.wire.epoch !== delta.epoch ||
          baseline.wire.seq !== delta.baseSeq ||
          baseline.wire.cols !== delta.cols ||
          baseline.wire.rows !== delta.rows
        )
          throw new CompactBaselineError("Missing compact delta baseline");
        if (delta.changedRows.length > delta.rows) throw new Error("Too many compact changed rows");
        const grid = [...baseline.wire.grid];
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
        const snapshot = decodeCompactSnapshot({ ...metadata, encoding: "rle-v1", grid });
        full = { ...encodeCompactSnapshot(snapshot), epoch, seq };
      }
      const { epoch: _, seq: __, ...compact } = full;
      void _;
      void __;
      const snapshot = decodeCompactSnapshot(compact);
      if (
        baseline &&
        outline.encoding === COMPACT_DELTA_ENCODING &&
        baseline.snapshot.modes.alternateScreen !== snapshot.modes.alternateScreen
      )
        throw new Error("Compact delta changed screen basis");
      const preparedAt = generation;
      let committed = false;
      return {
        snapshot,
        commit() {
          if (committed || generation !== preparedAt)
            throw new Error("Stale compact store candidate");
          baseline = { wire: full, snapshot: decodeCompactSnapshot(compact) };
          generation++;
          committed = true;
        },
      };
    },
  };
}
