import type {
  MissionBoardColumn,
  MissionBoardView,
  MissionCardView,
  MissionHistorySummary,
} from "@tmux-ide/contracts";

import {
  MissionProjectionError,
  projectMissionBoard,
  projectMissionHistory,
} from "../../lib/mission-projections.ts";
import { MissionRepository, MissionRepositoryError } from "../../lib/mission-repository.ts";
import type { ProjectRuntimeRepository } from "../../lib/project-runtime-repository.ts";
import { terminalDisplayWidth } from "./panel-host.ts";
import type { WorkspaceUiStateV1 } from "./workspace-ui-state.ts";
import { missionsSelection, setMissionsSelection } from "./workspace-ui-state.ts";

export const MISSION_BOARD_COLUMNS = ["planned", "running", "blocked", "review", "done"] as const;
export const MISSION_COLUMN_LABELS: Readonly<Record<MissionBoardColumn, string>> = {
  planned: "Planned",
  running: "Running",
  blocked: "Blocked",
  review: "Review",
  done: "Done",
};
export const MISSION_DENSITIES = ["compact", "comfortable", "detailed"] as const;
export const MISSION_MIN_COLUMN_WIDTH = 22;
export const MISSION_MAX_COLUMN_WIDTH = 34;
export const MISSION_COLUMN_GAP = 1;
export const MISSION_HEADER_ROWS = 2;
export const MISSION_FOOTER_ROWS = 1;

export type MissionWorkspaceMode = "board" | "history";
export type MissionWorkspaceDensity = (typeof MISSION_DENSITIES)[number];
export type MissionWorkspaceLoadStatus = "loading" | "empty" | "error" | "ready";

export interface MissionWorkspaceSnapshot {
  board: MissionBoardView;
  history: MissionHistorySummary[];
  project: {
    identityKey: string;
    projectRoot: string;
  };
  loadedAt: string;
}

export type MissionWorkspaceLoadState =
  | { status: "loading"; generation: number; projectKey: string | null }
  | {
      status: "refreshing";
      generation: number;
      projectKey: string;
      snapshot: MissionWorkspaceSnapshot;
    }
  | { status: "empty"; generation: number; snapshot: MissionWorkspaceSnapshot }
  | { status: "ready"; generation: number; snapshot: MissionWorkspaceSnapshot }
  | {
      status: "error";
      generation: number;
      projectKey: string | null;
      message: string;
      snapshot?: MissionWorkspaceSnapshot;
    };

export interface MissionWorkspaceModel {
  mode: MissionWorkspaceMode;
  density: MissionWorkspaceDensity;
  selectedMissionId: string | null;
  selectedColumn: MissionBoardColumn;
  preferredRow: number;
  columnScroll: Record<MissionBoardColumn, number>;
  historyScroll: number;
  horizontalOffset: number;
}

export interface MissionWorkspaceLayout {
  width: number;
  height: number;
  mode: MissionWorkspaceMode;
  header: MissionHeaderLayout;
  footer: {
    label: string;
    width: number;
  };
  board: {
    availableRows: number;
    itemCapacity: number;
    columnWidth: number;
    visibleColumns: MissionBoardColumn[];
    columns: MissionColumnLayout[];
  };
  history: {
    availableRows: number;
    itemCapacity: number;
    rows: MissionHistoryRowLayout[];
  };
}

export interface MissionWorkspacePresentationOptions {
  loadStatus?: MissionWorkspaceLoadStatus | "refreshing";
  projectLabel?: string | null;
  errorMessage?: string | null;
  quitHint?: string | null;
}

export interface MissionHeaderLayout {
  rows: MissionHeaderChip[][];
  labels: [string, string];
}

export interface MissionHeaderChip {
  kind: "mode" | "density" | "refresh" | "horizontal";
  label: string;
  row: number;
  start: number;
  width: number;
  mode?: MissionWorkspaceMode;
  direction?: -1 | 1;
}

export interface MissionColumnLayout {
  column: MissionBoardColumn;
  label: string;
  x: number;
  width: number;
  count: number;
  scroll: number;
  cards: MissionCardLayout[];
}

