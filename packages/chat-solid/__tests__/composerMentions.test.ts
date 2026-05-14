import { describe, expect, it } from "vitest";
import { detectMentionContext } from "../src/lib/mentionCursor";
import { searchMentions, type MentionCandidate } from "../src/lib/mentionSearch";

const SAMPLE: MentionCandidate[] = [
  { kind: "file", value: "src/index.ts", label: "src/index.ts" },
  { kind: "file", value: "src/lib/api.ts", label: "src/lib/api.ts" },
  { kind: "file", value: "src/lib/composerDraftStore.ts", label: "src/lib/composerDraftStore.ts" },
  {
    kind: "thread",
    value: "t-42",
    label: "Refactor authentication",
    hint: "claude-code · 12 msgs",
  },
  { kind: "agent", value: "%1", label: "Agent 1", hint: "claude" },
];

describe("detectMentionContext", () => {
  it("returns inactive when caret is at 0", () => {
    expect(detectMentionContext("", 0)).toEqual({ active: false });
    expect(detectMentionContext("@foo", 0)).toEqual({ active: false });
  });

  it("activates immediately after @ at start of input", () => {
    expect(detectMentionContext("@", 1)).toEqual({ active: true, atIndex: 0, query: "" });
  });

  it("activates after @ preceded by whitespace", () => {
    const value = "hi @";
    expect(detectMentionContext(value, value.length)).toEqual({
      active: true,
      atIndex: 3,
      query: "",
    });
  });

  it("captures everything between @ and the caret as the query", () => {
    const value = "see @src/in";
    expect(detectMentionContext(value, value.length)).toEqual({
      active: true,
      atIndex: 4,
      query: "src/in",
    });
  });

  it("rejects @ embedded mid-word (email / preceded by non-whitespace)", () => {
    expect(detectMentionContext("foo@bar", 7)).toEqual({ active: false });
  });

  it("rejects when the query contains whitespace (token has been closed)", () => {
    const value = "@foo bar";
    expect(detectMentionContext(value, value.length)).toEqual({ active: false });
  });

  it("rejects nested @ in the query", () => {
    expect(detectMentionContext("@a@b", 4)).toEqual({ active: false });
  });

  it("anchors to the most recent @ before the caret", () => {
    const value = "@first hello @second";
    expect(detectMentionContext(value, value.length)).toEqual({
      active: true,
      atIndex: 13,
      query: "second",
    });
  });
});

describe("searchMentions", () => {
  it("returns all candidates sorted by kind when query is empty", () => {
    const out = searchMentions(SAMPLE, "");
    expect(out.length).toBeLessThanOrEqual(12);
    expect(out[0].candidate.kind).toBe("file");
    const kinds = out.map((r) => r.candidate.kind);
    // file kind precedes thread, thread precedes agent
    const fileIdx = kinds.lastIndexOf("file");
    const threadIdx = kinds.indexOf("thread");
    const agentIdx = kinds.indexOf("agent");
    expect(fileIdx).toBeLessThan(threadIdx);
    expect(threadIdx).toBeLessThan(agentIdx);
  });

  it("prefers prefix matches over substring matches", () => {
    const out = searchMentions(SAMPLE, "src");
    expect(out[0].candidate.label.startsWith("src/")).toBe(true);
  });

  it("filters out candidates that do not match the query", () => {
    const out = searchMentions(SAMPLE, "zzzzzzzz");
    expect(out).toEqual([]);
  });

  it("returns matched indices for highlighting", () => {
    const out = searchMentions(SAMPLE, "comp");
    const composer = out.find((r) => r.candidate.label.includes("composerDraftStore"));
    expect(composer).toBeTruthy();
    expect(composer!.matched.length).toBeGreaterThanOrEqual(4);
  });

  it("respects the limit parameter", () => {
    const out = searchMentions(SAMPLE, "", 2);
    expect(out).toHaveLength(2);
  });

  it("falls back to subsequence matching when no contiguous match exists", () => {
    // "iax" matches "src/lib/api.ts" via subsequence (i, a, x? — there's no x;
    // use a valid one: "ats" matches "src/lib/api.ts" via subsequence l→a→t→s)
    const out = searchMentions(SAMPLE, "ats");
    const api = out.find((r) => r.candidate.value === "src/lib/api.ts");
    expect(api).toBeTruthy();
  });
});
