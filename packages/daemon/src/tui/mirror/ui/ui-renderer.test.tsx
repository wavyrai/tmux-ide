/* @jsxImportSource @opentui/solid */
import { MouseButtons } from "@opentui/core/testing";
import { describe, expect, it } from "bun:test";

import { createSemanticThemeSnapshot } from "../theme.ts";
import { renderForTest, stableFrame } from "../testing/renderer-harness.test.ts";
import { Button, Dialog, StatusBar, StatusBarGroup, StatusBarSegment, Tabs } from "./index.ts";

describe("OpenTUI ui primitives", () => {
  it("composes tabs, buttons, and status segments with direct pointer ownership", async () => {
    const calls: string[] = [];
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const setup = await renderForTest(
      () => (
        <box width={60} height={4} flexDirection="column">
          <Tabs
            theme={theme}
            width={60}
            items={[
              { id: "shell", label: "shell" },
              { id: "agents", label: "agents", badge: "2", attention: true },
            ]}
            activeId="shell"
            onSelect={(id) => calls.push(`tab:${id}`)}
            onAdd={() => calls.push("add")}
          />
          <Button
            theme={theme}
            label="Commands"
            shortcut="F5"
            onPress={() => calls.push("button")}
          />
          <StatusBar theme={theme} width={60}>
            <StatusBarGroup grow>
              <StatusBarSegment theme={theme} label="tmux-ide · terminals" active />
            </StatusBarGroup>
            <StatusBarGroup>
              <StatusBarSegment theme={theme} label="F5 Commands" />
            </StatusBarGroup>
          </StatusBar>
        </box>
      ),
      { width: 60, height: 4 },
    );
    await setup.renderOnce();
    const frame = stableFrame(setup.captureCharFrame());
    expect(frame).toContain("shell");
    expect(frame).toContain("agents 2");
    expect(frame).toContain("Commands F5");
    expect(frame).toContain("tmux-ide · terminals");
    await setup.mockMouse.click(10, 0, MouseButtons.LEFT);
    await setup.mockMouse.click(58, 0, MouseButtons.LEFT);
    await setup.mockMouse.click(2, 1, MouseButtons.LEFT);
    expect(calls).toContain("tab:agents");
    expect(calls).toContain("add");
    expect(calls).toContain("button");
    setup.renderer.destroy();
  });

  it("provides one centered dialog frame for overlay content", async () => {
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const setup = await renderForTest(
      () => (
        <Dialog
          theme={theme}
          viewportWidth={60}
          viewportHeight={12}
          width={32}
          height={7}
          title="Command palette"
          footer="↑↓ choose · Enter open · Esc close"
          onDismiss={() => undefined}
        >
          <text fg={theme.roles.text.secondary}>› New terminal window</text>
        </Dialog>
      ),
      { width: 60, height: 12 },
    );
    await setup.renderOnce();
    const frame = stableFrame(setup.captureCharFrame());
    expect(frame).toContain("Command palette");
    expect(frame).toContain("New terminal window");
    expect(frame).toContain("Enter open · Esc");
    setup.renderer.destroy();
  });
});
