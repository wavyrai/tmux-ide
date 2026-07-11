import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyMatch } from "./fuzzy.ts";

describe("fuzzyMatch", () => {
  it("matches a subsequence and returns the matched indices", () => {
    const m = fuzzyMatch("web", "wavyr-website");
    expect(m).not.toBeNull();
    // "web" hits the "web" of "website" (after the "-").
    expect(m!.positions).toEqual([6, 7, 8]);
  });

  it("returns null when not a subsequence", () => {
    expect(fuzzyMatch("xyz", "wavyr-website")).toBeNull();
    // out-of-order chars are not a subsequence
    expect(fuzzyMatch("bew", "web")).toBeNull();
  });

  it("empty query matches everything with score 0", () => {
    const m = fuzzyMatch("", "anything");
    expect(m).toEqual({ score: 0, positions: [] });
  });

  it("is case-insensitive", () => {
    const m = fuzzyMatch("WEB", "wavyr-website");
    expect(m).not.toBeNull();
    expect(m!.positions).toEqual([6, 7, 8]);
  });

  it("scores a contiguous run higher than a scattered match", () => {
    const contiguous = fuzzyMatch("abc", "abcxyz")!;
    const scattered = fuzzyMatch("abc", "axbxc")!;
    expect(contiguous.score).toBeGreaterThan(scattered.score);
  });

  it("rewards a start-of-string match", () => {
    const atStart = fuzzyMatch("web", "website")!;
    const midWord = fuzzyMatch("web", "xxwebxx")!;
    expect(atStart.score).toBeGreaterThan(midWord.score);
  });

  it("rewards a post-separator match", () => {
    const postSep = fuzzyMatch("web", "wavyr-website")!;
    const midWord = fuzzyMatch("web", "wavyrwebsite")!;
    expect(postSep.score).toBeGreaterThan(midWord.score);
  });

  it("ranks a label-start (prefix) match above a mid-word run (M24.4)", () => {
    const prefix = fuzzyMatch("abcd", "abcdxyz")!;
    const midWord = fuzzyMatch("abcd", "xxabcdxx")!;
    expect(prefix.score).toBeGreaterThan(midWord.score);
    expect(prefix.positions).toEqual([0, 1, 2, 3]);
  });

  it("ranks a prefix match above a scattered match rich in word-start bonuses (M24.4)", () => {
    // Measured regression this tier fixes: three word-start hits (30) used to
    // outscore the exact prefix (29), so "save" ranked the wrong label first.
    const prefix = fuzzyMatch("save", "save file")!;
    const scattered = fuzzyMatch("save", "swap pane view east")!;
    expect(prefix.score).toBeGreaterThan(scattered.score);
  });

  it("the prefix tier is case-insensitive and leaves non-prefix anchoring alone", () => {
    expect(fuzzyMatch("SAVE", "Save file")!.score).toBe(fuzzyMatch("save", "Save file")!.score);
    // "web" still anchors on the word after the separator, not the leading w.
    expect(fuzzyMatch("web", "wavyr-website")!.positions).toEqual([6, 7, 8]);
  });
});

describe("fuzzyFilter", () => {
  const key = (s: string) => s;

  it("drops non-matches", () => {
    const out = fuzzyFilter("web", ["website", "landing", "webapp"], key);
    expect(out.map((m) => m.item)).toEqual(["website", "webapp"]);
  });

  it("sorts by score descending", () => {
    const out = fuzzyFilter("web", ["xxwebxx", "website"], key);
    // "website" matches at start → higher score → first.
    expect(out[0]!.item).toBe("website");
  });

  it("is stable on ties (preserves input order)", () => {
    // Both match identically (start-of-string "ab"), so ties keep input order.
    const out = fuzzyFilter("ab", ["abone", "abtwo", "abthree"], key);
    expect(out.map((m) => m.item)).toEqual(["abone", "abtwo", "abthree"]);
  });

  it("empty query returns all items in original order with score 0", () => {
    const items = ["c", "a", "b"];
    const out = fuzzyFilter("", items, key);
    expect(out.map((m) => m.item)).toEqual(["c", "a", "b"]);
    expect(out.every((m) => m.score === 0)).toBe(true);
  });

  it("filters a realistic project list by 'proto'", () => {
    const items = ["prototyper-ui", "wavyr-website", "new-name", "prototyper-platform"];
    const out = fuzzyFilter("proto", items, key);
    expect(out.map((m) => m.item).sort()).toEqual(["prototyper-platform", "prototyper-ui"]);
  });
});
