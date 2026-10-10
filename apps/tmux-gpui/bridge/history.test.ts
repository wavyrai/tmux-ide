import { test } from "node:test";
import assert from "node:assert/strict";
import { blankTerminalReplicaSnapshot } from "../../../packages/core/src/terminal-replica.ts";
import { createHistoryViewport } from "./history.ts";
const row = (text: string) => ({
  ...blankTerminalReplicaSnapshot(2, 2).grid[0]!,
  cells: blankTerminalReplicaSnapshot(2, 2).grid[0]!.cells.map((c) => ({ ...c, grapheme: text })),
});
test("history viewport stays anchored across append and returns to live cursor", () => {
  const h = createHistoryViewport();
  const a = row("A"),
    b = row("B"),
    c = row("C");
  const snapshot = { ...blankTerminalReplicaSnapshot(2, 2), history: [a, b] };
  h.update(snapshot);
  assert.equal(h.scroll(1)!.grid[0], b);
  assert.equal(h.offset, 1);
  const next = h.update({ ...snapshot, history: [a, b, c] })!;
  assert.equal(next.grid[0], b);
  assert.equal(h.offset, 2);
  assert.equal(next.cursor.hidden, true);
  assert.equal(h.scroll(0)!.cursor.hidden, snapshot.cursor.hidden);
  assert.equal(h.offset, 0);
});
test("trim preserves a surviving anchor; lost/reset/alternate-screen anchors return live", () => {
  const h = createHistoryViewport();
  const a = row("A"),
    b = row("B"),
    c = row("C");
  const snapshot = { ...blankTerminalReplicaSnapshot(2, 2), history: [a, b, c] };
  h.update(snapshot);
  h.scroll(2);
  assert.equal(h.update({ ...snapshot, history: [b, c] })!.grid[0], b);
  h.update({ ...snapshot, history: [row("B"), c] });
  assert.equal(h.offset, 0);
  h.scroll(1);
  h.update({ ...snapshot, modes: { ...snapshot.modes, alternateScreen: true } });
  assert.equal(h.offset, 0);
  h.scroll(3);
  assert.equal(h.offset, 0);
  h.update(null);
  assert.equal(h.scroll(1), null);
});
test("retained history is bounded and never exceeds a thousand rows", () => {
  const h = createHistoryViewport();
  h.update({
    ...blankTerminalReplicaSnapshot(2, 2),
    history: Array.from({ length: 1100 }, () => row("X")),
  });
  h.scroll(2000);
  assert.equal(h.offset, 1000);
});
test("repeated row references cannot falsely prove an anchor occurrence", () => {
  const h = createHistoryViewport();
  const a = row("A"),
    b = row("B");
  const snapshot = { ...blankTerminalReplicaSnapshot(2, 2), history: [a, a, b] };
  h.update(snapshot);
  h.scroll(2);
  h.update(snapshot);
  assert.equal(h.offset, 0);
});
test("serialized history budget and width changes cannot retain stale views", () => {
  const h = createHistoryViewport();
  const snapshot = {
    ...blankTerminalReplicaSnapshot(2, 2),
    history: [row("X".repeat(2 * 1024 * 1024))],
  };
  h.update(snapshot);
  h.scroll(1);
  assert.equal(h.offset, 0);
  h.update({ ...snapshot, history: [row("A")] });
  h.scroll(1);
  assert.equal(h.offset, 1);
  h.update(blankTerminalReplicaSnapshot(3, 2));
  assert.equal(h.offset, 0);
});
