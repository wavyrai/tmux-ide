import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  COHESION_FIXTURE_V1,
  deriveAttentionBlend,
  resolveVisualTheme,
  type RendererNeutralColor,
} from "@tmux-ide/contracts";
import {
  ACCENT,
  CARD_22_3B_LIVE_THEME_WIRING_DEFERRALS,
  DARK_THEME,
  DEFAULT_BG,
  LIGHT_THEME,
  LEGACY_THEME_ALIAS_IDS,
  colorToThemeBytes,
  createSemanticThemeSnapshot,
  createSemanticThemeStore,
  type ResolvedThemeMode,
  type ThemeModeSource,
} from "./theme.ts";
import { THEME_PRESETS } from "./settings-model.ts";
import { parseAppConfig } from "../../lib/app-config.ts";

function rgbaKey(color: { r: number; g: number; b: number; a: number }): string {
  return colorToThemeBytes(color as Parameters<typeof colorToThemeBytes>[0]).join(",");
}

function rendererNeutralKey(color: RendererNeutralColor): string {
  return [color.red, color.green, color.blue, color.alpha].join(",");
}

function expectCanonicalColorProjection(
  snapshot: ReturnType<typeof createSemanticThemeSnapshot>,
  resolved: ReturnType<typeof resolveVisualTheme>,
): void {
  for (const group of ["surfaces", "text", "borders", "statusTone", "selection"] as const) {
    const actual = snapshot.roles[group] as Readonly<Record<string, Parameters<typeof rgbaKey>[0]>>;
    const expected = resolved.tokens[group] as Readonly<Record<string, RendererNeutralColor>>;
    expect(Object.keys(actual)).toEqual(Object.keys(expected));
    for (const role of Object.keys(expected)) {
      expect(rgbaKey(actual[role]!)).toBe(rendererNeutralKey(expected[role]!));
    }
  }
  expect(rgbaKey(snapshot.derived.attentionSurface)).toBe(
    rendererNeutralKey(
      deriveAttentionBlend(resolved.tokens.surfaces.panel, resolved.tokens.borders.attention),
    ),
  );
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

  it("projects the common fixture and dark/light/high-contrast canonical roles exactly", () => {
    const cases = [
      {
        config: {
          mode: "dark" as const,
          userTheme: COHESION_FIXTURE_V1.theme.user,
          projectTheme: COHESION_FIXTURE_V1.theme.project ?? undefined,
          accessibility: COHESION_FIXTURE_V1.theme.accessibility,
        },
      },
      { config: { mode: "light" as const } },
      {
        config: {
          mode: "dark" as const,
          accessibility: { reducedMotion: true, increasedContrast: true },
        },
      },
    ];
    for (const { config } of cases) {
      const expected = resolveVisualTheme({
        appearance: config.mode,
        userTheme: "userTheme" in config ? config.userTheme : undefined,
        projectTheme: "projectTheme" in config ? config.projectTheme : undefined,
        accessibility: "accessibility" in config ? config.accessibility : undefined,
      });
      expectCanonicalColorProjection(createSemanticThemeSnapshot(config), expected);
    }
    expect(Object.isFrozen(COHESION_FIXTURE_V1)).toBe(true);
  });

  it("does not treat parser-filled legacy defaults as canonical theme overrides", () => {
    const cases = [
      { mode: "dark" as const, rendererMode: null, accessibility: undefined },
      { mode: "light" as const, rendererMode: null, accessibility: undefined },
      { mode: "system" as const, rendererMode: "light" as const, accessibility: undefined },
      {
        mode: "dark" as const,
        rendererMode: null,
        accessibility: { reducedMotion: true, increasedContrast: true },
      },
    ];

    for (const testCase of cases) {
      const parsed = parseAppConfig({ theme: { mode: testCase.mode } }).theme;
      const config = { ...parsed, accessibility: testCase.accessibility };
      const expectedMode =
        testCase.mode === "system" ? (testCase.rendererMode ?? "dark") : testCase.mode;
      const expected = resolveVisualTheme({
        appearance: expectedMode,
        accessibility: testCase.accessibility,
      });
      const snapshot = createSemanticThemeSnapshot(config, testCase.rendererMode);
      expectCanonicalColorProjection(snapshot, expected);
      expect(snapshot.canonical).toEqual(expected.tokens);
    }
  });

  it("preserves only legacy theme leaves explicitly present in parsed app config", () => {
    const parsed = parseAppConfig({
      theme: {
        mode: "light",
        accent: "#123456",
        status: { blocked: "#654321" },
        glyphs: { active: "◆" },
      },
    }).theme;
    const snapshot = createSemanticThemeSnapshot(parsed);
    const canonical = resolveVisualTheme({ appearance: "light" });

    expect(rgbaKey(snapshot.colors.accent)).toBe("18,52,86,255");
    expect(rgbaKey(snapshot.roles.statusTone.warning)).toBe("101,67,33,255");
    expect(rgbaKey(snapshot.roles.text.primary)).toBe(
      rendererNeutralKey(canonical.tokens.text.primary),
    );
    expect(rgbaKey(snapshot.roles.text.muted)).toBe(
      rendererNeutralKey(canonical.tokens.text.muted),
    );
    expect(snapshot.glyphs.active).toBe("◆");
    expect(snapshot.glyphs.inactive).toBe(DARK_THEME.glyphs.inactive);
  });

  it("keeps the explicit compatibility export list mapped to the canonical dark facade", () => {
    expect(LEGACY_THEME_ALIAS_IDS).toEqual([
      "DEFAULT_FG",
      "DEFAULT_BG",
      "SIDEBAR_BG",
      "ACCENT",
      "MUTED",
      "BADGE_BG",
      "FOCUS_BORDER_FG",
      "TAB_ACTIVE_BG",
      "HOVER_BG",
      "BUTTON_HOVER_BG",
      "CHIP_ATTN_BG",
    ]);
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
    expect(rgbaKey(snapshot.roles.text.link)).toBe("255,0,170,255");
    expect(rgbaKey(snapshot.roles.borders.focused)).toBe("255,0,170,255");
    expect(rgbaKey(snapshot.roles.selection.selection)).toBe(rgbaKey(snapshot.colors.selection));
    expect(rgbaKey(snapshot.colors.status.blocked)).toBe(rgbaKey(DARK_THEME.colors.status.blocked));
  });

  it("keeps the canonical high-contrast focus outline above a legacy accent", () => {
    const snapshot = createSemanticThemeSnapshot({
      mode: "dark",
      accent: "#ff00aa",
      accessibility: { increasedContrast: true },
    });
    expect(rgbaKey(snapshot.roles.borders.focused)).toBe("255,255,255,255");
    expect(rgbaKey(snapshot.roles.text.link)).toBe("255,0,170,255");
  });

  it("preserves a saved accent that collides with status while deriving collision-safe focus", () => {
    const [r, g, b] = colorToThemeBytes(DARK_THEME.colors.status.blocked);
    const statusAccent = `#${[r, g, b]
      .map((channel) => channel.toString(16).padStart(2, "0"))
      .join("")}`;
    const snapshot = createSemanticThemeSnapshot({ mode: "dark", accent: statusAccent });
    expect(rgbaKey(snapshot.colors.accent)).toBe(rgbaKey(snapshot.colors.status.blocked));
    expect(rgbaKey(snapshot.colors.focus)).toBe(rgbaKey(DARK_THEME.roles.borders.focused));
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
    expect(rgbaKey(snapshot.roles.statusTone.neutral)).toBe("0,255,0,255");
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
    expect(Object.isFrozen(first.roles)).toBe(true);
    expect(Object.isFrozen(first.roles.surfaces)).toBe(true);
    expect(Object.isFrozen(first.derived)).toBe(true);
    expect(Object.isFrozen(first.density)).toBe(true);
    expect(Object.isFrozen(first.borders)).toBe(true);
    expect(Object.isFrozen(first.glyphs)).toBe(true);
    expect(Object.isFrozen(first.canonical)).toBe(true);
    expect(Object.isFrozen(first.canonical.motion)).toBe(true);
    expect(Object.isFrozen(first.canonical.motion.fast)).toBe(true);
  });

  it("keeps compatibility focus signals distinct from semantic status colors", () => {
    for (const snapshot of [DARK_THEME, LIGHT_THEME]) {
      const reserved = new Set([
        rgbaKey(snapshot.colors.focus),
        rgbaKey(snapshot.colors.focusBorder),
      ]);
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

  it("retains and notifies on canonical non-color token changes", () => {
    const projectTheme = (fast: number) => ({
      version: 1 as const,
      id: "motion-reactivity",
      name: "Motion reactivity",
      appearance: "dark" as const,
      overrides: { motion: { fast: { unit: "ms" as const, value: fast } } },
    });
    const store = createSemanticThemeStore({ mode: "dark", projectTheme: projectTheme(10) });
    const first = store.getSnapshot();
    let notifications = 0;
    store.subscribe(() => notifications++);

    store.configure({ mode: "dark", projectTheme: projectTheme(20) });
    expect(notifications).toBe(1);
    expect(store.getSnapshot()).not.toBe(first);
    expect(store.getSnapshot().canonical.motion.fast.value).toBe(20);

    store.configure({ mode: "dark", projectTheme: projectTheme(20) });
    expect(notifications).toBe(1);
  });
});

describe("Card 22.3b live-theme wiring deferrals", () => {
  it("keeps the two root-composition writes explicit until app.tsx owns them", () => {
    expect(CARD_22_3B_LIVE_THEME_WIRING_DEFERRALS).toEqual([
      { component: "Sidebar", prop: "theme", owner: "app.tsx" },
      { component: "MissionsSurface", prop: "semanticTheme", owner: "app.tsx" },
    ]);

    const app = readFileSync(fileURLToPath(new URL("./app.tsx", import.meta.url)), "utf-8");
    const sidebarCall = app.match(/<Sidebar[\s\S]*?\/>/u)?.[0];
    const missionsCall = app.match(/<MissionsSurface[\s\S]*?\/>/u)?.[0];
    expect(sidebarCall).toBeDefined();
    expect(sidebarCall).not.toContain("theme={semanticTheme()}");
    expect(missionsCall).toBeDefined();
    expect(missionsCall).not.toContain("semanticTheme={semanticTheme()}");
  });
});
