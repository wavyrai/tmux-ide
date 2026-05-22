export type RGBA = { r: number; g: number; b: number; a: number };

export interface WidgetTheme {
  bg: RGBA;
  fg: RGBA;
  fgMuted: RGBA;
  accent: RGBA;
  border: RGBA;
  selected: RGBA;
  selectedText: RGBA;
  dirName: RGBA;
  rowAlt: RGBA;
  indentGuide: RGBA;
  ignored: RGBA;
  gitModified: RGBA;
  gitAdded: RGBA;
  gitDeleted: RGBA;
  gitUntracked: RGBA;
  diffAdded: RGBA;
  diffAddedBg: RGBA;
  diffRemoved: RGBA;
  diffRemovedBg: RGBA;
  diffContext: RGBA;
  diffContextBg: RGBA;
  diffHunk: RGBA;
  diffLineNumber: RGBA;
}

function rgba(r: number, g: number, b: number, a = 255) {
  return { r, g, b, a };
}

const DEFAULTS: WidgetTheme = {
  bg: rgba(30, 30, 40),
  fg: rgba(200, 200, 210),
  fgMuted: rgba(120, 120, 140),
  accent: rgba(130, 170, 255),
  border: rgba(60, 60, 80),
  selected: rgba(50, 50, 70),
  selectedText: rgba(255, 255, 255),
  dirName: rgba(100, 160, 255),
  rowAlt: rgba(255, 255, 255, 5),
  indentGuide: rgba(60, 60, 80),
  ignored: rgba(80, 80, 100),
  gitModified: rgba(230, 180, 80),
  gitAdded: rgba(80, 200, 120),
  gitDeleted: rgba(230, 80, 80),
  gitUntracked: rgba(120, 120, 140),
  diffAdded: rgba(80, 200, 120),
  diffAddedBg: rgba(20, 60, 30),
  diffRemoved: rgba(230, 80, 80),
  diffRemovedBg: rgba(60, 20, 20),
  diffContext: rgba(160, 160, 170),
  diffContextBg: rgba(30, 30, 40),
  diffHunk: rgba(100, 180, 220),
  diffLineNumber: rgba(80, 80, 100),
};

/**
 * Parse a tmux/CSS color string into RGBA.
 * Supports: colourN / colorN (0-255), #rgb, #rrggbb.
 */
function parseColor(color: string): RGBA | null {
  // tmux colour0–colour255
  const tmuxMatch = color.match(/^colou?r(\d+)$/);
  if (tmuxMatch) {
    const rawIndex = tmuxMatch[1];
    if (!rawIndex) return null;
    const n = parseInt(rawIndex, 10);
    if (n < 0 || n > 255) return null;

    // Standard colors 0–15 (approximate to common terminal defaults)
    const STANDARD: [number, number, number][] = [
      [0, 0, 0],
      [128, 0, 0],
      [0, 128, 0],
      [128, 128, 0],
      [0, 0, 128],
      [128, 0, 128],
      [0, 128, 128],
      [192, 192, 192],
      [128, 128, 128],
      [255, 0, 0],
      [0, 255, 0],
      [255, 255, 0],
      [0, 0, 255],
      [255, 0, 255],
      [0, 255, 255],
      [255, 255, 255],
    ];
    if (n < 16) {
      const standard = STANDARD[n];
      if (!standard) return null;
      return rgba(standard[0], standard[1], standard[2]);
    }

    // 6×6×6 color cube (16–231)
    if (n < 232) {
      const idx = n - 16;
      const LEVELS: number[] = [0, 95, 135, 175, 215, 255];
      const r = LEVELS[Math.floor(idx / 36)];
      const g = LEVELS[Math.floor((idx % 36) / 6)];
      const b = LEVELS[idx % 6];
      if (r == null || g == null || b == null) return null;
      return rgba(r, g, b);
    }

    // Grayscale ramp (232–255)
    const level = 8 + 10 * (n - 232);
    return rgba(level, level, level);
  }

  // Hex: #rgb or #rrggbb
  const hexMatch = color.match(/^#([0-9a-fA-F]{3,6})$/);
  if (hexMatch) {
    let hex = hexMatch[1];
    if (!hex) return null;
    if (hex.length === 3) {
      const [r, g, b] = hex.split("");
      if (!r || !g || !b) return null;
      hex = r + r + g + g + b + b;
    }
    if (hex.length !== 6) return null;
    return rgba(
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    );
  }

  return null;
}

export function createTheme(config?: Record<string, string>): WidgetTheme {
  if (!config) return DEFAULTS;
  const theme = { ...DEFAULTS };
  const MAP: Record<string, keyof WidgetTheme> = {
    accent: "accent",
    border: "border",
    bg: "bg",
    fg: "fg",
  };
  for (const [key, prop] of Object.entries(MAP)) {
    const val = config[key];
    if (val) {
      const parsed = parseColor(val);
      if (parsed) theme[prop] = parsed;
    }
  }
  return theme;
}
