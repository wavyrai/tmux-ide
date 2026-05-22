import { describe, it, expect } from "bun:test";
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
    expect(normalizeQuote("  hello   world  ")).toBe("hello world");
  });

  it("handles newlines", () => {
    expect(normalizeQuote("line1\n  line2\n")).toBe("line1 line2");
  });
});

describe("generateMarkId", () => {
  it("returns unique IDs", () => {
    const a = generateMarkId();
    const b = generateMarkId();
    expect(a).not.toBe(b);
    expect(a.startsWith("m")).toBeTruthy();
  });
});

describe("createAuthored", () => {
  it("creates a mark with correct fields", () => {
    const mark = createAuthored("ai:François", { from: 0, to: 50 }, "some text");
    expect(mark.kind).toBe("authored");
    expect(mark.by).toBe("ai:François");
    expect(mark.range.from).toBe(0);
    expect(mark.range.to).toBe(50);
    expect(mark.quote).toBe("some text");
    expect(mark.id.startsWith("m")).toBeTruthy();
    expect(mark.at.includes("T")).toBeTruthy(); // ISO timestamp
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
    expect(result.marks).toBeTruthy();
    expect(result.marks!.version).toBe(2);
    expect(Object.keys(result.marks!.marks).length).toBe(1);
    expect(result.marks!.marks["m1"]!.by).toBe("ai:François");
    expect(result.content.includes("Hello world!")).toBeTruthy();
    expect(!result.content.includes("TMUX-IDE:MARKS")).toBeTruthy();
  });

  it("returns null marks when no comment block", () => {
    const md = "Just content.";
    const result = extractMarks(md);
    expect(result.marks).toBe(null);
    expect(result.content).toBe(md);
  });

  it("handles malformed JSON gracefully", () => {
    const md = "Content.\n\n<!-- TMUX-IDE:MARKS\nnot json\n-->\n";
    const result = extractMarks(md);
    expect(result.marks).toBe(null);
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
    expect(result.includes("Hello world!")).toBeTruthy();
    expect(result.includes("TMUX-IDE:MARKS")).toBeTruthy();
    expect(result.includes("ai:François")).toBeTruthy();
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
    expect(count).toBe(1);
    expect(result.includes("human:thijs")).toBeTruthy();
  });
});

describe("calculateStats", () => {
  it("calculates AI vs human percentages from marks", () => {
    const marks: Record<string, Mark> = {
      m1: createAuthored("ai:François", { from: 0, to: 300 }, "ai text"),
      m2: createAuthored("human:thijs", { from: 300, to: 500 }, "human text"),
    };
    const stats = calculateStats(marks);
    expect(stats.totalChars).toBe(500);
    expect(stats.aiPercent).toBe(60);
    expect(stats.humanPercent).toBe(40);
  });

  it("returns 100% AI when all marks are AI", () => {
    const marks: Record<string, Mark> = {
      m1: createAuthored("ai:Amélie", { from: 0, to: 100 }, "text"),
      m2: createAuthored("ai:Louis", { from: 100, to: 200 }, "more text"),
    };
    const stats = calculateStats(marks);
    expect(stats.aiPercent).toBe(100);
    expect(stats.humanPercent).toBe(0);
  });

  it("returns zeros for empty marks", () => {
    const stats = calculateStats({});
    expect(stats.totalChars).toBe(0);
    expect(stats.aiPercent).toBe(0);
  });

  it("skips orphaned marks", () => {
    const marks: Record<string, Mark> = {
      m1: { ...createAuthored("ai:X", { from: 0, to: 100 }, "text"), orphaned: true },
      m2: createAuthored("human:Y", { from: 0, to: 50 }, "text"),
    };
    const stats = calculateStats(marks);
    expect(stats.totalChars).toBe(50);
    expect(stats.humanPercent).toBe(100);
  });

  it("skips non-authored marks", () => {
    const marks: Record<string, Mark> = {
      m1: createAuthored("ai:X", { from: 0, to: 100 }, "text"),
      m2: { ...createAuthored("human:Y", { from: 0, to: 50 }, "text"), kind: "comment" },
    };
    const stats = calculateStats(marks);
    expect(stats.totalChars).toBe(100);
    expect(stats.aiPercent).toBe(100);
  });
});

describe("reanchorMarks", () => {
  it("keeps marks with matching quotes at correct positions", () => {
    const content = "Hello world!";
    const marks: Record<string, Mark> = {
      m1: createAuthored("ai:X", { from: 0, to: 12 }, "Hello world!"),
    };
    const result = reanchorMarks(content, marks);
    expect(result["m1"]!.range.from).toBe(0);
    expect(result["m1"]!.range.to).toBe(12);
    expect(result["m1"]!.orphaned).toBe(undefined);
  });

  it("re-anchors marks when content shifts", () => {
    // Content was "XHello" but now prefix was removed
    const content = "Hello world!";
    const marks: Record<string, Mark> = {
      m1: createAuthored("ai:X", { from: 1, to: 13 }, "Hello world!"),
    };
    const result = reanchorMarks(content, marks);
    expect(result["m1"]!.range.from).toBe(0);
    expect(result["m1"]!.range.to).toBe(12);
  });

  it("orphans marks when quote not found", () => {
    const content = "Completely different text.";
    const marks: Record<string, Mark> = {
      m1: createAuthored("ai:X", { from: 0, to: 12 }, "Hello world!"),
    };
    const result = reanchorMarks(content, marks);
    expect(result["m1"]!.orphaned).toBe(true);
  });
});

describe("tagContent", () => {
  it("tags entire content as authored", () => {
    const md = "Hello world!";
    const result = tagContent(md, "ai:François");

    const { marks } = extractMarks(result);
    expect(marks).toBeTruthy();
    const authored = Object.values(marks!.marks).filter((m) => m.kind === "authored");
    expect(authored.length > 0).toBeTruthy();
    expect(authored[0]!.by).toBe("ai:François");
    expect(authored[0]!.range.from).toBe(0);
    expect(authored[0]!.range.to).toBe(12);
  });

  it("preserves existing marks and only tags uncovered ranges", () => {
    const existingMark = createAuthored("human:thijs", { from: 0, to: 5 }, "Hello");
    const doc: MarksDocument = { version: 2, marks: { [existingMark.id]: existingMark } };
    const md = embedMarks("Hello world!", doc);

    const result = tagContent(md, "ai:Amélie");
    const { marks } = extractMarks(result);
    expect(marks).toBeTruthy();

    const marksList = Object.values(marks!.marks).filter(
      (m) => m.kind === "authored" && !m.orphaned,
    );
    // Should have human mark for "Hello" and AI mark for the rest
    const humanMarks = marksList.filter((m) => m.by === "human:thijs");
    const aiMarks = marksList.filter((m) => m.by === "ai:Amélie");
    expect(humanMarks.length > 0).toBeTruthy();
    expect(aiMarks.length > 0).toBeTruthy();
  });

  it("round-trips: extract after tag returns same content", () => {
    const original = "Some plan content here.\n\n## Section Two\n\nMore content.";
    const tagged = tagContent(original, "ai:Louis");
    const { content } = extractMarks(tagged);
    expect(content).toBe(original);
  });
});
