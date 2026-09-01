/* @jsxImportSource @opentui/solid */
import { MouseButtons } from "@opentui/core/testing";
import { describe, expect, it } from "bun:test";

import { createSemanticThemeSnapshot } from "../theme.ts";
import { renderForTest, stableFrame } from "../testing/renderer-harness.test.ts";
import { PaneActionMenu, type PaneMenuActionId } from "./pane-action-menu.tsx";
import { PaneTitleBar } from "./terminal-pane-header.tsx";

describe("PaneTitleBar", () => {
  it("composes focus, clipped title, agent state, and one overflow control on one row", async () => {
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const setup = await renderForTest(
      () => (
        <PaneTitleBar
          theme={theme}
          paneId="pane.agent"
          title="a-very-long-agent-pane-title"
          width={28}
          selected
          terminalFocused
          keyboardFocused
          activity="running"
          attention={false}
          menuAnchor={{ x: 27, y: 0 }}
          onSelectIntent={() => undefined}
          onMenuIntent={() => undefined}
        />
      ),
      { width: 28, height: 1 },
    );
    await setup.renderOnce();
    const frame = stableFrame(setup.captureCharFrame());
    expect(frame.split("\n")).toHaveLength(1);
    expect(frame).toContain("●");
    expect(frame).toContain("a-very");
    expect(frame).toContain("workin");
    expect(frame.match(/⋯/g)).toHaveLength(1);
    setup.renderer.destroy();
  });

  it("keeps activity and attention separate from pane selection", async () => {
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const setup = await renderForTest(
      () => (
        <PaneTitleBar
          theme={theme}
          paneId="pane.blocked"
          title="review-agent"
          width={26}
          selected={false}
          terminalFocused={false}
          keyboardFocused={false}
          activity="waiting"
          attention
          menuAnchor={{ x: 25, y: 0 }}
          onSelectIntent={() => undefined}
          onMenuIntent={() => undefined}
        />
      ),
      { width: 26, height: 1 },
    );
    await setup.renderOnce();
    expect(stableFrame(setup.captureCharFrame())).toContain("block");
    setup.renderer.destroy();
  });

  it("keeps the focus marker when no agent activity is present", async () => {
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const setup = await renderForTest(
      () => (
        <PaneTitleBar
          theme={theme}
          paneId="pane.shell"
          title="pane.shell"
          width={28}
          selected
          terminalFocused
          keyboardFocused
          menuAnchor={{ x: 27, y: 0 }}
          onSelectIntent={() => undefined}
          onMenuIntent={() => undefined}
        />
      ),
      { width: 28, height: 1 },
    );
    await setup.renderOnce();
    expect(stableFrame(setup.captureCharFrame()).slice(2)).toStartWith("● pane.shell");
    setup.renderer.destroy();
  });

  it("stays bounded at tiny widths", async () => {
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    for (const width of [1, 2, 4, 6, 8]) {
      const setup = await renderForTest(
        () => (
          <PaneTitleBar
            theme={theme}
            paneId={`pane.${width}`}
            title="tiny-pane"
            width={width}
            selected={width % 2 === 0}
            terminalFocused={false}
            keyboardFocused={false}
            activity="running"
            attention
            menuAnchor={{ x: width - 1, y: 0 }}
            onSelectIntent={() => undefined}
            onMenuIntent={() => undefined}
          />
        ),
        { width, height: 1 },
      );
      await setup.renderOnce();
      const captured = stableFrame(setup.captureCharFrame());
      const line = captured.split("\n")[0]!;
      expect(Array.from(line).length).toBeLessThanOrEqual(width);
      expect(captured).not.toContain("\n");
      setup.renderer.destroy();
    }
  });

  it("routes right-click and overflow activation to the same menu intent", async () => {
    const calls: Array<{ x: number; y: number }> = [];
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const setup = await renderForTest(
      () => (
        <PaneTitleBar
          theme={theme}
          paneId="pane.route"
          title="route"
          width={20}
          selected
          terminalFocused
          keyboardFocused
          menuFocused
          menuAnchor={{ x: 77, y: 13 }}
          onSelectIntent={() => undefined}
          onMenuIntent={(anchor) => calls.push({ ...anchor })}
        />
      ),
      { width: 20, height: 1 },
    );
    await setup.renderOnce();
    await setup.mockMouse.click(3, 0, MouseButtons.RIGHT);
    await setup.mockMouse.click(18, 0, MouseButtons.LEFT);
    await setup.mockInput.pressEnter();
    expect(calls[0]).toEqual({ x: 3, y: 0 });
    expect(calls.slice(1)).toEqual([
      { x: 77, y: 13 },
      { x: 77, y: 13 },
    ]);
    setup.renderer.destroy();
  });

  it("presents the explicit close confirmation state", async () => {
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const setup = await renderForTest(
      () => (
        <PaneActionMenu
          theme={theme}
          paneTitle="pane.agent"
          left={2}
          top={1}
          width={24}
          viewportWidth={32}
          viewportHeight={12}
          active
          selectedId="close-pane"
          closeArmed
          onActionIntent={() => undefined}
        />
      ),
      { width: 32, height: 12 },
    );
    await setup.renderOnce();
    expect(stableFrame(setup.captureCharFrame())).toContain("Confirm close");
    setup.renderer.destroy();
  });

  it("routes a pane menu row pointer press by exact action id", async () => {
    const actions: PaneMenuActionId[] = [];
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const setup = await renderForTest(
      () => (
        <PaneActionMenu
          theme={theme}
          paneTitle="pane.agent"
          left={2}
          top={1}
          width={24}
          viewportWidth={32}
          viewportHeight={12}
          active
          selectedId="split-down"
          closeArmed={false}
          onActionIntent={(id) => actions.push(id)}
        />
      ),
      { width: 32, height: 12 },
    );
    await setup.renderOnce();
    await setup.mockMouse.click(10, 6, MouseButtons.LEFT);
    expect(actions).toEqual(["split-down"]);
    setup.renderer.destroy();
  });
});
