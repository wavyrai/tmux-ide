import { VISUAL_THEME_PRESETS } from "../../../packages/contracts/src/visual-theme-presets.ts";
import {
  resolveVisualTheme,
  mixSrgbColors,
} from "../../../packages/contracts/src/visual-tokens.ts";
import type { ITheme } from "@xterm/xterm";
export interface Theme {
  success?: string;
  warning?: string;
  info?: string;
  source?: "tui";
  accent: string;
  border: string;
  chrome: string;
  controlInk: string;
  danger: string;
  description: string;
  frameGradient: string;
  glassSheen: string;
  id: string;
  mode: "light" | "dark";
  muted: string;
  name: string;
  overlayFill: string;
  overlayShadow: string;
  page: string;
  panelActiveFill: string;
  panelFill: string;
  panelShadow: string;
  scrim: string;
  surface: string;
  tabShadow: string;
  tabSurface: string;
  terminal: ITheme;
  text: string;
  tint: string;
}
const ansi = {
  black: "#343a40",
  blue: "#80addd",
  brightBlack: "#929aa3",
  brightBlue: "#a1c6f1",
  brightCyan: "#a6d9dd",
  brightGreen: "#acd699",
  brightMagenta: "#ddbbea",
  brightRed: "#f49ca2",
  brightWhite: "#f7f8fa",
  brightYellow: "#eed898",
  cyan: "#85bcc7",
  green: "#93bc83",
  magenta: "#c4a0d6",
  red: "#dc7980",
  white: "#d8d9df",
  yellow: "#ddc47b",
};
interface Palette {
  accent: string;
  ambient: string;
  bottom: string;
  chrome: string;
  description: string;
  glow: string;
  id: string;
  mode: "light" | "dark";
  muted: string;
  name: string;
  surface: string;
  text: string;
}
function makeTheme(p: Palette): Theme {
  const dark = p.mode === "dark";
  // xterm's DOM renderer requires an opaque selection behind both glyphs and
  // empty cells. Blend with the theme surface here, never transparent black.
  const selectionTint = (opacity: number) =>
    "#" +
    [1, 3, 5]
      .map((index) => {
        const base = Number.parseInt(p.surface.slice(index, index + 2), 16);
        const accent = Number.parseInt(p.accent.slice(index, index + 2), 16);
        return Math.round(base + (accent - base) * opacity)
          .toString(16)
          .padStart(2, "0");
      })
      .join("");
  return {
    ...p,
    border: dark ? "#ffffff18" : "#00000014",
    controlInk: p.muted,
    danger: dark ? "#f3a59e" : "#a23436",
    frameGradient: `radial-gradient(ellipse at 10% 5%, ${p.ambient} 0%, transparent 65%), radial-gradient(ellipse at 95% 90%, ${p.glow} 0%, transparent 70%), linear-gradient(165deg, ${p.chrome}, ${p.bottom})`,
    // Large panes stay transparent: their color comes entirely from the app backdrop.
    glassSheen: "none",
    overlayFill: dark ? `${p.chrome}ed` : `${p.surface}ed`,
    overlayShadow: dark ? "0 16px 48px #00000038" : "0 16px 48px #24283818",
    page: p.chrome,
    panelActiveFill: dark ? "#ffffff14" : "#ffffff78",
    panelFill: dark ? "#ffffff08" : "#ffffff45",
    panelShadow: dark
      ? "inset 0 -4px 12px -4px #ffffff08, inset 0 1px 3px #ffffff06, 0 3px 8px -3px #09011414, 0 1px 2px -1px #0801140a"
      : "inset 0 -4px 12px -4px #ffffff40, inset 0 1px 3px #ffffff50, 0 3px 8px -3px #24283812, 0 1px 2px -1px #2428380c",
    scrim: dark ? "#00000040" : "#161b2920",
    tabShadow: dark
      ? "inset 0 -4px 12px -4px #ffffff14, inset 0 1px 3px #ffffff0f, 0 8px 8px -3px #0901140f, 0 3px 3px -1.5px #0801140f, 0 2px 2px -1px #0801140a, 0 1px 1px -0.5px #08011408"
      : "inset 0 -4px 12px -4px #ffffff50, inset 0 1px 3px #ffffff66, 0 8px 8px -3px #24283808, 0 3px 3px -1.5px #2428380c, 0 2px 2px -1px #2428380a, 0 1px 1px -0.5px #2428380a",
    // Neutral light, not palette color, gives compact glass its rounded surface.
    tabSurface: dark
      ? "linear-gradient(180deg, #ffffff29, #ffffff14)"
      : "linear-gradient(180deg, #ffffff85, #ffffff30)",
    terminal: {
      ...ansi,
      background: "#00000000",
      cursor: p.accent,
      cursorAccent: p.surface,
      foreground: p.text,
      selectionBackground: selectionTint(dark ? 0.3 : 0.27),
      selectionForeground: p.text,
      selectionInactiveBackground: selectionTint(0.16),
      ...(dark
        ? {}
        : {
            black: "#292b37",
            blue: "#4f80bf",
            brightBlack: "#808490",
            brightBlue: "#4d81c6",
            brightCyan: "#317c88",
            brightGreen: "#508240",
            brightRed: "#bd4b59",
            brightWhite: "#202532",
            brightYellow: "#987622",
            cyan: "#377e8e",
            green: "#527a43",
            magenta: "#966aa7",
            red: "#b94753",
            white: "#58616b",
            yellow: "#906e24",
          }),
    },
    tint: dark ? "#ffffff0d" : "#00000006",
  };
}
export const themes: Theme[] = [
  makeTheme({
    accent: "#648fe3",
    ambient: "#fcfcfe",
    bottom: "#f4f4f7",
    chrome: "#eeeef2",
    description: "Soft white, clear glass.",
    glow: "#f7f7fa",
    id: "paper",
    mode: "light",
    muted: "#656571",
    name: "Paper",
    surface: "#f8f8fb",
    text: "#3f404a",
  }),
  makeTheme({
    accent: "#788cca",
    ambient: "#fcfdff",
    bottom: "#f0f2f8",
    chrome: "#e8edf5",
    description: "A cooler kind of clarity.",
    glow: "#eff3fc",
    id: "pearl",
    mode: "light",
    muted: "#5d697e",
    name: "Pearl",
    surface: "#f5f8ff",
    text: "#3e465d",
  }),
  makeTheme({
    accent: "#74966b",
    ambient: "#f9fbf6",
    bottom: "#eff2eb",
    chrome: "#e5ebe5",
    description: "A soft wash of green.",
    glow: "#eef3e9",
    id: "sage",
    mode: "light",
    muted: "#5c6b5c",
    name: "Sage",
    surface: "#f4f7f0",
    text: "#3c493d",
  }),
  makeTheme({
    accent: "#b6cfad",
    ambient: "#1d1d1f",
    bottom: "#141416",
    chrome: "#111112",
    description: "Charcoal glass after dark.",
    glow: "#19191b",
    id: "midnight",
    mode: "dark",
    muted: "#959499",
    name: "Midnight",
    surface: "#1b1b1d",
    text: "#d1d0d5",
  }),
  makeTheme({
    accent: "#b4d6f4",
    ambient: "#045d7b",
    bottom: "#041b47",
    chrome: "#00394c",
    description: "Deep blue, from edge to edge.",
    glow: "#07316d",
    id: "ocean",
    mode: "dark",
    muted: "#9abcd1",
    name: "Ocean",
    surface: "#074878",
    text: "#eff8ff",
  }),
  makeTheme({
    accent: "#e6bba0",
    ambient: "#513833",
    bottom: "#251e2d",
    chrome: "#322323",
    description: "A warm glow for late nights.",
    glow: "#352a3e",
    id: "ember",
    mode: "dark",
    muted: "#bca39e",
    name: "Ember",
    surface: "#493035",
    text: "#efded7",
  }),
];

