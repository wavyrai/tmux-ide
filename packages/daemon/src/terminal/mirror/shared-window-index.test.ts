import { expect, it } from "vitest";
import { SharedWindowIndex } from "./shared-window-index.ts";

it("revokes every overlapping owner and recovers only after its final overlap disappears", () => {
  const index = new SharedWindowIndex<string>();
  expect(index.update("a", ["@1", "@2", "@1"])).toEqual(new Map());
  expect(index.update("b", ["@1"])).toEqual(
    new Map([
      ["b", true],
      ["a", true],
    ]),
  );
  expect(index.update("c", ["@2"])).toEqual(new Map([["c", true]]));
  expect(index.update("b", [])).toEqual(new Map([["b", false]]));
  expect(index.conflicted("a")).toBe(true);
  expect(index.update("c", [])).toEqual(
    new Map([
      ["c", false],
      ["a", false],
    ]),
  );
  expect(index.update("b", ["@1"])).toEqual(
    new Map([
      ["b", true],
      ["a", true],
    ]),
  );
});

it("separates replacement owners and independent physical windows", () => {
  const index = new SharedWindowIndex<object>();
  const retired = {},
    replacement = {},
    peer = {};
  index.update(retired, ["@1"]);
  index.update(peer, ["@2"]);
  expect(index.conflicted(peer)).toBe(false);
  index.update(retired, []);
  expect(index.update(replacement, ["@1"])).toEqual(new Map());
  expect(index.update(peer, ["@1", "@2"])).toEqual(
    new Map([
      [peer, true],
      [replacement, true],
    ]),
  );
  expect(index.conflicted(retired)).toBe(false);
  expect(index.update(replacement, [])).toEqual(
    new Map([
      [replacement, false],
      [peer, false],
    ]),
  );
});
