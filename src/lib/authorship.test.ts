import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractMarks,
  embedMarks,
  calculateStats,
  createAuthored,
  normalizeQuote,
  reanchorMarks,
  tagContent,
  generateMarkId,
  type Mark,
  type MarksDocument,
} from "./authorship.ts";

describe("normalizeQuote", () => {
  it("collapses whitespace", () => {
    assert.strictEqual(normalizeQuote("  hello   world  "), "hello world");
  });

  it("handles newlines", () => {
    assert.strictEqual(normalizeQuote("line1\n  line2\n"), "line1 line2");
  });
});

describe("generateMarkId", () => {
  it("returns unique IDs", () => {
    const a = generateMarkId();
    const b = generateMarkId();
    assert.notStrictEqual(a, b);
    assert.ok(a.startsWith("m"));
  });
});

describe("createAuthored", () => {
  it("creates a mark with correct fields", () => {
    const mark = createAuthored("ai:François", { from: 0, to: 50 }, "some text");
    assert.strictEqual(mark.kind, "authored");
    assert.strictEqual(mark.by, "ai:François");
    assert.strictEqual(mark.range.from, 0);
    assert.strictEqual(mark.range.to, 50);
    assert.strictEqual(mark.quote, "some text");
    assert.ok(mark.id.startsWith("m"));
    assert.ok(mark.at.includes("T")); // ISO timestamp
  });
});

describe("extractMarks", () => {
  it("extracts marks from markdown with comment block", () => {
    const doc: MarksDocument = {
      version: 2,
      marks: {
        m1: {
          id: "m1",
          kind: "authored",
          by: "ai:François",
          at: "2026-01-01T00:00:00Z",
          range: { from: 0, to: 13 },
          quote: "Hello world!",
        },
      },
    };
    const md = `Hello world!\n\n<!-- TMUX-IDE:MARKS\n${JSON.stringify(doc, null, 2)}\n-->\n`;

    const result = extractMarks(md);
    assert.ok(result.marks);
    assert.strictEqual(result.marks!.version, 2);
    assert.strictEqual(Object.keys(result.marks!.marks).length, 1);
    assert.strictEqual(result.marks!.marks["m1"]!.by, "ai:François");
    assert.ok(result.content.includes("Hello world!"));
    assert.ok(!result.content.includes("TMUX-IDE:MARKS"));
  });

  it("returns null marks when no comment block", () => {
    const md = "Just content.";
    const result = extractMarks(md);
    assert.strictEqual(result.marks, null);
    assert.strictEqual(result.content, md);
  });

  it("handles malformed JSON gracefully", () => {
    const md = "Content.\n\n<!-- TMUX-IDE:MARKS\nnot json\n-->\n";
    const result = extractMarks(md);
    assert.strictEqual(result.marks, null);
  });
});

describe("embedMarks", () => {
  it("appends marks comment to markdown", () => {
    const md = "Hello world!";
    const doc: MarksDocument = {
      version: 2,
      marks: {
        m1: createAuthored("ai:François", { from: 0, to: 12 }, "Hello world!"),
      },
    };

    const result = embedMarks(md, doc);
    assert.ok(result.includes("Hello world!"));
    assert.ok(result.includes("TMUX-IDE:MARKS"));
    assert.ok(result.includes("ai:François"));
  });

  it("replaces existing marks comment", () => {
    const oldDoc: MarksDocument = { version: 2, marks: {} };
    const md = `Content.\n\n<!-- TMUX-IDE:MARKS\n${JSON.stringify(oldDoc)}\n-->\n`;

    const newDoc: MarksDocument = {
      version: 2,
      marks: {
        m1: createAuthored("human:thijs", { from: 0, to: 8 }, "Content."),
      },
    };

    const result = embedMarks(md, newDoc);
    const count = (result.match(/TMUX-IDE:MARKS/g) || []).length;
    assert.strictEqual(count, 1);
    assert.ok(result.includes("human:thijs"));
  });
});

