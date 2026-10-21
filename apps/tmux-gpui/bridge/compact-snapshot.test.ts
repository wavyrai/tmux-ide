import assert from "node:assert/strict";
import { test } from "node:test";
import { blankTerminalReplicaSnapshot } from "../../../packages/core/src/terminal-replica.ts";
import {
  type CompactSnapshot,
  createCompactSnapshotEncoder,
  decodeCompactSnapshot,
  encodeCompactSnapshot,
  MAX_COMPACT_CELLS,
} from "./compact-snapshot.ts";

test("compact snapshot preserves metadata, wrapped rows, history, Unicode and every cell attribute", () => {
  const source = structuredClone(blankTerminalReplicaSnapshot(8, 2));
  const row = source.grid[0]!;
  row.wrapped = true;
  Object.assign(row.cells[0]!, {
    grapheme: "界",
    width: 2,
    attributes: 255,
    foreground: { kind: "rgb", value: 0xffffff },
    background: { kind: "indexed", index: 255 },
  });
  Object.assign(row.cells[1]!, { grapheme: "", width: 0 });
  row.cells[2]!.grapheme = "e\u0301";
  row.cells[3]!.grapheme = "👩‍💻";
  row.cells[4]!.grapheme = '"\\';
  source.history = [structuredClone(row)];
  source.cursor = { x: 3, y: 1, hidden: false, style: "bar", blink: false };
  source.modes = {
    ...source.modes,
    alternateScreen: true,
    bracketedPaste: true,
    mouseTracking: true,
    mouseProtocol: "drag",
    mouseEncoding: "sgr-pixels",
  };
  source.bootstrap = { kind: "authoritative-stream", hiddenState: "observed-from-start" };
  source.placements = [
    { id: "image", kind: "kitty", row: 0, column: 0, rows: 1, columns: 2, contentDigest: "digest" },
  ];
  assert.deepEqual(
    decodeCompactSnapshot(JSON.parse(JSON.stringify(encodeCompactSnapshot(source)))),
    source,
  );
});

test("sparse large frames compress repeated cells without changing the canonical snapshot", () => {
  const source = blankTerminalReplicaSnapshot(250, 70);
  const before = JSON.stringify(source);
  const encoded = JSON.stringify(encodeCompactSnapshot(source));
  assert.ok(Buffer.byteLength(encoded) < Buffer.byteLength(before) / 20);
  assert.deepEqual(decodeCompactSnapshot(JSON.parse(encoded)), source);
  assert.equal(JSON.stringify(source), before);
});

type MalformedCompactSnapshot = Omit<CompactSnapshot, "encoding"> & {
  encoding: string;
  authority?: boolean;
};

for (const [name, mutate] of [
  [
    "zero run",
    (s: MalformedCompactSnapshot) => {
      s.grid[0]![1][0]![0] = 0;
    },
  ],
  [
    "fractional run",
    (s: MalformedCompactSnapshot) => {
      s.grid[0]![1][0]![0] = 1.5;
    },
  ],
  [
    "expansion bomb",
    (s: MalformedCompactSnapshot) => {
      s.grid[0]![1][0]![0] = MAX_COMPACT_CELLS;
    },
  ],
  [
    "short row",
    (s: MalformedCompactSnapshot) => {
      s.grid[0]![1][0]![0] = 1;
    },
  ],
  [
    "wrong rows",
    (s: MalformedCompactSnapshot) => {
      s.rows = 2;
    },
  ],
  [
    "oversized geometry",
    (s: MalformedCompactSnapshot) => {
      s.cols = 65536;
    },
  ],
  [
    "history cell budget",
    (s: MalformedCompactSnapshot) => {
      s.history = Array(70000).fill(s.grid[0]);
    },
  ],
  [
    "unknown encoding",
    (s: MalformedCompactSnapshot) => {
      s.encoding = "other";
    },
  ],
  [
    "unknown metadata",
    (s: MalformedCompactSnapshot) => {
      s.authority = true;
    },
  ],
  [
    "invalid indexed color",
    (s: MalformedCompactSnapshot) => {
      s.grid[0]![1][0]![3] = 0x01000100;
    },
  ],
  [
    "invalid RGB color",
    (s: MalformedCompactSnapshot) => {
      s.grid[0]![1][0]![4] = 0x03000000;
    },
  ],
  [
    "out of bounds cursor",
    (s: MalformedCompactSnapshot) => {
      s.cursor.x = 4;
      s.cursor.hidden = false;
    },
  ],
  [
    "orphan continuation",
    (s: MalformedCompactSnapshot) => {
      s.grid[0]![1][0]![2] = 0;
    },
  ],
  [
    "unpaired wide cell",
    (s: MalformedCompactSnapshot) => {
      s.grid[0]![1][0]![2] = 2;
    },
  ],
  [
    "control character",
    (s: MalformedCompactSnapshot) => {
      s.grid[0]![1][0]![1] = "\x1b";
    },
  ],
  [
    "lone surrogate",
    (s: MalformedCompactSnapshot) => {
      s.grid[0]![1][0]![1] = "\ud800";
    },
  ],
  [
    "grapheme byte bound",
    (s: MalformedCompactSnapshot) => {
      s.grid[0]![1][0]![1] = "😀".repeat(65);
    },
  ],
] as const) {
  test(`compact decoder rejects ${name} atomically`, () => {
    const source = structuredClone(encodeCompactSnapshot(blankTerminalReplicaSnapshot(4, 1)));
    mutate(source);
    assert.throws(() => decodeCompactSnapshot(source));
    // A failed decode must not poison subsequent frames.
    const valid = blankTerminalReplicaSnapshot(4, 1);
    assert.deepEqual(decodeCompactSnapshot(encodeCompactSnapshot(valid)), valid);
  });
}

