import { VISUAL_THEME_PRESETS, findVisualThemePreset } from "@tmux-ide/contracts";
import { batch, createSignal, type Accessor } from "solid-js";

import { updateAppConfig, type AppConfig } from "../../../lib/app-config.ts";
import {
  DARK_THEME,
  createSemanticThemeStore,
  createTerminalPaletteProjection,
  deriveSystemVisualHostDefaults,
  type SemanticThemeSnapshot,
  type TerminalPaletteProjection,
  type ThemeModeSource,
  type ThemeModeSetting,
} from "../theme.ts";
import { createApplicationTransientNoteOwner } from "./application-transient-note-owner.ts";
import type {
  ApplicationTerminalPaletteOwner,
  ApplicationTerminalPaletteSnapshot,
} from "./application-terminal-palette-owner.ts";

export interface ApplicationAppearanceOwner {
  /** One publication boundary for every app-owned colour consumer. */
  readonly appearance: Accessor<ApplicationAppearanceSnapshot>;
  readonly note: Accessor<string | null>;
  readonly setNote: (note: string | null) => void;
  readonly theme: Accessor<SemanticThemeSnapshot>;
  readonly palette: Accessor<TerminalPaletteProjection>;
  readonly hostPalette: Accessor<ApplicationTerminalPaletteSnapshot>;
  readonly setTransientNote: (note: string | null) => void;
  readonly pickerOpen: Accessor<boolean>;
  readonly pickerError: Accessor<string | null>;
  readonly openPicker: () => void;
  readonly preview: (id: string) => void;
  readonly pickerQuery: Accessor<string>;
  readonly pickerSelection: Accessor<string>;
  readonly pickerOptions: Accessor<readonly { id: string; name: string }[]>;
  readonly cancelPicker: () => void;
  readonly savePicker: () => void;
  readonly handlePickerKey: (event: {
    name: string;
    repeated?: boolean;
    sequence?: string;
    ctrl?: boolean;
    meta?: boolean;
    eventType?: string;
  }) => boolean;
  readonly cycleTheme: () => void;
  readonly dispose: () => void;
}

export interface ApplicationAppearanceSnapshot {
  readonly generation: number;
  readonly theme: SemanticThemeSnapshot;
  readonly palette: TerminalPaletteProjection;
}

function hostDefaults(snapshot: ApplicationTerminalPaletteSnapshot) {
  if (snapshot.availability !== "available") return null;
  return deriveSystemVisualHostDefaults(snapshot);
}

