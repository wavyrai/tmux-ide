import { createMemo, createSignal, type Accessor } from "solid-js";

import { updateAppConfig, type AppConfig } from "../../../lib/app-config.ts";
import {
  createSemanticThemeStore,
  createTerminalPaletteProjection,
  type SemanticThemeSnapshot,
  type TerminalPaletteProjection,
  type ThemeModeSource,
  type ThemeModeSetting,
} from "../theme.ts";
import { createApplicationTransientNoteOwner } from "./application-transient-note-owner.ts";

export interface ApplicationAppearanceOwner {
  readonly note: Accessor<string | null>;
  readonly setNote: (note: string | null) => void;
  readonly theme: Accessor<SemanticThemeSnapshot>;
  readonly palette: Accessor<TerminalPaletteProjection>;
  readonly setTransientNote: (note: string | null) => void;
  readonly cycleTheme: () => void;
  readonly dispose: () => void;
}

export function createAppearanceOwner(
  config: AppConfig,
  renderer: ThemeModeSource,
): ApplicationAppearanceOwner {
  const store = createSemanticThemeStore(config.theme, {
    rendererMode: renderer.themeMode,
  });
  const [theme, setTheme] = createSignal(store.getSnapshot());
  const stopTheme = store.subscribe(() => setTheme(store.getSnapshot()));
  const stopRendererTheme = store.followRendererThemeMode(renderer);
  const palette = createMemo(() => createTerminalPaletteProjection(theme()));
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
    note,
    setNote,
    theme,
    palette,
    setTransientNote: notice.publish,
    cycleTheme,
    dispose() {
      stopTheme();
      stopRendererTheme();
      notice.dispose();
    },
  };
}
