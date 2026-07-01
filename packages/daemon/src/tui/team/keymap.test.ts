import { describe, expect, it } from "vitest";
import { DEFAULT_KEYMAP, mergeKeymap, resolveAction } from "./keymap.ts";

describe("mergeKeymap", () => {
  it("undefined overrides → defaults (deep copy)", () => {
    const km = mergeKeymap(undefined);
    expect(km).toEqual(DEFAULT_KEYMAP);
    // A copy, not the shared reference.
    expect(km.up.keys).not.toBe(DEFAULT_KEYMAP.up.keys);
  });

  it("empty overrides → defaults", () => {
    expect(mergeKeymap({})).toEqual(DEFAULT_KEYMAP);
  });

  it("an override replaces keys but keeps the default description", () => {
    const km = mergeKeymap({ up: ["w"] });
    expect(km.up.keys).toEqual(["w"]);
    expect(km.up.description).toBe(DEFAULT_KEYMAP.up.description);
  });

  it("ignores unknown action ids", () => {
    const km = mergeKeymap({ bogus: ["z"] } as Record<string, string[]>);
    expect(km).toEqual(DEFAULT_KEYMAP);
  });

  it("a partial override leaves other actions at their defaults", () => {
    const km = mergeKeymap({ quit: ["Q"] });
    expect(km.quit.keys).toEqual(["Q"]);
    expect(km.up.keys).toEqual(DEFAULT_KEYMAP.up.keys);
    expect(km.down.keys).toEqual(DEFAULT_KEYMAP.down.keys);
  });
});

describe("resolveAction", () => {
  it("resolves the primary key of a binding", () => {
    expect(resolveAction(DEFAULT_KEYMAP, "up")).toBe("up");
    expect(resolveAction(DEFAULT_KEYMAP, "return")).toBe("enter");
  });

  it("resolves an alias key", () => {
    expect(resolveAction(DEFAULT_KEYMAP, "k")).toBe("up");
    expect(resolveAction(DEFAULT_KEYMAP, "j")).toBe("down");
  });

  it("returns null for an unbound key", () => {
    expect(resolveAction(DEFAULT_KEYMAP, "z")).toBeNull();
  });

  it("is deterministic — a default key maps to exactly one action", () => {
    expect(resolveAction(DEFAULT_KEYMAP, "?")).toBe("help");
    expect(resolveAction(DEFAULT_KEYMAP, "/")).toBe("filter");
    expect(resolveAction(DEFAULT_KEYMAP, "x")).toBe("kill");
  });
});
