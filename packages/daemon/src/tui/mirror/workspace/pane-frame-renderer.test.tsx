/* @jsxImportSource @opentui/solid */
import { MouseButtons } from "@opentui/core/testing";
import { useKeyboard } from "@opentui/solid";
import {
  COHESION_FIXTURE_V1,
  projectApplicationShellV1,
  type PaneVisualStateV1,
} from "@tmux-ide/contracts";
import { createSignal } from "solid-js";
import { describe, expect, it } from "bun:test";
import { SelectableRow } from "../recipes.tsx";
import { recipePalette } from "../recipes.ts";
import { colorToThemeBytes, createSemanticThemeSnapshot } from "../theme.ts";
import { expectFrameBounds, renderForTest, stableFrame } from "../testing/renderer-harness.test.ts";
import {
  createPaneFrameFixtureTraceRecorder,
  PANE_FRAME_FIXTURE_EXPECTED_TRACE,
  PANE_FRAME_FIXTURE_MODEL,
} from "../../../ui/pane-frame/fixture.ts";
import { paneFrameModelsFromApplicationShellAgents } from "../../../ui/pane-frame/model.ts";
import type { PaneFrameInput } from "./pane-frame.ts";
import { paneFrameHitTest, projectPaneFrame, projectSemanticPaneFrame } from "./pane-frame.ts";
import { PaneFrame } from "./pane-frame.tsx";

const actions = [
  { id: "agent", label: "agent", compactLabel: "A", description: "Open agent controls" },
  { id: "mission", label: "mission", compactLabel: "M", description: "Open mission proof" },
  { id: "native", label: "native", compactLabel: "N", description: "Open native surface" },
] as const;

function canonicalActionVisualState(
  controlInteraction: Partial<PaneVisualStateV1["controlInteraction"]> = {},
): PaneVisualStateV1 {
  return {
    structure: "docked",
    applicationFocus: { pane: true, terminalInput: false, windowActive: true },
    agentActivity: "idle",
    domainStatus: "idle",
    attention: "none",
    layoutInteraction: {
      editable: true,
      selected: false,
      dragging: false,
      resizing: false,
      previewing: false,
    },
    controlInteraction: {
      hover: false,
      focusVisible: false,
      pressed: false,
      disabled: false,
      loading: false,
      ...controlInteraction,
    },
  };
}

function colorKey(color: Parameters<typeof colorToThemeBytes>[0]): string {
  return colorToThemeBytes(color).join(",");
}

