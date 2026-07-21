import {
  BORDER_TOKEN_ROLES,
  DENSITY_TOKEN_ROLES,
  ELEVATION_TOKEN_ROLES,
  FOCUS_TOKEN_ROLES,
  MOTION_DURATION_ROLES,
  SELECTION_TOKEN_ROLES,
  SHAPE_TOKEN_ROLES,
  STATUS_TONE_ROLES,
  SURFACE_TOKEN_ROLES,
  TEXT_TOKEN_ROLES,
  TYPOGRAPHY_TOKEN_ROLES,
  WINDOW_ACTIVITY_TOKEN_ROLES,
  resolveVisualTheme,
  type DesktopThemeState,
  type ElevationValue,
  type RendererNeutralColor,
  type SemanticIconId,
  type ThemeAccessibilityPreferences,
  type ThemeAppearance,
  type ThemeDiagnostic,
  type TypographyValue,
} from "@tmux-ide/contracts";

import { DOM_ICON_METADATA, type DomIconMetadata } from "./dom-icons.ts";

const DOM_RHYTHM_PX = 18;

export const DOM_EXPERIENCE_VARIABLE = Object.freeze({
  surface: {
    canvas: "--tmux-ide-surface-canvas",
    panel: "--tmux-ide-surface-panel",
    panelRaised: "--tmux-ide-surface-panel-raised",
    terminal: "--tmux-ide-surface-terminal",
    header: "--tmux-ide-surface-header",
    headerActive: "--tmux-ide-surface-header-active",
    command: "--tmux-ide-surface-command",
  } as const,
  text: Object.fromEntries(
    TEXT_TOKEN_ROLES.map((role) => [role, `--tmux-ide-text-${toKebabCase(role)}`]),
  ) as Record<(typeof TEXT_TOKEN_ROLES)[number], `--tmux-ide-text-${string}`>,
  border: Object.fromEntries(
    BORDER_TOKEN_ROLES.map((role) => [role, `--tmux-ide-border-${toKebabCase(role)}`]),
  ) as Record<(typeof BORDER_TOKEN_ROLES)[number], `--tmux-ide-border-${string}`>,
  status: Object.fromEntries(
    STATUS_TONE_ROLES.map((role) => [role, `--tmux-ide-status-${toKebabCase(role)}`]),
  ) as Record<(typeof STATUS_TONE_ROLES)[number], `--tmux-ide-status-${string}`>,
  selection: Object.fromEntries(
    SELECTION_TOKEN_ROLES.map((role) => [role, `--tmux-ide-selection-${toKebabCase(role)}`]),
  ) as Record<(typeof SELECTION_TOKEN_ROLES)[number], `--tmux-ide-selection-${string}`>,
  control: {
    disabledBackground: "--tmux-ide-control-disabled-background",
    disabledForeground: "--tmux-ide-control-disabled-foreground",
    disabledForegroundHighContrast: "--tmux-ide-control-disabled-foreground-high-contrast",
  } as const,
  density: Object.fromEntries(
    DENSITY_TOKEN_ROLES.map((role) => [role, `--tmux-ide-density-${toKebabCase(role)}`]),
  ) as Record<(typeof DENSITY_TOKEN_ROLES)[number], `--tmux-ide-density-${string}`>,
  shape: Object.fromEntries(
    SHAPE_TOKEN_ROLES.map((role) => [role, `--tmux-ide-shape-${toKebabCase(role)}`]),
  ) as Record<(typeof SHAPE_TOKEN_ROLES)[number], `--tmux-ide-shape-${string}`>,
  elevation: Object.fromEntries(
    ELEVATION_TOKEN_ROLES.map((role) => [role, `--tmux-ide-elevation-${toKebabCase(role)}`]),
  ) as Record<(typeof ELEVATION_TOKEN_ROLES)[number], `--tmux-ide-elevation-${string}`>,
  motion: {
    instant: "--tmux-ide-motion-instant",
    fast: "--tmux-ide-motion-fast",
    standard: "--tmux-ide-motion-standard",
    emphasized: "--tmux-ide-motion-emphasized",
    easingStandard: "--tmux-ide-motion-easing-standard",
    easingEmphasized: "--tmux-ide-motion-easing-emphasized",
  } as const,
  typography: Object.fromEntries(
    TYPOGRAPHY_TOKEN_ROLES.map((role) => [role, `--tmux-ide-typography-${toKebabCase(role)}`]),
  ) as Record<(typeof TYPOGRAPHY_TOKEN_ROLES)[number], `--tmux-ide-typography-${string}`>,
  focus: Object.fromEntries(
    FOCUS_TOKEN_ROLES.map((role) => [role, `--tmux-ide-focus-${toKebabCase(role)}`]),
  ) as Record<(typeof FOCUS_TOKEN_ROLES)[number], `--tmux-ide-focus-${string}`>,
  windowActivity: Object.fromEntries(
    WINDOW_ACTIVITY_TOKEN_ROLES.map((role) => [
      role,
      `--tmux-ide-window-activity-${toKebabCase(role)}`,
    ]),
  ) as Record<(typeof WINDOW_ACTIVITY_TOKEN_ROLES)[number], `--tmux-ide-window-activity-${string}`>,
});

