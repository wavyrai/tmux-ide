import { test } from "node:test";
import assert from "node:assert/strict";
import { blankTerminalReplicaSnapshot } from "../../../packages/core/src/terminal-replica.ts";
import {
  freezeOwnedTerminalReplicaRow,
  createOwnedTerminalReplicaRowBuilder,
} from "../../../packages/core/src/terminal-replica-owned-row.ts";
import { createHistoryRowByteSizer } from "./history-row-byte-size.ts";
const row = () => ({
  ...blankTerminalReplicaSnapshot(2, 2).grid[0]!,
  cells: blankTerminalReplicaSnapshot(2, 2).grid[0]!.cells.map((cell) => ({ ...cell })),
});
test("owned ordinary rows serialize once with exact UTF8 cost", (t) => {
  const source = row();
  source.cells[0] = { ...source.cells[0]!, grapheme: "界🙂" };
  const owned = freezeOwnedTerminalReplicaRow(source);
  const expected = Buffer.byteLength(JSON.stringify(owned));
  const stringify = t.mock.method(JSON, "stringify");
  const size = createHistoryRowByteSizer();
  assert.equal(size(owned), expected);
  for (let i = 0; i < 100; i++) assert.equal(size(owned), expected);
  assert.equal(stringify.mock.callCount(), 1);
});
test("foreign mutable and frozen accessor rows recalculate", () => {
  const source = row();
  const size = createHistoryRowByteSizer();
  const before = size(source);
  source.cells[0] = { ...source.cells[0]!, grapheme: "longer" };
  assert.ok(size(source) > before);
  let wrapped = false;
  const accessor = Object.freeze({
    cells: source.cells,
    get wrapped() {
      return wrapped;
    },
  });
  assert.equal(size(accessor), Buffer.byteLength(JSON.stringify(accessor)));
  wrapped = true;
  assert.equal(size(accessor), Buffer.byteLength(JSON.stringify(accessor)));
});
test("owned row extras with custom serialization or mutable nested data never cache", () => {
  let text = "a";
  const builder = createOwnedTerminalReplicaRowBuilder();
  const hooked = builder.finish(Object.assign(row(), { toJSON: () => ({ text }) }), false);
  const size = createHistoryRowByteSizer();
  const before = size(hooked);
  text = "much longer";
  assert.ok(size(hooked) > before);
  const extra = { text: "a" };
  const other = createOwnedTerminalReplicaRowBuilder().finish(
    Object.assign(row(), { extra }),
    false,
  );
  const first = size(other);
  extra.text = "much longer";
  assert.ok(size(other) > first);
});