function liveApplicationShellAgentModel(structure: "docked" | "maximized" = "docked") {
  const projection = projectApplicationShellV1({
    project: COHESION_FIXTURE_V1.project,
    workspace: {
      ...COHESION_FIXTURE_V1.workspace,
      sidebar: {
        ...COHESION_FIXTURE_V1.workspace.sidebar,
        agents: COHESION_FIXTURE_V1.workspace.sidebar.agents.map((agent) =>
          agent.paneId === "pane.implementer"
            ? { ...agent, activity: "running" as const, attention: false }
            : agent,
        ),
      },
    },
    dock: COHESION_FIXTURE_V1.dock,
    focus: { ...COHESION_FIXTURE_V1.focus, overlays: [] },
    connection: {
      state: "connected",
      message: "Live",
      safeState: "No attachment is open",
      nextAction: "Choose an agent terminal",
    },
  });
  return paneFrameModelsFromApplicationShellAgents(projection, {
    localStateByPaneId: new Map([["pane.implementer", { structure }]]),
  }).find((model) => model.pane.id === "pane.implementer")!;
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
  it("renders and activates the shared cohesion fixture through injected OpenTUI leaves", async () => {
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const recorder = createPaneFrameFixtureTraceRecorder();
    const projection = projectSemanticPaneFrame({
      width: 120,
      height: 40,
      model: PANE_FRAME_FIXTURE_MODEL,
    });
    const setup = await renderForTest(
      () => (
        <PaneFrame
          theme={theme}
          projection={projection}
          inputOwner
          onActionActivate={recorder.onActionActivate}
          onGripActivate={recorder.onGripActivate}
        >
          <text> shared fixture body</text>
        </PaneFrame>
      ),
      { width: 120, height: 40 },
    );
    await setup.renderOnce();
    await setup.mockMouse.click(projection.grip!.x, projection.grip!.y, MouseButtons.LEFT);
    const split = projection.actions.find((action) => action.id === "split")!;
    await setup.mockMouse.click(
      split.start + Math.floor(split.width / 2),
      projection.header.y,
      MouseButtons.LEFT,
    );
    expect(recorder.trace).toEqual(PANE_FRAME_FIXTURE_EXPECTED_TRACE);
    expect(stableFrame(setup.captureCharFrame())).toContain(PANE_FRAME_FIXTURE_MODEL.title);
    setup.renderer.destroy();
  });

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

  it.each([
    [80, 24, "compact"],
    [120, 40, "standard"],
    [200, 60, "wide"],
  ] as const)(
    "renders the live application-shell agent adapter at %sx%s as %s",
    async (width, height, variant) => {
      const theme = createSemanticThemeSnapshot({ mode: "dark" });
      const maximized = width === 200;
      const model = liveApplicationShellAgentModel(maximized ? "maximized" : "docked");
      const projection = projectSemanticPaneFrame({ width, height, model });
      const setup = await renderForTest(
        () => (
          <PaneFrame theme={theme} projection={projection}>
            <text fg={theme.colors.mutedForeground}> opaque terminal body</text>
          </PaneFrame>
        ),
        { width, height },
      );
      await setup.renderOnce();
      const frame = stableFrame(setup.captureCharFrame());

      expectFrameBounds(setup.captureCharFrame(), width, height);
      expect(projection.variant).toBe(variant);
      expect(projection.model.pane.id).toBe("pane.implementer");
      expect(projection.actions.map(({ id }) => id)).toEqual(["zoom", "menu"]);
      expect(
        projection.model.actions.map(({ id, behavior, pressed }) => ({ id, behavior, pressed })),
      ).toEqual([
        { id: "zoom", behavior: "toggle", pressed: maximized },
        { id: "menu", behavior: "action", pressed: false },
      ]);
      expect(projection.actions[0]).toMatchObject({
        id: "zoom",
        icon: maximized ? "restore" : "maximize",
        pressed: maximized,
      });
      expect(frame).toContain(model.title);
      expect(frame).toContain("opaque terminal body");
      expect(frame).not.toMatch(/%\d+/u);
      expect(frame).toMatchSnapshot();
      setup.renderer.destroy();
    },
  );

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
      },
    ] as const;

    for (const { label, input, marker, borderStart } of cases) {
      const { setup, theme, projection } = await renderStaticPane(input);
      const stable = stableFrame(setup.captureCharFrame());
      expect(stable, label).toMatchSnapshot();
      expect(stable.startsWith(borderStart), label).toBe(true);
      expect(projection.marker, label).toBe(marker);
      expect(projection.titleSpan.text, label).toContain(marker);
      const appearance = projection.model.appearance;
      const borderRole = appearance.outerOutline.visible
        ? (appearance.outerOutline.role ?? appearance.border.role)
        : appearance.border.role;
      const borderSpan = setup.captureSpans().lines[0]!.spans[0]!;
      expect(colorKey(borderSpan.fg), label).toBe(colorKey(theme.roles.borders[borderRole]));
      const titleSpan = spanContaining(setup, projection.titleSpan.text, projection.header.y);
      expect(titleSpan, label).toBeDefined();
      expect(colorKey(titleSpan!.fg), label).toBe(
        colorKey(theme.roles.text[appearance.header.text]),
      );
      expect(colorKey(titleSpan!.bg), label).toBe(
        colorKey(theme.roles.surfaces[appearance.header.surface]),
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

  it("maps canonical action interaction to exact OpenTUI glyphs, spans, and activation", async () => {
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const cases = [
      {
        label: "disabled",
        control: { disabled: true },
        recipe: { disabled: true },
        glyph: "×",
        interactive: false,
        state: "disabled",
      },
      {
        label: "loading",
        control: { loading: true },
        recipe: { loading: true },
        glyph: "…",
        interactive: false,
        state: "loading",
      },
      {
        label: "pressed",
        control: { pressed: true },
        recipe: { pressed: true },
        glyph: "◆",
        interactive: true,
        state: "pressed",
      },
      {
        label: "focus-visible",
        control: { focusVisible: true },
        recipe: { focused: true },
        glyph: "›",
        interactive: true,
        state: "focused",
      },
      {
        label: "hover",
        control: { hover: true },
        recipe: { hovered: true },
        glyph: "·",
        interactive: true,
        state: "hovered",
      },
    ] as const;

    for (const testCase of cases) {
      const calls: string[] = [];
      const projection = projectPaneFrame({
        width: 120,
        height: 40,
        title: `Canonical ${testCase.label}`,
        kind: "native",
        focused: true,
        visualState: canonicalActionVisualState(testCase.control),
        actions: [actions[0]],
      });
      const setup = await renderForTest(
        () => (
          <PaneFrame
            theme={theme}
            projection={projection}
            inputOwner
            onActionActivate={(intent) => calls.push(intent.actionId)}
          />
        ),
        { width: 120, height: 40 },
      );
      await setup.renderOnce();
      const palette = recipePalette(theme, testCase.recipe);
      const labelSpan = spanContaining(setup, " agent ", projection.header.y);
      const markerSpan = spanContaining(setup, testCase.glyph, projection.header.y);
      expect(labelSpan, testCase.label).toBeDefined();
      expect(markerSpan, testCase.label).toBeDefined();
      expect(colorKey(labelSpan!.fg), testCase.label).toBe(colorKey(palette.foreground));
      expect(colorKey(labelSpan!.bg), testCase.label).toBe(colorKey(palette.background));
      expect(colorKey(markerSpan!.fg), testCase.label).toBe(colorKey(palette.accent));
      expect(projection.actions[0]!.interactive, testCase.label).toBe(testCase.interactive);
      expect(projection.actions[0]!.state, testCase.label).toBe(testCase.state);

      const action = projection.actions[0]!;
      await setup.mockMouse.click(
        action.start + Math.floor(action.width / 2),
        projection.header.y,
        MouseButtons.LEFT,
      );
      expect(calls, testCase.label).toEqual(testCase.interactive ? ["agent"] : []);
      setup.renderer.destroy();
    }
  });

  it("keeps the shared presenter passive unless the OpenTUI host owns input", async () => {
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const projection = projectPaneFrame({
      width: 120,
      height: 40,
      title: "Passive root agreement",
      kind: "native",
      focused: true,
      visualState: canonicalActionVisualState(),
      actions: [actions[0]],
    });
    const action = projection.actions[0]!;

    for (const inputOwner of [false, true]) {
      const calls: string[] = [];
      const setup = await renderForTest(
        () => (
          <PaneFrame
            theme={theme}
            projection={projection}
            inputOwner={inputOwner}
            onActionActivate={(intent) => calls.push(`${intent.actionId}:${intent.commandId}`)}
          />
        ),
        { width: 120, height: 40 },
      );
      await setup.renderOnce();
      await setup.mockMouse.click(
        action.start + Math.floor(action.width / 2),
        projection.header.y,
        MouseButtons.LEFT,
      );
      expect(calls).toEqual(inputOwner ? ["agent:pane.action.agent"] : []);
      setup.renderer.destroy();
    }
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
