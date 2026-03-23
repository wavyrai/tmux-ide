import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  loadMission,
  loadGoals,
  loadTasks,
  saveTask,
  loadTask,
  type Mission,
  type Goal,
  type Task,
} from "../lib/task-store.ts";
import { listSessionPanes, type PaneInfo } from "../widgets/lib/pane-comms.ts";
import { isAgentPane, isAgentBusy, agentIdentifier } from "../lib/orchestrator.ts";

export interface SessionInfo {
  name: string;
  dir: string;
  mission: Mission | null;
  goals: Goal[];
  tasks: Task[];
  panes: PaneInfo[];
}

export interface SessionStats {
  totalTasks: number;
  doneTasks: number;
  agents: number;
  activeAgents: number;
}

export interface SessionOverview {
  name: string;
  dir: string;
  mission: Mission | null;
  stats: SessionStats;
  goals: { id: string; title: string; progress: number }[];
}

export interface AgentDetail {
  paneTitle: string;
  paneId: string;
  isBusy: boolean;
  taskTitle: string | null;
  taskId: string | null;
  elapsed: string;
}

export interface ProjectDetail {
  session: string;
  dir: string;
  mission: Mission | null;
  goals: Goal[];
  tasks: Task[];
  agents: AgentDetail[];
}

type TmuxRunner = (args: string[]) => string;

let _tmuxRunner: TmuxRunner = (args) =>
  execFileSync("tmux", args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

export function _setTmuxRunner(fn: TmuxRunner): () => void {
  const prev = _tmuxRunner;
  _tmuxRunner = fn;
  return () => {
    _tmuxRunner = prev;
  };
}

function tmuxSilent(args: string[]): string {
  try {
    return _tmuxRunner(args);
  } catch {
    return "";
  }
}

export function listTmuxSessions(): string[] {
  const raw = tmuxSilent(["list-sessions", "-F", "#{session_name}"]);
  if (!raw) return [];
  return raw.split("\n").filter(Boolean);
}

export function getSessionCwd(session: string): string {
  return tmuxSilent(["display-message", "-t", session, "-p", "#{pane_current_path}"]);
}

function formatElapsed(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export function discoverSessions(): SessionInfo[] {
  const sessionNames = listTmuxSessions();
  const results: SessionInfo[] = [];

  for (const name of sessionNames) {
    const dir = getSessionCwd(name);
    if (!dir) continue;

    const tasksDir = join(dir, ".tasks");
    const hasTasks = existsSync(tasksDir);

    const mission = hasTasks ? loadMission(dir) : null;
    const goals = hasTasks ? loadGoals(dir) : [];
    const tasks = hasTasks ? loadTasks(dir) : [];

    let panes: PaneInfo[] = [];
    try {
      panes = listSessionPanes(name);
    } catch {
      // session may have vanished
    }

    results.push({ name, dir, mission, goals, tasks, panes });
  }

  return results;
}

export function computeStats(info: SessionInfo): SessionStats {
  const agentPanes = info.panes.filter((p) => isAgentPane(p));
  const activeAgents = agentPanes.filter((p) => isAgentBusy(p)).length;

  return {
    totalTasks: info.tasks.length,
    doneTasks: info.tasks.filter((t) => t.status === "done").length,
    agents: agentPanes.length,
    activeAgents,
  };
}

export function computeGoalProgress(
  goals: Goal[],
  tasks: Task[],
): { id: string; title: string; progress: number }[] {
  return goals.map((g) => {
    const goalTasks = tasks.filter((t) => t.goal === g.id);
    const done = goalTasks.filter((t) => t.status === "done").length;
    const progress = goalTasks.length > 0 ? Math.round((done / goalTasks.length) * 100) : 0;
    return { id: g.id, title: g.title, progress };
  });
}

export function buildOverviews(sessions: SessionInfo[]): SessionOverview[] {
  return sessions.map((s) => ({
    name: s.name,
    dir: s.dir,
    mission: s.mission,
    stats: computeStats(s),
    goals: computeGoalProgress(s.goals, s.tasks),
  }));
}

export function buildProjectDetail(info: SessionInfo): ProjectDetail {
  const agents: AgentDetail[] = info.panes
    .filter((p) => isAgentPane(p))
    .map((pane) => {
      const name = agentIdentifier(pane);
      const assignedTask = info.tasks.find(
        (t) => t.assignee === name && t.status === "in-progress",
      );
      return {
        paneTitle: name,
        paneId: pane.id,
        isBusy: isAgentBusy(pane),
        taskTitle: assignedTask?.title ?? null,
        taskId: assignedTask?.id ?? null,
        elapsed: assignedTask ? formatElapsed(assignedTask.updated) : "",
      };
    });

  return {
    session: info.name,
    dir: info.dir,
    mission: info.mission,
    goals: info.goals,
    tasks: info.tasks,
    agents,
  };
}

export interface OrchestratorSnapshot {
  running: boolean;
  claimedCount: number;
  agents: AgentDetail[];
  inProgressCount: number;
  pendingCount: number;
}

export function buildOrchestratorSnapshot(info: SessionInfo): OrchestratorSnapshot {
  const agents: AgentDetail[] = info.panes
    .filter((p) => isAgentPane(p))
    .map((pane) => {
      const name = agentIdentifier(pane);
      const assignedTask = info.tasks.find(
        (t) => t.assignee === name && t.status === "in-progress",
      );
      return {
        paneTitle: name,
        paneId: pane.id,
        isBusy: isAgentBusy(pane),
        taskTitle: assignedTask?.title ?? null,
        taskId: assignedTask?.id ?? null,
        elapsed: assignedTask ? formatElapsed(assignedTask.updated) : "",
      };
    });

  return {
    running: agents.length > 0,
    claimedCount: info.tasks.filter((t) => t.status === "in-progress").length,
    agents,
    inProgressCount: info.tasks.filter((t) => t.status === "in-progress").length,
    pendingCount: info.tasks.filter((t) => t.status === "todo").length,
  };
}

export function updateTask(
  dir: string,
  taskId: string,
  fields: {
    status?: string;
    assignee?: string;
    title?: string;
    description?: string;
    priority?: number;
  },
): Task | null {
  const task = loadTask(dir, taskId);
  if (!task) return null;

  if (fields.status) {
    const validStatuses = ["todo", "in-progress", "review", "done"];
    if (!validStatuses.includes(fields.status)) return null;
    task.status = fields.status as Task["status"];
  }
  if (fields.assignee !== undefined) {
    task.assignee = fields.assignee || null;
  }
  if (fields.title !== undefined) {
    task.title = fields.title;
  }
  if (fields.description !== undefined) {
    task.description = fields.description;
  }
  if (fields.priority !== undefined) {
    task.priority = fields.priority;
  }
  task.updated = new Date().toISOString();
  saveTask(dir, task);
  return task;
}
