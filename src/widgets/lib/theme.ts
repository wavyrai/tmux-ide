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

export function createTheme(config?: Record<string, string>): WidgetTheme {
  if (!config) return DEFAULTS;
  return { ...DEFAULTS };
}