export type DomExperienceVariableName = `--tmux-ide-${string}`;
export type DomExperienceVariables = Record<DomExperienceVariableName, string>;
export type AccessibilityPreferenceConflict = "reduced-motion" | "increased-contrast";

export interface DomExperienceAccessibility {
  readonly reducedMotion: boolean;
  readonly increasedContrast: boolean;
  readonly conflicts: readonly AccessibilityPreferenceConflict[];
}

export interface DomExperienceInput {
  readonly hostTheme?: Partial<DesktopThemeState> | null;
  readonly productAccessibility?: Partial<ThemeAccessibilityPreferences> | null;
  readonly userTheme?: unknown;
  readonly projectTheme?: unknown;
}

export interface DomExperience {
  readonly appearance: ThemeAppearance;
  readonly accessibility: DomExperienceAccessibility;
  readonly variables: DomExperienceVariables;
  readonly icons: Readonly<Record<SemanticIconId, DomIconMetadata>>;
  readonly diagnostics: readonly ThemeDiagnostic[];
}

function toKebabCase(value: string): string {
  return value.replace(/[A-Z]/gu, (character) => `-${character.toLowerCase()}`);
}

function colorToCss(value: RendererNeutralColor): string {
  if (value.alpha === 255) return `rgb(${value.red} ${value.green} ${value.blue})`;
  return `rgb(${value.red} ${value.green} ${value.blue} / ${formatNumber(value.alpha / 255)})`;
}

function colorToCssWithAlpha(value: RendererNeutralColor, alpha: number): string {
  return `rgb(${value.red} ${value.green} ${value.blue} / ${formatNumber(alpha)})`;
}

function formatNumber(value: number): string {
  return String(Math.round(value * 1_000) / 1_000);
}

function rhythmToCss(value: number): string {
  return `${formatNumber(value * DOM_RHYTHM_PX)}px`;
}

function easingToCss(value: "linear" | "standard" | "decelerate"): string {
  if (value === "linear") return "linear";
  if (value === "decelerate") return "cubic-bezier(0, 0, 0.2, 1)";
  return "cubic-bezier(0.2, 0, 0, 1)";
}

const BENCHMARK_ELEVATION = Object.freeze({
  floating: { y: 18, blur: 38, alpha: 0.46 },
  palette: { y: 10, blur: 18, alpha: 0.34 },
  windowMode: { y: 18, blur: 40, alpha: 0.5 },
} satisfies Record<
  (typeof ELEVATION_TOKEN_ROLES)[number],
  { readonly y: number; readonly blur: number; readonly alpha: number }
>);

function elevationToCss(
  role: (typeof ELEVATION_TOKEN_ROLES)[number],
  value: ElevationValue,
  canvas: RendererNeutralColor,
): string {
  if (value.level === 0 || value.intent === "flat") return "none";
  const benchmark = BENCHMARK_ELEVATION[role];
  return `0 ${benchmark.y}px ${benchmark.blur}px ${colorToCssWithAlpha(canvas, benchmark.alpha)}`;
}

function typographyFamily(value: TypographyValue["family"]): string {
  return value === "monospace"
    ? 'ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, monospace'
    : 'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
}

function typographyWeight(value: TypographyValue["weight"]): string {
  return String({ regular: 400, medium: 500, semibold: 600, bold: 700 }[value]);
}

function reconcileAccessibility(
  host: Partial<DesktopThemeState> | null | undefined,
  product: Partial<ThemeAccessibilityPreferences> | null | undefined,
): DomExperienceAccessibility {
  const conflicts: AccessibilityPreferenceConflict[] = [];
  if (
    host?.reducedMotion !== undefined &&
    product?.reducedMotion !== undefined &&
    host.reducedMotion !== product.reducedMotion
  ) {
    conflicts.push("reduced-motion");
  }
  if (
    host?.highContrast !== undefined &&
    product?.increasedContrast !== undefined &&
    host.highContrast !== product.increasedContrast
  ) {
    conflicts.push("increased-contrast");
  }
  return Object.freeze({
    reducedMotion: Boolean(host?.reducedMotion || product?.reducedMotion),
    increasedContrast: Boolean(host?.highContrast || product?.increasedContrast),
    conflicts: Object.freeze(conflicts),
  });
}

