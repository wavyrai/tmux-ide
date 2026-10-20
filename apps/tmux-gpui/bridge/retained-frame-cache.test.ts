import assert from "node:assert/strict";
import { test } from "node:test";
import { blankTerminalReplicaSnapshot } from "../../../packages/core/src/terminal-replica.ts";
import { createRetainedFrameCache } from "./retained-frame-cache.ts";
const frame = () => structuredClone(blankTerminalReplicaSnapshot(2, 2));
const large = (bytes: number) => {
  const value = frame();
  Object.assign(value.grid[0]!.cells[0]!, { grapheme: "x".repeat(bytes) });
  return value;
};
test("cached frames isolate both producer and consumer mutations and reject changed proof", () => {
  const cache = createRetainedFrameCache(),
    value = frame();
  assert.equal(cache.remember("a", "incarnation1", value), true);
  Object.assign(value.grid[0]!.cells[0]!, { grapheme: "changed" });
  const cached = cache.preview("a", "incarnation1")!;
  const preview = JSON.parse(cached);
  assert.equal(preview.grid[0]!.cells[0]!.grapheme, " ");
  Object.assign(preview.grid[0]!.cells[0]!, { grapheme: "consumer" });
  assert.equal(JSON.parse(cache.preview("a", "incarnation1")!).grid[0].cells[0].grapheme, " ");
  assert.equal(cache.preview("a", "incarnation2"), null);
  assert.equal(cache.preview("a", "incarnation1"), null);
});
test("eight-entry LRU honors preview, replacement, retained tabs and clear", () => {
  const cache = createRetainedFrameCache();
  for (let i = 0; i < 8; i++) cache.remember(String(i), "proof", frame());
  assert.ok(cache.preview("0", "proof"));
  cache.remember("8", "proof", frame());
  assert.equal(cache.preview("1", "proof"), null);
  assert.ok(cache.preview("0", "proof"));
  cache.remember("2", "new", frame());
  cache.retain(["0", "2"]);
  assert.equal(cache.preview("8", "proof"), null);
  assert.ok(cache.preview("2", "new"));
  cache.clear();
  assert.equal(cache.preview("0", "proof"), null);
  assert.equal(cache.remember("fresh", "proof", frame()), true);
});
test("serialized byte limits reject oversize frames and evict to total budget", () => {
  const cache = createRetainedFrameCache();
  for (let i = 0; i < 6; i++)
    assert.equal(cache.remember(String(i), "proof", large(3 * 1024 * 1024)), true);
  assert.equal(cache.preview("0", "proof"), null);
  for (let i = 1; i < 6; i++) assert.ok(cache.preview(String(i), "proof"));
  assert.equal(cache.remember("1", "proof", large(4 * 1024 * 1024)), false);
  assert.equal(cache.preview("1", "proof"), null);
  assert.equal(cache.remember("", "proof", frame()), false);
  assert.equal(cache.remember("a", "", frame()), false);
});
