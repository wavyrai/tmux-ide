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
import {
  deriveAttentionBlend,
  resolveVisualTheme,
  type BorderTokenRole,
  type RendererNeutralColor,
  type SelectionTokenRole,
  type StatusToneRole,
  type SurfaceTokenRole,
  type TextTokenRole,
  type ThemeAccessibilityPreferences,
  type ThemeDiagnostic,
} from "@tmux-ide/contracts";

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

/** OpenTUI's RGBA projection of the renderer-neutral product color vocabulary. */
export interface OpenTuiSemanticColorRoles {
  readonly surfaces: Readonly<Record<SurfaceTokenRole, RGBA>>;
  readonly text: Readonly<Record<TextTokenRole, RGBA>>;
  readonly borders: Readonly<Record<BorderTokenRole, RGBA>>;
  readonly statusTone: Readonly<Record<StatusToneRole, RGBA>>;
  readonly selection: Readonly<Record<SelectionTokenRole, RGBA>>;
}

export interface OpenTuiDerivedColors {
  /** Terminal-cell background derived from canonical panel + attention tokens. */
  readonly attentionSurface: RGBA;
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
  readonly roles: OpenTuiSemanticColorRoles;
  readonly derived: OpenTuiDerivedColors;
  readonly accessibility: ThemeAccessibilityPreferences;
  readonly diagnostics: readonly ThemeDiagnostic[];
  readonly futureSources: readonly ThemeDiagnostic["source"][];
}

export interface ThemeConfigInput {
  mode?: ThemeModeSetting;
  userTheme?: unknown;
  projectTheme?: unknown;
  accessibility?: Partial<ThemeAccessibilityPreferences>;
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

function rgbaFromRendererNeutral(color: RendererNeutralColor): RGBA {
  return rgba(color.red, color.green, color.blue, color.alpha);
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
    snapshot.roles,
    snapshot.roles.surfaces,
    snapshot.roles.text,
    snapshot.roles.borders,
    snapshot.roles.statusTone,
    snapshot.roles.selection,
    snapshot.derived,
    snapshot.density,
    snapshot.borders,
    snapshot.glyphs,
    snapshot.accessibility,
    snapshot.diagnostics,
    snapshot.futureSources,
  ]) {
    Object.freeze(colors);
  }
  return Object.freeze(snapshot);
}

const DEFAULT_ACCESSIBILITY: ThemeAccessibilityPreferences = Object.freeze({
  reducedMotion: false,
  increasedContrast: false,
});

function projectColorRoles(
  tokens: ReturnType<typeof resolveVisualTheme>["tokens"],
): OpenTuiSemanticColorRoles {
  const surfaces: Record<SurfaceTokenRole, RGBA> = {
    canvas: rgbaFromRendererNeutral(tokens.surfaces.canvas),
    panel: rgbaFromRendererNeutral(tokens.surfaces.panel),
    panelRaised: rgbaFromRendererNeutral(tokens.surfaces.panelRaised),
    terminal: rgbaFromRendererNeutral(tokens.surfaces.terminal),
    header: rgbaFromRendererNeutral(tokens.surfaces.header),
    headerActive: rgbaFromRendererNeutral(tokens.surfaces.headerActive),
    command: rgbaFromRendererNeutral(tokens.surfaces.command),
  };
  const text: Record<TextTokenRole, RGBA> = {
    primary: rgbaFromRendererNeutral(tokens.text.primary),
    secondary: rgbaFromRendererNeutral(tokens.text.secondary),
    muted: rgbaFromRendererNeutral(tokens.text.muted),
    bright: rgbaFromRendererNeutral(tokens.text.bright),
    inverse: rgbaFromRendererNeutral(tokens.text.inverse),
    link: rgbaFromRendererNeutral(tokens.text.link),
  };
  const borders: Record<BorderTokenRole, RGBA> = {
    subtle: rgbaFromRendererNeutral(tokens.borders.subtle),
    default: rgbaFromRendererNeutral(tokens.borders.default),
    focused: rgbaFromRendererNeutral(tokens.borders.focused),
    selected: rgbaFromRendererNeutral(tokens.borders.selected),
    attention: rgbaFromRendererNeutral(tokens.borders.attention),
    danger: rgbaFromRendererNeutral(tokens.borders.danger),
  };
  const statusTone: Record<StatusToneRole, RGBA> = {
    neutral: rgbaFromRendererNeutral(tokens.statusTone.neutral),
    info: rgbaFromRendererNeutral(tokens.statusTone.info),
    warning: rgbaFromRendererNeutral(tokens.statusTone.warning),
    danger: rgbaFromRendererNeutral(tokens.statusTone.danger),
    success: rgbaFromRendererNeutral(tokens.statusTone.success),
  };
  const selection: Record<SelectionTokenRole, RGBA> = {
    selection: rgbaFromRendererNeutral(tokens.selection.selection),
    selectionText: rgbaFromRendererNeutral(tokens.selection.selectionText),
    hover: rgbaFromRendererNeutral(tokens.selection.hover),
    pressed: rgbaFromRendererNeutral(tokens.selection.pressed),
    disabled: rgbaFromRendererNeutral(tokens.selection.disabled),
  };
  return { surfaces, text, borders, statusTone, selection };
}

