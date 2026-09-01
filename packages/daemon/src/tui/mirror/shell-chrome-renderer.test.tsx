/* @jsxImportSource @opentui/solid */
import { MouseButtons, type TestRendererSetup } from "@opentui/core/testing";
import { useKeyboard } from "@opentui/solid";
import { createSignal, onCleanup } from "solid-js";
import { describe, expect, it } from "bun:test";
import { buildHostedPanelViews } from "./panel-host.ts";
import {
  ContextStatusBar,
  ShellCompositeLeafChrome,
  ShellMiniSidebar,
  ShellTabBar,
} from "./shell-chrome-view.tsx";
import {
  shellChromeLayout,
  shellNavigationPresentation,
  shellSidebarHint,
  shellSurfaceTabs,
  shellVisualPalette,
} from "./shell-chrome.ts";
import {
  createSemanticThemeSnapshot,
  createSemanticThemeStore,
  type ResolvedThemeMode,
  type ThemeModeSource,
} from "./theme.ts";
import { Surface, SelectableRow, InputShell } from "./recipe-components.tsx";
import { colorToThemeBytes } from "./theme.ts";
import {
  expectFrameBounds,
  frameLines,
  renderForTest,
  stableFrame,
} from "./testing/renderer-harness.test.ts";

type TestSetup = TestRendererSetup;

let setup: TestSetup | null = null;

const views = buildHostedPanelViews([
  { id: "home", title: "Home", panel: "home" },
  { id: "terminal", title: "Terminal", panel: "terminals" },
  { id: "files", title: "Files", panel: "files" },
  { id: "diff", title: "Diff", panel: "diff" },
  { id: "missions", title: "Missions", panel: "missions" },
]);

function colorKey(color: Parameters<typeof colorToThemeBytes>[0]): string {
  return colorToThemeBytes(color).join(",");
}

class ThemeModeHarnessSource implements ThemeModeSource {
  themeMode: ResolvedThemeMode | null = "dark";
  listeners = new Set<(mode: ResolvedThemeMode) => void>();
  on(_event: "theme_mode", listener: (mode: ResolvedThemeMode) => void): void {
    this.listeners.add(listener);
  }
  off(_event: "theme_mode", listener: (mode: ResolvedThemeMode) => void): void {
    this.listeners.delete(listener);
  }
  emit(mode: ResolvedThemeMode): void {
    this.themeMode = mode;
    for (const listener of this.listeners) listener(mode);
  }
}

function expectSidebarHintCells(frame: string, width: number, height: number): void {
  const layout = shellChromeLayout(width, height, 28);
  const hint = shellSidebarHint(layout.variant, "^q quit", layout.sidebar.width);
  const lines = frameLines(frame);
  const footer = lines[height - 1] ?? "";
  const sidebarCells = footer.slice(0, layout.sidebar.width);
  expect(sidebarCells).toContain(hint.label);
  expect(sidebarCells.indexOf(hint.label)).toBe(sidebarCells.lastIndexOf(hint.label));
  expect(sidebarCells.slice(hint.inset, hint.inset + hint.label.length)).toBe(hint.label);
  expect(
    sidebarCells.slice(hint.buttonSpan.start, hint.buttonSpan.start + hint.buttonSpan.width),
  ).toBe("F5");
}

function expectRenderedTabBoundaries(frame: string, width: number, height: number): void {
  const layout = shellChromeLayout(width, height, 28);
  const navigation = shellNavigationPresentation(layout.variant, true);
  const tabs = shellSurfaceTabs(views, "terminal", layout.variant, null, new Set(["terminal"]), {
    startX: navigation.width,
    navigationFocused: true,
  });
  const top = frameLines(frame)[0] ?? "";
  for (const tab of tabs) {
    expect(top.slice(tab.span.start, tab.span.start + tab.span.width)).toBe(tab.label);
  }
}

