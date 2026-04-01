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
import { execSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  mkdirSync,
  readdirSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import {
  loadMission,
  saveMission,
  loadGoal,
  loadGoals,
  loadTasks,
  saveTask,
  saveGoal,
  nextTaskId,
  type Task,
  type Goal,
  type Mission,
  type Milestone,
} from "./task-store.ts";
import { slugify } from "./slugify.ts";
import { recordTaskTime } from "./token-tracker.ts";
import {
  listSessionPanes,
  sendCommand,
  captureLastLine,
  type PaneInfo,
} from "../widgets/lib/pane-comms.ts";
import { appendEvent, readEvents, type OrchestratorEvent } from "./event-log.ts";
import { loadSkill } from "./skill-registry.ts";
import { isGhAvailable, createMissionPr } from "./github-pr.ts";
import { computeAndSaveMetrics, appendMissionHistory } from "./metrics.ts";
import {
  loadValidationContract,
  loadValidationState,
  saveValidationState,
  checkCoverage,
} from "./validation.ts";
import {
  dispatchResearch,
  evaluateTriggers,
  loadResearchState,
  processResearchCompletion,
  saveResearchState,
  type ResearchConfigShape,
  type ResearchState,
} from "./research.ts";

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
  dispatchMode: "tasks" | "goals" | "missions";
  paneSpecialties: Map<string, string[]>;
  services: Record<string, { command: string; port?: number; healthcheck?: string }>;
  research?: ResearchConfigShape;
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
const AGENT_PREFIXES = ["claude", "codex"];
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
  if (AGENT_PREFIXES.some((p) => cmd.startsWith(p))) return true;
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
  const lastLine = captureLastLine(paneId);
  return lastLine.includes("❯");
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

/**
 * Load a library file excerpt. Returns content truncated to ~500 chars if needed.
 */
function loadLibraryExcerpt(filePath: string, maxChars = 500): string | null {
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, "utf-8").trim();
    if (!content) return null;
    if (content.length <= maxChars) return content;
    return content.slice(0, maxChars) + `\n... (see full file at ${filePath})`;
  } catch {
    return null;
  }
}

