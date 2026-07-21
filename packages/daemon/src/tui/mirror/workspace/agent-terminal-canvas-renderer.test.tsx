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
  type TerminalPaneChromeLayout,
  type TerminalPaneChromePane,
} from "./terminal-pane-chrome.ts";
import { SharedTerminalPaneChromeLayer } from "./terminal-pane-chrome-view.tsx";

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
                <SharedTerminalPaneChromeLayer theme={theme} layout={layout} layer="native" />
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
                <SharedTerminalPaneChromeLayer theme={theme} layout={layout} layer="framebuffer" />
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
                <SharedTerminalPaneChromeLayer theme={theme} layout={layout} layer="native" />
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

  it.each([
    [80, 24],
    [120, 40],
    [200, 60],
  ] as const)(
    "keeps pane chrome stable through production topology churn at %sx%s",
    async (width, height) => {
      type Topology = "base" | "added" | "migrated" | "zoomed";
      interface StressState {
        topology: Topology;
        active: string;
        attention: string | null;
        hoveredAction: number | null;
        pressed: boolean;
      }

      const theme = createSemanticThemeSnapshot({ mode: "dark" });
      const canvas = projectAgentTerminalCanvas({ width, height, chromeRows: 2 });
      const framebuffer = canvas.framebuffer;
      const leftWidth = Math.floor((framebuffer.width - 1) / 2);
      const rightLeft = leftWidth + 1;
      const rightWidth = framebuffer.width - rightLeft;
      const upperHeight = Math.floor((framebuffer.height - 1) / 2);
      const lowerTop = upperHeight + 1;
      const firstLeftWidth = Math.floor((leftWidth - 1) / 2);
      const addedLeft = firstLeftWidth + 1;
      const addedWidth = leftWidth - addedLeft;
      const states: readonly StressState[] = [
        {
          topology: "base",
          active: "%1",
          attention: null,
          hoveredAction: 0,
          pressed: false,
        },
        {
          topology: "base",
          active: "%2",
          attention: "%3",
          hoveredAction: 1,
          pressed: true,
        },
        {
          topology: "added",
          active: "%4",
          attention: "%2",
          hoveredAction: 0,
          pressed: false,
        },
        {
          topology: "added",
          active: "%1",
          attention: "%4",
          hoveredAction: 1,
          pressed: true,
        },
        {
          topology: "base",
          active: "%3",
          attention: null,
          hoveredAction: 0,
          pressed: false,
        },
        {
          topology: "migrated",
          active: "%3",
          attention: "%2",
          hoveredAction: 1,
          pressed: false,
        },
        {
          topology: "migrated",
          active: "%2",
          attention: "%3",
          hoveredAction: 0,
          pressed: true,
        },
        {
          topology: "base",
          active: "%2",
          attention: "%1",
          hoveredAction: 1,
          pressed: false,
        },
        {
          topology: "zoomed",
          active: "%2",
          attention: "%2",
          hoveredAction: 0,
          pressed: true,
        },
        {
          topology: "base",
          active: "%1",
          attention: null,
          hoveredAction: 0,
          pressed: false,
        },
      ];

      const pane = (
        current: StressState,
        id: string,
        left: number,
        top: number,
        paneWidth: number,
        paneHeight: number,
      ): TerminalPaneChromePane => ({
        id,
        left,
        top,
        width: paneWidth,
        height: paneHeight,
        active: current.active === id,
        zoomed: current.topology === "zoomed",
      });
      const panesFor = (current: StressState): readonly TerminalPaneChromePane[] => {
        if (current.topology === "zoomed") {
          return [pane(current, "%2", 0, 0, framebuffer.width, framebuffer.height)];
        }
        const leftPanes =
          current.topology === "added"
            ? [
                pane(current, "%1", 0, 0, firstLeftWidth, framebuffer.height),
                pane(current, "%4", addedLeft, 0, addedWidth, framebuffer.height),
              ]
            : [pane(current, "%1", 0, 0, leftWidth, framebuffer.height)];
        const upperId = current.topology === "migrated" ? "%3" : "%2";
        const lowerId = current.topology === "migrated" ? "%2" : "%3";
        return [
          ...leftPanes,
          pane(current, upperId, rightLeft, 0, rightWidth, upperHeight),
          pane(current, lowerId, rightLeft, lowerTop, rightWidth, framebuffer.height - lowerTop),
        ];
      };

      let drive!: (state: StressState) => void;
      let readLayout!: () => TerminalPaneChromeLayout;
      let readPanes!: () => readonly TerminalPaneChromePane[];

      function Harness() {
        const [state, setState] = createSignal<StressState>(states[0]!);
        drive = setState;
        const livePanes = createMemo(() => panesFor(state()));
        const layout = createMemo(() => {
          const current = state();
          const panes = livePanes();
          return projectTerminalPaneChrome({
            canvas,
            panes,
            metadataByPane: new Map(
              panes.map((candidate) => {
                const attention = current.attention === candidate.id;
                return [
                  candidate.id,
                  {
                    title: `Agent ${candidate.id}`,
                    status: attention ? "blocked" : "working",
                    statusTone: attention ? ("blocked" as const) : ("working" as const),
                    attention,
                  },
                ] as const;
              }),
            ),
            hoveredAction: {
              paneId: current.active,
              actionIndex: current.hoveredAction,
            },
            pressedAction: current.pressed
              ? { paneId: current.active, actionIndex: current.hoveredAction ?? 0 }
              : null,
          });
        });
        readLayout = layout;
        readPanes = livePanes;
        return (
          <AgentTerminalCanvas
            theme={theme}
            projection={canvas}
            chrome={
              <>
                <text fg={theme.roles.text.muted}> production window</text>
                <SharedTerminalPaneChromeLayer theme={theme} layout={layout()} layer="native" />
              </>
            }
            framebuffer={
              <box
                position="relative"
                width={framebuffer.width}
                height={framebuffer.height}
                backgroundColor={theme.roles.surfaces.terminal}
              >
                <box position="absolute" left={0} bottom={0} width={1} height={1}>
                  <text fg={theme.roles.text.muted}>·</text>
                </box>
                <SharedTerminalPaneChromeLayer
                  theme={theme}
                  layout={layout()}
                  layer="framebuffer"
                />
              </box>
            }
          />
        );
      }

      const warnings: string[] = [];
      const originalWarn = console.warn;
      const originalError = console.error;
      const captureWarning = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
      console.warn = captureWarning;
      console.error = captureWarning;
      const setup = await renderForTest(() => <Harness />, { width, height });
      const countsByTopology = new Map<Topology, number>();
      const framesByState = new Map<string, string>();
      let previousTopology: Topology | null = null;
      let previousNodes = new Map<string, unknown>();
      let previousTrees = new Map<string, readonly unknown[]>();
      try {
        for (let index = 0; index < states.length * 3; index += 1) {
          const state = states[index % states.length]!;
          drive({ ...state });
          await setup.renderOnce();

          const layout = readLayout();
          const panes = readPanes();
          const projections = [...layout.native, ...layout.framebuffer].filter(
            (projection) => projection.frame !== null,
          );
          expect(canvas.tmuxSize).toEqual({ cols: width, rows: height - 2 });
          expect(
            projections.every(
              (projection) => !terminalPaneChromeOverlapsBodies({ canvas, panes }, projection),
            ),
          ).toBe(true);

          const nodes = new Map<string, unknown>();
          const trees = new Map<string, readonly unknown[]>();
          for (const projection of projections) {
            const key = `${projection.layer}:${projection.paneId}`;
            const node = setup.renderer.root.findDescendantById(
              `shared-terminal-pane-chrome:${key}`,
            );
            expect(node).toBeDefined();
            expect(nodes.has(key)).toBe(false);
            nodes.set(key, node);
            trees.set(key, renderableTree(node as TestRenderable));
          }
          expect(nodes.size).toBe(projections.length);

          for (const [key, node] of nodes) {
            if (!previousNodes.has(key)) continue;
            expect(node).toBe(previousNodes.get(key));
            if (previousTopology !== state.topology) continue;
            const previousTree = previousTrees.get(key)!;
            const tree = trees.get(key)!;
            expect(tree).toHaveLength(previousTree.length);
            tree.forEach((renderable, childIndex) => {
              expect(renderable).toBe(previousTree[childIndex]);
            });
          }

          const renderables = renderableCount(setup.renderer.root);
          const previousCount = countsByTopology.get(state.topology);
          if (previousCount === undefined) countsByTopology.set(state.topology, renderables);
          else expect(renderables).toBe(previousCount);

          const frame = stableFrame(setup.captureCharFrame());
          expectFrameBounds(frame, width, height);
          const stateKey = JSON.stringify(state);
          const previousFrame = framesByState.get(stateKey);
          if (previousFrame === undefined) framesByState.set(stateKey, frame);
          else expect(frame).toBe(previousFrame);

          previousTopology = state.topology;
          previousNodes = nodes;
          previousTrees = trees;
        }
      } finally {
        console.warn = originalWarn;
        console.error = originalError;
        setup.renderer.destroy();
      }
      expect(warnings.filter((warning) => /insertBefore|anchor|reconcil/iu.test(warning))).toEqual(
        [],
      );
    },
  );
});
