import type {
  MissionAttemptSummary,
  MissionBoardColumn,
  MissionBoardView,
  MissionCardView,
  MissionDetailView,
  MissionHistorySummary,
  MissionProofSummary,
  MissionTimelineEntry,
  TaskCardView,
} from "@tmux-ide/contracts";

import {
  MissionProjectionError,
  projectMissionBoard,
  projectMissionDetail,
  projectMissionHistory,
} from "../../lib/mission-projections.ts";
import { MissionRepository, MissionRepositoryError } from "../../lib/mission-repository.ts";
import type { ProjectRuntimeRepository } from "../../lib/project-runtime-repository.ts";
import type { HostedPanelView } from "./panel-host.ts";
import { findFirstHostedViewForPanel, terminalDisplayWidth } from "./panel-host.ts";
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

export type MissionWorkspaceMode = "board" | "history" | "detail";
export type MissionWorkspaceDensity = (typeof MISSION_DENSITIES)[number];
export type MissionWorkspaceLoadStatus = "loading" | "empty" | "error" | "ready";
export type MissionDetailSection = "tasks" | "timeline" | "attempts" | "proof";
export const MISSION_DETAIL_SECTIONS = ["tasks", "timeline", "attempts", "proof"] as const;

export interface MissionWorkspaceSnapshot {
  board: MissionBoardView;
  history: MissionHistorySummary[];
  detail: MissionDetailView | null;
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
  detailReturnMode: "board" | "history";
  selectedTaskId: string | null;
  detailSection: MissionDetailSection;
  detailScroll: Record<MissionDetailSection, number>;
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
  detail: MissionDetailLayout;
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
  kind: "mode" | "density" | "refresh" | "horizontal" | "section" | "deep-link";
  label: string;
  row: number;
  start: number;
  width: number;
  mode?: MissionWorkspaceMode;
  direction?: -1 | 1;
  section?: MissionDetailSection;
  link?: MissionDeepLinkKind;
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

export interface MissionDetailRowLayout {
  kind: MissionDetailSection | "context";
  id: string;
  index: number;
  hoverKey: number;
  x: number;
  y: number;
  width: number;
  height: number;
  lines: string[];
}

export interface MissionDetailLayout {
  wide: boolean;
  contextWidth: number;
  sectionX: number;
  sectionWidth: number;
  availableRows: number;
  itemCapacity: number;
  sections: MissionHeaderChip[];
  links: MissionHeaderChip[];
  contextRows: MissionDetailRowLayout[];
  rows: MissionDetailRowLayout[];
}

export type MissionDeepLinkKind = "terminal" | "files" | "diff";

export type MissionDeepLinkIntent =
  | { kind: "terminal"; session: string; paneId: string | null; viewId: string }
  | { kind: "files"; path: string; viewId: string; mode: "open" | "reveal" }
  | { kind: "diff"; path: string; viewId: string };

export type MissionDeepLinkResolution =
  | { available: true; kind: MissionDeepLinkKind; intent: MissionDeepLinkIntent; label: string }
  | { available: false; kind: MissionDeepLinkKind; reason: string; label: string };

export type MissionTmuxPreflightCommand =
  | { kind: "session"; file: "tmux"; args: ["has-session", "-t", string] }
  | { kind: "pane"; file: "tmux"; args: ["display-message", "-p", "-t", string, string] };

export type MissionWorkspaceHit =
  | { kind: "mode"; mode: MissionWorkspaceMode }
  | { kind: "density" }
  | { kind: "refresh" }
  | { kind: "horizontal"; direction: -1 | 1 }
  | { kind: "column"; column: MissionBoardColumn }
  | { kind: "card"; missionId: string; column: MissionBoardColumn; index: number; hoverKey: number }
  | { kind: "history"; missionId: string; index: number; hoverKey: number }
  | { kind: "detail-section"; section: MissionDetailSection }
  | {
      kind: "detail-row";
      section: MissionDetailSection;
      id: string;
      index: number;
      hoverKey: number;
    }
  | { kind: "deep-link"; link: MissionDeepLinkKind }
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
  selectedMissionId: string | null = null,
  now: () => Date = () => new Date(),
): MissionWorkspaceSnapshot {
  const missions = new MissionRepository(repository);
  const { history, state } = missions.snapshot();
  const board = projectMissionBoard(state, history);
  const completed = projectMissionHistory(state, history);
  const detail = selectedMissionId ? projectDetailOrNull(state, history, selectedMissionId) : null;
  return {
    board,
    history: completed.map((entry) => detached(entry)),
    detail: detail ? detached(detail) : null,
    project: {
      identityKey: repository.metadata.identityKey,
      projectRoot: repository.metadata.projectRoot,
    },
    loadedAt: now().toISOString(),
  };
}

