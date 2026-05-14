/**
 * Unit tests for the Solid SearchService (G19-P2).
 *
 * Exercises the pure NDJSON consumer + the segmentLine helper.
 * The full HTTP path is covered by daemon-side tests in
 * packages/daemon/src/command-center/search-replace.test.ts and
 * .../search.test.ts; here we pin the renderer-facing shape only.
 */

import { describe, expect, it } from "vitest";
import { createRoot } from "solid-js";
import { createStore } from "solid-js/store";
import {
  consumeNdjson,
  iterateMatches,
  segmentLine,
  stepMatch,
  type FlatMatch,
  type SearchFrame,
  type SearchState,
} from "@/lib/search";

const INITIAL_STATE: SearchState = {
  status: "idle",
  byFile: {},
  fileOrder: [],
  summary: null,
  error: null,
};

function makeStream(frames: SearchFrame[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(JSON.stringify(f) + "\n"));
      controller.close();
    },
  });
}

describe("segmentLine", () => {
  it("returns one plain segment when no submatches", () => {
    expect(segmentLine("hello world", [])).toEqual([{ kind: "plain", text: "hello world" }]);
  });

  it("splits around a single submatch", () => {
    expect(segmentLine("hello world", [{ start: 6, end: 11 }])).toEqual([
      { kind: "plain", text: "hello " },
      { kind: "match", text: "world" },
    ]);
  });

  it("handles multiple submatches in order", () => {
    expect(
      segmentLine("aaa bbb aaa", [
        { start: 0, end: 3 },
        { start: 8, end: 11 },
      ]),
    ).toEqual([
      { kind: "match", text: "aaa" },
      { kind: "plain", text: " bbb " },
      { kind: "match", text: "aaa" },
    ]);
  });

  it("sorts and clamps out-of-range submatches", () => {
    expect(
      segmentLine("abc", [
        { start: 5, end: 99 },
        { start: 0, end: 1 },
      ]),
    ).toEqual([
      { kind: "match", text: "a" },
      { kind: "plain", text: "bc" },
    ]);
  });
});

describe("iterateMatches", () => {
  function fixtureState(): SearchState {
    return {
      status: "done",
      fileOrder: ["a.ts", "b.ts"],
      summary: null,
      error: null,
      byFile: {
        "a.ts": {
          path: "a.ts",
          expanded: true,
          snapshotMs: 0,
          contextByLine: {},
          matches: [
            { line: 1, text: "first", submatches: [{ start: 0, end: 5 }] },
            {
              line: 2,
              text: "second",
              submatches: [
                { start: 1, end: 3 },
                { start: 4, end: 6 },
              ],
            },
          ],
        },
        "b.ts": {
          path: "b.ts",
          expanded: true,
          snapshotMs: 0,
          contextByLine: {},
          matches: [{ line: 10, text: "tenth", submatches: [{ start: 2, end: 4 }] }],
        },
      },
    };
  }

  it("flattens file order × match order with per-line first-submatch column", () => {
    const flat = iterateMatches(fixtureState());
    expect(
      flat.map((m) => ({ path: m.path, line: m.line, column: m.column, length: m.length })),
    ).toEqual([
      { path: "a.ts", line: 1, column: 0, length: 5 },
      { path: "a.ts", line: 2, column: 1, length: 2 },
      { path: "b.ts", line: 10, column: 2, length: 2 },
    ]);
  });

  it("emits a stable id per match", () => {
    const flat = iterateMatches(fixtureState());
    expect(new Set(flat.map((m) => m.id)).size).toBe(flat.length);
    expect(flat[0]!.id).toBe("a.ts:1:0");
  });
});

