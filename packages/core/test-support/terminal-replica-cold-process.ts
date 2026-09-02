import type {
  CanonicalTerminalReplicaPatch,
  CanonicalTerminalReplicaSeed,
} from "@tmux-ide/contracts";
import {
  applyTerminalReplicaUpdate,
  blankTerminalReplicaSnapshot,
  type TerminalReplicaApplyProfile,
} from "../src/terminal-replica.ts";

const generation = "00000000-0000-4000-8000-000000000001";
const incarnation = `${generation}:0`;
const snapshot = blankTerminalReplicaSnapshot(132, 41);
const seed: CanonicalTerminalReplicaSeed = {
  type: "terminal.seed",
  workspaceName: "benchmark",
  semanticPaneId: "pane.benchmark",
  generation,
  incarnation,
  revision: 1,
  cols: 132,
  rows: 41,
  stateHash: "0658f636a5e29bd3",
  hashAlgorithm: "fnv1a64-v1",
  snapshot,
};
const seeded = applyTerminalReplicaUpdate(null, seed, {
  authenticatedFrameHash: "1111111111111111",
});
if (seeded.status !== "applied") throw new Error("cold benchmark seed failed");

const row = {
  wrapped: false,
  cells: snapshot.grid[0]!.cells.map((cell, index) =>
    index === 131 ? { ...cell, grapheme: "x" } : { ...cell },
  ),
};
const patch: CanonicalTerminalReplicaPatch = {
  type: "terminal.patch",
  workspaceName: "benchmark",
  semanticPaneId: "pane.benchmark",
  generation,
  incarnation,
  baseRevision: 1,
  revision: 2,
  cols: 132,
  rows: 41,
  stateHash: "c3d5e5851b2a7a20",
  hashAlgorithm: "fnv1a64-v1",
  patch: { rows: [{ index: 0, row }] },
};
let profile: TerminalReplicaApplyProfile | null = null;
const startedAt = performance.now();
const applied = applyTerminalReplicaUpdate(seeded.state, patch, {
  authenticatedFrameHash: "2222222222222222",
  instrumentation: {
    nowMicros: () => performance.now() * 1_000,
    onComplete: (value) => {
      profile = value;
    },
  },
});
const durationMs = performance.now() - startedAt;
if (applied.status !== "applied" || !profile) throw new Error("cold benchmark patch failed");
console.log(JSON.stringify({ durationMs, profile }));
