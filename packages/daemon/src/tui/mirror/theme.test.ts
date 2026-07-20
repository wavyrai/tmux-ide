import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ACCENT,
  DARK_THEME,
  DEFAULT_BG,
  LIGHT_THEME,
  colorToThemeBytes,
  createSemanticThemeSnapshot,
  createSemanticThemeStore,
  type ResolvedThemeMode,
  type ThemeModeSource,
} from "./theme.ts";
import { THEME_PRESETS } from "./settings-model.ts";

function rgbaKey(color: { r: number; g: number; b: number; a: number }): string {
  return colorToThemeBytes(color as Parameters<typeof colorToThemeBytes>[0]).join(",");
}

class FakeThemeModeSource implements ThemeModeSource {
  themeMode: ResolvedThemeMode | null;
  readonly listeners = new Set<(mode: ResolvedThemeMode) => void>();

  constructor(mode: ResolvedThemeMode | null) {
    this.themeMode = mode;
  }

  on(event: "theme_mode", listener: (mode: ResolvedThemeMode) => void): void {
    expect(event).toBe("theme_mode");
    this.listeners.add(listener);
  }

  off(event: "theme_mode", listener: (mode: ResolvedThemeMode) => void): void {
    expect(event).toBe("theme_mode");
    this.listeners.delete(listener);
  }

  emit(mode: ResolvedThemeMode): void {
    this.themeMode = mode;
    for (const listener of this.listeners) listener(mode);
  }
}

describe("semantic theme snapshots", () => {
  it("uses only RGBA.fromInts so docs/tui-web's narrow browser shim remains a drift detector", () => {
    const source = readFileSync(fileURLToPath(new URL("./theme.ts", import.meta.url)), "utf-8");
    expect(source).toContain("RGBA.fromInts");
    expect(source).not.toMatch(/RGBA\.from(?!Ints\b)/u);
  });

  it("resolves dark, light, and system mode with a stable dark fallback", () => {
    expect(createSemanticThemeSnapshot({ mode: "dark" }).mode).toBe("dark");
    expect(createSemanticThemeSnapshot({ mode: "light" }).mode).toBe("light");
    expect(createSemanticThemeSnapshot({ mode: "system" }, "light").mode).toBe("light");
    expect(createSemanticThemeSnapshot({ mode: "system" }, null).mode).toBe("dark");
    expect(createSemanticThemeSnapshot({ mode: "system" }, "light").setting).toBe("system");
  });

  it("keeps dark compatibility exports mapped to the legacy dark palette", () => {
    expect(rgbaKey(DEFAULT_BG)).toBe(rgbaKey(DARK_THEME.colors.background));
    expect(rgbaKey(ACCENT)).toBe(rgbaKey(DARK_THEME.colors.accent));
  });

  it("normalizes color bytes without confusing real normalized channels and browser-shim bytes", () => {
    const real = createSemanticThemeSnapshot({ accent: "#010101" }).colors.accent;
    expect(colorToThemeBytes(real)).toEqual([1, 1, 1, 255]);
    const shimLikeColor = { r: 1, g: 1, b: 1, a: 255 } as Parameters<typeof colorToThemeBytes>[0];
    expect(colorToThemeBytes(shimLikeColor)).toEqual([1, 1, 1, 255]);
  });

  it("derives custom accent tokens without changing semantic status tokens", () => {
    const snapshot = createSemanticThemeSnapshot({ mode: "dark", accent: "#ff00aa" });
    expect(rgbaKey(snapshot.colors.accent)).toBe("255,0,170,255");
    expect(rgbaKey(snapshot.colors.focus)).toBe("255,0,170,255");
    expect(rgbaKey(snapshot.colors.focusBorder)).not.toBe(rgbaKey(snapshot.colors.focus));
    expect(rgbaKey(snapshot.colors.status.blocked)).toBe(rgbaKey(DARK_THEME.colors.status.blocked));
  });

  it("preserves a saved accent that collides with status while deriving collision-safe focus", () => {
    const snapshot = createSemanticThemeSnapshot({ mode: "dark", accent: "colour203" });
    expect(rgbaKey(snapshot.colors.accent)).toBe("255,95,95,255");
    expect(rgbaKey(snapshot.colors.accent)).toBe(rgbaKey(snapshot.colors.status.blocked));
    expect(rgbaKey(snapshot.colors.focus)).toBe(rgbaKey(DARK_THEME.colors.focus));
    expect(rgbaKey(snapshot.colors.focus)).not.toBe(rgbaKey(snapshot.colors.status.blocked));
    expect(rgbaKey(snapshot.colors.focusBorder)).not.toBe(rgbaKey(snapshot.colors.status.blocked));
  });

  it("keeps focus and focusBorder safe against adversarial custom status overrides", () => {
    const snapshot = createSemanticThemeSnapshot({
      mode: "dark",
      accent: "colour203",
      status: {
        blocked: "colour203",
        working: "#82aaff",
        done: "#6e91e6",
        idle: "#99b9ff",
        unknown: "#a5c2ff",
      },
    });
    const statusColors = Object.values(snapshot.colors.status).map(rgbaKey);
    expect(rgbaKey(snapshot.colors.accent)).toBe(rgbaKey(snapshot.colors.status.blocked));
    expect(statusColors).not.toContain(rgbaKey(snapshot.colors.focus));
    expect(statusColors).not.toContain(rgbaKey(snapshot.colors.focusBorder));
    expect(rgbaKey(snapshot.colors.focusBorder)).not.toBe(rgbaKey(snapshot.colors.focus));
  });

  it("moves a derived focus border that collides with a custom status override", () => {
    const baseline = createSemanticThemeSnapshot({ mode: "dark", accent: "#ff00aa" });
    const [r, g, b] = colorToThemeBytes(baseline.colors.focusBorder);
    const collidingStatus = `#${[r, g, b]
      .map((channel) => channel.toString(16).padStart(2, "0"))
      .join("")}`;
    const snapshot = createSemanticThemeSnapshot({
      mode: "dark",
      accent: "#ff00aa",
      status: { blocked: collidingStatus },
    });
    expect(rgbaKey(snapshot.colors.focus)).toBe(rgbaKey(snapshot.colors.accent));
    expect(rgbaKey(snapshot.colors.focusBorder)).not.toBe(rgbaKey(snapshot.colors.status.blocked));
    expect(rgbaKey(snapshot.colors.focusBorder)).not.toBe(rgbaKey(snapshot.colors.focus));
  });

  it("accepts tmux colour tokens and preserves saved status/glyph overrides", () => {
    const snapshot = createSemanticThemeSnapshot({
      accent: "colour75",
      status: { idle: "colour10" },
      glyphs: { active: "◆" },
    });
    expect(rgbaKey(snapshot.colors.accent)).toBe("95,175,255,255");
    expect(rgbaKey(snapshot.colors.status.idle)).toBe("0,255,0,255");
    expect(snapshot.glyphs.active).toBe("◆");
    expect(snapshot.glyphs.inactive).toBe(DARK_THEME.glyphs.inactive);
  });

  it("returns immutable stable containers for identical store state", () => {
    const store = createSemanticThemeStore({ mode: "dark" });
    const first = store.getSnapshot();
    store.setMode("dark");
    expect(store.getSnapshot()).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.colors)).toBe(true);
    expect(Object.isFrozen(first.colors.status)).toBe(true);
    expect(Object.isFrozen(first.density)).toBe(true);
    expect(Object.isFrozen(first.borders)).toBe(true);
    expect(Object.isFrozen(first.glyphs)).toBe(true);
  });

  it("keeps focus/accent colors distinct from semantic status colors in both palettes", () => {
    for (const snapshot of [DARK_THEME, LIGHT_THEME]) {
      const reserved = new Set([rgbaKey(snapshot.colors.accent), rgbaKey(snapshot.colors.focus)]);
      expect(reserved.has(rgbaKey(snapshot.colors.status.blocked))).toBe(false);
      expect(reserved.has(rgbaKey(snapshot.colors.status.working))).toBe(false);
      expect(reserved.has(rgbaKey(snapshot.colors.status.done))).toBe(false);
      expect(reserved.has(rgbaKey(snapshot.colors.status.idle))).toBe(false);
      expect(reserved.has(rgbaKey(snapshot.colors.status.unknown))).toBe(false);
    }
  });

  it("keeps focus collision-safe for every curated accent against resolved status colors", () => {
    for (const preset of THEME_PRESETS) {
      const snapshot = createSemanticThemeSnapshot({ mode: "dark", accent: preset.accent });
      const statusColors = Object.values(snapshot.colors.status).map(rgbaKey);
      expect(snapshot.colors.accent).toBeDefined();
      expect(statusColors).not.toContain(rgbaKey(snapshot.colors.focus));
      expect(statusColors).not.toContain(rgbaKey(snapshot.colors.focusBorder));
    }
  });
});

