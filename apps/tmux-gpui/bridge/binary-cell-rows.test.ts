import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { blankTerminalReplicaSnapshot } from "../../../packages/core/src/terminal-replica.ts";
import { encodeCompactSnapshot } from "./compact-snapshot.ts";
import { createCompactDeltaProducer } from "./compact-delta.ts";
import {
  encodeBinaryCellFrame,
  decodeBinaryCellFrame,
  encodeBinaryCellPublication,
  decodeBinaryCellPublication,
} from "./binary-cell-rows.ts";
import type { CompactFrame } from "./compact-delta.ts";
function fixture() {
  return { ...encodeCompactSnapshot(blankTerminalReplicaSnapshot(4, 2)), epoch: "epoch", seq: 1 };
}
const body = (frame: CompactFrame) => encodeBinaryCellFrame(frame);
test("binary cells retain full/delta metadata, wrapped history, Unicode and all style bits", () => {
  const frame = fixture();
  frame.grid[0] = [
    true,
    [
      [1, "界", 2, 0x010000ff, 0x02ffffff, 255],
      [1, "", 0, 0, 0, 0],
      [1, "👩‍💻é", 1, 0, 0, 0],
      [1, "\ufeff", 1, 0, 0, 0],
    ],
  ];
  frame.history = [frame.grid[0]];
  assert.deepEqual(decodeBinaryCellFrame(body(frame)), frame);
  const delta: CompactFrame = {
    encoding: "rle-delta-v1",
    epoch: frame.epoch,
    seq: 2,
    baseSeq: 1,
    cols: 4,
    rows: 2,
    changedRows: [[0, frame.grid[0]]],
    history: frame.history,
    cursor: frame.cursor,
    modes: frame.modes,
    bootstrap: frame.bootstrap,
    placements: frame.placements,
  };
  assert.deepEqual(decodeBinaryCellFrame(body(delta)), delta);
  delta.changedRows = [];
  assert.deepEqual(decodeBinaryCellFrame(body(delta)), delta);
});
test("u16 grapheme lengths preserve 255/256 bytes and reject 257", () => {
  for (const length of [255, 256]) {
    const f = fixture();
    f.grid[0]![1][0]![1] = "a".repeat(length);
    assert.deepEqual(decodeBinaryCellFrame(body(f)), f);
  }
  const f = fixture();
  f.grid[0]![1][0]![1] = "a".repeat(257);
  assert.throws(() => body(f));
});
test("every truncation and trailing bytes reject atomically", () => {
  const bytes = body(fixture());
  for (let n = 0; n < bytes.length; n++)
    assert.throws(() => decodeBinaryCellFrame(bytes.subarray(0, n)));
  assert.throws(() => decodeBinaryCellFrame(Buffer.concat([bytes, Buffer.from([0])])));
  assert.deepEqual(decodeBinaryCellFrame(bytes), fixture());
});
function firstRun(bytes: Buffer) {
  return 4 + bytes.readUInt32BE(0) + 4 + 4 + 1 + 4;
}
for (const [name, mutate] of [
  ["zero repeat", (b: Buffer, o: number) => b.writeUInt32BE(0, o)],
  ["overflow repeat", (b: Buffer, o: number) => b.writeUInt32BE(0xffffffff, o)],
  ["oversize text", (b: Buffer, o: number) => b.writeUInt16BE(257, o + 4)],
  [
    "bad utf8",
    (b: Buffer, o: number) => {
      b[o + 6] = 255;
    },
  ],
  [
    "bad width",
    (b: Buffer, o: number) => {
      b[o + 7] = 3;
    },
  ],
  ["bad color", (b: Buffer, o: number) => b.writeUInt32BE(1, o + 8)],
  [
    "bad wrapped",
    (b: Buffer, o: number) => {
      b[o - 5] = 2;
    },
  ],
  ["run count", (b: Buffer, o: number) => b.writeUInt32BE(0xffffffff, o - 4)],
  ["row index", (b: Buffer, o: number) => b.writeUInt32BE(2, o - 9)],
] as const)
  test(`binary rejects ${name} before admission`, () => {
    const bytes = Buffer.from(body(fixture()));
    mutate(bytes, firstRun(bytes));
    assert.throws(() => decodeBinaryCellFrame(bytes));
  });
