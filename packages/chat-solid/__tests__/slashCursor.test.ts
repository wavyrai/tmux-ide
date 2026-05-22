import { describe, expect, it } from "vitest";
import { detectSlashContext } from "../src/lib/slashCursor";

describe("detectSlashContext", () => {
  it.each([
    ["/", 1, { active: true, slashIndex: 0, query: "" }],
    ["/co", 3, { active: true, slashIndex: 0, query: "co" }],
    ["say /co", 7, { active: true, slashIndex: 4, query: "co" }],
    ["say\n/co", 7, { active: true, slashIndex: 4, query: "co" }],
    ["say/co", 6, { active: false }],
    ["/co now", 7, { active: false }],
    ["/co", 0, { active: false }],
    ["abc", 3, { active: false }],
  ])("detects slash context in %j at %d", (value, caret, expected) => {
    expect(detectSlashContext(value, caret)).toEqual(expected);
  });
});
