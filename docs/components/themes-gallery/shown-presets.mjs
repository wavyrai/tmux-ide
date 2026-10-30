// The presets /themes shows, in display order within each section. The app
// ships every preset in packages/contracts/src/visual-theme-presets.ts; this
// list decides which appear on the public page. A preset that adapts another
// project's colour scheme carries that scheme's attribution, and is listed
// here only after its licence was checked (card #644's licence table).
// "monokai" and "github-light" are held back: their names are not cleared.
//
// Plain JavaScript so both the page and `pnpm demo:themes`
// (rasterize-theme-gallery.mjs) read the same list.

/** @type {readonly { id: string; attribution?: { scheme: string; licence: string; url: string } }[]} */
export const SHOWN_PRESETS = [
  { id: "paper" },
  {
    id: "solarized-light",
    attribution: {
      scheme: "Solarized",
      licence: "MIT",
      url: "https://github.com/altercation/solarized",
    },
  },
  {
    id: "gruvbox-light",
    attribution: { scheme: "Gruvbox", licence: "MIT", url: "https://github.com/morhetz/gruvbox" },
  },
  {
    id: "nord-light",
    attribution: { scheme: "Nord", licence: "MIT", url: "https://github.com/nordtheme/nord" },
  },
  { id: "amber" },
  { id: "green" },
  { id: "cyan" },
  { id: "red" },
  { id: "blue" },
  { id: "purple" },
  { id: "pink" },
  { id: "white" },
  {
    id: "tokyo",
    attribution: {
      scheme: "Tokyo Night",
      licence: "MIT",
      url: "https://github.com/tokyo-night/tokyo-night-vscode-theme",
    },
  },
  {
    id: "solarized",
    attribution: {
      scheme: "Solarized",
      licence: "MIT",
      url: "https://github.com/altercation/solarized",
    },
  },
  {
    id: "dracula",
    attribution: {
      scheme: "Dracula",
      licence: "MIT",
      url: "https://github.com/dracula/dracula-theme",
    },
  },
  {
    id: "nord",
    attribution: { scheme: "Nord", licence: "MIT", url: "https://github.com/nordtheme/nord" },
  },
  {
    id: "catppuccin",
    attribution: {
      scheme: "Catppuccin",
      licence: "MIT",
      url: "https://github.com/catppuccin/catppuccin",
    },
  },
  {
    id: "gruvbox",
    attribution: { scheme: "Gruvbox", licence: "MIT", url: "https://github.com/morhetz/gruvbox" },
  },
  {
    id: "rosepine",
    attribution: {
      scheme: "Rosé Pine",
      licence: "MIT",
      url: "https://github.com/rose-pine/rose-pine-theme",
    },
  },
  { id: "midnight" },
];