test("delta sorted unique rows, exact geometry and expansion budgets apply", () => {
  const producer = createCompactDeltaProducer();
  const a = producer.prepare(blankTerminalReplicaSnapshot(4, 20), "a");
  a.commit();
  const b = producer.prepare(blankTerminalReplicaSnapshot(4, 20), "a");
  const wire = b.wire;
  assert.equal(wire.encoding, "rle-delta-v1");
  if (wire.encoding !== "rle-delta-v1") throw new Error("expected delta");
  wire.changedRows = [
    [2, fixture().grid[0]!],
    [1, fixture().grid[0]!],
  ];
  assert.throws(() => body(wire));
  wire.changedRows = [
    [1, fixture().grid[0]!],
    [1, fixture().grid[0]!],
  ];
  assert.throws(() => body(wire));
  const large = fixture();
  large.cols = 65535;
  large.rows = 65535;
  assert.throws(() => body(large));
  const full = fixture();
  full.history = Array(65535).fill(full.grid[0]);
  assert.throws(() => body(full));
});
test("shared golden bytes decode and encode identically", () => {
  const vectors = JSON.parse(
    readFileSync(new URL("./binary-vectors.json", import.meta.url), "utf8"),
  );
  for (const v of vectors.cells) {
    const bytes = Buffer.from(v.hex, "hex");
    assert.deepEqual(decodeBinaryCellFrame(bytes), v.frame);
    assert.equal(encodeBinaryCellFrame(v.frame).toString("hex"), v.hex);
  }
});

test("outer authority metadata and binary cells are one atomic frame", () => {
  const frame = fixture();
  const publication = { version: 1, connection: "local", request: 3, inputReady: false };
  const bytes = encodeBinaryCellPublication(publication, body(frame));
  assert.deepEqual(decodeBinaryCellPublication(bytes.subarray(12)), { publication, frame });
  assert.throws(() => encodeBinaryCellPublication({ ...publication, snapshot: null }, body(frame)));
  assert.throws(() => decodeBinaryCellPublication(bytes.subarray(12, bytes.length - 1)));
  const malformed = Buffer.from(bytes.subarray(12));
  malformed.writeUInt32BE(0xffffffff);
  assert.throws(() => decodeBinaryCellPublication(malformed));
});

test("run validation agrees with compact JSON for every four-cell width combination", async () => {
  const { decodeCompactSnapshot } = await import("./compact-snapshot.ts");
  for (let code = 0; code < 81; code++) {
    const f = fixture();
    let n = code;
    f.grid[0] = [
      false,
      Array.from({ length: 4 }, () => {
        const width = n % 3;
        n = Math.floor(n / 3);
        return [1, width === 0 ? "" : "x", width as 0 | 1 | 2, 0, 0, 0];
      }),
    ];
    const { epoch, seq, ...compact } = f;
    void epoch;
    void seq;
    let json = true,
      binary = true;
    try {
      decodeCompactSnapshot(compact);
    } catch {
      json = false;
    }
    try {
      body(f);
    } catch {
      binary = false;
    }
    assert.equal(binary, json, `width combination ${code}`);
  }
  for (const text of [
    "",
    "\ufeff",
    "😀",
    "é",
    "a".repeat(256),
    "a".repeat(257),
    "\ud800",
    "\x1b",
    "\x85",
  ]) {
    const f = fixture();
    f.grid[0]![1][0]![1] = text;
    const { epoch, seq, ...compact } = f;
    void epoch;
    void seq;
    let json = true,
      binary = true;
    try {
      decodeCompactSnapshot(compact);
    } catch {
      json = false;
    }
    try {
      body(f);
    } catch {
      binary = false;
    }
    assert.equal(binary, json, JSON.stringify(text));
  }
});

test("maximum cell budget roundtrips without expanded cell allocation or cell JSON", (t) => {
  const f = {
    ...encodeCompactSnapshot(blankTerminalReplicaSnapshot(512, 512)),
    epoch: "max",
    seq: 1,
  };
  const stringify = JSON.stringify;
  let arrays = 0;
  t.mock.method(JSON, "stringify", (value: unknown) => {
    if (Array.isArray(value)) arrays++;
    return stringify(value);
  });
  const bytes = body(f);
  assert.equal(arrays, 0);
  assert.deepEqual(decodeBinaryCellFrame(bytes), f);
  const tooLarge = { ...f, history: [f.grid[0]!] };
  assert.throws(() => body(tooLarge), /budget/);
});

test("expanded grapheme budget applies even to tiny repeated binary runs", () => {
  const f = fixture();
  f.cols = 65535;
  f.rows = 1;
  f.grid = [[false, [[65535, "x".repeat(129), 1, 0, 0, 0]]]];
  assert.throws(() => body(f), /grapheme budget/);
  f.grid[0]![1][0]![1] = "x".repeat(128);
  assert.deepEqual(decodeBinaryCellFrame(body(f)), f);
});
