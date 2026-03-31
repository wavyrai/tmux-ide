import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task, Goal, Mission } from "../lib/task-store.ts";
import type { PaneInfo } from "../widgets/lib/pane-comms.ts";
import type { OrchestratorConfig, OrchestratorState } from "../lib/orchestrator.ts";
import type { Mark, MarkKind, MarkRange } from "../lib/authorship.ts";
import { ensureTasksDir, saveTask, saveGoal } from "../lib/task-store.ts";

// ---------------------------------------------------------------------------
// Factory: Task
// ---------------------------------------------------------------------------

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "001",
    title: "Test task",
    description: "",
    goal: null,
    status: "todo",
    assignee: null,
    priority: 1,
    created: "2026-01-01T00:00:00Z",
    updated: "2026-01-01T00:00:00Z",
    tags: [],
    proof: null,
    retryCount: 0,
    maxRetries: 5,
    lastError: null,
    nextRetryAt: null,
    depends_on: [],
    milestone: null,
    specialty: null,
    fulfills: [],
    discoveredIssues: [],
    salientSummary: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Factory: Goal
// ---------------------------------------------------------------------------

export function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "01",
    title: "Test goal",
    description: "",
    status: "todo",
    acceptance: "",
    priority: 1,
    created: "2026-01-01T00:00:00Z",
    updated: "2026-01-01T00:00:00Z",
    assignee: null,
    specialty: null,
    milestone: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Factory: Mission
// ---------------------------------------------------------------------------

export function makeMission(overrides: Partial<Mission> = {}): Mission {
  return {
    title: "Test mission",
    description: "",
    status: "active",
    branch: null,
    milestones: [],
    created: "2026-01-01T00:00:00Z",
    updated: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Factory: PaneInfo
// ---------------------------------------------------------------------------

export function makePane(overrides: Partial<PaneInfo> = {}): PaneInfo {
  return {
    id: "%1",
    index: 0,
    title: "Agent 1",
    currentCommand: "zsh",
    width: 80,
    height: 24,
    active: false,
    role: null,
    name: null,
    type: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Factory: OrchestratorConfig
// ---------------------------------------------------------------------------

export function makeOrchestratorConfig(
  dir: string,
  overrides: Partial<OrchestratorConfig> = {},
): OrchestratorConfig {
  return {
    session: "test",
    dir,
    autoDispatch: true,
    stallTimeout: 300000,
    pollInterval: 5000,
    masterPane: "Master",
    beforeRun: null,
    afterRun: null,
    maxConcurrentAgents: 10,
    dispatchMode: "tasks",
    paneSpecialties: new Map(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Factory: OrchestratorState
// ---------------------------------------------------------------------------

export function makeOrchestratorState(
  overrides: Partial<OrchestratorState> = {},
): OrchestratorState {
  return {
    lastActivity: new Map(),
    previousTasks: new Map(),
    claimedTasks: new Set(),
    taskClaimTimes: new Map(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Factory: Mark
// ---------------------------------------------------------------------------

export function makeMark(overrides: Partial<Mark> = {}): Mark {
  return {
    id: "m1",
    kind: "authored" as MarkKind,
    by: "ai:test",
    at: "2026-01-01T00:00:00Z",
    range: { from: 0, to: 10 } as MarkRange,
    quote: "test quote",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// TestProject: temp directory with .tasks scaffolding
// ---------------------------------------------------------------------------

export class TestProject {
  readonly dir: string;

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), "tmux-ide-test-"));
  }

  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }

  initTasks(): void {
    ensureTasksDir(this.dir);
  }

  addTask(overrides: Partial<Task> = {}): Task {
    const task = makeTask(overrides);
    saveTask(this.dir, task);
    return task;
  }

  addGoal(overrides: Partial<Goal> = {}): Goal {
    const goal = makeGoal(overrides);
    saveGoal(this.dir, goal);
    return goal;
  }
}
