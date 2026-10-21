import assert from "node:assert/strict";
import { test } from "node:test";
import { blankTerminalReplicaSnapshot } from "../../../packages/core/src/terminal-replica.ts";
import {
  createCompactDeltaProducer,
  createCompactDeltaStore,
  CompactBaselineError,
  type CompactDeltaFrame,
} from "./compact-delta.ts";

function frame() {
  return structuredClone(blankTerminalReplicaSnapshot(80, 24));
}
function admitted(store: ReturnType<typeof createCompactDeltaStore>, value: unknown) {
  const candidate = store.prepare(value);
  candidate.commit();
  return candidate.snapshot;
}

test("row damage preserves Unicode, wrapped rows, history and complete metadata", () => {
  const producer = createCompactDeltaProducer(),
    store = createCompactDeltaStore();
  const a = frame();
  const first = producer.prepare(a, "request/source/layout/history");
  assert.deepEqual(admitted(store, first.wire), a);
  first.commit();
  const b = frame();
  b.grid[3]!.wrapped = true;
  b.grid[3]!.cells[0]!.grapheme = "👩‍💻é";
  b.grid[3]!.cells[1]!.attributes = 255;
  b.grid[3]!.cells[1]!.foreground = { kind: "rgb", value: 0x123456 };
  b.cursor = { ...b.cursor, x: 5, style: "bar" };
  b.modes.bracketedPaste = true;
  b.history = [structuredClone(b.grid[3]!)];
  b.placements = [
    { id: "image", kind: "kitty", row: 0, column: 0, columns: 1, rows: 1, contentDigest: "digest" },
  ];
  const second = producer.prepare(b, "request/source/layout/history");
  assert.equal(second.wire.encoding, "rle-delta-v1");
  if (second.wire.encoding === "rle-delta-v1")
    assert.deepEqual(
      second.wire.changedRows.map(([i]) => i),
      [3],
    );
  assert.deepEqual(admitted(store, second.wire), b);
  second.commit();
  const idle = producer.prepare(b, "request/source/layout/history");
  assert.equal(idle.wire.encoding, "rle-delta-v1");
  if (idle.wire.encoding === "rle-delta-v1") assert.deepEqual(idle.wire.changedRows, []);
  assert.deepEqual(admitted(store, idle.wire), b);
});

test("accepted false write commits A; overwritten B cannot become C's baseline", () => {
  const producer = createCompactDeltaProducer(),
    store = createCompactDeltaStore();
  const a = frame(),
    b = frame(),
    c = frame();
  b.grid[0]!.cells[0]!.grapheme = "B";
  c.grid[1]!.cells[0]!.grapheme = "C";
  const first = producer.prepare(a, "route");
  const acceptedWrite = (_: string) => false;
  assert.equal(acceptedWrite(first.json), false);
  first.commit();
  admitted(store, first.wire);
  const pending = producer.prepare(b, "route");
  const latest = producer.prepare(c, "route");
  assert.equal(latest.wire.seq, 2);
  assert.deepEqual(admitted(store, latest.wire), c);
  latest.commit();
  assert.throws(() => pending.commit(), /Stale/);
  assert.throws(() => latest.commit(), /Stale/);
});

test("failed writes and reset never establish an emitted baseline", () => {
  const producer = createCompactDeltaProducer();
  const candidate = producer.prepare(frame(), "a");
  assert.equal(producer.prepare(frame(), "a").wire.encoding, "rle-v1");
  producer.reset();
  assert.throws(() => candidate.commit(), /Stale/);
  assert.equal(producer.prepare(frame(), "a").wire.seq, 1);
});

test("identity, resize and alternate screen each establish fresh full epochs", () => {
  const producer = createCompactDeltaProducer(),
    store = createCompactDeltaStore();
  let previous = "";
  for (const [snapshot, identity] of [
    [frame(), "a"],
    [frame(), "b"],
    [blankTerminalReplicaSnapshot(81, 24), "b"],
    [
      {
        ...blankTerminalReplicaSnapshot(81, 24),
        modes: { ...frame().modes, alternateScreen: true },
      },
      "b",
    ],
  ] as const) {
    const candidate = producer.prepare(snapshot, identity);
    assert.equal(candidate.wire.encoding, "rle-v1");
    assert.equal(candidate.wire.seq, 1);
    assert.notEqual(candidate.wire.epoch, previous);
    assert.deepEqual(admitted(store, candidate.wire), snapshot);
    candidate.commit();
    previous = candidate.wire.epoch;
  }
});

