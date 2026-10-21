import { test } from "node:test";
import assert from "node:assert/strict";
import { blankTerminalReplicaSnapshot } from "../../../packages/core/src/terminal-replica.ts";
import { freezeOwnedTerminalReplicaRow } from "../../../packages/core/src/terminal-replica-owned-row.ts";
import {
  TerminalReplicaRowSchemaZ,
  type TerminalReplicaRow,
} from "../../../packages/contracts/src/terminal-replica.ts";
import {
  createHostedPublicationBounds,
  createHostedSurfaceValidator,
} from "./hosted-publication.ts";
import { MAX_COMPACT_GRAPHEME_BYTES, MAX_COMPACT_CELLS } from "./compact-snapshot.ts";

const base = blankTerminalReplicaSnapshot(2, 1);
function row(grapheme: string, cols = 2) {
  return freezeOwnedTerminalReplicaRow({
    wrapped: false,
    cells: Array.from({ length: cols }, () => ({ ...base.grid[0].cells[0], grapheme })),
  });
}
function validators() {
  const surface = createHostedSurfaceValidator(),
    bounds = createHostedPublicationBounds();
  return [
    (snapshot: typeof base) => surface([{ paneId: "pane", snapshot }]),
    (snapshot: typeof base) =>
      bounds({ connection: "c", sequence: 1, snapshot, surfaces: [{ paneId: "pane", snapshot }] }),
  ];
}
test("cursor-only snapshots reuse owned row schema validation and text measurements", () => {
  const witness = "owned-row-validation-witness";
  const owned = row(witness),
    snapshot = { ...base, grid: [owned], history: [owned] };
  const parse = TerminalReplicaRowSchemaZ.parse,
    byteLength = Buffer.byteLength;
  let parses = 0,
    textReads = 0;
  TerminalReplicaRowSchemaZ.parse = function (...args: Parameters<typeof parse>) {
    parses++;
    return parse.apply(this, args);
  };
  Buffer.byteLength = function (...args: Parameters<typeof byteLength>) {
    if (args[0] === witness) textReads++;
    return byteLength(...args);
  };
  try {
    for (const validate of validators()) {
      validate(snapshot);
      assert.ok(textReads > 0);
      parses = 0;
      textReads = 0;
      validate({ ...snapshot, cursor: { ...snapshot.cursor, x: 1 } });
      assert.equal(parses, 0, "unchanged immutable rows are not parsed/cloned again");
      assert.equal(textReads, 0, "cursor updates do not reread immutable graphemes");
    }
  } finally {
    TerminalReplicaRowSchemaZ.parse = parse;
    Buffer.byteLength = byteLength;
  }
});
test("new owned rows still undergo full schema validation, and metadata is validated every time", () => {
  for (const validate of validators()) {
    validate(base);
    const bad = freezeOwnedTerminalReplicaRow({
      wrapped: false,
      cells: base.grid[0].cells.map((cell) => ({ ...cell, attributes: 256 })),
    });
    assert.throws(() => validate({ ...base, grid: [bad] }));
    assert.throws(() => validate({ ...base, cursor: { ...base.cursor, x: -1 } }));
    assert.throws(() => validate({ ...base, unexpected: true } as typeof base));
  }
});
test("mutable foreign rows and reused snapshot objects never earn cache trust", () => {
  for (const validate of validators()) {
    const mutable = {
      wrapped: false,
      cells: base.grid[0].cells.map((cell) => ({ ...cell, foreground: { ...cell.foreground } })),
    };
    // A frozen foreign shell still has mutable cells; it must never earn provenance.
    Object.freeze(mutable);
    Object.freeze(mutable.cells);
    const snapshot = { ...base, grid: [mutable] };
    validate(snapshot);
    mutable.cells[0].attributes = 256;
    assert.throws(() => validate(snapshot));
  }
});
test("cached rows still count for every repeated history occurrence and current column width", () => {
  const heavy = row("x".repeat(Math.floor(MAX_COMPACT_GRAPHEME_BYTES / 2)), 1);
  const snapshot = { ...base, cols: 1, grid: [heavy], history: [] as TerminalReplicaRow[] };
  for (const validate of validators()) {
    validate(snapshot);
    assert.throws(() => validate({ ...snapshot, history: [heavy, heavy] }), /text exceeds bounds/);
    assert.throws(() => validate({ ...snapshot, cols: 2 }), /row width/);
    const empty = row("", 1);
    validate({ ...snapshot, grid: [empty] });
    assert.throws(
      () => validate({ ...snapshot, grid: [empty], history: Array(MAX_COMPACT_CELLS).fill(empty) }),
      /dimensions/,
    );
  }
});
