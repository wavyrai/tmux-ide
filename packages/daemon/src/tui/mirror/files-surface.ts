import type { RGBA } from "@opentui/core";
import { clampTop, gutterWidth, type ReadOnlyReason } from "./editor-buffer.ts";
import { type FileNode, type FilteredRow } from "./file-tree.ts";
import { clipTerminal } from "./missions-workspace.ts";
import { terminalDisplayWidth } from "./panel-host.ts";
import { actionChipSpansFromRight, type Rect } from "./recipes.ts";

export type FilesSurfaceVariant = "compact" | "standard" | "wide";
export type FilesFocusArea = "list" | "editor";
export type FilesActionId =
  | "open"
  | "toggle-directory"
  | "filter"
  | "toggle-hidden"
  | "toggle-ignored"
  | "refresh"
  | "save"
  | "reload"
  | "focus-list"
  | "focus-editor";

export interface FilesActionDescriptor {
  id: FilesActionId;
  label: string;
  disabled?: boolean;
  hovered?: boolean;
  description: string;
}

export type FilesActionSpan = FilesActionDescriptor & { start: number; width: number };

export interface FilesProjectedRow extends Rect {
  id: string;
  role: "directory" | "file";
  sourceIndex: number;
  visibleIndex: number;
  label: string;
  depth: number;
  selected: boolean;
  hovered: boolean;
  disabled: boolean;
  ignored: boolean;
  status: string | null;
  actions: readonly FilesActionDescriptor[];
}

export interface FilesProjectedEditorLine extends Rect {
  id: string;
  lineNumber: number;
  gutter: string;
  text: string;
  cursorCol: number | null;
}

export interface FilesSurfaceProjection {
  width: number;
  height: number;
  variant: FilesSurfaceVariant;
  header: Rect;
  banner: Rect;
  body: Rect;
  footer: Rect;
  list: Rect;
  editor: Rect;
  previewVisible: boolean;
  title: string;
  pathContext: string;
  headerMeta: readonly string[];
  filter: { active: boolean; query: string };
  state: "loading" | "empty" | "error" | "ready" | "success";
  stateMessage: string;
  rows: readonly FilesProjectedRow[];
  editorLines: readonly FilesProjectedEditorLine[];
  footerHint: string;
  actions: readonly FilesActionSpan[];
}

export interface FilesSurfaceInput {
  width: number;
  height: number;
  workspaceDir: string;
  editorPath: string | null;
  editorModified: boolean;
  editorCursor: { row: number; col: number };
  editorLineCount: number;
  editorMessage: string;
  readOnly: ReadOnlyReason;
  filterQuery: string | null;
  focus: FilesFocusArea;
  showHidden: boolean;
  showIgnored: boolean;
  visibleRows: readonly { node: FileNode; index: number }[];
  totalRows: number;
  fileSelection: number;
  fileTop: number;
  editorVisible: readonly { num: number; text: string; cursorCol: number | null }[];
  editorTop: number;
  editorTotalLines: number;
  hovered: { region: "files" | "button"; index: number } | null;
  statusFor(node: FileNode): string | null;
  readOnlyBanner: string | null;
  footerBase: string;
}

export function filesSurfaceVariant(width: number, height: number): FilesSurfaceVariant {
  if (width >= 160 && height >= 45) return "wide";
  if (width >= 96 && height >= 30) return "standard";
  return "compact";
}

export function filesListWidth(width: number): number {
  const safe = Math.max(0, Math.floor(width));
  if (safe < 58) return safe;
  if (safe < 96) return Math.max(20, Math.min(34, Math.floor(safe * 0.42)));
  return Math.max(24, Math.min(44, Math.floor(safe * 0.34)));
}

export function filesBodyRows(height: number): number {
  return Math.max(0, Math.floor(height) - 3);
}

