/* @jsxImportSource @opentui/solid */
import { MouseButtons } from "@opentui/core/testing";
import { useKeyboard } from "@opentui/solid";
import { createSignal } from "solid-js";
import { describe, expect, it } from "bun:test";
import { COHESION_FIXTURE_V1, projectApplicationShellV1 } from "@tmux-ide/contracts";
import { SelectableRow } from "../recipes.tsx";
import { createSemanticThemeSnapshot } from "../theme.ts";
import { expectFrameBounds, renderForTest, stableFrame } from "../testing/renderer-harness.test.ts";
import {
  projectWorkbenchShell,
  type WorkbenchDockMode,
  type WorkbenchDockTabId,
  type WorkbenchFocusZone,
} from "./workbench-shell.ts";
import { WorkbenchShell } from "./workbench-shell.tsx";

async function renderWorkbench(width: number, height: number) {
  const shell = projectApplicationShellV1(COHESION_FIXTURE_V1);
  const theme = createSemanticThemeSnapshot({ mode: "dark" });
  const calls: string[] = [];
  let modeValue: WorkbenchDockMode = "open";
  let activeValue: WorkbenchDockTabId = "missions";
  let focusValue: WorkbenchFocusZone = "canvas";
  const preferredHeight = width >= 160 ? 20 : width >= 96 ? 14 : 10;

  function Harness() {
    const [mode, setMode] = createSignal(modeValue);
    const [active, setActive] = createSignal(activeValue);
    const [focus, setFocus] = createSignal(focusValue);
    const projection = () =>
      projectWorkbenchShell({
        width,
        height,
        dockMode: mode(),
        persistedDockHeight: preferredHeight,
        activeDockTab: active(),
        focusZone: focus(),
        hoveredDockTab: null,
        attentionDockTabs: new Set(["activity"]),
        dockTools: shell.bottomDock.tools,
      });
    useKeyboard((event) => {
      if (event.name === "tab") {
        focusValue = focus() === "canvas" ? "dock-tabs" : "canvas";
        setFocus(focusValue);
        calls.push(`keyboard:${focusValue}`);
      }
    });
    return (
      <box
        width={width}
        height={height}
        overflow="hidden"
        onMouseDown={() => calls.push("leaked-to-root")}
      >
        <WorkbenchShell
          theme={theme}
          projection={projection()}
          onDockTabActivate={(tabId, source) => {
            activeValue = tabId;
            focusValue = "dock-body";
            setActive(activeValue);
            setFocus(focusValue);
            calls.push(`${source}:tab:${tabId}`);
          }}
          onDockActionActivate={(actionId, nextMode, source) => {
            modeValue = nextMode;
            focusValue = nextMode === "collapsed" ? "dock-tabs" : "dock-body";
            setMode(modeValue);
            setFocus(focusValue);
            calls.push(`${source}:action:${actionId}`);
          }}
          canvas={
            <box
              width={projection().canvasBody.width}
              height={projection().canvasBody.height}
              flexDirection="column"
              overflow="hidden"
            >
              <SelectableRow
                theme={theme}
                label="Agent canvas"
                meta={`${projection().variant} · 3 agents`}
                width={projection().canvasBody.width}
                selected
              />
              <SelectableRow
                theme={theme}
                label="Fable · project manager"
                meta="working"
                width={projection().canvasBody.width}
                focused={projection().focusZone === "canvas"}
                status="working"
                tone="working"
              />
              <SelectableRow
                theme={theme}
                label="Codex implementer 1 · terminal %7"
                meta="task M31.3"
                width={projection().canvasBody.width}
              />
              <SelectableRow
                theme={theme}
                label="Codex implementer 2 · ready"
                meta="gpt-5.5"
                width={projection().canvasBody.width}
              />
            </box>
          }
          dockBody={
            <box
              width={projection().dockBodyContent.width}
              height={projection().dockBodyContent.height}
              flexDirection="column"
              overflow="hidden"
            >
              <SelectableRow
                theme={theme}
                label={`${active()} dock`}
                meta={`${mode()} · preferred ${preferredHeight} rows`}
                width={projection().dockBodyContent.width}
                selected
              />
              <SelectableRow
                theme={theme}
                label="Full application parity"
                meta="7 / 20 cards"
                width={projection().dockBodyContent.width}
                focused={projection().focusZone === "dock-body"}
              />
              <SelectableRow
                theme={theme}
                label="Workbench dock projection"
                meta="in progress"
                width={projection().dockBodyContent.width}
                status="working"
                tone="working"
              />
            </box>
          }
        />
      </box>
    );
  }

  const setup = await renderForTest(() => <Harness />, { width, height });
  await setup.renderOnce();
  return {
    setup,
    calls,
    mode: () => modeValue,
    active: () => activeValue,
    focus: () => focusValue,
    projection: () =>
      projectWorkbenchShell({
        width,
        height,
        dockMode: modeValue,
        persistedDockHeight: preferredHeight,
        activeDockTab: activeValue,
        focusZone: focusValue,
        hoveredDockTab: null,
        attentionDockTabs: new Set(["activity"]),
        dockTools: shell.bottomDock.tools,
      }),
    frame: () => setup.captureCharFrame(),
  };
}