// Consume the same source documents and resolver as the TUI, not a copied catalog.
const hex = (c: { red: number; green: number; blue: number }) =>
  "#" + [c.red, c.green, c.blue].map((v) => v.toString(16).padStart(2, "0")).join("");
const nativeDocuments = [
  { version: 1 as const, id: "light", name: "Light", appearance: "light" as const, overrides: {} },
  { version: 1 as const, id: "dark", name: "Dark", appearance: "dark" as const, overrides: {} },
  ...VISUAL_THEME_PRESETS,
];
const ansiNames = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
];
const nativeThemes = nativeDocuments.map((doc) => {
  const r = resolveVisualTheme({ userTheme: doc }).tokens;
  const accent = hex(r.borders.focused);
  const theme = makeTheme({
    id: doc.id,
    name: doc.name,
    mode: doc.appearance!,
    description: "Native TUI palette",
    accent,
    ambient: hex(r.surfaces.canvas),
    bottom: hex(r.surfaces.canvas),
    chrome: hex(r.surfaces.canvas),
    glow: hex(r.surfaces.canvas),
    muted: hex(r.text.secondary),
    surface: hex(r.surfaces.panel),
    text: hex(r.text.primary),
  });
  const normal = [
    r.surfaces.terminal,
    r.statusTone.danger,
    r.statusTone.success,
    r.statusTone.warning,
    r.text.link,
    r.borders.focused,
    r.statusTone.info,
    r.text.secondary,
  ];
  const colors = [
    ...normal,
    r.text.muted,
    ...normal.slice(1, 7).map((c) => mixSrgbColors(c, r.text.primary, 0.2)),
    r.text.bright,
  ];
  return {
    ...theme,
    source: "tui" as const,
    border: hex(r.borders.default),
    danger: hex(r.statusTone.danger),
    success: hex(r.statusTone.success),
    warning: hex(r.statusTone.warning),
    info: hex(r.statusTone.info),
    panelFill: hex(r.surfaces.panel),
    panelActiveFill: hex(r.surfaces.panel),
    tint: hex(r.selection.hover),
    terminal: {
      ...theme.terminal,
      ...Object.fromEntries(ansiNames.map((n, i) => [n, hex(colors[i])])),
      foreground: hex(r.text.primary),
      background: hex(r.surfaces.terminal),
      cursor: accent,
      cursorAccent: hex(r.surfaces.terminal),
      selectionBackground: hex(r.selection.selection),
      selectionForeground: hex(r.selection.selectionText),
      selectionInactiveBackground: hex(r.selection.selection),
    },
  };
});
// Native IDs win on collisions, so saved TUI names always mean the same palette.
const originalThemes = themes.filter((t) => !nativeThemes.some((n) => n.id === t.id));
themes.splice(0, themes.length, ...nativeThemes, ...originalThemes);