function ShellChromeHarness(props: { width: number; height: number; mode?: ResolvedThemeMode }) {
  const theme = createSemanticThemeSnapshot({ mode: props.mode ?? "dark" });
  const [active, setActive] = createSignal("terminal");
  const [hovered, setHovered] = createSignal<number | null>(null);
  const [message, setMessage] = createSignal("ready");
  const layout = () => shellChromeLayout(props.width, props.height, 28);
  const navigation = () => shellNavigationPresentation(layout().variant, true);
  const tabs = () =>
    shellSurfaceTabs(views, active(), layout().variant, hovered(), new Set(["terminal"]), {
      startX: navigation().width,
      navigationFocused: true,
    });
  const selectTab = (index: number) => {
    const tab = tabs()[index];
    if (!tab) return;
    setActive(tab.id);
    setMessage(`selected ${tab.id}`);
  };
  useKeyboard((event) => {
    if (event.name === "right")
      selectTab(Math.min(views.length - 1, tabs().findIndex((tab) => tab.id === active()) + 1));
    else if (event.name === "left")
      selectTab(Math.max(0, tabs().findIndex((tab) => tab.id === active()) - 1));
    else if (event.name === "f5") setMessage("palette");
  });
  return (
    <box
      width={props.width}
      height={props.height}
      flexDirection="column"
      overflow="hidden"
      onMouseMove={(event) => {
        const hit = tabs().findIndex(
          (tab) =>
            event.x >= tab.span.start && event.x < tab.span.start + tab.span.width && event.y === 0,
        );
        setHovered(hit >= 0 ? hit : null);
      }}
      onMouseDown={(event) => {
        const hit = tabs().findIndex(
          (tab) =>
            event.x >= tab.span.start && event.x < tab.span.start + tab.span.width && event.y === 0,
        );
        if (hit >= 0) selectTab(hit);
      }}
    >
      <ShellTabBar
        theme={theme}
        width={props.width}
        variant={layout().variant}
        views={views}
        activeViewId={active()}
        hoveredIndex={hovered()}
        note={message()}
        attentionViewIds={new Set(["terminal"])}
        navigationFocused
        rightChips={[
          { id: "context", label: "⧉ web ", context: true },
          { id: "alert", label: "!blocked ", attention: true },
          { id: "palette", label: "F5 palette ", hovered: message() === "palette" },
        ]}
      />
      <box flexDirection="row" flexGrow={1} overflow="hidden">
        <ShellMiniSidebar
          theme={theme}
          width={layout().sidebar.width}
          variant={layout().variant}
          active="web"
          hint={shellSidebarHint(layout().variant, "^q quit", layout().sidebar.width)}
          sessions={[
            { name: "web", status: "working" },
            { name: "api", status: "blocked" },
            { name: "docs", status: "idle" },
          ]}
        />
        <box flexDirection="column" flexGrow={1} overflow="hidden">
          <Surface
            theme={theme}
            title={`${layout().variant} workspace`}
            focused
            width={layout().main.width}
            height={Math.max(4, layout().main.height - 1)}
          >
            <SelectableRow
              theme={theme}
              label="Active view and keyboard focus are selected"
              meta={active()}
              width={Math.max(1, layout().main.width - 2)}
              selected
            />
            <SelectableRow
              theme={theme}
              label="Agent attention keeps blocked status"
              meta="blocked"
              width={Math.max(1, layout().main.width - 2)}
              attention
              status="blocked"
              tone="blocked"
            />
            <SelectableRow
              theme={theme}
              label="Pointer hover is a separate surface"
              meta="hover"
              width={Math.max(1, layout().main.width - 2)}
              hovered
            />
            <ShellCompositeLeafChrome
              theme={theme}
              title="Terminal"
              panel="terminals"
              width={Math.max(1, layout().main.width - 2)}
              focused
              terminalFocused
            />
            <InputShell
              theme={theme}
              value=""
              placeholder="Palette query…"
              width={Math.min(36, layout().main.width - 2)}
              focused
            />
          </Surface>
          <ContextStatusBar
            theme={theme}
            layout={layout()}
            project="tmux-ide"
            session="web"
            pane="Claude Code"
            mode={active()}
            notification={message()}
            connectionState="connected"
            help="F5 palette · arrows move · ^q quit"
            onHelp={() => setMessage("palette")}
          />
        </box>
      </box>
    </box>
  );
}

async function renderShell(width: number, height: number, mode: ResolvedThemeMode = "dark") {
  setup = await renderForTest(
    () => <ShellChromeHarness width={width} height={height} mode={mode} />,
    {
      width,
      height,
    },
  );
  await setup.renderOnce();
  return {
    frame: () => setup!.captureCharFrame(),
  };
}

