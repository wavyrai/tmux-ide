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

test("owned foreign Proxy extras cannot poison sizes or introduce inspection errors", () => {
  let text = "a";
  const extra = new Proxy(Object.freeze({}), {
    get(target, key) {
      return key === "toJSON" ? () => ({ text }) : Reflect.get(target, key);
    },
  });
  const owned = createOwnedTerminalReplicaRowBuilder().finish(
    Object.assign(row(), { extra }),
    false,
  );
  const size = createHistoryRowByteSizer();
  const first = size(owned);
  text = "much longer";
  assert.ok(size(owned) > first);
  assert.equal(size(owned), Buffer.byteLength(JSON.stringify(owned)));
  const opaque = new Proxy(Object.freeze({}), {
    getPrototypeOf() {
      throw Error("must not inspect foreign extra prototype");
    },
  });
  const other = createOwnedTerminalReplicaRowBuilder().finish(
    Object.assign(row(), { opaque }),
    false,
  );
  assert.equal(size(other), Buffer.byteLength(JSON.stringify(other)));
});

test("verified compact receiver history retains cache provenance across cursor patches", async (t) => {
  const { encodeCompactSemanticTerminalUpdate, decodeVerifiedCompactSemanticTerminalUpdate } =
    await import("../../../packages/core/src/terminal-delivery.ts");
  const { hashTerminalReplicaSnapshot } =
    await import("../../../packages/core/src/terminal-replica.ts");
  const { isDecodedTerminalReplicaRow, isTerminalReplicaRowDeeplyFrozen } =
    await import("../../../packages/core/src/terminal-replica-hash-cache.ts");
  const { createHistoryViewport } = await import("./history.ts");
  const source = { ...blankTerminalReplicaSnapshot(2, 2), history: [row()] };
  const first = decodeVerifiedCompactSemanticTerminalUpdate(
    encodeCompactSemanticTerminalUpdate({ frame: "seed", revision: 0, snapshot: source }),
    null,
    hashTerminalReplicaSnapshot(source),
  ).canonicalSnapshot!;
  const retained = first.history[0]!;
  assert.equal(isDecodedTerminalReplicaRow(retained), true);
  const foreign = freezeOwnedTerminalReplicaRow(row());
  assert.equal(isTerminalReplicaRowDeeplyFrozen(foreign), true);
  assert.equal(isDecodedTerminalReplicaRow(foreign), false);
  const target = { ...first, cursor: { ...first.cursor, x: 1 } };
  const second = decodeVerifiedCompactSemanticTerminalUpdate(
    encodeCompactSemanticTerminalUpdate({
      frame: "patch",
      baseRevision: 0,
      revision: 1,
      patch: { rows: [], cursor: target.cursor },
    }),
    first,
    hashTerminalReplicaSnapshot(target),
  ).canonicalSnapshot!;
  assert.equal(second.history[0], retained);
  const stringify = t.mock.method(JSON, "stringify");
  const viewport = createHistoryViewport();
  viewport.update(first);
  viewport.scroll(1);
  for (let i = 0; i < 20; i++) assert.equal(viewport.update(second)!.grid[0], retained);
  assert.equal(stringify.mock.calls.filter((call) => call.arguments[0] === retained).length, 1);
});
