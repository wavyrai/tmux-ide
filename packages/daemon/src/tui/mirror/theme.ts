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
  BUILTIN_VISUAL_THEMES,
  contrastRatio,
  deriveAttentionBlend,
  deriveFocusedHeader,
  mixSrgbColors,
  readableForeground,
  resolveVisualTheme,
  type BorderTokenRole,
  type RendererNeutralColor,
  type SelectionTokenRole,
  type StatusToneRole,
  type SurfaceTokenRole,
  type TextTokenRole,
  type ThemeAccessibilityPreferences,
  type ThemeDiagnostic,
  type VisualHostDefaultsV1,
  type VisualTokenOverridesV1,
  type VisualTokensV1,
} from "@tmux-ide/contracts";
import {
  LEGACY_THEME_OVERRIDE_PROVENANCE,
  type LegacyThemeOverrideId,
  type LegacyThemeOverrideProvenance,
} from "../../lib/legacy-theme-compat.ts";
import type { ResolvedThemeMode, ThemeModeSetting } from "../../lib/theme-mode.ts";
import { XTERM_PALETTE } from "./ansi-palette.ts";

export type { ResolvedThemeMode, ThemeModeSetting };

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
  /** Full renderer-neutral source tokens. Host projections may consume additional groups later. */
  readonly canonical: VisualTokensV1;
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
  /** Present on resolved app config; absent means direct callers supplied explicit legacy values. */
  [LEGACY_THEME_OVERRIDE_PROVENANCE]?: LegacyThemeOverrideProvenance;
}

export interface ThemeStoreOptions {
  mode?: ThemeModeSetting;
  accent?: string;
  rendererMode?: ResolvedThemeMode | null;
  hostDefaults?: VisualHostDefaultsV1 | null;
}

export interface ThemeStore {
  getSnapshot(): SemanticThemeSnapshot;
  subscribe(listener: () => void): () => void;
  setMode(mode: ThemeModeSetting): void;
  setAccent(accent: string | undefined): void;
  setHostDefaults(defaults: VisualHostDefaultsV1 | null): void;
  configure(config: ThemeConfigInput | undefined): void;
  followRendererThemeMode(source: ThemeModeSource): () => void;
}

/** The renderer-neutral subset of a terminal palette needed for system theme
 * derivation. Runtime owners and browser fixtures can both satisfy this
 * structurally; no OpenTUI runtime type crosses this boundary. */
export interface SystemTerminalPaletteInput {
  readonly palette: readonly (string | null)[];
  readonly defaultForeground: string | null;
  readonly defaultBackground: string | null;
  readonly detectedMode?: ResolvedThemeMode;
}

/** Renderer projection for terminal cells. xterm-headless keeps the original
 * ANSI/truecolor values; the OpenTUI surface resolves them through this object
 * at paint time. That separation lets a live theme change recolor existing
 * scrollback without touching tmux, the PTY, or the terminal parser. */
