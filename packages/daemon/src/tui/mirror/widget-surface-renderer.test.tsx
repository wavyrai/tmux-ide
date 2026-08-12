/* @jsxImportSource @opentui/solid */
import { SyntaxStyle } from "@opentui/core";
import { describe, expect, it } from "bun:test";
import { createSignal } from "solid-js";

import type { BlitOptions } from "./pane-mirror.ts";
import {
  PaneSurfaceRenderable,
  registerPaneSurface,
  type TerminalPaneRenderSource,
} from "./pane-surface.tsx";
import { createSemanticThemeSnapshot, createTerminalPaletteProjection } from "./theme.ts";
import { renderForTest } from "./testing/renderer-harness.test.ts";
import { TuiRichWidgetSurface } from "./widget-surface.tsx";

describe("OpenTUI rich widget surface", () => {
  it("renders Markdown as structured terminal UI with pane escape chrome", async () => {
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const syntaxStyle = SyntaxStyle.fromStyles({
      default: { fg: theme.roles.text.primary },
      "markup.heading": { fg: theme.colors.accent, bold: true },
    });
    const setup = await renderForTest(
      () => (
        <box position="relative" width={54} height={12}>
          <TuiRichWidgetSurface
            theme={theme}
            syntaxStyle={syntaxStyle}
            width={54}
            height={12}
            surface={{
              kind: "markdown",
              label: "Markdown",
              title: "PLAN.md",
              text: "# Release plan\n\n- [x] Shared contract\n- [ ] Ship it",
            }}
          />
        </box>
      ),
      { width: 54, height: 12 },
    );
    const frame = await setup.waitForFrame((candidate) => candidate.includes("Release plan"), {
      maxFrames: 20,
    });
    expect(frame).toContain("PLAN.md  ·  Ctrl-C to return");
    expect(frame).toContain("Release plan");
    expect(frame).toContain("Shared contract");
    setup.renderer.destroy();
    syntaxStyle.destroy();
  });

  it("retains the assembled pane framebuffer and rich wrapper identities across content updates", async () => {
    registerPaneSurface();
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const palette = createTerminalPaletteProjection(theme);
    const mirror = {
      scrollbackDepth: () => 0,
      cursorState: () => null,
      blitPane: (
        _id: string,
        _buffers: unknown,
        _width: number,
        _height: number,
        _scrollOffset: number,
        _defaultFg: number,
        _defaultBg: number,
        _options: BlitOptions,
      ) => undefined,
    } as unknown as TerminalPaneRenderSource;
    const paneIdentities = new Set<PaneSurfaceRenderable>();
    const wrapperIdentities = new Set<object>();
    let update!: () => void;
    const setup = await renderForTest(
      () => {
        const [text, setText] = createSignal("# First");
        update = () => setText("# Second");
        return (
          <box position="relative" width={42} height={9}>
            <pane_surface
              ref={(surface: PaneSurfaceRenderable) => paneIdentities.add(surface)}
              width={42}
              height={9}
              mirror={mirror}
              paneId="pane.editor"
              defaultFg={palette.foreground}
              defaultBg={palette.background}
              terminalPalette={palette}
              searchHl={palette.searchHighlight}
              searchCur={palette.searchCurrent}
              contentVersion={1}
            />
            <box
              id="rich:pane.editor:markdown"
              ref={(wrapper: object) => wrapperIdentities.add(wrapper)}
              position="absolute"
              left={0}
              top={0}
              width={42}
              height={9}
              overflow="hidden"
            >
              <TuiRichWidgetSurface
                theme={theme}
                syntaxStyle={null}
                width={42}
                height={9}
                surface={{ kind: "fallback", label: "Preview", title: null, text: text() }}
              />
            </box>
          </box>
        );
      },
      { width: 42, height: 9 },
    );
    await setup.waitForFrame((frame) => frame.includes("First"));
    update();
    await setup.waitForFrame((frame) => frame.includes("Second"));
    expect(paneIdentities.size).toBe(1);
    expect(wrapperIdentities.size).toBe(1);
    setup.renderer.destroy();
  });
});
