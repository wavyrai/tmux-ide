/**
 * A terminal-safe icon vocabulary shared by native workspace surfaces.
 *
 * The Unicode glyphs are deliberately monochrome, non-emoji symbols with a
 * one-cell terminal width. ASCII fallbacks keep semantic actions available to
 * conservative hosts without leaking presentation choices into controllers.
 */
export const WORKSPACE_ICONS = {
  home: { glyph: "⌂", fallback: "H", label: "Home" },
  terminals: { glyph: "❯", fallback: ">", label: "Terminals" },
  files: { glyph: "▤", fallback: "F", label: "Files" },
  diff: { glyph: "±", fallback: "D", label: "Changes" },
  missions: { glyph: "◆", fallback: "M", label: "Missions" },
  activity: { glyph: "◷", fallback: "A", label: "Activity" },
  preview: { glyph: "◫", fallback: "P", label: "Preview" },
  native: { glyph: "▣", fallback: "N", label: "Native surface" },
  more: { glyph: "⋯", fallback: ".", label: "More actions" },
  close: { glyph: "×", fallback: "x", label: "Close" },
  minimize: { glyph: "−", fallback: "-", label: "Minimize" },
  maximize: { glyph: "□", fallback: "Z", label: "Maximize" },
  restore: { glyph: "▣", fallback: "R", label: "Restore" },
  splitRight: { glyph: "│", fallback: "|", label: "Split side-by-side" },
  splitDown: { glyph: "─", fallback: "-", label: "Split stacked" },
  dock: { glyph: "▤", fallback: "D", label: "Dock" },
  float: { glyph: "◇", fallback: "F", label: "Float" },
  move: { glyph: "⠿", fallback: "M", label: "Move" },
  resize: { glyph: "◲", fallback: "R", label: "Resize" },
  popOut: { glyph: "⇱", fallback: "^", label: "Pop out" },
  search: { glyph: "⌕", fallback: "/", label: "Search" },
  refresh: { glyph: "↻", fallback: "r", label: "Refresh" },
  command: { glyph: "›", fallback: ">", label: "Command" },
} as const;

export type WorkspaceIconId = keyof typeof WORKSPACE_ICONS;
export type WorkspaceIconMode = "unicode" | "ascii";

export function workspaceIcon(id: WorkspaceIconId, mode: WorkspaceIconMode = "unicode"): string {
  const icon = WORKSPACE_ICONS[id];
  return mode === "ascii" ? icon.fallback : icon.glyph;
}

export function workspaceIconLabel(id: WorkspaceIconId): string {
  return WORKSPACE_ICONS[id].label;
}
