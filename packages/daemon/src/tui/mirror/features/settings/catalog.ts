/** Settings commands exposed to the command palette. Dependency-free by design. */
export type SettingsCommandId =
  | "settings"
  | "settings-theme"
  | "settings-notifications"
  | "settings-quiet-hours"
  | "settings-updates"
  | "settings-restore"
  | "settings-keys"
  | "settings-reset";

export interface SettingsPaletteCommand {
  readonly id: SettingsCommandId;
  readonly label: string;
}

export const SETTINGS_PALETTE_COMMANDS: readonly SettingsPaletteCommand[] = Object.freeze([
  { id: "settings", label: "Settings…" },
  { id: "settings-theme", label: "Settings: Accent color" },
  { id: "settings-notifications", label: "Settings: Notifications" },
  { id: "settings-quiet-hours", label: "Settings: Quiet hours" },
  { id: "settings-updates", label: "Settings: Updates & background refresh" },
  { id: "settings-restore", label: "Settings: Crash restore" },
  { id: "settings-keys", label: "Settings: Keyboard shortcuts (view)" },
  { id: "settings-reset", label: "Settings: Reset to defaults" },
]);
