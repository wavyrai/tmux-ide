import { z } from "zod";

export const VISUAL_THEME_VERSION = 1 as const;

export const SURFACE_TOKEN_ROLES = [
  "canvas",
  "panel",
  "panelRaised",
  "terminal",
  "header",
  "headerActive",
  "command",
] as const;
export const TEXT_TOKEN_ROLES = [
  "primary",
  "secondary",
  "muted",
  "bright",
  "inverse",
  "link",
] as const;
export const BORDER_TOKEN_ROLES = [
  "subtle",
  "default",
  "focused",
  "selected",
  "attention",
  "danger",
] as const;
export const STATUS_TONE_ROLES = ["neutral", "info", "warning", "danger", "success"] as const;
export const SELECTION_TOKEN_ROLES = [
  "selection",
  "selectionText",
  "hover",
  "pressed",
  "disabled",
] as const;
export const DENSITY_TOKEN_ROLES = [
  "cellHeight",
  "headerHeight",
  "statusHeight",
  "inlineGap",
  "sectionGap",
  "controlPadding",
] as const;
export const SHAPE_TOKEN_ROLES = [
  "dockedRadius",
  "floatingRadius",
  "controlRadius",
  "statusRadius",
] as const;
export const ELEVATION_TOKEN_ROLES = ["floating", "palette", "windowMode"] as const;
export const MOTION_DURATION_ROLES = ["instant", "fast", "standard", "emphasized"] as const;
export const TYPOGRAPHY_TOKEN_ROLES = ["workspace", "label", "title", "metadata", "code"] as const;
export const FOCUS_TOKEN_ROLES = [
  "outline",
  "outlineOffset",
  "focusContrast",
  "highContrastOutline",
] as const;
export const WINDOW_ACTIVITY_TOKEN_ROLES = ["active", "inactive"] as const;

export type SurfaceTokenRole = (typeof SURFACE_TOKEN_ROLES)[number];
export type TextTokenRole = (typeof TEXT_TOKEN_ROLES)[number];
export type BorderTokenRole = (typeof BORDER_TOKEN_ROLES)[number];
export type StatusToneRole = (typeof STATUS_TONE_ROLES)[number];
export type SelectionTokenRole = (typeof SELECTION_TOKEN_ROLES)[number];
export type DensityTokenRole = (typeof DENSITY_TOKEN_ROLES)[number];
export type ShapeTokenRole = (typeof SHAPE_TOKEN_ROLES)[number];
export type ElevationTokenRole = (typeof ELEVATION_TOKEN_ROLES)[number];
export type MotionDurationRole = (typeof MOTION_DURATION_ROLES)[number];
export type TypographyTokenRole = (typeof TYPOGRAPHY_TOKEN_ROLES)[number];
export type FocusTokenRole = (typeof FOCUS_TOKEN_ROLES)[number];
export type WindowActivityTokenRole = (typeof WINDOW_ACTIVITY_TOKEN_ROLES)[number];

export const RendererNeutralColorSchemaZ = z
  .object({
    space: z.literal("srgb"),
    red: z.number().int().min(0).max(255),
    green: z.number().int().min(0).max(255),
    blue: z.number().int().min(0).max(255),
    alpha: z.number().int().min(0).max(255),
  })
  .strict();
export type RendererNeutralColor = z.infer<typeof RendererNeutralColorSchemaZ>;

/** One product rhythm is translated by each host; it is neither a pixel nor a terminal cell. */
export const RhythmValueSchemaZ = z
  .object({ unit: z.literal("rhythm"), value: z.number().finite().min(0).max(16) })
  .strict();
export const RatioValueSchemaZ = z
  .object({ unit: z.literal("ratio"), value: z.number().finite().min(0).max(20) })
  .strict();
export const DurationValueSchemaZ = z
  .object({ unit: z.literal("ms"), value: z.number().finite().min(0).max(10_000) })
  .strict();
export type RhythmValue = z.infer<typeof RhythmValueSchemaZ>;
export type RatioValue = z.infer<typeof RatioValueSchemaZ>;
export type DurationValue = z.infer<typeof DurationValueSchemaZ>;

export const ElevationValueSchemaZ = z
  .object({
    level: z.number().int().min(0).max(4),
    intent: z.enum(["flat", "raised", "overlay"]),
  })
  .strict();
export type ElevationValue = z.infer<typeof ElevationValueSchemaZ>;