export function filesHitTest(
  projection: FilesSurfaceProjection,
  x: number,
  y: number,
):
  | { area: "header"; actionId?: FilesActionId; actionIndex?: number }
  | { area: "list"; rowIndex?: number }
  | { area: "editor" | "footer" }
  | null {
  if (x < 0 || y < 0 || x >= projection.width || y >= projection.height) return null;
  if (y < projection.header.height) {
    const actionIndex = projection.actions.findIndex(
      (action) => x >= action.start && x < action.start + action.width,
    );
    if (actionIndex >= 0) {
      return {
        area: "header",
        actionId: projection.actions[actionIndex]!.id,
        actionIndex,
      };
    }
    return { area: "header" };
  }
  if (y >= projection.footer.y) return { area: "footer" };
  if (y < projection.body.y) return null;
  if (x < projection.list.width) {
    const row = projection.rows.find((candidate) => y === candidate.y);
    return row ? { area: "list", rowIndex: row.visibleIndex } : { area: "list" };
  }
  return { area: "editor" };
}

export function projectFilesSurface(input: FilesSurfaceInput): FilesSurfaceProjection {
  const width = Math.max(0, Math.floor(input.width));
  const height = Math.max(0, Math.floor(input.height));
  const variant = filesSurfaceVariant(width, height);
  const headerHeight = Math.min(1, height);
  const bannerHeight = height >= 4 ? 1 : 0;
  const footerHeight = height >= 6 ? 1 : 0;
  const bodyY = headerHeight + bannerHeight;
  const bodyHeight = Math.max(0, height - bodyY - footerHeight);
  const body: Rect = { x: 0, y: bodyY, width, height: bodyHeight };
  const listWidth = Math.min(width, filesListWidth(width));
  const previewVisible = width - listWidth >= 24 && bodyHeight > 0;
  const list: Rect = {
    x: 0,
    y: bodyY,
    width: previewVisible ? listWidth : width,
    height: bodyHeight,
  };
  const editor: Rect = {
    x: previewVisible ? listWidth : 0,
    y: bodyY,
    width: previewVisible ? Math.max(0, width - listWidth) : 0,
    height: bodyHeight,
  };
  const title = "Files";
  const rows = input.visibleRows.slice(0, bodyHeight).map((row, i) =>
    projectFileRow({
      row,
      y: bodyY + i,
      width: list.width,
      selection: input.fileSelection,
      focus: input.focus,
      hovered: input.hovered,
      status: input.statusFor(row.node),
    }),
  );
  const editorLines = previewVisible
    ? input.editorVisible.slice(0, bodyHeight).map((line, i) =>
        projectEditorLine({
          line,
          y: bodyY + i,
          x: editor.x,
          width: editor.width,
          totalLines: input.editorTotalLines,
        }),
      )
    : [];
  const state = filesState(input, rows.length, editorLines.length);
  const actions: FilesActionDescriptor[] = [
    { id: "filter", label: "/ filter", description: "Filter file names" },
    {
      id: "toggle-hidden",
      label: `H dot:${input.showHidden ? "on" : "off"}`,
      description: "Toggle dotfiles",
    },
    {
      id: "toggle-ignored",
      label: `I ign:${input.showIgnored ? "on" : "off"}`,
      description: "Toggle gitignored files",
    },
    { id: "refresh", label: "r refresh", description: "Refresh file tree" },
  ];
  if (input.editorPath) {
    actions.unshift({
      id: "reload",
      label: "reload",
      description: "Reload open file",
    });
    if (input.editorModified && !input.readOnly) {
      actions.unshift({ id: "save", label: "save", description: "Save open file" });
    }
  }
  const actionLimit = variant === "compact" ? 3 : variant === "standard" ? 5 : actions.length;
  const visibleActions = actions.slice(0, actionLimit).map((action, index) => ({
    ...action,
    hovered: input.hovered?.region === "button" && input.hovered.index === index,
  }));
  const actionSpans = actionChipSpansFromRight(visibleActions, width, 1);
  return {
    width,
    height,
    variant,
    header: { x: 0, y: 0, width, height: headerHeight },
    banner: { x: 0, y: headerHeight, width, height: bannerHeight },
    body,
    footer: { x: 0, y: height - footerHeight, width, height: footerHeight },
    list,
    editor,
    previewVisible,
    title,
    pathContext: clipTerminal(input.editorPath ?? input.workspaceDir, width),
    headerMeta: [
      `${input.editorCursor.row + 1}:${input.editorCursor.col + 1}`,
      `${input.editorLineCount}L`,
      input.editorMessage,
    ].filter(Boolean),
    filter: { active: input.filterQuery !== null, query: input.filterQuery ?? "" },
    state,
    stateMessage: filesStateMessage(input, state),
    rows,
    editorLines,
    footerHint:
      variant === "compact"
        ? "enter open · / filter · esc list"
        : clipTerminal(input.footerBase, width),
    actions: actionSpans,
  };
}

