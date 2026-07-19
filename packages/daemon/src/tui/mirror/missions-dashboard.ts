import type {
  MissionAttemptSummary,
  MissionCardView,
  MissionDetailView,
  MissionHistorySummary,
  TaskCardView,
} from "@tmux-ide/contracts";

import type { AgentRowInput } from "./agent-rows.ts";
import { agentDisplayKind } from "./agent-rows.ts";
import {
  MISSION_BOARD_COLUMNS,
  MISSION_COLUMN_GAP,
  MISSION_MIN_COLUMN_WIDTH,
  clipTerminal,
  missionWorkspaceHitTest,
  missionWorkspaceLayout,
  type MissionWorkspaceHit,
  type MissionWorkspaceLayout,
  type MissionWorkspaceModel,
  type MissionWorkspacePresentationOptions,
  type MissionWorkspaceSnapshot,
} from "./missions-workspace.ts";
import { terminalDisplayWidth } from "./panel-host.ts";

export const MISSION_DASHBOARD_INSPECTOR_GAP = 1;
export const MISSION_DASHBOARD_COMPACT_INSPECTOR_WIDTH = 24;
export const MISSION_DASHBOARD_WIDE_INSPECTOR_MIN_WIDTH = 34;
export const MISSION_DASHBOARD_WIDE_INSPECTOR_MAX_WIDTH = 46;
export const MISSION_DASHBOARD_MEDIUM_MIN_WIDTH =
  MISSION_MIN_COLUMN_WIDTH * 3 +
  MISSION_COLUMN_GAP * 2 +
  MISSION_DASHBOARD_INSPECTOR_GAP +
  MISSION_DASHBOARD_COMPACT_INSPECTOR_WIDTH;
export const MISSION_DASHBOARD_WIDE_MIN_WIDTH =
  MISSION_MIN_COLUMN_WIDTH * MISSION_BOARD_COLUMNS.length +
  MISSION_COLUMN_GAP * (MISSION_BOARD_COLUMNS.length - 1) +
  MISSION_DASHBOARD_INSPECTOR_GAP +
  MISSION_DASHBOARD_WIDE_INSPECTOR_MIN_WIDTH;

export type MissionDashboardVariant = "narrow" | "medium" | "wide";

export interface MissionDashboardProjection {
  width: number;
  height: number;
  variant: MissionDashboardVariant;
  main: MissionDashboardRegion;
  inspector: MissionDashboardInspector | null;
}

export interface MissionDashboardRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  layout: MissionWorkspaceLayout;
}

export interface MissionDashboardInspector {
  x: number;
  y: number;
  width: number;
  height: number;
  variant: Exclude<MissionDashboardVariant, "narrow">;
  borderRows: number;
  titleRows: number;
  bodyRows: number;
  title: string;
  rows: MissionDashboardInspectorRow[];
  agents: MissionDashboardAgentContext[];
}

export interface MissionDashboardInspectorRow {
  key: string;
  label: string;
  value: string;
  emphasis?: boolean;
}

export interface MissionDashboardAgentContext {
  key: string;
  rank: "pane" | "session" | "kind";
  display: string;
  state: string;
  context: string;
}

export interface MissionDashboardProjectionOptions extends MissionWorkspacePresentationOptions {
  agents?: readonly AgentRowInput[];
}

export function missionDashboardProjection(
  width: number,
  height: number,
  model: MissionWorkspaceModel,
  snapshot: MissionWorkspaceSnapshot | null,
  options: MissionDashboardProjectionOptions = {},
): MissionDashboardProjection {
  const {
    width: safeWidth,
    height: safeHeight,
    mainWidth,
    inspectorWidth,
    variant,
  } = missionDashboardMainSize(width, height);
  const mainLayout = missionWorkspaceLayout(mainWidth, safeHeight, model, snapshot, options);
  const main: MissionDashboardRegion = {
    x: 0,
    y: 0,
    width: mainWidth,
    height: safeHeight,
    layout: mainLayout,
  };
  const inspector =
    inspectorWidth > 0
      ? missionDashboardInspector(
          mainWidth + MISSION_DASHBOARD_INSPECTOR_GAP,
          0,
          inspectorWidth,
          safeHeight,
          variant === "wide" ? "wide" : "medium",
          model,
          snapshot,
          options.agents ?? [],
        )
      : null;
  return { width: safeWidth, height: safeHeight, variant, main, inspector };
}

