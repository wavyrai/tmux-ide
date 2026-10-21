import assert from "node:assert/strict";
import { test } from "node:test";
import { blankTerminalReplicaSnapshot } from "../../../packages/core/src/terminal-replica.ts";
import {
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

for (const [name, mutate] of [
  [
    "zero run",
    (s: any) => {
      s.grid[0][1][0][0] = 0;
    },
  ],
  [
    "fractional run",
    (s: any) => {
      s.grid[0][1][0][0] = 1.5;
    },
  ],
  [
    "expansion bomb",
    (s: any) => {
      s.grid[0][1][0][0] = MAX_COMPACT_CELLS;
    },
  ],
  [
    "short row",
    (s: any) => {
      s.grid[0][1][0][0] = 1;
    },
  ],
  [
    "wrong rows",
    (s: any) => {
      s.rows = 2;
    },
  ],
  [
    "oversized geometry",
    (s: any) => {
      s.cols = 65536;
    },
  ],
  [
    "history cell budget",
    (s: any) => {
      s.history = Array(70000).fill(s.grid[0]);
    },
  ],
  [
    "unknown encoding",
    (s: any) => {
      s.encoding = "other";
    },
  ],
  [
    "unknown metadata",
    (s: any) => {
      s.authority = true;
    },
  ],
  [
    "invalid indexed color",
    (s: any) => {
      s.grid[0][1][0][3] = 0x01000100;
    },
  ],
  [
    "invalid RGB color",
    (s: any) => {
      s.grid[0][1][0][4] = 0x03000000;
    },
  ],
  [
    "out of bounds cursor",
    (s: any) => {
      s.cursor.x = 4;
      s.cursor.hidden = false;
    },
  ],
  [
    "orphan continuation",
    (s: any) => {
      s.grid[0][1][0][2] = 0;
    },
  ],
  [
    "unpaired wide cell",
    (s: any) => {
      s.grid[0][1][0][2] = 2;
    },
  ],
  [
    "control character",
    (s: any) => {
      s.grid[0][1][0][1] = "\x1b";
    },
  ],
  [
    "lone surrogate",
    (s: any) => {
      s.grid[0][1][0][1] = "\ud800";
    },
  ],
  [
    "grapheme byte bound",
    (s: any) => {
      s.grid[0][1][0][1] = "😀".repeat(65);
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
