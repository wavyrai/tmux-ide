import { describe, it, expect } from "vitest";
import { PaneMirror } from "./pane-mirror.ts";

/** xterm parses writes on its own write-buffer flush (a timer), so poll the
 *  mirror until the content lands (the real app reads on a 16ms render tick). */
async function flushed(m: PaneMirror, needle: string): Promise<string[]> {
  for (let i = 0; i < 50; i++) {
    const buf = m.bufferLines();
    if (buf.some((l) => l.includes(needle))) return buf;
    await new Promise((r) => setTimeout(r, 5));
  }
  return m.bufferLines();
}

describe("PaneMirror.bufferLines", () => {
  it("returns the whole buffer (scrollback + viewport) as plain lines", async () => {
    const m = new PaneMirror(20, 4);
    // Write more lines than the viewport height so some fall into scrollback.
    const lines = ["one", "two MARKER", "three", "four", "five", "six MARKER"];
    m.write(lines.join("\r\n"));
    const buf = await flushed(m, "six MARKER");
    // Every written line is present, in order, incl. the ones scrolled off.
    expect(buf).toContain("one");
    expect(buf).toContain("two MARKER");
    expect(buf).toContain("six MARKER");
    // Scrollback depth > 0 proves lines went above the live viewport.
    expect(m.scrollbackDepth()).toBeGreaterThan(0);
    m.dispose();
  });

  it("trims trailing blanks so a match column aligns with the rendered row", async () => {
    const m = new PaneMirror(20, 3);
    m.write("hello");
    const buf = await flushed(m, "hello");
    expect(buf.some((l) => l === "hello")).toBe(true);
    m.dispose();
  });
});

function arrays(w: number, h: number) {
  return {
    char: new Uint32Array(w * h),
    fg: new Uint16Array(w * h * 4),
    bg: new Uint16Array(w * h * 4),
    attributes: new Uint32Array(w * h),
  };
}

/** Blit and return the rows written this call. */
function blit(
  m: PaneMirror,
  buffers: ReturnType<typeof arrays>,
  w: number,
  h: number,
  full = false,
): number[] {
  const dirtyRows: number[] = [];
  m.blit(buffers, w, h, 0, 0xd4d4d8, 0x101016, { full, dirtyRows });
  return dirtyRows;
}

describe("PaneMirror.blit — incremental (M21.4)", () => {
  it("bumps contentVersion on writes and holds it steady when idle", async () => {
    const m = new PaneMirror(20, 4);
    const v0 = m.contentVersion();
    m.write("hello");
    await flushed(m, "hello");
    expect(m.contentVersion()).toBeGreaterThan(v0);
    const v1 = m.contentVersion();
    await new Promise((r) => setTimeout(r, 20));
    expect(m.contentVersion()).toBe(v1); // no writes → no bump
    m.dispose();
  });

  it("first blit paints every row; an unchanged re-blit writes nothing", async () => {
    const W = 20,
      H = 5;
    const m = new PaneMirror(W, H);
    m.write("A\r\nB\r\nC");
    await flushed(m, "C");
    const buffers = arrays(W, H);
    expect(blit(m, buffers, W, H, true).length).toBe(H); // full
    expect(blit(m, buffers, W, H, false)).toEqual([]); // nothing changed
    m.dispose();
  });

  it("an in-place change repaints only the changed row", async () => {
    const W = 20,
      H = 5;
    const m = new PaneMirror(W, H);
    m.write("A\r\nB\r\nC");
    await flushed(m, "C");
    const buffers = arrays(W, H);
    blit(m, buffers, W, H, true);
    // Cursor-address row 2 (1-indexed) and overwrite it — no scroll.
    m.write("\x1b[2;1HZZZ");
    await flushed(m, "ZZZ");
    expect(blit(m, buffers, W, H, false)).toEqual([1]);
    m.dispose();
  });

  it("a scroll repaints only the newly exposed bottom row", async () => {
    const W = 20,
      H = 5;
    const m = new PaneMirror(W, H);
    m.write("A\r\nB\r\nC\r\nD\r\nE"); // fills the viewport exactly
    await flushed(m, "E");
    const buffers = arrays(W, H);
    blit(m, buffers, W, H, true);
    m.write("\r\nF"); // scroll: A → scrollback, F at the bottom
    await flushed(m, "F");
    expect(blit(m, buffers, W, H, false)).toEqual([H - 1]);
    m.dispose();
  });

  it("forceRows repaints extra rows even when their content is unchanged", async () => {
    const W = 20,
      H = 5;
    const m = new PaneMirror(W, H);
    m.write("A\r\nB\r\nC");
    await flushed(m, "C");
    const buffers = arrays(W, H);
    blit(m, buffers, W, H, true);
    const dirtyRows: number[] = [];
    m.blit(buffers, W, H, 0, 0xd4d4d8, 0x101016, { full: false, forceRows: [2], dirtyRows });
    expect(dirtyRows).toEqual([2]);
    m.dispose();
  });

  it("a mismatched-length row is bounds-guarded: always dirty, never RangeError (D5)", async () => {
    const W = 10,
      H = 4;
    const m = new PaneMirror(W, H);
    m.write("A\r\nB\r\nC\r\nD");
    await flushed(m, "D");
    const buffers = arrays(W, H);
    blit(m, buffers, W, H, true);
    // Force the xterm internal into the post-shrink shape the guard exists for:
    // a line whose raw cell data is NOT cols×3 u32 long. Writing it into the
    // rowLen-strided shadow used to throw RangeError (measured after rapid
    // shrinks over wrapped content).
    const line = m["term"].buffer.active.getLine(1) as unknown as {
      _line: { _data: Uint32Array };
    };
    line._line._data = new Uint32Array(W * 3 + 6); // longer than the stride
    expect(() => blit(m, buffers, W, H, false)).not.toThrow();
    // Shadow-less rows repaint every walk — the guarded row stays dirty.
    expect(blit(m, buffers, W, H, false)).toContain(1);
    expect(blit(m, buffers, W, H, false)).toContain(1);
    m.dispose();
  });
});
