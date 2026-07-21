/* @jsxImportSource @opentui/solid */
import { MouseButtons } from "@opentui/core/testing";
import { testRender, useKeyboard } from "@opentui/solid";
import { createSignal, onCleanup } from "solid-js";
import { afterEach, describe, expect, it } from "bun:test";
import { missionDashboardHitTest, missionDashboardProjection } from "./missions-dashboard.ts";
import {
  handleMissionSurfaceKey,
  handleMissionSurfacePointerDown,
  type MissionSurfaceControllerActions,
} from "./missions-surface-controller.ts";
import { MissionsSurface, type MissionSurfaceHoverRegion } from "./missions-surface.tsx";
import { missionRenderFixture } from "./missions-render-fixtures.ts";
import {
  defaultMissionWorkspaceModel,
  type MissionDeepLinkKind,
  type MissionWorkspaceHit,
  type MissionWorkspaceLoadState,
  type MissionWorkspaceModel,
  type MissionWorkspaceSnapshot,
} from "./missions-workspace.ts";
import { terminalDisplayWidth } from "./panel-host.ts";
import { MUTED, createSemanticThemeSnapshot } from "./theme.ts";

type TestSetup = Awaited<ReturnType<typeof testRender>>;

const THEME = createSemanticThemeSnapshot({ mode: "dark" });

let setup: TestSetup | null = null;

afterEach(() => {
  setup?.renderer.destroy();
  setup = null;
});

function frameLines(frame: string): string[] {
  const lines = frame.endsWith("\n") ? frame.slice(0, -1).split("\n") : frame.split("\n");
  return lines.map((line) => line.replace(/\r$/u, ""));
}

function stableFrame(frame: string): string {
  return frameLines(frame)
    .map((line) => line.replace(/\s+$/u, ""))
    .join("\n");
}

function expectFrameBounds(frame: string, width: number, height: number): void {
  const lines = frameLines(frame);
  expect(lines).toHaveLength(height);
  for (const line of lines) {
    expect(terminalDisplayWidth(line)).toBeLessThanOrEqual(width);
  }
}

function keyNameInFrame(frame: string, value: string): boolean {
  return stableFrame(frame).includes(value);
}

function loadState(snapshot: MissionWorkspaceSnapshot): MissionWorkspaceLoadState {
  return { status: "ready", generation: 1, snapshot };
}

interface RenderHarness {
  model: () => MissionWorkspaceModel;
  snapshot: MissionWorkspaceSnapshot;
  calls: string[];
  actions: MissionSurfaceControllerActions;
  lastFrame: () => string;
  clickHit: (hit: Exclude<MissionWorkspaceHit, null>) => Promise<void>;
  clickInspectorWhitespace: () => Promise<void>;
}

