/**
 * Compatibility metadata for the pre-canonical app theme fields.
 *
 * `parseAppConfig` must still resolve a complete legacy palette for tmux chrome,
 * while the native app must only project values the user actually wrote over
 * the canonical visual theme. A symbol keeps that provenance on the in-memory
 * object (including through object spread) without serializing implementation
 * metadata into `~/.tmux-ide/config.json`.
 */

export const LEGACY_THEME_OVERRIDE_IDS = [
  "accent",
  "muted",
  "fg",
  "status.blocked",
  "status.working",
  "status.done",
  "status.idle",
  "status.unknown",
  "glyphs.active",
  "glyphs.inactive",
] as const;

export type LegacyThemeOverrideId = (typeof LEGACY_THEME_OVERRIDE_IDS)[number];
export type LegacyThemeOverrideProvenance = Readonly<Record<LegacyThemeOverrideId, boolean>>;

export const LEGACY_THEME_OVERRIDE_PROVENANCE = Symbol.for(
  "tmux-ide.legacy-theme-override-provenance",
);

export function legacyThemeOverrideProvenance(
  explicitIds: ReadonlySet<LegacyThemeOverrideId> = new Set(),
): LegacyThemeOverrideProvenance {
  return Object.freeze(
    Object.fromEntries(LEGACY_THEME_OVERRIDE_IDS.map((id) => [id, explicitIds.has(id)])) as Record<
      LegacyThemeOverrideId,
      boolean
    >,
  );
}
