/* @jsxImportSource @opentui/solid */
import { MouseButtons } from "@opentui/core/testing";
import { describe, expect, it } from "bun:test";

import { createSemanticThemeSnapshot, colorToThemeBytes } from "../theme.ts";
import { renderForTest, stableFrame } from "../testing/renderer-harness.test.ts";
import {
  WINDOW_TAB_MAX_WIDTH,
  WINDOW_TAB_MIN_WIDTH,
  WindowTabBar,
  TerminalWindowStrip,
  windowTabBarLayout,
  type WindowTabItem,
} from "./terminal-window-strip.tsx";

const items = (count: number): WindowTabItem[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `window.${index}`,
    windowIndex: index,
    title: index === 1 ? "a-deliberately-long-agent-window-name" : `window-${index}`,
    agentStatus: index === 1 ? "working" : index === 2 ? "idle" : undefined,
    attention: index === 2,
    secondaryAction: true,
  }));

describe("WindowTabBar", () => {
  it("uses bounded content widths instead of equal viewport fractions", () => {
    const projection = windowTabBarLayout(items(3), "window.0", 120, "+ New window");
    expect(projection.hiddenCount).toBe(0);
    expect(projection.visible.map(({ width }) => width)).not.toEqual([36, 36, 36]);
    for (const tab of projection.visible) {
      expect(tab.width).toBeGreaterThanOrEqual(WINDOW_TAB_MIN_WIDTH);
      expect(tab.width).toBeLessThanOrEqual(WINDOW_TAB_MAX_WIDTH);
    }
    expect(projection.visible[1]!.width).toBe(WINDOW_TAB_MAX_WIDTH);
  });

  it("keeps the active tab and add affordance in-budget under deterministic narrow overflow", () => {
    const first = windowTabBarLayout(items(8), "window.5", 34, "+");
    const second = windowTabBarLayout(items(8), "window.5", 34, "+");
    expect(first).toEqual(second);
    expect(first.hiddenCount).toBeGreaterThan(0);
    expect(first.visible.some(({ item }) => item.id === "window.5")).toBe(true);
    expect(
      first.visible.reduce((sum, tab) => sum + tab.width, 0) + first.overflowWidth + first.addWidth,
    ).toBeLessThanOrEqual(34);
  });

  it("renders separated title, agent state, attention, secondary, overflow, and add controls", async () => {
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const setup = await renderForTest(
      () => (
        <WindowTabBar
          theme={theme}
          width={100}
          items={items(5)}
          activeId="window.1"
          hoveredId="window.2"
          onActivateIntent={() => undefined}
          onAddIntent={() => undefined}
          onSecondaryIntent={() => undefined}
        />
      ),
      { width: 100, height: 1 },
    );
    await setup.renderOnce();
    const frame = stableFrame(setup.captureCharFrame());
    expect(frame).toContain("a-deliberately");
    expect(frame).toContain("workin…");
    expect(frame).toContain("…");
    expect(frame).toContain("+");
    const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
    const selected = spans.find((span) => span.text.includes("a-deliberately"));
    const key = (value: Parameters<typeof colorToThemeBytes>[0]) =>
      colorToThemeBytes(value).join(",");
    expect(key(selected!.bg)).toBe(key(theme.roles.selection.selection));
    setup.renderer.destroy();
  });

  it("routes tab, secondary, add, and keyboard activation by stable semantic id", async () => {
    const calls: string[] = [];
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const setup = await renderForTest(
      () => (
        <WindowTabBar
          theme={theme}
          width={72}
          items={items(2)}
          activeId="window.0"
          focused
          focusedId="window.1"
          onActivateIntent={(id) => calls.push(`activate:${id}`)}
          onAddIntent={() => calls.push("add")}
          onSecondaryIntent={(id) => calls.push(`secondary:${id}`)}
        />
      ),
      { width: 72, height: 1 },
    );
    await setup.renderOnce();
    const projection = windowTabBarLayout(items(2), "window.0", 72, "+ New window");
    await setup.mockMouse.click(2, 0, MouseButtons.LEFT);
    await setup.mockMouse.click(projection.visible[0]!.width + 2, 0, MouseButtons.LEFT);
    const secondStart = projection.visible[0]!.width;
    const secondAction = secondStart + projection.visible[1]!.width - 2;
    await setup.mockMouse.click(secondAction, 0, MouseButtons.LEFT);
    await setup.mockMouse.click(70, 0, MouseButtons.LEFT);
    await setup.mockInput.pressEnter();
    expect(calls).toContain("activate:window.0");
    expect(calls.filter((call) => call === "activate:window.1").length).toBeGreaterThanOrEqual(2);
    expect(calls).toContain("secondary:window.1");
    expect(calls).toContain("add");
    setup.renderer.destroy();
  });

  it("adapts a clicked semantic window to its exact authoritative window index", async () => {
    const calls: number[] = [];
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const setup = await renderForTest(
      () => (
        <TerminalWindowStrip
          theme={theme}
          width={48}
          hoveredIndex={null}
          tabs={[
            {
              index: 2,
              name: "editor",
              active: true,
              sync: false,
              semanticWindowId: "window.editor",
              activePaneId: "%11",
            },
            {
              index: 9,
              name: "agent",
              active: false,
              sync: false,
              semanticWindowId: "window.agent",
              activePaneId: "%42",
              status: "WORKING",
            },
          ]}
          onActivate={(index) => calls.push(index)}
          onNewWindow={() => undefined}
        />
      ),
      { width: 48, height: 1 },
    );
    await setup.renderOnce();
    const firstWidth = windowTabBarLayout(
      [
        { id: "window.editor", windowIndex: 2, title: "editor" },
        { id: "window.agent", windowIndex: 9, title: "agent", agentStatus: "working" },
      ],
      "window.editor",
      48,
      "+",
    ).visible[0]!.width;
    await setup.mockMouse.click(firstWidth + 2, 0, MouseButtons.LEFT);
    expect(calls).toEqual([9]);
    setup.renderer.destroy();
  });
});
