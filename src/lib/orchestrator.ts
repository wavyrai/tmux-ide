import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { loadMission, loadGoal, loadTasks, saveTask, loadTask, type Task } from "./task-store.ts";
import { recordTaskTime } from "./token-tracker.ts";
import {
  listSessionPanes,
  sendCommand,
  type PaneInfo,
} from "../widgets/lib/pane-comms.ts";
import { createWorktree, removeWorktree, validateWorktreePath } from "./worktree.ts";
import { appendEvent } from "./event-log.ts";

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
  maxConcurrentAgents: number;
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

  // Concurrency control: don't exceed max concurrent agents
  const maxConcurrent = config.maxConcurrentAgents ?? 10;
  const inProgressCount = tasks.filter((t) => t.status === "in-progress").length;
  const availableSlots = Math.max(0, maxConcurrent - inProgressCount);
  if (availableSlots === 0) return;

  // Find unassigned todo tasks that haven't been claimed, sorted by priority
  // Also include retry-eligible tasks (nextRetryAt in the past)
  const now = Date.now();
  const todoTasks = tasks
    .filter((t) => {
      // Skip if already claimed
      if (state.claimedTasks.has(t.id)) return false;
      // Regular todo tasks
      if (t.status === "todo" && !t.assignee) {
        // Check dependencies: all depends_on tasks must be done
        if (t.depends_on && t.depends_on.length > 0) {
          const allDepsDone = t.depends_on.every((depId) => {
            const dep = tasks.find((d) => d.id === depId);
            return dep?.status === "done";
          });
          if (!allDepsDone) return false;
        }
        return true;
      }
      // Retry-eligible tasks (failed with nextRetryAt in the past)
      if (t.nextRetryAt && t.retryCount < (t.maxRetries ?? 5)) {
        const retryTime = new Date(t.nextRetryAt).getTime();
        if (retryTime <= now) return true;
      }
      return false;
    })
    .sort((a, b) => a.priority - b.priority);

  const dispatchLimit = Math.min(availableSlots, idleAgents.length);
  for (let i = 0; i < dispatchLimit; i++) {
    const task = todoTasks.shift();
    if (!task) break;
    const agent = idleAgents[i]!;

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

    // Validate worktree path hasn't escaped root (symlink attacks, etc.)
    const pathCheck = validateWorktreePath(config.dir, config.worktreeRoot, worktreePath);
    if (!pathCheck.valid) {
      state.claimedTasks.delete(task.id);
      continue;
    }

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

    // Log dispatch event
    appendEvent(config.dir, {
      timestamp: new Date().toISOString(),
      type: "dispatch",
      taskId: task.id,
      agent: agent.title,
      message: `Dispatched "${task.title}" to ${agent.title}`,
    });

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
      appendEvent(config.dir, {
        timestamp: new Date().toISOString(),
        type: "stall",
        taskId: task.id,
        agent: task.assignee!,
        message: `Stall detected: "${task.title}" (${Math.floor(elapsed / 60000)}m)`,
      });
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

      appendEvent(config.dir, {
        timestamp: new Date().toISOString(),
        type: "completion",
        taskId: task.id,
        agent: task.assignee ?? undefined,
        message: `Completed "${task.title}" by ${task.assignee ?? "unknown"}`,
      });

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

export function reconcile(
  config: OrchestratorConfig,
  state: OrchestratorState,
  tasks: Task[],
  panes: PaneInfo[],
): void {
  const paneNames = new Set(panes.map((p) => p.title));

  for (const task of tasks.filter((t) => t.status === "in-progress" && t.assignee)) {
    // Check if the assigned agent's pane still exists
    if (!paneNames.has(task.assignee!)) {
      const agent = task.assignee!;
      // Agent crashed or pane was closed — release the task
      task.assignee = null;
      task.status = "todo";
      task.updated = new Date().toISOString();
      saveTask(config.dir, task);
      state.claimedTasks.delete(task.id);
      appendEvent(config.dir, {
        timestamp: new Date().toISOString(),
        type: "reconcile",
        taskId: task.id,
        agent,
        message: `Agent "${agent}" vanished, released "${task.title}"`,
      });
    }
  }
}

// --- Orchestrator state persistence ---

interface PersistedState {
  claimedTasks: string[];
  taskClaimTimes: Record<string, number>;
}

function stateFilePath(dir: string): string {
  return join(dir, ".tasks", "orchestrator-state.json");
}

export function saveOrchestratorState(dir: string, state: OrchestratorState): void {
  const tasksDir = join(dir, ".tasks");
  if (!existsSync(tasksDir)) mkdirSync(tasksDir, { recursive: true });
  const data: PersistedState = {
    claimedTasks: [...state.claimedTasks],
    taskClaimTimes: Object.fromEntries(state.taskClaimTimes),
  };
  writeFileSync(stateFilePath(dir), JSON.stringify(data, null, 2) + "\n");
}

export function loadOrchestratorState(dir: string, state: OrchestratorState): void {
  const path = stateFilePath(dir);
  if (!existsSync(path)) return;
  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as PersistedState;
    if (Array.isArray(data.claimedTasks)) {
      for (const id of data.claimedTasks) state.claimedTasks.add(id);
    }
    if (data.taskClaimTimes && typeof data.taskClaimTimes === "object") {
      for (const [id, time] of Object.entries(data.taskClaimTimes)) {
        state.taskClaimTimes.set(id, time);
      }
    }
  } catch {
    // Corrupted state file — start fresh
  }
}