export function defaultMissionWorkspaceModel(
  selectedMissionId: string | null = null,
  selectedTaskId: string | null = null,
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
    detailReturnMode: "board",
    selectedTaskId,
    detailSection: "tasks",
    detailScroll: emptyDetailScrolls(),
  };
}

export function reconcileMissionWorkspaceModel(
  model: MissionWorkspaceModel,
  snapshot: Pick<MissionWorkspaceSnapshot, "board" | "history" | "detail"> | null,
  options: {
    persistedMissionId?: string | null;
    persistedTaskId?: string | null;
    width?: number;
    height?: number;
  } = {},
): MissionWorkspaceModel {
  let next = cloneModel(model);
  const preferred = options.persistedMissionId ?? next.selectedMissionId;
  if (!snapshot) {
    next.selectedMissionId = preferred ?? null;
    next.selectedTaskId = options.persistedTaskId ?? next.selectedTaskId ?? null;
    return next;
  }
  if (next.mode === "detail") {
    const detailMission = snapshot.detail?.mission.id;
    if (detailMission) {
      next.selectedMissionId = detailMission;
      next.selectedTaskId = selectDetailTask(
        snapshot.detail,
        detailMission === model.selectedMissionId
          ? (next.selectedTaskId ?? options.persistedTaskId)
          : options.persistedTaskId,
      );
      return clampMissionWorkspaceModel(next, snapshot, options);
    }
    if (missionExists(snapshot, next.selectedMissionId)) {
      return clampMissionWorkspaceModel(next, snapshot, options);
    }
    next.mode = next.detailReturnMode;
    next.selectedTaskId = null;
  }
  if (next.mode === "history") {
    next.selectedMissionId = selectHistoryMission(snapshot.history, preferred);
    next.historyScroll = clampTop(
      next.historyScroll,
      snapshot.history.length,
      historyItemCapacity(options.height, next.density),
    );
    return clampMissionWorkspaceModel(next, snapshot, options);
  }
  const found = findMissionInBoard(snapshot.board, preferred);
  const fallback = found ?? firstBoardMission(snapshot.board);
  next.selectedMissionId = fallback?.id ?? null;
  next.selectedColumn = fallback?.column ?? next.selectedColumn;
  next.preferredRow = fallback?.index ?? 0;
  return clampMissionWorkspaceModel(next, snapshot, options);
}

export function clampMissionWorkspaceModel(
  model: MissionWorkspaceModel,
  snapshot: Pick<MissionWorkspaceSnapshot, "board" | "history" | "detail">,
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
  if (next.mode === "detail" && snapshot.detail) {
    next.selectedTaskId = selectDetailTask(snapshot.detail, next.selectedTaskId);
    for (const section of MISSION_DETAIL_SECTIONS) {
      const itemCount = detailSectionItems(snapshot.detail, section).length;
      next.detailScroll[section] = clampTop(
        next.detailScroll[section],
        itemCount,
        effectiveDetailItemCapacity(options.width, options.height, next.density, itemCount),
      );
    }
    if (next.detailSection === "tasks") {
      const idx = flattenedTasks(snapshot.detail).findIndex(
        (task) => task.id === next.selectedTaskId,
      );
      if (idx >= 0) {
        const itemCount = flattenedTasks(snapshot.detail).length;
        next.detailScroll.tasks = scrollToIndex(
          idx,
          next.detailScroll.tasks,
          effectiveDetailItemCapacity(options.width, options.height, next.density, itemCount),
        );
      }
    }
  }
  next.horizontalOffset = Math.min(
    Math.max(0, next.horizontalOffset),
    Math.max(0, MISSION_BOARD_COLUMNS.length - visibleColumnCount(options.width)),
  );
  return next;
}

export function moveMissionSelection(
  model: MissionWorkspaceModel,
  snapshot: Pick<MissionWorkspaceSnapshot, "board" | "history" | "detail">,
  action: "left" | "right" | "up" | "down" | "home" | "end",
  options: { width?: number; height?: number } = {},
): MissionWorkspaceModel {
  const next = cloneModel(model);
  if (next.mode === "detail") return moveMissionDetailSelection(next, snapshot, action, options);
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
  snapshot: Pick<MissionWorkspaceSnapshot, "board" | "history" | "detail">,
  mode: MissionWorkspaceMode,
  options: { width?: number; height?: number } = {},
): MissionWorkspaceModel {
  return reconcileMissionWorkspaceModel({ ...cloneModel(model), mode }, snapshot, options);
}

