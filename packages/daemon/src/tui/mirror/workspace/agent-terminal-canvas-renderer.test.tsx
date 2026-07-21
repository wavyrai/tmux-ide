/* @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test";
import { createMemo, createSignal } from "solid-js";
import { colorToThemeBytes, createSemanticThemeSnapshot } from "../theme.ts";
import { expectFrameBounds, renderForTest, stableFrame } from "../testing/renderer-harness.test.ts";
import { projectAgentTerminalCanvas } from "./agent-terminal-canvas.ts";
import { AgentTerminalCanvas } from "./agent-terminal-canvas-view.tsx";
import {
  projectTerminalPaneChrome,
  terminalPaneChromeHitTest,
  terminalPaneChromeOverlapsBodies,
} from "./terminal-pane-chrome.ts";
import { TerminalPaneChromeLayer } from "./terminal-pane-chrome-view.tsx";

interface TestRenderable {
  getChildren(): readonly unknown[];
}

function renderableTree(node: TestRenderable): readonly unknown[] {
  return [
    node,
    ...node
      .getChildren()
      .flatMap((child) =>
        typeof (child as { getChildren?: unknown }).getChildren === "function"
          ? renderableTree(child as TestRenderable)
          : [child],
      ),
  ];
}

function renderableCount(node: TestRenderable): number {
  return renderableTree(node).length;
}

function colorKey(color: Parameters<typeof colorToThemeBytes>[0]): string {
  return colorToThemeBytes(color).join(",");
}

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
      const maximizeSpan = setup
        .captureSpans()
        .lines[projection.chrome.height - 1]!.spans.find((span) => span.text.includes("□"));
      expect(maximizeSpan).toBeDefined();
      expect(colorKey(maximizeSpan!.bg)).toBe(colorKey(theme.roles.surfaces.headerActive));
      expect(colorKey(maximizeSpan!.fg)).toBe(colorKey(theme.roles.text.muted));
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
      expect(stable).toContain(zoom.label);
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

  it("keeps pane and action renderables stable across fresh projection objects", async () => {
    const width = 100;
    const height = 14;
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const canvas = projectAgentTerminalCanvas({ width, height, chromeRows: 2 });
    const states = [
      { active: "%1", hoveredPane: "%1", hoveredAction: 0, pressedAction: null },
      { active: "%2", hoveredPane: "%2", hoveredAction: 1, pressedAction: null },
      { active: "%3", hoveredPane: "%3", hoveredAction: 0, pressedAction: 0 },
      { active: "%1", hoveredPane: "%1", hoveredAction: 0, pressedAction: null },
    ] as const;
    let drive!: (state: (typeof states)[number]) => void;

    function Harness() {
      const [state, setState] = createSignal<(typeof states)[number]>(states[0]);
      drive = setState;
      const layout = createMemo(() => {
        const current = state();
        // Deliberately allocate every pane, metadata map, projection, frame,
        // chip, and action again. This is the production projection contract.
        return projectTerminalPaneChrome({
          canvas,
          panes: [
            {
              id: "%1",
              left: 0,
              top: 0,
              width: 49,
              height: canvas.framebuffer.height,
              active: current.active === "%1",
              zoomed: false,
            },
            {
              id: "%2",
              left: 50,
              top: 0,
              width: 50,
              height: 5,
              active: current.active === "%2",
              zoomed: false,
            },
            {
              id: "%3",
              left: 50,
              top: 6,
              width: 50,
              height: canvas.framebuffer.height - 6,
              active: current.active === "%3",
              zoomed: false,
            },
          ],
          metadataByPane: new Map([
            ["%1", { title: "Codex PM", status: "working", statusTone: "working" as const }],
            ["%2", { title: "Codex builder", status: "working", statusTone: "working" as const }],
            ["%3", { title: "Claude review", status: "idle", statusTone: "idle" as const }],
          ]),
          hoveredAction: {
            paneId: current.hoveredPane,
            actionIndex: current.hoveredAction,
          },
          pressedAction:
            current.pressedAction === null
              ? null
              : { paneId: current.hoveredPane, actionIndex: current.pressedAction },
        });
      });
      return (
        <box position="relative" width={width} height={height} overflow="hidden">
          <TerminalPaneChromeLayer theme={theme} layout={layout()} layer="native" />
          <box
            position="absolute"
            left={canvas.framebuffer.x}
            top={canvas.framebuffer.y}
            width={canvas.framebuffer.width}
            height={canvas.framebuffer.height}
          >
            <TerminalPaneChromeLayer theme={theme} layout={layout()} layer="framebuffer" />
          </box>
        </box>
      );
    }

    const setup = await renderForTest(() => <Harness />, { width, height });
    await setup.renderOnce();
    const initialCount = renderableCount(setup.renderer.root);
    const stablePaneNodes = new Map(
      ["%1", "%2", "%3"].map((paneId) => {
        const layer = paneId === "%3" ? "framebuffer" : "native";
        return [
          paneId,
          setup.renderer.root.findDescendantById(`terminal-pane-chrome:${layer}:${paneId}`),
        ] as const;
      }),
    );
    expect([...stablePaneNodes.values()].every(Boolean)).toBe(true);
    const stablePaneTrees = new Map(
      [...stablePaneNodes].map(([paneId, node]) => [
        paneId,
        renderableTree(node as TestRenderable),
      ]),
    );

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    const framesByState = new Map<string, string>();
    try {
      for (let index = 0; index < 24; index += 1) {
        const state = states[index % states.length]!;
        drive({ ...state });
        await setup.renderOnce();
        expect(renderableCount(setup.renderer.root)).toBe(initialCount);
        for (const [paneId, node] of stablePaneNodes) {
          const layer = paneId === "%3" ? "framebuffer" : "native";
          expect(
            setup.renderer.root.findDescendantById(`terminal-pane-chrome:${layer}:${paneId}`),
          ).toBe(node);
          const currentTree = renderableTree(node as TestRenderable);
          const stableTree = stablePaneTrees.get(paneId)!;
          expect(currentTree).toHaveLength(stableTree.length);
          currentTree.forEach((renderable, childIndex) => {
            expect(renderable).toBe(stableTree[childIndex]);
          });
        }
        const key = JSON.stringify(state);
        const frame = stableFrame(setup.captureCharFrame());
        const previous = framesByState.get(key);
        if (previous) expect(frame).toBe(previous);
        else framesByState.set(key, frame);
      }
    } finally {
      console.warn = originalWarn;
      setup.renderer.destroy();
    }
    expect(warnings.filter((warning) => /insertBefore|anchor|reconcil/iu.test(warning))).toEqual(
      [],
    );
  });
});
