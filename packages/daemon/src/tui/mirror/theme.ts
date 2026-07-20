/**
 * Semantic theme substrate for the unified app.
 *
 * This module is still the compatibility bridge for the extracted surfaces:
 * existing named RGBA exports stay stable and map to the default dark snapshot.
 * New code should consume {@link SemanticThemeSnapshot} / {@link ThemeStore}
 * instead of inventing per-surface colors.
 *
 * Node-free on purpose: the web host (docs/tui-web) imports this module
 * verbatim, aliasing @opentui/core to a browser shim that only exposes RGBA.
 */
import { RGBA } from "@opentui/core";

export type ResolvedThemeMode = "dark" | "light";
export type ThemeModeSetting = ResolvedThemeMode | "system";

export interface ThemeModeSource {
  readonly themeMode: ResolvedThemeMode | null;
  on(event: "theme_mode", listener: (mode: ResolvedThemeMode) => void): unknown;
  off(event: "theme_mode", listener: (mode: ResolvedThemeMode) => void): unknown;
}

export interface SemanticThemeColors {
  readonly background: RGBA;
  readonly surface: RGBA;
  readonly surfaceRaised: RGBA;
  readonly foreground: RGBA;
  readonly mutedForeground: RGBA;
  readonly border: RGBA;
  readonly accent: RGBA;
  readonly accentMuted: RGBA;
  readonly focus: RGBA;
  readonly focusBorder: RGBA;
  readonly selection: RGBA;
  readonly selectionForeground: RGBA;
  readonly hover: RGBA;
  readonly buttonHover: RGBA;
  readonly attention: RGBA;
  readonly status: {
    readonly blocked: RGBA;
    readonly working: RGBA;
    readonly done: RGBA;
    readonly idle: RGBA;
    readonly unknown: RGBA;
  };
}

export interface SemanticThemeTokens {
  readonly colors: SemanticThemeColors;
  readonly density: {
    readonly compactGap: number;
    readonly comfortableGap: number;
    readonly detailedGap: number;
    readonly paddingX: number;
  };
  readonly borders: {
    readonly style: "single" | "rounded" | "double" | "bold";
    readonly focusedStyle: "single" | "rounded" | "double" | "bold";
  };
  readonly glyphs: {
    readonly active: string;
    readonly inactive: string;
    readonly focusHorizontal: string;
    readonly focusVertical: string;
    readonly check: string;
    readonly scrollThumb: string;
    readonly scrollTrack: string;
  };
}

export interface SemanticThemeSnapshot extends SemanticThemeTokens {
  readonly mode: ResolvedThemeMode;
  readonly setting: ThemeModeSetting;
}

export interface ThemeConfigInput {
  mode?: ThemeModeSetting;
  accent?: string;
  muted?: string;
  fg?: string;
  status?: Partial<Record<keyof SemanticThemeColors["status"], string>>;
  glyphs?: Partial<Pick<SemanticThemeTokens["glyphs"], "active" | "inactive">>;
}

export interface ThemeStoreOptions {
  mode?: ThemeModeSetting;
  accent?: string;
  rendererMode?: ResolvedThemeMode | null;
}

export interface ThemeStore {
  getSnapshot(): SemanticThemeSnapshot;
  subscribe(listener: () => void): () => void;
  setMode(mode: ThemeModeSetting): void;
  setAccent(accent: string | undefined): void;
  configure(config: ThemeConfigInput | undefined): void;
  followRendererThemeMode(source: ThemeModeSource): () => void;
}

const STANDARD_ANSI: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [128, 0, 0],
  [0, 128, 0],
  [128, 128, 0],
  [0, 0, 128],
  [128, 0, 128],
  [0, 128, 128],
  [192, 192, 192],
  [128, 128, 128],
  [255, 0, 0],
  [0, 255, 0],
  [255, 255, 0],
  [0, 0, 255],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255],
];