async function renderHarness(
  width: number,
  height: number,
  options: { withoutDetail?: boolean } = {},
): Promise<RenderHarness> {
  const fixture = missionRenderFixture();
  if (options.withoutDetail) fixture.snapshot.detail = null;
  let currentModel = fixture.model;
  let lastFrame = "";
  const calls: string[] = [];
  let clickHit: RenderHarness["clickHit"] = async () => {
    throw new Error("renderer not mounted");
  };
  let clickInspectorWhitespace: RenderHarness["clickInspectorWhitespace"] = async () => {
    throw new Error("renderer not mounted");
  };
  const actions: MissionSurfaceControllerActions = {
    updateModel: (updater) => {
      calls.push("update");
      setModel((model) => {
        const next = updater(model);
        currentModel = next;
        return next;
      });
    },
    refresh: () => calls.push("refresh"),
    followDeepLink: (kind) => calls.push(`link:${kind}`),
    persistSelection: (missionId, taskId) =>
      calls.push(`persist:${missionId ?? ""}:${taskId ?? ""}`),
  };
  const [model, setModel] = createSignal(currentModel);

  function Harness() {
    const projection = () =>
      missionDashboardProjection(width, height, model(), fixture.snapshot, {
        loadStatus: "ready",
        projectLabel: "missions-polish",
        quitHint: "^Q quit",
        agents: fixture.agents,
      });
    const state = () => ({
      model: model(),
      snapshot: fixture.snapshot,
      layoutSize: projection().main,
      persistedTaskId: "tsk_running",
    });
    const routeHit = (hit: MissionWorkspaceHit) => {
      if (!hit) return false;
      return handleMissionSurfacePointerDown(hit, state(), actions);
    };
    useKeyboard((event) => {
      handleMissionSurfaceKey(
        {
          name: event.name,
          ctrl: event.ctrl,
          meta: event.meta,
          shift: event.shift,
        },
        state(),
        actions,
      );
    });
    clickHit = async (wanted) => {
      const projected = projection();
      const hit =
        wanted.kind === "card"
          ? projected.main.layout.board.columns
              .flatMap((column) => column.cards)
              .find((card) => card.missionId === wanted.missionId)
          : wanted.kind === "collapse"
            ? projected.main.layout.header.rows.flat().find((chip) => chip.kind === "collapse")
            : wanted.kind === "zoom"
              ? projected.main.layout.header.rows.flat().find((chip) => chip.kind === "zoom")
              : null;
      if (!hit) throw new Error(`No rendered hit for ${wanted.kind}`);
      const x = "start" in hit ? hit.start : hit.x + Math.floor(hit.width / 2);
      const y = "row" in hit ? hit.row : hit.y + Math.floor(hit.height / 2);
      const routed = missionDashboardHitTest(projected, projected.main.x + x, projected.main.y + y);
      expect(routed?.kind).toBe(wanted.kind);
      await setup!.mockMouse.click(projected.main.x + x, projected.main.y + y, MouseButtons.LEFT);
    };
    clickInspectorWhitespace = async () => {
      const inspector = projection().inspector;
      if (!inspector) throw new Error("No inspector rendered");
      await setup!.mockMouse.click(
        inspector.x + inspector.width - 1,
        inspector.y + inspector.height - 1,
      );
    };
    onCleanup(() => calls.push("disposed"));
    return (
      <box
        width={width}
        height={height}
        overflow="hidden"
        onMouseDown={(event) => {
          const hit = missionDashboardHitTest(projection(), event.x, event.y);
          routeHit(hit);
        }}
      >
        <MissionsSurface
          width={width}
          dashboard={projection()}
          model={model()}
          snapshot={fixture.snapshot}
          loadState={loadState(fixture.snapshot)}
          errorMessage=""
          resolveDeepLink={(kind: MissionDeepLinkKind) => ({
            available: true,
            kind,
            label: kind,
            intent:
              kind === "terminal"
                ? { kind, session: "m28-missions", paneId: "%7", viewId: "missions" }
                : kind === "files"
                  ? { kind, path: "packages/daemon", mode: "reveal", viewId: "files" }
                  : { kind, path: "packages/daemon", viewId: "diff" },
          })}
          isHovered={(_region: MissionSurfaceHoverRegion, _index: number) => false}
          theme={THEME}
        />
      </box>
    );
  }

  setup = await testRender(() => <Harness />, { width, height });
  await setup.renderOnce();
  lastFrame = setup.captureCharFrame();
  return {
    model: () => currentModel,
    snapshot: fixture.snapshot,
    calls,
    actions,
    lastFrame: () => {
      lastFrame = setup!.captureCharFrame();
      return lastFrame;
    },
    clickHit,
    clickInspectorWhitespace,
  };
}