export function createAppearanceOwner(
  config: AppConfig,
  renderer: ThemeModeSource,
  terminalPaletteOwner: ApplicationTerminalPaletteOwner,
): ApplicationAppearanceOwner {
  const initialHostPalette = terminalPaletteOwner.getSnapshot();
  const store = createSemanticThemeStore(config.theme, {
    rendererMode: renderer.themeMode,
    hostDefaults: hostDefaults(initialHostPalette),
  });
  const initialTheme = store.getSnapshot();
  // Mirrored programs are foreign terminal applications, not semantic app
  // components. They are launched with tmux-ide's dark terminal contract and
  // may retain default-colour cells indefinitely. Keep that cell contract
  // stable while app-owned overlays continue to follow the selected theme.
  const terminalCellDefaults = DARK_THEME;
  const [appearance, setAppearance] = createSignal<ApplicationAppearanceSnapshot>(
    Object.freeze({
      generation: 0,
      theme: initialTheme,
      palette: createTerminalPaletteProjection(initialTheme, terminalCellDefaults),
    }),
  );
  const publishTheme = (): void => {
    const nextTheme = store.getSnapshot();
    setAppearance((current) =>
      Object.freeze({
        generation: current.generation + 1,
        theme: nextTheme,
        palette: createTerminalPaletteProjection(nextTheme, terminalCellDefaults),
      }),
    );
  };
  const stopTheme = store.subscribe(publishTheme);
  const stopRendererTheme = store.followRendererThemeMode(renderer);
  const theme = (): SemanticThemeSnapshot => appearance().theme;
  const palette = (): TerminalPaletteProjection => appearance().palette;
  const [hostPalette, setHostPalette] = createSignal(initialHostPalette);
  const stopHostPalette = terminalPaletteOwner.subscribe(() => {
    const next = terminalPaletteOwner.getSnapshot();
    batch(() => {
      setHostPalette(next);
      // The store publishes at most one complete semantic snapshot. Explicit
      // dark/light settings retain these defaults without changing colours;
      // switching back to system applies the latest valid host palette.
      store.setHostDefaults(hostDefaults(next));
    });
  });
  const [note, setNote] = createSignal<string | null>(null);
  const notice = createApplicationTransientNoteOwner({
    read: note,
    write: setNote,
  });
  const [pickerOpen, setPickerOpen] = createSignal(false);
  const [pickerError, setPickerError] = createSignal<string | null>(null);
  const [pickerQuery, setPickerQuery] = createSignal("");
  const [pickerSelection, setPickerSelection] = createSignal(
    config.theme.preset ?? theme().setting,
  );
  const options = [
    { id: "system", name: "System · follow terminal" },
    { id: "dark", name: "Dark" },
    { id: "light", name: "Light" },
    ...VISUAL_THEME_PRESETS,
  ];
  const pickerOptions = () =>
    options.filter((p) => `${p.id} ${p.name}`.toLowerCase().includes(pickerQuery().toLowerCase()));
  const apply = (id: string) => {
    const preset = findVisualThemePreset(id);
    const mode = preset?.appearance ?? (id as ThemeModeSetting);
    store.configure({ ...config.theme, mode, preset: preset?.id });
    setPickerSelection(id);
  };
  let originalSelection = pickerSelection();
  const preview = (id: string): void => {
    if (!pickerOpen()) return;
    setPickerError(null);
    if (options.some((p) => p.id === id)) apply(id);
  };
  const cancelPicker = (): void => {
    if (!pickerOpen()) return;
    apply(originalSelection);
    setPickerOpen(false);
    setPickerError(null);
  };
  const savePicker = (): void => {
    if (!pickerOpen()) return;
    try {
      updateAppConfig({
        theme: {
          mode: theme().setting,
          preset: findVisualThemePreset(pickerSelection())?.id ?? "",
        },
      });
      setPickerOpen(false);
      setPickerError(null);
      notice.publish(
        `Appearance saved · ${options.find((p) => p.id === pickerSelection())?.name ?? theme().setting}`,
      );
    } catch {
      setPickerError("Could not save. Try again or cancel.");
    }
  };
  const cycleTheme = (): void => {
    const order: readonly ThemeModeSetting[] = ["dark", "light", "system"];
    const next = order[(order.indexOf(theme().setting) + 1) % order.length]!;
    apply(next);
    updateAppConfig({ theme: { mode: next, preset: "" } });
    notice.publish(`theme → ${next}`);
  };
  return {
    appearance,
    note,
    setNote,
    theme,
    palette,
    hostPalette,
    setTransientNote: notice.publish,
    pickerOpen,
    pickerError,
    pickerQuery,
    pickerSelection,
    pickerOptions,
    openPicker() {
      if (pickerOpen()) return;
      originalSelection = pickerSelection();
      setPickerQuery("");
      setPickerError(null);
      setPickerOpen(true);
    },
    preview,
    cancelPicker,
    savePicker,
    handlePickerKey(event) {
      if (!pickerOpen()) return false;
      if (event.eventType === "release" || event.repeated) return true;
      const name = event.name.toLowerCase();
      const choices = pickerOptions();
      if (name === "escape") cancelPicker();
      else if (name === "return" || name === "enter") savePicker();
      else if (name === "up" || name === "down" || name === "tab") {
        if (choices.length) {
          const current = choices.findIndex((p) => p.id === pickerSelection());
          const index =
            current < 0
              ? name === "up"
                ? choices.length - 1
                : 0
              : (current + (name === "up" ? choices.length - 1 : 1)) % choices.length;
          preview(choices[index]!.id);
        }
      } else if (name === "backspace") {
        setPickerQuery((q) => q.slice(0, -1));
      } else if (!event.ctrl && !event.meta) {
        const text = event.sequence ?? (name.length === 1 ? name : "");
        if (text.length === 1 && text >= " ") setPickerQuery((q) => (q + text).slice(0, 80));
      }
      return true;
    },
    cycleTheme,
    dispose() {
      stopTheme();
      stopRendererTheme();
      stopHostPalette();
      terminalPaletteOwner.dispose();
      notice.dispose();
    },
  };
}
