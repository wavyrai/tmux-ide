import { describe, expect, it } from "vitest";

import {
  WIDGET_MARKER_CONCEAL_PREFIX,
  WIDGET_MARKER_CONCEAL_SUFFIX,
  WIDGET_MARKER_MAX_PAYLOAD_CHARACTERS,
  WIDGET_MARKER_SENTINEL,
  WidgetMarkerTooLargeError,
  createWidgetMarkerByteWatcher,
  decodeWidgetMarkerLine,
  detectWidgetMarker,
  detectWidgetMarkerFromReplicaRows,
  encodeWidgetMarkerLine,
  widgetLogicalLines,
  widgetMarkerAnnouncement,
  widgetMarkerDigest,
  type WidgetCellRow,
} from "../pane-widget-marker.ts";

/** A row of ordinary text, padded out the way a real grid pads its rows. */
function row(text: string, options: { wrapped?: boolean; columns?: number } = {}): WidgetCellRow {
  const columns = options.columns ?? Math.max(text.length, 80);
  const cells = [...text];
  while (cells.length < columns) cells.push(" ");
  return { cells, wrapped: options.wrapped ?? false };
}

/** Split `text` across rows of `columns` cells, marking continuations wrapped. */
function wrappedRows(text: string, columns: number): WidgetCellRow[] {
  const characters = [...text];
  const rows: WidgetCellRow[] = [];
  for (let offset = 0; offset < characters.length; offset += columns) {
    const slice = characters.slice(offset, offset + columns);
    while (slice.length < columns) slice.push(" ");
    rows.push({ cells: slice, wrapped: offset > 0 });
  }
  return rows;
}

