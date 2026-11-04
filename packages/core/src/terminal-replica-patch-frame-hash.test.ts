import { describe, expect, it } from "vitest";
import type {
  CanonicalTerminalReplicaPatch,
  CanonicalTerminalReplicaSeed,
  TerminalReplicaRow,
} from "@tmux-ide/contracts";
import {
  TERMINAL_REPLICA_SPACE_CELL,
  applyTerminalReplicaPatch,
  applyTerminalReplicaUpdate,
  blankTerminalReplicaSnapshot,
  hashTerminalReplicaSnapshot,
  type TerminalReplicaApplyProfile,
  type TerminalReplicaState,
} from "./terminal-replica.ts";
import {
  createOwnedTerminalReplicaRowBuilder,
  freezeOwnedTerminalReplicaRow,
} from "./terminal-replica-owned-row.ts";

// #708: under an output flood every patch appends many history rows, and the
// reducer hashed each patch frame canonically, cell by cell, although the
// interpreter had already hashed those exact rows.
function textRow(cols: number, text: string): TerminalReplicaRow {
  const builder = createOwnedTerminalReplicaRowBuilder();
  const cells = Array.from({ length: cols }, (_, i) =>
    builder.append({ ...TERMINAL_REPLICA_SPACE_CELL, grapheme: text[i % text.length]! }),
  );
  return freezeOwnedTerminalReplicaRow(builder.finish({ cells, wrapped: false }, false));
}

const COLS = 200;
const ROWS = 50;
function seeded(): TerminalReplicaState {
  const snapshot = blankTerminalReplicaSnapshot(COLS, ROWS);
  const seed: CanonicalTerminalReplicaSeed = {
    type: "terminal.seed",
    workspaceName: "workspace",
    semanticPaneId: "pane",
    generation: "00000000-0000-4000-8000-000000000001",
    incarnation: "00000000-0000-4000-8000-000000000001:0",
    revision: 0,
    cols: COLS,
    rows: ROWS,
    snapshot,
    stateHash: hashTerminalReplicaSnapshot(snapshot),
    hashAlgorithm: "fnv1a64-v1",
  };
  return applyTerminalReplicaUpdate(null, seed).state!;
}

function flood(
  state: TerminalReplicaState,
  lines: number,
  label = "line",
): CanonicalTerminalReplicaPatch {
  const append = Array.from({ length: lines }, (_, i) => textRow(COLS, `${label} ${i} `));
  Object.freeze(append);
  const current = state.snapshot!;
  const payload = {
    rows: [{ index: 0, row: textRow(COLS, `${label} prompt `) }],
    historyDelta: { trim: 0, append },
    cursor: current.cursor,
    modes: current.modes,
    placements: [],
    bootstrap: current.bootstrap,
  };
  // The interpreter commits (and so hashes) these rows before the hub applies them.
  const next = applyTerminalReplicaPatch(current, payload);
  return {
    type: "terminal.patch",
    workspaceName: "workspace",
    semanticPaneId: "pane",
    generation: "00000000-0000-4000-8000-000000000001",
    incarnation: "00000000-0000-4000-8000-000000000001:0",
    baseRevision: state.revision,
    revision: state.revision + 1,
    cols: COLS,
    rows: ROWS,
    stateHash: hashTerminalReplicaSnapshot(next),
    hashAlgorithm: "fnv1a64-v1",
    patch: payload,
  };
}

