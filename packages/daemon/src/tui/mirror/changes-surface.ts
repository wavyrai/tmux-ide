import type { RGBA } from "@opentui/core";
import type { DiffEntry, DiffGroup, DiffLine, DiffLineKind, DiffRow } from "./diff-model.ts";
import { clipTerminal } from "./missions-workspace.ts";
import { terminalDisplayWidth } from "./panel-host.ts";
import { actionChipSpansFromRight, actionChipWidth, type Rect } from "./recipes.ts";

export type ChangesVariant = "compact" | "standard" | "wide";
export type ChangesActionId =
  | "refresh"
  | "stage"
  | "unstage"
  | "stage-all"
  | "unstage-all"
  | "row-stage"
  | "row-unstage";

export interface ChangesAction {
  id: ChangesActionId;
  label: string;
  description: string;
  disabled?: boolean;
  hovered?: boolean;
}

export interface ChangesActionSpan extends ChangesAction {
  start: number;
  width: number;
}

export interface ChangesProjectedFileRow extends Rect {
  id: string;
  kind: "file";
  rowIndex: number;
  fileIndex: number;
  entry: DiffEntry;
  status: string;
  path: string;
  countText: string;
  selected: boolean;
  hovered: boolean;
  action: ChangesActionSpan | null;
}

export interface ChangesProjectedHeaderRow extends Rect {
  id: string;
  kind: "header";
  rowIndex: number;
  label: string;
  group: DiffGroup;
}

export type ChangesProjectedListRow = ChangesProjectedHeaderRow | ChangesProjectedFileRow;

export interface ChangesProjectedDiffLine extends Rect {
  id: string;
  kind: DiffLineKind;
  text: string;
}

export interface ChangesSurfaceProjection {
  width: number;
  height: number;
  variant: ChangesVariant;
  header: Rect;
  banner: Rect;
  body: Rect;
  footer: Rect;
  list: Rect;
  diff: Rect;
  title: string;
  pathContext: string;
  totals: string;
  filter: { active: boolean; query: string };
  state: "ready" | "empty" | "loading" | "error";
  message: string;
  headerActions: readonly ChangesActionSpan[];
  listRows: readonly ChangesProjectedListRow[];
  diffLines: readonly ChangesProjectedDiffLine[];
  footerHint: string;
  footerActions: readonly ChangesActionSpan[];
}

export interface ChangesSurfaceInput {
  width: number;
  height: number;
  dir: string;
  fileCount: number;
  totals: { additions: number; deletions: number };
  filterQuery: string | null;
  message: string;
  listRows: readonly { row: DiffRow; rowIndex: number }[];
  selectedFileIndex: number;
  diffLines: readonly DiffLine[];
  hovered:
    | { region: "diff"; index: number }
    | { region: "diffverb"; index: number }
    | { region: "button"; index: number }
    | null;
  footerHint: string;
}

export function changesVariant(width: number, height: number): ChangesVariant {
  if (width >= 160 && height >= 45) return "wide";
  if (width >= 96 && height >= 30) return "standard";
  return "compact";
}

export function changesListWidth(width: number): number {
  const safe = Math.max(0, Math.floor(width));
  if (safe < 58) return safe;
  if (safe < 96) return Math.max(22, Math.min(34, Math.floor(safe * 0.42)));
  return Math.max(28, Math.min(52, Math.floor(safe * 0.34)));
}

export function changesBodyRows(height: number): number {
  return Math.max(0, Math.floor(height) - 3);
}