export const TypographyValueSchemaZ = z
  .object({
    family: z.enum(["monospace", "system"]),
    weight: z.enum(["regular", "medium", "semibold", "bold"]),
    lineHeight: RatioValueSchemaZ,
    truncation: z.enum(["ellipsis", "clip", "wrap"]),
  })
  .strict();
export type TypographyValue = z.infer<typeof TypographyValueSchemaZ>;

export const MotionEasingSchemaZ = z
  .object({
    standard: z.enum(["linear", "standard", "decelerate"]),
    emphasized: z.enum(["linear", "standard", "decelerate"]),
  })
  .strict();

export const WindowActivityValueSchemaZ = z
  .object({ opacity: RatioValueSchemaZ, contrast: RatioValueSchemaZ })
  .strict();

const SurfacesSchemaZ = z
  .object({
    canvas: RendererNeutralColorSchemaZ,
    panel: RendererNeutralColorSchemaZ,
    panelRaised: RendererNeutralColorSchemaZ,
    terminal: RendererNeutralColorSchemaZ,
    header: RendererNeutralColorSchemaZ,
    headerActive: RendererNeutralColorSchemaZ,
    command: RendererNeutralColorSchemaZ,
  })
  .strict();
const TextSchemaZ = z
  .object({
    primary: RendererNeutralColorSchemaZ,
    secondary: RendererNeutralColorSchemaZ,
    muted: RendererNeutralColorSchemaZ,
    bright: RendererNeutralColorSchemaZ,
    inverse: RendererNeutralColorSchemaZ,
    link: RendererNeutralColorSchemaZ,
  })
  .strict();
const BordersSchemaZ = z
  .object({
    subtle: RendererNeutralColorSchemaZ,
    default: RendererNeutralColorSchemaZ,
    focused: RendererNeutralColorSchemaZ,
    selected: RendererNeutralColorSchemaZ,
    attention: RendererNeutralColorSchemaZ,
    danger: RendererNeutralColorSchemaZ,
  })
  .strict();
const StatusToneSchemaZ = z
  .object({
    neutral: RendererNeutralColorSchemaZ,
    info: RendererNeutralColorSchemaZ,
    warning: RendererNeutralColorSchemaZ,
    danger: RendererNeutralColorSchemaZ,
    success: RendererNeutralColorSchemaZ,
  })
  .strict();
const SelectionSchemaZ = z
  .object({
    selection: RendererNeutralColorSchemaZ,
    selectionText: RendererNeutralColorSchemaZ,
    hover: RendererNeutralColorSchemaZ,
    pressed: RendererNeutralColorSchemaZ,
    disabled: RendererNeutralColorSchemaZ,
  })
  .strict();
const DensitySchemaZ = z
  .object({
    cellHeight: RhythmValueSchemaZ,
    headerHeight: RhythmValueSchemaZ,
    statusHeight: RhythmValueSchemaZ,
    inlineGap: RhythmValueSchemaZ,
    sectionGap: RhythmValueSchemaZ,
    controlPadding: RhythmValueSchemaZ,
  })
  .strict();
const ShapeSchemaZ = z
  .object({
    dockedRadius: RhythmValueSchemaZ,
    floatingRadius: RhythmValueSchemaZ,
    controlRadius: RhythmValueSchemaZ,
    statusRadius: RhythmValueSchemaZ,
  })
  .strict();
const ElevationSchemaZ = z
  .object({
    floating: ElevationValueSchemaZ,
    palette: ElevationValueSchemaZ,
    windowMode: ElevationValueSchemaZ,
  })
  .strict();
const MotionSchemaZ = z
  .object({
    instant: DurationValueSchemaZ,
    fast: DurationValueSchemaZ,
    standard: DurationValueSchemaZ,
    emphasized: DurationValueSchemaZ,
    easing: MotionEasingSchemaZ,
  })
  .strict();
const TypographySchemaZ = z
  .object({
    workspace: TypographyValueSchemaZ,
    label: TypographyValueSchemaZ,
    title: TypographyValueSchemaZ,
    metadata: TypographyValueSchemaZ,
    code: TypographyValueSchemaZ,
  })
  .strict();
const FocusSchemaZ = z
  .object({
    outline: RhythmValueSchemaZ,
    outlineOffset: RhythmValueSchemaZ,
    focusContrast: RatioValueSchemaZ,
    highContrastOutline: RendererNeutralColorSchemaZ,
  })
  .strict();