const ANSI_LEVELS = [0, 95, 135, 175, 215, 255] as const;
export type RgbaByteTuple = readonly [number, number, number, number];
type RgbaWithOptionalToInts = RGBA & { toInts?: () => [number, number, number, number] };

function rgba(r: number, g: number, b: number, a = 255): RGBA {
  return RGBA.fromInts(r, g, b, a);
}

function byteChannel(channel: number): number {
  return Math.max(0, Math.min(255, Math.round(channel)));
}

export function colorToThemeBytes(color: RGBA): RgbaByteTuple {
  const maybeRealRgba = color as RgbaWithOptionalToInts;
  if (typeof maybeRealRgba.toInts === "function") {
    const [r, g, b, a] = maybeRealRgba.toInts();
    return [byteChannel(r), byteChannel(g), byteChannel(b), byteChannel(a)];
  }
  return [byteChannel(color.r), byteChannel(color.g), byteChannel(color.b), byteChannel(color.a)];
}

function rgbaKey(color: RGBA): string {
  return colorToThemeBytes(color).join(",");
}

function parseThemeColor(value: string | undefined, fallback: RGBA): RGBA {
  if (!value) return fallback;
  const tmuxMatch = value.match(/^colou?r(\d+)$/u);
  if (tmuxMatch) {
    const n = Number(tmuxMatch[1]);
    if (!Number.isInteger(n) || n < 0 || n > 255) return fallback;
    if (n < 16) {
      const [r, g, b] = STANDARD_ANSI[n]!;
      return rgba(r, g, b);
    }
    if (n < 232) {
      const idx = n - 16;
      const r = ANSI_LEVELS[Math.floor(idx / 36)]!;
      const g = ANSI_LEVELS[Math.floor((idx % 36) / 6)]!;
      const b = ANSI_LEVELS[idx % 6]!;
      return rgba(r, g, b);
    }
    const level = 8 + 10 * (n - 232);
    return rgba(level, level, level);
  }

  const hexMatch = value.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/u);
  if (!hexMatch) return fallback;
  let hex = hexMatch[1]!;
  if (hex.length === 3) {
    const [r, g, b] = hex.split("");
    hex = `${r}${r}${g}${g}${b}${b}`;
  }
  return rgba(
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  );
}

function mix(base: RGBA, overlay: RGBA, amount: number, alphaByteOverride?: number): RGBA {
  const [baseR, baseG, baseB, baseA] = colorToThemeBytes(base);
  const [overlayR, overlayG, overlayB] = colorToThemeBytes(overlay);
  const alphaByte = alphaByteOverride === undefined ? baseA : byteChannel(alphaByteOverride);
  const channel = (a: number, b: number) => Math.round(a + (b - a) * amount);
  return rgba(
    channel(baseR, overlayR),
    channel(baseG, overlayG),
    channel(baseB, overlayB),
    alphaByte,
  );
}

function cloneColor(color: RGBA): RGBA {
  const [r, g, b, a] = colorToThemeBytes(color);
  return rgba(r, g, b, a);
}

function collidesWithAny(color: RGBA, colors: readonly RGBA[]): boolean {
  const key = rgbaKey(color);
  return colors.some((candidate) => rgbaKey(candidate) === key);
}

function safeColorCandidate(candidates: readonly RGBA[], forbidden: readonly RGBA[]): RGBA {
  for (const candidate of candidates) {
    if (!collidesWithAny(candidate, forbidden)) return cloneColor(candidate);
  }
  for (const r of ANSI_LEVELS) {
    for (const g of ANSI_LEVELS) {
      for (const b of ANSI_LEVELS) {
        const candidate = rgba(r, g, b);
        if (!collidesWithAny(candidate, forbidden)) return candidate;
      }
    }
  }
  for (let channel = 0; channel <= 255; channel++) {
    const candidate = rgba(channel, channel, channel);
    if (!collidesWithAny(candidate, forbidden)) return candidate;
  }
  throw new Error("No collision-safe theme color candidate available");
}

