/* @jsxImportSource @opentui/solid */
import { it, expect } from "bun:test";
import { CliRenderEvents } from "@opentui/core";
import {
  literalStyledFrame,
  readCompletedFrame,
  compareVisual,
  type CompletedFrame,
} from "./styled-frame-oracle.ts";
import { registerPaneSurface, type TerminalPaneRenderSource } from "../pane-surface.tsx";
import { blitSemanticRow } from "../semantic-pane-render-source.ts";
import { createSemanticThemeSnapshot, createTerminalPaletteProjection } from "../theme.ts";
import { renderForTest, destroyTestRenderer } from "./renderer-harness.test.ts";

it.each(["BEFORE_SSH", "AFTER_SSH_RECOVERY"])(
  "reads completed physical cells independently for %s",
  async (marker) => {
    registerPaneSurface();
    const expected = literalStyledFrame(marker);
    const palette = createTerminalPaletteProjection(createSemanticThemeSnapshot({ mode: "dark" }));
    const mirror: TerminalPaneRenderSource = {
      scrollbackDepth: () => 0,
      cursorState: () => ({ x: 4, y: 2, hidden: false, style: "block", blink: false }),
      blitPane: (_id, b, w, h, _offset, _fg, _bg, options) => {
        for (let y = 0; y < h; y++) {
          const row = {
            wrapped: false,
            cells: expected.cells[y]!.map((c) => ({
              grapheme: c.text,
              width: c.width as 0 | 1 | 2,
              foreground: { kind: "rgb" as const, value: parseInt(c.fg, 16) },
              background: { kind: "rgb" as const, value: parseInt(c.bg, 16) },
              attributes: c.bold ? 1 : 0,
            })),
          };
          blitSemanticRow(row, b, y, w, 0xffffff, 0, options.graphemes, options.palette);
          options.dirtyRows.push(y);
        }
        return null;
      },
    };
    const setup = await renderForTest(
      () => (
        <pane_surface
          width={40}
          height={8}
          mirror={mirror}
          paneId="oracle"
          paneFocused={true}
          contentVersion={1}
          defaultFg={0xffffff}
          defaultBg={0}
          terminalPalette={palette}
          searchHl={palette.searchHighlight}
          searchCur={palette.searchCurrent}
        />
      ),
      { width: 40, height: 8, consoleMode: "disabled" },
    );
    let captured: CompletedFrame | undefined;
    const record = () => {
      const b = setup.renderer.currentRenderBuffer;
      const v = b.buffers;
      const c = setup.renderer.getCursorState();
      captured = {
        cols: b.width,
        rows: b.height,
        char: [...v.char],
        fg: [...v.fg],
        bg: [...v.bg],
        attributes: [...v.attributes],
        text: setup.captureCharFrame(),
        cursor: { x: c.x, y: c.y, visible: c.visible },
      };
    };
    setup.renderer.on(CliRenderEvents.FRAME, record);
    try {
      await setup.renderOnce();
      expect(captured).toBeDefined();
      const actual = readCompletedFrame(captured!);
      compareVisual(actual, expected);
      for (const field of ["text", "width", "fg", "bg", "bold"] as const) {
        const wrong = structuredClone(actual);
        const c = wrong.cells[1]![1]!;
        if (field === "text") c.text = "?";
        else if (field === "width") c.width = 9;
        else if (field === "bold") c.bold = !c.bold;
        else c[field] = "fedcba";
        expect(() => compareVisual(wrong, expected)).toThrow(field);
      }
      const tail = structuredClone(actual);
      tail.cells[3]![39]!.bg = "000000";
      expect(() => compareVisual(tail, expected)).toThrow("bg");
      const cursor = structuredClone(actual);
      cursor.cursor.x++;
      expect(() => compareVisual(cursor, expected)).toThrow("cursor");
      const wrongChar = structuredClone(captured!);
      wrongChar.char[0] = 0x3f;
      expect(() => readCompletedFrame(wrongChar)).toThrow("codepoint");
      const image = structuredClone(captured!);
      image.char[0] = 0x40000001;
      expect(() => readCompletedFrame(image)).toThrow("flags");
      const intern = structuredClone(captured!);
      intern.char[43] = (intern.char[43]! | 0x10000000) >>> 0;
      expect(() => readCompletedFrame(intern)).toThrow("grapheme");
      if (marker === "BEFORE_SSH") {
        const continuation = structuredClone(captured!);
        continuation.char[42] = 0x20;
        expect(() => readCompletedFrame(continuation)).toThrow("width");
      }
      expect(() => readCompletedFrame({ ...captured!, char: [] })).toThrow("lengths");
    } finally {
      setup.renderer.off(CliRenderEvents.FRAME, record);
      destroyTestRenderer(setup);
    }
  },
);

it("keeps native geometry selection explicit and rejects malformed expanded cells", async () => {
  const { readPhysicalFrame } =
    await import("../../../terminal/mirror/__tests__/native-physical-cell-oracle.ts");
  const header = {
    version: 2,
    cols: 40,
    rows: 8,
    history: 0,
    hscrolled: 0,
    limit: 2000,
    cursor: [4, 2],
    currentAttributes: [0, 8, 8, 8],
  };
  const rows = Array.from({ length: 8 }, (_, row) => ({
    row,
    flags: 0,
    used: 0,
    cells: [] as unknown[],
  }));
  const raw = () => [header, ...rows].map((x) => JSON.stringify(x)).join("\n");
  expect(() => readPhysicalFrame(raw())).toThrow("geometry");
  expect(readPhysicalFrame(raw(), "styled-reconnect").cells).toHaveLength(8);
  header.cols = 39;
  expect(() => readPhysicalFrame(raw(), "styled-reconnect")).toThrow("geometry");
  header.cols = 40;
  header.history = 4;
  rows.forEach((row, i) => (row.row = i + 4));
  expect(readPhysicalFrame(raw(), "styled-reconnect").history).toBe(4);
  expect(() => readPhysicalFrame(raw())).toThrow("geometry");
  rows[0]!.row = 0;
  expect(() => readPhysicalFrame(raw(), "styled-reconnect")).toThrow("row");
  rows[0]!.row = 4;
  expect(() =>
    readPhysicalFrame(
      [header, ...rows.slice(1)].map((x) => JSON.stringify(x)).join("\n"),
      "styled-reconnect",
    ),
  ).toThrow("geometry");
  expect(() =>
    readPhysicalFrame(
      [{ ...header, cols: 8, rows: 4 }, ...rows.slice(0, 4)]
        .map((x) => JSON.stringify(x))
        .join("\n"),
    ),
  ).toThrow("geometry");
  expect(() =>
    readPhysicalFrame(
      [header, ...rows, rows[7]].map((x) => JSON.stringify(x)).join("\n"),
      "styled-reconnect",
    ),
  ).toThrow("geometry");
  expect(() =>
    readPhysicalFrame(
      [header, rows[1], rows[0], ...rows.slice(2)].map((x) => JSON.stringify(x)).join("\n"),
      "styled-reconnect",
    ),
  ).toThrow("row");
  rows[0]!.used = 1;
  expect(() => readPhysicalFrame(raw(), "styled-reconnect")).toThrow("row used");
  rows[0]!.used = 0;
  rows[0]!.cells = [[0, 1, "58", 0, "8", 8, 8, 0, 0]];
  expect(() => readPhysicalFrame(raw(), "styled-reconnect")).toThrow("color");
});