describe("semantic theme store", () => {
  it("follows renderer theme_mode only while setting is system and unsubscribes cleanly", () => {
    const source = new FakeThemeModeSource("dark");
    const store = createSemanticThemeStore({ mode: "system" });
    let notifications = 0;
    store.subscribe(() => notifications++);

    const unsubscribeRenderer = store.followRendererThemeMode(source);
    expect(store.getSnapshot().mode).toBe("dark");
    expect(source.listeners.size).toBe(1);

    source.emit("light");
    expect(store.getSnapshot().mode).toBe("light");
    expect(notifications).toBe(1);

    store.setMode("dark");
    source.emit("light");
    expect(store.getSnapshot().mode).toBe("dark");
    expect(notifications).toBe(2);

    store.setMode("system");
    expect(store.getSnapshot().mode).toBe("light");
    expect(notifications).toBe(3);

    unsubscribeRenderer();
    expect(source.listeners.size).toBe(0);
    source.emit("dark");
    expect(store.getSnapshot().mode).toBe("light");
    expect(notifications).toBe(3);
  });

  it("notifies subscribers once per material accent change", () => {
    const store = createSemanticThemeStore({ mode: "dark", accent: "colour75" });
    const snapshots = [store.getSnapshot()];
    const unsubscribe = store.subscribe(() => snapshots.push(store.getSnapshot()));

    store.setAccent("colour75");
    store.setAccent("colour203");
    store.setAccent("colour203");
    unsubscribe();
    store.setAccent("colour114");

    expect(snapshots).toHaveLength(2);
    expect(rgbaKey(snapshots[0]!.colors.accent)).toBe("95,175,255,255");
    expect(rgbaKey(snapshots[1]!.colors.accent)).toBe("255,95,95,255");
  });
});