function safeFocusColor(base: SemanticThemeSnapshot, statusColors: readonly RGBA[]): RGBA {
  const contrast = base.mode === "dark" ? rgba(255, 255, 255) : rgba(0, 0, 0);
  return safeColorCandidate(
    [
      base.colors.focus,
      base.colors.focusBorder,
      ...([0.18, 0.28, 0.38, 0.5, 0.64, 0.78] as const).map((amount) =>
        mix(base.colors.focus, contrast, amount),
      ),
    ],
    statusColors,
  );
}

function safeFocusBorderColor(
  focus: RGBA,
  preferred: RGBA,
  base: SemanticThemeSnapshot,
  statusColors: readonly RGBA[],
): RGBA {
  const contrast = base.mode === "dark" ? rgba(255, 255, 255) : rgba(0, 0, 0);
  return safeColorCandidate(
    [
      preferred,
      base.colors.focusBorder,
      mix(focus, contrast, base.mode === "dark" ? 0.18 : 0.14),
      mix(focus, contrast, base.mode === "dark" ? 0.28 : 0.24),
      base.colors.focus,
    ],
    [...statusColors, focus],
  );
}

function freezeSnapshot(snapshot: SemanticThemeSnapshot): SemanticThemeSnapshot {
  for (const colors of [
    snapshot.colors,
    snapshot.colors.status,
    snapshot.density,
    snapshot.borders,
    snapshot.glyphs,
  ]) {
    Object.freeze(colors);
  }
  return Object.freeze(snapshot);
}

function darkPalette(): SemanticThemeSnapshot {
  const accent = rgba(130, 170, 255);
  return freezeSnapshot({
    mode: "dark",
    setting: "dark",
    colors: {
      background: rgba(16, 16, 22),
      surface: rgba(22, 22, 30),
      surfaceRaised: rgba(30, 30, 40),
      foreground: rgba(212, 212, 216),
      mutedForeground: rgba(110, 110, 130),
      border: rgba(60, 60, 80),
      accent,
      accentMuted: rgba(60, 66, 92),
      focus: rgba(130, 170, 255),
      focusBorder: rgba(110, 145, 230),
      selection: rgba(40, 46, 66),
      selectionForeground: rgba(255, 255, 255),
      hover: rgba(30, 34, 48),
      buttonHover: rgba(52, 60, 86),
      attention: rgba(92, 44, 48),
      status: {
        blocked: rgba(255, 95, 95),
        working: rgba(255, 215, 95),
        done: rgba(135, 175, 255),
        idle: rgba(135, 215, 135),
        unknown: rgba(128, 128, 128),
      },
    },
    density: { compactGap: 0, comfortableGap: 1, detailedGap: 2, paddingX: 1 },
    borders: { style: "single", focusedStyle: "single" },
    glyphs: {
      active: "●",
      inactive: "○",
      focusHorizontal: "─",
      focusVertical: "│",
      check: "✓",
      scrollThumb: "█",
      scrollTrack: "░",
    },
  });
}

function lightPalette(): SemanticThemeSnapshot {
  const accent = rgba(45, 105, 220);
  return freezeSnapshot({
    mode: "light",
    setting: "light",
    colors: {
      background: rgba(248, 248, 250),
      surface: rgba(238, 240, 246),
      surfaceRaised: rgba(255, 255, 255),
      foreground: rgba(28, 32, 42),
      mutedForeground: rgba(92, 99, 118),
      border: rgba(188, 196, 214),
      accent,
      accentMuted: rgba(212, 224, 255),
      focus: rgba(45, 105, 220),
      focusBorder: rgba(20, 80, 190),
      selection: rgba(218, 228, 252),
      selectionForeground: rgba(15, 25, 45),
      hover: rgba(228, 234, 246),
      buttonHover: rgba(208, 220, 246),
      attention: rgba(255, 224, 224),
      status: {
        blocked: rgba(210, 52, 72),
        working: rgba(176, 120, 0),
        done: rgba(66, 92, 210),
        idle: rgba(38, 135, 82),
        unknown: rgba(112, 118, 130),
      },
    },
    density: { compactGap: 0, comfortableGap: 1, detailedGap: 2, paddingX: 1 },
    borders: { style: "single", focusedStyle: "single" },
    glyphs: {
      active: "●",
      inactive: "○",
      focusHorizontal: "─",
      focusVertical: "│",
      check: "✓",
      scrollThumb: "█",
      scrollTrack: "░",
    },
  });
}

