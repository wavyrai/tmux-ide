import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  loadMission,
  nextTaskId,
  saveTask,
  type Task,
} from "./task-store.ts";
import { appendEvent, readEvents, type OrchestratorEvent } from "./event-log.ts";
import { sendCommand, type PaneInfo } from "../widgets/lib/pane-comms.ts";
import type { OrchestratorConfig, OrchestratorState } from "./orchestrator.ts";

export interface ResearchState {
  lastResearchAt: Record<string, string>;
  missionStartAnalyzed: boolean;
  milestoneTaskCounts: Record<string, number>;
  activeResearchTaskId: string | null;
  retryWindow: { timestamp: string; taskId: string }[];
}

export interface ResearchTrigger {
  type: string;
  reason: string;
  context?: Record<string, unknown>;
}

export interface ResearchConfigShape {
  enabled?: boolean;
  triggers?: {
    mission_start?: boolean;
    milestone_progress?: number;
    milestone_complete?: boolean;
    periodic_minutes?: number;
    retry_cluster?: boolean;
    stall_detected?: boolean;
    discovered_issue?: boolean;
  };
}

const RESEARCH_STATE_FILE = ".tasks/research-state.json";
const DEFAULT_COOLDOWN_MINUTES = 30;
const SPINNERS = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠂⠒⠢⠆⠐⠠⠄◐◓◑◒✳|/\\-] /;
const SHELL_COMMANDS = new Set(["zsh", "bash", "sh", "fish"]);
const AGENT_PREFIXES = ["claude", "codex"];
const VERSION_PATTERN = /^\d+\.\d+/;

function getResearchStatePath(dir: string): string {
  return join(dir, RESEARCH_STATE_FILE);
}

function defaultResearchState(): ResearchState {
  return {
    lastResearchAt: {},
    missionStartAnalyzed: false,
    milestoneTaskCounts: {},
    activeResearchTaskId: null,
    retryWindow: [],
  };
}

export function loadResearchState(dir: string): ResearchState {
  const path = getResearchStatePath(dir);
  if (!existsSync(path)) return defaultResearchState();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<ResearchState>;
    return {
      lastResearchAt: parsed.lastResearchAt ?? {},
      missionStartAnalyzed: parsed.missionStartAnalyzed ?? false,
      milestoneTaskCounts: parsed.milestoneTaskCounts ?? {},
      activeResearchTaskId: parsed.activeResearchTaskId ?? null,
      retryWindow: Array.isArray(parsed.retryWindow) ? parsed.retryWindow : [],
    };
  } catch {
    return defaultResearchState();
  }
}

export function saveResearchState(dir: string, state: ResearchState): void {
  const tasksDir = join(dir, ".tasks");
  if (!existsSync(tasksDir)) mkdirSync(tasksDir, { recursive: true });
  const path = getResearchStatePath(dir);
  const tmpPath = path + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmpPath, path);
}

function getResearchConfig(config: Partial<OrchestratorConfig> & { research?: ResearchConfigShape }) {
  return config.research ?? {};
}

function hasCooldown(
  researchState: ResearchState,
  type: string,
  minutes = DEFAULT_COOLDOWN_MINUTES,
): boolean {
  if (minutes <= 0) return false;
  const last = researchState.lastResearchAt[type];
  if (!last) return false;
  return Date.now() - Date.parse(last) < minutes * 60_000;
}

function latestEventAfter(
  events: OrchestratorEvent[],
  type: string,
  after: string | undefined,
): OrchestratorEvent | null {
  const afterTs = after ? Date.parse(after) : 0;
  const filtered = events
    .filter((event) => event.type === type && Date.parse(event.timestamp) > afterTs)
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  return filtered[0] ?? null;
}

