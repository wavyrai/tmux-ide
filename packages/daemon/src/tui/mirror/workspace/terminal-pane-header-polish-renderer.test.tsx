/* @jsxImportSource @opentui/solid */
import { MouseButtons } from "@opentui/core/testing";
import { useKeyboard, type JSX } from "@opentui/solid";
import { describe, expect, it } from "bun:test";
import { createSignal, onCleanup } from "solid-js";

import { colorToThemeBytes, createSemanticThemeSnapshot } from "../theme.ts";
import { renderForTest, stableFrame } from "../testing/renderer-harness.test.ts";
import { componentPalette } from "../ui/index.ts";
import { createKeyboardRouteOwner, KeyboardRouteProvider } from "../ui/keyboard-router.tsx";
import { PaneTitleBar, type PaneTitleBarProps } from "./terminal-pane-header.tsx";
import { PaneActionMenu, type PaneMenuActionId } from "./pane-action-menu.tsx";
import { expectFrameBounds } from "../testing/renderer-harness.test.ts";

const colorKey = (color: Parameters<typeof colorToThemeBytes>[0]) =>
  JSON.stringify(colorToThemeBytes(color));

function KeyboardHost(props: { children: JSX.Element }) {
  const owner = createKeyboardRouteOwner();
  onCleanup(() => owner.dispose());
  useKeyboard((event) => owner.route(event));
  return <KeyboardRouteProvider owner={owner}>{props.children}</KeyboardRouteProvider>;
}

async function header(mode: "dark" | "light", overrides: Partial<PaneTitleBarProps> = {}) {
  const theme = createSemanticThemeSnapshot({ mode });
  const props: PaneTitleBarProps = {
    theme,
    paneId: "pane.polish",
    title: "Agent name",
    width: 40,
    selected: false,
    terminalFocused: false,
    keyboardFocused: false,
    menuAnchor: { x: 39, y: 0 },
    onSelectIntent: () => undefined,
    onMenuIntent: () => undefined,
    ...overrides,
  };
  const setup = await renderForTest(
    () => (
      <KeyboardHost>
        <box width={props.width} height={2}>
          <PaneTitleBar {...props} />
          <text position="absolute" top={1}>
            terminal body
          </text>
        </box>
      </KeyboardHost>
    ),
    { width: props.width, height: 2 },
  );
  await setup.renderOnce();
  const title = () =>
    setup.captureSpans().lines[0]!.spans.find((s) => s.text.includes("Agent name"))!;
  return { setup, theme, props, title };
}