export function missionDashboardMainSize(
  width: number,
  height: number,
): {
  width: number;
  height: number;
  mainWidth: number;
  inspectorWidth: number;
  variant: MissionDashboardVariant;
} {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const variant = missionDashboardVariant(safeWidth);
  const inspectorWidth = missionDashboardInspectorWidth(safeWidth, variant);
  const mainWidth =
    inspectorWidth > 0
      ? Math.max(1, safeWidth - MISSION_DASHBOARD_INSPECTOR_GAP - inspectorWidth)
      : safeWidth;
  return { width: safeWidth, height: safeHeight, mainWidth, inspectorWidth, variant };
}

export function missionDashboardHitTest(
  projection: MissionDashboardProjection,
  x: number,
  y: number,
): MissionWorkspaceHit {
  if (
    x < projection.main.x ||
    x >= projection.main.x + projection.main.width ||
    y < projection.main.y ||
    y >= projection.main.y + projection.main.height
  ) {
    return null;
  }
  return missionWorkspaceHitTest(
    projection.main.layout,
    x - projection.main.x,
    y - projection.main.y,
  );
}

export function missionDashboardVariant(width: number): MissionDashboardVariant {
  if (width >= MISSION_DASHBOARD_WIDE_MIN_WIDTH) return "wide";
  if (width >= MISSION_DASHBOARD_MEDIUM_MIN_WIDTH) return "medium";
  return "narrow";
}

export function missionDashboardInspectorWidth(
  width: number,
  variant: MissionDashboardVariant,
): number {
  if (variant === "narrow") return 0;
  if (variant === "medium") return Math.min(MISSION_DASHBOARD_COMPACT_INSPECTOR_WIDTH, width - 1);
  return Math.max(
    MISSION_DASHBOARD_WIDE_INSPECTOR_MIN_WIDTH,
    Math.min(MISSION_DASHBOARD_WIDE_INSPECTOR_MAX_WIDTH, Math.floor(width * 0.24)),
  );
}

function missionDashboardInspector(
  x: number,
  y: number,
  width: number,
  height: number,
  variant: Exclude<MissionDashboardVariant, "narrow">,
  model: MissionWorkspaceModel,
  snapshot: MissionWorkspaceSnapshot | null,
  agents: readonly AgentRowInput[],
): MissionDashboardInspector {
  const selected = selectedMissionContext(model, snapshot);
  const task = selected.detail ? selectedTaskContext(model, selected.detail) : null;
  const attempts = selectedAttempts(selected.mission, selected.detail, task);
  const matchedAgents = relevantMissionAgents(attempts, agents, width - 2);
  const bodyWidth = Math.max(1, width - 2);
  const geometry = missionDashboardInspectorGeometry(width, height);
  const rows = inspectorRows(selected, task, matchedAgents, bodyWidth, variant).slice(
    0,
    geometry.bodyRows,
  );
  const title = selected.mission
    ? selected.mission.title
    : snapshot
      ? "No mission selected"
      : "Missions";
  return {
    x,
    y,
    width: Math.max(1, width),
    height: Math.max(1, height),
    variant,
    ...geometry,
    title: clipTerminal(title, bodyWidth),
    rows,
    agents: matchedAgents,
  };
}