export interface MissionCardLayout {
  missionId: string;
  column: MissionBoardColumn;
  index: number;
  hoverKey: number;
  x: number;
  y: number;
  width: number;
  height: number;
  lines: string[];
}

export interface MissionHistoryRowLayout {
  missionId: string;
  index: number;
  hoverKey: number;
  x: number;
  y: number;
  width: number;
  height: number;
  lines: string[];
}

export type MissionWorkspaceHit =
  | { kind: "mode"; mode: MissionWorkspaceMode }
  | { kind: "density" }
  | { kind: "refresh" }
  | { kind: "horizontal"; direction: -1 | 1 }
  | { kind: "column"; column: MissionBoardColumn }
  | { kind: "card"; missionId: string; column: MissionBoardColumn; index: number; hoverKey: number }
  | { kind: "history"; missionId: string; index: number; hoverKey: number }
  | null;

export class MissionWorkspaceLoader {
  #generation = 0;
  #activeProjectKey: string | null = null;

  begin(
    projectKey: string | null,
    priorSnapshot?: MissionWorkspaceSnapshot | null,
  ): MissionWorkspaceLoadState {
    this.#generation += 1;
    this.#activeProjectKey = projectKey;
    if (projectKey && priorSnapshot?.project.identityKey === projectKey) {
      return {
        status: "refreshing",
        generation: this.#generation,
        projectKey,
        snapshot: priorSnapshot,
      };
    }
    return { status: "loading", generation: this.#generation, projectKey };
  }

  cancel(): void {
    this.#generation += 1;
    this.#activeProjectKey = null;
  }

  accept(
    generation: number,
    projectKey: string,
    snapshot: MissionWorkspaceSnapshot,
  ): MissionWorkspaceLoadState | null {
    if (generation !== this.#generation || projectKey !== this.#activeProjectKey) return null;
    const status =
      snapshot.board.counts.total === 0 && snapshot.history.length === 0 ? "empty" : "ready";
    return { status, generation, snapshot };
  }

  reject(
    generation: number,
    projectKey: string | null,
    error: unknown,
  ): MissionWorkspaceLoadState | null {
    if (generation !== this.#generation || projectKey !== this.#activeProjectKey) return null;
    return { status: "error", generation, projectKey, message: missionErrorMessage(error) };
  }

  isCurrent(generation: number, projectKey: string | null): boolean {
    return generation === this.#generation && projectKey === this.#activeProjectKey;
  }
}

export function invalidatedMissionWorkspaceLoadState(): MissionWorkspaceLoadState {
  return { status: "loading", generation: 0, projectKey: null };
}

export function readMissionWorkspace(
  repository: ProjectRuntimeRepository,
  now: () => Date = () => new Date(),
): MissionWorkspaceSnapshot {
  const missions = new MissionRepository(repository);
  const { history, state } = missions.snapshot();
  const board = projectMissionBoard(state, history);
  const completed = projectMissionHistory(state, history);
  return {
    board,
    history: completed.map((entry) => detached(entry)),
    project: {
      identityKey: repository.metadata.identityKey,
      projectRoot: repository.metadata.projectRoot,
    },
    loadedAt: now().toISOString(),
  };
}

export function defaultMissionWorkspaceModel(
  selectedMissionId: string | null = null,
): MissionWorkspaceModel {
  return {
    mode: "board",
    density: "comfortable",
    selectedMissionId,
    selectedColumn: "planned",
    preferredRow: 0,
    columnScroll: emptyScrolls(),
    historyScroll: 0,
    horizontalOffset: 0,
  };
}

export function reconcileMissionWorkspaceModel(
  model: MissionWorkspaceModel,
  snapshot: Pick<MissionWorkspaceSnapshot, "board" | "history"> | null,
  options: { persistedMissionId?: string | null; width?: number; height?: number } = {},
): MissionWorkspaceModel {
  let next = cloneModel(model);
  const preferred = options.persistedMissionId ?? next.selectedMissionId;
  if (!snapshot) {
    next.selectedMissionId = preferred ?? null;
    return next;
  }
  if (next.mode === "history") {
    next.selectedMissionId = selectHistoryMission(snapshot.history, preferred);
    next.historyScroll = clampTop(
      next.historyScroll,
      snapshot.history.length,
      historyItemCapacity(options.height, next.density),
    );
  } else {
    const found = findMissionInBoard(snapshot.board, preferred);
    const fallback = found ?? firstBoardMission(snapshot.board);
    next.selectedMissionId = fallback?.id ?? null;
    next.selectedColumn = fallback?.column ?? next.selectedColumn;
    next.preferredRow = fallback?.index ?? 0;
  }
  next = clampMissionWorkspaceModel(next, snapshot, options);
  return next;
}

export function clampMissionWorkspaceModel(
  model: MissionWorkspaceModel,
  snapshot: Pick<MissionWorkspaceSnapshot, "board" | "history">,
  options: { width?: number; height?: number } = {},
): MissionWorkspaceModel {
  const next = cloneModel(model);
  const rows = boardItemCapacity(options.height, next.density);
  for (const column of MISSION_BOARD_COLUMNS) {
    next.columnScroll[column] = clampTop(
      next.columnScroll[column],
      snapshot.board.columns[column].length,
      rows,
    );
  }
  const selected = findMissionInBoard(snapshot.board, next.selectedMissionId);
  if (selected) {
    next.selectedColumn = selected.column;
    next.preferredRow = selected.index;
    next.columnScroll[selected.column] = scrollToIndex(
      selected.index,
      next.columnScroll[selected.column],
      rows,
    );
    next.horizontalOffset = followColumnOffset(
      columnIndex(selected.column),
      next.horizontalOffset,
      visibleColumnCount(options.width),
    );
  } else if (next.mode === "board") {
    const fallback = firstBoardMission(snapshot.board);
    next.selectedMissionId = fallback?.id ?? null;
    next.selectedColumn = fallback?.column ?? next.selectedColumn;
    next.preferredRow = fallback?.index ?? 0;
    if (fallback) {
      next.horizontalOffset = followColumnOffset(
        columnIndex(fallback.column),
        next.horizontalOffset,
        visibleColumnCount(options.width),
      );
    }
  }
  if (next.mode === "history") {
    next.selectedMissionId = selectHistoryMission(snapshot.history, next.selectedMissionId);
    const idx = snapshot.history.findIndex((entry) => entry.mission.id === next.selectedMissionId);
    if (idx >= 0)
      next.historyScroll = scrollToIndex(
        idx,
        next.historyScroll,
        historyItemCapacity(options.height, next.density),
      );
    next.historyScroll = clampTop(
      next.historyScroll,
      snapshot.history.length,
      historyItemCapacity(options.height, next.density),
    );
  }
  next.horizontalOffset = Math.min(
    Math.max(0, next.horizontalOffset),
    Math.max(0, MISSION_BOARD_COLUMNS.length - visibleColumnCount(options.width)),
  );
  return next;
}

export function moveMissionSelection(
  model: MissionWorkspaceModel,
  snapshot: Pick<MissionWorkspaceSnapshot, "board" | "history">,
  action: "left" | "right" | "up" | "down" | "home" | "end",
  options: { width?: number; height?: number } = {},
): MissionWorkspaceModel {
  const next = cloneModel(model);
  if (next.mode === "history") {
    const current = Math.max(
      0,
      snapshot.history.findIndex((entry) => entry.mission.id === next.selectedMissionId),
    );
    const last = Math.max(0, snapshot.history.length - 1);
    const index =
      action === "up"
        ? Math.max(0, current - 1)
        : action === "down"
          ? Math.min(last, current + 1)
          : action === "home"
            ? 0
            : action === "end"
              ? last
              : current;
    next.selectedMissionId = snapshot.history[index]?.mission.id ?? null;
    return clampMissionWorkspaceModel(next, snapshot, options);
  }
  const located = findMissionInBoard(snapshot.board, next.selectedMissionId);
  const currentColumn = located?.column ?? next.selectedColumn;
  const currentIndex = located?.index ?? next.preferredRow;
  if (action === "up" || action === "down" || action === "home" || action === "end") {
    const cards = snapshot.board.columns[currentColumn];
    if (cards.length > 0) {
      const index =
        action === "up"
          ? Math.max(0, currentIndex - 1)
          : action === "down"
            ? Math.min(cards.length - 1, currentIndex + 1)
            : action === "home"
              ? 0
              : cards.length - 1;
      next.selectedMissionId = cards[index]?.id ?? null;
      next.selectedColumn = currentColumn;
      next.preferredRow = index;
    }
  } else {
    const target = nearestNonEmptyColumn(snapshot.board, currentColumn, action === "left" ? -1 : 1);
    if (target) {
      const cards = snapshot.board.columns[target];
      const index = Math.min(currentIndex, cards.length - 1);
      next.selectedMissionId = cards[index]?.id ?? null;
      next.selectedColumn = target;
      next.preferredRow = index;
    }
  }
  return clampMissionWorkspaceModel(next, snapshot, options);
}

export function setMissionWorkspaceMode(
  model: MissionWorkspaceModel,
  snapshot: Pick<MissionWorkspaceSnapshot, "board" | "history">,
  mode: MissionWorkspaceMode,
  options: { width?: number; height?: number } = {},
): MissionWorkspaceModel {
  return reconcileMissionWorkspaceModel({ ...cloneModel(model), mode }, snapshot, options);
}

export function cycleMissionDensity(
  model: MissionWorkspaceModel,
  snapshot: Pick<MissionWorkspaceSnapshot, "board" | "history"> | null,
  options: { width?: number; height?: number } = {},
): MissionWorkspaceModel {
  const index = MISSION_DENSITIES.indexOf(model.density);
  const next = {
    ...cloneModel(model),
    density: MISSION_DENSITIES[(index + 1) % MISSION_DENSITIES.length]!,
  };
  return snapshot ? clampMissionWorkspaceModel(next, snapshot, options) : next;
}

export function scrollMissionWorkspace(
  model: MissionWorkspaceModel,
  snapshot: Pick<MissionWorkspaceSnapshot, "board" | "history">,
  target: MissionBoardColumn | "history",
  delta: number,
  options: { width?: number; height?: number } = {},
): MissionWorkspaceModel {
  const next = cloneModel(model);
  if (target === "history") next.historyScroll += delta;
  else next.columnScroll[target] += delta;
  return clampMissionWorkspaceModel(next, snapshot, options);
}

export function applyMissionWorkspaceHit(
  model: MissionWorkspaceModel,
  snapshot: Pick<MissionWorkspaceSnapshot, "board" | "history">,
  hit: Exclude<MissionWorkspaceHit, { kind: "refresh" } | null>,
  options: { width?: number; height?: number } = {},
): MissionWorkspaceModel {
  if (hit.kind === "mode") return setMissionWorkspaceMode(model, snapshot, hit.mode, options);
  if (hit.kind === "density") return cycleMissionDensity(model, snapshot, options);
  if (hit.kind === "horizontal") {
    return moveMissionSelection(model, snapshot, hit.direction < 0 ? "left" : "right", options);
  }
  if (hit.kind === "column") {
    const first = snapshot.board.columns[hit.column][0];
    return first
      ? reconcileMissionWorkspaceModel(
          { ...cloneModel(model), selectedMissionId: first.id },
          snapshot,
          options,
        )
      : clampMissionWorkspaceModel(
          { ...cloneModel(model), selectedColumn: hit.column },
          snapshot,
          options,
        );
  }
  return reconcileMissionWorkspaceModel(
    { ...cloneModel(model), selectedMissionId: hit.missionId },
    snapshot,
    options,
  );
}

export function missionWorkspaceLayout(
  width: number,
  height: number,
  model: MissionWorkspaceModel,
  snapshot: Pick<MissionWorkspaceSnapshot, "board" | "history"> | null,
  presentation: MissionWorkspacePresentationOptions = {},
): MissionWorkspaceLayout {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const visibleCount = visibleColumnCount(safeWidth);
  const horizontalOffset = Math.min(
    Math.max(0, model.horizontalOffset),
    Math.max(0, MISSION_BOARD_COLUMNS.length - visibleCount),
  );
  const visibleColumns = MISSION_BOARD_COLUMNS.slice(
    horizontalOffset,
    horizontalOffset + visibleCount,
  );
  const gapTotal = Math.max(0, visibleColumns.length - 1) * MISSION_COLUMN_GAP;
  const columnWidth = Math.min(
    MISSION_MAX_COLUMN_WIDTH,
    Math.max(1, Math.floor((safeWidth - gapTotal) / Math.max(1, visibleColumns.length))),
  );
  const cardHeight = missionCardHeight(model.density);
  const availableRows = boardRows(safeHeight);
  const boardCapacity = boardItemCapacity(safeHeight, model.density);
  const columns: MissionColumnLayout[] = [];
  let x = 0;
  for (const column of visibleColumns) {
    const cards = snapshot?.board.columns[column] ?? [];
    const start = Math.max(0, model.columnScroll[column]);
    const visibleCards = cards.slice(start, start + boardCapacity);
    columns.push({
      column,
      label: MISSION_COLUMN_LABELS[column],
      x,
      width: columnWidth,
      count: snapshot?.board.counts[column] ?? 0,
      scroll: start,
      cards: visibleCards.map((card, visibleIndex) => ({
        missionId: card.id,
        column,
        index: start + visibleIndex,
        hoverKey: missionCardHoverKey(column, start + visibleIndex),
        x,
        y: MISSION_HEADER_ROWS + 1 + visibleIndex * cardHeight,
        width: columnWidth,
        height: cardHeight,
        lines: missionCardLines(card, model.density, columnWidth),
      })),
    });
    x += columnWidth + MISSION_COLUMN_GAP;
  }
  const historyAvailableRows = historyRows(safeHeight);
  const historyStart = Math.max(0, model.historyScroll);
  const rowHeight = missionHistoryRowHeight(model.density);
  const historyCapacity = historyItemCapacity(safeHeight, model.density);
  const header = missionHeaderLayout(safeWidth, model, snapshot, presentation);
  return {
    width: safeWidth,
    height: safeHeight,
    mode: model.mode,
    header,
    footer: {
      label: missionFooterLabel(safeWidth, presentation.quitHint),
      width: safeWidth,
    },
    board: { availableRows, itemCapacity: boardCapacity, columnWidth, visibleColumns, columns },
    history: {
      availableRows: historyAvailableRows,
      itemCapacity: historyCapacity,
      rows: (snapshot?.history ?? [])
        .slice(historyStart, historyStart + historyCapacity)
        .map((entry, visibleIndex) => ({
          missionId: entry.mission.id,
          index: historyStart + visibleIndex,
          hoverKey: historyStart + visibleIndex,
          x: 0,
          y: MISSION_HEADER_ROWS + visibleIndex * rowHeight,
          width: safeWidth,
          height: rowHeight,
          lines: missionHistoryLines(entry, model.density, safeWidth),
        })),
    },
  };
}

export function missionWorkspaceHitTest(
  layout: MissionWorkspaceLayout,
  x: number,
  y: number,
): MissionWorkspaceHit {
  if (y === 0) {
    const hit = missionHeaderHit(layout.header, x, y);
    if (hit) return hit;
  } else if (y === 1) {
    const hit = missionHeaderHit(layout.header, x, y);
    if (hit) return hit;
  }
  if (layout.mode === "board") {
    for (const column of layout.board.columns) {
      if (y === MISSION_HEADER_ROWS && x >= column.x && x < column.x + column.width)
        return { kind: "column", column: column.column };
      for (const card of column.cards) {
        if (x >= card.x && x < card.x + card.width && y >= card.y && y < card.y + card.height) {
          return {
            kind: "card",
            missionId: card.missionId,
            column: card.column,
            index: card.index,
            hoverKey: card.hoverKey,
          };
        }
      }
    }
    return null;
  }
  for (const row of layout.history.rows) {
    if (x >= row.x && x < row.x + row.width && y >= row.y && y < row.y + row.height) {
      return {
        kind: "history",
        missionId: row.missionId,
        index: row.index,
        hoverKey: row.hoverKey,
      };
    }
  }
  return null;
}

export function missionCardLines(
  card: MissionCardView,
  density: MissionWorkspaceDensity,
  width: number,
): string[] {
  const progress =
    card.progress.total > 0 ? `${card.progress.done}/${card.progress.total}` : "no tasks";
  const lines = [card.title, `${card.status} · ${progress}`];
  if (density !== "compact") {
    if (card.blockedBy.length > 0) lines.push(`blocked by ${card.blockedBy.length}`);
    if (card.latestAttempt)
      lines.push(`attempt ${card.latestAttempt.agent}/${card.latestAttempt.harness}`);
    const proof = proofSignal(card.proofSummary);
    if (proof) lines.push(proof);
  }
  if (density === "detailed") {
    if (card.durationMs !== null) lines.push(`duration ${formatDuration(card.durationMs)}`);
    if (card.labels.length > 0) lines.push(`# ${card.labels.join(", ")}`);
  }
  return lines.slice(0, missionCardHeight(density)).map((line) => clipTerminal(line, width));
}

export function missionHistoryLines(
  entry: MissionHistorySummary,
  density: MissionWorkspaceDensity,
  width: number,
): string[] {
  const lines = [
    `${entry.outcome} · ${entry.mission.title}`,
    `finished ${entry.finishedAt} · ${entry.taskTotals.done}/${entry.taskTotals.total} tasks · ${formatDuration(entry.durationMs)}`,
  ];
  if (density !== "compact") {
    lines.push(
      `attempts ${attemptSignals(entry)}${entry.lastEvent ? ` · ${entry.lastEvent.label}` : ""}`,
    );
    const proof = proofSignal(entry.proofSummary);
    if (proof) lines.push(proof);
  }
  if (density === "detailed") lines.push(`mission ${entry.mission.id}`);
  return lines.slice(0, missionHistoryRowHeight(density)).map((line) => clipTerminal(line, width));
}

export function missionModeLabel(mode: MissionWorkspaceMode, active: boolean): string {
  return active ? `[${mode}]` : ` ${mode} `;
}

export function densityLabel(density: MissionWorkspaceDensity): string {
  return `z ${density}`;
}

export function missionSelectionFromWorkspaceState(
  state: WorkspaceUiStateV1,
  viewId: string,
): string | null {
  return missionsSelection(state, viewId).selectedMissionId;
}

export function workspaceStateWithMissionSelection(
  state: WorkspaceUiStateV1,
  viewId: string,
  missionId: string | null,
): WorkspaceUiStateV1 {
  return setMissionsSelection(state, viewId, missionId, null);
}

export function clipTerminal(text: string, width: number): string {
  if (width <= 0) return "";
  if (terminalDisplayWidth(text) <= width) return text;
  const ellipsis = "…";
  const limit = Math.max(0, width - terminalDisplayWidth(ellipsis));
  let out = "";
  let used = 0;
  for (const segment of graphemes(text)) {
    const segmentWidth = terminalDisplayWidth(segment);
    if (used + segmentWidth > limit) break;
    out += segment;
    used += segmentWidth;
  }
  return out + ellipsis;
}

function missionErrorMessage(error: unknown): string {
  if (error instanceof MissionRepositoryError || error instanceof MissionProjectionError) {
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return "mission data could not be loaded";
}

function detached<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function emptyScrolls(): Record<MissionBoardColumn, number> {
  return { planned: 0, running: 0, blocked: 0, review: 0, done: 0 };
}

function cloneModel(model: MissionWorkspaceModel): MissionWorkspaceModel {
  return { ...model, columnScroll: { ...model.columnScroll } };
}

function findMissionInBoard(board: MissionBoardView, missionId: string | null | undefined) {
  if (!missionId) return null;
  for (const column of MISSION_BOARD_COLUMNS) {
    const index = board.columns[column].findIndex((card) => card.id === missionId);
    if (index >= 0) return { id: missionId, column, index };
  }
  return null;
}

function firstBoardMission(board: MissionBoardView) {
  for (const column of MISSION_BOARD_COLUMNS) {
    const card = board.columns[column][0];
    if (card) return { id: card.id, column, index: 0 };
  }
  return null;
}

function selectHistoryMission(
  history: readonly MissionHistorySummary[],
  missionId: string | null | undefined,
): string | null {
  if (missionId && history.some((entry) => entry.mission.id === missionId)) return missionId;
  return history[0]?.mission.id ?? null;
}

function nearestNonEmptyColumn(
  board: MissionBoardView,
  from: MissionBoardColumn,
  direction: -1 | 1,
): MissionBoardColumn | null {
  for (
    let index = columnIndex(from) + direction;
    index >= 0 && index < MISSION_BOARD_COLUMNS.length;
    index += direction
  ) {
    const column = MISSION_BOARD_COLUMNS[index]!;
    if (board.columns[column].length > 0) return column;
  }
  return null;
}

function columnIndex(column: MissionBoardColumn): number {
  return MISSION_BOARD_COLUMNS.indexOf(column);
}

function missionCardHoverKey(column: MissionBoardColumn, index: number): number {
  return index * MISSION_BOARD_COLUMNS.length + columnIndex(column);
}

function visibleColumnCount(width: number | undefined): number {
  const safeWidth = Math.max(1, width ?? 120);
  const max = Math.floor(
    (safeWidth + MISSION_COLUMN_GAP) / (MISSION_MIN_COLUMN_WIDTH + MISSION_COLUMN_GAP),
  );
  return Math.max(1, Math.min(MISSION_BOARD_COLUMNS.length, max));
}

function followColumnOffset(index: number, offset: number, count: number): number {
  if (index < offset) return index;
  if (index >= offset + count) return index - count + 1;
  return offset;
}

function boardRows(height: number | undefined): number {
  return Math.max(0, (height ?? 24) - MISSION_HEADER_ROWS - 1 - MISSION_FOOTER_ROWS);
}

function historyRows(height: number | undefined): number {
  return Math.max(0, (height ?? 24) - MISSION_HEADER_ROWS - MISSION_FOOTER_ROWS);
}

function boardItemCapacity(height: number | undefined, density: MissionWorkspaceDensity): number {
  return Math.max(0, Math.floor(boardRows(height) / missionCardHeight(density)));
}

function historyItemCapacity(height: number | undefined, density: MissionWorkspaceDensity): number {
  return Math.max(0, Math.floor(historyRows(height) / missionHistoryRowHeight(density)));
}

function clampTop(top: number, total: number, rows: number): number {
  return Math.max(0, Math.min(Math.max(0, total - Math.max(1, rows)), top));
}

function scrollToIndex(index: number, top: number, rows: number): number {
  if (index < top) return index;
  if (index >= top + rows) return Math.max(0, index - rows + 1);
  return top;
}

function missionCardHeight(density: MissionWorkspaceDensity): number {
  if (density === "compact") return 2;
  if (density === "comfortable") return 4;
  return 6;
}

function missionHistoryRowHeight(density: MissionWorkspaceDensity): number {
  if (density === "compact") return 2;
  if (density === "comfortable") return 4;
  return 5;
}

function missionHeaderLayout(
  width: number,
  model: MissionWorkspaceModel,
  snapshot: Pick<MissionWorkspaceSnapshot, "board" | "history"> | null,
  presentation: MissionWorkspacePresentationOptions,
): MissionHeaderLayout {
  const firstRow: MissionHeaderChip[] = [];
  let cursor = 0;
  let firstLabel = "";
  const addFirst = (
    chip: Omit<MissionHeaderChip, "row" | "start" | "width">,
  ): MissionHeaderChip | null => {
    const label = clipTerminal(chip.label, Math.max(0, width - cursor));
    const chipWidth = terminalDisplayWidth(label);
    if (chipWidth <= 0 || cursor + chipWidth > width) return null;
    const placed = { ...chip, label, row: 0, start: cursor, width: chipWidth };
    firstRow.push(placed);
    firstLabel = `${firstLabel}${firstLabel ? " " : ""}${label}`;
    cursor += chipWidth + 1;
    return placed;
  };
  addFirst({
    kind: "mode",
    mode: "board",
    label: missionModeLabel("board", model.mode === "board"),
  });
  addFirst({
    kind: "mode",
    mode: "history",
    label: missionModeLabel("history", model.mode === "history"),
  });
  addFirst({ kind: "density", label: densityLabel(model.density) });
  addFirst({ kind: "refresh", label: "r refresh" });

  const secondRow: MissionHeaderChip[] = [];
  const left = "<";
  const right = ">";
  if (width >= 1) {
    secondRow.push({ kind: "horizontal", direction: -1, label: left, row: 1, start: 0, width: 1 });
  }
  if (width >= 2) {
    secondRow.push({
      kind: "horizontal",
      direction: 1,
      label: right,
      row: 1,
      start: width - 1,
      width: 1,
    });
  }
  const secondLabel = missionSecondHeaderLabel(width, snapshot, presentation);
  return { rows: [firstRow, secondRow], labels: [clipTerminal(firstLabel, width), secondLabel] };
}

function missionSecondHeaderLabel(
  width: number,
  snapshot: Pick<MissionWorkspaceSnapshot, "board" | "history"> | null,
  presentation: MissionWorkspacePresentationOptions,
): string {
  if (width <= 0) return "";
  if (width === 1) return "<";
  const status = missionLoadStatusLabel(presentation);
  const project = presentation.projectLabel
    ? ` · ${projectBasename(presentation.projectLabel)}`
    : "";
  const summary = snapshot
    ? `${status}${project} · ${snapshot.board.counts.total} total · ${snapshot.history.length} finished`
    : `${status}${project}`;
  return `<${fitTerminal(` ${summary} `, Math.max(0, width - 2))}>`;
}

function missionFooterLabel(width: number, quitHint: string | null | undefined): string {
  const quit = quitHint?.trim() || "^q quit";
  return fitTerminal(
    `${quit} · tab mode · arrows move · z density · r refresh · enter details next`,
    width,
  );
}

function fitTerminal(text: string, width: number): string {
  if (width <= 0) return "";
  const clipped = clipTerminal(text, width);
  return `${clipped}${" ".repeat(Math.max(0, width - terminalDisplayWidth(clipped)))}`;
}

function missionLoadStatusLabel(presentation: MissionWorkspacePresentationOptions): string {
  if (presentation.loadStatus === "refreshing") return "refreshing";
  if (presentation.loadStatus === "loading") return "loading";
  if (presentation.loadStatus === "error") return presentation.errorMessage ?? "error";
  if (presentation.loadStatus === "empty") return "empty";
  return "ready";
}

function projectBasename(projectLabel: string): string {
  const trimmed = projectLabel.replace(/[\\/]+$/u, "");
  const parts = trimmed.split(/[\\/]/u).filter(Boolean);
  return parts.at(-1) ?? trimmed;
}

function missionHeaderHit(header: MissionHeaderLayout, x: number, y: number): MissionWorkspaceHit {
  const row = header.rows[y];
  if (!row) return null;
  for (const chip of row) {
    if (x < chip.start || x >= chip.start + chip.width) continue;
    if (chip.kind === "mode" && chip.mode) return { kind: "mode", mode: chip.mode };
    if (chip.kind === "density") return { kind: "density" };
    if (chip.kind === "refresh") return { kind: "refresh" };
    if (chip.kind === "horizontal" && chip.direction) {
      return { kind: "horizontal", direction: chip.direction };
    }
  }
  return null;
}

function proofSignal(proof: MissionCardView["proofSummary"]): string | null {
  const parts: string[] = [];
  if (proof.tests.total > 0) parts.push(`tests ${proof.tests.passed}/${proof.tests.total}`);
  if (proof.diff.filesChanged > 0) parts.push(`diff ${proof.diff.filesChanged}`);
  if (proof.prs.length > 0)
    parts.push(`PR ${proof.prs.map((pr) => pr.number ?? pr.status ?? "link").join(",")}`);
  if (proof.hasProof && parts.length === 0) parts.push(`${proof.proofIds.length} proof`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function attemptSignals(entry: MissionHistorySummary): string {
  const totals = entry.attemptTotals;
  const parts = [
    totals.submitted > 0 ? `${totals.submitted} submitted` : "",
    totals.approved > 0 ? `${totals.approved} approved` : "",
    totals.rejected > 0 ? `${totals.rejected} rejected` : "",
    totals.failed > 0 ? `${totals.failed} failed` : "",
    totals.interrupted > 0 ? `${totals.interrupted} interrupted` : "",
    totals.running > 0 ? `${totals.running} running` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : `${totals.total} total`;
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return "n/a";
  const seconds = Math.floor(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function graphemes(text: string): string[] {
  const Segmenter = Intl.Segmenter;
  if (Segmenter)
    return [...new Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(
      (entry) => entry.segment,
    );
  return [...text];
}
