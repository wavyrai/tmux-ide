import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseAppConfig } from "../../../lib/app-config.ts";
import {
  DARK_THEME,
  colorToPackedRgb,
  colorToThemeBytes,
  type ResolvedThemeMode,
  type ThemeModeSource,
} from "../theme.ts";
import { createAppearanceOwner } from "./application-appearance-owner.ts";
import type {
  ApplicationTerminalPaletteOwner,
  ApplicationTerminalPaletteSnapshot,
} from "./application-terminal-palette-owner.ts";

class ThemeRenderer extends EventEmitter implements ThemeModeSource {
  themeMode: ResolvedThemeMode | null = "dark";
}

function paletteSnapshot(
  defaultBackground: string,
  defaultForeground: string,
  detectedMode: ResolvedThemeMode,
  palette: readonly (string | null)[] = Array(16).fill(null),
): ApplicationTerminalPaletteSnapshot {
  return Object.freeze({
    availability: "available",
    detectedMode,
    palette: Object.freeze(Array.from({ length: 16 }, (_, index) => palette[index] ?? null)),
    defaultForeground,
    defaultBackground,
    cursorColor: null,
    mouseForeground: null,
    mouseBackground: null,
    tekForeground: null,
    tekBackground: null,
    highlightBackground: null,
    highlightForeground: null,
    capabilities: null,
    signature: `${detectedMode}:${defaultBackground}:${defaultForeground}:${palette.join(",")}`,
  });
}

const defaultDarkPalette = paletteSnapshot("#000000", "#ffffff", "dark");

class PaletteOwner implements ApplicationTerminalPaletteOwner {
  readonly ready = Promise.resolve();
  disposeCount = 0;
  private listeners = new Set<() => void>();

  constructor(private current: ApplicationTerminalPaletteSnapshot = defaultDarkPalette) {}

  getSnapshot = () => this.current;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  refresh = async () => undefined;
  dispose = () => {
    this.disposeCount += 1;
    this.listeners.clear();
  };
  publish(next: ApplicationTerminalPaletteSnapshot) {
    this.current = next;
    for (const listener of this.listeners) listener();
  }
  listenerCount() {
    return this.listeners.size;
  }
}

const previousConfig = process.env.TMUX_IDE_CONFIG;
const roots: string[] = [];

function useTemporaryConfig(): string {
  const root = mkdtempSync(join(tmpdir(), "tmux-ide-appearance-"));
  roots.push(root);
  const path = join(root, "config.json");
  process.env.TMUX_IDE_CONFIG = path;
  return path;
}