test("dense run boundaries preserve all 256 attributes and color distinctions", () => {
  const source = structuredClone(blankTerminalReplicaSnapshot(256, 1));
  for (const [x, cell] of source.grid[0]!.cells.entries()) {
    cell.grapheme = String.fromCharCode(0x100 + x);
    cell.attributes = x;
    cell.foreground = { kind: "indexed", index: x };
    cell.background = { kind: "rgb", value: x * 0x10101 };
  }
  assert.deepEqual(decodeCompactSnapshot(encodeCompactSnapshot(source)), source);
});

test("compact decoder bounds expanded UTF-8 bytes even when runs are tiny on the wire", () => {
  const compact = structuredClone(encodeCompactSnapshot(blankTerminalReplicaSnapshot(65535, 1)));
  compact.grid[0]![1][0]![1] = "x".repeat(129);
  assert.throws(() => decodeCompactSnapshot(compact), /grapheme budget/);
  compact.grid[0]![1][0]![1] = "x".repeat(128);
  assert.equal(decodeCompactSnapshot(compact).grid[0]!.cells.length, 65535);
});

test("compact decoder rejects excess runs before expanding cells", () => {
  const compact = structuredClone(encodeCompactSnapshot(blankTerminalReplicaSnapshot(1, 1)));
  compact.grid[0]![1].push(compact.grid[0]![1][0]!);
  assert.throws(() => decodeCompactSnapshot(compact), /run count/);
});

test("immutable encoder reuses rows without rereading cells and encodes only replacements", () => {
  const source = structuredClone(blankTerminalReplicaSnapshot(4, 2));
  let reads = 0;
  const row = source.grid[0]!;
  const cells = row.cells;
  Object.defineProperty(row, "cells", {
    get() {
      reads++;
      return cells;
    },
  });
  const encoder = createCompactSnapshotEncoder();
  const first = encoder.encode(source);
  const after = reads;
  const second = encoder.encode({ ...source, cursor: { ...source.cursor, x: 2 } });
  assert.equal(reads, after);
  assert.equal(second.grid[0], first.grid[0]);
  assert.equal(second.cursor.x, 2);
  const replacement = structuredClone(source.grid[1]!);
  replacement.cells[0]!.grapheme = "👩‍💻";
  const changed = encoder.encode({ ...source, grid: [row, replacement] });
  assert.equal(reads, after);
  assert.equal(changed.grid[0], first.grid[0]);
  assert.notEqual(changed.grid[1], first.grid[1]);
  assert.equal(changed.grid[1]![1][0]![1], "👩‍💻");
  assert.throws(() => {
    first.grid[0]![1][0]![1] = "poison";
  }, TypeError);
  assert.throws(() => {
    first.grid[0]![1].push([1, "x", 1, 0, 0, 0]);
  }, TypeError);
  first.grid[0] = [true, []];
  assert.equal(encoder.encode(source).grid[0], second.grid[0]);
  encoder.reset();
  assert.notEqual(encoder.encode(source).grid[0], second.grid[0]);
  assert.ok(reads > after);
});

test("immutable encoder recalculates repeated history bytes and cell budgets on cache hits", () => {
  const source = structuredClone(blankTerminalReplicaSnapshot(32768, 1));
  for (const cell of source.grid[0]!.cells) cell.grapheme = "x".repeat(256);
  const encoder = createCompactSnapshotEncoder();
  encoder.encode(source); // Exactly 8 MiB.
  assert.throws(() => encoder.encode({ ...source, history: [source.grid[0]!] }), /grapheme budget/);
  assert.throws(
    () => encoder.encode({ ...source, history: Array(8).fill(source.grid[0]) }),
    /dimensions/,
  );
  assert.equal(encoder.encode(source).history.length, 0);
});

test("immutable encoder resets dimension basis and validates new rows; mutable encoder stays uncached", () => {
  const source = structuredClone(blankTerminalReplicaSnapshot(4, 1));
  const encoder = createCompactSnapshotEncoder();
  const first = encoder.encode(source);
  const taller = encoder.encode({ ...source, rows: 2, grid: [source.grid[0]!, source.grid[0]!] });
  assert.notEqual(taller.grid[0], first.grid[0]);
  assert.throws(() => encoder.encode({ ...source, cols: 3 }), /width mismatch/);
  const bad = structuredClone(source);
  bad.grid[0]!.cells[0]!.grapheme = "\u0000";
  assert.throws(() => encoder.encode(bad), /grapheme/);
  const mutable = encodeCompactSnapshot(source);
  mutable.grid[0]![1][0]![1] = "caller edit";
  source.grid[0]!.cells[0]!.grapheme = "new";
  assert.notDeepEqual(encodeCompactSnapshot(source).grid, mutable.grid);
});

test("compact encoder rejects all control scalars while preserving adjacent Unicode", () => {
  const source = structuredClone(blankTerminalReplicaSnapshot(1, 1));
  for (let code = 0; code <= 0x9f; code++) {
    source.grid[0]!.cells[0]!.grapheme = String.fromCodePoint(code);
    if (code <= 0x1f || code >= 0x7f)
      assert.throws(() => encodeCompactSnapshot(source), /grapheme/);
    else assert.doesNotThrow(() => encodeCompactSnapshot(source));
  }
  for (const grapheme of ["\u00a0", "😀", "\ufeff"]) {
    source.grid[0]!.cells[0]!.grapheme = grapheme;
    assert.deepEqual(decodeCompactSnapshot(encodeCompactSnapshot(source)), source);
  }
});
