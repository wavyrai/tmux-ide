/* @jsxImportSource @opentui/solid */
import { MouseButtons } from "@opentui/core/testing";
import { describe, expect, it } from "bun:test";

import { createSemanticThemeSnapshot } from "../theme.ts";
import { renderForTest, stableFrame } from "../testing/renderer-harness.test.ts";
import { TerminalWindowStrip, type TerminalWindowTab } from "./terminal-window-strip.tsx";

const tabs: TerminalWindowTab[] = [
  {
    index: 0,
    name: "Editor",
    active: true,
    sync: false,
    semanticWindowId: "window.editor",
    activePaneId: "pane.editor",
  },
  {
    index: 1,
    name: "Tests",
    active: false,
    sync: false,
    semanticWindowId: "window.tests",
    activePaneId: "pane.tests",
  },
];

describe("TerminalWindowStrip", () => {
  it("gives every visible tab and the add button direct click ownership", async () => {
    const calls: string[] = [];
    const setup = await renderForTest(
      () => (
        <TerminalWindowStrip
          theme={createSemanticThemeSnapshot({ mode: "dark" })}
          tabs={tabs}
          hoveredIndex={null}
          onActivate={(index) => calls.push(`window:${index}`)}
          onNewWindow={() => calls.push("new")}
        />
      ),
      { width: 40, height: 2 },
    );
    await setup.renderOnce();
    expect(stableFrame(setup.captureCharFrame())).toContain("0:Editor   1:Tests   +");

    const firstStart = 1;
    const secondStart = firstStart + " 0:Editor ".length + 1;
    const addStart = secondStart + " 1:Tests ".length + 1;
    await setup.mockMouse.click(firstStart + 1, 0, MouseButtons.LEFT);
    await setup.mockMouse.click(secondStart + 1, 0, MouseButtons.LEFT);
    await setup.mockMouse.click(addStart + 1, 0, MouseButtons.LEFT);

    expect(calls).toEqual(["window:0", "window:1", "new"]);
  });
});
