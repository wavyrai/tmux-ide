import type { CliRenderer } from "@opentui/core";
import { createAutomaticContrastPass } from "../automatic-contrast.ts";
import { VISUAL_THEME_PRESETS, findVisualThemePreset } from "@tmux-ide/contracts";
import { batch, createSignal, type Accessor } from "solid-js";

import { updateAppConfig, type AppConfig } from "../../../lib/app-config.ts";
import {
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
  readonly setNote: (note: string | null | ((current: string | null) => string | null)) => void;
  readonly theme: Accessor<SemanticThemeSnapshot>;
  readonly palette: Accessor<TerminalPaletteProjection>;
  readonly hostPalette: Accessor<ApplicationTerminalPaletteSnapshot>;
  readonly setTransientNote: (note: string | null) => void;
  readonly automaticContrast: Accessor<boolean>;
  readonly toggleAutomaticContrast: () => void;
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
  return (
    deriveSystemVisualHostDefaults(snapshot) ?? { appearance: snapshot.detectedMode, overrides: {} }
  );
}

export function createAppearanceOwner(
  config: AppConfig,
  renderer: ThemeModeSource &
    Partial<Pick<CliRenderer, "addPostProcessFn" | "removePostProcessFn" | "requestRender">>,
  terminalPaletteOwner: ApplicationTerminalPaletteOwner,
): ApplicationAppearanceOwner {
  const [automaticContrast, setAutomaticContrast] = createSignal(
    config.theme.automaticContrast ?? true,
  );
  const correct = createAutomaticContrastPass();
  const postProcess: Parameters<CliRenderer["addPostProcessFn"]>[0] = (buffer) => {
    if (automaticContrast()) correct(buffer);
  };
  renderer.addPostProcessFn?.(postProcess);
  const setContrast = (enabled: boolean) => {
    if (enabled === automaticContrast()) return;
    setAutomaticContrast(enabled);
    renderer.requestRender?.();
  };
  const toggleAutomaticContrast = () => {
    if (pickerOpen()) {
      setContrast(!automaticContrast());
      setPickerError(null);
    }
  };
  const initialHostPalette = terminalPaletteOwner.getSnapshot();
  const store = createSemanticThemeStore(config.theme, {
    rendererMode: renderer.themeMode,
    hostDefaults: hostDefaults(initialHostPalette),
  });
  const initialTheme = store.getSnapshot();
  const [appearance, setAppearance] = createSignal<ApplicationAppearanceSnapshot>(
    Object.freeze({
      generation: 0,
      theme: initialTheme,
      palette: createTerminalPaletteProjection(initialTheme, initialHostPalette.palette),
    }),
  );
  const publishTheme = (): void => {
    const nextTheme = store.getSnapshot();
    setAppearance((current) =>
      Object.freeze({
        generation: current.generation + 1,
        theme: nextTheme,
        palette: createTerminalPaletteProjection(
          nextTheme,
          terminalPaletteOwner.getSnapshot().palette,
        ),
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
      const before = appearance();
      store.setHostDefaults(hostDefaults(next));
      if (theme().setting === "system" && appearance() === before) publishTheme();
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
    const wasSystem = theme().setting === "system";
    store.configure({
      ...config.theme,
      mode,
      preset: preset?.id,
    });
    if (mode === "system" && !wasSystem) void terminalPaletteOwner.refresh();
    setPickerSelection(id);
  };
  let originalSelection = pickerSelection();
  let originalContrast = automaticContrast();
  const preview = (id: string): void => {
    if (!pickerOpen()) return;
    setPickerError(null);
    if (options.some((p) => p.id === id)) apply(id);
  };
  const cancelPicker = (): void => {
    if (!pickerOpen()) return;
    setContrast(originalContrast);
    apply(originalSelection);
    setPickerOpen(false);
    setPickerError(null);
  };
  const savePicker = (): void => {
    if (!pickerOpen()) return;
    try {
      updateAppConfig({
        theme: {
          automaticContrast: automaticContrast(),
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
    updateAppConfig({ theme: { mode: next, preset: "", automaticContrast: automaticContrast() } });
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
    automaticContrast,
    toggleAutomaticContrast,
    pickerOpen,
    pickerError,
    pickerQuery,
    pickerSelection,
    pickerOptions,
    openPicker() {
      if (pickerOpen()) return;
      originalSelection = pickerSelection();
      originalContrast = automaticContrast();
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
      if (event.ctrl && name === "a") toggleAutomaticContrast();
      else if (name === "escape") cancelPicker();
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
      renderer.removePostProcessFn?.(postProcess);
      stopTheme();
      stopRendererTheme();
      stopHostPalette();
      terminalPaletteOwner.dispose();
      notice.dispose();
    },
  };
}