test("receiver gaps, stale frames and reset cannot silently advance state", () => {
  const producer = createCompactDeltaProducer(),
    store = createCompactDeltaStore();
  const first = producer.prepare(frame(), "a");
  first.commit();
  const second = producer.prepare(frame(), "a");
  second.commit();
  const third = producer.prepare(frame(), "a");
  assert.throws(() => store.prepare(second.wire), CompactBaselineError);
  admitted(store, first.wire);
  assert.throws(() => store.prepare(third.wire), CompactBaselineError);
  admitted(store, second.wire);
  assert.throws(() => store.prepare(first.wire), CompactBaselineError);
  assert.throws(() => store.prepare(second.wire), CompactBaselineError);
  assert.deepEqual(admitted(store, third.wire), frame());
  store.reset();
  assert.throws(() => store.prepare(third.wire), CompactBaselineError);
});

test("outer validation can reject a prepared frame without advancing receiver", () => {
  const producer = createCompactDeltaProducer(),
    store = createCompactDeltaStore();
  const first = producer.prepare(frame(), "a");
  first.commit();
  admitted(store, first.wire);
  const second = producer.prepare(frame(), "a");
  const discarded = store.prepare(second.wire);
  const accepted = store.prepare(second.wire);
  accepted.commit();
  assert.throws(() => discarded.commit(), /Stale/);
  assert.throws(() => accepted.commit(), /Stale/);
});

for (const [name, mutate] of [
  [
    "duplicate row",
    (v: CompactDeltaFrame & { injected?: boolean }) => {
      v.changedRows.push(v.changedRows[0]);
    },
  ],
  [
    "unsorted row",
    (v: CompactDeltaFrame & { injected?: boolean }) => {
      v.changedRows = [
        [1, v.changedRows[0][1]],
        [0, v.changedRows[0][1]],
      ];
    },
  ],
  [
    "outside row",
    (v: CompactDeltaFrame & { injected?: boolean }) => {
      v.changedRows[0][0] = 24;
    },
  ],
  [
    "bad run",
    (v: CompactDeltaFrame & { injected?: boolean }) => {
      v.changedRows[0][1][1][0][0] = 262144;
    },
  ],
  [
    "invalid Unicode",
    (v: CompactDeltaFrame & { injected?: boolean }) => {
      v.changedRows[0][1][1][0][1] = "\ud800";
    },
  ],
  [
    "invalid metadata",
    (v: CompactDeltaFrame & { injected?: boolean }) => {
      v.cursor.x = 100;
      v.cursor.hidden = false;
    },
  ],
  [
    "screen basis",
    (v: CompactDeltaFrame & { injected?: boolean }) => {
      v.modes.alternateScreen = true;
    },
  ],
  [
    "unsafe sequence",
    (v: CompactDeltaFrame & { injected?: boolean }) => {
      v.seq = Number.MAX_SAFE_INTEGER + 1;
    },
  ],
  [
    "skipped sequence",
    (v: CompactDeltaFrame & { injected?: boolean }) => {
      v.seq += 1;
    },
  ],
  [
    "unknown field",
    (v: CompactDeltaFrame & { injected?: boolean }) => {
      v.injected = true;
    },
  ],
  [
    "wrong geometry",
    (v: CompactDeltaFrame & { injected?: boolean }) => {
      v.cols++;
    },
  ],
  [
    "wrong epoch",
    (v: CompactDeltaFrame & { injected?: boolean }) => {
      v.epoch = "other";
    },
  ],
  [
    "epoch bytes",
    (v: CompactDeltaFrame & { injected?: boolean }) => {
      v.epoch = "🙂";
    },
  ],
] as const)
  test(`malformed ${name} is atomic`, () => {
    const producer = createCompactDeltaProducer(),
      store = createCompactDeltaStore();
    const first = producer.prepare(frame(), "a");
    first.commit();
    admitted(store, first.wire);
    const b = frame();
    b.grid[0]!.cells[0]!.grapheme = "B";
    const second = producer.prepare(b, "a");
    const bad = structuredClone(second.wire);
    mutate(bad as CompactDeltaFrame);
    assert.throws(() => store.prepare(bad));
    assert.deepEqual(admitted(store, second.wire), b);
  });