afterEach(() => {
  if (previousConfig === undefined) delete process.env.TMUX_IDE_CONFIG;
  else process.env.TMUX_IDE_CONFIG = previousConfig;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("createAppearanceOwner", () => {
  it("cycles and persists the theme immediately", () => {
    const path = useTemporaryConfig();
    const paletteOwner = new PaletteOwner();
    const owner = createAppearanceOwner(
      parseAppConfig({ theme: { mode: "dark" } }),
      new ThemeRenderer(),
      paletteOwner,
    );

    owner.cycleTheme();

    expect(owner.theme().setting).toBe("light");
    expect(owner.note()).toBe("theme → light");
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ theme: { mode: "light" } });
    owner.dispose();
  });

  it("publishes a host palette change as one complete system appearance generation", () => {
    const paletteOwner = new PaletteOwner();
    const owner = createAppearanceOwner(
      parseAppConfig({ theme: { mode: "system" } }),
      new ThemeRenderer(),
      paletteOwner,
    );
    // Solid accessors do not expose subscribe; observe the palette owner event
    // boundary and assert the appearance generation advances exactly once.
    const before = owner.appearance();
    paletteOwner.publish(
      paletteSnapshot("#f4f4f2", "#202124", "light", [
        "#101010",
        "#b42318",
        "#067647",
        "#b54708",
        "#175cd3",
        "#6938ef",
        "#026aa2",
        "#e4e7ec",
      ]),
    );
    const after = owner.appearance();
    expect(after.generation - before.generation).toBe(1);
    expect(after.theme.mode).toBe("light");
    expect(after.palette.background).toBe(colorToPackedRgb(DARK_THEME.roles.surfaces.terminal));
    expect(after.palette.foreground).toBe(colorToPackedRgb(DARK_THEME.roles.text.primary));
    expect(after.theme).toBe(owner.theme());
    expect(after.palette).toBe(owner.palette());
    owner.dispose();
  });

  it("cannot produce a light canvas with stale black app chrome", () => {
    const paletteOwner = new PaletteOwner(
      paletteSnapshot("#f7f7f5", "#191919", "light", [
        "#111111",
        "#d92d20",
        "#039855",
        "#dc6803",
        "#1570ef",
        "#7f56d9",
        "#088ab2",
        "#eeeeee",
      ]),
    );
    const owner = createAppearanceOwner(
      parseAppConfig({ theme: { mode: "system" } }),
      new ThemeRenderer(),
      paletteOwner,
    );
    const snapshot = owner.appearance();
    const luminance = (color: Parameters<typeof colorToThemeBytes>[0]) => {
      const [red, green, blue] = colorToThemeBytes(color);
      return 0.299 * red + 0.587 * green + 0.114 * blue;
    };

    expect(snapshot.theme.mode).toBe("light");
    expect(luminance(snapshot.theme.roles.surfaces.canvas)).toBeGreaterThan(200);
    expect(luminance(snapshot.theme.roles.surfaces.panel)).toBeGreaterThan(180);
    expect(luminance(snapshot.theme.roles.surfaces.header)).toBeGreaterThan(180);
    expect(luminance(snapshot.theme.roles.surfaces.command)).toBeGreaterThan(180);
    owner.dispose();
  });

  it("retains the latest host palette while explicit modes remain independent", () => {
    useTemporaryConfig();
    const paletteOwner = new PaletteOwner();
    const owner = createAppearanceOwner(
      parseAppConfig({ theme: { mode: "dark" } }),
      new ThemeRenderer(),
      paletteOwner,
    );
    const initial = owner.appearance();
    paletteOwner.publish(paletteSnapshot("#fafafa", "#101010", "light"));

    expect(owner.appearance()).toBe(initial);
    expect(owner.theme().mode).toBe("dark");
    owner.cycleTheme();
    expect(owner.theme().setting).toBe("light");
    owner.cycleTheme();
    expect(owner.theme().setting).toBe("system");
    expect(owner.theme().mode).toBe("light");
    expect(colorToThemeBytes(owner.theme().roles.surfaces.canvas).slice(0, 3)).toEqual([
      250, 250, 250,
    ]);
    owner.dispose();
  });

  it("preserves every explicit terminal color across repeated appearance cycles and cleans up", () => {
    useTemporaryConfig();
    const renderer = new ThemeRenderer();
    const paletteOwner = new PaletteOwner();
    const owner = createAppearanceOwner(
      parseAppConfig({ theme: { mode: "dark" } }),
      renderer,
      paletteOwner,
    );
    const initialAnsi = owner.palette().ansiForeground;
    const initialForeground = owner.palette().foreground;
    const initialBackground = owner.palette().background;
    const explicitColors = [0x000000, 0x7f3fbf, 0xffffff, 0x123456, 0xfedcba];

    for (let cycle = 0; cycle < 25; cycle += 1) {
      owner.cycleTheme();
      owner.cycleTheme();
      owner.cycleTheme();
      expect(owner.palette().ansiForeground).toBe(initialAnsi);
      expect(owner.palette().foreground).toBe(initialForeground);
      expect(owner.palette().background).toBe(initialBackground);
      expect(explicitColors.map(owner.palette().resolveForeground)).toEqual(explicitColors);
      expect(explicitColors.map(owner.palette().resolveBackground)).toEqual(explicitColors);
    }

    expect(paletteOwner.listenerCount()).toBe(1);
    expect(renderer.listenerCount("theme_mode")).toBe(1);
    owner.dispose();
    expect(paletteOwner.disposeCount).toBe(1);
    expect(paletteOwner.listenerCount()).toBe(0);
    expect(renderer.listenerCount("theme_mode")).toBe(0);
  });

  it("keeps mirrored terminal defaults stable while light chrome and overlays change", () => {
    useTemporaryConfig();
    const owner = createAppearanceOwner(
      parseAppConfig({ theme: { mode: "dark" } }),
      new ThemeRenderer(),
      new PaletteOwner(),
    );
    const dark = owner.appearance();

    owner.cycleTheme();
    const light = owner.appearance();

    expect(light.theme.mode).toBe("light");
    expect(light.palette.foreground).toBe(dark.palette.foreground);
    expect(light.palette.background).toBe(dark.palette.background);
    expect(light.palette.searchCurrent).not.toBe(dark.palette.searchCurrent);
    owner.dispose();
  });
});
