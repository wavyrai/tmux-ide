// Capability 122 (history on demand) conformance vectors for the Rust client,
// made by the TypeScript reference in packages/core. Run from the repository
// root of a checkout with capability 122:
//   node --import tsx apps/tmux-gpui/upstream/crates/herdr-client/src/tmux_delivery/tests/generate-partial-history-vectors.ts
// It writes partial-history-vectors.json beside this file.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  blankTerminalReplicaSnapshot,
  encodeBinarySemanticTerminalUpdate,
  encodeCompactSemanticTerminalUpdate,
  encodeSemanticTerminalHistory,
  hashTerminalDeliveryRepresentation,
  hashTerminalReplicaSnapshot,
} from "../../../../../../../../packages/core/src/index.ts";
import {
  splitTerminalHistory,
  takeTerminalHistoryChunk,
} from "../../../../../../../../packages/core/src/terminal-partial-history.ts";

type Snap = ReturnType<typeof blankTerminalReplicaSnapshot>;
type Row = Snap["history"][number];
let counter = 0;
function row(cols: number, tag: string): Row {
  const base = blankTerminalReplicaSnapshot(cols, 1).grid[0]!;
  counter += 1;
  return structuredClone({
    ...base,
    wrapped: counter % 7 === 0,
    cells: base.cells.map((cell, index) => ({
      ...cell,
      grapheme: index === 0 ? tag : index === 1 ? String(counter % 10) : " ",
      ...(index === 2 && counter % 3 === 0 ? { foreground: { kind: "indexed", index: counter % 256 } } : {}),
    })),
  });
}
function full(history: number): Snap {
  const snapshot = structuredClone(blankTerminalReplicaSnapshot(6, 3));
  snapshot.grid = snapshot.grid.map(() => row(6, "g"));
  snapshot.history = Array.from({ length: history }, () => row(6, "h"));
  return snapshot;
}
const out: Record<string, unknown[]> = {};
for (const encoding of ["semantic-compact-v1", "semantic-binary-v1"] as const) {
  counter = 0;
  const encode = (payload: Parameters<typeof encodeCompactSemanticTerminalUpdate>[0]) =>
    encoding === "semantic-binary-v1"
      ? encodeBinarySemanticTerminalUpdate(payload)
      : encodeCompactSemanticTerminalUpdate(payload);
  const steps: unknown[] = [];
  const push = (
    frame: string,
    baseRevision: number | null,
    revision: number,
    hash: string,
    unloaded: { rows: number; digest: string },
    bytes: Uint8Array,
  ) =>
    steps.push({
      frame,
      baseRevision,
      revision,
      canonicalStateHash: hash,
      historyUnloaded: unloaded,
      representationHash: hashTerminalDeliveryRepresentation(bytes),
      wire: Buffer.from(bytes).toString("base64"),
    });
  let snap = full(500);
  const split = splitTerminalHistory(snap, 200);
  push(
    "seed",
    null,
    0,
    hashTerminalReplicaSnapshot(snap),
    split.unloaded,
    encode({ frame: "seed", revision: 0, snapshot: split.snapshot }),
  );
  // At the history limit: 20 trimmed (all unloaded), 20 appended.
  const append = Array.from({ length: 20 }, () => row(6, "s"));
  snap = { ...snap, history: [...snap.history.slice(20), ...append] };
  let unloaded = splitTerminalHistory(snap, 220).unloaded;
  push(
    "patch",
    0,
    1,
    hashTerminalReplicaSnapshot(snap),
    unloaded,
    encode({
      frame: "patch",
      baseRevision: 0,
      revision: 1,
      patch: { rows: [], historyDelta: { trim: 0, append } },
    }),
  );
  // One chunk of 120 (280 unloaded → 160), then a trim of 170 that takes the
  // 160 unloaded rows and 10 loaded ones, appending 5: the patch's trim
  // counts loaded rows only, so it says 10.
  let loaded = 220;
  const chunk = takeTerminalHistoryChunk(snap.history, unloaded.rows, 120);
  push(
    "history",
    1,
    1,
    hashTerminalReplicaSnapshot(snap),
    chunk.unloaded,
    encodeSemanticTerminalHistory({ frame: "history", revision: 1, rows: [...chunk.rows] }, encoding),
  );
  unloaded = chunk.unloaded;
  loaded += 120;
  const more = Array.from({ length: 5 }, () => row(6, "t"));
  snap = { ...snap, history: [...snap.history.slice(170), ...more] };
  loaded = loaded - 10 + 5;
  unloaded = splitTerminalHistory(snap, loaded).unloaded;
  push(
    "patch",
    1,
    2,
    hashTerminalReplicaSnapshot(snap),
    unloaded,
    encode({
      frame: "patch",
      baseRevision: 1,
      revision: 2,
      patch: { rows: [], historyDelta: { trim: 10, append: more } },
    }),
  );
  out[encoding] = steps;
}
writeFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "partial-history-vectors.json"),
  `${JSON.stringify(out, null, 1)}\n`,
);
