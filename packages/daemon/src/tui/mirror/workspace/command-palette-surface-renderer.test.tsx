/* @jsxImportSource @opentui/solid */
import { useKeyboard } from "@opentui/solid";
import { createSignal } from "solid-js";
import { describe, expect, it } from "bun:test";
import { recipePalette } from "../recipes.ts";
import { colorToThemeBytes, createSemanticThemeSnapshot } from "../theme.ts";
import { expectFrameBounds, renderForTest, stableFrame } from "../testing/renderer-harness.test.ts";
import {
  projectCommandPalette,
  type CommandPaletteDescriptor,
  type CommandPalettePhase,
} from "./command-palette-surface.ts";
import { CommandPaletteSurface } from "./command-palette-surface.tsx";

function colorKey(color: Parameters<typeof colorToThemeBytes>[0]): string {
  return colorToThemeBytes(color).join(",");
}

const commands: readonly CommandPaletteDescriptor[] = [
  {
    id: "workspace.home.open",
    icon: "home",
    label: "Open Home",
    description: "Browse projects, recent workspaces, and onboarding",
    category: "Navigation",
    shortcut: "F1",
  },
  {
    id: "workspace.terminals.open",
    icon: "terminals",
    label: "Open Terminals",
    detail: "Return to the live tmux agent canvas",
    category: "Navigation",
    status: "3 agents",
    shortcut: "F2",
    current: true,
  },
  {
    id: "workspace.files.open",
    icon: "files",
    label: "Open File…",
    description: "Find a workspace file by name or path",
    category: "Files",
    shortcut: "⌘P",
  },
  {
    id: "workspace.files.save",
    icon: "files",
    label: "Save File",
    detail: "Write changes from the native editor",
    category: "Files",
    shortcut: "⌘S",
    disabledReason: "No file is open",
  },
  {
    id: "workspace.diff.open",
    icon: "changes",
    label: "Review Changes",
    description: "Open the native diff surface",
    category: "Files",
    status: "12 files",
  },
  {
    id: "workspace.pane.maximize",
    icon: "maximize",
    label: "Maximize Active Pane",
    description: "Focus one agent while preserving tmux pane identity",
    category: "Window",
    shortcut: "⌘↵",
  },
  {
    id: "workspace.pane.split",
    icon: "split-right",
    label: "Split Pane Right",
    description: "Create a terminal beside the active agent",
    category: "Window",
    shortcut: "⌘D",
  },
];

async function renderPalette(width: number, height: number) {
  const theme = createSemanticThemeSnapshot({ mode: "dark" });
  const projection = projectCommandPalette({
    width,
    height,
    query: "",
    commands,
    selectedCommandId: "workspace.terminals.open",
  });
  const setup = await renderForTest(
    () => <CommandPaletteSurface theme={theme} projection={projection} />,
    { width, height },
  );
  await setup.renderOnce();
  return { setup, projection, frame: () => setup.captureCharFrame() };
}

