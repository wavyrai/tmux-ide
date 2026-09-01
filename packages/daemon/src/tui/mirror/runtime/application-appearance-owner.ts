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
  readonly setNote: (note: string | null) => void;
  readonly theme: Accessor<SemanticThemeSnapshot>;
  readonly palette: Accessor<TerminalPaletteProjection>;
  readonly hostPalette: Accessor<ApplicationTerminalPaletteSnapshot>;
  readonly setTransientNote: (note: string | null) => void;
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
  const [appearance, setAppearance] = createSignal<ApplicationAppearanceSnapshot>(
    Object.freeze({
      generation: 0,
      theme: initialTheme,
      palette: createTerminalPaletteProjection(initialTheme),
    }),
  );
  const publishTheme = (): void => {
    const nextTheme = store.getSnapshot();
    setAppearance((current) =>
      Object.freeze({
        generation: current.generation + 1,
        theme: nextTheme,
        palette: createTerminalPaletteProjection(nextTheme),
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
  const cycleTheme = (): void => {
    const order: readonly ThemeModeSetting[] = ["dark", "light", "system"];
    const next = order[(order.indexOf(theme().setting) + 1) % order.length]!;
    store.setMode(next);
    updateAppConfig({ theme: { mode: next } });
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