function createVariables(input: ReturnType<typeof resolveVisualTheme>): DomExperienceVariables {
  const variables = {} as DomExperienceVariables;
  const { tokens } = input;
  for (const role of SURFACE_TOKEN_ROLES) {
    variables[DOM_EXPERIENCE_VARIABLE.surface[role]] = colorToCss(tokens.surfaces[role]);
  }
  for (const role of TEXT_TOKEN_ROLES) {
    variables[DOM_EXPERIENCE_VARIABLE.text[role]] = colorToCss(tokens.text[role]);
  }
  for (const role of BORDER_TOKEN_ROLES) {
    variables[DOM_EXPERIENCE_VARIABLE.border[role]] = colorToCss(tokens.borders[role]);
  }
  for (const role of STATUS_TONE_ROLES) {
    variables[DOM_EXPERIENCE_VARIABLE.status[role]] = colorToCss(tokens.statusTone[role]);
  }
  for (const role of SELECTION_TOKEN_ROLES) {
    variables[DOM_EXPERIENCE_VARIABLE.selection[role]] = colorToCss(tokens.selection[role]);
  }
  variables[DOM_EXPERIENCE_VARIABLE.control.disabledBackground] = colorToCss(tokens.surfaces.panel);
  variables[DOM_EXPERIENCE_VARIABLE.control.disabledForeground] = colorToCssWithAlpha(
    tokens.text.muted,
    0.55,
  );
  variables[DOM_EXPERIENCE_VARIABLE.control.disabledForegroundHighContrast] = colorToCss(
    tokens.text.muted,
  );
  for (const role of DENSITY_TOKEN_ROLES) {
    variables[DOM_EXPERIENCE_VARIABLE.density[role]] = rhythmToCss(tokens.density[role].value);
  }
  for (const role of SHAPE_TOKEN_ROLES) {
    variables[DOM_EXPERIENCE_VARIABLE.shape[role]] = rhythmToCss(tokens.shape[role].value);
  }
  for (const role of ELEVATION_TOKEN_ROLES) {
    const name = DOM_EXPERIENCE_VARIABLE.elevation[role];
    variables[`${name}-shadow`] = elevationToCss(
      role,
      tokens.elevation[role],
      tokens.surfaces.canvas,
    );
    variables[`${name}-level`] = String(tokens.elevation[role].level);
    variables[`${name}-intent`] = tokens.elevation[role].intent;
  }
  for (const role of MOTION_DURATION_ROLES) {
    variables[DOM_EXPERIENCE_VARIABLE.motion[role]] = `${tokens.motion[role].value}ms`;
  }
  variables[DOM_EXPERIENCE_VARIABLE.motion.easingStandard] = easingToCss(
    tokens.motion.easing.standard,
  );
  variables[DOM_EXPERIENCE_VARIABLE.motion.easingEmphasized] = easingToCss(
    tokens.motion.easing.emphasized,
  );
  for (const role of TYPOGRAPHY_TOKEN_ROLES) {
    const name = DOM_EXPERIENCE_VARIABLE.typography[role];
    const typography = tokens.typography[role];
    variables[`${name}-family`] = typographyFamily(typography.family);
    variables[`${name}-weight`] = typographyWeight(typography.weight);
    variables[`${name}-line-height`] = formatNumber(typography.lineHeight.value);
    variables[`${name}-truncation`] = typography.truncation;
  }
  variables[DOM_EXPERIENCE_VARIABLE.focus.outline] = rhythmToCss(tokens.focus.outline.value);
  variables[DOM_EXPERIENCE_VARIABLE.focus.outlineOffset] = rhythmToCss(
    tokens.focus.outlineOffset.value,
  );
  variables[DOM_EXPERIENCE_VARIABLE.focus.focusContrast] = formatNumber(
    tokens.focus.focusContrast.value,
  );
  variables[DOM_EXPERIENCE_VARIABLE.focus.highContrastOutline] = colorToCss(
    tokens.focus.highContrastOutline,
  );
  for (const role of WINDOW_ACTIVITY_TOKEN_ROLES) {
    const name = DOM_EXPERIENCE_VARIABLE.windowActivity[role];
    variables[`${name}-opacity`] = formatNumber(tokens.windowActivity[role].opacity.value);
    variables[`${name}-contrast`] = formatNumber(tokens.windowActivity[role].contrast.value);
  }
  return Object.freeze(variables);
}

/** Browser-safe projection of canonical experience contracts into DOM host primitives. */
export function createDomExperience(input: DomExperienceInput = {}): DomExperience {
  const accessibility = reconcileAccessibility(input.hostTheme, input.productAccessibility);
  const resolved = resolveVisualTheme({
    appearance: input.hostTheme?.mode,
    userTheme: input.userTheme,
    projectTheme: input.projectTheme,
    accessibility,
  });
  return Object.freeze({
    appearance: resolved.appearance,
    accessibility,
    variables: createVariables(resolved),
    icons: DOM_ICON_METADATA,
    diagnostics: resolved.diagnostics,
  });
}
