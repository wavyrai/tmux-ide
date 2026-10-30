import gallery from "./gallery.json";
import { SHOWN_PRESETS } from "./shown-presets.mjs";

export type ThemeAppearance = "light" | "dark";

export const SWATCH_ROLES = [
  "background",
  "text",
  "accent",
  "success",
  "warning",
  "danger",
] as const;
export type SwatchRole = (typeof SWATCH_ROLES)[number];

export interface Attribution {
  readonly scheme: string;
  readonly licence: string;
  readonly url: string;
}

export interface GalleryPreset {
  readonly id: string;
  readonly name: string;
  readonly appearance: ThemeAppearance;
  readonly swatches: Readonly<Record<SwatchRole, string>>;
  readonly attribution?: Attribution;
  readonly thumb: string;
  readonly full: string;
}

export const THUMB_SIZE = gallery.size.thumb;
export const FULL_SIZE = gallery.size.full;

function galleryPreset({ id, attribution }: (typeof SHOWN_PRESETS)[number]): GalleryPreset {
  const preset = gallery.presets.find((candidate) => candidate.id === id);
  if (!preset) throw new Error(`Theme preset "${id}" is not in gallery.json; run pnpm demo:themes`);
  if (preset.appearance !== "light" && preset.appearance !== "dark")
    throw new Error(`Theme preset "${id}" has unknown appearance ${preset.appearance}`);
  return {
    ...preset,
    appearance: preset.appearance,
    ...(attribution ? { attribution } : {}),
    thumb: `/themes/${id}.webp`,
    full: `/themes/${id}-full.webp`,
  };
}

/**
 * The presets /themes shows (shown-presets.mjs), with the names, appearance
 * and colours recorded from the app's preset code by `pnpm demo:themes`.
 */
export const GALLERY_PRESETS: readonly GalleryPreset[] = SHOWN_PRESETS.map(galleryPreset);

/** The config line that selects a preset, as documented in /docs/theming. */
export function presetConfigLine(id: string): string {
  return `{ "theme": { "preset": "${id}" } }`;
}