describe("terminal patch frame identity (#708)", () => {
  it("does not walk every cell of an already hashed flood patch again", () => {
    const state = seeded();
    const update = flood(state, 2_000);
    const seen: TerminalReplicaApplyProfile[] = [];
    const result = applyTerminalReplicaUpdate(state, update, {
      instrumentation: {
        nowMicros: () => performance.now() * 1000,
        onComplete: (profile) => seen.push(profile),
      },
    });
    expect(result.status).toBe("applied");
    // 2,000 rows x 200 cells canonically cost hundreds of milliseconds.
    expect(seen[0]!.phaseMicros.updateHash).toBeLessThan(20_000);
  });

  it("keeps a redelivered patch idempotent", () => {
    const state = seeded();
    const update = flood(state, 300);
    const applied = applyTerminalReplicaUpdate(state, update);
    expect(applied.status).toBe("applied");
    expect(applyTerminalReplicaUpdate(applied.state, update).status).toBe("idempotent");
  });

  // Same claimed stateHash and revision: only the frame identity separates them.
  const changes: [string, (u: CanonicalTerminalReplicaPatch) => CanonicalTerminalReplicaPatch][] = [
    [
      "an appended history row",
      (u: CanonicalTerminalReplicaPatch) => {
        const append = [...u.patch.historyDelta!.append];
        append[150] = textRow(COLS, "other ");
        Object.freeze(append);
        return { ...u, patch: { ...u.patch, historyDelta: { trim: 0, append } } };
      },
    ],
    [
      "the history trim",
      (u: CanonicalTerminalReplicaPatch) => ({
        ...u,
        patch: { ...u.patch, historyDelta: { ...u.patch.historyDelta!, trim: 1 } },
      }),
    ],
    [
      "a changed screen row",
      (u: CanonicalTerminalReplicaPatch) => ({
        ...u,
        patch: { ...u.patch, rows: [{ index: 0, row: textRow(COLS, "other prompt ") }] },
      }),
    ],
    [
      "the changed row's index",
      (u: CanonicalTerminalReplicaPatch) => ({
        ...u,
        patch: { ...u.patch, rows: [{ ...u.patch.rows[0]!, index: 1 }] },
      }),
    ],
    ["the envelope cols", (u: CanonicalTerminalReplicaPatch) => ({ ...u, cols: COLS + 1 })],
    [
      "the cursor",
      (u: CanonicalTerminalReplicaPatch) => ({
        ...u,
        patch: { ...u.patch, cursor: { ...u.patch.cursor!, x: 3 } },
      }),
    ],
  ];
  it.each(changes)("keeps a same-revision patch with another %s a conflict", (_, change) => {
    const state = seeded();
    const update = flood(state, 300);
    const applied = applyTerminalReplicaUpdate(state, update);
    expect(applyTerminalReplicaUpdate(applied.state, change(update)).status).toBe("conflict");
  });

  // Review item 2: a patch that replaces the full history is identified by it.
  it("keeps a same-revision patch with another full history a conflict", () => {
    const state = seeded();
    const current = state.snapshot!;
    const history = Array.from({ length: 300 }, (_, i) => textRow(COLS, `full ${i} `));
    Object.freeze(history);
    const payload = {
      rows: [],
      history,
      cursor: current.cursor,
      modes: current.modes,
      placements: [],
      bootstrap: current.bootstrap,
    };
    const next = applyTerminalReplicaPatch(current, payload);
    const update: CanonicalTerminalReplicaPatch = {
      type: "terminal.patch",
      workspaceName: "workspace",
      semanticPaneId: "pane",
      generation: "00000000-0000-4000-8000-000000000001",
      incarnation: "00000000-0000-4000-8000-000000000001:0",
      baseRevision: state.revision,
      revision: state.revision + 1,
      cols: COLS,
      rows: ROWS,
      stateHash: hashTerminalReplicaSnapshot(next),
      hashAlgorithm: "fnv1a64-v1",
      patch: payload,
    };
    const applied = applyTerminalReplicaUpdate(state, update);
    expect(applied.status).toBe("applied");
    expect(applyTerminalReplicaUpdate(applied.state, update).status).toBe("idempotent");
    const other = [...history];
    other[120] = textRow(COLS, "replaced ");
    Object.freeze(other);
    const changed = { ...update, patch: { ...payload, history: other } };
    expect(applyTerminalReplicaUpdate(applied.state, changed).status).toBe("conflict");
  });
});