describe("MissionsSurface OpenTUI renderer", () => {
  it.each([
    [80, 24, "narrow"],
    [120, 40, "medium"],
    [200, 60, "wide"],
  ] as const)(
    "renders deterministic %sx%s %s frame within bounds",
    async (width, height, variant) => {
      const harness = await renderHarness(width, height);
      const frame = harness.lastFrame();
      const projection = missionDashboardProjection(
        width,
        height,
        harness.model(),
        harness.snapshot,
        {
          loadStatus: "ready",
          projectLabel: "missions-polish",
          quitHint: "^Q quit",
          agents: missionRenderFixture().agents,
        },
      );

      expect(projection.variant).toBe(variant);
      expectFrameBounds(frame, width, height);
      expect(stableFrame(frame)).toMatchSnapshot();
      expect(keyNameInFrame(frame, "missions-polish")).toBe(true);
      expect(keyNameInFrame(frame, "^Q quit")).toBe(true);
      if (variant === "narrow") {
        expect(projection.inspector).toBeNull();
        expect(keyNameInFrame(frame, "agents:")).toBe(false);
      } else if (variant === "medium") {
        expect(projection.inspector?.variant).toBe("medium");
        expect(projection.main.width).toBeLessThan(width);
        expect(projection.main.layout.board.visibleColumns).toContain("running");
        expect(keyNameInFrame(frame, "agents:")).toBe(true);
      } else {
        expect(projection.inspector?.variant).toBe("wide");
        expect(keyNameInFrame(frame, "Codex renderer")).toBe(true);
        expect(keyNameInFrame(frame, "tsk_running")).toBe(true);
        expect(keyNameInFrame(frame, "summary:")).toBe(true);
        expect(keyNameInFrame(frame, "Unrelated agent")).toBe(false);
      }
    },
  );

  it("drives keyboard navigation, detail entry, and back through the rendered surface", async () => {
    const harness = await renderHarness(120, 40);
    expect(harness.model().selectedColumn).toBe("running");

    setup!.mockInput.pressEnter();
    await setup!.renderOnce();
    expect(harness.model().mode).toBe("detail");
    expect(harness.calls).toContain("persist:mis_running:tsk_running");
    expect(keyNameInFrame(harness.lastFrame(), "tsk_running")).toBe(true);

    setup!.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await setup!.renderOnce();
    expect(harness.model().mode).toBe("board");

    setup!.mockInput.pressArrow("right");
    await setup!.renderOnce();
    expect(harness.model().selectedColumn).toBe("blocked");
    const afterRight = harness.lastFrame();
    expect(keyNameInFrame(afterRight, "blocked lane mi")).toBe(true);

    expect(harness.model().selectedMissionId).toBe("mis_blocked");
  });

  it("renders density, collapse, zoom, and horizontal-follow changes from keyboard", async () => {
    const harness = await renderHarness(120, 40);
    const initialFrame = stableFrame(harness.lastFrame());

    await setup!.mockInput.pressKey("z");
    await setup!.renderOnce();
    expect(harness.model().density).toBe("detailed");
    expect(stableFrame(harness.lastFrame())).not.toBe(initialFrame);

    await setup!.mockInput.pressKey("c");
    await setup!.renderOnce();
    expect(harness.model().collapsedColumns.running).toBe(true);
    expect(keyNameInFrame(harness.lastFrame(), "Ru")).toBe(true);

    await setup!.mockInput.pressKey("x");
    await setup!.renderOnce();
    expect(harness.model().zoomColumn).toBe("running");

    setup!.mockInput.pressArrow("right");
    await setup!.renderOnce();
    expect(harness.model().selectedColumn).toBe("blocked");
    expect(harness.model().horizontalOffset).toBeGreaterThanOrEqual(0);
  });

  it("routes card clicks through projected hit geometry and leaves inspector whitespace inert", async () => {
    const harness = await renderHarness(200, 60, { withoutDetail: true });
    await harness.clickInspectorWhitespace();
    await setup!.renderOnce();
    expect(harness.model().selectedMissionId).toBe("mis_running");
    expect(harness.calls).toEqual([]);

    await harness.clickHit({
      kind: "card",
      missionId: "mis_planned",
      column: "planned",
      index: 0,
      hoverKey: 0,
    });
    await setup!.renderOnce();
    expect(harness.model().mode).toBe("detail");
    expect(harness.model().selectedMissionId).toBe("mis_planned");
    expect(harness.calls).toEqual(["update", "update", "refresh"]);
  });

  it("uses the same Missions controller command for mouse and keyboard collapse", async () => {
    const harness = await renderHarness(120, 40);
    await setup!.mockInput.pressKey("c");
    await setup!.renderOnce();
    expect(harness.model().collapsedColumns.running).toBe(true);

    await harness.clickHit({ kind: "collapse" });
    await setup!.renderOnce();
    expect(harness.model().collapsedColumns.running).toBe(false);
  });

  it("destroys the renderer and disposes Solid cleanup without hanging", async () => {
    const harness = await renderHarness(80, 24);
    setup!.renderer.destroy();
    setup = null;
    expect(harness.calls).toContain("disposed");
  });

  it("renders empty state deterministically without filesystem reads", async () => {
    const fixture = missionRenderFixture();
    fixture.snapshot.board.columns = {
      planned: [],
      running: [],
      blocked: [],
      review: [],
      done: [],
    };
    fixture.snapshot.board.counts = {
      planned: 0,
      running: 0,
      blocked: 0,
      review: 0,
      done: 0,
      total: 0,
    };
    fixture.snapshot.history = [];
    fixture.snapshot.detail = null;
    const model = defaultMissionWorkspaceModel();
    const dashboard = missionDashboardProjection(80, 24, model, fixture.snapshot, {
      loadStatus: "empty",
      projectLabel: "missions-polish",
      quitHint: "^Q quit",
      agents: [],
    });
    setup = await testRender(
      () => (
        <MissionsSurface
          width={80}
          dashboard={dashboard}
          model={model}
          snapshot={fixture.snapshot}
          loadState={{ status: "empty", generation: 1, snapshot: fixture.snapshot }}
          errorMessage=""
          resolveDeepLink={(kind) => ({ available: false, kind, label: kind, reason: "none" })}
          isHovered={() => false}
          theme={THEME}
        />
      ),
      { width: 80, height: 24 },
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expectFrameBounds(frame, 80, 24);
    expect(keyNameInFrame(frame, "No missions yet.")).toBe(true);
  });
});
