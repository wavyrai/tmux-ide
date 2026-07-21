import { describe, expect, it } from "vitest";
import {
  shellChromeLayout,
  shellChromeVariant,
  shellOverlayWidth,
  shellSidebarHint,
  shellStatusLine,
  shellSurfaceTabs,
  shellVisualPalette,
} from "./shell-chrome.ts";
import { buildHostedPanelViews } from "./panel-host.ts";
import { terminalDisplayWidth } from "./panel-host.ts";
import {
  colorToThemeBytes,
  createSemanticThemeSnapshot,
  createSemanticThemeStore,
  type ResolvedThemeMode,
  type ThemeModeSource,
} from "./theme.ts";

function key(color: Parameters<typeof colorToThemeBytes>[0]): string {
  return colorToThemeBytes(color).join(",");
}

const views = buildHostedPanelViews([
  { id: "home", title: "Home", panel: "home" },
  { id: "terminal", title: "Terminal", panel: "terminals" },
  { id: "files", title: "Files", panel: "files" },
  { id: "diff", title: "Diff", panel: "diff" },
  { id: "missions", title: "Missions", panel: "missions" },
]);

describe("shell chrome responsive projection", () => {
  it.each([
    [80, 24, "compact", 20],
    [120, 40, "standard", 28],
    [200, 60, "wide", 28],
  ] as const)("projects %sx%s as %s", (width, height, variant, sidebarWidth) => {
    const layout = shellChromeLayout(width, height, 28);
    expect(layout.variant).toBe(variant);
    expect(layout.sidebar.width).toBe(sidebarWidth);
    expect(layout.main.x).toBe(layout.sidebar.width);
    expect(layout.main.width + layout.sidebar.width).toBe(width);
    expect(layout.paletteWidth).toBe(shellOverlayWidth(width, variant, "palette"));
    expect(layout.dialogWidth).toBe(shellOverlayWidth(width, variant, "dialog"));
  });

  it("keeps surface tab labels and spans deterministic by variant", () => {
    const compact = shellSurfaceTabs(views, "files", "compact", 1);
    expect(compact.map((tab) => tab.label)).toEqual([" ⌂ ", " ❯ ", " ▤ ", " ± ", " ◆ "]);
    expect(compact[1]!.hovered).toBe(true);
    expect(compact[2]!.selected).toBe(true);
    expect(compact.map((tab) => tab.span.start)).toEqual([0, 3, 6, 9, 12]);

    const wide = shellSurfaceTabs(views, "missions", "wide", null);
    expect(wide[0]!.label).toContain("F1");
    expect(wide[4]!.label).toContain("F6");
    expect(wide[4]!.selected).toBe(true);
  });

  it("keeps attention inside fixed-width tab labels and spans", () => {
    const alerted = shellSurfaceTabs(views, "terminal", "standard", null, new Set(["terminal"]));
    const normal = shellSurfaceTabs(views, "terminal", "standard", null);
    expect(alerted[1]!.label).toBe(" ! Terminal ");
    expect(alerted[1]!.span).toEqual(normal[1]!.span);
    expect(alerted[2]!.span).toEqual(normal[2]!.span);
    expect(alerted.map((tab) => tab.span.start)).toEqual(normal.map((tab) => tab.span.start));
  });

  it.each([
    ["compact", 16, "^q quit"],
    ["compact", 20, "^q detach"],
    ["standard", 28, "^q quit"],
    ["wide", 28, "^q detach"],
  ] as const)("projects width-aware %s sidebar hint spans", (variant, width, quitHint) => {
    const hint = shellSidebarHint(variant, quitHint, width);
    expect(terminalDisplayWidth(hint.label)).toBeLessThanOrEqual(width);
    expect(hint.label).toContain("F5");
    expect(hint.label).toContain(quitHint.includes("detach") ? "^q detach" : "^q quit");
    expect(hint.pre + hint.btn + hint.post).toBe(hint.label);
    expect(hint.inset).toBe(2);
    expect(hint.buttonSpan.width).toBe(2);
    expect(
      `${" ".repeat(hint.inset)}${hint.label}`.slice(
        hint.buttonSpan.start,
        hint.buttonSpan.start + 2,
      ),
    ).toBe("F5");
    expect(hint.buttonSpan.start + hint.buttonSpan.width).toBeLessThanOrEqual(width);
  });

  it("keeps active view, keyboard focus, hover, attention, and terminal focus visually distinct", () => {
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const selected = shellVisualPalette(theme, { selected: true, focused: true });
    const hovered = shellVisualPalette(theme, { hovered: true });
    const context = shellVisualPalette(theme, { context: true });
    const attention = shellVisualPalette(theme, { attention: true });
    const selectedAttention = shellVisualPalette(theme, {
      selected: true,
      focused: true,
      attention: true,
    });
    const terminal = shellVisualPalette(theme, { terminalFocus: true });

    expect(key(selected.bg)).toBe(key(theme.roles.selection.selection));
    expect(key(hovered.bg)).toBe(key(theme.roles.selection.hover));
    expect(key(context.bg)).not.toBe(key(theme.derived.attentionSurface));
    expect(key(context.fg)).toBe(key(theme.roles.text.link));
    expect(key(attention.bg)).toBe(key(theme.derived.attentionSurface));
    expect(key(attention.border)).toBe(key(theme.roles.statusTone.warning));
    expect(key(selectedAttention.bg)).toBe(key(theme.roles.selection.selection));
    expect(selectedAttention.marker).toBe("!");
    expect(key(selectedAttention.border)).toBe(key(theme.roles.statusTone.warning));
    expect(key(terminal.bg)).toBe(key(theme.roles.borders.focused));
    expect(
      new Set([selected.marker, hovered.marker, context.marker, attention.marker, terminal.marker])
        .size,
    ).toBe(5);
  });

  it("follows renderer theme_mode through the semantic theme store subscription", () => {
    class Source implements ThemeModeSource {
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

    const source = new Source();
    const store = createSemanticThemeStore({ mode: "system" });
    let current = store.getSnapshot();
    const unsubscribe = store.subscribe(() => {
      current = store.getSnapshot();
    });
    const unfollow = store.followRendererThemeMode(source);

    expect(current.mode).toBe("dark");
    source.emit("light");
    expect(current.mode).toBe("light");
    store.setMode("dark");
    source.emit("dark");
    expect(current.mode).toBe("dark");
    store.setMode("system");
    source.emit("light");
    expect(current.mode).toBe("light");

    unfollow();
    unsubscribe();
    source.emit("dark");
    expect(current.mode).toBe("light");
  });

  it("clips status/help strip by responsive variant", () => {
    expect(shellChromeVariant(200, 60)).toBe("wide");
    const compact = shellStatusLine(
      "compact",
      {
        project: "project",
        mode: "Missions",
        notification: "blocked agent",
        help: "F5 palette · ^q quit",
      },
      24,
    );
    expect(compact).toContain("Missions");
    expect(compact.length).toBeLessThanOrEqual(24);
  });
});
