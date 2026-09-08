/**
 * Unit tests for the pure seed/reseed delivery gate.
 */
import { describe, expect, it } from "vitest";
import { PaneFeed, parseCursorProbe, seedBytesFromCapture } from "./pane-feed.ts";
import type { MirrorPaneEvent } from "./events.ts";

const dec = new TextDecoder();

describe("observed wrap flag", () => {
  it.each([
    ["1", "1", "5", { top: 1, bottom: 5, origin: true }],
    ["0", "0", "23", { top: 0, bottom: 23, origin: false }],
    ["1", "4", "4", { top: 4, bottom: 4, origin: true }],
    ["1", "5", "1", undefined],
    ["1", "0", "24", undefined],
    ["invalid", "0", "5", undefined],
    ["1", "-1", "5", undefined],
    ["1", "0", "1.5", undefined],
    ["1", "0", "", undefined],
  ])("validates coupled scrolling observation %s %s %s", (origin, top, bottom, scrolling) => {
    const feed = new PaneFeed();
    const epoch = feed.beginReseed();
    feed.captureReply(epoch, ["AB"]);
    const fields = [
      "1",
      "0",
      "80",
      "24",
      "0",
      "1",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      origin,
      "1",
      "0",
      "2000",
      "0",
      "0",
      "0",
      "0",
      top,
      bottom,
    ];
    const cursor = feed.cursorReply(epoch, fields.join(" ")).at(-1);
    if (cursor?.type !== "cursor") throw new Error("Missing cursor event");
    expect(cursor.observedModes?.scrolling).toEqual(scrolling);
  });

  it.each([
    ["0 0 0 0", "none"],
    ["1 1 0 0", "vt200"],
    ["1 0 1 0", "drag"],
    ["1 0 0 1", "any"],
    ["1 0 0 0", undefined],
    ["0 1 0 0", undefined],
    ["1 1 1 0", undefined],
    ["1 0 0 invalid", undefined],
  ])("decodes consistent mouse observations %s", (flags, mouseProtocol) => {
    const [any, standard, button, all] = flags!.split(" ");
    const feed = new PaneFeed();
    const epoch = feed.beginReseed();
    feed.captureReply(epoch, ["AB"]);
    const fields = [
      "1",
      "0",
      "80",
      "24",
      "0",
      "1",
      "0",
      "0",
      "0",
      any,
      button,
      standard,
      "0",
      "1",
      "0",
      "2000",
      "1",
      all,
      "1",
      "0",
    ];
    const cursor = feed.cursorReply(epoch, fields.join(" ")).at(-1);
    expect(cursor?.type).toBe("cursor");
    if (cursor?.type !== "cursor") throw new Error("Missing cursor event");
    expect(cursor.observedModes).toEqual({
      alternateScreen: false,
      cursorVisible: true,
      insert: false,
      applicationCursor: false,
      applicationKeypad: false,
      bracketedPaste: true,
      mouseSgr: true,
      mouseUtf8: false,
      ...(mouseProtocol === undefined ? {} : { mouseProtocol }),
    });
  });
  it.each(["0", "1", "invalid", "2"])("validates scalar observations independently: %s", (flag) => {
    const feed = new PaneFeed();
    const epoch = feed.beginReseed();
    feed.captureReply(epoch, ["AB"]);
    const fields = ["1", "0", "80", "24", flag, flag, flag, flag, flag, "0", "0", "0", "0", "1"];
    const cursor = feed.cursorReply(epoch, fields.join(" ")).at(-1);
    expect(cursor).toEqual({
      type: "cursor",
      x: 1,
      y: 0,
      wraparound: true,
      ...(flag === "0" || flag === "1"
        ? {
            observedModes: {
              alternateScreen: flag === "1",
              cursorVisible: flag === "1",
              insert: flag === "1",
              applicationCursor: flag === "1",
              applicationKeypad: flag === "1",
            },
          }
        : {}),
    });
  });
  it.each(["0", "1", "invalid", "2"])(
    "carries only a valid wrap flag %s at the cursor seam",
    (flag) => {
      const feed = new PaneFeed();
      const epoch = feed.beginReseed();
      feed.captureReply(epoch, ["ABC"]);
      const held = new TextEncoder().encode("D");
      feed.delta(held);
      const fields = ["1", "0", "80", "24", ...Array(9).fill("0"), flag, "0", "2000"];
      const events = feed.cursorReply(epoch, fields.join(" "));
      expect(events.at(-2)).toEqual({ type: "delta", data: held });
      expect(events.at(-1)).toEqual({
        type: "cursor",
        x: 1,
        y: 0,
        historySize: 0,
        historyLimit: 2000,
        observedModes: {
          alternateScreen: false,
          cursorVisible: false,
          insert: false,
          applicationCursor: false,
          applicationKeypad: false,
        },
        ...(flag === "0" || flag === "1" ? { wraparound: flag === "1" } : {}),
      });
    },
  );
});

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

  it.each(["0", "10000", "", "-1", "1.5", "NaN", "9007199254740992"])(
    "carries only valid native history limits from the capture probe: %s",
    (value) => {
      const feed = new PaneFeed();
      const epoch = feed.beginReseed();
      feed.captureReply(epoch, ["screen"]);
      const events = feed.cursorReply(epoch, `0 0 80 24 0 1 0 0 0 0 0 0 0 1 12 ${value}`);
      const cursor = events.at(-1);
      expect(cursor).toEqual({
        type: "cursor",
        x: 0,
        y: 0,
        historySize: 12,
        wraparound: true,
        observedModes: {
          alternateScreen: false,
          cursorVisible: true,
          insert: false,
          applicationCursor: false,
          applicationKeypad: false,
        },
        ...(value === "0" || value === "10000" ? { historyLimit: Number(value) } : {}),
      });
    },
  );

  it.each(["0", "1", "", "unknown", "2"])(
    "carries only observed scroll-on-clear policy: %s",
    (value) => {
      const feed = new PaneFeed();
      const epoch = feed.beginReseed();
      feed.captureReply(epoch, ["screen"]);
      const cursor = feed
        .cursorReply(epoch, `0 0 80 24 0 1 0 0 0 0 0 0 0 1 12 2000 0 0 0 0 0 23 ${value}`)
        .at(-1);
      expect(cursor?.type).toBe("cursor");
      if (cursor?.type === "cursor") {
        if (value === "0" || value === "1")
          expect(cursor.observedModes?.scrollOnClear).toBe(value === "1");
        else expect(cursor.observedModes).not.toHaveProperty("scrollOnClear");
      }
    },
  );

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
