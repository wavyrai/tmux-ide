import { expect, it } from "vitest";
import type { TerminalReplicaSnapshot, TerminalReplicaRow } from "@tmux-ide/contracts";
import type { MirrorPaneFrameContext } from "../../desktop-renderer/src/terminal/workspace-pane-compositor";
import {
  captureTerminalHistoryAnchor,
  advanceTerminalHistoryAnchor,
  terminalHistoryViewport,
} from "./terminal-history-anchor";
const row = (grapheme: string): TerminalReplicaRow => ({
  wrapped: false,
  cells: [
    {
      grapheme,
      width: 1,
      foreground: { kind: "default" },
      background: { kind: "default" },
      attributes: 0,
    },
  ],
});
type MutableFrame = { -readonly [K in keyof MirrorPaneFrameContext]: MirrorPaneFrameContext[K] };
function frame(history: string[], revision = 1): MutableFrame {
  return {
    canonical: {
      generation: "g",
      incarnation: "pane-1",
      revision,
      cols: 1,
      rows: 1,
      alternateScreen: false,
    } as MirrorPaneFrameContext["canonical"],
    canonicalSnapshot: {
      cols: 1,
      rows: 1,
      history: history.map(row),
      grid: [row("live")],
      modes: { alternateScreen: false },
    } as TerminalReplicaSnapshot,
  };
}
it("maps capped xterm history to canonical coordinates and never anchors live", () => {
  const f = frame(["0", "1", "2", "3", "4"]);
  expect(captureTerminalHistoryAnchor(f, 1, 3)).toEqual({ row: 3 });
  expect(captureTerminalHistoryAnchor(f, 3, 3)).toBeNull();
  expect(terminalHistoryViewport({ row: 3 }, f, 3)).toBe(1);
  expect(terminalHistoryViewport({ row: 1 }, f, 3)).toBeNull();
});
it("preserves unchanged prefix through reseed and does not search repeated logs", () => {
  const before = frame(["a", "repeat", "repeat"]);
  expect(
    advanceTerminalHistoryAnchor({ row: 1 }, before, frame(["a", "repeat", "repeat", "new"], 2)),
  ).toEqual({ row: 1 });
  expect(
    advanceTerminalHistoryAnchor({ row: 1 }, before, frame(["repeat", "repeat", "new"], 2)),
  ).toBeNull();
});
it("maps an exact retained suffix, but drops evicted anchors and changed grids", () => {
  const before = frame(["a", "b", "c"]),
    after = frame(["b", "c"], 2);
  expect(advanceTerminalHistoryAnchor({ row: 1 }, before, after)).toEqual({ row: 0 });
  expect(advanceTerminalHistoryAnchor({ row: 0 }, before, after)).toBeNull();
  after.canonicalSnapshot!.grid = [row("changed")];
  expect(advanceTerminalHistoryAnchor({ row: 1 }, before, after)).toBeNull();
});
it("uses contiguous explicit trim even when appended history has duplicate rows", () => {
  const before = frame(["a", "b", "c"]),
    after = frame(["b", "c", "b"], 2);
  after.canonicalUpdate = {
    type: "terminal.patch",
    workspaceName: "test",
    semanticPaneId: "%0",
    generation: "g",
    incarnation: "pane-1",
    cols: 1,
    rows: 1,
    stateHash: "0000000000000000",
    hashAlgorithm: "fnv1a64-v1",
    baseRevision: 1,
    revision: 2,
    patch: { rows: [], historyDelta: { trim: 1, append: [row("b")] } },
  } as MirrorPaneFrameContext["canonicalUpdate"];
  expect(advanceTerminalHistoryAnchor({ row: 1 }, before, after)).toEqual({ row: 0 });
  after.canonicalUpdate = {
    ...after.canonicalUpdate,
    baseRevision: 0,
  } as MirrorPaneFrameContext["canonicalUpdate"];
  expect(advanceTerminalHistoryAnchor({ row: 1 }, before, after)).toBeNull();
});
it.each(["incarnation", "generation", "revision", "geometry", "alternate", "wrapped", "style"])(
  "rejects invalid continuity: %s",
  (kind) => {
    const before = frame(["a", "b"]),
      after = frame(["a", "b"], 2);
    if (kind === "incarnation") after.canonical = { ...after.canonical!, incarnation: "pane-2" };
    if (kind === "generation") after.canonical = { ...after.canonical!, generation: "new" };
    if (kind === "revision") after.canonical = { ...after.canonical!, revision: 0 };
    if (kind === "geometry") after.canonicalSnapshot!.cols = 2;
    if (kind === "alternate") after.canonicalSnapshot!.modes.alternateScreen = true;
    if (kind === "wrapped") after.canonicalSnapshot!.history[0]!.wrapped = true;
    if (kind === "style") after.canonicalSnapshot!.history[0]!.cells[0]!.attributes = 1;
    expect(advanceTerminalHistoryAnchor({ row: 1 }, before, after)).toBeNull();
  },
);
