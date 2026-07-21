/* @jsxImportSource @opentui/solid */
import { MouseButtons } from "@opentui/core/testing";
import { useKeyboard } from "@opentui/solid";
import { createSignal } from "solid-js";
import { describe, expect, it } from "bun:test";
import { WorkbenchDockPresenter } from "../../../ui/workbench-dock/presenter.tsx";
import {
  createWorkbenchDockHostFixture,
  createWorkbenchDockHostTrace,
  EXPECTED_WORKBENCH_DOCK_HOST_TRACE,
  EXPECTED_WORKBENCH_DOCK_KEYBOARD_TRACE,
} from "../../../ui/workbench-dock/fixture.ts";
import { createSemanticThemeSnapshot } from "../theme.ts";
import { renderForTest, stableFrame } from "../testing/renderer-harness.test.ts";
import { createOpenTuiWorkbenchDockHost } from "./workbench-dock-opentui.tsx";
import { workbenchDockNavigationTarget, type WorkbenchDockTabId } from "./workbench-shell.ts";

describe("shared WorkbenchDockPresenter OpenTUI host", () => {
  it("renders the common fixture and records the common activation trace", async () => {
    const projection = createWorkbenchDockHostFixture();
    const trace = createWorkbenchDockHostTrace();
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const host = createOpenTuiWorkbenchDockHost(() => theme);
    const setup = await renderForTest(
      () => (
        <box width={projection.dock.width} height={projection.dock.height} overflow="hidden">
          <WorkbenchDockPresenter
            projection={projection}
            host={host}
            onTabActivate={trace.onTabActivate}
            onActionActivate={trace.onActionActivate}
            body={<text>shared dock body</text>}
          />
        </box>
      ),
      { width: projection.dock.width, height: projection.dock.height },
    );
    await setup.renderOnce();

    const frame = stableFrame(setup.captureCharFrame());
    expect(frame).toContain("Missions");
    expect(frame).toContain("Activity");
    expect(frame).toContain("shared dock body");

    const files = projection.tabs.find((tab) => tab.id === "files")!;
    const collapse = projection.actions.find((action) => action.id === "toggle-collapse")!;
    const maximize = projection.actions.find((action) => action.id === "toggle-maximize")!;
    for (const target of [files, collapse, maximize]) {
      await setup.mockMouse.click(
        target.x + Math.max(0, Math.floor(target.width / 2)),
        0,
        MouseButtons.LEFT,
      );
    }
    expect(trace.calls).toEqual(EXPECTED_WORKBENCH_DOCK_HOST_TRACE);

    const disabled = projection.tabs.find((tab) => tab.id === "changes")!;
    await setup.mockMouse.click(
      disabled.x + Math.max(0, Math.floor(disabled.width / 2)),
      0,
      MouseButtons.LEFT,
    );
    expect(trace.calls).toEqual(EXPECTED_WORKBENCH_DOCK_HOST_TRACE);
  });

  it("routes real arrow input through the same automatic-activation trace as the DOM host", async () => {
    const trace = createWorkbenchDockHostTrace();
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const host = createOpenTuiWorkbenchDockHost(() => theme);

    function Harness() {
      const [active, setActive] = createSignal<WorkbenchDockTabId>("missions");
      const projection = () => createWorkbenchDockHostFixture({ activeDockTab: active() });
      useKeyboard((event) => {
        const target = workbenchDockNavigationTarget(projection().tabs, active(), event);
        if (!target) return;
        setActive(target);
        trace.onTabActivate(target);
      });
      return (
        <box width={80} height={24} overflow="hidden">
          <WorkbenchDockPresenter
            projection={projection()}
            host={host}
            onTabActivate={trace.onTabActivate}
            body={<text>shared dock body</text>}
          />
        </box>
      );
    }

    const setup = await renderForTest(() => <Harness />, { width: 80, height: 24 });
    await setup.renderOnce();
    setup.mockInput.pressArrow("left");
    await setup.renderOnce();
    setup.mockInput.pressArrow("right");
    await setup.renderOnce();
    setup.mockInput.pressArrow("right");
    await setup.renderOnce();

    expect(trace.calls).toEqual(EXPECTED_WORKBENCH_DOCK_KEYBOARD_TRACE);
  });
});
