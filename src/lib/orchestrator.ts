import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadMission, loadGoal, loadTasks, saveTask, loadTask, type Task } from "./task-store.ts";
import { recordTaskTime } from "./token-tracker.ts";
import {
  listSessionPanes,
  sendCommand,
  type PaneInfo,
} from "../widgets/lib/pane-comms.ts";
import { createWorktree, removeWorktree } from "./worktree.ts";

export interface OrchestratorConfig {
  session: string;
  dir: string;
  autoDispatch: boolean;
  stallTimeout: number;
  pollInterval: number;
  worktreeRoot: string;
  masterPane: string | null;
  beforeRun: string | null;
  afterRun: string | null;
  cleanupOnDone: boolean;
}

export interface OrchestratorState {
  lastActivity: Map<string, number>;
  previousTasks: Map<string, string>;
  claimedTasks: Set<string>;
  taskClaimTimes: Map<string, number>;
}

export function runHook(
  command: string,
  cwd: string,
): { ok: true } | { ok: false; error: string } {
  try {
    execSync(command, { cwd, timeout: 60000, stdio: "pipe" });
    return { ok: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

// Agent detection: Claude Code reports its version (e.g. "2.1.80") as currentCommand,
// not "claude". Detect agents by checking both the command name and the pane title.
const SHELL_COMMANDS = new Set(["zsh", "bash", "sh", "fish"]);
const AGENT_COMMANDS = new Set(["claude", "codex"]);
const SPINNERS = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠂⠒⠢⠆⠐⠠⠄◐◓◑◒|/\\-] /;
const VERSION_PATTERN = /^\d+\.\d+/;

export function isAgentPane(pane: PaneInfo): boolean {
  const cmd = pane.currentCommand.toLowerCase();
  if (AGENT_COMMANDS.has(cmd)) return true;
  // Claude Code shows its version string as the command (e.g. "2.1.80")
  if (VERSION_PATTERN.test(cmd) && /claude/i.test(pane.title)) return true;
  // Title-based detection
  if (/claude\s*code/i.test(pane.title)) return true;
  return false;
}

export function isAgentBusy(pane: PaneInfo): boolean {
  // Spinner chars in pane title indicate the agent is actively working
  return SPINNERS.test(pane.title);
}

export function isIdleForDispatch(pane: PaneInfo): boolean {
  const cmd = pane.currentCommand.toLowerCase();
  // Running a shell → idle
  if (SHELL_COMMANDS.has(cmd)) return true;
  // Agent pane that is NOT showing a spinner → idle (waiting for input)
  if (isAgentPane(pane) && !isAgentBusy(pane)) return true;
  return false;
}

function worktreePathForTask(config: OrchestratorConfig, task: Task): string | null {
  if (!task.branch) return null;
  // branch format: "task/001-slug" → worktree dir: "001-slug"
  const suffix = task.branch.replace(/^task\//, "");
  const wt = join(config.dir, config.worktreeRoot, suffix);
  return existsSync(wt) ? wt : null;
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
  // Find idle agent panes (not the master pane)
  const idleAgents = panes.filter((p) => {
    if (p.title === config.masterPane) return false;
    return isIdleForDispatch(p);
  });

  // Find unassigned todo tasks that haven't been claimed, sorted by priority
  const todoTasks = tasks
    .filter((t) => t.status === "todo" && !t.assignee && !state.claimedTasks.has(t.id))
    .sort((a, b) => a.priority - b.priority);

  for (const agent of idleAgents) {
    const task = todoTasks.shift();
    if (!task) break;

    // Claim lock: prevent double-dispatch across poll ticks
    state.claimedTasks.add(task.id);

    // Create git worktree
    const slug = slugify(task.title);
    const { path: worktreePath, branch } = createWorktree(
      config.dir,
      config.worktreeRoot,
      task.id,
      slug,
    );

    // Run before_run hook in worktree — abort dispatch for this task on failure
    if (config.beforeRun) {
      const result = runHook(config.beforeRun, worktreePath);
      if (!result.ok) {
        state.claimedTasks.delete(task.id);
        continue;
      }
    }

    // Assign task
    task.assignee = agent.title;
    task.status = "in-progress";
    task.branch = branch;
    task.updated = new Date().toISOString();
    saveTask(config.dir, task);

    // Record claim time for cost tracking
    state.taskClaimTimes.set(task.id, Date.now());

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
      // Record elapsed time for cost tracking
      const claimTime = state.taskClaimTimes.get(task.id);
      if (claimTime && task.assignee) {
        recordTaskTime(config.dir, task.assignee, task.id, Date.now() - claimTime);
      }
      state.taskClaimTimes.delete(task.id);

      // Clear claim lock
      state.claimedTasks.delete(task.id);

      const wt = worktreePathForTask(config, task);

      // Run after_run hook (failure is logged but ignored)
      if (config.afterRun && wt) {
        runHook(config.afterRun, wt);
      }

      // Cleanup worktree if configured
      if (config.cleanupOnDone && wt) {
        removeWorktree(config.dir, wt);
      }

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
    claimedTasks: new Set(),
    taskClaimTimes: new Map(),
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
