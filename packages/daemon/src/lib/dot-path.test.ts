import { describe, it, expect } from "bun:test";
import { getByPath, setByPath } from "./dot-path.ts";

describe("getByPath", () => {
  it("gets a top-level key", () => {
    expect(getByPath({ name: "test" }, "name")).toBe("test");
  });

  it("gets a nested value", () => {
    const obj = { rows: [{ panes: [{ title: "Shell" }] }] };
    expect(getByPath(obj, "rows.0.panes.0.title")).toBe("Shell");
  });

  it("returns undefined for non-existent path", () => {
    expect(getByPath({}, "a.b.c")).toBe(undefined);
  });

  it("returns undefined for partially valid path", () => {
    expect(getByPath({ a: { b: 1 } }, "a.b.c")).toBe(undefined);
  });
});

describe("setByPath", () => {
  it("sets a top-level key", () => {
    const obj = {};
    setByPath(obj, "name", "test");
    expect(obj).toEqual({ name: "test" });
  });

  it("sets a nested value", () => {
    const obj = { rows: [{ panes: [{ title: "old" }] }] };
    setByPath(obj, "rows.0.panes.0.title", "new");
    expect(obj.rows[0].panes[0].title).toBe("new");
  });

  it("creates arrays for numeric keys", () => {
    const obj = {};
    setByPath(obj, "rows.0.title", "test");
    expect(Array.isArray(obj.rows)).toBeTruthy();
    expect(obj.rows[0].title).toBe("test");
  });

  it("creates objects for string keys", () => {
    const obj = {};
    setByPath(obj, "a.b.c", "val");
    expect(obj).toEqual({ a: { b: { c: "val" } } });
  });

  it("handles duplicate segment values (regression)", () => {
    // Bug: rows.0.panes.0 — both "0" segments caused indexOf to return
    // the same index, breaking the lookahead for array vs object creation
    const obj = {};
    setByPath(obj, "rows.0.panes.0", "value");
    expect(Array.isArray(obj.rows)).toBeTruthy();
    expect(Array.isArray(obj.rows[0].panes)).toBeTruthy();
    expect(obj.rows[0].panes[0]).toBe("value");
  });

  it("handles deeper duplicate segments", () => {
    const obj = {};
    setByPath(obj, "a.0.b.0.c", "deep");
    expect(Array.isArray(obj.a)).toBeTruthy();
    expect(Array.isArray(obj.a[0].b)).toBeTruthy();
    expect(obj.a[0].b[0].c).toBe("deep");
  });
});
