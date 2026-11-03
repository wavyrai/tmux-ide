import { describe, expect, it } from "vitest";
import type { CanonicalTerminalReplicaSeed, TerminalReplicaRow } from "@tmux-ide/contracts";
import {
  TERMINAL_REPLICA_SPACE_CELL,
  applyTerminalReplicaUpdate,
  applyTerminalReplicaUpdateCooperatively,
  blankTerminalReplicaSnapshot,
  hashTerminalReplicaSnapshot,
  type TerminalReplicaApplyProfile,
} from "./terminal-replica.ts";
import {
  createOwnedTerminalReplicaRowBuilder,
  freezeOwnedTerminalReplicaRow,
} from "./terminal-replica-owned-row.ts";

// #706: opening a session reseeds every paused pane, one at a time, before
// the first frame. Each seed carries the pane's whole history.
function textRow(cols: number, text: string): TerminalReplicaRow {
  const builder = createOwnedTerminalReplicaRowBuilder();
  const cells = Array.from({ length: cols }, (_, i) =>
    builder.append({ ...TERMINAL_REPLICA_SPACE_CELL, grapheme: text[i % text.length]! }),
  );
  return freezeOwnedTerminalReplicaRow(builder.finish({ cells, wrapped: false }, false));
}

function historySeed(cols: number, rows: number, history: number): CanonicalTerminalReplicaSeed {
  const grid = Array.from({ length: rows }, (_, i) => textRow(cols, `screen ${i} `));
  const lines = Array.from({ length: history }, (_, i) => textRow(cols, `history line ${i} `));
  Object.freeze(grid);
  Object.freeze(lines);
  const snapshot = { ...blankTerminalReplicaSnapshot(cols, rows), grid, history: lines };
  Object.freeze(snapshot);
  return {
    type: "terminal.seed",
    workspaceName: "workspace",
    semanticPaneId: "pane",
    generation: "00000000-0000-4000-8000-000000000001",
    incarnation: "00000000-0000-4000-8000-000000000001:0",
    revision: 0,
    cols,
    rows,
    snapshot,
    // The daemon's interpreter hashes the rows when it commits the seed.
    stateHash: hashTerminalReplicaSnapshot(snapshot),
    hashAlgorithm: "fnv1a64-v1",
  };
}

function profiled() {
  const seen: TerminalReplicaApplyProfile[] = [];
  return {
    seen,
    instrumentation: {
      nowMicros: () => performance.now() * 1000,
      onComplete: (profile: TerminalReplicaApplyProfile) => seen.push(profile),
    },
  };
}

