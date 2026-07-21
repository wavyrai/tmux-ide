/* @jsxImportSource @opentui/solid */
import { MouseButtons } from "@opentui/core/testing";
import { useKeyboard } from "@opentui/solid";
import { createSignal } from "solid-js";
import { describe, expect, it } from "bun:test";
import { SelectableRow } from "../recipes.tsx";
import { recipePalette } from "../recipes.ts";
import { colorToThemeBytes, createSemanticThemeSnapshot } from "../theme.ts";
import { expectFrameBounds, renderForTest, stableFrame } from "../testing/renderer-harness.test.ts";
import type { PaneFrameInput } from "./pane-frame.ts";
import { paneFrameHitTest, projectPaneFrame } from "./pane-frame.ts";
import { PaneFrame } from "./pane-frame.tsx";

const actions = [
  { id: "agent", label: "agent", compactLabel: "A", description: "Open agent controls" },
  { id: "mission", label: "mission", compactLabel: "M", description: "Open mission proof" },
  { id: "native", label: "native", compactLabel: "N", description: "Open native surface" },
] as const;

function colorKey(color: Parameters<typeof colorToThemeBytes>[0]): string {
  return colorToThemeBytes(color).join(",");
}

function spanContaining(
  setup: Awaited<ReturnType<typeof renderForTest>>,
  text: string,
  lineIndex?: number,
) {
  const lines =
    lineIndex === undefined ? setup.captureSpans().lines : [setup.captureSpans().lines[lineIndex]!];
  return lines.flatMap((line) => line.spans).find((span) => span.text.includes(text));
}

async function renderStaticPane(input: Omit<PaneFrameInput, "width" | "height">) {
  const theme = createSemanticThemeSnapshot({ mode: "dark" });
  const width = 120;
  const height = 40;
  const projection = projectPaneFrame({
    width,
    height,
    ...input,
  });
  const setup = await renderForTest(
    () => (
      <PaneFrame theme={theme} projection={projection}>
        <text fg={theme.colors.mutedForeground}> body keeps framebuffer ownership elsewhere</text>
      </PaneFrame>
    ),
    { width, height },
  );
  await setup.renderOnce();
  return { setup, theme, projection };
}

async function renderPane(width: number, height: number) {
  const theme = createSemanticThemeSnapshot({ mode: "dark" });
  const calls: string[] = [];
  let focusedValue = true;
  let statusValue = "working";
  let pressedValue: number | null = null;

  function Harness() {
    const [focused, setFocused] = createSignal(focusedValue);
    const [status, setStatus] = createSignal(statusValue);
    const [pressed, setPressed] = createSignal<number | null>(pressedValue);
    const projection = () =>
      projectPaneFrame({
        width,
        height,
        title: "Codex implementer",
        kind: "terminals",
        subtitle: "%7 · task/142-pane-frame",
        focused: focused(),
        terminalFocused: focused(),
        attention: status() === "blocked",
        dirty: true,
        windowEditSelected: status() === "blocked",
        floating: status() === "blocked",
        maximized: focused(),
        status: status(),
        statusTone: status() === "blocked" ? "blocked" : "working",
        pressedActionIndex: pressed(),
        actions,
      });
    useKeyboard((event) => {
      if (event.name === "f") {
        focusedValue = !focused();
        setFocused(focusedValue);
        calls.push("keyboard:focus");
      }
      if (event.name === "b") {
        statusValue = "blocked";
        setStatus(statusValue);
        calls.push("keyboard:block");
      }
    });
    return (
      <box
        width={width}
        height={height}
        overflow="hidden"
        onMouseDown={(event) => {
          const hit = paneFrameHitTest(projection(), event.x, event.y);
          if (hit?.area === "action") {
            pressedValue = hit.actionIndex;
            setPressed(pressedValue);
            calls.push(`mouse:${hit.actionId}`);
          }
        }}
        onMouseUp={() => {
          pressedValue = null;
          setPressed(null);
        }}
      >
        <PaneFrame theme={theme} projection={projection()}>
          <SelectableRow
            theme={theme}
            label="Mission: ship application-grade window chrome"
            meta="M31"
            width={Math.max(0, projection().body.width)}
            selected
          />
          <SelectableRow
            theme={theme}
            label="Task: PaneFrame projection and renderer"
            meta="running"
            width={Math.max(0, projection().body.width)}
            focused
          />
          <SelectableRow
            theme={theme}
            label="Harness: Codex"
            meta="gpt-5.5"
            width={Math.max(0, projection().body.width)}
            status="working"
            tone="working"
          />
          <text fg={theme.colors.mutedForeground}> terminal framebuffer remains opaque</text>
        </PaneFrame>
      </box>
    );
  }

  const setup = await renderForTest(() => <Harness />, { width, height });
  await setup.renderOnce();
  return {
    setup,
    calls,
    focused: () => focusedValue,
    status: () => statusValue,
    pressed: () => pressedValue,
    projection: () =>
      projectPaneFrame({
        width,
        height,
        title: "Codex implementer",
        kind: "terminals",
        subtitle: "%7 · task/142-pane-frame",
        focused: focusedValue,
        terminalFocused: focusedValue,
        attention: statusValue === "blocked",
        dirty: true,
        windowEditSelected: statusValue === "blocked",
        floating: statusValue === "blocked",
        maximized: focusedValue,
        status: statusValue,
        statusTone: statusValue === "blocked" ? "blocked" : "working",
        pressedActionIndex: pressedValue,
        actions,
      }),
    frame: () => setup.captureCharFrame(),
  };
}