export function evaluateTriggers(
  config: Partial<OrchestratorConfig> & { dir: string; research?: ResearchConfigShape },
  _state: OrchestratorState,
  researchState: ResearchState,
  tasks: Task[],
  events: OrchestratorEvent[],
): ResearchTrigger[] {
  const research = getResearchConfig(config);
  if (!research.enabled) return [];
  if (researchState.activeResearchTaskId) return [];

  const mission = loadMission(config.dir);
  const triggers = research.triggers ?? {};
  const results: ResearchTrigger[] = [];

  if (triggers.mission_start && mission && !researchState.missionStartAnalyzed) {
    if (!hasCooldown(researchState, "mission_start")) {
      researchState.missionStartAnalyzed = true;
      results.push({
        type: "mission_start",
        reason: `Mission "${mission.title}" started and needs an initial audit`,
      });
    }
  }

  const milestoneStep = triggers.milestone_progress ?? 0;
  if (mission && milestoneStep > 0) {
    for (const milestone of mission.milestones) {
      const doneCount = tasks.filter(
        (task) => task.milestone === milestone.id && task.status === "done" && !task.tags.includes("research"),
      ).length;
      const previousCount = researchState.milestoneTaskCounts[milestone.id] ?? 0;
      const previousBucket = Math.floor(previousCount / milestoneStep);
      const currentBucket = Math.floor(doneCount / milestoneStep);
      if (doneCount > 0 && currentBucket > previousBucket) {
        results.push({
          type: "milestone_progress",
          reason: `Milestone ${milestone.id} reached ${doneCount} completed task(s)`,
          context: { milestoneId: milestone.id, completedCount: doneCount, milestoneTitle: milestone.title },
        });
      }
      researchState.milestoneTaskCounts[milestone.id] = doneCount;
    }
  }

  if (triggers.milestone_complete) {
    const event = latestEventAfter(events, "milestone_complete", researchState.lastResearchAt.milestone_complete);
    if (event && !hasCooldown(researchState, "milestone_complete")) {
      results.push({
        type: "milestone_complete",
        reason: event.message,
      });
    }
  }

  if ((triggers.periodic_minutes ?? 0) > 0 && !hasCooldown(researchState, "periodic", triggers.periodic_minutes)) {
    results.push({
      type: "periodic",
      reason: `Periodic research interval elapsed (${triggers.periodic_minutes} minute window)`,
    });
  }

  if (triggers.retry_cluster) {
    const windowStart = Date.now() - 15 * 60_000;
    researchState.retryWindow = events
      .filter((event) => event.type === "retry" && Date.parse(event.timestamp) >= windowStart)
      .map((event) => ({ timestamp: event.timestamp, taskId: event.taskId ?? "unknown" }));
    if (researchState.retryWindow.length >= 3 && !hasCooldown(researchState, "retry_cluster")) {
      results.push({
        type: "retry_cluster",
        reason: `${researchState.retryWindow.length} retries clustered in the last 15 minutes`,
      });
    }
  }

  if (triggers.stall_detected) {
    const event = latestEventAfter(events, "stall", researchState.lastResearchAt.stall_detected);
    if (event && !hasCooldown(researchState, "stall_detected")) {
      results.push({
        type: "stall_detected",
        reason: event.message,
      });
    }
  }

  if (triggers.discovered_issue) {
    const event = latestEventAfter(events, "discovered_issue", researchState.lastResearchAt.discovered_issue);
    if (event && !hasCooldown(researchState, "discovered_issue")) {
      results.push({
        type: "discovered_issue",
        reason: event.message,
      });
    }
  }

  return results;
}

function promptInstructions(type: string): string {
  switch (type) {
    case "mission_start":
      return `Perform an initial codebase-analysis and architecture-audit.\nIdentify major risks, missing contracts, and likely execution bottlenecks.`;
    case "milestone_progress":
      return `Perform a progress audit.\nCheck whether recent completed work is coherent, whether validation coverage still matches implementation, and whether follow-up tasks are needed.`;
    case "milestone_complete":
      return `Perform a completion review.\nLook for hidden regressions, weak evidence, and any missing remediation before the next milestone advances.`;
    case "retry_cluster":
      return `Perform an incident-analysis.\nFind why multiple retries are clustering and propose concrete corrective actions or task reshaping.`;
    case "stall_detected":
      return `Perform issue-triage on the stalled work.\nIdentify likely blockers, missing context, or decomposition problems.`;
    case "discovered_issue":
      return `Perform issue-triage on the newly discovered problem.\nClarify severity, scope, and the best next task to create.`;
    case "periodic":
    default:
      return `Perform a continuous internal audit.\nReview architecture, tests, contracts, and task quality. Surface actionable findings only.`;
  }
}