const WindowActivitySchemaZ = z
  .object({ active: WindowActivityValueSchemaZ, inactive: WindowActivityValueSchemaZ })
  .strict();

export const VisualTokensV1SchemaZ = z
  .object({
    surfaces: SurfacesSchemaZ,
    text: TextSchemaZ,
    borders: BordersSchemaZ,
    statusTone: StatusToneSchemaZ,
    selection: SelectionSchemaZ,
    density: DensitySchemaZ,
    shape: ShapeSchemaZ,
    elevation: ElevationSchemaZ,
    motion: MotionSchemaZ,
    typography: TypographySchemaZ,
    focus: FocusSchemaZ,
    windowActivity: WindowActivitySchemaZ,
  })
  .strict();
export type VisualTokensV1 = z.infer<typeof VisualTokensV1SchemaZ>;

export const VisualTokenOverridesV1SchemaZ = z
  .object({
    surfaces: SurfacesSchemaZ.partial().optional(),
    text: TextSchemaZ.partial().optional(),
    borders: BordersSchemaZ.partial().optional(),
    statusTone: StatusToneSchemaZ.partial().optional(),
    selection: SelectionSchemaZ.partial().optional(),
    density: DensitySchemaZ.partial().optional(),
    shape: ShapeSchemaZ.partial().optional(),
    elevation: ElevationSchemaZ.partial().optional(),
    motion: MotionSchemaZ.partial().optional(),
    typography: TypographySchemaZ.partial().optional(),
    focus: FocusSchemaZ.partial().optional(),
    windowActivity: WindowActivitySchemaZ.partial().optional(),
  })
  .strict();
export type VisualTokenOverridesV1 = z.infer<typeof VisualTokenOverridesV1SchemaZ>;

const ThemeIdSchemaZ = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9._-]*$/u);
const ThemeNameSchemaZ = z.string().min(1).max(120);
export const ThemeAppearanceSchemaZ = z.enum(["dark", "light"]);
export type ThemeAppearance = z.infer<typeof ThemeAppearanceSchemaZ>;

export const VisualThemeDocumentV1SchemaZ = z
  .object({
    version: z.literal(VISUAL_THEME_VERSION),
    id: ThemeIdSchemaZ,
    name: ThemeNameSchemaZ,
    appearance: ThemeAppearanceSchemaZ.optional(),
    overrides: VisualTokenOverridesV1SchemaZ,
  })
  .strict();
export type VisualThemeDocumentV1 = z.infer<typeof VisualThemeDocumentV1SchemaZ>;

/** Version zero used `tokens`; migration is explicit and never mutates caller data. */
export const VisualThemeDocumentV0SchemaZ = z
  .object({
    version: z.literal(0),
    id: ThemeIdSchemaZ,
    name: ThemeNameSchemaZ,
    appearance: ThemeAppearanceSchemaZ.optional(),
    tokens: VisualTokenOverridesV1SchemaZ,
  })
  .strict();
export type VisualThemeDocumentV0 = z.infer<typeof VisualThemeDocumentV0SchemaZ>;

export const ThemeAccessibilityPreferencesSchemaZ = z
  .object({ reducedMotion: z.boolean(), increasedContrast: z.boolean() })
  .strict();
export type ThemeAccessibilityPreferences = z.infer<typeof ThemeAccessibilityPreferencesSchemaZ>;

export interface ThemeDiagnostic {
  readonly source: "user" | "project";
  readonly code:
    | "invalid-document"
    | "invalid-token"
    | "unknown-token"
    | "migrated"
    | "future-version";
  readonly path: string;
  readonly message: string;
}