describe("CommandPaletteSurface OpenTUI renderer", () => {
  it.each([
    [80, 24, "compact"],
    [120, 40, "standard"],
    [200, 60, "wide"],
  ] as const)("renders the %sx%s %s command surface", async (width, height, variant) => {
    const harness = await renderPalette(width, height);
    const frame = harness.frame();
    expectFrameBounds(frame, width, height);
    expect(harness.projection.variant).toBe(variant);
    expect(stableFrame(frame)).toMatchSnapshot();
    expect(stableFrame(frame)).toContain("Command palette");
    expect(stableFrame(frame)).toContain("Open Terminals");
    expect(stableFrame(frame)).toContain("F2");
    expect(stableFrame(frame)).toContain("⌂");
  });

  it.each([
    ["loading", "", "Loading commands"],
    ["ready", "", "No commands yet"],
    ["ready", "gibberish", "No matching commands"],
    ["error", "", "Commands unavailable"],
  ] as const)("renders the %s / %s visual state", async (phase, query, expected) => {
    const width = 80;
    const height = 24;
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const projection = projectCommandPalette({
      width,
      height,
      query,
      commands: [],
      phase: phase as CommandPalettePhase,
      errorMessage: "Command discovery timed out",
      retryCommandId: "commands.reload",
      selectedCommandId: phase === "error" ? "commands.reload" : null,
    });
    const setup = await renderForTest(
      () => <CommandPaletteSurface theme={theme} projection={projection} />,
      { width, height },
    );
    await setup.renderOnce();
    const frame = stableFrame(setup.captureCharFrame());
    expect(frame).toMatchSnapshot();
    expect(frame).toContain(expected);
    if (phase === "error") {
      expect(frame).toContain("Command discovery timed out");
      expect(frame).toContain("Retry");
    }
  });

  it("survives fresh descriptor objects and selection changes with the same semantic row ids", async () => {
    const width = 120;
    const height = 40;
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    let ids: readonly string[] = [];

    function Harness() {
      const [selected, setSelected] = createSignal(commands[0]!.id);
      useKeyboard((event) => {
        if (event.name === "down") setSelected(commands[1]!.id);
      });
      const projection = () => {
        const projected = projectCommandPalette({
          width,
          height,
          query: "",
          commands: commands.map((command) => ({ ...command })),
          selectedCommandId: selected(),
        });
        ids = projected.rowIds;
        return projected;
      };
      return <CommandPaletteSurface theme={theme} projection={projection()} />;
    }

    const setup = await renderForTest(() => <Harness />, { width, height });
    await setup.renderOnce();
    const beforeIds = [...ids];
    setup.mockInput.pressArrow("down");
    await setup.renderOnce();
    expect(ids).toEqual(beforeIds);
    expect(stableFrame(setup.captureCharFrame())).toContain("› ❯ Open Terminals");
  });

  it("lets disabled fully override simultaneous current and selected icon chrome", async () => {
    const width = 120;
    const height = 40;
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const disabledCurrent: CommandPaletteDescriptor = {
      id: "workspace.files.disabled-current",
      icon: "files",
      label: "Disabled current command",
      description: "Must never inherit focused icon color",
      category: "Files",
      disabledReason: "No file is open",
      current: true,
    };
    const projection = projectCommandPalette({
      width,
      height,
      query: "",
      commands: [disabledCurrent],
      selectedCommandId: disabledCurrent.id,
    });
    const setup = await renderForTest(
      () => <CommandPaletteSurface theme={theme} projection={projection} />,
      { width, height },
    );
    await setup.renderOnce();

    const row = projection.rows.find((candidate) => candidate.kind === "command")!;
    expect(row).toMatchObject({ disabled: true, current: true, selected: true });
    const spans = setup.captureSpans().lines[row.rect.y]!.spans;
    const marker = spans.find((candidate) => candidate.text.includes("×"));
    const icon = spans.find((candidate) => candidate.text.includes("▤"));
    const label = spans.find((candidate) => candidate.text.includes("Disabled current command"));
    const disabledPalette = recipePalette(theme, {
      disabled: true,
      focused: true,
      selected: true,
    });

    expect(stableFrame(setup.captureCharFrame())).toContain("× ▤ Disabled current command");
    expect(marker).toBeDefined();
    expect(icon).toBeDefined();
    expect(label).toBeDefined();
    expect(colorKey(marker!.fg)).toBe(colorKey(disabledPalette.accent));
    expect(colorKey(icon!.fg)).toBe(colorKey(disabledPalette.accent));
    expect(colorKey(icon!.fg)).not.toBe(colorKey(theme.colors.focus));
    expect(colorKey(label!.fg)).toBe(colorKey(disabledPalette.foreground));
    expect(colorKey(label!.bg)).toBe(colorKey(disabledPalette.background));
  });

  it("clips safely in a narrow viewport", async () => {
    const width = 28;
    const height = 10;
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const projection = projectCommandPalette({
      width,
      height,
      query: "maximize",
      commands,
      selectedCommandId: "workspace.pane.maximize",
    });
    const setup = await renderForTest(
      () => <CommandPaletteSurface theme={theme} projection={projection} />,
      { width, height },
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expectFrameBounds(frame, width, height);
    expect(stableFrame(frame)).toMatchSnapshot();
  });
});