export interface TerminalPaletteProjection {
  /** Packed `0xRRGGBB` defaults used by cells with no explicit SGR color. */
  readonly foreground: number;
  readonly background: number;
  /** Complete, protocol-faithful indexed ANSI colors. */
  readonly ansiForeground: readonly number[];
  readonly ansiBackground: readonly number[];
  /** Identity-preserving SGR 38;2 / 48;2 truecolor resolution. */
  resolveForeground(color: number): number;
  resolveBackground(color: number): number;
  readonly cursorMarker: number;
  readonly searchHighlight: number;
  readonly searchCurrent: number;
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

/** Convert an OpenTUI semantic color into the framebuffer's packed RGB form. */
export function colorToPackedRgb(color: RGBA): number {
  const [r, g, b] = colorToThemeBytes(color);
  return (r << 16) | (g << 8) | b;
}

function rendererNeutralFromRgba(color: RGBA): RendererNeutralColor {
  const [red, green, blue, alpha] = colorToThemeBytes(color);
  return { space: "srgb", red, green, blue, alpha };
}

/** WCAG contrast for an OpenTUI foreground/background pair. Keeping this at
 * the host projection boundary lets every owned surface test the exact colours
 * it will hand to the renderer instead of duplicating colour math. */
export function themeContrastRatio(foreground: RGBA, background: RGBA): number {
  return contrastRatio(rendererNeutralFromRgba(foreground), rendererNeutralFromRgba(background));
}

/** Prefer the requested semantic colour, but never let critical app chrome
 * disappear when a terminal palette or user override creates a low-contrast
 * pair. The candidate order remains meaningful; the most readable candidate
 * is only used when none reaches the requested threshold. */
export function readableThemeForeground(
  background: RGBA,
  candidates: readonly RGBA[],
  minimumContrast = 4.5,
): RGBA {
  const unique = candidates.filter(
    (candidate, index) =>
      candidates.findIndex((other) => rgbaKey(other) === rgbaKey(candidate)) === index,
  );
  for (const candidate of unique) {
    if (themeContrastRatio(candidate, background) >= minimumContrast) return candidate;
  }
  return unique.reduce((best, candidate) =>
    themeContrastRatio(candidate, background) > themeContrastRatio(best, background)
      ? candidate
      : best,
  );
}

export interface SemanticThemeContrastCheck {
  readonly id:
    | "primary-on-canvas"
    | "secondary-on-panel"
    | "muted-on-panel"
    | "link-on-panel"
    | "selection-text-on-selection";
  readonly ratio: number;
  readonly minimum: number;
  readonly passes: boolean;
}

/** The legibility contract for app-owned chrome. Terminal cells have their own
 * semantic projection contract in {@link createTerminalPaletteProjection};
 * these checks cover the remaining owned surfaces. */
export function semanticThemeContrastChecks(
  snapshot: SemanticThemeSnapshot,
): readonly SemanticThemeContrastCheck[] {
  const pairs = [
    ["primary-on-canvas", snapshot.roles.text.primary, snapshot.roles.surfaces.canvas],
    ["secondary-on-panel", snapshot.roles.text.secondary, snapshot.roles.surfaces.panel],
    ["muted-on-panel", snapshot.roles.text.muted, snapshot.roles.surfaces.panel],
    ["link-on-panel", snapshot.roles.text.link, snapshot.roles.surfaces.panel],
    [
      "selection-text-on-selection",
      snapshot.roles.selection.selectionText,
      snapshot.roles.selection.selection,
    ],
  ] as const;
  return pairs.map(([id, foreground, background]) => {
    const minimum = 4.5;
    const ratio = themeContrastRatio(foreground, background);
    return { id, ratio, minimum, passes: ratio >= minimum };
  });
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

function rendererNeutral(red: number, green: number, blue: number): RendererNeutralColor {
  return {
    space: "srgb",
    red: byteChannel(red),
    green: byteChannel(green),
    blue: byteChannel(blue),
    alpha: 255,
  };
}

function rendererNeutralFromPacked(color: number): RendererNeutralColor {
  return rendererNeutral((color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff);
}

function perceivedLuminance(color: RendererNeutralColor): number {
  return 0.299 * color.red + 0.587 * color.green + 0.114 * color.blue;
}

function parseTerminalHostColor(value: string | null | undefined): RendererNeutralColor | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  const hex = /^#([\da-f]{3}|[\da-f]{6})$/u.exec(normalized)?.[1];
  if (hex) {
    const expanded =
      hex.length === 3 ? `${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}` : hex;
    return rendererNeutral(
      Number.parseInt(expanded.slice(0, 2), 16),
      Number.parseInt(expanded.slice(2, 4), 16),
      Number.parseInt(expanded.slice(4, 6), 16),
    );
  }
  // OSC palette replies may use X11's rgb:RR/GG/BB form with one to four
  // hexadecimal digits per channel. Scale each channel to a byte rather than
  // truncating high-fidelity replies.
  const x11 = /^rgb:([\da-f]{1,4})\/([\da-f]{1,4})\/([\da-f]{1,4})$/u.exec(normalized);
  if (!x11) return null;
  const channel = (part: string): number => {
    const maximum = 16 ** part.length - 1;
    return Math.round((Number.parseInt(part, 16) / maximum) * 255);
  };
  return rendererNeutral(channel(x11[1]!), channel(x11[2]!), channel(x11[3]!));
}

function mostReadable(
  background: RendererNeutralColor,
  candidates: readonly RendererNeutralColor[],
  minimum = 4.5,
): RendererNeutralColor {
  const unique = candidates.filter(
    (candidate, index) =>
      candidates.findIndex(
        (other) =>
          other.red === candidate.red &&
          other.green === candidate.green &&
          other.blue === candidate.blue,
      ) === index,
  );
  const passing = unique.find((candidate) => contrastRatio(candidate, background) >= minimum);
  return (
    passing ??
    unique.reduce((best, candidate) =>
      contrastRatio(candidate, background) > contrastRatio(best, background) ? candidate : best,
    )
  );
}

function mutedHostText(
  panel: RendererNeutralColor,
  foreground: RendererNeutralColor,
): RendererNeutralColor {
  for (const weight of [0.58, 0.64, 0.7, 0.76, 0.82, 0.9, 1] as const) {
    const candidate = mixSrgbColors(panel, foreground, weight);
    if (contrastRatio(candidate, panel) >= 4.5) return candidate;
  }
  return foreground;
}

/**
 * Derive opaque, semantic app defaults from a real terminal palette.
 *
 * Only the 16 host ANSI slots inform semantic accents. Structural surfaces,
 * borders and neutral text are generated from the measured default background
 * and foreground, so mutable ANSI slots 8 and 15 can never become chrome.
 * Missing accent slots fall back to the canonical xterm entries. The returned
 * value is renderer-neutral and can therefore be shared by the native TUI and
 * browser fixtures.
 */
export function deriveSystemVisualHostDefaults(
  input: SystemTerminalPaletteInput,
): VisualHostDefaultsV1 | null {
  const reportedPalette = Array.from({ length: 16 }, (_, index) =>
    parseTerminalHostColor(input.palette[index]),
  );
  const measuredBackground =
    parseTerminalHostColor(input.defaultBackground) ?? reportedPalette[0] ?? null;
  const measuredForeground =
    parseTerminalHostColor(input.defaultForeground) ?? reportedPalette[7] ?? null;
  if (!measuredBackground && !measuredForeground && reportedPalette.every((value) => !value))
    return null;

  const fallbackMode = input.detectedMode ?? "dark";
  const background = measuredBackground ?? BUILTIN_VISUAL_THEMES[fallbackMode].surfaces.canvas;
  const black = rendererNeutral(0, 0, 0);
  const white = rendererNeutral(255, 255, 255);
  const appearance =
    measuredBackground === null
      ? fallbackMode
      : perceivedLuminance(background) > 127.5
        ? "light"
        : "dark";
  const builtIn = BUILTIN_VISUAL_THEMES[appearance];
  const structuralTarget = appearance === "dark" ? white : black;
  const panel = mixSrgbColors(background, structuralTarget, appearance === "dark" ? 0.055 : 0.04);
  const panelRaised = mixSrgbColors(
    background,
    structuralTarget,
    appearance === "dark" ? 0.1 : 0.075,
  );
  const header = mixSrgbColors(background, structuralTarget, appearance === "dark" ? 0.035 : 0.025);
  const command = mixSrgbColors(
    background,
    structuralTarget,
    appearance === "dark" ? 0.085 : 0.065,
  );
  const primary = mostReadable(background, [
    measuredForeground ?? builtIn.text.primary,
    builtIn.text.primary,
    readableForeground(background, black, white),
  ]);
  const secondary = mutedHostText(panel, primary);
  const muted = mutedHostText(panel, mixSrgbColors(panel, primary, 0.9));
  const ansi = (index: number): RendererNeutralColor =>
    reportedPalette[index] ?? rendererNeutralFromPacked(XTERM_PALETTE[index]!);
  const readableAccent = (...candidates: readonly RendererNeutralColor[]) =>
    mostReadable(panel, [...candidates, builtIn.borders.focused, primary]);
  const focus = readableAccent(ansi(6), ansi(4));
  const info = readableAccent(ansi(6), ansi(4));
  const warning = readableAccent(ansi(3));
  const danger = readableAccent(ansi(1));
  const success = readableAccent(ansi(2));
  const selection = mixSrgbColors(background, focus, appearance === "dark" ? 0.3 : 0.2);
  const selectionText = mostReadable(selection, [primary, black, white]);
  const overrides: VisualTokenOverridesV1 = {
    surfaces: {
      canvas: background,
      panel,
      panelRaised,
      terminal: background,
      header,
      headerActive: deriveFocusedHeader(header, focus),
      command,
    },
    text: {
      primary,
      secondary,
      muted,
      bright: readableForeground(background, black, white),
      inverse: mostReadable(primary, [background, black, white]),
      link: focus,
    },
    borders: {
      subtle: mixSrgbColors(background, structuralTarget, appearance === "dark" ? 0.14 : 0.12),
      default: mixSrgbColors(background, structuralTarget, appearance === "dark" ? 0.23 : 0.2),
      focused: focus,
      selected: readableAccent(ansi(5), focus),
      attention: warning,
      danger,
    },
    statusTone: { neutral: muted, info, warning, danger, success },
    selection: {
      selection,
      selectionText,
      hover: mixSrgbColors(background, focus, appearance === "dark" ? 0.12 : 0.08),
      pressed: mixSrgbColors(background, focus, appearance === "dark" ? 0.22 : 0.14),
      disabled: mixSrgbColors(background, structuralTarget, appearance === "dark" ? 0.07 : 0.05),
    },
  };
  return Object.freeze({ appearance, overrides });
}

/** Build the terminal-cell view of a semantic OpenTUI theme. Explicit terminal
 * colors remain protocol-faithful: all 256 xterm slots and 24-bit truecolor pass
 * through unchanged. `cellDefaults` owns cells that use SGR 39/49 while
 * `snapshot` owns tmux-ide overlays such as selection and search.
 *
 * Keeping those inputs separate is important for mirrored applications. A
 * running TUI chose its colours against the terminal defaults it started with;
 * changing those defaults underneath its retained framebuffer can collapse
 * contrast even though every source cell is still present. */
export function createTerminalPaletteProjection(
  snapshot: SemanticThemeSnapshot,
  cellDefaults: SemanticThemeSnapshot = snapshot,
): TerminalPaletteProjection {
  const p = colorToPackedRgb;
  const foreground = p(cellDefaults.roles.text.primary);
  const background = p(cellDefaults.roles.surfaces.terminal);

  return Object.freeze({
    foreground,
    background,
    ansiForeground: XTERM_PALETTE,
    ansiBackground: XTERM_PALETTE,
    resolveForeground: (color: number) => color & 0xffffff,
    resolveBackground: (color: number) => color & 0xffffff,
    cursorMarker: p(snapshot.roles.selection.hover),
    searchHighlight: p(snapshot.roles.selection.hover),
    searchCurrent: p(snapshot.roles.selection.selection),
  });
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
  deepFreeze(snapshot.canonical);
  return Object.freeze(snapshot);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function cloneCanonicalTokens(tokens: VisualTokensV1): VisualTokensV1 {
  // The contract is JSON data by design. Clone before freezing so the facade
  // never freezes the shared built-in token registry owned by contracts.
  return JSON.parse(JSON.stringify(tokens)) as VisualTokensV1;
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
    canonical: cloneCanonicalTokens(resolved.tokens),
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
  hostDefaults: VisualHostDefaultsV1 | null,
): ResolvedThemeMode {
  return setting === "system" ? (hostDefaults?.appearance ?? rendererMode ?? "dark") : setting;
}

function withAppThemeConfig(
  base: SemanticThemeSnapshot,
  setting: ThemeModeSetting,
  config: ThemeConfigInput | undefined,
): SemanticThemeSnapshot {
  const legacyValue = (id: LegacyThemeOverrideId, value: string | undefined) => {
    const provenance = config?.[LEGACY_THEME_OVERRIDE_PROVENANCE];
    return provenance === undefined || provenance[id] ? value : undefined;
  };
  const accentInput = legacyValue("accent", config?.accent);
  const foregroundInput = legacyValue("fg", config?.fg);
  const mutedInput = legacyValue("muted", config?.muted);
  const statusInput = {
    blocked: legacyValue("status.blocked", config?.status?.blocked),
    working: legacyValue("status.working", config?.status?.working),
    done: legacyValue("status.done", config?.status?.done),
    idle: legacyValue("status.idle", config?.status?.idle),
    unknown: legacyValue("status.unknown", config?.status?.unknown),
  };
  const activeGlyph = legacyValue("glyphs.active", config?.glyphs?.active);
  const inactiveGlyph = legacyValue("glyphs.inactive", config?.glyphs?.inactive);
  const accent = parseThemeColor(accentInput, base.colors.accent);
  const foreground = parseThemeColor(foregroundInput, base.colors.foreground);
  const muted = parseThemeColor(mutedInput, base.colors.mutedForeground);
  const white = rgba(255, 255, 255);
  const black = rgba(0, 0, 0);
  const contrast = base.mode === "dark" ? white : black;
  const status = {
    blocked: parseThemeColor(statusInput.blocked, base.colors.status.blocked),
    working: parseThemeColor(statusInput.working, base.colors.status.working),
    done: parseThemeColor(statusInput.done, base.colors.status.done),
    idle: parseThemeColor(statusInput.idle, base.colors.status.idle),
    unknown: parseThemeColor(statusInput.unknown, base.colors.status.unknown),
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
      ...(accentInput ? { headerActive: accentMuted } : {}),
    },
    text: {
      ...base.roles.text,
      ...(foregroundInput ? { primary: foreground } : {}),
      ...(mutedInput ? { secondary: muted, muted } : {}),
      ...(accentInput ? { link: accent } : {}),
    },
    borders: {
      ...base.roles.borders,
      ...(accentInput && !base.accessibility.increasedContrast ? { focused: focus } : {}),
    },
    statusTone: {
      ...base.roles.statusTone,
      ...(statusInput.blocked ? { warning: status.blocked } : {}),
      ...(statusInput.working ? { info: status.working } : {}),
      ...(statusInput.done ? { success: status.done } : {}),
      ...(statusInput.idle ? { neutral: status.idle } : {}),
    },
    selection: {
      ...base.roles.selection,
      ...(accentInput ? { selection, hover, pressed } : {}),
    },
  };
  return freezeSnapshot({
    mode: base.mode,
    setting,
    canonical: base.canonical,
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
      active: activeGlyph ?? base.glyphs.active,
      inactive: inactiveGlyph ?? base.glyphs.inactive,
    },
  });
}

export function createSemanticThemeSnapshot(
  config: ThemeConfigInput | undefined = undefined,
  rendererMode: ResolvedThemeMode | null = null,
  hostDefaults: VisualHostDefaultsV1 | null = null,
): SemanticThemeSnapshot {
  const setting = config?.mode ?? "dark";
  const accessibility = {
    reducedMotion: config?.accessibility?.reducedMotion ?? DEFAULT_ACCESSIBILITY.reducedMotion,
    increasedContrast:
      config?.accessibility?.increasedContrast ?? DEFAULT_ACCESSIBILITY.increasedContrast,
  };
  const mode = resolvedMode(setting, rendererMode, hostDefaults);
  const resolved = resolveVisualTheme({
    appearance: mode,
    hostDefaults: setting === "system" ? (hostDefaults ?? undefined) : undefined,
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
  let hostDefaults = options.hostDefaults ?? null;
  let snapshot = createSemanticThemeSnapshot(currentConfig, rendererMode, hostDefaults);
  const listeners = new Set<() => void>();

  const refresh = () => {
    const next = createSemanticThemeSnapshot(currentConfig, rendererMode, hostDefaults);
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
    setHostDefaults(defaults) {
      if (JSON.stringify(hostDefaults) === JSON.stringify(defaults)) return;
      hostDefaults = defaults;
      if (currentConfig.mode === "system") refresh();
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
      canonical: snapshot.canonical,
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
  "ACCENT",
  "MUTED",
  "BADGE_BG",
  "TAB_ACTIVE_BG",
  "HOVER_BG",
] as const;

export const DEFAULT_FG = compatibilityTheme.colors.foreground;
export const DEFAULT_BG = compatibilityTheme.colors.background;

export const ACCENT = compatibilityTheme.colors.accent;
export const MUTED = compatibilityTheme.colors.mutedForeground;
export const BADGE_BG = compatibilityTheme.colors.accentMuted;

/** The selected row/tab. Always wins over HOVER_BG. */
export const TAB_ACTIVE_BG = compatibilityTheme.colors.selection;

/** A single subtle pointer-hover tint. */
export const HOVER_BG = compatibilityTheme.colors.hover;