describe("PaneFrame OpenTUI renderer", () => {
  it.each([
    [80, 24, "compact"],
    [120, 40, "standard"],
    [200, 60, "wide"],
  ] as const)("renders the %sx%s %s window chrome", async (width, height, variant) => {
    const harness = await renderPane(width, height);
    const frame = harness.frame();
    expectFrameBounds(frame, width, height);
    expect(harness.projection().variant).toBe(variant);
    expect(stableFrame(frame)).toMatchSnapshot();
    expect(stableFrame(frame)).toContain(harness.projection().titleSpan.text.slice(0, 8));
    expect(stableFrame(frame)).toContain(variant === "compact" ? "●" : "working");
    expect(stableFrame(frame)).toContain(variant === "compact" ? "A" : "agent");
    harness.setup.renderer.destroy();
  });

  it("routes projected action spans and keeps keyboard ownership in the harness", async () => {
    const harness = await renderPane(120, 40);
    const agent = harness.projection().actions.find((action) => action.id === "agent")!;
    await harness.setup.mockMouse.click(
      agent.start + Math.floor(agent.width / 2),
      harness.projection().header.y,
      MouseButtons.LEFT,
    );
    harness.setup.mockInput.pressKey("b");
    await harness.setup.renderOnce();
    expect(harness.status()).toBe("blocked");
    expect(stableFrame(harness.frame())).toContain("blocked");
    expect(stableFrame(harness.frame())).toContain("float");
    expect(harness.calls).toEqual(["mouse:agent", "keyboard:block"]);
    harness.setup.renderer.destroy();
  });

  it("pins rendered state-matrix glyphs, borders, and semantic header colors", async () => {
    const cases = [
      {
        label: "idle-unfocused",
        input: {
          title: "Idle agent",
          kind: "native",
          focused: false,
        },
        marker: "○",
        borderStart: "┌",
        paletteState: {},
      },
      {
        label: "keyboard-focus-attention",
        input: {
          title: "Keyboard mission attention",
          kind: "missions",
          focused: true,
          attention: true,
          status: "blocked",
          statusTone: "blocked",
        },
        marker: "!",
        borderStart: "┌",
        paletteState: { focused: true, attention: true },
      },
      {
        label: "terminal-focus-attention",
        input: {
          title: "Terminal agent attention",
          kind: "terminals",
          focused: false,
          terminalFocused: true,
          attention: true,
          status: "blocked",
          statusTone: "blocked",
        },
        marker: "▣",
        borderStart: "┌",
        paletteState: { focused: true, attention: true },
      },
      {
        label: "edit-floating-maximized",
        input: {
          title: "Mission native surface",
          kind: "native",
          focused: false,
          terminalFocused: true,
          attention: true,
          windowEditSelected: true,
          floating: true,
          maximized: true,
          status: "blocked",
          statusTone: "blocked",
          actions,
        },
        marker: "◇",
        borderStart: "┏",
        paletteState: { selected: true, focused: true, attention: true },
      },
    ] as const;

    for (const { label, input, marker, borderStart, paletteState } of cases) {
      const { setup, theme, projection } = await renderStaticPane(input);
      const stable = stableFrame(setup.captureCharFrame());
      expect(stable, label).toMatchSnapshot();
      expect(stable.startsWith(borderStart), label).toBe(true);
      expect(projection.marker, label).toBe(marker);
      expect(projection.titleSpan.text, label).toContain(marker);
      const palette = recipePalette(theme, paletteState);
      const borderSpan = setup.captureSpans().lines[0]!.spans[0]!;
      expect(colorKey(borderSpan.fg), label).toBe(colorKey(palette.border));
      const titleSpan = spanContaining(setup, projection.titleSpan.text, projection.header.y);
      expect(titleSpan, label).toBeDefined();
      const nativeFocused = projection.focused || projection.terminalFocused;
      expect(colorKey(titleSpan!.fg), label).toBe(
        colorKey(nativeFocused ? theme.roles.text.primary : theme.roles.text.muted),
      );
      expect(colorKey(titleSpan!.bg), label).toBe(
        colorKey(nativeFocused ? theme.roles.surfaces.headerActive : palette.background),
      );
      if (label === "edit-floating-maximized") {
        expect(stable).toContain("edit");
        expect(stable).toContain("float");
        expect(stable).toContain("max");
      }
      setup.renderer.destroy();
    }
  });

  it("pins disabled, hovered, and mouse-down pressed action states before release", async () => {
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const calls: string[] = [];
    let pressedValue: number | null = null;

    function Harness() {
      const [pressed, setPressed] = createSignal<number | null>(pressedValue);
      const projection = () =>
        projectPaneFrame({
          width: 120,
          height: 40,
          title: "Action state matrix",
          kind: "native",
          focused: true,
          hoveredActionIndex: 0,
          pressedActionIndex: pressed(),
          actions: [actions[0], { ...actions[1], disabled: true }, actions[2]],
        });
      return (
        <box
          width={120}
          height={40}
          overflow="hidden"
          onMouseDown={(event) => {
            const hit = paneFrameHitTest(projection(), event.x, event.y);
            if (hit?.area === "action") {
              pressedValue = hit.actionIndex;
              setPressed(pressedValue);
              calls.push(`down:${hit.actionId}`);
            }
          }}
          onMouseUp={() => {
            pressedValue = null;
            setPressed(null);
            calls.push("up");
          }}
        >
          <PaneFrame theme={theme} projection={projection()}>
            <text fg={theme.colors.mutedForeground}> action state evidence</text>
          </PaneFrame>
        </box>
      );
    }

    const setup = await renderForTest(() => <Harness />, { width: 120, height: 40 });
    await setup.renderOnce();
    const initialProjection = projectPaneFrame({
      width: 120,
      height: 40,
      title: "Action state matrix",
      kind: "native",
      focused: true,
      hoveredActionIndex: 0,
      actions: [actions[0], { ...actions[1], disabled: true }, actions[2]],
    });
    const hoveredPalette = recipePalette(theme, { hovered: true });
    const disabledPalette = recipePalette(theme, { disabled: true });
    const hoveredLabel = spanContaining(setup, " agent ", initialProjection.header.y);
    const disabledLabel = spanContaining(setup, " mission ", initialProjection.header.y);
    const disabledMarker = spanContaining(setup, "×", initialProjection.header.y);
    expect(hoveredLabel).toBeDefined();
    expect(disabledLabel).toBeDefined();
    expect(disabledMarker).toBeDefined();
    expect(colorKey(hoveredLabel!.bg)).toBe(colorKey(hoveredPalette.background));
    expect(colorKey(disabledLabel!.fg)).toBe(colorKey(disabledPalette.foreground));
    expect(colorKey(disabledMarker!.fg)).toBe(colorKey(disabledPalette.accent));

    const native = initialProjection.actions.find((action) => action.id === "native")!;
    await setup.mockMouse.pressDown(
      native.start + Math.floor(native.width / 2),
      initialProjection.header.y,
      MouseButtons.LEFT,
    );
    await setup.renderOnce();
    const pressedFrame = stableFrame(setup.captureCharFrame());
    expect(pressedFrame).toMatchSnapshot();
    expect(calls).toEqual(["down:native"]);
    expect(pressedValue).toBe(2);
    const pressedPalette = recipePalette(theme, { pressed: true });
    const pressedLabel = spanContaining(setup, " native ", initialProjection.header.y);
    const pressedMarker = spanContaining(setup, "◆", initialProjection.header.y);
    expect(pressedLabel).toBeDefined();
    expect(pressedMarker).toBeDefined();
    expect(colorKey(pressedLabel!.bg)).toBe(colorKey(pressedPalette.background));
    expect(colorKey(pressedLabel!.fg)).toBe(colorKey(pressedPalette.foreground));
    expect(colorKey(pressedMarker!.fg)).toBe(colorKey(pressedPalette.accent));

    await setup.mockMouse.release(
      native.start + Math.floor(native.width / 2),
      initialProjection.header.y,
      MouseButtons.LEFT,
    );
    await setup.renderOnce();
    expect(calls).toEqual(["down:native", "up"]);
    expect(pressedValue).toBeNull();
    expect(stableFrame(setup.captureCharFrame())).not.toContain("◆ native");
    setup.renderer.destroy();
  });

  it("pins native icon base, hover, disabled, pressed, and hidden states", async () => {
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const iconActions = [
      { id: "maximize", label: "maximize", icon: "maximize", description: "Maximize" },
      { id: "menu", label: "more", icon: "more", description: "More actions" },
      { id: "close", label: "close", icon: "close", description: "Close", disabled: true },
      { id: "resize", label: "resize", icon: "resize", description: "Resize" },
      { id: "dock", label: "dock", icon: "dock", description: "Dock", hidden: true },
    ] as const;
    const projection = projectPaneFrame({
      width: 120,
      height: 8,
      title: "Icon action state matrix",
      kind: "terminals",
      focused: true,
      terminalFocused: true,
      hoveredActionIndex: 1,
      pressedActionIndex: 3,
      actions: iconActions,
    });
    const setup = await renderForTest(
      () => (
        <PaneFrame theme={theme} projection={projection}>
          <text> icon state evidence</text>
        </PaneFrame>
      ),
      { width: 120, height: 8 },
    );
    await setup.renderOnce();

    const base = spanContaining(setup, "□", projection.header.y)!;
    const hovered = spanContaining(setup, "⋯", projection.header.y)!;
    const disabled = spanContaining(setup, "×", projection.header.y)!;
    const pressed = spanContaining(setup, "◲", projection.header.y)!;
    expect(colorKey(base.bg)).toBe(colorKey(theme.roles.surfaces.headerActive));
    expect(colorKey(base.fg)).toBe(colorKey(theme.roles.text.muted));
    expect(colorKey(hovered.bg)).toBe(colorKey(recipePalette(theme, { hovered: true }).background));
    expect(colorKey(disabled.fg)).toBe(
      colorKey(recipePalette(theme, { disabled: true }).foreground),
    );
    expect(colorKey(pressed.bg)).toBe(colorKey(recipePalette(theme, { pressed: true }).background));
    expect(stableFrame(setup.captureCharFrame())).not.toContain("▤");
    const hidden = projection.actions.find((action) => action.id === "dock")!;
    expect(
      paneFrameHitTest(
        projection,
        hidden.start + Math.floor(hidden.width / 2),
        projection.header.y,
      ),
    ).toMatchObject({ area: "action", actionId: "dock" });
    setup.renderer.destroy();
  });
});