export const DARK_THEME = darkPalette();
export const LIGHT_THEME = lightPalette();

function baseFor(mode: ResolvedThemeMode): SemanticThemeSnapshot {
  return mode === "dark" ? DARK_THEME : LIGHT_THEME;
}

function resolvedMode(
  setting: ThemeModeSetting,
  rendererMode: ResolvedThemeMode | null,
): ResolvedThemeMode {
  return setting === "system" ? (rendererMode ?? "dark") : setting;
}

function withAppThemeConfig(
  base: SemanticThemeSnapshot,
  setting: ThemeModeSetting,
  config: ThemeConfigInput | undefined,
): SemanticThemeSnapshot {
  const accent = parseThemeColor(config?.accent, base.colors.accent);
  const foreground = parseThemeColor(config?.fg, base.colors.foreground);
  const muted = parseThemeColor(config?.muted, base.colors.mutedForeground);
  const white = rgba(255, 255, 255);
  const black = rgba(0, 0, 0);
  const contrast = base.mode === "dark" ? white : black;
  const status = {
    blocked: parseThemeColor(config?.status?.blocked, base.colors.status.blocked),
    working: parseThemeColor(config?.status?.working, base.colors.status.working),
    done: parseThemeColor(config?.status?.done, base.colors.status.done),
    idle: parseThemeColor(config?.status?.idle, base.colors.status.idle),
    unknown: parseThemeColor(config?.status?.unknown, base.colors.status.unknown),
  };
  const statusColors = Object.values(status);
  const accentCollidesWithStatus = collidesWithAny(accent, statusColors);
  const focus = accentCollidesWithStatus ? safeFocusColor(base, statusColors) : cloneColor(accent);
  const preferredFocusBorder = accentCollidesWithStatus
    ? base.colors.focusBorder
    : mix(accent, contrast, base.mode === "dark" ? 0.18 : 0.14);
  const focusBorder = safeFocusBorderColor(focus, preferredFocusBorder, base, statusColors);
  return freezeSnapshot({
    mode: base.mode,
    setting,
    colors: {
      background: cloneColor(base.colors.background),
      surface: cloneColor(base.colors.surface),
      surfaceRaised: cloneColor(base.colors.surfaceRaised),
      foreground,
      mutedForeground: muted,
      border: cloneColor(base.colors.border),
      accent,
      accentMuted: mix(base.colors.surface, accent, base.mode === "dark" ? 0.34 : 0.18),
      focus,
      focusBorder,
      selection: mix(base.colors.background, accent, base.mode === "dark" ? 0.22 : 0.16),
      selectionForeground: cloneColor(base.colors.selectionForeground),
      hover: mix(base.colors.background, accent, base.mode === "dark" ? 0.08 : 0.06),
      buttonHover: mix(base.colors.background, accent, base.mode === "dark" ? 0.24 : 0.16),
      attention: cloneColor(base.colors.attention),
      status,
    },
    density: { ...base.density },
    borders: { ...base.borders },
    glyphs: {
      ...base.glyphs,
      active: config?.glyphs?.active ?? base.glyphs.active,
      inactive: config?.glyphs?.inactive ?? base.glyphs.inactive,
    },
  });
}

export function createSemanticThemeSnapshot(
  config: ThemeConfigInput | undefined = undefined,
  rendererMode: ResolvedThemeMode | null = null,
): SemanticThemeSnapshot {
  const setting = config?.mode ?? "dark";
  return withAppThemeConfig(baseFor(resolvedMode(setting, rendererMode)), setting, config);
}