function snapshotFromResolvedTheme(
  resolved: ReturnType<typeof resolveVisualTheme>,
  setting: ThemeModeSetting,
  accessibility: ThemeAccessibilityPreferences,
): SemanticThemeSnapshot {
  const roles = projectColorRoles(resolved.tokens);
  const derived = {
    attentionSurface: rgbaFromRendererNeutral(
      deriveAttentionBlend(resolved.tokens.surfaces.panel, resolved.tokens.borders.attention),
    ),
  };
  const colors: SemanticThemeColors = {
    background: roles.surfaces.canvas,
    surface: roles.surfaces.panel,
    surfaceRaised: roles.surfaces.panelRaised,
    foreground: roles.text.primary,
    mutedForeground: roles.text.muted,
    border: roles.borders.default,
    accent: roles.borders.focused,
    accentMuted: roles.surfaces.headerActive,
    focus: roles.borders.focused,
    focusBorder: roles.borders.focused,
    selection: roles.selection.selection,
    selectionForeground: roles.selection.selectionText,
    hover: roles.selection.hover,
    buttonHover: roles.selection.pressed,
    attention: derived.attentionSurface,
    status: {
      blocked: roles.statusTone.warning,
      working: roles.statusTone.info,
      done: roles.statusTone.success,
      idle: roles.statusTone.neutral,
      unknown: roles.statusTone.neutral,
    },
  };
  return freezeSnapshot({
    mode: resolved.appearance,
    setting,
    roles,
    derived,
    colors,
    accessibility: { ...accessibility },
    diagnostics: [...resolved.diagnostics],
    futureSources: [...resolved.futureSources],
    density: {
      compactGap: Math.floor(resolved.tokens.density.inlineGap.value),
      comfortableGap: Math.max(1, Math.round(resolved.tokens.density.sectionGap.value)),
      detailedGap: Math.max(2, Math.round(resolved.tokens.density.sectionGap.value) + 1),
      paddingX: Math.max(0, Math.round(resolved.tokens.density.controlPadding.value)),
    },
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
  const accentMuted = mix(base.colors.surface, accent, base.mode === "dark" ? 0.34 : 0.18);
  const selection = mix(base.colors.background, accent, base.mode === "dark" ? 0.22 : 0.16);
  const hover = mix(base.colors.background, accent, base.mode === "dark" ? 0.08 : 0.06);
  const pressed = mix(base.colors.background, accent, base.mode === "dark" ? 0.24 : 0.16);
  const roles: OpenTuiSemanticColorRoles = {
    surfaces: {
      ...base.roles.surfaces,
      ...(config?.accent ? { headerActive: accentMuted } : {}),
    },
    text: {
      ...base.roles.text,
      ...(config?.fg ? { primary: foreground } : {}),
      ...(config?.muted ? { secondary: muted, muted } : {}),
      ...(config?.accent ? { link: accent } : {}),
    },
    borders: {
      ...base.roles.borders,
      ...(config?.accent && !base.accessibility.increasedContrast ? { focused: focus } : {}),
    },
    statusTone: {
      ...base.roles.statusTone,
      ...(config?.status?.blocked ? { warning: status.blocked } : {}),
      ...(config?.status?.working ? { info: status.working } : {}),
      ...(config?.status?.done ? { success: status.done } : {}),
      ...(config?.status?.idle ? { neutral: status.idle } : {}),
    },
    selection: {
      ...base.roles.selection,
      ...(config?.accent ? { selection, hover, pressed } : {}),
    },
  };
  return freezeSnapshot({
    mode: base.mode,
    setting,
    roles,
    derived: base.derived,
    accessibility: base.accessibility,
    diagnostics: base.diagnostics,
    futureSources: base.futureSources,
    colors: {
      background: cloneColor(base.colors.background),
      surface: cloneColor(base.colors.surface),
      surfaceRaised: cloneColor(base.colors.surfaceRaised),
      foreground,
      mutedForeground: muted,
      border: cloneColor(base.colors.border),
      accent,
      accentMuted,
      focus,
      focusBorder,
      selection,
      selectionForeground: cloneColor(base.colors.selectionForeground),
      hover,
      buttonHover: pressed,
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
  const accessibility = {
    reducedMotion: config?.accessibility?.reducedMotion ?? DEFAULT_ACCESSIBILITY.reducedMotion,
    increasedContrast:
      config?.accessibility?.increasedContrast ?? DEFAULT_ACCESSIBILITY.increasedContrast,
  };
  const resolved = resolveVisualTheme({
    appearance: resolvedMode(setting, rendererMode),
    userTheme: config?.userTheme,
    projectTheme: config?.projectTheme,
    accessibility,
  });
  return withAppThemeConfig(
    snapshotFromResolvedTheme(resolved, setting, accessibility),
    setting,
    config,
  );
}

export const DARK_THEME = createSemanticThemeSnapshot({ mode: "dark" });
export const LIGHT_THEME = createSemanticThemeSnapshot({ mode: "light" });

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
  const colorGroup = (group: Readonly<Record<string, RGBA>>) =>
    Object.entries(group).map(([role, color]) => [role, rgbaKey(color)] as const);
  const key = (snapshot: SemanticThemeSnapshot) =>
    JSON.stringify({
      mode: snapshot.mode,
      setting: snapshot.setting,
      colors: {
        background: rgbaKey(snapshot.colors.background),
        surface: rgbaKey(snapshot.colors.surface),
        surfaceRaised: rgbaKey(snapshot.colors.surfaceRaised),
        foreground: rgbaKey(snapshot.colors.foreground),
        mutedForeground: rgbaKey(snapshot.colors.mutedForeground),
        border: rgbaKey(snapshot.colors.border),
        accent: rgbaKey(snapshot.colors.accent),
        accentMuted: rgbaKey(snapshot.colors.accentMuted),
        focus: rgbaKey(snapshot.colors.focus),
        focusBorder: rgbaKey(snapshot.colors.focusBorder),
        selection: rgbaKey(snapshot.colors.selection),
        selectionForeground: rgbaKey(snapshot.colors.selectionForeground),
        hover: rgbaKey(snapshot.colors.hover),
        buttonHover: rgbaKey(snapshot.colors.buttonHover),
        attention: rgbaKey(snapshot.colors.attention),
        status: colorGroup(snapshot.colors.status),
      },
      roles: {
        surfaces: colorGroup(snapshot.roles.surfaces),
        text: colorGroup(snapshot.roles.text),
        borders: colorGroup(snapshot.roles.borders),
        statusTone: colorGroup(snapshot.roles.statusTone),
        selection: colorGroup(snapshot.roles.selection),
      },
      derived: { attentionSurface: rgbaKey(snapshot.derived.attentionSurface) },
      accessibility: snapshot.accessibility,
      diagnostics: snapshot.diagnostics,
      futureSources: snapshot.futureSources,
      density: snapshot.density,
      borders: snapshot.borders,
      glyphs: snapshot.glyphs,
    });
  return key(a) === key(b);
}

const compatibilityTheme = DARK_THEME;

/**
 * Temporary names retained for app.tsx and pre-Card-22 leaves. Card 22.3 owns
 * their removal after every consumer receives a live SemanticThemeSnapshot.
 */
export const LEGACY_THEME_ALIAS_IDS = [
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
] as const;

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