export function buildResearchPrompt(
  dir: string,
  type: string,
  context: Record<string, unknown> = {},
): string {
  const mission = loadMission(dir);
  const taskId = typeof context.taskId === "string" ? context.taskId : "<TASK_ID>";
  let prompt = `# Research Task: ${type}\n\n`;

  if (mission) {
    prompt += `## Mission: ${mission.title}\n`;
    if (mission.description) prompt += `${mission.description}\n`;
    prompt += "\n";
  }

  if (context.reason) {
    prompt += `## Trigger Context\n${String(context.reason)}\n\n`;
  }

  if (context.milestoneId || context.milestoneTitle || context.completedCount != null) {
    prompt += `## Milestone Context\n`;
    if (context.milestoneId) prompt += `Milestone: ${String(context.milestoneId)}\n`;
    if (context.milestoneTitle) prompt += `Title: ${String(context.milestoneTitle)}\n`;
    if (context.completedCount != null) prompt += `Completed tasks: ${String(context.completedCount)}\n`;
    prompt += "\n";
  }

  prompt += `## Instructions\n${promptInstructions(type)}\n\n`;
  prompt += `## Reporting Protocol\n`;
  prompt += `1. Investigate only what is necessary to produce actionable findings.\n`;
  prompt += `2. If you find concrete issues, update or create follow-up tasks as needed.\n`;
  prompt += `3. Finish by recording your result with:\n`;
  prompt += `   tmux-ide task done ${taskId} --proof "key findings and evidence" --summary "short research takeaway"\n`;
  prompt += `4. Include severity, impact, and the recommended next action in your proof.\n`;

  return prompt.trim();
}

function isIdlePane(pane: PaneInfo): boolean {
  const cmd = pane.currentCommand.toLowerCase();
  if (SHELL_COMMANDS.has(cmd)) return true;
  if (AGENT_PREFIXES.some((prefix) => cmd.startsWith(prefix))) return !SPINNERS.test(pane.title);
  if (VERSION_PATTERN.test(cmd)) return !SPINNERS.test(pane.title);
  return false;
}

function findResearchPane(panes: PaneInfo[], masterPane: string | null): PaneInfo | null {
  const explicit = panes.find((pane) => pane.role === "researcher" && isIdlePane(pane));
  if (explicit) return explicit;

  const idleFallback = panes.filter((pane) => {
    if (pane.role === "lead") return false;
    if (masterPane && pane.title === masterPane) return false;
    return isIdlePane(pane);
  });

  if (idleFallback.length < 2) return null;
  return idleFallback[0] ?? null;
}

function activeMilestoneId(dir: string): string | null {
  const mission = loadMission(dir);
  return mission?.milestones.find((milestone) => milestone.status === "active")?.id ?? null;
}

