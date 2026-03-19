import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getByPath, setByPath } from "./dot-path.ts";

describe("getByPath", () => {
  it("gets a top-level key", () => {
    assert.strictEqual(getByPath({ name: "test" }, "name"), "test");
  });

  it("gets a nested value", () => {
    const obj = { rows: [{ panes: [{ title: "Shell" }] }] };
    assert.strictEqual(getByPath(obj, "rows.0.panes.0.title"), "Shell");
  });

  it("returns undefined for non-existent path", () => {
    assert.strictEqual(getByPath({}, "a.b.c"), undefined);
  });

  it("returns undefined for partially valid path", () => {
    assert.strictEqual(getByPath({ a: { b: 1 } }, "a.b.c"), undefined);
  });
});

describe("setByPath", () => {
  it("sets a top-level key", () => {
    const obj = {};
    setByPath(obj, "name", "test");
    assert.deepStrictEqual(obj, { name: "test" });
  });

  it("sets a nested value", () => {
    const obj = { rows: [{ panes: [{ title: "old" }] }] };
    setByPath(obj, "rows.0.panes.0.title", "new");
    assert.strictEqual(obj.rows[0].panes[0].title, "new");
  });

  it("creates arrays for numeric keys", () => {
    const obj = {};
    setByPath(obj, "rows.0.title", "test");
    assert.ok(Array.isArray(obj.rows));
    assert.strictEqual(obj.rows[0].title, "test");
  });

  it("creates objects for string keys", () => {
    const obj = {};
    setByPath(obj, "a.b.c", "val");
    assert.deepStrictEqual(obj, { a: { b: { c: "val" } } });
  });

  it("handles duplicate segment values (regression)", () => {
    // Bug: rows.0.panes.0 — both "0" segments caused indexOf to return
    // the same index, breaking the lookahead for array vs object creation
    const obj = {};
    setByPath(obj, "rows.0.panes.0", "value");
    assert.ok(Array.isArray(obj.rows), "rows should be an array");
    assert.ok(Array.isArray(obj.rows[0].panes), "panes should be an array");
    assert.strictEqual(obj.rows[0].panes[0], "value");
  });

  it("handles deeper duplicate segments", () => {
    const obj = {};
    setByPath(obj, "a.0.b.0.c", "deep");
    assert.ok(Array.isArray(obj.a));
    assert.ok(Array.isArray(obj.a[0].b));
    assert.strictEqual(obj.a[0].b[0].c, "deep");
  });
});