export function buildTaskPrompt(dir: string, task: Task, config?: OrchestratorConfig): string {
  let prompt = "";

  // 1. Mission narrative
  const mission = loadMission(dir);
  if (mission) {
    prompt += `## Mission: ${mission.title}\n`;
    if (mission.description) prompt += `${mission.description}\n`;
    prompt += "\n";
  }

  // 2. Milestone context
  if (task.milestone && mission) {
    const milestone = mission.milestones.find((m) => m.id === task.milestone);
    if (milestone) {
      prompt += `## Milestone: ${milestone.title} (${milestone.id})\n`;
      if (milestone.description) prompt += `${milestone.description}\n`;
      prompt += "\n";
    }
  }

  // 3. AGENTS.md — project boundaries
  const agentsMdPath = join(dir, "AGENTS.md");
  const agentsContent = loadLibraryExcerpt(agentsMdPath, 1000);
  if (agentsContent) {
    prompt += `## Agent Guidelines\n${agentsContent}\n\n`;
  }

  // 4. Skill context
  {
    const skillName = task.specialty ?? "general-worker";
    const skill = loadSkill(dir, skillName);
    if (skill?.body) {
      prompt += `## Your Role: ${skill.name}\n`;
      prompt += `${skill.body}\n\n`;
    }
  }

  // 5. Goal context
  if (task.goal) {
    const goal = loadGoal(dir, task.goal);
    if (goal) {
      prompt += `## Goal: ${goal.title}\n`;
      if (goal.acceptance) prompt += `Acceptance: ${goal.acceptance}\n`;
      prompt += "\n";
    }
  }

  // 6. Task details
  prompt += `## Your Task: ${task.title}\n`;
  if (task.description) prompt += `${task.description}\n`;
  prompt += `\nPriority: P${task.priority}\n`;
  if (task.tags?.length) prompt += `Tags: ${task.tags.join(", ")}\n`;
  if (task.fulfills?.length) prompt += `Fulfills assertions: ${task.fulfills.join(", ")}\n`;
  prompt += "\n";

  // 7. Recent completions (same milestone, last 5)
  if (task.milestone) {
    const allTasks = loadTasks(dir);
    const recentDone = allTasks
      .filter((t) => t.milestone === task.milestone && t.status === "done" && t.id !== task.id)
      .slice(-5);
    if (recentDone.length > 0) {
      prompt += `## Recent Completions (${task.milestone})\n`;
      for (const t of recentDone) {
        prompt += `- ${t.id}: ${t.title}`;
        if (t.salientSummary) prompt += ` — ${t.salientSummary}`;
        prompt += "\n";
      }
      prompt += "\n";
    }
  }

  // 8. Library references
  const libraryDir = join(dir, ".tmux-ide", "library");
  if (existsSync(libraryDir)) {
    // Always include architecture.md
    const archExcerpt = loadLibraryExcerpt(join(libraryDir, "architecture.md"));
    if (archExcerpt) {
      prompt += `## Architecture\n${archExcerpt}\n\n`;
    }

    // Match library files by task tags
    if (task.tags?.length) {
      try {
        const files = readdirSync(libraryDir).filter(
          (f) => f.endsWith(".md") && f !== "architecture.md",
        );
        const tagSet = new Set(task.tags.map((t) => t.toLowerCase()));
        for (const file of files) {
          const stem = file.replace(/\.md$/, "").toLowerCase();
          if (tagSet.has(stem)) {
            const excerpt = loadLibraryExcerpt(join(libraryDir, file));
            if (excerpt) {
              prompt += `## Reference: ${file}\n${excerpt}\n\n`;
            }
          }
        }
      } catch {
        // Library scan failed — skip
      }
    }
  }

  // 9. Services
  if (config?.services && Object.keys(config.services).length > 0) {
    prompt += `## Available Services\n`;
    for (const [name, svc] of Object.entries(config.services)) {
      prompt += `- **${name}**: \`${svc.command}\``;
      if (svc.port) prompt += ` (port ${svc.port})`;
      if (svc.healthcheck) prompt += ` — healthcheck: \`${svc.healthcheck}\``;
      prompt += "\n";
    }
    prompt += "\n";
  }

  // 10. Workspace + completion instructions
  prompt += `Workspace: ${dir}\n\n`;
  prompt += `When done:\n`;
  prompt += `  tmux-ide task done ${task.id} --proof "short summary of what you accomplished"\n`;

  return prompt.trim();
}

// --- Milestone gating ---

/**
 * Get the current (first non-done) milestone from the mission, sorted by order.
 */
export function getCurrentMilestone(dir: string): Milestone | null {
  const mission = loadMission(dir);
  if (!mission || mission.milestones.length === 0) return null;
  const sorted = [...mission.milestones].sort((a, b) => a.order - b.order);
  return sorted.find((m) => m.status !== "done") ?? null;
}

/**
 * Check that all milestones with lower order than the given one are 'done'.
 */
export function isMilestoneReady(dir: string, milestoneId: string): boolean {
  const mission = loadMission(dir);
  if (!mission) return false;
  const target = mission.milestones.find((m) => m.id === milestoneId);
  if (!target) return false;
  return mission.milestones.filter((m) => m.order < target.order).every((m) => m.status === "done");
}

/**
 * Check if a task's milestone allows dispatch.
 * Tasks without a milestone are always eligible (backward compat).
 * Tasks with a milestone require it to be 'active' and all predecessors done.
 */
function isTaskMilestoneEligible(dir: string, task: Task, mission: Mission | null): boolean {
  if (!task.milestone) return true;
  if (!mission) return false;
  const milestone = mission.milestones.find((m) => m.id === task.milestone);
  if (!milestone) return false;
  if (milestone.status !== "active") return false;
  return isMilestoneReady(dir, milestone.id);
}

/**
 * Check active milestones for completion. When all tasks for a milestone are done,
 * transition to 'validating' (if a validation contract exists) or straight to 'done'.
 */
