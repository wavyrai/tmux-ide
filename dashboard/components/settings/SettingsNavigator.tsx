"use client";

import { NavigatorShell } from "@/components/navigators/NavigatorShell";

export type SettingsSectionId =
  | "general"
  | "appearance"
  | "keybinds"
  | "terminal"
  | "sounds"
  | "about";

const SETTINGS_SECTIONS: { id: SettingsSectionId; label: string }[] = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "keybinds", label: "Keybinds" },
  { id: "terminal", label: "Terminal" },
  { id: "sounds", label: "Sounds" },
  { id: "about", label: "About" },
];

interface SettingsNavigatorProps {
  active: SettingsSectionId;
  onChange: (id: SettingsSectionId) => void;
}

/**
 * Section picker for the Settings workspace. Mirrors the section list
 * that previously lived inside SettingsView's `<aside>`. The detail view
 * owns the active-section state and passes it in here so refresh / route
 * round-trips don't lose selection.
 */
export function SettingsNavigator({ active, onChange }: SettingsNavigatorProps) {
  return (
    <NavigatorShell title="Settings" testId="settings-navigator">
      <nav className="p-2">
        {SETTINGS_SECTIONS.map((section) => (
          <button
            key={section.id}
            type="button"
            data-testid={`settings-nav-${section.id}`}
            data-active={active === section.id ? "true" : "false"}
            onClick={() => onChange(section.id)}
            className={`block h-8 w-full rounded-md px-2 text-left text-[12px] transition-colors ${
              active === section.id
                ? "bg-[var(--surface-active)] text-[var(--accent)]"
                : "text-[var(--fg-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--fg)]"
            }`}
          >
            {section.label}
          </button>
        ))}
      </nav>
    </NavigatorShell>
  );
}

export { SETTINGS_SECTIONS };
