/* @jsxImportSource @opentui/solid */
import { MouseButtons } from "@opentui/core/testing";
import { useKeyboard } from "@opentui/solid";
import { createSignal } from "solid-js";
import { describe, expect, it } from "bun:test";

import { createSemanticThemeSnapshot } from "../theme.ts";
import { colorToThemeBytes } from "../theme.ts";
import { terminalDisplayWidth } from "../terminal-text.ts";
import { renderForTest, stableFrame } from "../testing/renderer-harness.test.ts";
import {
  AgentBadge,
  Button,
  Dialog,
  KeyHint,
  NavigationRow,
  OverlayFrame,
  OverlayHost,
  OverlayListRow,
  overlayEscapeTarget,
  StatusBar,
  StatusBarGroup,
  StatusBarSegment,
  StatusSegment,
  Surface,
  Tabs,
  TuiButton,
} from "./index.ts";

describe("OpenTUI ui primitives", () => {
  const colorKey = (color: Parameters<typeof colorToThemeBytes>[0]) =>
    colorToThemeBytes(color).join(",");

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

  it("paints light-mode glyph cells with the semantic surface owned by each primitive", async () => {
    const theme = createSemanticThemeSnapshot({ mode: "light" });
    const setup = await renderForTest(
      () => (
        <box width={60} height={4} flexDirection="column">
          <Tabs
            theme={theme}
            width={60}
            items={[
              { id: "shell", label: "shell" },
              { id: "agents", label: "agents" },
            ]}
            activeId="shell"
            onSelect={() => undefined}
            onAdd={() => undefined}
          />
          <Button theme={theme} label="Ghost" variant="ghost" onPress={() => undefined} />
          <StatusBar theme={theme} width={60}>
            <StatusBarGroup grow>
              <StatusBarSegment theme={theme} label="neutral status" />
            </StatusBarGroup>
          </StatusBar>
        </box>
      ),
      { width: 60, height: 4 },
    );
    await setup.renderOnce();
    const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
    const inactiveTab = spans.find((span) => span.text.includes("agents"));
    const addButton = spans.find((span) => span.text.includes("+"));
    const ghostButton = spans.find((span) => span.text.includes("Ghost"));
    const status = spans.find((span) => span.text.includes("neutral status"));
    expect(colorKey(inactiveTab!.bg)).toBe(colorKey(theme.roles.surfaces.panel));
    expect(colorKey(addButton!.bg)).toBe(colorKey(theme.roles.surfaces.panel));
    expect(colorKey(ghostButton!.bg)).toBe(colorKey(theme.roles.surfaces.panel));
    expect(colorKey(status!.bg)).toBe(colorKey(theme.roles.surfaces.header));
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

  it("dispatches one semantic callback for pointer, Enter, and Space and blocks disabled activation", async () => {
    const calls: string[] = [];
    let bubbled = 0;
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const setup = await renderForTest(
      () => (
        <box width={40} height={3} onMouseDown={() => bubbled++}>
          <TuiButton
            theme={theme}
            label="Create window"
            focused
            width={20}
            onPress={() => calls.push("activate")}
          />
          <TuiButton
            theme={theme}
            label="Unavailable"
            disabled
            focused
            width={20}
            onPress={() => calls.push("disabled")}
          />
        </box>
      ),
      { width: 40, height: 3 },
    );
    await setup.renderOnce();
    await setup.mockMouse.click(2, 0, MouseButtons.LEFT);
    await setup.mockMouse.click(2, 1, MouseButtons.LEFT);
    await setup.mockInput.pressEnter();
    await setup.mockInput.pressKey(" ");
    expect(calls).toEqual(["activate", "activate", "activate"]);
    expect(bubbled).toBe(0);
    setup.renderer.destroy();
  });

  it("keeps navigation-row pointer and keyboard activation on the same typed path", async () => {
    const calls: string[] = [];
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const setup = await renderForTest(
      () => (
        <box width={40} height={2} flexDirection="column">
          <NavigationRow
            theme={theme}
            id="agent:codex"
            label="Codex"
            detail="[WORKING]"
            width={40}
            focused
            status="working"
            onActivate={(source) => calls.push(source)}
          />
          <NavigationRow
            theme={theme}
            id="agent:disabled"
            label="Unavailable"
            width={40}
            disabled
            onActivate={(source) => calls.push(`disabled:${source}`)}
          />
        </box>
      ),
      { width: 40, height: 2 },
    );
    await setup.renderOnce();
    await setup.mockMouse.click(4, 0, MouseButtons.LEFT);
    await setup.mockMouse.click(4, 1, MouseButtons.LEFT);
    await setup.mockInput.pressEnter();
    expect(calls).toEqual(["mouse", "keyboard"]);
    setup.renderer.destroy();
  });

  it.each([80, 120, 200])(
    "keeps semantic primitives cell-aligned and clipped at the %i-column golden viewport",
    async (width) => {
      const theme = createSemanticThemeSnapshot({ mode: "light" });
      const setup = await renderForTest(
        () => (
          <Surface theme={theme} variant="header" width={width} height={1} flexDirection="row">
            <KeyHint
              theme={theme}
              keys="F5"
              label="Commands with a deliberately long responsive label"
              width={width - 18}
            />
            <StatusSegment theme={theme} label="ready" tone="done" width={10} />
            <AgentBadge theme={theme} label="agent" status="working" width={8} />
          </Surface>
        ),
        { width, height: 1 },
      );
      await setup.renderOnce();
      const line = setup.captureCharFrame().split("\n")[0]!;
      expect(terminalDisplayWidth(line)).toBe(width);
      expect(line).toContain("F5 Commands");
      expect(line).toContain("ready");
      expect(line).toContain("agen…");
      setup.renderer.destroy();
    },
  );

  it("renders destructive and attention treatments from semantic roles", async () => {
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const setup = await renderForTest(
      () => (
        <box width={48} height={2} flexDirection="column">
          <TuiButton
            theme={theme}
            label="Close pane"
            variant="danger"
            selected
            attention
            width={18}
            onPress={() => undefined}
          />
          <AgentBadge theme={theme} label="Claude" status="blocked" selected width={18} />
        </box>
      ),
      { width: 48, height: 2 },
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("! Close pane");
    expect(frame).toContain("! Claude");
    const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
    const button = spans.find((span) => span.text.includes("Close pane"));
    expect(colorKey(button!.bg)).toBe(colorKey(theme.roles.selection.selection));
    expect(colorKey(button!.fg)).toBe(colorKey(theme.roles.selection.selectionText));
    setup.renderer.destroy();
  });

  it("keeps overlay frames inset and captures outside pointer dismissal", async () => {
    let dismissed = 0;
    let bubbled = 0;
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const setup = await renderForTest(
      () => (
        <box width={24} height={8} onMouseDown={() => bubbled++}>
          <OverlayFrame
            theme={theme}
            viewportWidth={24}
            viewportHeight={8}
            width={40}
            height={12}
            title="Rename agent"
            footer="Enter save"
            onDismiss={() => dismissed++}
          >
            <text fg={theme.roles.text.secondary}>draft</text>
          </OverlayFrame>
        </box>
      ),
      { width: 24, height: 8 },
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame.split("\n")[1]?.startsWith(" ")).toBe(true);
    expect(frame).toContain("Rename agent");
    await setup.mockMouse.click(0, 0, MouseButtons.LEFT);
    await setup.mockMouse.click(4, 3, MouseButtons.LEFT);
    expect(dismissed).toBe(1);
    expect(bubbled).toBe(0);
    setup.renderer.destroy();
  });

  it.each([80, 120, 200])(
    "admits only the top overlay, restores focus, and stays bounded at %i columns",
    async (width) => {
      const dismissed: string[] = [];
      const activated: string[] = [];
      const restored: string[] = [];
      const theme = createSemanticThemeSnapshot({ mode: "dark" });
      function Harness() {
        const [ids, setIds] = createSignal(["palette", "rename"]);
        const dismiss = (id: string) => {
          dismissed.push(id);
          setIds((current) => current.filter((candidate) => candidate !== id));
        };
        useKeyboard((event) => {
          if (event.name === "down") activated.push(`keyboard:${ids().at(-1)}`);
          const escape = overlayEscapeTarget(
            ids().map((id) => ({ id })),
            event.name,
          );
          if (escape) dismiss(escape);
        });
        const layers = () =>
          ids().map((id) => ({
            id,
            render: ({ active, zIndex }: { active: boolean; zIndex: number }) => (
              <OverlayFrame
                theme={theme}
                viewportWidth={width}
                viewportHeight={24}
                width={id === "palette" ? 58 : 42}
                height={7}
                title={id}
                active={active}
                zIndex={zIndex}
                onDismiss={() => dismiss(id)}
              >
                <OverlayListRow
                  theme={theme}
                  id={`${id}:row`}
                  label={`${id} action`}
                  width={Math.min(id === "palette" ? 54 : 38, width - 6)}
                  selected
                  onPress={() => activated.push(`pointer:${id}`)}
                />
              </OverlayFrame>
            ),
          }));
        return (
          <OverlayHost
            width={width}
            height={24}
            layers={layers()}
            ownsEscape={false}
            captureFocus={() => "pane:%7"}
            isFocusMounted={() => true}
            restoreFocus={(id) => restored.push(id)}
            onDismiss={(id) => dismiss(id)}
          />
        );
      }
      const setup = await renderForTest(() => <Harness />, { width, height: 24 });
      await setup.renderOnce();
      expect(stableFrame(setup.captureCharFrame())).toContain("rename action");
      expect(terminalDisplayWidth(setup.captureCharFrame().split("\n")[0]!)).toBe(width);

      await setup.mockInput.pressArrow("down");
      await setup.mockMouse.click(Math.floor((width - 42) / 2) + 3, 10, MouseButtons.LEFT);
      await setup.renderOnce();
      expect(activated).toEqual(["keyboard:rename", "pointer:rename"]);
      setup.mockInput.pressEscape();
      await new Promise((resolve) => setTimeout(resolve, 30));
      await setup.renderOnce();
      expect(dismissed).toEqual(["rename"]);
      await setup.mockMouse.click(0, 0, MouseButtons.LEFT);
      await setup.renderOnce();
      expect(dismissed).toEqual(["rename", "palette"]);
      expect(restored).toEqual(["pane:%7"]);
      setup.renderer.destroy();
    },
  );
});
