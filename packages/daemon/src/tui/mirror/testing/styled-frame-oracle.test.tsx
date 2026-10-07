/* @jsxImportSource @opentui/solid */
import { it, expect } from "bun:test";
import { createSignal, createMemo, Show } from "solid-js";
import { ApplicationTerminalWorkspace } from "../runtime/application-terminal-workspace.tsx";
import type { PaneScopedTerminalAdapter } from "../runtime/pane-scoped-terminal-surface.tsx";
import { CliRenderEvents } from "@opentui/core";
import {
  literalStyledFrame,
  cropWorkspaceCompletedFrame,
  readCompletedFrame,
  compareVisual,
  type CompletedFrame,
} from "./styled-frame-oracle.ts";
import { registerPaneSurface, type TerminalPaneRenderSource } from "../pane-surface.tsx";
import { blitSemanticRow } from "../semantic-pane-render-source.ts";
import { createSemanticThemeSnapshot, createTerminalPaletteProjection } from "../theme.ts";
import { renderForTest, destroyTestRenderer } from "./renderer-harness.test.ts";

it.each([
  ["BEFORE_SSH", 40],
  ["AFTER_SSH_RECOVERY", 40],
  ["RESIZE_NARROW", 24],
  ["WORKSPACE_CROP", 40],
] as const)("reads completed physical cells independently for %s", async (marker, cols) => {
  registerPaneSurface();
  const expected = literalStyledFrame(marker, cols);
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
  const chrome = marker === "WORKSPACE_CROP";
  const setup = await renderForTest(
    () => (
      <>
        {chrome && (
          <>
            <text position="absolute" top={0}>
              TAB_CHROME
            </text>
            <text position="absolute" top={1}>
              TITLE_CHROME
            </text>
          </>
        )}
        <box position="absolute" top={chrome ? 2 : 0} width={cols} height={8}>
          <pane_surface
            width={cols}
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
        </box>
      </>
    ),
    { width: cols, height: chrome ? 10 : 8, consoleMode: "disabled" },
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
    if (chrome) {
      const full = captured!;
      expect(full.rows).toBe(10);
      expect(full.text.split("\n")[0]).toContain("TAB_CHROME");
      expect(full.text.split("\n")[1]).toContain("TITLE_CHROME");
      expect(full.cursor.y).toBe(5);
      expect(() => cropWorkspaceCompletedFrame({ ...full, rows: 9 })).toThrow("geometry");
      expect(() => cropWorkspaceCompletedFrame({ ...full, char: full.char.slice(1) })).toThrow(
        "lengths",
      );
      expect(() =>
        cropWorkspaceCompletedFrame({ ...full, cursor: { ...full.cursor, y: 1 } }),
      ).toThrow("cursor");
      const bad = structuredClone(full);
      bad.char[2 * cols] = 0x3f;
      expect(() => readCompletedFrame(cropWorkspaceCompletedFrame(bad))).toThrow("codepoint");
      const shifted = {
        ...full,
        text: full.text.split("\n").slice(1).concat(" ".repeat(cols)).join("\n"),
      };
      expect(() => readCompletedFrame(cropWorkspaceCompletedFrame(shifted))).toThrow();
      captured = cropWorkspaceCompletedFrame(full);
    }
    const actual = readCompletedFrame(captured!);
    expect(() => compareVisual(actual, literalStyledFrame(marker, cols === 24 ? 40 : 24))).toThrow(
      "cols",
    );
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
    tail.cells[3]![cols - 1]!.bg = "000000";
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
    intern.char[cols + 3] = (intern.char[cols + 3]! | 0x10000000) >>> 0;
    expect(() => readCompletedFrame(intern)).toThrow("grapheme");
    if (marker === "BEFORE_SSH") {
      const continuation = structuredClone(captured!);
      continuation.char[cols + 2] = 0x20;
      expect(() => readCompletedFrame(continuation)).toThrow("width");
    }
    expect(() => readCompletedFrame({ ...captured!, char: [] })).toThrow("lengths");
  } finally {
    setup.renderer.off(CliRenderEvents.FRAME, record);
    destroyTestRenderer(setup);
  }
});

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
  header.cols = 24;
  expect(readPhysicalFrame(raw(), "styled-reconnect-narrow").cols).toBe(24);
  expect(() => readPhysicalFrame(raw(), "styled-reconnect")).toThrow("geometry");
  header.cols = 39;
  expect(() => readPhysicalFrame(raw(), "styled-reconnect-narrow")).toThrow("geometry");
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

