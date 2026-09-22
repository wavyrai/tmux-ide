/* @jsxImportSource @opentui/solid */
import { expect, it } from "bun:test";
import { createSignal } from "solid-js";
import { blankTerminalReplicaSnapshot } from "@tmux-ide/core";
import { parseAppConfig } from "../../lib/app-config.ts";
import { createAppearanceOwner } from "./runtime/application-appearance-owner.ts";
import { createApplicationTerminalPaletteOwner } from "./runtime/application-terminal-palette-owner.ts";
import { registerPaneSurface, type TerminalPaneRenderSource } from "./pane-surface.tsx";
import { blitSemanticRow } from "./semantic-pane-render-source.ts";
import { colorToPackedRgb } from "./theme.ts";
import { packedContrastRatio } from "./automatic-contrast.ts";
import { renderForTest } from "./testing/renderer-harness.test.ts";

it("corrects composed app and retained terminal RGB, then restores OFF without terminal bytes", async () => {
  registerPaneSurface();
  const snapshot = structuredClone(blankTerminalReplicaSnapshot(4, 1));
  for (const [i, cell] of snapshot.grid[0]!.cells.entries()) {
    cell.grapheme = String(i);
    cell.foreground = { kind: "rgb", value: 0x888888 };
    cell.background = { kind: "rgb", value: 0x999999 };
    cell.attributes = i === 1 ? 2 : i === 2 ? 32 : 0;
  }
  const canonical = JSON.stringify(snapshot);
  const source: TerminalPaneRenderSource = {
    scrollbackDepth: () => 0,
    cursorState: () => null,
    blitPane: (_id, buffers, width, _height, _offset, fg, bg, options) => {
      if (!options.full) return null;
      blitSemanticRow(
        snapshot.grid[0],
        buffers,
        0,
        width,
        fg,
        bg,
        options.graphemes,
        options.palette,
      );
      options.dirtyRows.push(0);
      return null;
    },
  };
  const [bg, setBg] = createSignal("#eeeeee");
  const setup = await renderForTest(
    () => (
      <box width={8} height={2} flexDirection="column" backgroundColor={bg()}>
        <text height={1} fg="#888888" content="App 界é" />
        <pane_surface width={4} height={1} mirror={source} paneId="fixture" contentVersion={0} />
      </box>
    ),
    { width: 8, height: 2 },
  );
  const palette = createApplicationTerminalPaletteOwner(setup.renderer);
  const owner = createAppearanceOwner(parseAppConfig({}), setup.renderer, palette);
  await palette.ready;
  let raw: { char: number[]; fg: number[]; attributes: number[] } | undefined;
  setup.renderer.addPostProcessFn((b) => {
    raw = {
      char: Array.from(b.buffers.char),
      fg: Array.from(b.buffers.fg),
      attributes: Array.from(b.buffers.attributes),
    };
  });
  const capture = () =>
    setup
      .captureSpans()
      .lines.map((line) =>
        line.spans
          .filter((s) => /[\p{L}\p{N}]/u.test(s.text))
          .map((s) => [colorToPackedRgb(s.fg), colorToPackedRgb(s.bg), s.attributes]),
      );
  for (const background of ["#eeeeee", "#222222"]) {
    owner.openPicker();
    owner.preview(background === "#eeeeee" ? "light" : "dark");
    setBg(background);
    await setup.renderOnce();
    for (const row of capture())
      for (const [fg, bg] of row) expect(packedContrastRatio(fg!, bg!)).toBeGreaterThanOrEqual(4.5);
    expect(setup.captureCharFrame()).toContain("App 界é");
    expect(raw!.fg.slice(16, 20)).toEqual(raw!.fg.slice(20, 24));
    expect(raw!.attributes[9]! & 2).toBe(0);
    const corrected = capture();
    const correctedChars = raw!.char;
    await setup.renderOnce();
    expect(capture()).toEqual(corrected);
    owner.openPicker();
    owner.toggleAutomaticContrast();
    await setup.renderOnce();
    expect(capture()[0]![0]![0]).toBe(0x888888);
    expect(raw!.attributes[9]! & 2).toBe(2);
    expect(raw!.char).toEqual(correctedChars);
    expect(capture()[1]![0]!.slice(0, 2)).toEqual([0x888888, 0x999999]);
    owner.cancelPicker();
    await setup.renderOnce();
    expect(capture()).toEqual(corrected);
  }
  expect(JSON.stringify(snapshot)).toBe(canonical);
  owner.dispose();
});
