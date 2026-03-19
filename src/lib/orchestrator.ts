import { loadMission, loadGoal, loadTasks, saveTask, loadTask, type Task } from "./task-store.ts";
import {
  listSessionPanes,
  sendCommand,
  getPaneBusyStatus,
  type PaneInfo,
} from "../widgets/lib/pane-comms.ts";
import { createWorktree } from "./worktree.ts";

export interface OrchestratorConfig {
  session: string;
  dir: string;
  autoDispatch: boolean;
  stallTimeout: number;
  pollInterval: number;
  worktreeRoot: string;
  masterPane: string | null;
}

export interface OrchestratorState {
  lastActivity: Map<string, number>;
  previousTasks: Map<string, string>;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
}

export function buildTaskPrompt(
  dir: string,
  task: Task,
  worktreePath: string,
  branch: string,
): string {
  let prompt = "";

  const mission = loadMission(dir);
  if (mission) {
    prompt += `Mission: ${mission.title}\n`;
    if (mission.description) prompt += `${mission.description}\n`;
    prompt += "\n";
  }

  if (task.goal) {
    const goal = loadGoal(dir, task.goal);
    if (goal) {
      prompt += `Goal: ${goal.title}\n`;
      if (goal.acceptance) prompt += `Acceptance: ${goal.acceptance}\n`;
      prompt += "\n";
    }
  }

  prompt += `Your Task: ${task.title}\n`;
  if (task.description) prompt += `${task.description}\n`;
  prompt += `\nPriority: P${task.priority}\n`;
  if (task.tags?.length) prompt += `Tags: ${task.tags.join(", ")}\n`;
  prompt += `\nWorkspace: ${worktreePath}\n`;
  prompt += `Branch: ${branch}\n`;
  prompt += `\nWhen done, run:\n`;
  prompt += `  tmux-ide task done ${task.id} --proof "describe what you accomplished"\n`;

  return prompt;
}

export function dispatch(
  config: OrchestratorConfig,
  state: OrchestratorState,
  tasks: Task[],
  panes: PaneInfo[],
): void {
  // Find idle agent panes (running shell, not the master pane)
  const idleAgents = panes.filter((p) => {
    if (p.title === config.masterPane) return false;
    const status = getPaneBusyStatus(config.session, p.id);
    return status === "idle";
  });

  // Find unassigned todo tasks, sorted by priority
  const todoTasks = tasks
    .filter((t) => t.status === "todo" && !t.assignee)
    .sort((a, b) => a.priority - b.priority);

  for (const agent of idleAgents) {
    const task = todoTasks.shift();
    if (!task) break;

    // Create git worktree
    const slug = slugify(task.title);
    const { path: worktreePath, branch } = createWorktree(
      config.dir,
      config.worktreeRoot,
      task.id,
      slug,
    );

    // Claim task
    task.assignee = agent.title;
    task.status = "in-progress";
    task.branch = branch;
    task.updated = new Date().toISOString();
    saveTask(config.dir, task);

    // Build and send prompt
    const prompt = buildTaskPrompt(config.dir, task, worktreePath, branch);
    sendCommand(config.session, agent.id, prompt);

    // Track activity
    state.lastActivity.set(agent.id, Date.now());
  }
}

export function detectStalls(
  config: OrchestratorConfig,
  state: OrchestratorState,
  tasks: Task[],
  panes: PaneInfo[],
): void {
  const now = Date.now();
  for (const task of tasks.filter((t) => t.status === "in-progress" && t.assignee)) {
    const agentPane = panes.find((p) => p.title === task.assignee);
    if (!agentPane) continue;

    const lastSeen = state.lastActivity.get(agentPane.id) ?? now;
    const elapsed = now - lastSeen;

    if (elapsed > config.stallTimeout) {
      sendCommand(
        config.session,
        agentPane.id,
        `You've been working on "${task.title}" for ${Math.floor(elapsed / 60000)} minutes. ` +
          `If done, run: tmux-ide task done ${task.id} --proof "describe what you did". ` +
          `If stuck, run: tmux-ide task update ${task.id} --status review`,
      );
      state.lastActivity.set(agentPane.id, now);
    }
  }
}

export function detectCompletions(
  config: OrchestratorConfig,
  state: OrchestratorState,
  tasks: Task[],
  panes: PaneInfo[],
): void {
  for (const task of tasks) {
    const prev = state.previousTasks.get(task.id);
    if (prev === "in-progress" && task.status === "done") {
      if (config.masterPane) {
        const masterPaneInfo = panes.find((p) => p.title === config.masterPane);
        if (masterPaneInfo) {
          const proofStr = task.proof ? JSON.stringify(task.proof) : "no proof provided";
          sendCommand(
            config.session,
            masterPaneInfo.id,
            `Task completed: "${task.title}" by ${task.assignee}. ` +
              `Proof: ${proofStr}. ` +
              `Review and approve, or request changes.`,
          );
        }
      }
    }
  }
}

export function createOrchestrator(config: OrchestratorConfig): () => void {
  const state: OrchestratorState = {
    lastActivity: new Map(),
    previousTasks: new Map(),
  };

  // Initialize previous state
  for (const task of loadTasks(config.dir)) {
    state.previousTasks.set(task.id, task.status);
  }

  function tick(): void {
    const tasks = loadTasks(config.dir);
    const panes = listSessionPanes(config.session);

    if (config.autoDispatch) {
      dispatch(config, state, tasks, panes);
    }

    detectStalls(config, state, tasks, panes);
    detectCompletions(config, state, tasks, panes);

    // Update previous state
    for (const task of tasks) {
      state.previousTasks.set(task.id, task.status);
    }
  }

  const interval = setInterval(tick, config.pollInterval);
  return () => clearInterval(interval);
}
