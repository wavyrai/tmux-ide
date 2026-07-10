/**
 * Frame splitting is the wire's foundation: partial frames buffer, multiple
 * frames per chunk all surface, and encode/split round-trips exactly.
 */
import { describe, expect, it } from "vitest";
import { MAX_FRAME_BYTES, createFrameSplitter, encodeFrame } from "./frames.ts";

describe("encodeFrame", () => {
  it("emits one newline-terminated JSON line", () => {
    expect(encodeFrame({ v: 1, id: 1, verb: "fleet" })).toBe('{"v":1,"id":1,"verb":"fleet"}\n');
  });

  it("never contains a raw newline inside the payload", () => {
    const frame = encodeFrame({ text: "line one\nline two" });
    expect(frame.slice(0, -1)).not.toContain("\n");
  });
});

describe("createFrameSplitter", () => {
  it("buffers a partial frame across chunks", () => {
    const split = createFrameSplitter();
    expect(split('{"id":')).toEqual([]);
    expect(split("1}\n")).toEqual(['{"id":1}']);
  });

  it("returns multiple complete frames from one chunk", () => {
    const split = createFrameSplitter();
    expect(split('{"id":1}\n{"id":2}\n{"id":3}\n')).toEqual(['{"id":1}', '{"id":2}', '{"id":3}']);
  });

  it("holds the trailing partial while yielding the complete ones", () => {
    const split = createFrameSplitter();
    expect(split('{"id":1}\n{"id"')).toEqual(['{"id":1}']);
    expect(split(":2}\n")).toEqual(['{"id":2}']);
  });

  it("drops blank lines", () => {
    const split = createFrameSplitter();
    expect(split('\n\n  \n{"id":1}\n\n')).toEqual(['{"id":1}']);
  });

  it("round-trips encodeFrame output byte-split at every position", () => {
    const frame = encodeFrame({ v: 1, id: "x", verb: "send", params: { message: "a\nb" } });
    for (let cut = 1; cut < frame.length; cut++) {
      const split = createFrameSplitter();
      const first = split(frame.slice(0, cut));
      const second = split(frame.slice(cut));
      expect([...first, ...second]).toEqual([frame.trimEnd()]);
    }
  });

  it("throws when a partial line exceeds MAX_FRAME_BYTES", () => {
    const split = createFrameSplitter();
    const half = "x".repeat(MAX_FRAME_BYTES);
    expect(() => {
      split(half);
      split(half); // still no newline — over the limit
    }).toThrow(/exceeds/);
  });
});