export function gracefulShutdown(
  config: OrchestratorConfig,
  state: OrchestratorState,
): void {
  // Release all in-progress tasks back to todo
  const tasks = loadTasks(config.dir);
  for (const task of tasks) {
    if (task.status === "in-progress" && task.assignee) {
      task.assignee = null;
      task.status = "todo";
      task.updated = new Date().toISOString();
      saveTask(config.dir, task);

      // Optionally clean worktrees
      if (config.cleanupOnDone) {
        const wt = worktreePathForTask(config, task);
        if (wt) removeWorktree(config.dir, wt);
      }
    }
  }

  // Persist state for resume
  saveOrchestratorState(config.dir, state);
}

/** Apply hot-reloadable fields from a partial config onto a live config. */
export function reloadConfig(
  target: OrchestratorConfig,
  patch: Partial<
    Pick<
      OrchestratorConfig,
      | "pollInterval"
      | "stallTimeout"
      | "maxConcurrentAgents"
      | "autoDispatch"
      | "cleanupOnDone"
      | "beforeRun"
      | "afterRun"
    >
  >,
): void {
  if (patch.pollInterval !== undefined) target.pollInterval = patch.pollInterval;
  if (patch.stallTimeout !== undefined) target.stallTimeout = patch.stallTimeout;
  if (patch.maxConcurrentAgents !== undefined) target.maxConcurrentAgents = patch.maxConcurrentAgents;
  if (patch.autoDispatch !== undefined) target.autoDispatch = patch.autoDispatch;
  if (patch.cleanupOnDone !== undefined) target.cleanupOnDone = patch.cleanupOnDone;
  if (patch.beforeRun !== undefined) target.beforeRun = patch.beforeRun;
  if (patch.afterRun !== undefined) target.afterRun = patch.afterRun;
}

export function createOrchestrator(initialConfig: OrchestratorConfig): () => void {
  // Mutable config — reloadConfig updates fields between ticks
  const config: OrchestratorConfig = { ...initialConfig };

  const state: OrchestratorState = {
    lastActivity: new Map(),
    previousTasks: new Map(),
    claimedTasks: new Set(),
    taskClaimTimes: new Map(),
  };

  // Load persisted state from previous run
  loadOrchestratorState(config.dir, state);

  // Initialize previous state
  for (const task of loadTasks(config.dir)) {
    state.previousTasks.set(task.id, task.status);
  }

  function tick(): void {
    const tasks = loadTasks(config.dir);
    const panes = listSessionPanes(config.session);

    // 1. Reconcile: detect crashed agents, unassign their tasks
    reconcile(config, state, tasks, panes);

    // 2. Auto-dispatch: assign todo/retry tasks to idle agents
    if (config.autoDispatch) {
      dispatch(config, state, tasks, panes);
    }

    // 3. Detect stalls: nudge agents that haven't produced output
    detectStalls(config, state, tasks, panes);

    // 4. Detect completions: notify master, run hooks, cleanup
    detectCompletions(config, state, tasks, panes);

    // Update previous state
    for (const task of tasks) {
      state.previousTasks.set(task.id, task.status);
    }
  }

  let interval = setInterval(tick, config.pollInterval);

  // Watch ide.yml for config changes — apply new settings without restart
  let watcher: FSWatcher | null = null;
  const configPath = join(config.dir, "ide.yml");
  if (existsSync(configPath)) {
    let debounce: ReturnType<typeof setTimeout> | null = null;
    watcher = watch(configPath, () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        try {
          const yaml = require("js-yaml") as { load: (s: string) => unknown };
          const raw = readFileSync(configPath, "utf-8");
          const parsed = yaml.load(raw) as Record<string, unknown>;
          const orch = (parsed.orchestrator ?? {}) as Record<string, unknown>;

          const oldPollInterval = config.pollInterval;

          reloadConfig(config, {
            pollInterval: (orch.poll_interval as number | undefined) ?? config.pollInterval,
            stallTimeout: (orch.stall_timeout as number | undefined) ?? config.stallTimeout,
            maxConcurrentAgents: (orch.max_concurrent_agents as number | undefined) ?? config.maxConcurrentAgents,
            autoDispatch: (orch.auto_dispatch as boolean | undefined) ?? config.autoDispatch,
            cleanupOnDone: (orch.cleanup_on_done as boolean | undefined) ?? config.cleanupOnDone,
            beforeRun: (orch.before_run as string | undefined) ?? config.beforeRun,
            afterRun: (orch.after_run as string | undefined) ?? config.afterRun,
          });

          // Restart interval if pollInterval changed
          if (config.pollInterval !== oldPollInterval) {
            clearInterval(interval);
            interval = setInterval(tick, config.pollInterval);
          }
        } catch {
          // Config file might be mid-write or invalid — ignore
        }
      }, 300);
    });
  }

  // Graceful shutdown on SIGTERM/SIGINT
  function onSignal() {
    clearInterval(interval);
    if (watcher) watcher.close();
    gracefulShutdown(config, state);
    process.exit(0);
  }

  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  return () => {
    clearInterval(interval);
    if (watcher) watcher.close();
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
  };
}