export function cycleMissionDensity(
  model: MissionWorkspaceModel,
  snapshot: Pick<MissionWorkspaceSnapshot, "board" | "history" | "detail"> | null,
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
  snapshot: Pick<MissionWorkspaceSnapshot, "board" | "history" | "detail">,
  target: MissionBoardColumn | "history" | MissionDetailSection,
  delta: number,
  options: { width?: number; height?: number } = {},
): MissionWorkspaceModel {
  const next = cloneModel(model);
  if (isDetailSection(target)) next.detailScroll[target] += delta;
  else if (target === "history") next.historyScroll += delta;
  else next.columnScroll[target] += delta;
  return clampMissionWorkspaceModel(next, snapshot, options);
}

export function applyMissionWorkspaceHit(
  model: MissionWorkspaceModel,
  snapshot: Pick<MissionWorkspaceSnapshot, "board" | "history" | "detail">,
  hit: Exclude<MissionWorkspaceHit, { kind: "refresh" } | null>,
  options: { width?: number; height?: number } = {},
): MissionWorkspaceModel {
  if (hit.kind === "mode") return setMissionWorkspaceMode(model, snapshot, hit.mode, options);
  if (hit.kind === "density") return cycleMissionDensity(model, snapshot, options);
  if (hit.kind === "detail-section")
    return clampMissionWorkspaceModel(
      { ...cloneModel(model), detailSection: hit.section },
      snapshot,
      options,
    );
  if (hit.kind === "detail-row") {
    const next = cloneModel(model);
    if (hit.section === "tasks") next.selectedTaskId = hit.id;
    return clampMissionWorkspaceModel(next, snapshot, options);
  }
  if (hit.kind === "deep-link") return model;
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

export function openMissionDetail(
  model: MissionWorkspaceModel,
  snapshot: Pick<MissionWorkspaceSnapshot, "board" | "history" | "detail">,
  options: { persistedTaskId?: string | null; width?: number; height?: number } = {},
): MissionWorkspaceModel {
  if (!model.selectedMissionId) return model;
  return reconcileMissionWorkspaceModel(
    {
      ...cloneModel(model),
      mode: "detail",
      detailReturnMode: model.mode === "history" ? "history" : "board",
      selectedTaskId: options.persistedTaskId ?? model.selectedTaskId,
    },
    snapshot,
    options,
  );
}

export function closeMissionDetail(model: MissionWorkspaceModel): MissionWorkspaceModel {
  const next = cloneModel(model);
  if (next.mode === "detail") next.mode = next.detailReturnMode;
  return next;
}

export function setMissionDetailSection(
  model: MissionWorkspaceModel,
  snapshot: Pick<MissionWorkspaceSnapshot, "board" | "history" | "detail">,
  section: MissionDetailSection,
  options: { width?: number; height?: number } = {},
): MissionWorkspaceModel {
  return clampMissionWorkspaceModel(
    { ...cloneModel(model), detailSection: section },
    snapshot,
    options,
  );
}

export function cycleMissionDetailSection(
  model: MissionWorkspaceModel,
  snapshot: Pick<MissionWorkspaceSnapshot, "board" | "history" | "detail">,
  direction: -1 | 1,
  options: { width?: number; height?: number } = {},
): MissionWorkspaceModel {
  const index = MISSION_DETAIL_SECTIONS.indexOf(model.detailSection);
  const next =
    MISSION_DETAIL_SECTIONS[
      (index + direction + MISSION_DETAIL_SECTIONS.length) % MISSION_DETAIL_SECTIONS.length
    ]!;
  return setMissionDetailSection(model, snapshot, next, options);
}

export function missionWorkspaceLayout(
  width: number,
  height: number,
  model: MissionWorkspaceModel,
  snapshot: Pick<MissionWorkspaceSnapshot, "board" | "history" | "detail"> | null,
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
  const detail = missionDetailLayout(safeWidth, safeHeight, model, snapshot?.detail ?? null);
  return {
    width: safeWidth,
    height: safeHeight,
    mode: model.mode,
    header,
    footer: {
      label: missionFooterLabel(safeWidth, model, presentation.quitHint),
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
    detail,
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
  if (layout.mode === "history") {
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
  }
  if (layout.mode === "detail") {
    for (const section of layout.detail.sections) {
      if (x >= section.start && x < section.start + section.width && y === section.row) {
        return section.section ? { kind: "detail-section", section: section.section } : null;
      }
    }
    for (const link of layout.detail.links) {
      if (x >= link.start && x < link.start + link.width && y === link.row) {
        return link.link ? { kind: "deep-link", link: link.link } : null;
      }
    }
    for (const row of layout.detail.rows) {
      if (x >= row.x && x < row.x + row.width && y >= row.y && y < row.y + row.height) {
        if (row.kind === "context") return null;
        return {
          kind: "detail-row",
          section: row.kind,
          id: row.id,
          index: row.index,
          hoverKey: row.hoverKey,
        };
      }
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

export function missionDetailContextLines(detail: MissionDetailView, width: number): string[] {
  const mission = detail.mission;
  const lines = [
    mission.title,
    `${mission.status} · ${detail.progress.done}/${detail.progress.total} tasks · ${formatDuration(mission.durationMs)}`,
    mission.summary,
  ];
  if (mission.labels.length > 0) lines.push(`# ${mission.labels.join(", ")}`);
  if (mission.blockedBy.length > 0) lines.push(`blocked by ${mission.blockedBy.join(", ")}`);
  if (mission.latestAttempt)
    lines.push(`latest ${mission.latestAttempt.agent}/${mission.latestAttempt.harness}`);
  const proof = proofSignal(mission.proofSummary);
  if (proof) lines.push(proof);
  return lines.map((line) => clipTerminal(line, width));
}

export function missionDetailTaskLines(
  task: TaskCardView,
  density: MissionWorkspaceDensity,
  width: number,
): string[] {
  const lines = [
    `${task.title}`,
    `${task.column} · ${task.status} · p${task.priority}${task.assignee ? ` · ${task.assignee}` : ""}`,
  ];
  if (density !== "compact") {
    if (task.dependencies.length > 0) lines.push(`depends ${task.dependencies.join(", ")}`);
    if (task.blockedBy.length > 0) lines.push(`blocked by ${task.blockedBy.join(", ")}`);
    if (task.latestAttempt)
      lines.push(
        `attempt ${task.latestAttempt.agent}/${task.latestAttempt.harness}${task.latestAttempt.model ? `/${task.latestAttempt.model}` : ""}`,
      );
    const proof = proofSignal(task.proofSummary);
    if (proof) lines.push(proof);
  }
  if (density === "detailed")
    lines.push(`task ${task.id} · duration ${formatDuration(task.durationMs)}`);
  return lines.slice(0, missionDetailRowHeight(density)).map((line) => clipTerminal(line, width));
}

export function missionDetailTimelineLines(entry: MissionTimelineEntry, width: number): string[] {
  const refs = [
    entry.taskId ? `task ${entry.taskId}` : "",
    entry.attemptId ? `attempt ${entry.attemptId}` : "",
    entry.proofId ? `proof ${entry.proofId}` : "",
  ].filter(Boolean);
  return [
    `#${entry.sequence} ${entry.timestamp} · ${entry.label}`,
    `${entry.type} · ${entry.actor.type}:${entry.actor.id}${refs.length ? ` · ${refs.join(" · ")}` : ""}`,
    entry.reason ? `reason ${entry.reason}` : "",
  ]
    .filter(Boolean)
    .slice(0, 3)
    .map((line) => clipTerminal(line, width));
}

export function missionDetailAttemptLines(
  attempt: MissionAttemptSummary,
  density: MissionWorkspaceDensity,
  width: number,
): string[] {
  const lines = [
    `${attempt.status}${attempt.outcome ? `/${attempt.outcome}` : ""} · task ${attempt.taskId}`,
    `${attempt.agent}/${attempt.harness}${attempt.model ? ` · ${attempt.model}` : ""} · ${formatDuration(attempt.durationMs)}`,
  ];
  if (density !== "compact") {
    if (attempt.session) lines.push(`session ${attempt.session}`);
    if (attempt.terminal) lines.push(`pane ${attempt.terminal}`);
    if (attempt.worktree) lines.push(`worktree ${attempt.worktree}`);
    if (attempt.proofIds.length > 0) lines.push(`${attempt.proofIds.length} proof`);
  }
  return lines.slice(0, missionDetailRowHeight(density)).map((line) => clipTerminal(line, width));
}

export function missionDetailProofLines(
  detail: MissionDetailView,
  density: MissionWorkspaceDensity,
  width: number,
): string[] {
  const proof = detail.proofSummary;
  const lines = [
    proof.hasProof ? `${proof.proofIds.length} proof item(s)` : "no proof recorded",
    proof.noProofReasons.length ? `no-proof ${proof.noProofReasons.join(", ")}` : "",
    proof.notesCount > 0 ? `${proof.notesCount} note(s)` : "",
    proof.tests.total > 0 ? `tests ${proof.tests.passed}/${proof.tests.total}` : "",
    proof.commits.length > 0 ? `commits ${proof.commits.join(", ")}` : "",
    proof.diff.filesChanged > 0
      ? `diff ${proof.diff.filesChanged} files +${proof.diff.insertions}/-${proof.diff.deletions}`
      : "",
    proof.diff.summaries.length > 0 ? `diff ${proof.diff.summaries.join(", ")}` : "",
    proof.prs.length > 0
      ? `PR ${proof.prs.map((pr) => pr.number ?? pr.status ?? pr.url ?? "link").join(", ")}`
      : "",
    proof.artifacts.length > 0
      ? `artifacts ${proof.artifacts.map((artifact) => artifact.name).join(", ")}`
      : "",
  ].filter(Boolean);
  return lines.slice(0, missionDetailRowHeight(density)).map((line) => clipTerminal(line, width));
}

export function resolveMissionDeepLink(
  kind: MissionDeepLinkKind,
  detail: MissionDetailView | null,
  model: Pick<MissionWorkspaceModel, "selectedTaskId">,
  options: {
    projectRoot: string;
    views: readonly HostedPanelView[];
    resolveProjectPath: (projectRoot: string, path: string | null) => string | null;
  },
): MissionDeepLinkResolution {
  const label = kind === "terminal" ? "t terminal" : kind === "files" ? "f files" : "d diff";
  if (!detail) return { available: false, kind, label, reason: "mission detail is not loaded" };
  const tasks = flattenedTasks(detail);
  const task = tasks.length > 0 ? selectedDetailTask(detail, model.selectedTaskId) : null;
  const attempt = task
    ? task.latestAttempt
    : (detail.mission.latestAttempt ?? detail.attempts[0] ?? null);
  if (kind === "terminal") {
    const view = findFirstHostedViewForPanel(options.views, "terminals");
    if (!view) return { available: false, kind, label, reason: "no configured Terminals view" };
    if (!attempt?.session)
      return { available: false, kind, label, reason: "selected task has no terminal session ref" };
    return {
      available: true,
      kind,
      label,
      intent: {
        kind,
        session: attempt.session,
        paneId: attempt.terminal ?? null,
        viewId: view.id,
      },
    };
  }
  if (kind === "files") {
    const view = findFirstHostedViewForPanel(options.views, "files");
    if (!view) return { available: false, kind, label, reason: "no configured Files view" };
    const artifactPath = safeProjectedPath(
      task
        ? firstProjectedFilePath(task.proofSummary)
        : firstProjectedFilePath(detail.mission.proofSummary),
      options,
    );
    const fallbackPath = safeProjectedPath(task?.refs.worktree ?? attempt?.worktree, options);
    const path = artifactPath ?? fallbackPath;
    if (!path) return { available: false, kind, label, reason: "no safe in-project file ref" };
    return {
      available: true,
      kind,
      label,
      intent: {
        kind,
        path,
        viewId: view.id,
        mode: artifactPath ? "open" : "reveal",
      },
    };
  }
  const view = findFirstHostedViewForPanel(options.views, "diff");
  if (!view) return { available: false, kind, label, reason: "no configured Diff view" };
  const path =
    safeProjectedPath(task?.refs.worktree ?? attempt?.worktree, options) ??
    safeProjectedPath(
      task
        ? firstProjectedFilePath(task.proofSummary)
        : firstProjectedFilePath(detail.mission.proofSummary),
      options,
    );
  if (!path) return { available: false, kind, label, reason: "no safe in-project diff ref" };
  return { available: true, kind, label, intent: { kind, path, viewId: view.id } };
}

export function missionTmuxPreflightCommands(
  intent: Extract<MissionDeepLinkIntent, { kind: "terminal" }>,
): MissionTmuxPreflightCommand[] {
  const commands: MissionTmuxPreflightCommand[] = [
    { kind: "session", file: "tmux", args: ["has-session", "-t", `=${intent.session}`] },
  ];
  if (intent.paneId) {
    commands.push({
      kind: "pane",
      file: "tmux",
      args: ["display-message", "-p", "-t", intent.paneId, "#{session_name}\t#{pane_id}"],
    });
  }
  return commands;
}

export function missionTmuxPanePreflightMatches(
  output: string,
  session: string,
  paneId: string,
): boolean {
  return output.trimEnd() === `${session}\t${paneId}`;
}

export function selectedDetailTask(
  detail: MissionDetailView | null,
  taskId: string | null | undefined,
): TaskCardView | null {
  if (!detail) return null;
  return (
    flattenedTasks(detail).find((task) => task.id === taskId) ?? flattenedTasks(detail)[0] ?? null
  );
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
): { selectedMissionId: string | null; selectedTaskId: string | null } {
  return missionsSelection(state, viewId);
}

export function workspaceStateWithMissionSelection(
  state: WorkspaceUiStateV1,
  viewId: string,
  missionId: string | null,
  taskId: string | null = null,
): WorkspaceUiStateV1 {
  return setMissionsSelection(state, viewId, missionId, taskId);
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

function projectDetailOrNull(
  state: Parameters<typeof projectMissionDetail>[0],
  history: Parameters<typeof projectMissionDetail>[1],
  missionId: MissionCardView["id"],
): MissionDetailView | null {
  try {
    return projectMissionDetail(state, history, missionId);
  } catch (error) {
    if (error instanceof MissionProjectionError && error.projectionCode === "MISSION_NOT_FOUND") {
      return null;
    }
    throw error;
  }
}

function detached<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function emptyScrolls(): Record<MissionBoardColumn, number> {
  return { planned: 0, running: 0, blocked: 0, review: 0, done: 0 };
}

function emptyDetailScrolls(): Record<MissionDetailSection, number> {
  return { tasks: 0, timeline: 0, attempts: 0, proof: 0 };
}

function cloneModel(model: MissionWorkspaceModel): MissionWorkspaceModel {
  return {
    ...model,
    columnScroll: { ...model.columnScroll },
    detailScroll: { ...model.detailScroll },
  };
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

function missionExists(
  snapshot: Pick<MissionWorkspaceSnapshot, "board" | "history">,
  missionId: string | null | undefined,
): boolean {
  if (!missionId) return false;
  return (
    !!findMissionInBoard(snapshot.board, missionId) ||
    snapshot.history.some((entry) => entry.mission.id === missionId)
  );
}

function selectHistoryMission(
  history: readonly MissionHistorySummary[],
  missionId: string | null | undefined,
): string | null {
  if (missionId && history.some((entry) => entry.mission.id === missionId)) return missionId;
  return history[0]?.mission.id ?? null;
}

function selectDetailTask(
  detail: MissionDetailView | null,
  taskId: string | null | undefined,
): string | null {
  if (!detail) return taskId ?? null;
  const tasks = flattenedTasks(detail);
  if (taskId && tasks.some((task) => task.id === taskId)) return taskId;
  return tasks[0]?.id ?? null;
}

function flattenedTasks(detail: MissionDetailView): TaskCardView[] {
  return MISSION_BOARD_COLUMNS.flatMap((column) => detail.taskBoard.columns[column]);
}

function isDetailSection(value: unknown): value is MissionDetailSection {
  return value === "tasks" || value === "timeline" || value === "attempts" || value === "proof";
}

function detailSectionItems(
  detail: MissionDetailView | null,
  section: MissionDetailSection,
): readonly unknown[] {
  if (!detail) return [];
  if (section === "tasks") return flattenedTasks(detail);
  if (section === "timeline") return detail.timeline;
  if (section === "attempts") return detail.attempts;
  return [detail.proofSummary];
}

function firstProjectedFilePath(proof: MissionProofSummary): string | null {
  return proof.artifacts.find((artifact) => isPlainRelativePath(artifact.uri))?.uri ?? null;
}

function safeProjectedPath(
  rawPath: string | null | undefined,
  options: {
    projectRoot: string;
    resolveProjectPath: (projectRoot: string, path: string | null) => string | null;
  },
): string | null {
  if (!rawPath || !isPlainRelativePath(rawPath)) return null;
  return options.resolveProjectPath(options.projectRoot, rawPath);
}

function isPlainRelativePath(value: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:/iu.test(value)) return false;
  if (value.startsWith("/") || value.startsWith("\\") || value.startsWith("~")) return false;
  if (value.includes("\0")) return false;
  return true;
}

function moveMissionDetailSelection(
  model: MissionWorkspaceModel,
  snapshot: Pick<MissionWorkspaceSnapshot, "board" | "history" | "detail">,
  action: "left" | "right" | "up" | "down" | "home" | "end",
  options: { width?: number; height?: number },
): MissionWorkspaceModel {
  let next = cloneModel(model);
  if (!snapshot.detail) return next;
  if (action === "left" || action === "right") {
    return cycleMissionDetailSection(next, snapshot, action === "left" ? -1 : 1, options);
  }
  const items = detailSectionItems(snapshot.detail, next.detailSection);
  if (next.detailSection === "tasks") {
    const tasks = flattenedTasks(snapshot.detail);
    const current = Math.max(
      0,
      tasks.findIndex((task) => task.id === next.selectedTaskId),
    );
    const last = Math.max(0, tasks.length - 1);
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
    next.selectedTaskId = tasks[index]?.id ?? null;
  } else {
    const rows = effectiveDetailItemCapacity(
      options.width,
      options.height,
      next.density,
      items.length,
    );
    const max = Math.max(0, items.length - 1);
    const current = next.detailScroll[next.detailSection];
    next.detailScroll[next.detailSection] =
      action === "up"
        ? Math.max(0, current - 1)
        : action === "down"
          ? Math.min(max, current + 1)
          : action === "home"
            ? 0
            : action === "end"
              ? Math.max(0, items.length - rows)
              : current;
  }
  next = clampMissionWorkspaceModel(next, snapshot, options);
  return next;
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

function missionDetailRowHeight(density: MissionWorkspaceDensity): number {
  if (density === "compact") return 2;
  if (density === "comfortable") return 4;
  return 5;
}

function detailRows(height: number | undefined): number {
  return Math.max(0, (height ?? 24) - MISSION_HEADER_ROWS - 1 - MISSION_FOOTER_ROWS);
}

function detailItemCapacity(height: number | undefined, density: MissionWorkspaceDensity): number {
  return Math.max(0, Math.floor(detailRows(height) / missionDetailRowHeight(density)));
}

function effectiveDetailItemCapacity(
  width: number | undefined,
  height: number | undefined,
  density: MissionWorkspaceDensity,
  itemCount: number,
): number {
  if ((width ?? 120) >= 72) return detailItemCapacity(height, density);
  if (itemCount <= 0) return 0;
  const availableRows = detailRows(height);
  const rowHeight = missionDetailRowHeight(density);
  const reservedContextRows = Math.min(2, availableRows, Math.max(0, availableRows - rowHeight));
  return Math.max(0, Math.floor((availableRows - reservedContextRows) / rowHeight));
}

function missionDetailLayout(
  width: number,
  height: number,
  model: MissionWorkspaceModel,
  detail: MissionDetailView | null,
): MissionDetailLayout {
  const wide = width >= 72;
  const contextWidth = wide ? Math.min(34, Math.max(24, Math.floor(width * 0.36))) : 0;
  const sectionX = wide ? contextWidth + 1 : 0;
  const sectionWidth = Math.max(1, width - sectionX);
  const availableRows = detailRows(height);
  const rawRows = detail
    ? detailRowsForSection(detail, model.detailSection, model.density, sectionWidth)
    : [];
  const itemCapacity = effectiveDetailItemCapacity(width, height, model.density, rawRows.length);
  const linkLabels = detailLinkLabels(width);
  const linkWidth =
    linkLabels.reduce((sum, entry) => sum + terminalDisplayWidth(entry.label), 0) +
    Math.max(0, linkLabels.length - 1);
  const linkStart = Math.max(0, width - linkWidth);
  const sectionLimit = Math.max(0, linkStart - 1);
  const sectionLabels = MISSION_DETAIL_SECTIONS.map((section, index) =>
    detailSectionLabel(section, index, model.detailSection, width),
  );
  const sectionSpans = boundedSpansForLabels(sectionLabels, 0, 1, sectionLimit);
  const sections = sectionLabels
    .map<MissionHeaderChip>((label, index) => ({
      kind: "section",
      label,
      section: MISSION_DETAIL_SECTIONS[index]!,
      row: 2,
      start: sectionSpans[index]?.start ?? 0,
      width: sectionSpans[index]?.width ?? 0,
    }))
    .filter((chip) => chip.width > 0 && chip.start + chip.width <= sectionLimit);
  const linkSpans = boundedSpansForLabels(
    linkLabels.map((entry) => entry.label),
    linkStart,
    1,
    width,
  );
  const links = linkLabels
    .map<MissionHeaderChip>((entry, index) => ({
      kind: "deep-link",
      label: entry.label,
      link: entry.link,
      row: 2,
      start: linkSpans[index]?.start ?? 0,
      width: linkSpans[index]?.width ?? 0,
    }))
    .filter((chip) => chip.width > 0 && chip.start + chip.width <= width);

  if (!detail) {
    return {
      wide,
      contextWidth,
      sectionX,
      sectionWidth,
      availableRows,
      itemCapacity,
      sections,
      links,
      contextRows: [],
      rows: [],
    };
  }

  const rowHeight = missionDetailRowHeight(model.density);
  const contextRows = missionDetailContextLines(detail, Math.max(1, contextWidth || width)).map(
    (line, index) => ({
      kind: "context" as const,
      id: `context-${index}`,
      index,
      hoverKey: index,
      x: 0,
      y: MISSION_HEADER_ROWS + 1 + index,
      width: Math.max(1, contextWidth || width),
      height: 1,
      lines: [line],
    }),
  );
  const start = Math.max(0, model.detailScroll[model.detailSection]);
  const maxNarrowContextRows =
    rawRows.length > 0
      ? itemCapacity > 0
        ? Math.max(0, availableRows - rowHeight)
        : availableRows
      : availableRows;
  const narrowContextRows = wide
    ? []
    : contextRows.slice(0, Math.min(2, availableRows, maxNarrowContextRows));
  const capacityAfterContext = itemCapacity;
  const rows = rawRows.slice(start, start + capacityAfterContext).map((row, visibleIndex) => ({
    ...row,
    index: start + visibleIndex,
    hoverKey: detailHoverKey(model.detailSection, start + visibleIndex),
    x: sectionX,
    y: MISSION_HEADER_ROWS + 1 + narrowContextRows.length + visibleIndex * rowHeight,
    width: sectionWidth,
    height: rowHeight,
  }));
  return {
    wide,
    contextWidth,
    sectionX,
    sectionWidth,
    availableRows,
    itemCapacity,
    sections,
    links,
    contextRows: wide ? contextRows.slice(0, availableRows) : [],
    rows: [...narrowContextRows, ...rows],
  };
}

function detailSectionLabel(
  section: MissionDetailSection,
  index: number,
  active: MissionDetailSection,
  width: number,
): string {
  const name =
    width < 72
      ? section === "tasks"
        ? "T"
        : section === "timeline"
          ? "L"
          : section === "attempts"
            ? "A"
            : "P"
      : section;
  return `${index + 1}${width < 72 ? "" : " "}${section === active ? `[${name}]` : name}`;
}

function detailLinkLabels(width: number): { link: MissionDeepLinkKind; label: string }[] {
  if (width < 36)
    return [
      { link: "terminal", label: "t" },
      { link: "files", label: "f" },
      { link: "diff", label: "d" },
    ];
  if (width < 72)
    return [
      { link: "terminal", label: "t term" },
      { link: "files", label: "f file" },
      { link: "diff", label: "d diff" },
    ];
  return [
    { link: "terminal", label: "t terminal" },
    { link: "files", label: "f files" },
    { link: "diff", label: "d diff" },
  ];
}

function detailRowsForSection(
  detail: MissionDetailView,
  section: MissionDetailSection,
  density: MissionWorkspaceDensity,
  width: number,
): Omit<MissionDetailRowLayout, "index" | "hoverKey" | "x" | "y" | "width" | "height">[] {
  if (section === "tasks") {
    return flattenedTasks(detail).map((task) => ({
      kind: "tasks",
      id: task.id,
      lines: missionDetailTaskLines(task, density, width),
    }));
  }
  if (section === "timeline") {
    return detail.timeline.map((entry) => ({
      kind: "timeline",
      id: `${entry.sequence}`,
      lines: missionDetailTimelineLines(entry, width),
    }));
  }
  if (section === "attempts") {
    return detail.attempts.map((attempt) => ({
      kind: "attempts",
      id: attempt.id,
      lines: missionDetailAttemptLines(attempt, density, width),
    }));
  }
  return [
    {
      kind: "proof",
      id: "proof",
      lines: missionDetailProofLines(detail, density, width),
    },
  ];
}

function detailHoverKey(section: MissionDetailSection, index: number): number {
  return index * MISSION_DETAIL_SECTIONS.length + MISSION_DETAIL_SECTIONS.indexOf(section);
}

function boundedSpansForLabels(
  labels: readonly string[],
  start: number,
  gap: number,
  endExclusive: number,
): { start: number; width: number }[] {
  let cursor = start;
  return labels.map((label) => {
    const width = terminalDisplayWidth(label);
    if (width <= 0 || cursor + width > endExclusive) return { start: cursor, width: 0 };
    const span = { start: cursor, width };
    cursor += width + gap;
    return span;
  });
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

function missionFooterLabel(
  width: number,
  model: Pick<MissionWorkspaceModel, "mode">,
  quitHint: string | null | undefined,
): string {
  const quit = quitHint?.trim() || "^q quit";
  const controls =
    model.mode === "detail"
      ? "esc back · tab sections · 1-4 section · arrows move · t/f/d open · r refresh"
      : "tab mode · arrows move · enter details · z density · r refresh";
  return fitTerminal(`${quit} · ${controls}`, width);
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