export function checkMilestoneCompletion(
  config: OrchestratorConfig,
  state: OrchestratorState,
  tasks: Task[],
  panes: PaneInfo[],
): void {
  const mission = loadMission(config.dir);
  if (!mission || mission.milestones.length === 0) return;

  let changed = false;
  const sorted = [...mission.milestones].sort((a, b) => a.order - b.order);

  for (const milestone of sorted) {
    if (milestone.status !== "active") continue;

    const milestoneTasks = tasks.filter((t) => t.milestone === milestone.id);
    if (milestoneTasks.length === 0) continue;
    const allDone = milestoneTasks.every((t) => t.status === "done");
    if (!allDone) continue;

    // Check if a validation contract exists — if so, go through validation
    const contract = loadValidationContract(config.dir);
    if (contract) {
      const dispatched = dispatchValidation(config, state, milestone, milestoneTasks, panes);
      if (!dispatched) continue;

      milestone.status = "validating";
      milestone.updated = new Date().toISOString();
      changed = true;

      appendEvent(config.dir, {
        timestamp: new Date().toISOString(),
        type: "milestone_validating",
        milestoneId: milestone.id,
        title: milestone.title,
        message: `Milestone "${milestone.title}" (${milestone.id}) — all tasks done, dispatching validation`,
      });
    } else {
      // No contract — skip straight to done
      milestone.status = "done";
      milestone.updated = new Date().toISOString();
      changed = true;

      appendEvent(config.dir, {
        timestamp: new Date().toISOString(),
        type: "milestone_complete",
        milestoneId: milestone.id,
        title: milestone.title,
        message: `Milestone "${milestone.title}" (${milestone.id}) completed`,
      });

      activateNextMilestone(mission, milestone.id);
    }
  }

  if (changed) {
    mission.updated = new Date().toISOString();
    saveMission(config.dir, mission);
  }
}

function activateNextMilestone(mission: Mission, completedMilestoneId: string): boolean {
  const sorted = [...mission.milestones].sort((a, b) => a.order - b.order);
  const completed = sorted.find((milestone) => milestone.id === completedMilestoneId);
  if (!completed || completed.status !== "done") return false;

  const next = sorted.find(
    (milestone) => milestone.order > completed.order && milestone.status === "locked",
  );
  if (!next) return false;

  next.status = "active";
  next.updated = new Date().toISOString();
  return true;
}

/**
 * Build a validation prompt for a milestone.
 */
export function buildValidationPrompt(
  dir: string,
  milestone: Milestone,
  completedTasks: Task[],
): string {
  const contract = loadValidationContract(dir);
  let prompt = `# Validation: ${milestone.title} (${milestone.id})\n\n`;

  if (contract) {
    prompt += `## Validation Contract\n\n${contract}\n\n`;
  }

  prompt += `## Completed Tasks\n\n`;
  for (const task of completedTasks) {
    prompt += `### ${task.id}: ${task.title}\n`;
    if (task.proof) prompt += `Proof: ${JSON.stringify(task.proof)}\n`;
    if (task.fulfills.length > 0) prompt += `Fulfills assertions: ${task.fulfills.join(", ")}\n`;
    if (task.salientSummary) prompt += `Summary: ${task.salientSummary}\n`;
    prompt += "\n";
  }

  prompt += `## Instructions\n\n`;
  prompt += `Verify each assertion in the validation contract. For each assertion:\n`;
  prompt += `1. Check that the completed work actually satisfies the requirement\n`;
  prompt += `2. Run any relevant tests or checks\n`;
  prompt += `3. Report your finding:\n`;
  prompt += `   tmux-ide validate assert <ASSERT_ID> --status passing --evidence "description"\n`;
  prompt += `   tmux-ide validate assert <ASSERT_ID> --status failing --evidence "what's wrong"\n\n`;
  prompt += `When done verifying all assertions, the orchestrator will automatically detect results.\n`;

  return prompt.trim();
}

/**
 * Dispatch validation to a validator pane after milestone completion.
 */
