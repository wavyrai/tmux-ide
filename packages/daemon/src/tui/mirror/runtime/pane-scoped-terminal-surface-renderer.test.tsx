/* @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test";

import { registerPaneSurface, type TerminalPaneRenderSource } from "../pane-surface.tsx";
import { createSemanticThemeSnapshot, createTerminalPaletteProjection } from "../theme.ts";
import { renderForTest } from "../testing/renderer-harness.test.ts";
import { PaneScopedTerminalOwner } from "./pane-scoped-terminal-owner.ts";
import {
  PaneScopedTerminalSurface,
  type PaneScopedTerminalAdapter,
} from "./pane-scoped-terminal-surface.tsx";

describe("PaneScopedTerminalSurface", () => {
  it("invalidates only the addressed pane and leaves sibling/shell presentation resident", async () => {
    registerPaneSurface();
    const owner = new PaneScopedTerminalOwner();
    const generation = owner.beginGeneration();
    const blits: string[] = [];
    const renderSource: TerminalPaneRenderSource = {
      scrollbackDepth: () => 0,
      cursorState: () => null,
      blitPane: (paneId, _buffers, _width, height, _scroll, _fg, _bg, options) => {
        blits.push(paneId);
        for (let row = 0; row < height; row += 1) options.dirtyRows.push(row);
        return null;
      },
    };
    const adapter: PaneScopedTerminalAdapter = {
      renderSource,
      paneVersion: (paneId) => owner.version(paneId),
      paneSourceEpoch: () => owner.sourceEpoch(),
      subscribePaneVersion: (paneId, listener) => owner.subscribe(paneId, listener),
    };
    const palette = createTerminalPaletteProjection(createSemanticThemeSnapshot({ mode: "dark" }));
    const setup = await renderForTest(
      () => (
        <box flexDirection="column">
          <text>stable shell</text>
          <box flexDirection="row">
            <PaneScopedTerminalSurface
              adapter={adapter}
              paneId="editor"
              width={4}
              height={2}
              defaultFg={palette.foreground}
              defaultBg={palette.background}
              terminalPalette={palette}
              searchHl={palette.searchHighlight}
              searchCur={palette.searchCurrent}
              scrollOffset={0}
              paneFocused={true}
              sourceEpoch={1}
              selRange={null}
              search={null}
            />
            <PaneScopedTerminalSurface
              adapter={adapter}
              paneId="tests"
              width={4}
              height={2}
              defaultFg={palette.foreground}
              defaultBg={palette.background}
              terminalPalette={palette}
              searchHl={palette.searchHighlight}
              searchCur={palette.searchCurrent}
              scrollOffset={0}
              paneFocused={false}
              sourceEpoch={1}
              selRange={null}
              search={null}
            />
          </box>
        </box>
      ),
      { width: 12, height: 4 },
    );
    await setup.renderOnce();
    blits.length = 0;

    expect(owner.publish(generation, "editor", 1)).toBe(true);
    await setup.renderOnce();

    expect(blits).toEqual(["editor"]);
    expect(setup.captureCharFrame()).toContain("stable shell");
    setup.renderer.destroy();
  });

  it("fully repaints generation B even when its pane version equals generation A", async () => {
    registerPaneSurface();
    const owner = new PaneScopedTerminalOwner();
    const generation = owner.beginGeneration();
    let character = "A";
    const blits: string[] = [];
    const renderSource: TerminalPaneRenderSource = {
      scrollbackDepth: () => 0,
      cursorState: () => null,
      blitPane: (paneId, buffers, width, _height, _scroll, _fg, _bg, options) => {
        blits.push(paneId);
        buffers.char[0] = character.codePointAt(0)!;
        buffers.attributes[0] = 0;
        options.dirtyRows.push(0);
        for (let column = 1; column < width; column += 1) buffers.char[column] = 32;
        return null;
      },
    };
    const adapter: PaneScopedTerminalAdapter = {
      renderSource,
      paneVersion: (paneId) => owner.version(paneId),
      paneSourceEpoch: () => owner.sourceEpoch(),
      subscribePaneVersion: (paneId, listener) => owner.subscribe(paneId, listener),
    };
    const palette = createTerminalPaletteProjection(createSemanticThemeSnapshot({ mode: "dark" }));
    expect(owner.publish(generation, "editor", 1)).toBe(true);
    const setup = await renderForTest(
      () => (
        <PaneScopedTerminalSurface
          adapter={adapter}
          paneId="editor"
          width={4}
          height={2}
          defaultFg={palette.foreground}
          defaultBg={palette.background}
          terminalPalette={palette}
          searchHl={palette.searchHighlight}
          searchCur={palette.searchCurrent}
          scrollOffset={0}
          paneFocused={true}
          sourceEpoch={1}
          selRange={null}
          search={null}
        />
      ),
      { width: 4, height: 2 },
    );
    await setup.renderOnce();
    expect(blits).toEqual(["editor"]);
    expect(setup.captureCharFrame()).toContain("A");

    blits.length = 0;
    character = "B";
    owner.replaceSource();
    await setup.renderOnce();

    expect(blits).toEqual(["editor"]);
    expect(setup.captureCharFrame()).toContain("B");
    expect(setup.captureCharFrame()).not.toContain("A");
    setup.renderer.destroy();
  });
});
