import manifest from "./presets.json";

export type ThemeAppearance = "light" | "dark";

export interface ThemePreset {
  readonly id: string;
  readonly name: string;
  readonly appearance: ThemeAppearance;
  readonly swatches: Readonly<Record<SwatchRole, string>>;
}

export const SWATCH_ROLES = [
  "background",
  "text",
  "accent",
  "success",
  "warning",
  "danger",
] as const;
export type SwatchRole = (typeof SWATCH_ROLES)[number];

function parsePreset(entry: (typeof manifest)[number]): ThemePreset {
  if (entry.appearance !== "light" && entry.appearance !== "dark") {
    throw new Error(`Theme preset ${entry.id} has unknown appearance ${entry.appearance}`);
  }
  return { ...entry, appearance: entry.appearance };
}

/**
 * The 22 presets the app ships (packages/contracts/src/visual-theme-presets.ts),
 * in the app's order. presets.json and renders/ are written together by the
 * mockup's render script, from the same preset documents.
 */
export const THEME_PRESETS: readonly ThemePreset[] = manifest.map(parsePreset);

/** The config line that selects a preset, as documented in /docs/theming. */
export function presetConfigLine(id: string): string {
  return `{ "theme": { "preset": "${id}" } }`;
}
