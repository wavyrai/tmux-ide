// Resolve the shared tmux-ide catalog in the helper, never on the GPUI thread.
import {
  VISUAL_THEME_PRESETS,
  findVisualThemePreset,
  resolveVisualTheme,
  createVisualTerminalPalette,
  type RendererNeutralColor,
} from "@tmux-ide/contracts";
import {
  loadAppConfig,
  updateAppConfig,
  type AppConfig,
  type AppConfigPatch,
} from "../../../packages/daemon/src/lib/app-config.ts";

export const appearanceOptions = Object.freeze([
  { id: "system", name: "System · follow macOS" },
  { id: "dark", name: "Dark" },
  { id: "light", name: "Light" },
  ...[...VISUAL_THEME_PRESETS]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ id, name }) => ({ id, name })),
]);
type SystemAppearance = "dark" | "light";
const packed = (c: RendererNeutralColor) => (c.red << 16) | (c.green << 8) | c.blue;

export function resolveNativeAppearance(selected: string, system: SystemAppearance) {
  if (!appearanceOptions.some((option) => option.id === selected))
    throw new Error("Unknown native theme");
  const preset = findVisualThemePreset(selected);
  const { tokens: t } = resolveVisualTheme({
    appearance: selected === "system" ? system : selected === "light" ? "light" : "dark",
    userTheme: preset,
  });
  const colors = {
    foreground: packed(t.text.primary),
    background: packed(t.surfaces.terminal),
    danger: packed(t.statusTone.danger),
    success: packed(t.statusTone.success),
    warning: packed(t.statusTone.warning),
    link: packed(t.text.link),
    accent: packed(t.borders.focused),
    info: packed(t.statusTone.info),
    secondary: packed(t.text.secondary),
    muted: packed(t.text.muted),
    bright: packed(t.text.bright),
  };
  return {
    selected,
    system,
    theme: {
      canvas: packed(t.surfaces.canvas),
      background: colors.background,
      foreground: colors.foreground,
      cursor: packed(t.selection.hover),
      surface: packed(t.surfaces.panel),
      active: packed(t.selection.selection),
      muted: colors.muted,
      accent: colors.accent,
      palette: createVisualTerminalPalette(colors),
    },
    options: appearanceOptions,
  };
}

export function createAppearanceOwner(
  io: {
    read: () => AppConfig;
    write: (patch: AppConfigPatch) => AppConfig;
  } = { read: loadAppConfig, write: updateAppConfig },
) {
  const config = io.read();
  let selected = findVisualThemePreset(config.theme.preset)?.id ?? config.theme.mode;
  let system: SystemAppearance = "dark";
  let error: string | null = null;
  let resolved = resolveNativeAppearance(selected, system);
  return {
    publication: () => ({ ...resolved, error }),
    setSystem(next: SystemAppearance) {
      if (next === system) return;
      system = next;
      resolved = resolveNativeAppearance(selected, system);
    },
    select(id: string) {
      if (!appearanceOptions.some((option) => option.id === id)) {
        error = "Unknown theme — choose an available theme";
        return;
      }
      const preset = findVisualThemePreset(id);
      try {
        // Shared patch API retains unrelated config. A failed save never advertises
        // the new theme as applied; diagnostics cannot reveal paths or raw errors.
        io.write({ theme: { mode: preset?.appearance ?? id, preset: preset?.id ?? "" } });
        selected = id;
        error = null;
        resolved = resolveNativeAppearance(selected, system);
      } catch {
        error = "Could not save theme — try again";
      }
    },
  };
}