it("replaces workspace subscriptions only at generation change and accepts later new-source output", async () => {
  registerPaneSurface();
  const theme = createSemanticThemeSnapshot({ mode: "dark" }),
    palette = { ...createTerminalPaletteProjection(theme), foreground: 0xffffff, background: 0 };
  const makeAdapter = (initial: string) => {
    let marker = initial,
      version = 1,
      subscriptions = 0,
      disposals = 0;
    const listeners = new Set<(...args: [number, number, number, "content"]) => void>();
    const adapter: PaneScopedTerminalAdapter = {
      paneVersion: () => version,
      paneSourceEpoch: () => 0,
      paneSelectionSnapshot: () => null,
      subscribePaneVersion: (_id, fn) => {
        subscriptions++;
        listeners.add(fn);
        return () => {
          disposals++;
          listeners.delete(fn);
        };
      },
      renderSource: {
        scrollbackDepth: () => 0,
        cursorState: () => ({ x: 4, y: 2, hidden: false, style: "block", blink: false }),
        blitPane: (_id, b, w, h, _scroll, _fg, _bg, options) => {
          const expected = literalStyledFrame(marker);
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
      },
    };
    return {
      adapter,
      publish(next: string) {
        marker = next;
        version++;
        for (const fn of listeners) fn(version, 0, version, "content");
      },
      counts: () => ({ subscriptions, disposals, listeners: listeners.size }),
    };
  };
  const a = makeAdapter("BEFORE_SSH"),
    b = makeAdapter("SECOND_GENERATION");
  const [source, setSource] = createSignal({ adapter: a.adapter, rendererEpoch: 1 });
  const stable = createMemo(source, undefined, {
    equals: (a, b) => a?.adapter === b.adapter && a?.rendererEpoch === b.rendererEpoch,
  });
  const current = {
    type: "layout" as const,
    semanticWindowId: "window.main",
    windowName: "main",
    currentWindow: true,
    cols: 40,
    rows: 9,
    zoomed: false,
    paneBorderStatus: "top" as const,
    panes: [{ pane: "oracle", left: 0, top: 1, width: 40, height: 8, active: true }],
  };
  const layout = () => ({ current, windows: [current] });
  const setup = await renderForTest(
    () => (
      <Show when={stable()} keyed>
        {(value) => (
          <ApplicationTerminalWorkspace
            layout={layout}
            adapter={value.adapter}
            rendererEpoch={value.rendererEpoch}
            width={40}
            height={9}
            topOffset={1}
            focusedPane="oracle"
            theme={theme}
            palette={palette}
            onSelectPane={() => {}}
          />
        )}
      </Show>
    ),
    { width: 40, height: 10, consoleMode: "disabled" },
  );
  let frame: CompletedFrame | undefined;
  const record = () => {
    const buffer = setup.renderer.currentRenderBuffer,
      v = buffer.buffers,
      c = setup.renderer.getCursorState();
    frame = {
      cols: buffer.width,
      rows: buffer.height,
      char: [...v.char],
      fg: [...v.fg],
      bg: [...v.bg],
      attributes: [...v.attributes],
      text: setup.captureCharFrame(),
      cursor: { x: c.x, y: c.y, visible: c.visible },
    };
  };
  setup.renderer.on(CliRenderEvents.FRAME, record);
  const checkFrame = async (marker: string) => {
    await setup.renderOnce();
    expect(frame).toBeDefined();
    compareVisual(
      readCompletedFrame(cropWorkspaceCompletedFrame(frame!)),
      literalStyledFrame(marker),
    );
  };
  try {
    await checkFrame("BEFORE_SSH");
    expect(a.counts().listeners).toBe(1);
    setSource({ adapter: b.adapter, rendererEpoch: 2 });
    await checkFrame("SECOND_GENERATION");
    expect(a.counts().listeners).toBe(0);
    expect(a.counts().disposals).toBe(1);
    expect(b.counts().listeners).toBe(1);
    a.publish("STALE_OLD_SOURCE");
    await checkFrame("SECOND_GENERATION");
    b.publish("LATER_NEW_SOURCE");
    await checkFrame("LATER_NEW_SOURCE");
    expect(b.counts().subscriptions).toBe(1);
    setSource({ adapter: b.adapter, rendererEpoch: 2 });
    await checkFrame("LATER_NEW_SOURCE");
    expect(b.counts().subscriptions).toBe(1);
  } finally {
    setup.renderer.off(CliRenderEvents.FRAME, record);
    destroyTestRenderer(setup);
  }
  expect(b.counts().listeners).toBe(0);
});