describe("widget marker grammar", () => {
  it("round-trips an id and its arguments", () => {
    const line = encodeWidgetMarkerLine("markdown", { text: "# Plan", title: "Plan" });
    expect(decodeWidgetMarkerLine(line)).toEqual({
      id: "markdown",
      args: { text: "# Plan", title: "Plan" },
    });
  });

  it("carries no whitespace or shell-significant characters in its payload", () => {
    const line = encodeWidgetMarkerLine("markdown", {
      text: "a b\tc\nd 'e' \"f\" $g `h` |i| >j< \\k\\",
    });
    const payload = line.split(" ")[2]!;
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  it("survives non-ASCII arguments byte for byte", () => {
    const text = "Ünïcode — emoji 👩‍👩‍👧‍👦, CJK 日本語, RTL עברית";
    const decoded = decodeWidgetMarkerLine(encodeWidgetMarkerLine("markdown", { text }));
    expect(decoded).toEqual({ id: "markdown", args: { text } });
  });

  it("encodes an argument-less marker without a payload", () => {
    expect(decodeWidgetMarkerLine(encodeWidgetMarkerLine("markdown"))).toEqual({
      id: "markdown",
      args: null,
    });
  });

  it("wraps the announcement in conceal so a plain terminal shows nothing", () => {
    const announcement = widgetMarkerAnnouncement("markdown", { text: "x" });
    // SGR 8 conceal on, SGR 0 off, and a newline so the marker owns its line.
    expect(announcement.startsWith(WIDGET_MARKER_CONCEAL_PREFIX)).toBe(true);
    expect(announcement.endsWith(`${WIDGET_MARKER_CONCEAL_SUFFIX}\n`)).toBe(true);
    expect(WIDGET_MARKER_CONCEAL_PREFIX).toBe("\u001b[8m");
  });

  it("refuses a payload over the marker ceiling rather than emitting a truncated one", () => {
    const oversized = "x".repeat(WIDGET_MARKER_MAX_PAYLOAD_CHARACTERS);
    expect(() => encodeWidgetMarkerLine("markdown", { text: oversized })).toThrow(
      WidgetMarkerTooLargeError,
    );
  });

  it("rejects an invalid widget id at encode time", () => {
    expect(() => encodeWidgetMarkerLine("Markdown")).toThrow();
    expect(() => encodeWidgetMarkerLine("../etc/passwd")).toThrow();
  });
});

/*
 * The collision surface.
 *
 * Every case here is a line ordinary output could plausibly contain. If any of
 * them decoded, a user running `cat`, `grep` or a test runner over a file that
 * mentions this feature would have their pane hijacked — which is the failure
 * the digest and the field count exist to make impossible.
 */
describe("widget marker near-misses", () => {
  const valid = encodeWidgetMarkerLine("markdown", { text: "hello" });

  it("ignores prose that merely mentions the sentinel", () => {
    expect(decodeWidgetMarkerLine(`The ${WIDGET_MARKER_SENTINEL} sentinel opts a pane in.`)).toBe(
      null,
    );
  });

  it("ignores the sentinel with a plausible but unsigned payload", () => {
    expect(decodeWidgetMarkerLine(`${WIDGET_MARKER_SENTINEL} markdown aGVsbG8 00000000`)).toBe(
      null,
    );
  });

  it("ignores a marker whose payload was edited after signing", () => {
    const [sentinel, id, payload, digest] = valid.split(" ");
    const tampered = `${sentinel} ${id} ${payload!.slice(0, -1)}A ${digest}`;
    expect(decodeWidgetMarkerLine(tampered)).toBe(null);
  });

  it("ignores a marker whose id was swapped for another widget's", () => {
    const [sentinel, , payload, digest] = valid.split(" ");
    expect(decodeWidgetMarkerLine(`${sentinel} image ${payload} ${digest}`)).toBe(null);
  });

  it("ignores extra fields appended to a valid marker", () => {
    expect(decodeWidgetMarkerLine(`${valid} extra`)).toBe(null);
  });

  it("ignores a valid marker quoted inside a longer line", () => {
    expect(decodeWidgetMarkerLine(`$ echo "${valid}"`)).toBe(null);
  });

  it("ignores a future grammar version", () => {
    expect(decodeWidgetMarkerLine(valid.replace("/1", "/2"))).toBe(null);
  });

  it("ignores a payload that is signed but is not JSON", () => {
    // Base64url of "not json at all", correctly digested: the last gate.
    const payload = "bm90IGpzb24gYXQgYWxs";
    const line = `${WIDGET_MARKER_SENTINEL} markdown ${payload} ${widgetMarkerDigest("markdown", payload)}`;
    expect(decodeWidgetMarkerLine(line)).toBe(null);
  });

  it("accepts a marker indented or padded by the surrounding output", () => {
    expect(decodeWidgetMarkerLine(`   ${valid}   `)).toEqual({
      id: "markdown",
      args: { text: "hello" },
    });
  });
});

describe("logical lines from cell rows", () => {
  it("joins wrapped rows back into the line that was printed", () => {
    const marker = encodeWidgetMarkerLine("markdown", { text: "a fairly long document body" });
    const rows = wrappedRows(marker, 24);
    expect(rows.length).toBeGreaterThan(1);
    expect(widgetLogicalLines(rows)).toEqual([marker]);
  });

  it("keeps unwrapped rows as separate lines", () => {
    expect(widgetLogicalLines([row("one"), row("two")])).toEqual(["one", "two"]);
  });

  it("drops the grid's trailing pad cells but keeps interior spaces", () => {
    expect(widgetLogicalLines([row("a  b", { columns: 40 })])).toEqual(["a  b"]);
  });

  /*
   * Rule 10, as a test. A cell can hold several UTF-16 units, and the trailing
   * half of a wide glyph is an EMPTY cell whose characters already belong to
   * the cell before it. Reassembling by cell reproduces the line; reassembling
   * by string offset would double every wide character.
   */
  it("reassembles rows containing wide and multi-unit cells", () => {
    const rows: WidgetCellRow[] = [
      { cells: ["日", "", "本", "", "語", "", "!"], wrapped: false },
      { cells: ["👩‍👩‍👧‍👦", "", " ", "o", "k"], wrapped: true },
    ];
    expect(widgetLogicalLines(rows)).toEqual(["日本語!👩‍👩‍👧‍👦 ok"]);
  });

  it("finds a marker that emoji pushed onto a second wrapped row", () => {
    const marker = encodeWidgetMarkerLine("markdown", { text: "ok" });
    const rows = [
      { cells: ["🎉", "", " ", "d", "o", "n", "e"], wrapped: false },
      ...wrappedRows(marker, 30),
    ];
    expect(detectWidgetMarker(rows)?.id).toBe("markdown");
  });
});

describe("detectWidgetMarker", () => {
  it("returns null for a pane of ordinary output", () => {
    expect(detectWidgetMarker([row("$ ls"), row("README.md  package.json"), row("$ ")])).toBe(null);
  });

  it("returns null for an empty pane", () => {
    expect(detectWidgetMarker([])).toBe(null);
  });

  it("finds a marker below ordinary scrollback", () => {
    const marker = encodeWidgetMarkerLine("markdown", { text: "# Title" });
    const found = detectWidgetMarker([row("$ tmux-ide widget markdown plan.md"), row(marker)]);
    expect(found).toEqual({ id: "markdown", args: { text: "# Title" }, lineIndex: 1 });
  });

  /*
   * Bug this catches: a pane that rendered one widget, then another, keeps
   * showing the first because detection stopped at the oldest match in
   * scrollback.
   */
  it("prefers the newest marker when a pane rendered more than one", () => {
    const first = encodeWidgetMarkerLine("markdown", { text: "first" });
    const second = encodeWidgetMarkerLine("markdown", { text: "second" });
    expect(detectWidgetMarker([row(first), row("$ "), row(second)])?.args).toEqual({
      text: "second",
    });
  });

  it("stops finding a marker once the screen has been cleared", () => {
    const marker = encodeWidgetMarkerLine("markdown", { text: "x" });
    expect(detectWidgetMarker([row(marker)])).not.toBe(null);
    // What a Ctrl-C trap leaves behind: a cleared grid and a fresh prompt.
    expect(detectWidgetMarker([row("$ ")])).toBe(null);
  });
});

describe("detectWidgetMarkerFromReplicaRows", () => {
  it("reads retained canonical cells directly, including wrapped multi-cell graphemes", () => {
    const marker = encodeWidgetMarkerLine("markdown", { text: "canonical" });
    const rows = wrappedRows(marker, 24).map((source) => ({
      wrapped: source.wrapped,
      cells: source.cells.map((grapheme) => ({ grapheme })),
    }));
    expect(detectWidgetMarkerFromReplicaRows(rows)).toEqual({
      id: "markdown",
      args: { text: "canonical" },
      lineIndex: 0,
    });
  });
});

/*
 * Truncation fails CLOSED.
 *
 * The marker can be longer than the pane's whole seed window, and the mirror
 * path reseeds from `capture-pane -S -2000`: a marker that has scrolled partly
 * out of that window comes back with its head missing. Every one of these must
 * read as ordinary terminal output. A widget rendered from half a payload is
 * strictly worse than no widget — the user loses the pane AND the text that was
 * in it, with nothing on screen saying why.
 */
describe("a truncated marker", () => {
  const marker = encodeWidgetMarkerLine("markdown", { text: "a document long enough to wrap" });

  it("fails closed when the seed window cut off its head", () => {
    const rows = wrappedRows(marker, 40);
    expect(rows.length).toBeGreaterThan(2);
    // What a reseed delivers when the marker started above the window: the
    // first surviving row is a continuation, and has nothing to continue.
    const survived = rows.slice(2);
    expect(survived[0]!.wrapped).toBe(true);
    expect(detectWidgetMarker(survived)).toBe(null);
  });

  it("fails closed when only its tail survives", () => {
    expect(detectWidgetMarker(wrappedRows(marker, 40).slice(-1))).toBe(null);
  });

  it("fails closed while it is still arriving", () => {
    // Mid-stream: the digest has not been written yet, so there is no fourth
    // field and nothing to verify the first three against.
    const partial = marker.slice(0, marker.length - 9);
    expect(decodeWidgetMarkerLine(partial)).toBe(null);
    expect(detectWidgetMarker(wrappedRows(partial, 40))).toBe(null);
  });

  it("fails closed on a digest that survived but a payload that did not", () => {
    const [sentinel, id, payload, digest] = marker.split(" ");
    const clipped = `${sentinel} ${id} ${payload!.slice(0, payload!.length - 200)} ${digest}`;
    expect(decodeWidgetMarkerLine(clipped)).toBe(null);
  });

  /*
   * The head-truncation case has one more shape worth naming: the survivor is a
   * base64url fragment, and base64url is a subset of the characters a marker's
   * own fields use. It must not be mistaken for a marker even so.
   */
  it("does not mistake a surviving payload fragment for a marker of its own", () => {
    const payload = marker.split(" ")[2]!;
    expect(decodeWidgetMarkerLine(payload.slice(500, 900))).toBe(null);
  });
});

describe("the byte watcher that gates the scan", () => {
  const encoder = new TextEncoder();

  it("fires on the sentinel and stays quiet on ordinary output", () => {
    const watcher = createWidgetMarkerByteWatcher();
    expect(watcher.observe(encoder.encode("$ pnpm test\nok\n"))).toBe(false);
    expect(
      watcher.observe(encoder.encode(widgetMarkerAnnouncement("markdown", { text: "x" }))),
    ).toBe(true);
  });

  /*
   * Bug this catches: the transport splits the marker across two frames — which
   * it is free to do at any byte — and the pane silently never becomes a widget
   * for exactly the users whose output is large enough to be chunked.
   */
  it("fires when the sentinel is split across two chunks", () => {
    const watcher = createWidgetMarkerByteWatcher();
    const line = widgetMarkerAnnouncement("markdown", { text: "x" });
    const split = 12;
    expect(watcher.observe(encoder.encode(line.slice(0, split)))).toBe(false);
    expect(watcher.observe(encoder.encode(line.slice(split)))).toBe(true);
  });

  it("survives a multi-byte character straddling a chunk boundary", () => {
    const watcher = createWidgetMarkerByteWatcher();
    const bytes = encoder.encode("日本語 output");
    expect(() => {
      watcher.observe(bytes.subarray(0, 2));
      watcher.observe(bytes.subarray(2));
    }).not.toThrow();
  });
});