test("full beats dense delta by actual UTF-8 wire size; caller mutation cannot poison base", () => {
  const producer = createCompactDeltaProducer(),
    store = createCompactDeltaStore();
  const first = producer.prepare(frame(), "a");
  first.commit();
  admitted(store, first.wire);
  const b = frame();
  for (const row of b.grid) for (const cell of row.cells) cell.grapheme = "🙂";
  const second = producer.prepare(b, "a");
  assert.equal(second.wire.encoding, "rle-v1");
  const original = JSON.parse(second.json);
  second.wire.cols = 1;
  b.grid[0]!.cells[0]!.grapheme = "mutated";
  second.commit();
  const expected = admitted(store, original);
  const next = producer.prepare(expected, "a");
  assert.deepEqual(admitted(store, next.wire), expected);
});

test("dimension and grapheme budgets remain bounded for full and delta", () => {
  const producer = createCompactDeltaProducer(),
    store = createCompactDeltaStore();
  const snapshot = blankTerminalReplicaSnapshot(512, 512);
  const first = producer.prepare(snapshot, "max");
  first.commit();
  admitted(store, first.wire);
  const next = producer.prepare(snapshot, "max");
  assert.deepEqual(admitted(store, next.wire), snapshot);
  assert.throws(() => producer.prepare(blankTerminalReplicaSnapshot(513, 512), "large"));
});

test("sequence rollover establishes a fresh epoch instead of unsafe integers", () => {
  const producer = createCompactDeltaProducer({ sequenceLimit: 2 });
  const store = createCompactDeltaStore();
  const a = producer.prepare(frame(), "a");
  a.commit();
  admitted(store, a.wire);
  const b = producer.prepare(frame(), "a");
  b.commit();
  admitted(store, b.wire);
  const c = producer.prepare(frame(), "a");
  assert.equal(c.wire.encoding, "rle-v1");
  assert.equal(c.wire.seq, 1);
  assert.notEqual(c.wire.epoch, b.wire.epoch);
  assert.deepEqual(admitted(store, c.wire), frame());
  assert.throws(() => createCompactDeltaProducer({ sequenceLimit: Number.MAX_SAFE_INTEGER + 1 }));
});

test("receiver candidate mutation and reset cannot corrupt committed cells", () => {
  const producer = createCompactDeltaProducer(),
    store = createCompactDeltaStore();
  const a = producer.prepare(frame(), "a");
  a.commit();
  const candidate = store.prepare(a.wire);
  candidate.snapshot.grid[0]!.cells[0]!.grapheme = "mutated";
  candidate.commit();
  const b = producer.prepare(frame(), "a");
  assert.deepEqual(admitted(store, b.wire), frame());
  const pending = store.prepare({ ...b.wire, seq: 3, baseSeq: 2 });
  store.reset();
  assert.throws(() => pending.commit(), /Stale/);
});

test("production prepare/commit avoids JSON parsing and serializes each row key once", (t) => {
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  let parses = 0;
  let rowKeys = 0;
  t.mock.method(JSON, "parse", (...args: Parameters<typeof JSON.parse>) => {
    parses++;
    return parse(...args);
  });
  t.mock.method(JSON, "stringify", (value: unknown) => {
    if (Array.isArray(value) && typeof value[0] === "boolean") rowKeys++;
    return stringify(value);
  });
  const producer = createCompactDeltaProducer();
  const first = producer.prepare(frame(), "a");
  first.commit();
  const second = producer.prepare(frame(), "a");
  second.commit();
  assert.equal(second.seq, 2);
  assert.equal(second.epoch, first.epoch);
  assert.equal(second.encoding, "rle-delta-v1");
  assert.equal(parses, 0);
  assert.equal(rowKeys, 48);
  assert.equal(second.wire.encoding, "rle-delta-v1");
  assert.equal(parses, 1);
});

test("small metadata is owned before caller changes it or returned candidate metadata", () => {
  const producer = createCompactDeltaProducer(),
    store = createCompactDeltaStore();
  const source = frame();
  source.placements = [
    { id: "image", kind: "kitty", row: 0, column: 0, columns: 1, rows: 1, contentDigest: "digest" },
  ];
  const first = producer.prepare(source, "a");
  const expected = structuredClone(source);
  source.cursor.x = 79;
  source.modes.alternateScreen = true;
  source.bootstrap.hiddenState = "unknown";
  source.placements[0]!.id = "changed";
  first.commit();
  const received = store.prepare(first.wire);
  received.snapshot.cursor.x = 79;
  received.snapshot.modes.alternateScreen = true;
  received.snapshot.bootstrap.hiddenState = "unknown";
  received.snapshot.placements[0]!.id = "changed";
  received.commit();
  const second = producer.prepare(expected, "a");
  assert.equal(second.wire.encoding, "rle-delta-v1");
  assert.deepEqual(admitted(store, second.wire), expected);
});