export function dispatchResearch(
  config: Pick<
    OrchestratorConfig,
    "session" | "dir" | "masterPane" | "maxConcurrentAgents"
  > & { research?: ResearchConfigShape },
  state: OrchestratorState,
  researchState: ResearchState,
  tasks: Task[],
  panes: PaneInfo[],
  triggerOverride?: ResearchTrigger,
): Task | null {
  if (researchState.activeResearchTaskId) return null;

  const inProgressCount = tasks.filter((task) => task.status === "in-progress").length;
  if (inProgressCount >= config.maxConcurrentAgents - 1) return null;

  const triggers = triggerOverride
    ? [triggerOverride]
    : evaluateTriggers(config, state, researchState, tasks, readEvents(config.dir));
  const trigger = triggers[0];
  if (!trigger) return null;

  const pane = findResearchPane(panes, config.masterPane);
  if (!pane) return null;

  const id = nextTaskId(config.dir);
  const now = new Date().toISOString();
  const task: Task = {
    id,
    title: `Research: ${trigger.type.replace(/_/g, " ")}`,
    description: trigger.reason,
    goal: null,
    status: "in-progress",
    assignee: pane.name ?? pane.title,
    priority: 3,
    created: now,
    updated: now,
    tags: ["research", trigger.type],
    proof: null,
    retryCount: 0,
    maxRetries: 5,
    lastError: null,
    nextRetryAt: null,
    depends_on: [],
    milestone: typeof trigger.context?.milestoneId === "string" ? trigger.context.milestoneId : activeMilestoneId(config.dir),
    specialty: "researcher",
    fulfills: [],
    discoveredIssues: [],
    salientSummary: null,
  };
  saveTask(config.dir, task);

  const dispatchDir = join(config.dir, ".tasks", "dispatch");
  if (!existsSync(dispatchDir)) mkdirSync(dispatchDir, { recursive: true });
  const prompt = buildResearchPrompt(config.dir, trigger.type, {
    ...trigger.context,
    reason: trigger.reason,
    taskId: id,
  });
  const filename = `research-${id}.md`;
  writeFileSync(join(dispatchDir, filename), prompt);

  const sent = sendCommand(config.session, pane.id, `Read and execute: .tasks/dispatch/${filename}`);
  if (!sent) {
    task.status = "todo";
    task.assignee = null;
    task.updated = new Date().toISOString();
    saveTask(config.dir, task);
    return null;
  }

  researchState.activeResearchTaskId = id;
  researchState.lastResearchAt[trigger.type] = now;
  saveResearchState(config.dir, researchState);
  state.lastActivity.set(pane.id, Date.now());

  appendEvent(config.dir, {
    timestamp: now,
    type: "research_dispatch",
    taskId: id,
    target: pane.title,
    researchType: trigger.type,
    message: `Dispatched research task ${id} (${trigger.type}) to ${pane.title}`,
  });

  return task;
}

function researchLibraryFile(type: string): string {
  switch (type) {
    case "mission_start":
    case "milestone_progress":
    case "milestone_complete":
    case "periodic":
      return "research-findings.md";
    case "retry_cluster":
    case "stall_detected":
    case "discovered_issue":
    case "issue-triage":
    case "incident-analysis":
      return "learnings.md";
    case "architecture-audit":
    case "codebase-analysis":
      return "architecture.md";
    case "test-coverage":
      return "testing.md";
    case "contract-audit":
      return "validation.md";
    case "code-review":
      return "reviews.md";
    default:
      return "research-findings.md";
  }
}

export function processResearchCompletion(
  config: Pick<OrchestratorConfig, "dir">,
  researchState: ResearchState,
  task: Task,
): void {
  if (!task.tags.includes("research")) return;

  const researchType = task.tags.find((tag) => tag !== "research") ?? "research";
  const summary = task.salientSummary ?? task.proof?.notes ?? task.description ?? task.title;
  const libraryDir = join(config.dir, ".tmux-ide", "library");
  if (!existsSync(libraryDir)) mkdirSync(libraryDir, { recursive: true });

  const filename = researchLibraryFile(researchType);
  const body = [
    `## ${task.id}: ${task.title}`,
    `Type: ${researchType}`,
    summary,
    "---",
    "",
  ].join("\n");
  appendFileSync(join(libraryDir, filename), body + "\n");

  researchState.activeResearchTaskId = researchState.activeResearchTaskId === task.id ? null : researchState.activeResearchTaskId;
  researchState.lastResearchAt[researchType] = task.updated;
  if (researchType === "mission_start") {
    researchState.missionStartAnalyzed = true;
  }
  saveResearchState(config.dir, researchState);

  appendEvent(config.dir, {
    timestamp: task.updated,
    type: "research_finding",
    taskId: task.id,
    researchType,
    summary,
    message: `Recorded research findings for task ${task.id}`,
  });
}
