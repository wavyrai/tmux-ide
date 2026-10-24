// node --import tsx packages/core/src/terminal-projection-vectors.mjs
import { writeFileSync } from "node:fs";
import { URL } from "node:url";
import {
  blankTerminalReplicaSnapshot,
  freezeTerminalReplicaSnapshot,
  hashTerminalReplicaSnapshot,
} from "./terminal-replica.ts";
import {
  encodeBinarySemanticTerminalUpdate,
  hashTerminalDeliveryRepresentation,
} from "./terminal-delivery.ts";
import {
  projectAlternateSnapshot,
  applyTerminalProjectionPatch,
  hashTerminalProjection,
  hashSourceSnapshotFromProjection,
  hashTerminalProjectionTombstone,
  encodeTerminalProjection,
} from "./terminal-projection.ts";
import { hashTerminalReplicaTombstone } from "./terminal-replica.ts";
const base = blankTerminalReplicaSnapshot(3, 2);
const source = freezeTerminalReplicaSnapshot({
  ...base,
  modes: { ...base.modes, alternateScreen: true },
  history: [base.grid[0], base.grid[1]],
});
const initial = projectAlternateSnapshot(source);
const row = {
  ...initial.grid[1],
  cells: initial.grid[1].cells.map((cell, index) => (index ? cell : { ...cell, grapheme: "é" })),
};
const patch = { rows: [{ index: 1, row }], deferredHistory: initial.deferredHistory };
const next = applyTerminalProjectionPatch(initial, patch);
const entries = [
  { payload: { frame: "seed", revision: 7, projection: initial }, projection: initial },
  { payload: { frame: "patch", baseRevision: 7, revision: 8, patch }, projection: next },
  {
    payload: {
      frame: "tombstone",
      baseRevision: 8,
      revision: 9,
      tombstone: { reason: "pane-closed" },
    },
    projection: null,
  },
];
const vectors = entries.map(({ payload, projection }) => {
  const bytes = encodeTerminalProjection(payload);
  return {
    payload,
    bytes: [...bytes],
    representationHash: hashTerminalDeliveryRepresentation(bytes),
    projectionStateHash: projection
      ? hashTerminalProjection(projection)
      : hashTerminalProjectionTombstone(payload.tombstone.reason),
    canonicalStateHash: projection
      ? hashSourceSnapshotFromProjection(projection)
      : hashTerminalReplicaTombstone(payload.tombstone.reason),
  };
});
const materialized = { ...source, grid: next.grid };
const materializedBytes = encodeBinarySemanticTerminalUpdate({
  frame: "seed",
  revision: 8,
  snapshot: materialized,
});
writeFileSync(
  new URL("fixtures/terminal-projection-vectors.json", import.meta.url),
  JSON.stringify(
    {
      source,
      sourceHash: hashTerminalReplicaSnapshot(source),
      materialized,
      materializedBytes: [...materializedBytes],
      materializedRepresentationHash: hashTerminalDeliveryRepresentation(materializedBytes),
      vectors,
    },
    null,
    2,
  ) + "\n",
);