describe("pane title hierarchy polish", () => {
  it("keeps tiny and Unicode headers cell-bounded and renders full status labels when they fit", async () => {
    for (const width of [1, 2, 4, 6, 7, 8, 20, 26, 80, 120]) {
      const { setup } = await header("dark", {
        width,
        title: "分析 Café agent with a long title",
        selected: true,
        activity: "running",
      });
      expectFrameBounds(setup.captureCharFrame(), width, 2);
      if (width >= 26) expect(setup.captureCharFrame()).toContain("working");
      setup.renderer.destroy();
    }
  });
  for (const mode of ["dark", "light"] as const) {
    it(`${mode}: live pointer hover reveals actions without moving the title or selecting the pane`, async () => {
      let selected = 0;
      const { setup, theme, title } = await header(mode, { onSelectIntent: () => selected++ });
      const before = stableFrame(setup.captureCharFrame());
      expect(before).not.toContain("⋯");
      await setup.mockMouse.moveTo(8, 0);
      await setup.renderOnce();
      const hover = stableFrame(setup.captureCharFrame());
      expect(hover).toContain("⋯");
      expect(hover.indexOf("Agent name")).toBe(before.indexOf("Agent name"));
      expect(colorKey(title().bg)).toBe(colorKey(theme.roles.selection.hover));
      expect(title().attributes & 1).toBe(0);
      expect(selected).toBe(0);
      // Moving between children of a header keeps the action slot visible.
      await setup.mockMouse.moveTo(38, 0);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("⋯");
      await setup.mockMouse.moveTo(8, 1);
      await setup.renderOnce();
      expect(stableFrame(setup.captureCharFrame())).toBe(before);
      setup.renderer.destroy();
    });

    it(`${mode}: menu state and disabled state keep the title/action geometry fixed`, async () => {
      for (const state of [{ menuOpen: true }, { menuDisabled: true, hovered: true }]) {
        const calls: unknown[] = [];
        const { setup } = await header(mode, {
          ...state,
          onMenuIntent: (anchor) => calls.push(anchor),
        });
        const line = stableFrame(setup.captureCharFrame()).split("\n")[0]!;
        expect(line.indexOf("Agent name")).toBe(4);
        expect(line.indexOf("⋯")).toBe(38);
        if ("menuDisabled" in state) {
          await setup.mockMouse.click(38, 0, MouseButtons.LEFT);
          await setup.mockMouse.click(8, 0, MouseButtons.RIGHT);
          expect(calls).toEqual([]);
        }
        setup.renderer.destroy();
      }
    });

    it(`${mode}: pane menu hover and keyboard selection share stable rows with visible shortcuts`, async () => {
      const theme = createSemanticThemeSnapshot({ mode });
      let select!: (id: PaneMenuActionId) => void;
      const actions: PaneMenuActionId[] = [];
      const setup = await renderForTest(
        () => {
          const [selected, setSelected] = createSignal<PaneMenuActionId>("select-text");
          select = setSelected;
          return (
            <PaneActionMenu
              theme={theme}
              paneTitle="Agent workspace"
              left={0}
              top={0}
              width={36}
              viewportWidth={32}
              viewportHeight={12}
              active
              selectedId={selected()}
              closeArmed={false}
              onHighlight={setSelected}
              onActionIntent={(id) => actions.push(id)}
            />
          );
        },
        { width: 32, height: 12 },
      );
      await setup.renderOnce();
      const rename = () =>
        stableFrame(setup.captureCharFrame())
          .split("\n")
          .find((line) => line.includes("Rename pane"))!;
      const before = rename();
      expect(before).toContain("R");
      const row = setup.renderer.root.findDescendantById("ui-overlay-row:rename-pane")!;
      expect(row).toBeDefined();
      await setup.mockMouse.moveTo(row.x + 4, row.y);
      await setup.renderOnce();
      expect(rename()).toContain("›");
      expect(rename().indexOf("Rename pane")).toBe(before.indexOf("Rename pane"));
      select("split-down");
      await setup.renderOnce();
      expect(rename()).not.toContain("›");
      expect(setup.renderer.root.findDescendantById("ui-overlay-row:rename-pane")).toBe(row);
      await setup.mockMouse.moveTo(row.x + 5, row.y);
      await setup.renderOnce();
      expect(rename()).toContain("›");
      await setup.mockMouse.click(row.x + 5, row.y, MouseButtons.LEFT);
      expect(actions).toEqual(["rename-pane"]);
      expect(stableFrame(setup.captureCharFrame())).toMatchSnapshot();
      setup.renderer.destroy();
    });

    it(`${mode}: quiets only inactive titles, not hover or attention`, async () => {
      for (const state of [{}, { hovered: true }, { attention: true }]) {
        const { setup, theme, title } = await header(mode, state);
        const palette = componentPalette(theme, state);
        expect(colorKey(title().fg)).toBe(
          colorKey(
            "hovered" in state || "attention" in state
              ? palette.foreground
              : theme.roles.text.secondary,
          ),
        );
        expect(title().attributes & 1).toBe(0);
        expect(colorKey(title().bg)).toBe(colorKey(palette.background));
        setup.renderer.destroy();
      }
    });

    it(`${mode}: selection and either focus emphasize the title independently`, async () => {
      for (const state of [
        { selected: true },
        { keyboardFocused: true },
        { terminalFocused: true },
      ]) {
        const { setup, theme, title } = await header(mode, state);
        const palette = componentPalette(theme, {
          selected: "selected" in state,
          focused: "keyboardFocused" in state || "terminalFocused" in state,
        });
        expect(colorKey(title().fg)).toBe(colorKey(palette.foreground));
        expect(title().attributes & 1).toBe(1);
        expect(colorKey(title().bg)).toBe(colorKey(palette.background));
        setup.renderer.destroy();
      }
    });

    it(`${mode}: retains agent status and attention styling independently of title emphasis`, async () => {
      for (const selected of [false, true]) {
        const { setup, theme } = await header(mode, {
          activity: "waiting",
          attention: true,
          selected,
        });
        const spans = setup.captureSpans().lines[0]!.spans;
        const badge = spans.find((span) => span.text.includes("block"))!;
        const palette = componentPalette(theme, { selected, status: "blocked", attention: true });
        expect(badge).toBeDefined();
        expect(colorKey(badge.bg)).toBe(colorKey(palette.background));
        expect(stableFrame(setup.captureCharFrame()).split("\n")[0]).toContain("!");
        setup.renderer.destroy();
      }
    });
  }

  it("preserves title/menu hit regions and leaves terminal-body input outside the header", async () => {
    let selected = 0;
    const menus: { x: number; y: number }[] = [];
    const { setup } = await header("dark", {
      menuFocused: true,
      menuAnchor: { x: 77, y: 13 },
      onSelectIntent: () => selected++,
      onMenuIntent: (anchor) => menus.push({ ...anchor }),
    });
    const lines = stableFrame(setup.captureCharFrame()).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]!.indexOf("Agent name")).toBe(4);
    expect(lines[0]!.indexOf("⋯")).toBe(38);
    expect(lines[1]).toBe("terminal body");
    await setup.mockMouse.click(6, 0, MouseButtons.LEFT);
    await setup.mockMouse.click(6, 1, MouseButtons.LEFT);
    expect(selected).toBe(1);
    await setup.mockMouse.click(38, 0, MouseButtons.LEFT);
    await setup.mockInput.pressEnter();
    await setup.mockMouse.click(6, 0, MouseButtons.RIGHT);
    expect(menus).toEqual([
      { x: 77, y: 13 },
      { x: 77, y: 13 },
      { x: 6, y: 0 },
    ]);
    expect(selected).toBe(1);
    setup.renderer.destroy();
  });
});
