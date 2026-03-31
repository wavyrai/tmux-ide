/**
 * Autonomous task orchestration engine.
 *
 * Runs as a background polling loop that coordinates agent workloads across
 * tmux panes. Core capabilities:
 *
 * - **Dispatch** — assigns unblocked todo tasks to idle agents, respecting
 *   dependency ordering, concurrency limits, and claim locks.
 * - **Stall detection** — nudges agents that exceed the configured timeout
 *   without producing output.
 * - **Completion handling** — records cost/time metrics, runs after-hooks,
 *   and notifies the master pane.
 * - **Retry with backoff** — re-dispatches failed tasks up to maxRetries,
 *   using nextRetryAt to schedule exponential backoff.
 * - **Reconciliation** — detects crashed or vanished agent panes and
 *   releases their in-progress tasks back to the queue.
 * - **Graceful shutdown** — on SIGTERM/SIGINT, releases all in-progress
 *   tasks and persists orchestrator state for resume on next startup.
 * - **Hot reload** — watches ide.yml for config changes and applies them
 *   without restarting the loop.
 *
 * @module orchestrator
 */
import { execSync, execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import {
  loadMission,
  loadGoal,
  loadGoals,
  loadTasks,
  saveTask,
  saveGoal,
  type Task,
  type Goal,
} from "./task-store.ts";
import { slugify } from "./slugify.ts";
import { recordTaskTime } from "./token-tracker.ts";
import { listSessionPanes, sendCommand, type PaneInfo } from "../widgets/lib/pane-comms.ts";
import { appendEvent } from "./event-log.ts";
import { loadSkill } from "./skill-registry.ts";

export interface OrchestratorConfig {
  session: string;
  dir: string;
  autoDispatch: boolean;
  stallTimeout: number;
  pollInterval: number;
  masterPane: string | null;
  beforeRun: string | null;
  afterRun: string | null;
  maxConcurrentAgents: number;
  dispatchMode: "tasks" | "goals";
  paneSpecialties: Map<string, string[]>;
}

export interface OrchestratorState {
  lastActivity: Map<string, number>;
  previousTasks: Map<string, string>;
  claimedTasks: Set<string>;
  taskClaimTimes: Map<string, number>;
}

export function runHook(command: string, cwd: string): { ok: true } | { ok: false; error: string } {
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
const SPINNERS = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠂⠒⠢⠆⠐⠠⠄◐◓◑◒✳|/\\-] /;
const VERSION_PATTERN = /^\d+\.\d+/;

// Strip spinner/status prefix from pane title to get stable name
export function normalizePaneTitle(title: string): string {
  return title.replace(SPINNERS, "").trim();
}

// French names for agents — fun, memorable, and stable across spinner changes
const AGENT_NAMES = [
  "François",
  "Amélie",
  "Louis",
  "Camille",
  "Marcel",
  "Colette",
  "Henri",
  "Margaux",
  "René",
  "Léonie",
  "Étienne",
  "Fleur",
  "Gaston",
  "Isabelle",
  "Jacques",
  "Lucienne",
  "Nicolas",
  "Odette",
  "Pierre",
  "Rosalie",
];

// Get a stable, memorable identifier for an agent pane
export function agentIdentifier(pane: PaneInfo): string {
  if (pane.name) return pane.name;
  return AGENT_NAMES[pane.index % AGENT_NAMES.length] ?? `Agent ${pane.index}`;
}

export function isAgentPane(pane: PaneInfo): boolean {
  const cmd = pane.currentCommand.toLowerCase();
  if (AGENT_COMMANDS.has(cmd)) return true;
  // Claude Code shows its version string as the command (e.g. "2.1.80")
  if (VERSION_PATTERN.test(cmd)) return true;
  // Title-based detection — check for Claude Code or French agent names
  if (/claude\s*code/i.test(pane.title)) return true;
  const name = normalizePaneTitle(pane.title);
  if (AGENT_NAMES.includes(name)) return true;
  return false;
}

export function isAgentBusy(pane: PaneInfo): boolean {
  // Spinner chars in pane title indicate the agent is actively working
  return SPINNERS.test(pane.title);
}

/**
 * Check if a pane is at the agent prompt (❯) by capturing the last line.
 * This is more reliable than title-based spinner detection since pane titles
 * can show stale spinners after the agent finishes.
 */
function isAtAgentPrompt(paneId: string): boolean {
  try {
    const lastLine = execFileSync("tmux", ["capture-pane", "-t", paneId, "-p", "-S", "-1"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return lastLine.includes("❯");
  } catch {
    return false;
  }
}

export function isIdleForDispatch(pane: PaneInfo): boolean {
  const cmd = pane.currentCommand.toLowerCase();
  // Running a shell → idle
  if (SHELL_COMMANDS.has(cmd)) return true;
  // Agent pane: check spinner first (fast), then fall back to prompt detection (reliable)
  if (isAgentPane(pane)) {
    if (!isAgentBusy(pane)) return true;
    // Spinner may be stale — check if agent is actually at the prompt
    return isAtAgentPrompt(pane.id);
  }
  return false;
}

export function buildTaskPrompt(
  dir: string,
  task: Task,
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

  if (task.specialty) {
    const skill = loadSkill(dir, task.specialty);
    if (skill?.body) {
      prompt += `Your Role: ${skill.name}\n`;
      prompt += `${skill.body}\n\n`;
    }
  }

  prompt += `Your Task: ${task.title}\n`;
  if (task.description) prompt += `${task.description}\n`;
  prompt += `\nPriority: P${task.priority}\n`;
  if (task.tags?.length) prompt += `Tags: ${task.tags.join(", ")}\n`;
  prompt += `\nWorkspace: ${dir}\n`;
  prompt += `\nWhen done:\n`;
  prompt += `  tmux-ide task done ${task.id} --proof "short summary of what you accomplished"\n`;

  // Prompt is written to a file (.tasks/dispatch/{id}.md), not pasted.
  // Keep readable multiline format for the agent.
  return prompt.trim();
}

export function dispatch(
  config: OrchestratorConfig,
  state: OrchestratorState,
  tasks: Task[],
  panes: PaneInfo[],
): void {
  // Find idle agent panes (not the master pane, not already assigned a task)
  const idleAgents = panes.filter((p) => {
    // Master pane check: use role when available, fall back to title
    if (p.role === "lead") return false;
    if (!p.role && config.masterPane && normalizePaneTitle(p.title) === config.masterPane)
      return false;
    if (!isIdleForDispatch(p)) return false;
    // Don't dispatch to a pane that already has an in-progress task assigned
    const name = agentIdentifier(p);
    const hasActiveTask = tasks.some(
      (t) => t.assignee === name && (t.status === "in-progress" || t.status === "review"),
    );
    if (hasActiveTask) return false;
    return true;
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
        // Skip if waiting for scheduled retry (nextRetryAt is in the future)
        if (t.nextRetryAt && new Date(t.nextRetryAt).getTime() > now) return false;
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

  const assignedAgents = new Set<string>();
  let dispatched = 0;
  for (const task of todoTasks) {
    if (dispatched >= availableSlots) break;
    const agent = findBestAgent(config, idleAgents, task, assignedAgents);
    if (!agent) continue; // no suitable agent — skip (specialist task waits)

    // Verify the target pane still exists before dispatch
    const currentPanes = listSessionPanes(config.session);
    if (!currentPanes.find((p) => p.id === agent.id)) {
      // Agent pane vanished — skip
      continue;
    }

    const agentName = agentIdentifier(agent);

    // Persist task as in-progress FIRST — prevents double-dispatch on crash
    task.status = "in-progress";
    task.assignee = agentName;
    task.nextRetryAt = null; // Clear retry schedule on dispatch
    task.updated = new Date().toISOString();
    saveTask(config.dir, task);

    // Claim lock: prevent double-dispatch across poll ticks
    state.claimedTasks.add(task.id);

    // Run before_run hook in project directory — abort dispatch for this task on failure
    if (config.beforeRun) {
      const result = runHook(config.beforeRun, config.dir);
      if (!result.ok) {
        task.status = "todo";
        task.assignee = null;
        task.updated = new Date().toISOString();
        saveTask(config.dir, task);
        state.claimedTasks.delete(task.id);
        continue;
      }
    }

    // Record claim time for cost tracking
    state.taskClaimTimes.set(task.id, Date.now());

    // Write the full prompt to a dispatch file and send a short command
    // telling the agent to read it. This avoids the paste preview problem
    // entirely — short commands (<200 chars) never trigger it.
    const prompt = buildTaskPrompt(config.dir, task);
    const dispatchDir = join(config.dir, ".tasks", "dispatch");
    if (!existsSync(dispatchDir)) mkdirSync(dispatchDir, { recursive: true });
    // Validate task ID to prevent path traversal
    if (!/^\d{3,}$/.test(task.id)) {
      task.status = "todo";
      task.assignee = null;
      task.updated = new Date().toISOString();
      saveTask(config.dir, task);
      state.claimedTasks.delete(task.id);
      continue;
    }
    const dispatchFile = join(dispatchDir, `${task.id}.md`);
    writeFileSync(dispatchFile, prompt);

    const shortCmd = `tmux-ide dispatch ${task.id}`;
    const sent = sendCommand(config.session, agent.id, shortCmd);

    if (!sent) {
      // Roll back: reset task to todo, remove claim
      task.status = "todo";
      task.assignee = null;
      task.updated = new Date().toISOString();
      saveTask(config.dir, task);
      state.claimedTasks.delete(task.id);
      state.taskClaimTimes.delete(task.id);

      appendEvent(config.dir, {
        timestamp: new Date().toISOString(),
        type: "error",
        taskId: task.id,
        agent: agent.title,
        message: `Failed to send command to ${agent.title} for task "${task.title}" — rolled back`,
      });
      continue;
    }

    // Log dispatch event
    appendEvent(config.dir, {
      timestamp: new Date().toISOString(),
      type: "dispatch",
      taskId: task.id,
      agent: agent.title,
      message: `Dispatched "${task.title}" to ${agent.title}`,
    });

    // Track agent assignment to prevent double-assignment
    assignedAgents.add(agent.id);
    dispatched++;

    // Track activity
    state.lastActivity.set(agent.id, Date.now());
  }
}

// --- Skill-based agent matching ---

function matchesSpecialty(specialty: string | null, agentSpecialties: string[]): boolean {
  if (!specialty) return true; // no specialty = any agent
  if (agentSpecialties.length === 0) return true; // no agent specialty = takes anything
  const tags = specialty.split(",").map((s) => s.trim().toLowerCase());
  return tags.some((tag) => agentSpecialties.includes(tag));
}

/**
 * Find the best available agent for a task based on specialty matching.
 *
 * Priority: specialist match > generalist (no specialties) > null.
 * Tasks with no specialty go to the first available agent.
 */
export function findBestAgent(
  config: OrchestratorConfig,
  idleAgents: PaneInfo[],
  task: Task,
  excludeIds: Set<string>,
): PaneInfo | null {
  const candidates = idleAgents.filter((p) => !excludeIds.has(p.id));
  if (candidates.length === 0) return null;

  // No specialty required — any idle agent works
  if (!task.specialty) return candidates[0] ?? null;

  // Prefer agents whose specialties match the task
  const specialist = candidates.find((p) => {
    const specs = getPaneSpecialties(config, p);
    return specs.length > 0 && matchesSpecialty(task.specialty, specs);
  });
  if (specialist) return specialist;

  // Fall back to generalist agents (no specialties defined)
  const generalist = candidates.find((p) => {
    const specs = getPaneSpecialties(config, p);
    return specs.length === 0;
  });
  return generalist ?? null;
}

// --- Goal-level dispatch (planner agents) ---

export function getPaneSpecialties(config: OrchestratorConfig, pane: PaneInfo): string[] {
  const key = pane.name ?? pane.title;
  return config.paneSpecialties.get(key) ?? [];
}

function isPlannerPane(config: OrchestratorConfig, pane: PaneInfo): boolean {
  const key = pane.name ?? pane.title;
  if (config.paneSpecialties.has(key)) return true;
  if (pane.role === "lead") return false;
  return isAgentPane(pane);
}


export function buildGoalPrompt(dir: string, goal: Goal, planner: PaneInfo): string {
  const mission = loadMission(dir);
  const name = agentIdentifier(planner);
  const specialtyLabel = goal.specialty ?? "general";

  let prompt = `You are ${name}, a ${specialtyLabel} planner.\n\n`;

  if (mission) {
    prompt += `Mission: ${mission.title}\n`;
    if (mission.description) prompt += `${mission.description}\n`;
    prompt += "\n";
  }

  prompt += `Your Goal: ${goal.title}\n`;
  if (goal.acceptance) prompt += `Acceptance Criteria: ${goal.acceptance}\n`;
  prompt += `Priority: P${goal.priority}\n\n`;

  prompt += `Instructions:\n`;
  prompt += `1. Read plans/MISSION.md for architectural context (if it exists)\n`;
  prompt += `2. Create your plan file: plans/goal-${goal.id}-${slugify(goal.title, 30)}.md\n`;
  prompt += `   Include: analysis, approach, task breakdown, risks\n`;
  prompt += `3. Create tasks for your goal:\n`;
  prompt += `   tmux-ide task create "task title" --goal ${goal.id} --priority N\n`;
  prompt += `4. Execute tasks using Claude Code subagents for parallel work\n`;
  prompt += `5. Update your plan file as tasks complete\n`;
  prompt += `6. Review all completed work for quality\n`;
  prompt += `7. When done: tmux-ide goal done ${goal.id} --proof "summary of what was accomplished"\n\n`;
  prompt += `You own this goal end-to-end. Plan it, execute it, deliver it.\n`;

  return prompt.trim();
}

export function dispatchGoals(
  config: OrchestratorConfig,
  state: OrchestratorState,
  goals: Goal[],
  tasks: Task[],
  panes: PaneInfo[],
): void {
  // Find idle planner panes (not the master pane, not already assigned)
  const idlePlanners = panes.filter((p) => {
    if (p.index === 0) return false;
    if (p.role === "lead") return false;
    if (!p.role && config.masterPane && normalizePaneTitle(p.title) === config.masterPane)
      return false;
    if (!isPlannerPane(config, p)) return false;
    if (!isIdleForDispatch(p)) return false;
    const name = agentIdentifier(p);
    const hasActiveGoal = goals.some((g) => g.assignee === name && g.status === "in-progress");
    if (hasActiveGoal) return false;
    return true;
  });

  // Find unassigned goals sorted by priority
  const todoGoals = goals
    .filter((g) => g.status === "todo" && !g.assignee)
    .sort((a, b) => a.priority - b.priority);

  for (const planner of idlePlanners) {
    const plannerSpecs = getPaneSpecialties(config, planner);

    // Find best matching goal
    const goal = todoGoals.find((g) => matchesSpecialty(g.specialty, plannerSpecs));
    if (!goal) continue;

    // Remove from candidates
    todoGoals.splice(todoGoals.indexOf(goal), 1);

    // Assign goal to planner
    goal.assignee = agentIdentifier(planner);
    goal.status = "in-progress";
    goal.updated = new Date().toISOString();
    saveGoal(config.dir, goal);

    // Write goal prompt to file and send short command
    const prompt = buildGoalPrompt(config.dir, goal, planner);
    const goalDispatchDir = join(config.dir, ".tasks", "dispatch");
    if (!existsSync(goalDispatchDir)) mkdirSync(goalDispatchDir, { recursive: true });
    const goalDispatchFile = join(goalDispatchDir, `goal-${goal.id}.md`);
    writeFileSync(goalDispatchFile, prompt);
    sendCommand(
      config.session,
      planner.id,
      `Read and execute the goal in .tasks/dispatch/goal-${goal.id}.md`,
    );

    // Log event
    appendEvent(config.dir, {
      timestamp: new Date().toISOString(),
      type: "dispatch",
      taskId: goal.id,
      agent: planner.title,
      message: `Dispatched goal "${goal.title}" to ${planner.title}`,
    });

    state.lastActivity.set(planner.id, Date.now());
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
    const agentPane = panes.find((p) => agentIdentifier(p) === task.assignee);
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

    // Task was explicitly marked as review while in-progress — treat as failure, schedule retry
    if (prev === "in-progress" && task.status === "review" && task.lastError) {
      state.taskClaimTimes.delete(task.id);
      const retried = scheduleRetry(config.dir, state, task, task.lastError);

      // Notify master if retries exhausted
      if (!retried && config.masterPane) {
        const masterPaneInfo =
          panes.find((p) => p.role === "lead") ?? panes.find((p) => p.title === config.masterPane);
        if (masterPaneInfo) {
          const retryDispDir = join(config.dir, ".tasks", "dispatch");
          if (!existsSync(retryDispDir)) mkdirSync(retryDispDir, { recursive: true });
          const msgFile = join(retryDispDir, `retry-exhausted-${task.id}.md`);
          const msg = `# Task Failed: ${task.title}\n\nFailed after ${task.maxRetries ?? 5} retries.\nLast error: ${task.lastError}\n\nManual intervention required.`;
          writeFileSync(msgFile, msg);
          // Keep under 200 chars to avoid paste preview in Claude Code TUI
          sendCommand(
            config.session,
            masterPaneInfo.id,
            `Task ${task.id} failed after retries. Run: tmux-ide dispatch retry-exhausted-${task.id}`,
          );
        }
      }
    }

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

      // Run after_run hook (failure is logged but ignored)
      if (config.afterRun) {
        runHook(config.afterRun, config.dir);
      }

      if (config.masterPane) {
        const masterPaneInfo =
          panes.find((p) => p.role === "lead") ?? panes.find((p) => p.title === config.masterPane);
        if (masterPaneInfo) {
          const proofStr = task.proof ? JSON.stringify(task.proof, null, 2) : "no proof provided";
          const dispDir = join(config.dir, ".tasks", "dispatch");
          if (!existsSync(dispDir)) mkdirSync(dispDir, { recursive: true });
          const msgFile = join(dispDir, `completed-${task.id}.md`);
          const msg = `# Task Completed: ${task.title}\n\nBy: ${task.assignee}\nProof:\n${proofStr}\n\nReview and approve, or request changes.`;
          writeFileSync(msgFile, msg);
          // Keep under 200 chars to avoid paste preview in Claude Code TUI
          const shortTitle = task.title.length > 60 ? task.title.slice(0, 57) + "..." : task.title;
          sendCommand(
            config.session,
            masterPaneInfo.id,
            `Task done: "${shortTitle}" by ${task.assignee}. Run: tmux-ide dispatch completed-${task.id}`,
          );
        }
      }
    }
  }
}

/**
 * Schedule a failed task for retry with exponential backoff.
 *
 * Backoff formula: 10s * 2^attempt, capped at 300s (5 minutes).
 * Max 5 retries by default (configurable per task via maxRetries).
 *
 * Returns true if retry was scheduled, false if max retries exceeded.
 */
export function scheduleRetry(
  dir: string,
  state: OrchestratorState,
  task: Task,
  reason: string,
): boolean {
  const maxRetries = task.maxRetries ?? 5;

  if (task.retryCount >= maxRetries) {
    // Max retries exceeded — mark for review
    task.status = "review";
    task.lastError = reason;
    task.assignee = null;
    task.updated = new Date().toISOString();
    saveTask(dir, task);
    state.claimedTasks.delete(task.id);

    appendEvent(dir, {
      timestamp: new Date().toISOString(),
      type: "error",
      taskId: task.id,
      message: `Max retries (${maxRetries}) exceeded for "${task.title}": ${reason}`,
    });

    return false;
  }

  // Exponential backoff: 10s * 2^attempt, capped at 300s
  const backoffMs = Math.min(10_000 * Math.pow(2, task.retryCount), 300_000);
  const nextRetryAt = new Date(Date.now() + backoffMs).toISOString();

  task.retryCount += 1;
  task.lastError = reason;
  task.nextRetryAt = nextRetryAt;
  task.status = "todo";
  task.assignee = null;
  task.updated = new Date().toISOString();
  saveTask(dir, task);
  state.claimedTasks.delete(task.id);

  appendEvent(dir, {
    timestamp: new Date().toISOString(),
    type: "retry",
    taskId: task.id,
    message: `Retry ${task.retryCount}/${maxRetries} scheduled for "${task.title}" in ${backoffMs / 1000}s: ${reason}`,
  });

  return true;
}

export function reconcile(
  config: OrchestratorConfig,
  state: OrchestratorState,
  tasks: Task[],
  panes: PaneInfo[],
): void {
  const agentIds = new Set(panes.map((p) => agentIdentifier(p)));

  for (const task of tasks.filter((t) => t.status === "in-progress" && t.assignee)) {
    // Check if the assigned agent's pane still exists
    if (!agentIds.has(task.assignee!)) {
      const agent = task.assignee!;
      const reason = `Agent "${agent}" vanished (pane closed or crashed)`;

      // Schedule retry with backoff instead of immediate re-queue
      scheduleRetry(config.dir, state, task, reason);

      appendEvent(config.dir, {
        timestamp: new Date().toISOString(),
        type: "reconcile",
        taskId: task.id,
        agent,
        message: `Agent "${agent}" vanished, scheduled retry for "${task.title}"`,
      });
    }
  }
}

// --- Orchestrator state persistence ---

interface PersistedState {
  claimedTasks: string[];
  taskClaimTimes: Record<string, number>;
  lastActivity?: Record<string, number>;
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
    lastActivity: Object.fromEntries(state.lastActivity),
  };
  // Atomic write: write to temp file, then rename
  const filePath = stateFilePath(dir);
  const tmpPath = filePath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmpPath, filePath);
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
    if (data.lastActivity && typeof data.lastActivity === "object") {
      for (const [id, time] of Object.entries(data.lastActivity)) {
        state.lastActivity.set(id, time);
      }
    }
  } catch {
    // Corrupted state file — start fresh
  }
}

/**
 * Sync claimedTasks with the actual task store on startup.
 * Removes stale claims (task no longer in-progress) and adds missing claims
 * (task is in-progress but not in claimedTasks). Prevents stale claims from
 * blocking dispatch after a crash or manual state reset.
 */
export function syncClaims(dir: string, state: OrchestratorState): void {
  const tasks = loadTasks(dir);
  const inProgressIds = new Set(tasks.filter((t) => t.status === "in-progress").map((t) => t.id));
  // Remove stale claims
  for (const id of state.claimedTasks) {
    if (!inProgressIds.has(id)) {
      state.claimedTasks.delete(id);
    }
  }
  // Add missing claims
  for (const id of inProgressIds) {
    state.claimedTasks.add(id);
  }
}

export function gracefulShutdown(config: OrchestratorConfig, state: OrchestratorState): void {
  // Release all in-progress tasks back to todo
  const tasks = loadTasks(config.dir);
  for (const task of tasks) {
    if (task.status === "in-progress" && task.assignee) {
      task.assignee = null;
      task.status = "todo";
      task.updated = new Date().toISOString();
      saveTask(config.dir, task);
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
      | "beforeRun"
      | "afterRun"
    >
  >,
): void {
  if (patch.pollInterval !== undefined) target.pollInterval = patch.pollInterval;
  if (patch.stallTimeout !== undefined) target.stallTimeout = patch.stallTimeout;
  if (patch.maxConcurrentAgents !== undefined)
    target.maxConcurrentAgents = patch.maxConcurrentAgents;
  if (patch.autoDispatch !== undefined) target.autoDispatch = patch.autoDispatch;
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

  // Sync claims with actual task store to clear stale claims after crash
  syncClaims(config.dir, state);

  // Initialize previous state
  for (const task of loadTasks(config.dir)) {
    state.previousTasks.set(task.id, task.status);
  }

  function tick(): void {
    const tasks = loadTasks(config.dir);
    const panes = listSessionPanes(config.session);

    // 1. Reconcile: detect crashed agents, unassign their tasks
    reconcile(config, state, tasks, panes);

    // 2. Auto-dispatch: assign tasks or goals to idle agents
    if (config.autoDispatch) {
      if (config.dispatchMode === "goals") {
        const goals = loadGoals(config.dir);
        dispatchGoals(config, state, goals, tasks, panes);
      } else {
        dispatch(config, state, tasks, panes);
      }
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
          const raw = readFileSync(configPath, "utf-8");
          const parsed = yaml.load(raw) as Record<string, unknown>;
          const orch = (parsed.orchestrator ?? {}) as Record<string, unknown>;

          const oldPollInterval = config.pollInterval;

          reloadConfig(config, {
            pollInterval: (orch.poll_interval as number | undefined) ?? config.pollInterval,
            stallTimeout: (orch.stall_timeout as number | undefined) ?? config.stallTimeout,
            maxConcurrentAgents:
              (orch.max_concurrent_agents as number | undefined) ?? config.maxConcurrentAgents,
            autoDispatch: (orch.auto_dispatch as boolean | undefined) ?? config.autoDispatch,
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
