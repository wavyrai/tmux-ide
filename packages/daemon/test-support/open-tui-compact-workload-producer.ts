import {
  applyTerminalReplicaPatch,
  blankTerminalReplicaSnapshot,
  encodeCompactSemanticTerminalUpdate,
  hashTerminalReplicaSnapshot,
} from "@tmux-ide/core";
import type { TerminalReplicaSnapshot } from "@tmux-ide/contracts";

const blank = blankTerminalReplicaSnapshot(132, 41);
const workloadRows = Object.freeze(
  Array.from({ length: 4_096 }, (_, ordinal) => {
    // The live ANSI history rows are short, unique LOAD lines. Keep this
    // sustained endpoint profile in the observed ~750KiB representation class;
    // the separate max-frame/placement fixtures own near-cap slice coverage.
    const prefix = `LOAD_${String(ordinal).padStart(4, "0")}`;
    return Object.freeze({
      wrapped: false,
      cells: Object.freeze([
        ...[...prefix].map((grapheme) => Object.freeze({ ...blank.grid[0]!.cells[0]!, grapheme })),
        ...Array.from({ length: 132 - prefix.length }, () => blank.grid[0]!.cells[0]!),
      ]),
    });
  }),
) as unknown as TerminalReplicaSnapshot["history"];
const seedSnapshot = Object.freeze({
  ...blank,
  history: Object.freeze([...workloadRows, ...workloadRows.slice(0, 904)]),
}) as TerminalReplicaSnapshot;
const patch = Object.freeze({
  dimensions: Object.freeze({ cols: 132, rows: 41 }),
  rows: Object.freeze([]),
  historyDelta: Object.freeze({ trim: 4_096, append: workloadRows }),
});
const firstTarget = applyTerminalReplicaPatch(seedSnapshot, patch);
const stableTarget = applyTerminalReplicaPatch(firstTarget, patch);
const seedBytes = encodeCompactSemanticTerminalUpdate({
  frame: "seed",
  revision: 3,
  snapshot: seedSnapshot,
});
const patchBytes = encodeCompactSemanticTerminalUpdate({
  frame: "patch",
  baseRevision: 3,
  revision: 4,
  patch,
});

process.stdout.write(
  `${JSON.stringify({
    seed: Buffer.from(seedBytes).toString("base64"),
    patch: Buffer.from(patchBytes).toString("base64"),
    seedHash: hashTerminalReplicaSnapshot(seedSnapshot),
    firstHash: hashTerminalReplicaSnapshot(firstTarget),
    targetHash: hashTerminalReplicaSnapshot(stableTarget),
  })}\n`,
);