describe("WorkbenchShell OpenTUI renderer", () => {
  it.each([
    [80, 24, "compact"],
    [120, 40, "standard"],
    [200, 60, "wide"],
  ] as const)(
    "renders the %sx%s %s agent canvas and bottom dock",
    async (width, height, variant) => {
      const harness = await renderWorkbench(width, height);
      const frame = harness.frame();
      expectFrameBounds(frame, width, height);
      expect(harness.projection().variant).toBe(variant);
      expect(stableFrame(frame)).toMatchSnapshot();
      expect(stableFrame(frame)).toContain("Agent canvas");
      expect(stableFrame(frame)).toContain("Missions");
      expect(stableFrame(frame)).toContain("Activity");
      expect(stableFrame(frame)).toContain("preferred");
    },
  );

  it("leaves input ownership in the harness while routing projected dock cells", async () => {
    const harness = await renderWorkbench(120, 40);
    const files = harness.projection().tabs.find((tab) => tab.id === "files")!;
    await harness.setup.mockMouse.click(
      files.x + Math.floor(files.width / 2),
      harness.projection().dockTabs.y,
      MouseButtons.LEFT,
    );
    await harness.setup.renderOnce();
    expect(harness.active()).toBe("files");
    expect(harness.focus()).toBe("dock-body");

    const collapse = harness
      .projection()
      .actions.find((action) => action.id === "toggle-collapse")!;
    await harness.setup.mockMouse.click(
      collapse.x + Math.floor(collapse.width / 2),
      harness.projection().dockTabs.y,
      MouseButtons.LEFT,
    );
    await harness.setup.renderOnce();
    expect(harness.mode()).toBe("collapsed");
    expect(harness.projection().dockBody.height).toBe(0);
    expect(stableFrame(harness.frame())).not.toContain("preferred");

    const reopen = harness.projection().actions.find((action) => action.id === "toggle-collapse")!;
    await harness.setup.mockMouse.click(
      reopen.x + Math.floor(reopen.width / 2),
      harness.projection().dockTabs.y,
      MouseButtons.LEFT,
    );
    await harness.setup.renderOnce();
    expect(harness.mode()).toBe("open");

    const maximize = harness
      .projection()
      .actions.find((action) => action.id === "toggle-maximize")!;
    await harness.setup.mockMouse.click(
      maximize.x + Math.floor(maximize.width / 2),
      harness.projection().dockTabs.y,
      MouseButtons.LEFT,
    );
    await harness.setup.renderOnce();
    expect(harness.mode()).toBe("maximized");
    expect(harness.projection().canvas.height).toBe(0);

    harness.setup.mockInput.pressTab();
    await harness.setup.renderOnce();
    expect(harness.focus()).toBe("canvas");
    expect(harness.projection().focusZone).toBe("dock-body");
    expect(harness.calls).toEqual([
      "mouse:tab:files",
      "mouse:action:toggle-collapse",
      "mouse:action:toggle-collapse",
      "mouse:action:toggle-maximize",
      "keyboard:canvas",
    ]);
  });
});