export function createSemanticThemeStore(
  config: ThemeConfigInput | undefined = undefined,
  options: ThemeStoreOptions = {},
): ThemeStore {
  let currentConfig: ThemeConfigInput = {
    ...config,
    mode: options.mode ?? config?.mode ?? "dark",
    accent: options.accent ?? config?.accent,
  };
  let rendererMode = options.rendererMode ?? null;
  let snapshot = createSemanticThemeSnapshot(currentConfig, rendererMode);
  const listeners = new Set<() => void>();

  const refresh = () => {
    const next = createSemanticThemeSnapshot(currentConfig, rendererMode);
    if (sameSnapshot(snapshot, next)) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setMode(mode) {
      if (currentConfig.mode === mode) return;
      currentConfig = { ...currentConfig, mode };
      refresh();
    },
    setAccent(accent) {
      if (currentConfig.accent === accent) return;
      currentConfig = { ...currentConfig, accent };
      refresh();
    },
    configure(nextConfig) {
      currentConfig = { ...nextConfig, mode: nextConfig?.mode ?? "dark" };
      refresh();
    },
    followRendererThemeMode(source) {
      const apply = (mode: ResolvedThemeMode | null) => {
        if (rendererMode === mode) return;
        rendererMode = mode;
        if (currentConfig.mode === "system") refresh();
      };
      apply(source.themeMode);
      const listener = (mode: ResolvedThemeMode) => apply(mode);
      source.on("theme_mode", listener);
      return () => {
        source.off("theme_mode", listener);
      };
    },
  };
}

function sameSnapshot(a: SemanticThemeSnapshot, b: SemanticThemeSnapshot): boolean {
  return (
    a.mode === b.mode &&
    a.setting === b.setting &&
    rgbaKey(a.colors.accent) === rgbaKey(b.colors.accent) &&
    rgbaKey(a.colors.foreground) === rgbaKey(b.colors.foreground) &&
    rgbaKey(a.colors.mutedForeground) === rgbaKey(b.colors.mutedForeground) &&
    rgbaKey(a.colors.status.blocked) === rgbaKey(b.colors.status.blocked) &&
    rgbaKey(a.colors.status.working) === rgbaKey(b.colors.status.working) &&
    rgbaKey(a.colors.status.done) === rgbaKey(b.colors.status.done) &&
    rgbaKey(a.colors.status.idle) === rgbaKey(b.colors.status.idle) &&
    rgbaKey(a.colors.status.unknown) === rgbaKey(b.colors.status.unknown) &&
    a.glyphs.active === b.glyphs.active &&
    a.glyphs.inactive === b.glyphs.inactive
  );
}

const compatibilityTheme = DARK_THEME;

export const DEFAULT_FG = compatibilityTheme.colors.foreground;
export const DEFAULT_BG = compatibilityTheme.colors.background;

/** The sidebar's surface — one lift above DEFAULT_BG so the nav column reads as
 *  chrome, not as content. */
export const SIDEBAR_BG = compatibilityTheme.colors.surface;
export const ACCENT = compatibilityTheme.colors.accent;
export const MUTED = compatibilityTheme.colors.mutedForeground;
export const BADGE_BG = compatibilityTheme.colors.accentMuted;

/** Focused-pane gutter hairline: focus is an accent signal, not agent status. */
export const FOCUS_BORDER_FG = compatibilityTheme.colors.focusBorder;

/** The selected row/tab. Always wins over HOVER_BG. */
export const TAB_ACTIVE_BG = compatibilityTheme.colors.selection;

/** A single subtle pointer-hover tint. */
export const HOVER_BG = compatibilityTheme.colors.hover;

/** A chip/button under the pointer. */
export const BUTTON_HOVER_BG = compatibilityTheme.colors.buttonHover;

/** The attention flash: a short-lived "look here" signal, distinct from focus. */
export const CHIP_ATTN_BG = compatibilityTheme.colors.attention;
