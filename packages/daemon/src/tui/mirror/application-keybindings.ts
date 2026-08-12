/**
 * Fixed application shortcuts shared by the command palette and the settings
 * keybinding viewer.
 *
 * Keep this module deliberately dependency-free. Loading the palette must not
 * evaluate the settings model, and loading settings must not become a hidden
 * prerequisite for the terminal-first application shell.
 */
export interface ApplicationKeybindingRow {
  readonly label: string;
  readonly keycap: string;
  readonly paletteAction?: string;
}

export const APPLICATION_KEYBINDING_ROWS: readonly ApplicationKeybindingRow[] = Object.freeze([
  { label: "Command palette", keycap: "F5 · ^p" },
  { label: "Home", keycap: "F1", paletteAction: "surface:home" },
  { label: "Terminals", keycap: "F2", paletteAction: "surface:terminals" },
  { label: "Files", keycap: "F3", paletteAction: "surface:files" },
  { label: "Changes", keycap: "F4", paletteAction: "surface:changes" },
  { label: "Missions", keycap: "F6", paletteAction: "surface:missions" },
  { label: "Activity", keycap: "F9", paletteAction: "surface:activity" },
  { label: "Cycle workspace focus", keycap: "F8 · ^tab" },
  { label: "Save file", keycap: "^s", paletteAction: "save" },
  { label: "Back to Home", keycap: "^g" },
  { label: "Toggle editor", keycap: "^e" },
  { label: "Quit / detach", keycap: "^q", paletteAction: "quit" },
]);

/** Stable palette action key to the shortcut displayed at the row's edge. */
export const PALETTE_KEYCAPS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    APPLICATION_KEYBINDING_ROWS.flatMap((row) =>
      row.paletteAction ? [[row.paletteAction, row.keycap] as const] : [],
    ),
  ),
);

const PREFIX_TAKEN = new Set([..."cdfilmnopqrstwxz"]);
const PREFIX_REMAP: Readonly<Record<string, string>> = Object.freeze({
  "M-m": "u",
  "M-p": "j",
  "M-,": "v",
});

/** Reliable prefix-table twin for an Alt key, shared without settings runtime. */
export function prefixTwinFor(altKey: string): string | null {
  const remapped = PREFIX_REMAP[altKey];
  if (remapped) return remapped;
  const letter = /^M-([a-z])$/u.exec(altKey)?.[1];
  if (!letter || PREFIX_TAKEN.has(letter)) return null;
  return letter;
}
