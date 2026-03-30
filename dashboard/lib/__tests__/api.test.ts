import { describe, it, expect, vi, beforeEach } from "vitest";
import { marksToSections } from "../api";
import { makeMark } from "./support";

describe("marksToSections", () => {
  it("returns empty object for empty marks", () => {
    const result = marksToSections({}, "# Heading\nSome text");
    expect(result).toEqual({});
  });

  it("attributes a section to the mark author", () => {
    const content = "# Introduction\nSome intro text here";
    const marks: Record<string, Mark> = {
      m1: makeMark({
        by: "ai:Claude",
        range: { from: 0, to: content.length },
        at: "2026-03-21T10:00:00Z",
      }),
    };

    const result = marksToSections(marks, content);
    expect(result["Introduction"]).toBeDefined();
    expect(result["Introduction"]!.author).toBe("ai:Claude");
    expect(result["Introduction"]!.charCount).toBeGreaterThan(0);
  });

  it("picks dominant author when multiple authors contribute", () => {
    const content =
      "# Design\nShort bit by human. And then a much longer section written entirely by AI that has many more characters.";
    const marks: Record<string, Mark> = {
      m1: makeMark({
        id: "m1",
        by: "human:thijs",
        range: { from: 9, to: 30 },
        at: "2026-03-21T10:00:00Z",
      }),
      m2: makeMark({
        id: "m2",
        by: "ai:Claude",
        range: { from: 30, to: content.length },
        at: "2026-03-21T10:05:00Z",
      }),
    };

    const result = marksToSections(marks, content);
    expect(result["Design"]!.author).toBe("ai:Claude");
  });

  it("handles multiple sections independently", () => {
    const content = "# Section A\nText A\n# Section B\nText B";
    const sectionAEnd = content.indexOf("# Section B");
    const marks: Record<string, Mark> = {
      m1: makeMark({
        id: "m1",
        by: "human:thijs",
        range: { from: 0, to: sectionAEnd },
        at: "2026-03-21T10:00:00Z",
      }),
      m2: makeMark({
        id: "m2",
        by: "ai:Claude",
        range: { from: sectionAEnd, to: content.length },
        at: "2026-03-21T10:05:00Z",
      }),
    };

    const result = marksToSections(marks, content);
    expect(result["Section A"]!.author).toBe("human:thijs");
    expect(result["Section B"]!.author).toBe("ai:Claude");
  });

  it("skips orphaned marks", () => {
    const content = "# Heading\nSome text";
    const marks: Record<string, Mark> = {
      m1: makeMark({
        by: "ai:Claude",
        range: { from: 0, to: content.length },
        orphaned: true,
      }),
    };

    const result = marksToSections(marks, content);
    expect(result).toEqual({});
  });
});

describe("fetchPlan", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("transforms marks + stats into authorship data", async () => {
    const mockResponse = {
      name: "test-plan",
      content: "# Plan\nContent here",
      marks: {
        m1: makeMark({
          by: "ai:Claude",
          range: { from: 0, to: 20 },
        }),
      },
      stats: { aiPercent: 100, humanPercent: 0, totalChars: 20 },
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      }),
    );

    const { fetchPlan } = await import("../api");
    const result = await fetchPlan("session", "test-plan");

    expect(result.content).toBe("# Plan\nContent here");
    expect(result.authorship).not.toBeNull();
    expect(result.authorship!.stats.aiPercent).toBe(100);
    expect(result.authorship!.sections["Plan"]).toBeDefined();
  });

  it("returns null authorship when marks are null", async () => {
    const mockResponse = {
      name: "test-plan",
      content: "# Plan\nNo marks",
      marks: null,
      stats: null,
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      }),
    );

    const { fetchPlan } = await import("../api");
    const result = await fetchPlan("session", "test-plan");

    expect(result.content).toBe("# Plan\nNo marks");
    expect(result.authorship).toBeNull();
  });
});

describe("updateTask", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns Task object on success", async () => {
    const mockTask = {
      id: "001",
      title: "Test",
      status: "in-progress",
      assignee: "Claude",
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true, task: mockTask }),
      }),
    );

    const { updateTask } = await import("../api");
    const result = await updateTask("session", "001", { status: "in-progress" });

    expect(result).not.toBeNull();
    expect(result!.id).toBe("001");
    expect(result!.status).toBe("in-progress");
  });

  it("returns null on failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));

    const { updateTask } = await import("../api");
    const result = await updateTask("session", "001", { status: "done" });

    expect(result).toBeNull();
  });
});