export function missionDashboardInspectorGeometry(
  width: number,
  height: number,
): { borderRows: number; titleRows: number; bodyRows: number } {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const borderRows = safeWidth >= 2 && safeHeight >= 2 ? 2 : 0;
  const titleRows = safeHeight > borderRows ? 1 : 0;
  return {
    borderRows,
    titleRows,
    bodyRows: Math.max(0, safeHeight - borderRows - titleRows),
  };
}

function inspectorRows(
  selected: SelectedMissionContext,
  task: TaskCardView | null,
  agents: readonly MissionDashboardAgentContext[],
  width: number,
  variant: Exclude<MissionDashboardVariant, "narrow">,
): MissionDashboardInspectorRow[] {
  const rows: MissionDashboardInspectorRow[] = [];
  if (!selected.mission) {
    rows.push(row("state", "state", "select a mission", width, true));
    rows.push(row("hint", "hint", "board/history selection drives this panel", width));
    return rows;
  }
  const mission = selected.mission;
  rows.push(row("mission", variant === "wide" ? "mission" : "mis", mission.id, width, true));
  rows.push(row("status", "status", `${mission.status} · ${progressText(mission)}`, width));
  if (task) {
    rows.push(row("task", "task", `${task.id} · ${task.status} · p${task.priority}`, width, true));
  } else if (selected.detail && selected.detail.taskBoard.counts.total === 0) {
    rows.push(row("task", "task", "no tasks", width));
  } else if (selected.detail) {
    rows.push(row("task", "task", "no task selected", width));
  }
  const latest = task?.latestAttempt ?? mission.latestAttempt;
  if (latest) {
    rows.push(
      row(
        "attempt",
        "attempt",
        `${latest.status}${latest.agent ? ` · ${latest.agent}` : ""}${latest.model ? ` · ${latest.model}` : ""}`,
        width,
      ),
    );
    if (latest.session || latest.terminal)
      rows.push(
        row("terminal", "term", [latest.session, latest.terminal].filter(Boolean).join(" "), width),
      );
  }
  if (agents.length > 0) {
    rows.push(row("agents", "agents", `${agents.length} relevant`, width, true));
    for (const agent of agents.slice(0, variant === "wide" ? 4 : 2)) {
      rows.push(
        row(`agent-${agent.key}`, agent.state, `${agent.display} · ${agent.context}`, width),
      );
    }
  } else {
    rows.push(row("agents", "agents", "no matching live agent", width));
  }
  if (variant === "wide") {
    if (mission.summary) rows.push(row("summary", "summary", mission.summary, width));
    if (mission.blockedBy.length > 0)
      rows.push(row("blocked", "blocked", mission.blockedBy.join(", "), width));
    if (mission.proofSummary.hasProof)
      rows.push(row("proof", "proof", `${mission.proofSummary.proofIds.length} item(s)`, width));
    if (selected.detail && selected.detail.timeline.length > 0) {
      const last = selected.detail.timeline[selected.detail.timeline.length - 1]!;
      rows.push(row("event", "event", `#${last.sequence} ${last.label}`, width));
    }
  }
  return rows;
}

function row(
  key: string,
  label: string,
  value: string,
  width: number,
  emphasis = false,
): MissionDashboardInspectorRow {
  const prefix = `${label}: `;
  const valueWidth = Math.max(0, width - terminalDisplayWidth(prefix));
  return {
    key,
    label,
    value: clipTerminal(value, valueWidth),
    emphasis,
  };
}

interface SelectedMissionContext {
  mission: MissionCardView | null;
  detail: MissionDetailView | null;
  history: MissionHistorySummary | null;
}

function selectedMissionContext(
  model: MissionWorkspaceModel,
  snapshot: MissionWorkspaceSnapshot | null,
): SelectedMissionContext {
  if (!snapshot) return { mission: null, detail: null, history: null };
  const selectedId = model.selectedMissionId;
  const detail =
    snapshot.detail && (!selectedId || snapshot.detail.mission.id === selectedId)
      ? snapshot.detail
      : null;
  const boardMission = selectedId ? findMissionCard(snapshot, selectedId) : null;
  const history = selectedId
    ? (snapshot.history.find((entry) => entry.mission.id === selectedId) ?? null)
    : null;
  return {
    mission: detail?.mission ?? boardMission ?? history?.mission ?? null,
    detail,
    history,
  };
}

