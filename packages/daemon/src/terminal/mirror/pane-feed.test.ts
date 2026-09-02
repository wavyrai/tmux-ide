/**
 * Unit tests for the pure seed/reseed delivery gate.
 */
import { describe, expect, it } from "vitest";
import { PaneFeed, parseCursorProbe, seedBytesFromCapture } from "./pane-feed.ts";
import type { MirrorPaneEvent } from "./events.ts";

const dec = new TextDecoder();

function text(event: MirrorPaneEvent | undefined): string {
  if (!event || (event.type !== "delta" && event.type !== "seed")) return "";
  return dec.decode(event.data);
}

describe("parseCursorProbe", () => {
  it("parses the four probe fields", () => {
    expect(parseCursorProbe("3 7 80 24")).toEqual({ x: 3, y: 7, cols: 80, rows: 24 });
  });

  it("accepts a zero cursor but rejects a zero grid", () => {
    expect(parseCursorProbe("0 0 80 24")).toEqual({ x: 0, y: 0, cols: 80, rows: 24 });
    expect(parseCursorProbe("0 0 0 24")).toBeNull();
  });

  it("rejects malformed lines", () => {
    expect(parseCursorProbe("")).toBeNull();
    expect(parseCursorProbe("1 2 3")).toBeNull();
    expect(parseCursorProbe("a b c d")).toBeNull();
  });
});

describe("seedBytesFromCapture", () => {
  it("re-encodes latin1 reply chars to raw bytes (the mojibake seam)", () => {
    // "é" on the wire is 0xC3 0xA9, read as two latin1 chars by the client.
    const wire = Buffer.from("café", "utf8").toString("latin1");
    expect(dec.decode(seedBytesFromCapture([wire]))).toBe("café");
  });

  it("joins capture lines with CRLF", () => {
    expect(dec.decode(seedBytesFromCapture(["a", "b"]))).toBe("a\r\nb");
  });
});

describe("PaneFeed", () => {
  const delta = (feed: PaneFeed, s: string): MirrorPaneEvent[] =>
    feed.delta(new TextEncoder().encode(s));

  it("passes deltas through while live", () => {
    const feed = new PaneFeed();
    const events = delta(feed, "hello");
    expect(events).toHaveLength(1);
    expect(text(events[0])).toBe("hello");
  });

  it("discards pre-capture deltas, holds probe-window deltas, and emits one atomic batch", () => {
    const feed = new PaneFeed();
    const epoch = feed.beginReseed();
    // Bytes read before the capture reply were produced before the capture
    // instant — the capture already contains them.
    expect(delta(feed, "IN-CAPTURE")).toEqual([]);
    feed.captureReply(epoch, ["screen line"]);
    // Bytes between the two probe replies are strictly-after-capture: held.
    expect(delta(feed, "HELD")).toEqual([]);
    const batch = feed.cursorReply(epoch, "2 5 80 24");
    expect(batch.map((event) => event.type)).toEqual(["reset", "seed", "delta", "cursor"]);
    expect(batch[0]).toEqual({ type: "reset", cols: 80, rows: 24 });
    expect(text(batch[1])).toBe("screen line");
    expect(text(batch[2])).toBe("HELD");
    expect(batch[3]).toEqual({ type: "cursor", x: 2, y: 5 });
    // Live again: deltas flow.
    expect(text(delta(feed, "AFTER")[0])).toBe("AFTER");
  });

  it("proves gaplessness: every byte is either in the capture epoch's discard window or delivered, never both dropped", () => {
    const feed = new PaneFeed();
    const epoch = feed.beginReseed();
    expect(delta(feed, "before")).toEqual([]); // in the capture by construction
    feed.captureReply(epoch, ["capture:before"]);
    expect(delta(feed, "mid")).toEqual([]); // held
    const batch = feed.cursorReply(epoch, "0 0 10 4");
    const replayed = batch.filter((event) => event.type === "seed" || event.type === "delta");
    expect(replayed.map(text)).toEqual(["capture:before", "mid"]);
    expect(text(delta(feed, "after")[0])).toBe("after");
  });

  it("epoch-guards overlapping reseeds — never two captures composited", () => {
    const feed = new PaneFeed();
    const first = feed.beginReseed();
    const second = feed.beginReseed();
    // The stale capture reply is ignored outright.
    feed.captureReply(first, ["STALE CAPTURE"]);
    expect(feed.currentState()).toBe("awaiting-capture");
    expect(feed.cursorReply(first, "0 0 80 24")).toEqual([]);
    feed.captureReply(second, ["FRESH CAPTURE"]);
    const batch = feed.cursorReply(second, "1 1 80 24");
    const seeds = batch.filter((event) => event.type === "seed");
    expect(seeds).toHaveLength(1);
    expect(text(seeds[0])).toBe("FRESH CAPTURE");
  });

  it("falls back to the layout size when the probe line is malformed", () => {
    const feed = new PaneFeed();
    const epoch = feed.beginReseed();
    feed.captureReply(epoch, ["x"]);
    const batch = feed.cursorReply(epoch, "garbage", { cols: 42, rows: 7 });
    expect(batch[0]).toEqual({ type: "reset", cols: 42, rows: 7 });
    expect(batch.some((event) => event.type === "cursor")).toBe(false);
  });

  it("omits reset and cursor when the probe fails and no fallback size exists", () => {
    const feed = new PaneFeed();
    const epoch = feed.beginReseed();
    feed.captureReply(epoch, ["x"]);
    const batch = feed.cursorReply(epoch, "", null);
    expect(batch.map((event) => event.type)).toEqual(["seed"]);
  });

  it("quarantines output after an aborted seed until a fresh authoritative seed", () => {
    const feed = new PaneFeed();
    const epoch = feed.beginReseed();
    expect(delta(feed, "discarded")).toEqual([]);
    feed.abort(epoch);
    expect(feed.currentState()).toBe("quarantined");
    expect(delta(feed, "quarantined")).toEqual([]);
    const fresh = feed.beginReseed();
    feed.captureReply(fresh, ["truth"]);
    expect(feed.cursorReply(fresh, "0 0 80 24").map((event) => event.type)).toEqual([
      "reset",
      "seed",
      "cursor",
    ]);
    expect(text(delta(feed, "flowing")[0])).toBe("flowing");
  });

  it("ignores a stale abort from a superseded reseed", () => {
    const feed = new PaneFeed();
    const first = feed.beginReseed();
    const second = feed.beginReseed();
    feed.abort(first);
    expect(feed.currentState()).toBe("awaiting-capture");
    feed.captureReply(second, ["seed"]);
    expect(feed.cursorReply(second, "0 0 5 5").map((event) => event.type)).toEqual([
      "reset",
      "seed",
      "cursor",
    ]);
  });

  it("bounds cursor-window retention, quarantines incomplete bytes, and requires a fresh reseed", () => {
    const feed = new PaneFeed();
    const epoch = feed.beginReseed();
    feed.captureReply(epoch, ["provisional"]);
    for (let index = 0; index < PaneFeed.MAX_HELD_CHUNKS; index += 1)
      expect(delta(feed, "x")).toEqual([]);
    const replay = delta(feed, "z");
    expect(replay).toEqual([]);
    expect(feed.takeOverflowed()).toBe(true);
    expect(feed.takeOverflowed()).toBe(false);
    expect(feed.cursorReply(epoch, "0 0 80 24")).toEqual([]);

    const next = feed.beginReseed();
    feed.captureReply(next, ["authoritative"]);
    expect(feed.cursorReply(next, "0 0 80 24").map((event) => event.type)).toEqual([
      "reset",
      "seed",
      "cursor",
    ]);
  });
});
