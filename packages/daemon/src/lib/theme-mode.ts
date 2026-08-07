/**
 * The theme-mode vocabulary of the persisted app config.
 *
 * These are configuration values, not presentation: the config reader, the
 * daemon, and any head that stores or forwards a user's theme preference need
 * them, while the OpenTUI palette that turns a mode into colors stays in the
 * TUI adapter (`tui/mirror/theme.ts`, which re-exports these names).
 */

export type ResolvedThemeMode = "dark" | "light";
export type ThemeModeSetting = ResolvedThemeMode | "system";
