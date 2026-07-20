/* @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test";
import { createSemanticThemeSnapshot } from "../theme.ts";
import { expectFrameBounds, renderForTest, stableFrame } from "../testing/renderer-harness.test.ts";
import { projectAgentTerminalCanvas } from "./agent-terminal-canvas.ts";
import { AgentTerminalCanvas } from "./agent-terminal-canvas-view.tsx";
import {
  projectTerminalPaneChrome,
  terminalPaneChromeHitTest,
  terminalPaneChromeOverlapsBodies,
} from "./terminal-pane-chrome.ts";
import { TerminalPaneChromeLayer } from "./terminal-pane-chrome-view.tsx";

describe("AgentTerminalCanvas OpenTUI renderer", () => {
  it.each([
    [80, 24],
    [120, 40],
    [200, 60],
  ] as const)("keeps native chrome outside the %sx%s framebuffer", async (width, height) => {
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const projection = projectAgentTerminalCanvas({
      width,
      height,
      chromeRows: 2,
      footerRows: 1,
    });
    const setup = await renderForTest(
      () => (
        <AgentTerminalCanvas
          theme={theme}
          projection={projection}
          chrome={
            <>
              <text fg={theme.colors.foreground}> mission-control · live</text>
              <text fg={theme.colors.mutedForeground}> 0:agents 1:shell</text>
            </>
          }
          framebuffer={
            <box width={projection.framebuffer.width} height={projection.framebuffer.height}>
              <text fg={theme.colors.accent}>
                tmux framebuffer {`${projection.tmuxSize!.cols}x${projection.tmuxSize!.rows}`}
              </text>
            </box>
          }
          footer={<text fg={theme.colors.mutedForeground}> /blocked 1/3</text>}
        />
      ),
      { width, height },
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expectFrameBounds(frame, width, height);
    expect(stableFrame(frame)).toMatchSnapshot();
    expect(stableFrame(frame)).toContain("mission-control · live");
    expect(stableFrame(frame)).toContain(
      `tmux framebuffer ${projection.tmuxSize!.cols}x${projection.tmuxSize!.rows}`,
    );
    expect(stableFrame(frame)).toContain("/blocked 1/3");
    setup.renderer.destroy();
  });

  it.each([
    [80, 24],
    [120, 40],
    [200, 60],
  ] as const)(
    "renders pane chrome at %sx%s without covering framebuffer sentinels",
    async (width, height) => {
      const theme = createSemanticThemeSnapshot({ mode: "dark" });
      const projection = projectAgentTerminalCanvas({ width, height, chromeRows: 2 });
      const framebuffer = projection.framebuffer;
      const leftWidth = Math.floor((framebuffer.width - 1) / 2);
      const rightLeft = leftWidth + 1;
      const rightWidth = framebuffer.width - rightLeft;
      const topHeight = Math.floor((framebuffer.height - 1) / 2);
      const lowerTop = topHeight + 1;
      const panes = [
        {
          id: "%1",
          left: 0,
          top: 0,
          width: leftWidth,
          height: framebuffer.height,
          active: true,
          zoomed: false,
        },
        {
          id: "%2",
          left: rightLeft,
          top: 0,
          width: rightWidth,
          height: topHeight,
          active: false,
          zoomed: false,
        },
        {
          id: "%3",
          left: rightLeft,
          top: lowerTop,
          width: rightWidth,
          height: framebuffer.height - lowerTop,
          active: false,
          zoomed: false,
        },
      ];
      const layout = projectTerminalPaneChrome({
        canvas: projection,
        panes,
        metadataByPane: new Map([
          ["%1", { title: "Codex PM", status: "working", statusTone: "working" as const }],
          ["%2", { title: "Codex implementer", status: "working", statusTone: "working" as const }],
          [
            "%3",
            {
              title: "Claude reviewer",
              status: "blocked",
              statusTone: "blocked" as const,
              attention: true,
            },
          ],
        ]),
      });
      const sentinel = (id: string, paneWidth: number, paneHeight: number) => (
        <>
          <box position="absolute" left={0} top={0} width={4} height={1}>
            <text>{`A${id.slice(1)}A`}</text>
          </box>
          <box position="absolute" right={0} bottom={0} width={4} height={1}>
            <text>{`Z${id.slice(1)}Z`}</text>
          </box>
          <box position="absolute" left={4} top={0} width={Math.max(0, paneWidth - 8)} height={1}>
            <text>{"·".repeat(Math.max(0, paneWidth - 8))}</text>
          </box>
          <box position="absolute" left={0} top={Math.max(0, paneHeight - 2)} width={1} height={1}>
            <text>│</text>
          </box>
        </>
      );
      const setup = await renderForTest(
        () => (
          <AgentTerminalCanvas
            theme={theme}
            projection={projection}
            chrome={
              <>
                <text fg={theme.colors.mutedForeground}> 0:agents 1:shell</text>
                <TerminalPaneChromeLayer theme={theme} layout={layout} layer="native" />
              </>
            }
            framebuffer={
              <box position="relative" width={framebuffer.width} height={framebuffer.height}>
                {panes.map((pane) => (
                  <box
                    position="absolute"
                    left={pane.left}
                    top={pane.top}
                    width={pane.width}
                    height={pane.height}
                    overflow="hidden"
                  >
                    {sentinel(pane.id, pane.width, pane.height)}
                  </box>
                ))}
                <TerminalPaneChromeLayer theme={theme} layout={layout} layer="framebuffer" />
              </box>
            }
          />
        ),
        { width, height },
      );
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      const stable = stableFrame(frame);
      expectFrameBounds(frame, width, height);
      expect(projection.tmuxSize).toEqual({ cols: width, rows: height - 2 });
      expect(stable).toMatchSnapshot();
      for (const id of ["1", "2", "3"]) {
        expect(stable).toContain(`A${id}A`);
        expect(stable).toContain(`Z${id}Z`);
      }
      expect(stable).toContain("Claude reviewer");
      setup.renderer.destroy();
    },
  );

  it.each([1, 2, 3, 4, 5, 8, 12, 13, 16] as const)(
    "keeps compact zoom chrome visible at width %s",
    async (width) => {
      const height = 6;
      const theme = createSemanticThemeSnapshot({ mode: "dark" });
      const projection = projectAgentTerminalCanvas({ width, height, chromeRows: 2 });
      const zoomed = width <= 4 && width % 2 === 0;
      const pane = {
        id: "%7",
        left: 0,
        top: 0,
        width,
        height: projection.framebuffer.height,
        active: true,
        zoomed,
      };
      const layout = projectTerminalPaneChrome({ canvas: projection, panes: [pane] });
      const setup = await renderForTest(
        () => (
          <AgentTerminalCanvas
            theme={theme}
            projection={projection}
            chrome={
              <>
                <text fg={theme.colors.mutedForeground}> window</text>
                <TerminalPaneChromeLayer theme={theme} layout={layout} layer="native" />
              </>
            }
            framebuffer={<text>B</text>}
          />
        ),
        { width, height },
      );
      await setup.renderOnce();
      const stable = stableFrame(setup.captureCharFrame());
      const header = layout.native[0]!;
      const zoom = header.frame!.actions.find((action) => action.id === "zoom")!;
      expect(stable).toMatchSnapshot();
      expect(stable).toContain(zoomed ? "R" : "Z");
      expect(stable).toContain("B");
      expect(
        terminalPaneChromeHitTest(
          layout,
          header.canvasRect.x + zoom.start + Math.floor((zoom.width - 1) / 2),
          header.canvasRect.y,
        ),
      ).toMatchObject({ paneId: "%7", hit: { area: "action", actionId: "zoom" } });
      expect(terminalPaneChromeOverlapsBodies({ canvas: projection, panes: [pane] }, header)).toBe(
        false,
      );
      setup.renderer.destroy();
    },
  );
});