describe("calculateStats", () => {
  it("calculates AI vs human percentages from marks", () => {
    const marks: Record<string, Mark> = {
      m1: createAuthored("ai:François", { from: 0, to: 300 }, "ai text"),
      m2: createAuthored("human:thijs", { from: 300, to: 500 }, "human text"),
    };
    const stats = calculateStats(marks);
    assert.strictEqual(stats.totalChars, 500);
    assert.strictEqual(stats.aiPercent, 60);
    assert.strictEqual(stats.humanPercent, 40);
  });

  it("returns 100% AI when all marks are AI", () => {
    const marks: Record<string, Mark> = {
      m1: createAuthored("ai:Amélie", { from: 0, to: 100 }, "text"),
      m2: createAuthored("ai:Louis", { from: 100, to: 200 }, "more text"),
    };
    const stats = calculateStats(marks);
    assert.strictEqual(stats.aiPercent, 100);
    assert.strictEqual(stats.humanPercent, 0);
  });

  it("returns zeros for empty marks", () => {
    const stats = calculateStats({});
    assert.strictEqual(stats.totalChars, 0);
    assert.strictEqual(stats.aiPercent, 0);
  });

  it("skips orphaned marks", () => {
    const marks: Record<string, Mark> = {
      m1: { ...createAuthored("ai:X", { from: 0, to: 100 }, "text"), orphaned: true },
      m2: createAuthored("human:Y", { from: 0, to: 50 }, "text"),
    };
    const stats = calculateStats(marks);
    assert.strictEqual(stats.totalChars, 50);
    assert.strictEqual(stats.humanPercent, 100);
  });

  it("skips non-authored marks", () => {
    const marks: Record<string, Mark> = {
      m1: createAuthored("ai:X", { from: 0, to: 100 }, "text"),
      m2: { ...createAuthored("human:Y", { from: 0, to: 50 }, "text"), kind: "comment" },
    };
    const stats = calculateStats(marks);
    assert.strictEqual(stats.totalChars, 100);
    assert.strictEqual(stats.aiPercent, 100);
  });
});

describe("reanchorMarks", () => {
  it("keeps marks with matching quotes at correct positions", () => {
    const content = "Hello world!";
    const marks: Record<string, Mark> = {
      m1: createAuthored("ai:X", { from: 0, to: 12 }, "Hello world!"),
    };
    const result = reanchorMarks(content, marks);
    assert.strictEqual(result["m1"]!.range.from, 0);
    assert.strictEqual(result["m1"]!.range.to, 12);
    assert.strictEqual(result["m1"]!.orphaned, undefined);
  });

  it("re-anchors marks when content shifts", () => {
    // Content was "XHello" but now prefix was removed
    const content = "Hello world!";
    const marks: Record<string, Mark> = {
      m1: createAuthored("ai:X", { from: 1, to: 13 }, "Hello world!"),
    };
    const result = reanchorMarks(content, marks);
    assert.strictEqual(result["m1"]!.range.from, 0);
    assert.strictEqual(result["m1"]!.range.to, 12);
  });

  it("orphans marks when quote not found", () => {
    const content = "Completely different text.";
    const marks: Record<string, Mark> = {
      m1: createAuthored("ai:X", { from: 0, to: 12 }, "Hello world!"),
    };
    const result = reanchorMarks(content, marks);
    assert.strictEqual(result["m1"]!.orphaned, true);
  });
});

describe("tagContent", () => {
  it("tags entire content as authored", () => {
    const md = "Hello world!";
    const result = tagContent(md, "ai:François");

    const { marks } = extractMarks(result);
    assert.ok(marks);
    const authored = Object.values(marks!.marks).filter((m) => m.kind === "authored");
    assert.ok(authored.length > 0);
    assert.strictEqual(authored[0]!.by, "ai:François");
    assert.strictEqual(authored[0]!.range.from, 0);
    assert.strictEqual(authored[0]!.range.to, 12);
  });

  it("preserves existing marks and only tags uncovered ranges", () => {
    const existingMark = createAuthored("human:thijs", { from: 0, to: 5 }, "Hello");
    const doc: MarksDocument = { version: 2, marks: { [existingMark.id]: existingMark } };
    const md = embedMarks("Hello world!", doc);

    const result = tagContent(md, "ai:Amélie");
    const { marks } = extractMarks(result);
    assert.ok(marks);

    const marksList = Object.values(marks!.marks).filter(
      (m) => m.kind === "authored" && !m.orphaned,
    );
    // Should have human mark for "Hello" and AI mark for the rest
    const humanMarks = marksList.filter((m) => m.by === "human:thijs");
    const aiMarks = marksList.filter((m) => m.by === "ai:Amélie");
    assert.ok(humanMarks.length > 0);
    assert.ok(aiMarks.length > 0);
  });

  it("round-trips: extract after tag returns same content", () => {
    const original = "Some plan content here.\n\n## Section Two\n\nMore content.";
    const tagged = tagContent(original, "ai:Louis");
    const { content } = extractMarks(tagged);
    assert.strictEqual(content, original);
  });
});
