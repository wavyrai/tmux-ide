/**
 * The TUI island — one bundle, several scenes, each mountable on its own.
 *
 *   fleet    the team handoff: codex → claude → cursor, via `tmux-ide send`
 *   cli      the coordination primitives, run against a live fleet (interactive)
 *   palette  the ⌘K command palette — the app's real actions + fuzzy matcher
 *   diff     the Diff surface — real porcelain + unified diff, the app's model
 *   files    the Files surface — the app's tree filter/sort/expand + a viewer
 *
 * Every scene renders the app's REAL components (sidebar, chips, glyph grammar,
 * theme) through a web host for OpenTUI's box/text primitives. Only the fleet
 * data is staged — the app's data layer is tmux control mode, which has no
 * browser twin. See scene.tsx / scene-cli.tsx for the exact real-vs-staged line.
 *
 * Built by Vite into public/tui-demo.<hash>.js and mounted by a React client
 * component; Solid renders into a plain div, so the two frameworks never touch.
 */
import { render } from "./host.ts";
import { Scene } from "./scene.tsx";
import { CliScene } from "./scene-cli.tsx";
import { PaletteScene } from "./scene-palette.tsx";
import { DiffScene } from "./scene-diff.tsx";
import { FilesScene } from "./scene-files.tsx";

const CELL_FONT =
  'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

export type SceneName = "fleet" | "cli" | "palette" | "diff" | "files";

const SCENES: Record<SceneName, () => unknown> = {
  fleet: Scene,
  cli: CliScene,
  palette: PaletteScene,
  diff: DiffScene,
  files: FilesScene,
};

export function mount(el: HTMLElement, name: SceneName = "fleet"): () => void {
  // The char grid: one cell is 1ch × 1lh, so the host's `ch`/`lh` units — and
  // the pixels→cells mouse math — resolve against THIS font.
  el.style.fontFamily = CELL_FONT;
  el.style.fontSize = "12px";
  el.style.lineHeight = "1.5";
  el.style.display = "flex";
  el.style.background = "rgb(16, 16, 22)";
  const Chosen = SCENES[name] ?? Scene;
  return render(() => Chosen() as HTMLElement, el);
}

(window as unknown as { __tuiDemo?: typeof mount }).__tuiDemo = mount;