export function dispatchValidation(
  config: OrchestratorConfig,
  state: OrchestratorState,
  milestone: Milestone,
  completedTasks: Task[],
  panes: PaneInfo[],
): boolean {
  // Find validator pane, fall back to any idle non-lead agent
  const validatorPane =
    panes.find((p) => p.role === "validator" && isIdleForDispatch(p)) ??
    panes.find((p) => {
      if (p.role === "lead") return false;
      if (config.masterPane && normalizePaneTitle(p.title) === config.masterPane) return false;
      return isIdleForDispatch(p);
    });

  if (!validatorPane) {
    appendEvent(config.dir, {
      timestamp: new Date().toISOString(),
      type: "error",
      message: `No idle validator pane for milestone "${milestone.title}" — validation pending`,
    });
    return false;
  }

  // Initialize validation state with pending entries for all fulfills
  const valState = loadValidationState(config.dir) ?? { assertions: {}, lastVerified: null };
  for (const task of completedTasks) {
    for (const assertionId of task.fulfills) {
      if (!valState.assertions[assertionId]) {
        valState.assertions[assertionId] = {
          status: "pending",
          verifiedBy: null,
          verifiedAt: null,
          evidence: null,
          blockedBy: null,
        };
      }
    }
  }
  saveValidationState(config.dir, valState);

  // Build and write prompt
  const prompt = buildValidationPrompt(config.dir, milestone, completedTasks);
  const dispatchDir = join(config.dir, ".tasks", "dispatch");
  if (!existsSync(dispatchDir)) mkdirSync(dispatchDir, { recursive: true });
  const dispatchFile = join(dispatchDir, `validate-${milestone.id}.md`);
  writeFileSync(dispatchFile, prompt);

  try {
    sendCommand(
      config.session,
      validatorPane.id,
      `Read and execute: .tasks/dispatch/validate-${milestone.id}.md`,
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    appendEvent(config.dir, {
      timestamp: new Date().toISOString(),
      type: "error",
      message: `Failed to dispatch validation for milestone "${milestone.title}": ${message}`,
    });
    return false;
  }

  saveValidationState(config.dir, valState);

  appendEvent(config.dir, {
    timestamp: new Date().toISOString(),
    type: "validation_dispatch",
    milestoneId: milestone.id,
    title: milestone.title,
    target: validatorPane.title,
    message: `Dispatched validation for "${milestone.title}" to ${validatorPane.title}`,
  });

  state.lastActivity.set(validatorPane.id, Date.now());
  return true;
}

/**
 * Check validation results for milestones in 'validating' state.
 * If all assertions pass → mark done, activate next.
 * If any fail → create remediation tasks, set milestone back to 'active'.
 */
export function checkValidationResults(config: OrchestratorConfig, tasks: Task[]): void {
  const mission = loadMission(config.dir);
  if (!mission) return;

  const valState = loadValidationState(config.dir);
  if (!valState) return;

  let changed = false;
  const sorted = [...mission.milestones].sort((a, b) => a.order - b.order);

  for (const milestone of sorted) {
    if (milestone.status !== "validating") continue;

    // Collect assertion IDs relevant to this milestone's tasks
    const milestoneTasks = tasks.filter((t) => t.milestone === milestone.id);
    const milestoneAssertionIds = new Set(milestoneTasks.flatMap((t) => t.fulfills));

    if (milestoneAssertionIds.size === 0) {
      milestone.status = "done";
      milestone.updated = new Date().toISOString();
      changed = true;

      appendEvent(config.dir, {
        timestamp: new Date().toISOString(),
        type: "milestone_complete",
        milestoneId: milestone.id,
        title: milestone.title,
        message: `Milestone "${milestone.title}" (${milestone.id}) — no assertions to validate`,
      });

      activateNextMilestone(mission, milestone.id);
      continue;
    }

    // Check if all milestone assertions have been verified (no longer pending)
    const allVerified = [...milestoneAssertionIds].every((id) => {
      const entry = valState.assertions[id];
      return entry && entry.status !== "pending";
    });
    if (!allVerified) continue;

    const allPassing = [...milestoneAssertionIds].every(
      (id) => valState.assertions[id]?.status === "passing",
    );

    if (allPassing) {
      milestone.status = "done";
      milestone.updated = new Date().toISOString();
      changed = true;

      appendEvent(config.dir, {
        timestamp: new Date().toISOString(),
        type: "milestone_complete",
        milestoneId: milestone.id,
        title: milestone.title,
        message: `Milestone "${milestone.title}" (${milestone.id}) — validation passed`,
      });

      activateNextMilestone(mission, milestone.id);
    } else {
      // Create remediation tasks for failing assertions
      const failedIds = [...milestoneAssertionIds].filter(
        (id) => valState.assertions[id]?.status === "failing",
      );

      for (const assertionId of failedIds) {
        const entry = valState.assertions[assertionId];
        if (!entry || entry.status !== "failing") continue;

        const id = nextTaskId(config.dir);
        const now = new Date().toISOString();
        const task: Task = {
          id,
          title: `Remediate: assertion ${assertionId} failing`,
          description: `Assertion ${assertionId} failed validation.\nEvidence: ${entry.evidence ?? "none"}\n\nFix the issue and ensure the assertion passes.`,
          goal: null,
          status: "todo",
          assignee: null,
          priority: 1,
          created: now,
          updated: now,
          tags: ["remediation"],
          proof: null,
          depends_on: [],
          retryCount: 0,
          maxRetries: 5,
          lastError: null,
          nextRetryAt: null,
          milestone: milestone.id,
          specialty: null,
          fulfills: [assertionId],
          discoveredIssues: [],
          salientSummary: null,
        };
        saveTask(config.dir, task);

        // Reset the assertion back to pending for re-verification
        entry.status = "pending";
        entry.verifiedBy = null;
        entry.verifiedAt = null;
        entry.evidence = null;
        entry.blockedBy = null;

        appendEvent(config.dir, {
          timestamp: new Date().toISOString(),
          type: "remediation",
          taskId: id,
          assertionId,
          message: `Created remediation task ${id} for failing assertion ${assertionId}`,
        });
      }

      saveValidationState(config.dir, valState);

      // Set milestone back to active so remediation tasks can be dispatched
      milestone.status = "active";
      milestone.updated = new Date().toISOString();
      changed = true;

      appendEvent(config.dir, {
        timestamp: new Date().toISOString(),
        type: "validation_failed",
        milestoneId: milestone.id,
        title: milestone.title,
        failedCount: failedIds.length,
        message: `Milestone "${milestone.title}" (${milestone.id}) — ${failedIds.length} assertion(s) failed, remediation tasks created`,
      });
    }
  }

  if (changed) {
    mission.updated = new Date().toISOString();
    saveMission(config.dir, mission);
  }
}

// --- Planning dispatch ---

const PLANNING_CLAIM = "__planning__";

/**
 * Build the planning prompt for the lead/planner agent.
 */
export function buildPlanningPrompt(dir: string): string {
  const mission = loadMission(dir);
  let prompt = `# Mission Planning\n\n`;

  if (mission) {
    prompt += `## Mission: ${mission.title}\n`;
    if (mission.description) prompt += `${mission.description}\n`;
    prompt += "\n";
  }

  // AGENTS.md
  const agentsMdPath = join(dir, "AGENTS.md");
  const agentsContent = loadLibraryExcerpt(agentsMdPath, 1000);
  if (agentsContent) {
    prompt += `## Agent Guidelines\n${agentsContent}\n\n`;
  }

  prompt += `## Instructions\n\n`;
  prompt += `You are the mission planner. Analyze the mission scope and create an execution plan.\n\n`;
  prompt += `1. Design milestones (sequential execution phases):\n`;
  prompt += `   tmux-ide milestone create "title" --sequence N [-d "description"]\n\n`;
  prompt += `2. Create a validation contract at .tasks/validation-contract.md with assertion IDs:\n`;
  prompt += `   Each assertion is a testable claim (e.g., ASSERT01: "Auth endpoint returns 200")\n\n`;
  prompt += `3. Create tasks linked to milestones:\n`;
  prompt += `   tmux-ide task create "title" --milestone M1 --specialty frontend --fulfills "ASSERT01,ASSERT02" [-d "description"]\n\n`;
  prompt += `4. Ensure every assertion in the contract is claimed by at least one task's --fulfills\n\n`;
  prompt += `5. When planning is complete, signal:\n`;
  prompt += `   tmux-ide mission plan-complete\n`;

  return prompt.trim();
}

/**
 * Dispatch the planning phase to the lead/planner pane.
 * Only runs once per mission (guarded by __planning__ claim).
 */
export function dispatchPlanning(
  config: OrchestratorConfig,
  state: OrchestratorState,
  panes: PaneInfo[],
): void {
  if (state.claimedTasks.has(PLANNING_CLAIM)) return;

  // Find the lead/planner pane
  const plannerPane =
    panes.find((p) => p.role === "lead") ??
    panes.find((p) => config.masterPane && normalizePaneTitle(p.title) === config.masterPane) ??
    panes.find((p) => isIdleForDispatch(p));

  if (!plannerPane) {
    appendEvent(config.dir, {
      timestamp: new Date().toISOString(),
      type: "error",
      message: "Unable to dispatch mission planning: no planner pane available",
    });
    return;
  }

  state.claimedTasks.add(PLANNING_CLAIM);

  const prompt = buildPlanningPrompt(config.dir);
  const dispatchDir = join(config.dir, ".tasks", "dispatch");
  if (!existsSync(dispatchDir)) mkdirSync(dispatchDir, { recursive: true });
  const dispatchFile = join(dispatchDir, "planning.md");
  writeFileSync(dispatchFile, prompt);

  sendCommand(config.session, plannerPane.id, `Read and execute: .tasks/dispatch/planning.md`);

  appendEvent(config.dir, {
    timestamp: new Date().toISOString(),
    type: "planning",
    target: plannerPane.title,
    message: `Dispatched mission planning to ${plannerPane.title}`,
  });

  state.lastActivity.set(plannerPane.id, Date.now());
}

// --- Mission completion ---

/**
 * Handle mission completion: all milestones done and all validations passing.
 */
export function handleMissionComplete(
  config: OrchestratorConfig,
  mission: Mission,
  panes: PaneInfo[],
): void {
  if (!mission.milestones.every((milestone) => milestone.status === "done")) return;

  mission.status = "complete";
  mission.updated = new Date().toISOString();
  saveMission(config.dir, mission);

  // Try to create a mission-level PR
  let prResult: { url: string; number: number } | null = null;
  if (mission.branch && isGhAvailable()) {
    prResult = createMissionPr(mission, config.dir);
  }

  // Build completion summary
  const totalMilestones = mission.milestones.length;
  const tasks = loadTasks(config.dir);
  const doneTasks = tasks.filter((t) => t.status === "done").length;

  let summary = `# Mission Complete: ${mission.title}\n\n`;
  summary += `Milestones: ${totalMilestones} completed\n`;
  summary += `Tasks: ${doneTasks}/${tasks.length} done\n`;
  if (prResult) summary += `PR: ${prResult.url}\n`;
  summary += `\nMission "${mission.title}" has been delivered.`;

  // Write dispatch file and notify master
  const dispatchDir = join(config.dir, ".tasks", "dispatch");
  if (!existsSync(dispatchDir)) mkdirSync(dispatchDir, { recursive: true });
  writeFileSync(join(dispatchDir, "mission-complete.md"), summary);

  if (config.masterPane) {
    const masterPane =
      panes.find((p) => p.role === "lead") ?? panes.find((p) => p.title === config.masterPane);
    if (masterPane) {
      sendCommand(
        config.session,
        masterPane.id,
        `Mission complete: "${mission.title}". Run: tmux-ide dispatch mission-complete`,
      );
    }
  }

  // Record mission in history for cross-mission comparison
  appendMissionHistory(config.dir, mission, tasks);

  appendEvent(config.dir, {
    timestamp: new Date().toISOString(),
    type: "mission_complete",
    title: mission.title,
    milestoneCount: totalMilestones,
    taskCount: doneTasks,
    ...(prResult ? { prNumber: prResult.number } : {}),
    message: `Mission "${mission.title}" completed — ${totalMilestones} milestones, ${doneTasks} tasks${prResult ? `, PR #${prResult.number}` : ""}`,
  });
}

export function dispatch(
  config: OrchestratorConfig,
  state: OrchestratorState,
  tasks: Task[],
  panes: PaneInfo[],
): void {
  // Coverage check: warn about unclaimed assertions (once per session)
  if (config.dispatchMode === "missions" && !state.claimedTasks.has("__coverage_warned__")) {
    const { unclaimed } = checkCoverage(config.dir);
    if (unclaimed.length > 0) {
      state.claimedTasks.add("__coverage_warned__");
      appendEvent(config.dir, {
        timestamp: new Date().toISOString(),
        type: "error",
        message: `Coverage gap: ${unclaimed.length} assertion(s) not claimed by any task: ${unclaimed.join(", ")}`,
      });
    }
  }

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
  const mission = config.dispatchMode === "missions" ? loadMission(config.dir) : null;
  const todoTasks = tasks
    .filter((t) => {
      // Skip if already claimed
      if (state.claimedTasks.has(t.id)) return false;
      // Regular todo tasks (include pre-assigned tasks — assignee is a preference hint)
      if (t.status === "todo") {
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
        // Milestone gating (missions mode only)
        if (
          config.dispatchMode === "missions" &&
          !isTaskMilestoneEligible(config.dir, t, mission)
        ) {
          return false;
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
    const prompt = buildTaskPrompt(config.dir, task, config);
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

  // Pre-assigned agent preference: if the task has an assignee (set at creation time),
  // prefer that agent if it's idle. This treats assignee as a preference hint.
  if (task.assignee) {
    const preferred = candidates.find((p) => agentIdentifier(p) === task.assignee);
    if (preferred) return preferred;
    // Preferred agent not idle — fall through to normal matching
  }

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
    prompt += `## Mission: ${mission.title}\n`;
    if (mission.description) prompt += `${mission.description}\n`;
    prompt += "\n";

    // Milestone context
    if (goal.milestone) {
      const milestone = mission.milestones.find((m) => m.id === goal.milestone);
      if (milestone) {
        prompt += `## Milestone: ${milestone.title} (${milestone.id})\n`;
        if (milestone.description) prompt += `${milestone.description}\n`;
        prompt += "\n";
      }
    }
  }

  // AGENTS.md — project boundaries
  const agentsMdPath = join(dir, "AGENTS.md");
  const agentsContent = loadLibraryExcerpt(agentsMdPath, 1000);
  if (agentsContent) {
    prompt += `## Agent Guidelines\n${agentsContent}\n\n`;
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
  researchState?: ResearchState,
): void {
  const now = Date.now();
  for (const task of tasks.filter((t) => t.status === "in-progress" && t.assignee)) {
    if (
      task.tags.includes("research") &&
      (!researchState?.activeResearchTaskId || researchState.activeResearchTaskId !== task.id)
    ) {
      continue;
    }

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
  researchState?: ResearchState,
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
      const elapsedMs = claimTime ? Date.now() - claimTime : undefined;
      if (claimTime && task.assignee) {
        recordTaskTime(config.dir, task.assignee, task.id, elapsedMs!);
      }
      state.taskClaimTimes.delete(task.id);

      // Clear claim lock
      state.claimedTasks.delete(task.id);

      appendEvent(config.dir, {
        timestamp: new Date().toISOString(),
        type: "completion",
        taskId: task.id,
        agent: task.assignee ?? undefined,
        durationMs: elapsedMs,
        message: `Completed "${task.title}" by ${task.assignee ?? "unknown"}${task.salientSummary ? ` — ${task.salientSummary}` : ""}`,
      } as OrchestratorEvent & { durationMs?: number });

      if (task.tags.includes("research") && researchState) {
        processResearchCompletion(config, researchState, task);
      }

      // Append salient summary to knowledge library
      if (task.salientSummary) {
        try {
          const libraryDir = join(config.dir, ".tmux-ide", "library");
          if (!existsSync(libraryDir)) mkdirSync(libraryDir, { recursive: true });
          const learningsPath = join(libraryDir, "learnings.md");
          const entry = `## Task ${task.id}: ${task.title}\n${task.salientSummary}\n---\n\n`;
          appendFileSync(learningsPath, entry);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[orchestrator] Failed to write learnings.md: ${msg}`);
          appendEvent(config.dir, {
            timestamp: new Date().toISOString(),
            type: "error",
            taskId: task.id,
            message: `Failed to append salientSummary to learnings.md: ${msg}`,
          });
        }
      }

      // Structured handoff: auto-create follow-up tasks for discovered issues
      if (task.discoveredIssues && task.discoveredIssues.length > 0) {
        for (const issue of task.discoveredIssues) {
          const followUpId = nextTaskId(config.dir);
          const now = new Date().toISOString();
          const followUp: Task = {
            id: followUpId,
            title: issue.length > 80 ? issue.slice(0, 77) + "..." : issue,
            description: `Discovered during task ${task.id} ("${task.title}"):\n\n${issue}`,
            goal: task.goal,
            status: "todo",
            assignee: null,
            priority: 2,
            created: now,
            updated: now,
            tags: ["discovered-issue"],
            proof: null,
            depends_on: [],
            retryCount: 0,
            maxRetries: 5,
            lastError: null,
            nextRetryAt: null,
            milestone: task.milestone,
            specialty: null,
            fulfills: [],
            discoveredIssues: [],
            salientSummary: null,
          };
          saveTask(config.dir, followUp);

          appendEvent(config.dir, {
            timestamp: new Date().toISOString(),
            type: "discovered_issue",
            taskId: followUpId,
            sourceTaskId: task.id,
            issue,
            message: `Auto-created follow-up task ${followUpId} from ${task.id}: ${issue}`,
          });
        }
      }

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

  // Emit session_end and save metrics
  appendEvent(config.dir, {
    timestamp: new Date().toISOString(),
    type: "session_end",
    message: `Orchestrator shutting down`,
  });

  try {
    computeAndSaveMetrics(config.dir);
  } catch {
    // Metrics save failure should not prevent shutdown
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
      | "research"
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
  if (patch.research !== undefined) target.research = patch.research;
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
  const researchState = loadResearchState(config.dir);

  // Load persisted state from previous run
  loadOrchestratorState(config.dir, state);

  // Sync claims with actual task store to clear stale claims after crash
  syncClaims(config.dir, state);

  // Initialize previous state
  for (const task of loadTasks(config.dir)) {
    state.previousTasks.set(task.id, task.status);
  }

  // Emit session_start
  appendEvent(config.dir, {
    timestamp: new Date().toISOString(),
    type: "session_start",
    message: `Orchestrator started — mode: ${config.dispatchMode}, max agents: ${config.maxConcurrentAgents}`,
  });

  let tickCount = 0;

  function tick(): void {
    tickCount++;
    let tasks = loadTasks(config.dir);
    const panes = listSessionPanes(config.session);

    // 1. Reconcile: detect crashed agents, unassign their tasks
    reconcile(config, state, tasks, panes);

    // 2. Auto-dispatch: assign tasks or goals to idle agents
    if (config.autoDispatch) {
      if (config.dispatchMode === "goals") {
        const goals = loadGoals(config.dir);
        dispatchGoals(config, state, goals, tasks, panes);
      } else if (config.dispatchMode === "missions") {
        // Mission lifecycle: planning → active → complete
        const mission = loadMission(config.dir);
        if (mission?.status === "planning" && mission.milestones.length === 0) {
          dispatchPlanning(config, state, panes);
        } else if (mission?.status === "active") {
          dispatch(config, state, tasks, panes);
        }
      } else {
        dispatch(config, state, tasks, panes);
      }
    }

    // 3. Detect stalls: nudge agents that haven't produced output
    detectStalls(config, state, tasks, panes, researchState);

    // 4. Detect completions: notify master, run hooks, cleanup
    detectCompletions(config, state, tasks, panes, researchState);
    tasks = loadTasks(config.dir);

    if (config.dispatchMode === "missions" && config.research?.enabled) {
      const triggers = evaluateTriggers(
        config,
        state,
        researchState,
        tasks,
        readEvents(config.dir),
      );
      if (triggers.length > 0) {
        dispatchResearch(config, state, researchState, tasks, panes, triggers[0]);
        tasks = loadTasks(config.dir);
      }
    }

    // 5. Milestone completion + validation flow + mission completion
    if (config.dispatchMode === "missions") {
      checkMilestoneCompletion(config, state, tasks, panes);
      checkValidationResults(config, tasks);

      // Check if mission is complete: all milestones done
      const mission = loadMission(config.dir);
      if (mission?.status === "active" && mission.milestones.length > 0) {
        const allMilestonesDone = mission.milestones.every((m) => m.status === "done");
        if (allMilestonesDone) {
          handleMissionComplete(config, mission, panes);
        }
      }
    }

    // Agent heartbeat every 6th tick (~30s at default 5s poll)
    if (tickCount % 6 === 0) {
      const agentPanes = panes.filter((p) => {
        if (p.role === "lead") return false;
        return isAgentPane(p);
      });
      if (agentPanes.length > 0) {
        const statuses = agentPanes
          .map((p) => `${agentIdentifier(p)}=${isAgentBusy(p) ? "busy" : "idle"}`)
          .join(", ");
        appendEvent(config.dir, {
          timestamp: new Date().toISOString(),
          type: "agent_heartbeat",
          message: `agents: ${statuses}`,
        });
      }
    }

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
            research: (orch.research as ResearchConfigShape | undefined) ?? config.research,
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
    saveResearchState(config.dir, researchState);
    process.exit(0);
  }

  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  return () => {
    clearInterval(interval);
    if (watcher) watcher.close();
    saveResearchState(config.dir, researchState);
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
  };
}
