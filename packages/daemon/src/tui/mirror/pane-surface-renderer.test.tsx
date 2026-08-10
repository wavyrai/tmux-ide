/* @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test";
import { createSignal } from "solid-js";
import type { BlitOptions } from "./pane-mirror.ts";
import { registerPaneSurface, type PaneSurfaceOptions } from "./pane-surface.tsx";
import type { SessionMirror } from "./session-mirror.ts";
import { createSemanticThemeSnapshot, createTerminalPaletteProjection } from "./theme.ts";
import { renderForTest } from "./testing/renderer-harness.test.ts";

describe("PaneSurface OpenTUI renderer", () => {
  it("repaints only the cursor-marker row when focus changes", async () => {
    registerPaneSurface();
    const blits: Array<Pick<BlitOptions, "full" | "forceRows">> = [];
    const mirror = {
      scrollbackDepth: () => 0,
      cursorState: () => ({
        x: 2,
        y: 2,
        hidden: false,
        style: "block" as const,
        blink: false,
      }),
      blitPane: (
        _id: string,
        _buffers: unknown,
        _width: number,
        _height: number,
        _scrollOffset: number,
        _defaultFg: number,
        _defaultBg: number,
        options: BlitOptions,
      ) => {
        blits.push({ full: options.full, forceRows: options.forceRows });
      },
    } as unknown as SessionMirror;
    const palette = createTerminalPaletteProjection(createSemanticThemeSnapshot({ mode: "dark" }));
    let setFocused!: (focused: boolean) => void;
    const setup = await renderForTest(
      () => {
        const [focused, setFocusedSignal] = createSignal(true);
        setFocused = setFocusedSignal;
        return (
          <pane_surface
            width={10}
            height={5}
            mirror={mirror}
            paneId="%1"
            defaultFg={palette.foreground}
            defaultBg={palette.background}
            terminalPalette={palette}
            searchHl={palette.searchHighlight}
            searchCur={palette.searchCurrent}
            scrollOffset={0}
            paneFocused={focused()}
            contentVersion={1}
            selRange={null}
            search={null}
          />
        );
      },
      { width: 10, height: 5 },
    );

    await setup.renderOnce();
    expect(blits.at(-1)?.full).toBe(true);

    blits.length = 0;
    setFocused(false);
    await setup.renderOnce();
    expect(blits).toEqual([{ full: false, forceRows: [2] }]);

    blits.length = 0;
    setFocused(true);
    await setup.renderOnce();
    expect(blits).toEqual([{ full: false, forceRows: [2] }]);
  });
});