export function projectChangesSurface(input: ChangesSurfaceInput): ChangesSurfaceProjection {
  const width = Math.max(0, Math.floor(input.width));
  const height = Math.max(0, Math.floor(input.height));
  const variant = changesVariant(width, height);
  const headerHeight = Math.min(1, height);
  const bannerHeight = height >= 4 ? 1 : 0;
  const footerHeight = height >= 6 ? 1 : 0;
  const bodyY = headerHeight + bannerHeight;
  const bodyHeight = Math.max(0, height - bodyY - footerHeight);
  const listWidth = Math.min(width, changesListWidth(width));
  const diffVisible = width - listWidth >= 24 && bodyHeight > 0;
  const list: Rect = { x: 0, y: bodyY, width: diffVisible ? listWidth : width, height: bodyHeight };
  const diff: Rect = {
    x: diffVisible ? list.width : 0,
    y: bodyY,
    width: diffVisible ? Math.max(0, width - list.width) : 0,
    height: bodyHeight,
  };
  const headerActions = actionChipSpansFromRight(
    [
      {
        id: "refresh" as const,
        label: variant === "compact" ? "[r]" : "[r refresh]",
        description: "Refresh git status",
        hovered: input.hovered?.region === "button" && input.hovered.index === 0,
      },
    ],
    width,
    1,
  );
  const listRows = input.listRows.slice(0, bodyHeight).map((row, offset) =>
    row.row.kind === "header"
      ? projectListHeader(row.row, row.rowIndex, list, offset)
      : projectListFile({
          row: row.row,
          rowIndex: row.rowIndex,
          y: list.y + offset,
          width: list.width,
          selectedFileIndex: input.selectedFileIndex,
          hovered: input.hovered,
        }),
  );
  const diffLines = diffVisible
    ? input.diffLines.slice(0, bodyHeight).map((line, offset) => ({
        id: `diff:${offset}`,
        kind: line.kind,
        text: clipTerminal(line.text || " ", Math.max(0, diff.width - 1)),
        x: diff.x,
        y: diff.y + offset,
        width: diff.width,
        height: 1,
      }))
    : [];
  const footerActions = actionChipSpansFromRight(footerActionDefs(input.hovered), width, 1);
  const state =
    input.message && input.fileCount === 0
      ? input.message.includes("clean")
        ? "empty"
        : "error"
      : input.fileCount === 0
        ? "empty"
        : "ready";
  return {
    width,
    height,
    variant,
    header: { x: 0, y: 0, width, height: headerHeight },
    banner: { x: 0, y: headerHeight, width, height: bannerHeight },
    body: { x: 0, y: bodyY, width, height: bodyHeight },
    footer: { x: 0, y: height - footerHeight, width, height: footerHeight },
    list,
    diff,
    title: "Changes",
    pathContext: clipTerminal(input.dir, width),
    totals: `${input.fileCount} files · +${input.totals.additions} -${input.totals.deletions}`,
    filter: { active: input.filterQuery !== null, query: input.filterQuery ?? "" },
    state,
    message: input.message || (input.fileCount === 0 ? "working tree clean" : input.dir),
    headerActions,
    listRows,
    diffLines,
    footerHint:
      variant === "compact"
        ? "]/[ hunk · / filter · ^e edit"
        : clipTerminal(input.footerHint, width),
    footerActions,
  };
}

function projectListHeader(
  row: Extract<DiffRow, { kind: "header" }>,
  rowIndex: number,
  list: Rect,
  offset: number,
): ChangesProjectedHeaderRow {
  return {
    id: `header:${row.group}:${rowIndex}`,
    kind: "header",
    rowIndex,
    group: row.group,
    label: clipTerminal(row.label, Math.max(0, list.width - 1)),
    x: list.x,
    y: list.y + offset,
    width: list.width,
    height: 1,
  };
}