describe("stepMatch", () => {
  const flat: FlatMatch[] = [
    { path: "a", line: 1, column: 0, length: 1, fileIndex: 0, matchIndex: 0, id: "a:1:0" },
    { path: "a", line: 2, column: 0, length: 1, fileIndex: 0, matchIndex: 1, id: "a:2:0" },
    { path: "b", line: 5, column: 0, length: 1, fileIndex: 1, matchIndex: 0, id: "b:5:0" },
  ];

  it("returns the first match when no current id (direction=next)", () => {
    expect(stepMatch(flat, null, "next")?.id).toBe("a:1:0");
  });

  it("returns the last match when no current id (direction=prev)", () => {
    expect(stepMatch(flat, null, "prev")?.id).toBe("b:5:0");
  });

  it("advances forward + wraps around at the end", () => {
    expect(stepMatch(flat, "a:1:0", "next")?.id).toBe("a:2:0");
    expect(stepMatch(flat, "a:2:0", "next")?.id).toBe("b:5:0");
    expect(stepMatch(flat, "b:5:0", "next")?.id).toBe("a:1:0");
  });

  it("advances backward + wraps around at the start", () => {
    expect(stepMatch(flat, "a:2:0", "prev")?.id).toBe("a:1:0");
    expect(stepMatch(flat, "a:1:0", "prev")?.id).toBe("b:5:0");
  });

  it("falls back to first/last when the current id has fallen out of the list", () => {
    expect(stepMatch(flat, "gone:0:0", "next")?.id).toBe("a:1:0");
    expect(stepMatch(flat, "gone:0:0", "prev")?.id).toBe("b:5:0");
  });

  it("returns null on an empty list", () => {
    expect(stepMatch([], null, "next")).toBeNull();
  });
});

describe("consumeNdjson", () => {
  function withState<T>(
    fn: (state: SearchState, setState: Parameters<typeof consumeNdjson>[2]) => Promise<T>,
  ): Promise<T> {
    return createRoot(async (dispose) => {
      const [state, setState] = createStore<SearchState>(structuredClone(INITIAL_STATE));
      const result = await fn(state, setState);
      dispose();
      return result;
    });
  }

  it("accumulates begin / match / end / summary into the store", async () => {
    await withState(async (state, setState) => {
      const stream = makeStream([
        { type: "begin", path: "src/foo.ts" },
        {
          type: "match",
          path: "src/foo.ts",
          line: 12,
          text: "  TODO: refactor\n",
          submatches: [{ start: 2, end: 6 }],
        },
        { type: "end", path: "src/foo.ts" },
        {
          type: "summary",
          matches: 1,
          filesSearched: 1,
          elapsedMs: 5,
          truncated: false,
        },
      ]);
      const controller = new AbortController();
      await consumeNdjson(stream, controller.signal, setState);

      expect(state.fileOrder).toEqual(["src/foo.ts"]);
      expect(state.byFile["src/foo.ts"]?.matches).toEqual([
        { line: 12, text: "  TODO: refactor", submatches: [{ start: 2, end: 6 }] },
      ]);
      expect(state.summary).toEqual({
        matches: 1,
        filesSearched: 1,
        elapsedMs: 5,
        truncated: false,
      });
    });
  });

  it("collects context frames keyed by line number", async () => {
    await withState(async (state, setState) => {
      const stream = makeStream([
        { type: "begin", path: "a.ts" },
        { type: "context", path: "a.ts", line: 11, text: "before\n" },
        {
          type: "match",
          path: "a.ts",
          line: 12,
          text: "TODO\n",
          submatches: [{ start: 0, end: 4 }],
        },
        { type: "context", path: "a.ts", line: 13, text: "after\n" },
        { type: "end", path: "a.ts" },
      ]);
      await consumeNdjson(stream, new AbortController().signal, setState);
      expect(state.byFile["a.ts"]?.contextByLine).toEqual({ 11: "before", 13: "after" });
    });
  });

  it("surfaces fatal error frames into status + error", async () => {
    await withState(async (state, setState) => {
      const stream = makeStream([
        { type: "error", message: "regex syntax error: ...", fatal: true },
      ]);
      await consumeNdjson(stream, new AbortController().signal, setState);
      expect(state.status).toBe("error");
      expect(state.error).toContain("regex syntax error");
    });
  });

  it("handles partial NDJSON across chunk boundaries", async () => {
    await withState(async (state, setState) => {
      const enc = new TextEncoder();
      const frame1 = JSON.stringify({ type: "begin", path: "a.ts" } satisfies SearchFrame);
      const frame2 = JSON.stringify({
        type: "match",
        path: "a.ts",
        line: 1,
        text: "TODO\n",
        submatches: [{ start: 0, end: 4 }],
      } satisfies SearchFrame);
      const buffer = frame1 + "\n" + frame2 + "\n";
      const half = Math.floor(buffer.length / 2);
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(buffer.slice(0, half)));
          c.enqueue(enc.encode(buffer.slice(half)));
          c.close();
        },
      });
      await consumeNdjson(stream, new AbortController().signal, setState);
      expect(state.byFile["a.ts"]?.matches).toEqual([
        { line: 1, text: "TODO", submatches: [{ start: 0, end: 4 }] },
      ]);
    });
  });
});