function selectedTaskContext(
  model: Pick<MissionWorkspaceModel, "selectedTaskId">,
  detail: MissionDetailView,
): TaskCardView | null {
  if (!model.selectedTaskId) return null;
  return (
    MISSION_BOARD_COLUMNS.flatMap((column) => detail.taskBoard.columns[column]).find(
      (task) => task.id === model.selectedTaskId,
    ) ?? null
  );
}

function selectedAttempts(
  mission: MissionCardView | null,
  detail: MissionDetailView | null,
  task: TaskCardView | null,
): MissionAttemptSummary[] {
  const attempts = new Map<string, MissionAttemptSummary>();
  if (task?.latestAttempt) attempts.set(task.latestAttempt.id, task.latestAttempt);
  if (detail) {
    for (const attempt of detail.attempts) {
      if (!task || attempt.taskId === task.id) attempts.set(attempt.id, attempt);
    }
  }
  if (attempts.size === 0 && mission?.latestAttempt) {
    attempts.set(mission.latestAttempt.id, mission.latestAttempt);
  }
  return [...attempts.values()];
}

function relevantMissionAgents(
  attempts: readonly MissionAttemptSummary[],
  agents: readonly AgentRowInput[],
  width: number,
): MissionDashboardAgentContext[] {
  const ranked = new Map<string, MissionDashboardAgentContext>();
  for (const attempt of attempts) {
    if (attempt.terminal) {
      for (const agent of agents.filter((item) => item.paneId === attempt.terminal)) {
        ranked.set(agentKey(agent), agentContext(agent, "pane", width));
      }
    }
  }
  for (const attempt of attempts) {
    if (attempt.session) {
      for (const agent of agents.filter((item) => item.session === attempt.session)) {
        const key = agentKey(agent);
        if (!ranked.has(key)) ranked.set(key, agentContext(agent, "session", width));
      }
    }
  }
  if (ranked.size > 0) return [...ranked.values()];
  for (const attempt of attempts) {
    const fallbackKind = attempt.agent;
    if (!fallbackKind) continue;
    for (const agent of agents.filter((item) => {
      const display = agentDisplayKind(item);
      return item.kind === fallbackKind || display === fallbackKind;
    })) {
      const key = agentKey(agent);
      if (!ranked.has(key)) ranked.set(key, agentContext(agent, "kind", width));
    }
  }
  return [...ranked.values()];
}

function agentContext(
  agent: AgentRowInput,
  rank: MissionDashboardAgentContext["rank"],
  width: number,
): MissionDashboardAgentContext {
  const display = agentDisplayKind(agent);
  const context =
    rank === "pane"
      ? `${agent.session} ${agent.paneId}`
      : rank === "session"
        ? `${agent.session} ${agent.paneId}`
        : `${agent.kind} ${agent.session}`;
  return {
    key: agentKey(agent),
    rank,
    display: clipTerminal(display, width),
    state: agent.state,
    context: clipTerminal(context, width),
  };
}

function agentKey(agent: AgentRowInput): string {
  return `${agent.session}:${agent.paneId}`;
}

function findMissionCard(snapshot: MissionWorkspaceSnapshot, id: string): MissionCardView | null {
  for (const column of MISSION_BOARD_COLUMNS) {
    const found = snapshot.board.columns[column].find((mission) => mission.id === id);
    if (found) return found;
  }
  return null;
}

function progressText(mission: Pick<MissionCardView, "progress">): string {
  return mission.progress.total > 0
    ? `${mission.progress.done}/${mission.progress.total}`
    : "no tasks";
}
