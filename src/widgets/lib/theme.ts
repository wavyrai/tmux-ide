export interface WidgetTheme {
  bg: { r: number; g: number; b: number; a: number };
  fg: { r: number; g: number; b: number; a: number };
  fgMuted: { r: number; g: number; b: number; a: number };
  accent: { r: number; g: number; b: number; a: number };
  border: { r: number; g: number; b: number; a: number };
  selected: { r: number; g: number; b: number; a: number };
  selectedText: { r: number; g: number; b: number; a: number };
  gitModified: { r: number; g: number; b: number; a: number };
  gitAdded: { r: number; g: number; b: number; a: number };
  gitDeleted: { r: number; g: number; b: number; a: number };
  gitUntracked: { r: number; g: number; b: number; a: number };
  diffAdded: { r: number; g: number; b: number; a: number };
  diffAddedBg: { r: number; g: number; b: number; a: number };
  diffRemoved: { r: number; g: number; b: number; a: number };
  diffRemovedBg: { r: number; g: number; b: number; a: number };
  diffContext: { r: number; g: number; b: number; a: number };
  diffContextBg: { r: number; g: number; b: number; a: number };
  diffHunk: { r: number; g: number; b: number; a: number };
  diffLineNumber: { r: number; g: number; b: number; a: number };
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
