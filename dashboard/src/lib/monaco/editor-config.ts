import type { editor } from "monaco-editor";

/**
 * Shared base options for code (single-file) editor instances. Tuned
 * for the dashboard's IDE shell: no minimap (tight layout), word wrap
 * on, line numbers, soft-readonly default so the lease consumer
 * explicitly opts into write mode.
 */
export const CODE_EDITOR_BASE_OPTIONS: editor.IStandaloneEditorConstructionOptions = {
  fontSize: 13,
  lineHeight: 20,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  wordWrap: "on",
  lineNumbers: "on",
  lineNumbersMinChars: 2,
  readOnly: true,
  automaticLayout: true,
  scrollbar: {
    vertical: "auto",
    horizontal: "auto",
    useShadows: false,
    verticalScrollbarSize: 4,
    horizontalScrollbarSize: 4,
    arrowSize: 0,
    verticalHasArrows: false,
    horizontalHasArrows: false,
    alwaysConsumeMouseWheel: false,
    verticalSliderSize: 4,
    horizontalSliderSize: 4,
  },
  smoothScrolling: true,
  cursorSmoothCaretAnimation: "on",
  padding: { top: 8, bottom: 8 },
  glyphMargin: true,
};

/**
 * Shared base options for diff editor instances. Mirrors emdash's
 * `DIFF_EDITOR_BASE_OPTIONS` — same tuning carried over verbatim.
 */
export const DIFF_EDITOR_BASE_OPTIONS: editor.IDiffEditorConstructionOptions = {
  originalEditable: false,
  fontSize: 13,
  lineHeight: 20,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  wordWrap: "on",
  lineNumbers: "on",
  lineNumbersMinChars: 2,
  readOnly: true,
  renderIndicators: false,
  overviewRulerLanes: 3,
  renderOverviewRuler: true,
  overviewRulerBorder: false,
  automaticLayout: true,
  scrollbar: {
    vertical: "auto",
    horizontal: "auto",
    useShadows: false,
    verticalScrollbarSize: 4,
    horizontalScrollbarSize: 4,
    arrowSize: 0,
    verticalHasArrows: false,
    horizontalHasArrows: false,
    alwaysConsumeMouseWheel: false,
    verticalSliderSize: 4,
    horizontalSliderSize: 4,
  },
  hideUnchangedRegions: { enabled: true },
  diffWordWrap: "on",
  enableSplitViewResizing: false,
  smoothScrolling: true,
  cursorSmoothCaretAnimation: "on",
  padding: { top: 8, bottom: 8 },
  folding: false,
  useInlineViewWhenSpaceIsLimited: false,
  glyphMargin: true,
};
