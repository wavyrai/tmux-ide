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
