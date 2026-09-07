/* @jsxImportSource @opentui/solid */
import { expect, it } from "bun:test";
import { createSignal } from "solid-js";
import { blankTerminalReplicaSnapshot } from "@tmux-ide/core";
import type { TerminalReplicaSnapshot } from "@tmux-ide/contracts";
import { reflowRetainedTerminalSnapshot } from "./terminal-viewport.ts";
import { extractTerminalCopySelection } from "./runtime/terminal-copy-selection.ts";
import type {
  NativeGridCaptureCell,
  NativeGridCaptureRow,
} from "../../terminal/mirror/native-grid-capture.ts";
import { projectNativeGridRow } from "../../terminal/mirror/native-grid-projection.ts";
import { registerPaneSurface, type TerminalPaneRenderSource } from "./pane-surface.tsx";
import { blitSemanticRow } from "./semantic-pane-render-source.ts";
import { installTuiPerformanceEventSink } from "./performance-events.ts";
import { createSemanticThemeSnapshot, createTerminalPaletteProjection } from "./theme.ts";
import { frameLines, renderForTest } from "./testing/renderer-harness.test.ts";

const cell = (text: string, width = 1, flags = 0): NativeGridCaptureCell => ({
  text,
  width,
  flags,
  bytesHex: Buffer.from(text).toString("hex"),
  attributes: 0,
  foreground: 8,
  background: 8,
  underline: 8,
  link: 0,
  storageFlags: flags,
});

it("paints native projection through PaneSurface without stale tails or lost clipped backing", async () => {
  registerPaneSurface();
  const original: NativeGridCaptureRow = {
    flags: 0,
    cells: [cell("界", 2), cell("!", 1, 4), cell("é"), cell("Z")],
  };
  const serialized = JSON.stringify(original);
  let backing = original;
  let origin = 0;
  let onlyBottomRowDirty = false;
  let retainedPaint: TerminalReplicaSnapshot | null = null;
  const mirror: TerminalPaneRenderSource = {
    scrollbackDepth: () => 0,
    cursorState: () => null,
    paneCanonicalIdentity: () => ({
      generation: "test-generation",
      incarnation: "test-incarnation",
      revision: 0,
      stateHash: "test-hash",
      cols: 4,
      rows: 2,
      sourceEpoch: 0,
    }),
    blitPane: (_id, buffers, width, height, _offset, fg, bg, options) => {
      for (let y = 0; y < height; y += 1) {
        if (onlyBottomRowDirty && !options.full && y === 0) continue;
        const row = retainedPaint
          ? [...retainedPaint.history, ...retainedPaint.grid][y]
          : projectNativeGridRow(y === 0 ? backing : undefined, width, origin);
        if (row === null) throw new Error("invalid test projection");
        blitSemanticRow(row, buffers, y, width, fg, bg, options.graphemes, options.palette);
        options.dirtyRows.push(y);
      }
      return null;
    },
  };
  const palette = createTerminalPaletteProjection(createSemanticThemeSnapshot({ mode: "dark" }));
  let resize!: (width: number) => void;
  let repaint!: () => void;
  const setup = await renderForTest(
    () => {
      const [width, setWidth] = createSignal(4);
      const [version, setVersion] = createSignal(0);
      resize = setWidth;
      repaint = () => setVersion((value) => value + 1);
      return (
        <box width={6} height={2} flexDirection="row">
          <pane_surface
            width={width()}
            height={2}
            mirror={mirror}
            paneId="pane.native"
            defaultFg={palette.foreground}
            defaultBg={palette.background}
            terminalPalette={palette}
            searchHl={palette.searchHighlight}
            searchCur={palette.searchCurrent}
            contentVersion={version()}
          />
          <text width={1} height={1}>
            |
          </text>
        </box>
      );
    },
    { width: 6, height: 2 },
  );
  const painted = async () => {
    await setup.renderOnce();
    // The byte capture represents the direct wide-cell spacer as a space.
    // It resolves interned graphemes, unlike captureSpans' code-point indexing.
    return frameLines(setup.captureCharFrame());
  };
  let projection: Array<{ chars: string; width: number; column: number }> = [];
  let projectionCount = 0;
  const uninstall = installTuiPerformanceEventSink({
    frame: () => {},
    terminalPaint: () => {},
    terminalDelivery: () => {},
    terminalFramebufferProjection: (event) => {
      projectionCount++;
      projection = JSON.parse(event.projection);
    },
  });
  try {
    expect(await painted()).toEqual(["界 éZ| ", "      "]);
    resize(1);
    expect(await painted()).toEqual([" |    ", "      "]);
    resize(4);
    expect(await painted()).toEqual(["界 éZ| ", "      "]);
    // A horizontal viewport beginning inside the wide owner must blank its
    // continuation without shifting the following combining character.
    origin = 1;
    repaint();
    expect(await painted()).toEqual([" éZ | ", "      "]);
    // Reuse the same framebuffer after a shorter row arrives. Neither the
    // previous wide glyph, combining override nor tail may remain visible.
    origin = 0;
    backing = { flags: 0, cells: [cell("!", 1, 4), cell("Q")] };
    repaint();
    expect(await painted()).toEqual([" Q  | ", "      "]);
    backing = { flags: 0, cells: [cell("👩‍💻", 2), cell("!", 1, 4), cell("X")] };
    repaint();
    expect(await painted()).toEqual(["👩‍💻X | ", "      "]);
    expect(projection.map(({ chars, width, column }) => [chars, width, column])).toEqual([
      ["👩‍💻", 2, 0],
      ["", 0, 1],
      ["X", 1, 2],
    ]);
    onlyBottomRowDirty = true;
    const beforePartialPaint = projectionCount;
    repaint();
    expect(await painted()).toEqual(["👩‍💻X | ", "      "]);
    expect(projectionCount).toBe(beforePartialPaint + 1);
    expect(projection[0]?.chars).toBe("👩‍💻");
    onlyBottomRowDirty = false;
    backing = original;
    repaint();
    expect(await painted()).toEqual(["界 éZ| ", "      "]);
    expect(projection.map(({ chars }) => chars)).toEqual(["界", "", "é", "Z"]);
    const frozenSource = {
      ...blankTerminalReplicaSnapshot(4, 1),
      grid: [projectNativeGridRow(original, 4)!],
    };
    retainedPaint = reflowRetainedTerminalSnapshot(frozenSource, 1, 2)!;
    resize(1);
    repaint();
    expect(await painted()).toEqual([" |    ", "é     "]);
    expect(
      extractTerminalCopySelection(retainedPaint, { row: 0, col: 0 }, { row: 2, col: 1 }, "emacs")
        ?.text,
    ).toBe("界éZ");
    retainedPaint = reflowRetainedTerminalSnapshot(retainedPaint, 4, 1)!;
    resize(4);
    repaint();
    expect(await painted()).toEqual(["界 éZ| ", "      "]);
    expect(retainedPaint.grid).toEqual(frozenSource.grid);
    expect(JSON.stringify(original)).toBe(serialized);
  } finally {
    uninstall();
    setup.renderer.destroy();
  }
});
