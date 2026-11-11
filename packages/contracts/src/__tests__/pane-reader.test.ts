import { describe, expect, it } from "vitest";
import {
  PaneReaderResponseSchemaZ,
  PaneStreamLayoutFrameSchemaZ,
  hasControlCharacter,
} from "../index.ts";

const C1 = ["\u0080", "\u0085", "\u009b", "\u009f"];

describe("reader names and folders (#353 round 2)", () => {
  it("treat C0, DEL and C1 as control characters, the app's rule", () => {
    for (const control of ["\u0000", "\u001f", "\u007f", ...C1])
      expect(hasControlCharacter(`a${control}b`), JSON.stringify(control)).toBe(true);
    for (const plain of ["notes.md", "Ünïcödé.md", " nbsp.md", "日本.md"])
      expect(hasControlCharacter(plain), plain).toBe(false);
  });
  it("refuse a C1 name or folder in a reader response", () => {
    const ok = { version: 1, state: "missing", name: "notes.md", folder: "docs" } as const;
    expect(PaneReaderResponseSchemaZ.safeParse(ok).success).toBe(true);
    for (const control of C1) {
      expect(PaneReaderResponseSchemaZ.safeParse({ ...ok, name: `a${control}.md` }).success).toBe(
        false,
      );
      expect(PaneReaderResponseSchemaZ.safeParse({ ...ok, folder: `d${control}` }).success).toBe(
        false,
      );
    }
  });
  it("refuse a C1 reader badge in a layout pane", () => {
    const layout = (name: string) => ({
      type: "layout",
      semanticWindowId: "window-a",
      windowName: "w",
      currentWindow: true,
      cols: 80,
      rows: 24,
      zoomed: false,
      panes: [
        {
          pane: "pane-a",
          reader: { name },
          left: 0,
          top: 0,
          width: 80,
          height: 24,
          active: true,
        },
      ],
    });
    expect(PaneStreamLayoutFrameSchemaZ.safeParse(layout("notes.md")).success).toBe(true);
    for (const control of C1)
      expect(PaneStreamLayoutFrameSchemaZ.safeParse(layout(`a${control}.md`)).success).toBe(false);
  });
});