async function renderContextStatus(input: {
  notification: string;
  transient?: string;
  connectionState?: "connected" | "reconnecting" | "disconnected" | "recovering";
}) {
  const width = 120;
  const theme = createSemanticThemeSnapshot({ mode: "dark" });
  const baseLayout = shellChromeLayout(width, 40, 28);
  const layout = { ...baseLayout, status: { ...baseLayout.status, width } };
  setup = await renderForTest(
    () => (
      <ContextStatusBar
        theme={theme}
        layout={layout}
        project="tmux-ide"
        session="calm-lynx"
        pane="Claude Code"
        mode="Terminals"
        notification={input.notification}
        transient={input.transient}
        connectionState={input.connectionState ?? "connected"}
        help="F5 Commands"
      />
    ),
    { width, height: 1 },
  );
  await setup.renderOnce();
  return setup.captureCharFrame();
}

describe("ShellChrome OpenTUI renderer", () => {
  it.each([
    [80, 24, "compact"],
    [120, 40, "standard"],
    [200, 60, "wide"],
  ] as const)("renders deterministic %sx%s %s shell chrome", async (width, height, variant) => {
    const harness = await renderShell(width, height);
    const frame = harness.frame();
    expectFrameBounds(frame, width, height);
    expect(stableFrame(frame)).toMatchSnapshot();
    expect(stableFrame(frame)).toContain(`${variant} workspace`);
    expect(stableFrame(frame)).toContain("F5");
    expect(stableFrame(frame)).toContain("^q quit");
    expectSidebarHintCells(frame, width, height);
    expectRenderedTabBoundaries(frame, width, height);
  });

  it.each([
    ["dark", 80, 24],
    ["dark", 120, 40],
    ["dark", 200, 60],
    ["light", 80, 24],
    ["light", 120, 40],
    ["light", 200, 60],
  ] as const)("proves semantic %s chrome at %sx%s", async (mode, width, height) => {
    const harness = await renderShell(width, height, mode);
    const theme = createSemanticThemeSnapshot({ mode });
    const spans = setup!.captureSpans().lines.flatMap((line) => line.spans);
    expectFrameBounds(harness.frame(), width, height);
    expect(stableFrame(harness.frame())).toContain("workspace");
    expect(spans.some((span) => colorKey(span.bg) === colorKey(theme.roles.surfaces.header))).toBe(
      true,
    );
    expect(spans.some((span) => colorKey(span.bg) === colorKey(theme.roles.surfaces.panel))).toBe(
      true,
    );
  });

  it("drives keyboard navigation through the shell harness", async () => {
    const harness = await renderShell(120, 40);
    setup!.mockInput.pressArrow("right");
    await setup!.renderOnce();
    expect(stableFrame(harness.frame())).toContain("selected files");
    await setup!.mockInput.pressKey("f5");
    await setup!.renderOnce();
    expect(stableFrame(harness.frame())).toContain("palette");
  });

  it.each([
    [80, 24, ["web", "F5"], ["tmux-ide", "terminal", "Commands", "Claude Code"]],
    [120, 40, ["web", "terminal", "F5 Commands"], ["tmux-ide", "Claude Code"]],
    [200, 60, ["tmux-ide", "web", "terminal", "Claude Code", "F5 Commands"], []],
  ] as const)(
    "collapses contextual footer segments deliberately at %sx%s",
    async (width, height, visible, hidden) => {
      const harness = await renderShell(width, height);
      const footer = frameLines(harness.frame())[height - 1]!.slice(
        shellChromeLayout(width, height, 28).sidebar.width,
      );
      for (const label of visible) expect(footer).toContain(label);
      for (const label of hidden) expect(footer).not.toContain(label);
    },
  );

  it("routes the Commands key hint through the same action as F5", async () => {
    const harness = await renderShell(120, 40);
    const footer = frameLines(harness.frame())[39]!;
    const commandX = footer.indexOf("F5 Commands") + 2;
    expect(commandX).toBeGreaterThan(1);
    await setup!.mockMouse.click(commandX, 39, MouseButtons.LEFT);
    await setup!.renderOnce();
    expect(stableFrame(harness.frame())).toContain("palette");

    setup!.mockInput.pressArrow("right");
    await setup!.renderOnce();
    expect(stableFrame(harness.frame())).toContain("selected files");
    await setup!.mockInput.pressKey("f5");
    await setup!.renderOnce();
    expect(stableFrame(harness.frame())).toContain("palette");
  });

  it("renders transient confirmation and attention as distinct contextual modes", async () => {
    const confirmation = await renderContextStatus({
      notification: "agent needs attention",
      transient: "split pane right",
    });
    expect(confirmation).toContain("✓ split pane right");
    expect(confirmation).not.toContain("agent needs attention");
    setup!.renderer.destroy();

    const attention = await renderContextStatus({ notification: "agent needs attention" });
    expect(attention).toContain("! agent needs attention");
    setup!.renderer.destroy();

    const reconnecting = await renderContextStatus({
      notification: "ready",
      connectionState: "reconnecting",
    });
    expect(reconnecting).toContain("Reconnecting");
  });

  it("routes mouse hover/click from the same projected tab spans", async () => {
    const harness = await renderShell(120, 40);
    const layout = shellChromeLayout(120, 40, 28);
    const navigation = shellNavigationPresentation(layout.variant, true);
    const tabs = shellSurfaceTabs(views, "terminal", layout.variant, null, new Set(["terminal"]), {
      startX: navigation.width,
      navigationFocused: true,
    });
    const frameTop = frameLines(harness.frame())[0]!;
    const visualFilesStart = frameTop.indexOf(tabs.find((tab) => tab.id === "files")!.label);
    expect(visualFilesStart).toBe(tabs.find((tab) => tab.id === "files")!.span.start);
    const visualFilesCenter =
      visualFilesStart + Math.floor(tabs.find((tab) => tab.id === "files")!.span.width / 2);
    await setup!.mockMouse.moveTo(visualFilesCenter, 0);
    await setup!.renderOnce();
    await setup!.mockMouse.click(visualFilesCenter, 0, MouseButtons.LEFT);
    await setup!.renderOnce();
    expect(stableFrame(harness.frame())).toContain("selected files");
  });

  it("captures distinct semantic chrome spans", async () => {
    await renderShell(120, 40);
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const attentionPalette = shellVisualPalette(theme, { attention: true });
    const contextPalette = shellVisualPalette(theme, { context: true });
    const selectedAttention = shellVisualPalette(theme, { selected: true, attention: true });
    const spans = setup!.captureSpans();
    const contextChip = spans.lines
      .flatMap((line) => line.spans)
      .find((span) => span.text.includes("⧉ web"));
    expect(contextChip).toBeDefined();
    expect(colorKey(contextChip!.bg)).toBe(colorKey(contextPalette.bg));
    expect(colorKey(contextChip!.bg)).not.toBe(colorKey(theme.derived.attentionSurface));

    const tabAttentionMarker = spans.lines[0]!.spans.find((span) => span.text === "!");
    expect(tabAttentionMarker).toBeDefined();
    expect(colorKey(tabAttentionMarker!.fg)).toBe(colorKey(theme.roles.statusTone.warning));
    expect(colorKey(tabAttentionMarker!.bg)).toBe(colorKey(selectedAttention.bg));

    const attentionLine = spans.lines.find((line) =>
      line.spans.some((span) => span.text.includes("Agent attention")),
    );
    expect(attentionLine).toBeDefined();
    const marker = attentionLine!.spans.find((span) => span.text === "!")!;
    expect(marker).toBeDefined();
    expect(colorKey(marker.bg)).toBe(colorKey(attentionPalette.bg));
  });

  it("updates shell colors from renderer theme_mode without rebuilding an input owner", async () => {
    const source = new ThemeModeHarnessSource();
    function ThemeModeShell() {
      const store = createSemanticThemeStore({ mode: "system" });
      const [theme, setTheme] = createSignal(store.getSnapshot());
      const unsubscribe = store.subscribe(() => setTheme(store.getSnapshot()));
      const unfollow = store.followRendererThemeMode(source);
      onCleanup(() => {
        unfollow();
        unsubscribe();
      });
      return (
        <ShellTabBar
          theme={theme()}
          width={80}
          variant="compact"
          views={views}
          activeViewId="terminal"
          hoveredIndex={null}
        />
      );
    }

    setup = await renderForTest(() => <ThemeModeShell />, { width: 80, height: 4 });
    await setup.renderOnce();
    const darkBg = setup.captureSpans().lines[0]!.spans.find((span) => span.text.includes("❯"))!.bg;
    source.emit("light");
    await setup.renderOnce();
    const lightBg = setup
      .captureSpans()
      .lines[0]!.spans.find((span) => span.text.includes("❯"))!.bg;
    expect(colorKey(lightBg)).not.toBe(colorKey(darkBg));
  });
});