function projectListFile(input: {
  row: Extract<DiffRow, { kind: "file" }>;
  rowIndex: number;
  y: number;
  width: number;
  selectedFileIndex: number;
  hovered: ChangesSurfaceInput["hovered"];
}): ChangesProjectedFileRow {
  const selected = input.row.fileIndex === input.selectedFileIndex;
  const hovered = input.hovered?.region === "diff" && input.hovered.index === input.rowIndex;
  const entry = input.row.entry;
  const chip = rowAction(entry, hovered || selected);
  const actionWidth = hovered || selected ? actionChipWidth(chip.label) : 0;
  const countText = countLabel(entry);
  const countWidth = countText ? terminalDisplayWidth(countText) + 1 : 0;
  const pathWidth = Math.max(4, input.width - 4 - countWidth - actionWidth);
  const base: ChangesProjectedFileRow = {
    id: `file:${entry.group}:${entry.path}`,
    kind: "file",
    rowIndex: input.rowIndex,
    fileIndex: input.row.fileIndex,
    entry,
    status: entry.status,
    path: clipTerminal(entry.path, pathWidth),
    countText,
    selected,
    hovered,
    action: null,
    x: 0,
    y: input.y,
    width: input.width,
    height: 1,
  };
  if (!selected && !hovered) return base;
  const span = actionChipSpansFromRight([chip], input.width, 0)[0]!;
  return { ...base, action: span };
}

function rowAction(entry: DiffEntry, hovered: boolean): ChangesAction {
  return {
    id: entry.group === "staged" ? "row-unstage" : "row-stage",
    label: entry.group === "staged" ? "[u unstage]" : "[s stage]",
    description: entry.group === "staged" ? "Unstage file" : "Stage file",
    hovered,
  };
}

function footerActionDefs(hovered: ChangesSurfaceInput["hovered"]): ChangesAction[] {
  const defs: ChangesAction[] = [
    { id: "stage", label: "[s stage]", description: "Stage selected file" },
    { id: "unstage", label: "[u unstage]", description: "Unstage selected file" },
    { id: "stage-all", label: "[S all]", description: "Stage all files" },
    { id: "unstage-all", label: "[U all]", description: "Unstage all files" },
  ];
  return defs.map((action, index) => ({
    ...action,
    hovered: hovered?.region === "diffverb" && hovered.index === index,
  }));
}

function countLabel(entry: DiffEntry): string {
  const add = entry.additions && entry.additions > 0 ? `+${entry.additions}` : "";
  const del = entry.deletions && entry.deletions > 0 ? `-${entry.deletions}` : "";
  return [add, del].filter(Boolean).join(" ");
}

export function changesHitTest(
  projection: ChangesSurfaceProjection,
  x: number,
  y: number,
):
  | { area: "header"; actionId?: ChangesActionId; actionIndex?: number }
  | { area: "list"; rowIndex?: number; fileIndex?: number; actionId?: ChangesActionId }
  | { area: "diff" | "footer"; actionId?: ChangesActionId; actionIndex?: number }
  | null {
  if (x < 0 || y < 0 || x >= projection.width || y >= projection.height) return null;
  if (y < projection.header.height) {
    const i = projection.headerActions.findIndex((span) => containsX(span, x));
    return i >= 0
      ? { area: "header", actionId: projection.headerActions[i]!.id, actionIndex: i }
      : { area: "header" };
  }
  if (y >= projection.footer.y) {
    const i = projection.footerActions.findIndex((span) => containsX(span, x));
    return i >= 0
      ? { area: "footer", actionId: projection.footerActions[i]!.id, actionIndex: i }
      : { area: "footer" };
  }
  if (y < projection.body.y) return null;
  if (x < projection.list.width) {
    const row = projection.listRows.find((candidate) => candidate.y === y);
    if (!row) return { area: "list" };
    if (row.kind === "header") return { area: "list", rowIndex: row.rowIndex };
    if (row.action && containsX(row.action, x))
      return {
        area: "list",
        rowIndex: row.rowIndex,
        fileIndex: row.fileIndex,
        actionId: row.action.id,
      };
    return { area: "list", rowIndex: row.rowIndex, fileIndex: row.fileIndex };
  }
  return { area: "diff" };
}

function containsX(span: { start: number; width: number }, x: number): boolean {
  return x >= span.start && x < span.start + span.width;
}

export function colorForDiffKind(kind: DiffLineKind, colors: Record<DiffLineKind, RGBA>): RGBA {
  return colors[kind];
}