export type LoadedThemeDocument =
  | {
      readonly status: "ready";
      readonly sourceVersion: 0 | 1 | null;
      readonly migrated: boolean;
      readonly writable: true;
      readonly document: VisualThemeDocumentV1;
      readonly diagnostics: readonly ThemeDiagnostic[];
    }
  | {
      readonly status: "future-version";
      readonly sourceVersion: number;
      readonly migrated: false;
      readonly writable: false;
      readonly document: null;
      readonly diagnostics: readonly ThemeDiagnostic[];
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const groupSchemas: Readonly<Record<string, Readonly<Record<string, z.ZodType>>>> = {
  surfaces: {
    canvas: RendererNeutralColorSchemaZ,
    panel: RendererNeutralColorSchemaZ,
    panelRaised: RendererNeutralColorSchemaZ,
    terminal: RendererNeutralColorSchemaZ,
    header: RendererNeutralColorSchemaZ,
    headerActive: RendererNeutralColorSchemaZ,
    command: RendererNeutralColorSchemaZ,
  },
  text: {
    primary: RendererNeutralColorSchemaZ,
    secondary: RendererNeutralColorSchemaZ,
    muted: RendererNeutralColorSchemaZ,
    bright: RendererNeutralColorSchemaZ,
    inverse: RendererNeutralColorSchemaZ,
    link: RendererNeutralColorSchemaZ,
  },
  borders: {
    subtle: RendererNeutralColorSchemaZ,
    default: RendererNeutralColorSchemaZ,
    focused: RendererNeutralColorSchemaZ,
    selected: RendererNeutralColorSchemaZ,
    attention: RendererNeutralColorSchemaZ,
    danger: RendererNeutralColorSchemaZ,
  },
  statusTone: {
    neutral: RendererNeutralColorSchemaZ,
    info: RendererNeutralColorSchemaZ,
    warning: RendererNeutralColorSchemaZ,
    danger: RendererNeutralColorSchemaZ,
    success: RendererNeutralColorSchemaZ,
  },
  selection: {
    selection: RendererNeutralColorSchemaZ,
    selectionText: RendererNeutralColorSchemaZ,
    hover: RendererNeutralColorSchemaZ,
    pressed: RendererNeutralColorSchemaZ,
    disabled: RendererNeutralColorSchemaZ,
  },
  density: Object.fromEntries(DENSITY_TOKEN_ROLES.map((role) => [role, RhythmValueSchemaZ])),
  shape: Object.fromEntries(SHAPE_TOKEN_ROLES.map((role) => [role, RhythmValueSchemaZ])),
  elevation: Object.fromEntries(ELEVATION_TOKEN_ROLES.map((role) => [role, ElevationValueSchemaZ])),
  motion: {
    ...Object.fromEntries(MOTION_DURATION_ROLES.map((role) => [role, DurationValueSchemaZ])),
    easing: MotionEasingSchemaZ,
  },
  typography: Object.fromEntries(
    TYPOGRAPHY_TOKEN_ROLES.map((role) => [role, TypographyValueSchemaZ]),
  ),
  focus: {
    outline: RhythmValueSchemaZ,
    outlineOffset: RhythmValueSchemaZ,
    focusContrast: RatioValueSchemaZ,
    highContrastOutline: RendererNeutralColorSchemaZ,
  },
  windowActivity: Object.fromEntries(
    WINDOW_ACTIVITY_TOKEN_ROLES.map((role) => [role, WindowActivityValueSchemaZ]),
  ),
};

function diagnostic(
  diagnostics: ThemeDiagnostic[],
  source: ThemeDiagnostic["source"],
  code: ThemeDiagnostic["code"],
  path: string,
  message: string,
): void {
  diagnostics.push({ source, code, path, message });
}

function cleanOverrides(
  value: unknown,
  source: ThemeDiagnostic["source"],
  diagnostics: ThemeDiagnostic[],
): VisualTokenOverridesV1 {
  if (!isRecord(value)) {
    diagnostic(
      diagnostics,
      source,
      "invalid-document",
      "overrides",
      "theme overrides must be an object",
    );
    return {};
  }
  const cleaned: Record<string, Record<string, unknown>> = {};
  for (const [group, groupValue] of Object.entries(value)) {
    const roles = groupSchemas[group];
    if (!roles) {
      diagnostic(diagnostics, source, "unknown-token", group, `unknown token group: ${group}`);
      continue;
    }
    if (!isRecord(groupValue)) {
      diagnostic(diagnostics, source, "invalid-token", group, "token group must be an object");
      continue;
    }
    const cleanGroup: Record<string, unknown> = {};
    for (const [role, token] of Object.entries(groupValue)) {
      const schema = roles[role];
      if (!schema) {
        diagnostic(
          diagnostics,
          source,
          "unknown-token",
          `${group}.${role}`,
          `unknown token role: ${role}`,
        );
        continue;
      }
      const parsed = schema.safeParse(token);
      if (!parsed.success) {
        diagnostic(
          diagnostics,
          source,
          "invalid-token",
          `${group}.${role}`,
          parsed.error.issues[0]?.message ?? "invalid token",
        );
        continue;
      }
      cleanGroup[role] = parsed.data;
    }
    if (Object.keys(cleanGroup).length > 0) cleaned[group] = cleanGroup;
  }
  return VisualTokenOverridesV1SchemaZ.parse(cleaned);
}

function cleanIdentity(
  value: unknown,
  schema: z.ZodType<string>,
  fallback: string,
  source: ThemeDiagnostic["source"],
  path: string,
  diagnostics: ThemeDiagnostic[],
): string {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  diagnostic(diagnostics, source, "invalid-document", path, `invalid ${path}; using ${fallback}`);
  return fallback;
}

export function loadVisualThemeDocument(
  raw: unknown,
  source: ThemeDiagnostic["source"],
): LoadedThemeDocument {
  const diagnostics: ThemeDiagnostic[] = [];
  if (isRecord(raw) && typeof raw.version === "number" && raw.version > VISUAL_THEME_VERSION) {
    diagnostic(
      diagnostics,
      source,
      "future-version",
      "version",
      `theme version ${raw.version} is newer than supported version ${VISUAL_THEME_VERSION}`,
    );
    return {
      status: "future-version",
      sourceVersion: raw.version,
      migrated: false,
      writable: false,
      document: null,
      diagnostics,
    };
  }

  const record = isRecord(raw) ? raw : {};
  const sourceVersion = record.version === 0 ? 0 : record.version === 1 ? 1 : null;
  if (sourceVersion === null) {
    diagnostic(
      diagnostics,
      source,
      "invalid-document",
      "version",
      "missing or invalid theme version; using safe defaults",
    );
  }
  const migrated = sourceVersion === 0;
  if (migrated) {
    diagnostic(diagnostics, source, "migrated", "version", "migrated theme version 0 to version 1");
  }
  const id = cleanIdentity(record.id, ThemeIdSchemaZ, `${source}-theme`, source, "id", diagnostics);
  const name = cleanIdentity(
    record.name,
    ThemeNameSchemaZ,
    `${source} theme`,
    source,
    "name",
    diagnostics,
  );
  const appearanceResult = ThemeAppearanceSchemaZ.safeParse(record.appearance);
  if (record.appearance !== undefined && !appearanceResult.success) {
    diagnostic(
      diagnostics,
      source,
      "invalid-document",
      "appearance",
      "invalid appearance; inheriting lower layer",
    );
  }
  const overrides = cleanOverrides(
    migrated ? record.tokens : record.overrides,
    source,
    diagnostics,
  );
  return {
    status: "ready",
    sourceVersion,
    migrated,
    writable: true,
    document: {
      version: VISUAL_THEME_VERSION,
      id,
      name,
      ...(appearanceResult.success ? { appearance: appearanceResult.data } : {}),
      overrides,
    },
    diagnostics,
  };
}

function color(hex: string): RendererNeutralColor {
  const normalized = hex.replace(/^#/u, "");
  return {
    space: "srgb",
    red: Number.parseInt(normalized.slice(0, 2), 16),
    green: Number.parseInt(normalized.slice(2, 4), 16),
    blue: Number.parseInt(normalized.slice(4, 6), 16),
    alpha: 255,
  };
}

const rhythm = (value: number): RhythmValue => ({ unit: "rhythm", value });
const ratio = (value: number): RatioValue => ({ unit: "ratio", value });
const duration = (value: number): DurationValue => ({ unit: "ms", value });

export function mixSrgbColors(
  left: RendererNeutralColor,
  right: RendererNeutralColor,
  rightWeight: number,
): RendererNeutralColor {
  const weight = Math.max(0, Math.min(1, rightWeight));
  const channel = (a: number, b: number) => Math.round(a * (1 - weight) + b * weight);
  return {
    space: "srgb",
    red: channel(left.red, right.red),
    green: channel(left.green, right.green),
    blue: channel(left.blue, right.blue),
    alpha: channel(left.alpha, right.alpha),
  };
}

function linearChannel(value: number): number {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(value: RendererNeutralColor): number {
  return (
    0.2126 * linearChannel(value.red) +
    0.7152 * linearChannel(value.green) +
    0.0722 * linearChannel(value.blue)
  );
}

export function contrastRatio(left: RendererNeutralColor, right: RendererNeutralColor): number {
  const a = relativeLuminance(left);
  const b = relativeLuminance(right);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function readableForeground(
  background: RendererNeutralColor,
  dark: RendererNeutralColor,
  light: RendererNeutralColor,
): RendererNeutralColor {
  return contrastRatio(background, light) >= contrastRatio(background, dark) ? light : dark;
}

export function deriveFocusedHeader(
  header: RendererNeutralColor,
  focus: RendererNeutralColor,
): RendererNeutralColor {
  return mixSrgbColors(header, focus, 0.16);
}

export function deriveAttentionBlend(
  surface: RendererNeutralColor,
  attention: RendererNeutralColor,
): RendererNeutralColor {
  return mixSrgbColors(surface, attention, 0.2);
}

function baseTokens(appearance: ThemeAppearance): VisualTokensV1 {
  const dark = appearance === "dark";
  const header = color(dark ? "17171f" : "ececf1");
  const focus = color(dark ? "68a8ff" : "1769d2");
  return VisualTokensV1SchemaZ.parse({
    surfaces: {
      canvas: color(dark ? "0e0e12" : "f5f5f7"),
      panel: color(dark ? "13131a" : "ffffff"),
      panelRaised: color(dark ? "1b1b24" : "ffffff"),
      terminal: color(dark ? "0b0b10" : "fbfbfd"),
      header,
      headerActive: deriveFocusedHeader(header, focus),
      command: color(dark ? "181821" : "ffffff"),
    },
    text: {
      primary: color(dark ? "dedee6" : "202027"),
      secondary: color(dark ? "a5a5b3" : "555563"),
      muted: color(dark ? "7b7b8a" : "72727f"),
      bright: color(dark ? "ffffff" : "09090d"),
      inverse: color(dark ? "101015" : "ffffff"),
      link: color(dark ? "62d9e8" : "006c7a"),
    },
    borders: {
      subtle: color(dark ? "242430" : "dedee5"),
      default: color(dark ? "343445" : "c3c3ce"),
      focused: focus,
      selected: color(dark ? "d77cff" : "7d35a8"),
      attention: color(dark ? "f0bd5c" : "8d5c00"),
      danger: color(dark ? "ff6475" : "b42334"),
    },
    statusTone: {
      neutral: color(dark ? "8b8b99" : "61616c"),
      info: color(dark ? "62b9ff" : "1769d2"),
      warning: color(dark ? "f0bd5c" : "8d5c00"),
      danger: color(dark ? "ff6475" : "b42334"),
      success: color(dark ? "62d49a" : "18764b"),
    },
    selection: {
      selection: color(dark ? "315f89" : "cce4ff"),
      selectionText: color(dark ? "ffffff" : "172334"),
      hover: color(dark ? "222b38" : "e8eef6"),
      pressed: color(dark ? "2c394a" : "dbe5f1"),
      disabled: color(dark ? "1a1a20" : "ececf0"),
    },
    density: {
      cellHeight: rhythm(1),
      headerHeight: rhythm(1),
      statusHeight: rhythm(1),
      inlineGap: rhythm(0.33),
      sectionGap: rhythm(1),
      controlPadding: rhythm(0.45),
    },
    shape: {
      dockedRadius: rhythm(0),
      floatingRadius: rhythm(0.33),
      controlRadius: rhythm(0.22),
      statusRadius: rhythm(0.44),
    },
    elevation: {
      floating: { level: 1, intent: "raised" },
      palette: { level: 3, intent: "overlay" },
      windowMode: { level: 2, intent: "overlay" },
    },
    motion: {
      instant: duration(0),
      fast: duration(90),
      standard: duration(150),
      emphasized: duration(220),
      easing: { standard: "standard", emphasized: "decelerate" },
    },
    typography: {
      workspace: {
        family: "monospace",
        weight: "regular",
        lineHeight: ratio(1.5),
        truncation: "ellipsis",
      },
      label: {
        family: "monospace",
        weight: "medium",
        lineHeight: ratio(1.35),
        truncation: "ellipsis",
      },
      title: {
        family: "monospace",
        weight: "semibold",
        lineHeight: ratio(1.35),
        truncation: "ellipsis",
      },
      metadata: {
        family: "monospace",
        weight: "regular",
        lineHeight: ratio(1.35),
        truncation: "ellipsis",
      },
      code: {
        family: "monospace",
        weight: "regular",
        lineHeight: ratio(1.5),
        truncation: "clip",
      },
    },
    focus: {
      outline: rhythm(0.12),
      outlineOffset: rhythm(0.05),
      focusContrast: ratio(4.5),
      highContrastOutline: color(dark ? "ffffff" : "000000"),
    },
    windowActivity: {
      active: { opacity: ratio(1), contrast: ratio(1) },
      inactive: { opacity: ratio(0.82), contrast: ratio(0.88) },
    },
  });
}

export const BUILTIN_VISUAL_THEMES: Readonly<Record<ThemeAppearance, VisualTokensV1>> =
  Object.freeze({ dark: baseTokens("dark"), light: baseTokens("light") });

function applyOverrides(base: VisualTokensV1, overrides: VisualTokenOverridesV1): VisualTokensV1 {
  return VisualTokensV1SchemaZ.parse({
    surfaces: { ...base.surfaces, ...overrides.surfaces },
    text: { ...base.text, ...overrides.text },
    borders: { ...base.borders, ...overrides.borders },
    statusTone: { ...base.statusTone, ...overrides.statusTone },
    selection: { ...base.selection, ...overrides.selection },
    density: { ...base.density, ...overrides.density },
    shape: { ...base.shape, ...overrides.shape },
    elevation: { ...base.elevation, ...overrides.elevation },
    motion: { ...base.motion, ...overrides.motion },
    typography: { ...base.typography, ...overrides.typography },
    focus: { ...base.focus, ...overrides.focus },
    windowActivity: { ...base.windowActivity, ...overrides.windowActivity },
  });
}

function applyAccessibility(
  tokens: VisualTokensV1,
  preferences: ThemeAccessibilityPreferences,
): VisualTokensV1 {
  let next = tokens;
  if (preferences.reducedMotion) {
    next = applyOverrides(next, {
      motion: {
        instant: duration(0),
        fast: duration(0),
        standard: duration(0),
        emphasized: duration(0),
        easing: { standard: "linear", emphasized: "linear" },
      },
    });
  }
  if (preferences.increasedContrast) {
    next = applyOverrides(next, {
      borders: {
        focused: next.focus.highContrastOutline,
        selected: next.focus.highContrastOutline,
        attention: next.statusTone.warning,
        danger: next.statusTone.danger,
      },
      focus: { focusContrast: ratio(7) },
      windowActivity: {
        active: { opacity: ratio(1), contrast: ratio(1) },
        inactive: { opacity: ratio(1), contrast: ratio(1) },
      },
    });
  }
  return next;
}

export interface ResolveVisualThemeInput {
  readonly appearance?: ThemeAppearance;
  readonly userTheme?: unknown;
  readonly projectTheme?: unknown;
  readonly accessibility?: Partial<ThemeAccessibilityPreferences>;
}

export interface ResolvedVisualThemeV1 {
  readonly version: 1;
  readonly appearance: ThemeAppearance;
  readonly tokens: VisualTokensV1;
  readonly diagnostics: readonly ThemeDiagnostic[];
  readonly futureSources: readonly ThemeDiagnostic["source"][];
}

export function resolveVisualTheme(input: ResolveVisualThemeInput = {}): ResolvedVisualThemeV1 {
  const loadedUser =
    input.userTheme === undefined ? null : loadVisualThemeDocument(input.userTheme, "user");
  const loadedProject =
    input.projectTheme === undefined
      ? null
      : loadVisualThemeDocument(input.projectTheme, "project");
  const readyUser = loadedUser?.status === "ready" ? loadedUser.document : null;
  const readyProject = loadedProject?.status === "ready" ? loadedProject.document : null;
  const appearance =
    readyProject?.appearance ?? readyUser?.appearance ?? input.appearance ?? "dark";
  let tokens = BUILTIN_VISUAL_THEMES[appearance];
  if (readyUser) tokens = applyOverrides(tokens, readyUser.overrides);
  if (readyProject) tokens = applyOverrides(tokens, readyProject.overrides);
  tokens = applyAccessibility(
    tokens,
    ThemeAccessibilityPreferencesSchemaZ.parse({
      reducedMotion: input.accessibility?.reducedMotion ?? false,
      increasedContrast: input.accessibility?.increasedContrast ?? false,
    }),
  );
  return {
    version: VISUAL_THEME_VERSION,
    appearance,
    tokens,
    diagnostics: [...(loadedUser?.diagnostics ?? []), ...(loadedProject?.diagnostics ?? [])],
    futureSources: [loadedUser, loadedProject]
      .filter(
        (loaded): loaded is Extract<LoadedThemeDocument, { status: "future-version" }> =>
          loaded?.status === "future-version",
      )
      .map((loaded) => loaded.diagnostics[0]!.source),
  };
}