function filesState(
  input: FilesSurfaceInput,
  visibleCount: number,
  editorVisibleCount: number,
): FilesSurfaceProjection["state"] {
  if (input.readOnlyBanner) return "error";
  if (input.totalRows === 0 && input.visibleRows.length === 0) return "empty";
  if (input.editorMessage.toLowerCase().includes("saved")) return "success";
  if (input.visibleRows.length === 0 && input.filterQuery !== null) return "empty";
  if (visibleCount === 0 && editorVisibleCount === 0) return "loading";
  return "ready";
}

function filesStateMessage(
  input: FilesSurfaceInput,
  state: FilesSurfaceProjection["state"],
): string {
  if (state === "error") return input.readOnlyBanner ?? "file unavailable";
  if (state === "empty" && input.filterQuery !== null)
    return `no files match /${input.filterQuery}`;
  if (state === "empty") return "no files visible — try H or I";
  if (state === "success") return input.editorMessage;
  if (state === "loading") return "loading files…";
  return input.editorPath ? input.editorPath : input.workspaceDir;
}

function projectFileRow(input: {
  row: FilteredRow;
  y: number;
  width: number;
  selection: number;
  focus: FilesFocusArea;
  hovered: { region: "files" | "button"; index: number } | null;
  status: string | null;
}): FilesProjectedRow {
  const n = input.row.node;
  const prefix = "  ".repeat(n.depth) + (n.isDir ? (n.expanded ? "▾ " : "▸ ") : "  ");
  const selected = input.row.index === input.selection && input.focus === "list";
  const statusReserve = input.status ? 2 : 0;
  const label = clipTerminal(prefix + n.name, Math.max(1, input.width - statusReserve - 1));
  return {
    id: `file:${n.path}`,
    role: n.isDir ? "directory" : "file",
    sourceIndex: input.row.index,
    visibleIndex: input.row.index,
    x: 0,
    y: input.y,
    width: input.width,
    height: 1,
    label,
    depth: n.depth,
    selected,
    hovered: input.hovered?.region === "files" && input.hovered.index === input.row.index,
    disabled: false,
    ignored: n.ignored,
    status: input.status,
    actions: [
      {
        id: n.isDir ? "toggle-directory" : "open",
        label: n.isDir ? "toggle" : "open",
        description: n.isDir ? "Expand or collapse directory" : "Open file in editor",
      },
    ],
  };
}

function projectEditorLine(input: {
  line: { num: number; text: string; cursorCol: number | null };
  x: number;
  y: number;
  width: number;
  totalLines: number;
}): FilesProjectedEditorLine {
  const gw = gutterWidth(input.totalLines);
  const contentWidth = Math.max(0, input.width - gw);
  return {
    id: `line:${input.line.num}`,
    x: input.x,
    y: input.y,
    width: input.width,
    height: 1,
    lineNumber: input.line.num,
    gutter: formatGutterText(input.line.num, gw),
    text: clipTerminal(input.line.text, contentWidth),
    cursorCol: input.line.cursorCol,
  };
}

function formatGutterText(num: number, width: number): string {
  const s = String(num);
  return `${" ".repeat(Math.max(0, width - s.length - 1))}${s} `;
}

export function filesVisibleTop(fileTop: number, totalRows: number, height: number): number {
  return clampTop(fileTop, totalRows, filesBodyRows(height));
}

export function clippedStatusLetter(
  status: string | null,
  colorMap: Record<string, RGBA>,
): { letter: string; color: RGBA } | null {
  if (!status) return null;
  const color = colorMap[status];
  return color ? { letter: status, color } : null;
}

export function fitsWidth(text: string, width: number): boolean {
  return terminalDisplayWidth(text) <= width;
}