describe("terminal seed frame hash (#706)", () => {
  it("does not walk every cell of an already hashed seed again", async () => {
    // One 8-pane session after a sleep: 2,000 history rows per pane.
    const update = historySeed(200, 50, 2_000);
    const { seen, instrumentation } = profiled();
    const result = await applyTerminalReplicaUpdateCooperatively(null, update, {
      yieldControl: async () => {},
      instrumentation,
    });
    expect(result.status).toBe("applied");
    const frame = seen[0]!.phaseMicros.updateHash;
    const rows = seen[0]!.phaseMicros.snapshotHash;
    // Hashing 410,000 cells canonically costs hundreds of milliseconds; a frame
    // identity built from the rows' cached hashes costs about as much as the
    // already cached snapshot hash.
    expect(frame).toBeLessThan(Math.max(20_000, rows * 4));
  });

  it("gives the same frame identity on the cooperative and the ordinary path", async () => {
    const update = historySeed(200, 50, 600);
    const cooperative = await applyTerminalReplicaUpdateCooperatively(null, update, {
      yieldControl: async () => {},
    });
    const ordinary = applyTerminalReplicaUpdate(null, update);
    expect(cooperative.state!.frameHash).toBe(ordinary.state!.frameHash);
    // A redelivered seed stays idempotent across the two paths.
    expect(applyTerminalReplicaUpdate(cooperative.state, update).status).toBe("idempotent");
  });

  it("still changes the frame identity when one history cell changes", async () => {
    const update = historySeed(200, 50, 600);
    const history = [...update.snapshot.history];
    history[300] = textRow(200, "history line 300 changed ");
    Object.freeze(history);
    const snapshot = { ...update.snapshot, history };
    Object.freeze(snapshot);
    const changed = { ...update, snapshot, stateHash: hashTerminalReplicaSnapshot(snapshot) };
    const a = await applyTerminalReplicaUpdateCooperatively(null, update, {
      yieldControl: async () => {},
    });
    const b = await applyTerminalReplicaUpdateCooperatively(null, changed, {
      yieldControl: async () => {},
    });
    expect(a.state!.frameHash).not.toBe(b.state!.frameHash);
    expect(applyTerminalReplicaUpdate(null, changed).state!.frameHash).toBe(b.state!.frameHash);
  });

  it("still changes the frame identity when one screen cell changes", async () => {
    const update = historySeed(200, 50, 600);
    const grid = [...update.snapshot.grid];
    grid[7] = textRow(200, "screen 7 changed ");
    Object.freeze(grid);
    const snapshot = { ...update.snapshot, grid };
    Object.freeze(snapshot);
    const changed = { ...update, snapshot, stateHash: hashTerminalReplicaSnapshot(snapshot) };
    const a = await applyTerminalReplicaUpdateCooperatively(null, update, {
      yieldControl: async () => {},
    });
    const b = await applyTerminalReplicaUpdateCooperatively(null, changed, {
      yieldControl: async () => {},
    });
    expect(a.state!.frameHash).not.toBe(b.state!.frameHash);
  });

  // A redelivered seed is compared by stateHash and frame identity before its
  // rows are verified, so the identity must still see the rows themselves.
  it.each([
    ["history", 300],
    ["grid", 7],
  ] as const)("keeps a same-revision seed with other %s rows a conflict", async (field, index) => {
    const update = historySeed(200, 50, 600);
    const applied = await applyTerminalReplicaUpdateCooperatively(null, update, {
      yieldControl: async () => {},
    });
    const rows = [...update.snapshot[field]];
    rows[index] = textRow(200, "replaced ");
    Object.freeze(rows);
    const snapshot = { ...update.snapshot, [field]: rows };
    Object.freeze(snapshot);
    // Same claimed stateHash: the recomputed state hash and the frame identity both see the rows.
    const other = { ...update, snapshot };
    expect(applyTerminalReplicaUpdate(applied.state, other).status).toBe("conflict");
  });

  it("keeps a same-revision seed from another incarnation a conflict", async () => {
    const update = historySeed(200, 50, 600);
    const applied = await applyTerminalReplicaUpdateCooperatively(null, update, {
      yieldControl: async () => {},
    });
    const other = { ...update, incarnation: "00000000-0000-4000-8000-000000000001:1" };
    expect(applyTerminalReplicaUpdate(applied.state, other).status).toBe("conflict");
  });

  // The envelope's cols and rows are compared only through the frame identity:
  // the idempotent branch runs before the envelope-versus-snapshot check.
  it.each([
    ["cols", { cols: 201 }],
    ["rows", { rows: 51 }],
  ] as const)(
    "keeps a same-revision seed whose envelope %s changed a conflict",
    async (_, envelope) => {
      const update = historySeed(200, 50, 600);
      const applied = applyTerminalReplicaUpdate(null, update);
      expect(applied.status).toBe("applied");
      const other = { ...update, ...envelope };
      expect(applyTerminalReplicaUpdate(applied.state, other).status).toBe("conflict");
      const cooperative = await applyTerminalReplicaUpdateCooperatively(applied.state, other, {
        yieldControl: async () => {},
      });
      expect(cooperative.status).toBe("conflict");
    },
  );
});
