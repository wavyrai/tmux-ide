import { test } from "node:test";
import assert from "node:assert/strict";
import { blankTerminalReplicaSnapshot } from "../../../packages/core/src/terminal-replica.ts";
import { createSelectionIdentity, scopeSelectionIdentity } from "./selection-identity.ts";
import type { HistoryFrame } from "./history-restoration.ts";
const row = () => blankTerminalReplicaSnapshot(2, 2).grid[0]!;
function fixture() {
  const history = [row(), row(), row(), row()];
  const frame: HistoryFrame = {
    proof: {
      workspaceName: "w",
      semanticPaneId: "p",
      generation: "g",
      incarnation: "i",
      revision: 1,
      stateHash: "h1",
    },
    snapshot: { ...blankTerminalReplicaSnapshot(2, 2), history },
  };
  const viewport = { ...frame.snapshot, history: [], grid: history.slice(1, 3) };
  const anchor = { state: "historical", token: "opaque-owner-token" };
  return { frame, viewport, anchor, read: createSelectionIdentity() };
}
test("fully historical interval survives append/trim-before and fresh helper resolved-token publication", () => {
  const f = fixture();
  const a = f.read(f.frame, f.viewport, 3, 1, f.anchor);
  assert.match(a!, /^[a-f0-9]{64}$/);
  const appended = {
    ...f.frame,
    proof: { ...f.frame.proof, revision: 2, stateHash: "h2" },
    snapshot: { ...f.frame.snapshot, history: [...f.frame.snapshot.history, row()] },
  };
  assert.equal(f.read(appended, f.viewport, 4, 1, f.anchor), a);
  const trimmed = {
    ...appended,
    proof: { ...appended.proof, revision: 3, stateHash: "h3" },
    snapshot: { ...appended.snapshot, history: appended.snapshot.history.slice(1) },
  };
  assert.equal(f.read(trimmed, f.viewport, 4, 0, f.anchor), a);
  assert.equal(createSelectionIdentity()(trimmed, f.viewport, 4, 0, f.anchor), a);
});
test("trim-through, equal-text replacement and duplicate references reject entire interval", () => {
  for (const mode of ["trim", "replace", "duplicate"]) {
    const f = fixture();
    assert(f.read(f.frame, f.viewport, 3, 1, f.anchor));
    const history =
      mode === "trim" ? f.frame.snapshot.history.slice(2) : [...f.frame.snapshot.history];
    if (mode === "replace") history[2] = row();
    if (mode === "duplicate") history.push(history[1]!);
    const next = { ...f.frame, snapshot: { ...f.frame.snapshot, history } };
    const view = {
      ...f.viewport,
      grid: history.slice(mode === "trim" ? 0 : 1, mode === "trim" ? 2 : 3),
    };
    assert.equal(f.read(next, view, 3, mode === "trim" ? 0 : 1, f.anchor), null);
    assert.equal(f.read(f.frame, f.viewport, 3, 1, f.anchor), null);
  }
});
test("dimensions, alternate, reincarnation and missing source invalidate sticky lineage", () => {
  for (const mode of ["dimensions", "alternate", "incarnation", "missing"]) {
    const f = fixture();
    assert(f.read(f.frame, f.viewport, 3, 1, f.anchor));
    const changed = {
      ...f.frame,
      proof: { ...f.frame.proof, incarnation: mode === "incarnation" ? "replacement" : "i" },
      snapshot: {
        ...f.frame.snapshot,
        rows: mode === "dimensions" ? 3 : 2,
        modes: { ...f.frame.snapshot.modes, alternateScreen: mode === "alternate" },
      },
    };
    f.read(mode === "missing" ? null : changed, f.viewport, 3, 1, f.anchor);
    assert.equal(f.read(f.frame, f.viewport, 3, 1, f.anchor), null);
    assert(f.read(f.frame, f.viewport, 3, 1, { ...f.anchor, token: "fresh-captured-token" }));
  }
});
test("mixed/live view binds exact committed proof and changed cells", () => {
  const f = fixture();
  const a = f.read(f.frame, f.viewport, 1, 3, f.anchor);
  assert(a);
  const next = { ...f.frame, proof: { ...f.frame.proof, revision: 2, stateHash: "h2" } };
  assert.notEqual(f.read(next, f.viewport, 1, 3, f.anchor), a);
  const modified = structuredClone(f.viewport);
  modified.grid[0]!.cells[0]!.grapheme = "x";
  assert.notEqual(f.read(f.frame, modified, 1, 3, f.anchor), a);
  assert.equal(f.read(f.frame, f.viewport, 3, 1, { state: "historical", token: null }), null);
  assert.equal(
    f.read(f.frame, f.viewport, 3, 1, { state: "restoring", token: f.anchor.token }),
    null,
  );
});
test("browser scope binds verified route/window/copy and canvas geometry", () => {
  const f = fixture(),
    proof = f.read(f.frame, f.viewport, 3, 1, f.anchor)!;
  const region = { id: "p", left: 0, top: 1, width: 2, height: 2 },
    canvas = { cols: 2, rows: 3 };
  const base = scopeSelectionIdentity(proof, "route", "window", region, canvas);
  assert(base);
  assert.notEqual(scopeSelectionIdentity(proof, "newroute", "window", region, canvas), base);
  assert.notEqual(scopeSelectionIdentity(proof, "route", "newwindow", region, canvas), base);
  assert.notEqual(
    scopeSelectionIdentity(proof, "route", "window", { ...region, top: 0 }, canvas),
    base,
  );
  assert.notEqual(
    scopeSelectionIdentity(proof, "route", "window", region, { ...canvas, cols: 3 }),
    base,
  );
  assert.equal(scopeSelectionIdentity(proof, null, "window", region, canvas), null);
});

test("selection proof retains exact digest bytes while serializing only replaced rows", async () => {
  const { createHash } = await import("node:crypto");
  const f = fixture();
  const source = structuredClone(f.viewport);
  source.grid[0].cells[0].grapheme = '"\\😀é\n';
  const scope = JSON.stringify(["w", "p", "g", "i", 2, 2, false]);
  const key = JSON.stringify(["canonical-v1", scope, 1, "h1", 1]);
  const expected = createHash("sha256")
    .update(JSON.stringify([key, JSON.stringify(source.grid)]))
    .digest("hex");
  const stringify = JSON.stringify;
  let wholeGrids = 0,
    rows = 0;
  JSON.stringify = ((value: unknown) => {
    if (value === source.grid) wholeGrids++;
    if (value && typeof value === "object" && "cells" in value && "wrapped" in value) rows++;
    return stringify(value);
  }) as typeof JSON.stringify;
  try {
    assert.equal(f.read(f.frame, source, 1, 3, f.anchor), expected);
    assert.equal(rows, 2);
    assert.equal(wholeGrids, 0);
    const updated = { ...f.frame, proof: { ...f.frame.proof, revision: 2, stateHash: "h2" } };
    assert.ok(f.read(updated, source, 1, 3, f.anchor));
    assert.equal(rows, 2, "new proof with unchanged rows does not serialize cells");
    const next = { ...source, grid: [...source.grid] };
    next.grid[1] = structuredClone(next.grid[1]);
    next.grid[1].wrapped = true;
    assert.ok(f.read(updated, next, 1, 3, f.anchor));
    assert.equal(rows, 3, "one replaced row serializes once");
  } finally {
    JSON.stringify = stringify;
  }
});
