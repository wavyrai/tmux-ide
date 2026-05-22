import { resolve } from "node:path";
import { outputError } from "./lib/output.ts";
import type { ProofSchema } from "./types.ts";
import {
  ensureTasksDir,
  loadMission,
  saveMission,
  loadGoals,
  loadGoal,
  loadTasks,
  loadTask,
  saveTask,
  loadTasksForGoal,
  detectCycle,
  type Mission,
} from "./lib/task-store.ts";
import {
  areGoalTasksDone,
  clearMissionRecord,
  completeMissionPlanRecord,
  createGoalRecord,
  createMilestoneRecord,
  createTaskRecord,
  deleteGoalRecord,
  deleteTaskRecord,
  doneGoalRecord,
  doneTaskRecord,
  setMissionRecord,
  updateGoalRecord,
  updateMilestoneRecord,
  updateTaskRecord,
  claimTaskRecord,
} from "./lib/task-actions.ts";
import { isGhAvailable, createTaskPr } from "./lib/github-pr.ts";
import {
  loadValidationContract,
  loadValidationState,
  saveValidationState,
  checkCoverage,
  parseAssertionIds,
} from "./lib/validation.ts";
import { getSessionName, readConfig } from "./lib/yaml-io.ts";
import { getSessionState } from "@tmux-ide/tmux-bridge";
import { listSessionPanes } from "./widgets/lib/pane-comms.ts";
import { dispatchResearch, loadResearchState, type ResearchTrigger } from "./lib/research.ts";
import { type OrchestratorState } from "./lib/orchestrator.ts";
import { CliActionInvocationError, tryDispatchAction } from "./lib/cli-action-bridge.ts";

interface TaskCommandValues {
  title?: string;
  description?: string;
  acceptance?: string;
  priority?: string;
  status?: string;
  assign?: string;
  goal?: string;
  tags?: string;
  proof?: string;
  depends?: string;
  pr?: boolean;
  specialty?: string;
  milestone?: string;
  fulfills?: string;
  summary?: string;
  sequence?: string;
  evidence?: string;
}

function splitList(raw: string | undefined): string[] | undefined {
  return raw
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function parsePriority(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = parseInt(raw, 10);
  return Number.isFinite(value) ? value : undefined;
}

function printActionError(err: unknown): void {
  if (err instanceof CliActionInvocationError) {
    outputError(err.message, err.code.toUpperCase());
  }
  throw err;
}

async function tryDispatchTaskAction(
  dir: string,
  {
    json,
    action,
    sub,
    args,
    values,
  }: {
    json: boolean;
    action: string;
    sub?: string;
    args: string[];
    values: TaskCommandValues;
  },
): Promise<boolean> {
  try {
    if (action === "task") {
      const id = args[0];
      if (sub === "create" && id) {
        const result = await tryDispatchAction(
          "task.create",
          {
            title: id,
            description: values.description,
            goalId: values.goal,
            priority: parsePriority(values.priority),
            assign: values.assign,
            tags: splitList(values.tags),
            depends: splitList(values.depends),
            milestone: values.milestone,
            specialty: values.specialty,
            fulfills: splitList(values.fulfills),
          },
          { cwd: dir },
        );
        if (!result) return false;
        if (json) console.log(JSON.stringify(result.task, null, 2));
        else console.log(`Created task ${result.taskId}: ${result.task.title}`);
        return true;
      }

      if (sub === "update" && id) {
        const result = await tryDispatchAction(
          "task.update",
          {
            taskId: id,
            status: values.status as "todo" | "in-progress" | "review" | "done" | undefined,
            assign: values.assign,
            description: values.description,
            priority: parsePriority(values.priority),
            tags: splitList(values.tags),
            goalId: values.goal,
            depends: splitList(values.depends),
            proof: values.proof,
            milestone: values.milestone,
            specialty: values.specialty,
            fulfills: splitList(values.fulfills),
          },
          { cwd: dir },
        );
        if (!result) return false;
        if (json) console.log(JSON.stringify(result.task, null, 2));
        else console.log(`Updated task ${id}`);
        return true;
      }

      if (sub === "claim" && id && values.assign) {
        const result = await tryDispatchAction(
          "task.claim",
          { taskId: id, assign: values.assign },
          { cwd: dir },
        );
        if (!result) return false;
        if (json) console.log(JSON.stringify(result.task, null, 2));
        else console.log(`Task ${id} claimed by ${values.assign}: ${result.task.title}`);
        return true;
      }

      if (sub === "done" && id) {
        const result = await tryDispatchAction(
          "task.done",
          { taskId: id, proof: values.proof },
          { cwd: dir },
        );
        if (!result) return false;
        if (json) console.log(JSON.stringify(result.task, null, 2));
        else console.log(`Task ${id} done: ${result.task.title}`);
        return true;
      }

      if (sub === "delete" && id) {
        const result = await tryDispatchAction("task.delete", { taskId: id }, { cwd: dir });
        if (!result) return false;
        if (json) console.log(JSON.stringify({ deleted: id }));
        else console.log(`Deleted task ${id}`);
        return true;
      }
    }

    if (action === "goal") {
      const id = args[0];
      if (sub === "create" && id) {
        const result = await tryDispatchAction(
          "goal.create",
          {
            title: id,
            priority: parsePriority(values.priority),
            acceptance: values.acceptance,
            description: values.description,
            milestone: values.milestone,
            specialty: values.specialty,
          },
          { cwd: dir },
        );
        if (!result) return false;
        if (json) console.log(JSON.stringify(result.goal, null, 2));
        else console.log(`Created goal ${result.goalId}: ${result.goal.title}`);
        return true;
      }

      if (sub === "update" && id) {
        const result = await tryDispatchAction(
          "goal.update",
          {
            goalId: id,
            status: values.status as "todo" | "in-progress" | "done" | undefined,
            description: values.description,
            acceptance: values.acceptance,
            priority: parsePriority(values.priority),
            milestone: values.milestone,
          },
          { cwd: dir },
        );
        if (!result) return false;
        if (json) console.log(JSON.stringify(result.goal, null, 2));
        else console.log(`Updated goal ${id}`);
        return true;
      }

      if (sub === "done" && id) {
        const result = await tryDispatchAction("goal.done", { goalId: id }, { cwd: dir });
        if (!result) return false;
        if (json) console.log(JSON.stringify(result.goal, null, 2));
        else console.log(`Goal ${id} marked done: ${result.goal.title}`);
        return true;
      }

      if (sub === "delete" && id) {
        const result = await tryDispatchAction("goal.delete", { goalId: id }, { cwd: dir });
        if (!result) return false;
        if (json) console.log(JSON.stringify({ deleted: id }));
        else console.log(`Deleted goal ${id}`);
        return true;
      }
    }

    if (action === "milestone") {
      const id = args[0];
      if (sub === "create" && id) {
        const sequence = parsePriority(values.sequence);
        const result = await tryDispatchAction(
          "milestone.create",
          { title: id, sequence, description: values.description },
          { cwd: dir },
        );
        if (!result) return false;
        if (json) console.log(JSON.stringify(result.milestone, null, 2));
        else
          console.log(
            `Created milestone ${result.milestoneId}: ${id} [${result.milestone.status}]`,
          );
        return true;
      }

      if (sub === "update" && id) {
        const result = await tryDispatchAction(
          "milestone.update",
          {
            milestoneId: id,
            status: values.status as "locked" | "active" | "validating" | "done" | undefined,
          },
          { cwd: dir },
        );
        if (!result) return false;
        if (json) console.log(JSON.stringify(result.milestone, null, 2));
        else console.log(`Updated milestone ${id}`);
        return true;
      }
    }

    if (action === "mission") {
      if (sub === "set" && args[0]) {
        const result = await tryDispatchAction(
          "mission.set",
          { title: args[0], description: values.description },
          { cwd: dir },
        );
        if (!result) return false;
        if (json) console.log(JSON.stringify(result.mission, null, 2));
        else console.log(`Mission set: ${result.mission.title}`);
        return true;
      }
      if (sub === "plan-complete") {
        const result = await tryDispatchAction("mission.planComplete", {}, { cwd: dir });
        if (!result) return false;
        saveMission(dir, result.mission);
        if (json) console.log(JSON.stringify(result.mission, null, 2));
        else console.log(`Mission "${result.mission.title}" planning complete — now active`);
        return true;
      }
      if (sub === "clear") {
        const result = await tryDispatchAction("mission.clear", {}, { cwd: dir });
        if (!result) return false;
        if (json) console.log(JSON.stringify(result));
        else console.log("Mission cleared");
        return true;
      }
    }

    if (action === "validate" && sub === "assert" && args[0] && values.status) {
      const result = await tryDispatchAction(
        "validation.assert",
        {
          assertId: args[0],
          status: values.status as "pending" | "passing" | "failing" | "blocked",
          evidence: values.evidence,
        },
        { cwd: dir },
      );
      if (!result) return false;
      if (json) console.log(JSON.stringify(result.assertion, null, 2));
      else console.log(`Assertion ${args[0]}: ${result.assertion.status}`);
      return true;
    }
  } catch (err) {
    printActionError(err);
  }

  return false;
}

export async function taskCommand(
  targetDir: string | undefined,
  {
    json = false,
    action,
    sub,
    args = [],
    values = {},
  }: {
    json?: boolean;
    action: string;
    sub?: string;
    args: string[];
    values?: TaskCommandValues;
  },
): Promise<void> {
  const dir = resolve(targetDir ?? ".");

  if (await tryDispatchTaskAction(dir, { json, action, sub, args, values })) return;

  switch (action) {
    case "mission":
      return handleMission(dir, sub, args, values, json);
    case "milestone":
      return handleMilestone(dir, sub, args, values, json);
    case "validate":
      return handleValidation(dir, sub, args, values, json);
    case "research":
      return handleResearch(dir, sub, args, json);
    case "goal":
      return handleGoal(dir, sub, args, values, json);
    case "task":
      return handleTask(dir, sub, args, values, json);
    default:
      outputError(`Unknown action: ${action}`, "USAGE");
  }
}

function emptyOrchestratorState(): OrchestratorState {
  return {
    lastActivity: new Map(),
    previousTasks: new Map(),
    claimedTasks: new Set(),
    taskClaimTimes: new Map(),
    inflightDispatches: new Map(),
    completedDispatches: new Set(),
    stallNudges: new Map(),
    totalDispatched: 0,
    totalCompleted: 0,
    totalFailed: 0,
    lastTickMs: 0,
    ticking: false,
    idleAgents: 0,
    queuedDispatches: 0,
    lastError: null,
    lastReconcileMs: 0,
  };
}

function handleResearch(dir: string, sub: string | undefined, args: string[], json: boolean): void {
  switch (sub) {
    case "status": {
      const researchState = loadResearchState(dir);
      const tasks = loadTasks(dir);
      const activeTask =
        researchState.activeResearchTaskId != null
          ? (tasks.find((task) => task.id === researchState.activeResearchTaskId) ?? null)
          : null;
      const recentFindings = tasks
        .filter((task) => task.tags.includes("research") && task.status === "done")
        .sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated))
        .slice(0, 5)
        .map((task) => ({
          id: task.id,
          title: task.title,
          updated: task.updated,
          type: task.tags.find((tag) => tag !== "research") ?? "research",
          summary: task.salientSummary,
        }));

      const payload = {
        activeTask,
        recentFindings,
        cooldowns: researchState.lastResearchAt,
        missionStartAnalyzed: researchState.missionStartAnalyzed,
        retryWindow: researchState.retryWindow,
      };

      if (json) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(
          `Active research task: ${activeTask ? `${activeTask.id} — ${activeTask.title}` : "none"}`,
        );
        console.log(`Mission start analyzed: ${researchState.missionStartAnalyzed ? "yes" : "no"}`);
        console.log(`Recent findings: ${recentFindings.length}`);
      }
      break;
    }

    case "trigger": {
      const type = args[0];
      if (!type) outputError("Usage: tmux-ide research trigger <type>", "USAGE");

      const { name: session } = getSessionName(dir);
      const sessionState = getSessionState(session);
      if (!sessionState.running) {
        outputError(`Session "${session}" is not running`, "SESSION_NOT_FOUND");
      }

      const panes = listSessionPanes(session);
      const tasks = loadTasks(dir);
      const researchState = loadResearchState(dir);
      let maxConcurrentAgents = 10;
      let masterPane: string | null = null;
      let researchEnabled = true;

      try {
        const { config } = readConfig(dir);
        maxConcurrentAgents = config.orchestrator?.max_concurrent_agents ?? 10;
        masterPane = config.orchestrator?.master_pane ?? null;
        researchEnabled = config.orchestrator?.research?.enabled ?? true;
      } catch {
        // Fall back to defaults when ide.yml is unreadable
      }

      const task = dispatchResearch(
        {
          session,
          dir,
          masterPane,
          maxConcurrentAgents,
          research: { enabled: researchEnabled },
        },
        emptyOrchestratorState(),
        researchState,
        tasks,
        panes,
        {
          type,
          reason: `Manual research trigger: ${type}`,
        } satisfies ResearchTrigger,
      );

      if (!task) {
        outputError(`Unable to dispatch research trigger "${type}"`, "CONFLICT");
      }

      if (json) {
        console.log(JSON.stringify(task, null, 2));
      } else {
        console.log(`Dispatched research task ${task.id}: ${task.title}`);
      }
      break;
    }

    case "help":
    case undefined:
      console.log(`Usage: tmux-ide research <status|trigger>

  status                         Show research agent state
  trigger <type>                 Manually dispatch a research task`);
      break;
    default:
      outputError(
        "Usage: tmux-ide research <status|trigger>\nRun: tmux-ide research help",
        "USAGE",
      );
  }
}

// --- Mission ---

function handleMission(
  dir: string,
  sub: string | undefined,
  args: string[],
  values: TaskCommandValues,
  json: boolean,
): void {
  switch (sub) {
    case "set": {
      const title = args[0];
      if (!title) outputError('Usage: tmux-ide mission set "title"', "USAGE");
      const { mission } = setMissionRecord(dir, { title, description: values.description });
      if (json) {
        console.log(JSON.stringify(mission, null, 2));
      } else {
        console.log(`Mission set: ${title}`);
      }
      break;
    }
    case "create": {
      const title = args[0];
      if (!title) outputError('Usage: tmux-ide mission create "title" [-d "description"]', "USAGE");
      ensureTasksDir(dir);
      const now = new Date().toISOString();
      const mission: Mission = {
        title,
        description: values.description ?? "",
        status: "planning",
        branch: null,
        milestones: [],
        created: now,
        updated: now,
      };
      saveMission(dir, mission);
      if (json) {
        console.log(JSON.stringify(mission, null, 2));
      } else {
        console.log(`Mission created (planning): ${title}`);
      }
      break;
    }
    case "plan-complete": {
      const { mission, coverageGaps } = completeMissionPlanRecord(dir);
      const first = [...mission.milestones].sort((a, b) => a.order - b.order)[0] ?? null;
      if (json) {
        console.log(JSON.stringify({ ...mission, coverageGaps }, null, 2));
      } else {
        console.log(`Mission "${mission.title}" planning complete — now active`);
        if (first) console.log(`  Activated milestone: ${first.id} — ${first.title}`);
        if (coverageGaps.length > 0) {
          console.log(
            `  Warning: ${coverageGaps.length} assertion(s) not claimed by any task: ${coverageGaps.join(", ")}`,
          );
        }
      }
      break;
    }
    case "show": {
      const mission = loadMission(dir);
      if (!mission) outputError('No mission set. Run: tmux-ide mission set "..."', "NOT_FOUND");
      if (json) {
        console.log(JSON.stringify(mission, null, 2));
      } else {
        console.log(`Mission: ${mission.title}`);
        if (mission.description) console.log(`  ${mission.description}`);
      }
      break;
    }
    case "status": {
      const mission = loadMission(dir);
      if (!mission) outputError("No mission set", "NOT_FOUND");
      const tasks = loadTasks(dir);
      const doneMilestones = mission.milestones.filter((m) => m.status === "done").length;
      const totalMilestones = mission.milestones.length;
      const doneTasks = tasks.filter((t) => t.status === "done").length;
      const totalTasks = tasks.length;
      const valState = loadValidationState(dir);
      const assertions = valState ? Object.values(valState.assertions) : [];
      const passingCount = assertions.filter((a) => a.status === "passing").length;
      const failingCount = assertions.filter((a) => a.status === "failing").length;
      const pendingCount = assertions.filter((a) => a.status === "pending").length;
      if (json) {
        console.log(
          JSON.stringify(
            {
              title: mission.title,
              status: mission.status,
              milestones: { done: doneMilestones, total: totalMilestones },
              tasks: { done: doneTasks, total: totalTasks },
              validation: { passing: passingCount, failing: failingCount, pending: pendingCount },
            },
            null,
            2,
          ),
        );
      } else {
        console.log(`Mission: ${mission.title} [${mission.status}]`);
        console.log(`  Milestones: ${doneMilestones}/${totalMilestones} done`);
        console.log(`  Tasks: ${doneTasks}/${totalTasks} done`);
        if (assertions.length > 0) {
          console.log(
            `  Validation: ${passingCount} passing, ${failingCount} failing, ${pendingCount} pending`,
          );
        }
      }
      break;
    }
    case "clear": {
      clearMissionRecord(dir);
      if (json) {
        console.log(JSON.stringify({ cleared: true }));
      } else {
        console.log("Mission cleared");
      }
      break;
    }
    case "help":
    case undefined:
      console.log(`Usage: tmux-ide mission <set|create|show|status|plan-complete|clear>

  set "title"  [-d "description"]   Set mission (status: active)
  create "title" [-d "description"] Create mission (status: planning)
  show                              Show current mission
  status                            Show mission progress
  plan-complete                     Signal planning is done
  clear                             Clear the mission`);
      break;
    default:
      outputError(
        "Usage: tmux-ide mission <set|create|show|status|plan-complete|clear>\nRun: tmux-ide mission help",
        "USAGE",
      );
  }
}

// --- Milestone ---

function handleMilestone(
  dir: string,
  sub: string | undefined,
  args: string[],
  values: TaskCommandValues,
  json: boolean,
): void {
  switch (sub) {
    case "create": {
      const title = args[0];
      if (!title) outputError('Usage: tmux-ide milestone create "title" --sequence N', "USAGE");
      const sequence = parseInt(values.sequence ?? "0", 10) || undefined;
      const { milestone } = createMilestoneRecord(dir, {
        title,
        description: values.description ?? "",
        sequence,
      });
      if (json) {
        console.log(JSON.stringify(milestone, null, 2));
      } else {
        console.log(`Created milestone ${milestone.id}: ${title} [${milestone.status}]`);
      }
      break;
    }
    case "list": {
      const mission = loadMission(dir);
      if (!mission) outputError("No mission set", "NOT_FOUND");
      const tasks = loadTasks(dir);
      const milestones = [...mission.milestones].sort((a, b) => a.order - b.order);
      if (json) {
        const data = milestones.map((m) => {
          const mTasks = tasks.filter((t) => t.milestone === m.id);
          const done = mTasks.filter((t) => t.status === "done").length;
          return { ...m, taskCount: mTasks.length, tasksDone: done };
        });
        console.log(JSON.stringify(data, null, 2));
      } else if (milestones.length === 0) {
        console.log('No milestones. Run: tmux-ide milestone create "title" --sequence N');
      } else {
        for (const m of milestones) {
          const mTasks = tasks.filter((t) => t.milestone === m.id);
          const done = mTasks.filter((t) => t.status === "done").length;
          console.log(`  ${m.id}  [${m.status}]  ${m.title}  (${done}/${mTasks.length} tasks)`);
        }
      }
      break;
    }
    case "show": {
      const id = args[0];
      if (!id) outputError("Usage: tmux-ide milestone show <id>", "USAGE");
      const mission = loadMission(dir);
      if (!mission) outputError("No mission set", "NOT_FOUND");
      const milestone = mission.milestones.find((m) => m.id === id);
      if (!milestone) outputError(`Milestone ${id} not found`, "NOT_FOUND");
      const tasks = loadTasks(dir).filter((t) => t.milestone === id);
      if (json) {
        console.log(JSON.stringify({ milestone, tasks }, null, 2));
      } else {
        console.log(`Milestone ${milestone.id}: ${milestone.title}`);
        console.log(`  Status: ${milestone.status}`);
        console.log(`  Order: ${milestone.order}`);
        if (milestone.description) console.log(`  Description: ${milestone.description}`);
        if (tasks.length > 0) {
          console.log(`  Tasks:`);
          for (const t of tasks) {
            console.log(`    ${t.id}  [${t.status}]  ${t.title}`);
          }
        }
      }
      break;
    }
    case "update": {
      const id = args[0];
      if (!id) outputError("Usage: tmux-ide milestone update <id> --status <status>", "USAGE");
      const { milestone } = updateMilestoneRecord(dir, {
        milestoneId: id,
        status: values.status,
        description: values.description,
      });
      if (json) {
        console.log(JSON.stringify(milestone, null, 2));
      } else {
        console.log(`Updated milestone ${id}`);
      }
      break;
    }
    case "help":
    case undefined:
      console.log(`Usage: tmux-ide milestone <create|list|show|update>

  create "title" [--sequence N] [-d "desc"]   Create a milestone
  list                                         List milestones
  show <id>                                    Show milestone with tasks
  update <id> [--status active|done|locked]    Update milestone`);
      break;
    default:
      outputError(
        "Usage: tmux-ide milestone <create|list|show|update>\nRun: tmux-ide milestone help",
        "USAGE",
      );
  }
}

// --- Validation ---

function handleValidation(
  dir: string,
  sub: string | undefined,
  args: string[],
  values: TaskCommandValues,
  json: boolean,
): void {
  switch (sub) {
    case "show": {
      const contract = loadValidationContract(dir);
      const state = loadValidationState(dir);
      if (json) {
        console.log(JSON.stringify({ contract: contract ?? null, state: state ?? null }, null, 2));
      } else {
        if (contract) {
          console.log("Validation Contract:");
          console.log(contract);
          console.log();
        } else {
          console.log("No validation contract found (.tasks/validation-contract.md)");
        }
        if (state && Object.keys(state.assertions).length > 0) {
          console.log("Assertion Status:");
          for (const [id, entry] of Object.entries(state.assertions)) {
            const evidence = entry.evidence ? ` — ${entry.evidence}` : "";
            console.log(`  ${id}  [${entry.status}]${evidence}`);
          }
        } else {
          console.log("No assertion state yet.");
        }
      }
      break;
    }
    case "assert": {
      const assertionId = args[0];
      if (!assertionId || !values.status) {
        outputError(
          'Usage: tmux-ide validate assert <ASSERT_ID> --status passing|failing [--evidence "..."]',
          "USAGE",
        );
      }
      const status = values.status as "passing" | "failing" | "blocked";
      if (status !== "passing" && status !== "failing" && status !== "blocked") {
        outputError("Status must be 'passing', 'failing', or 'blocked'", "USAGE");
      }
      ensureTasksDir(dir);
      const state = loadValidationState(dir) ?? { assertions: {}, lastVerified: null };
      state.assertions[assertionId] = {
        status,
        verifiedBy: values.assign ?? null,
        verifiedAt: new Date().toISOString(),
        evidence: values.evidence ?? null,
        blockedBy: status === "blocked" ? (values.evidence ?? null) : null,
      };
      state.lastVerified = new Date().toISOString();
      saveValidationState(dir, state);
      if (json) {
        console.log(JSON.stringify({ assertionId, ...state.assertions[assertionId] }, null, 2));
      } else {
        console.log(
          `Assertion ${assertionId}: ${status}${values.evidence ? ` — ${values.evidence}` : ""}`,
        );
      }
      break;
    }
    case "report": {
      const state = loadValidationState(dir);
      if (!state || Object.keys(state.assertions).length === 0) {
        if (json) {
          console.log(JSON.stringify({ total: 0, passing: 0, failing: 0, pending: 0, blocked: 0 }));
        } else {
          console.log("No assertions to report.");
        }
        break;
      }
      const entries = Object.values(state.assertions);
      const report = {
        total: entries.length,
        passing: entries.filter((e) => e.status === "passing").length,
        failing: entries.filter((e) => e.status === "failing").length,
        pending: entries.filter((e) => e.status === "pending").length,
        blocked: entries.filter((e) => e.status === "blocked").length,
      };
      if (json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(`Validation Report: ${report.total} assertions`);
        console.log(`  Passing: ${report.passing}`);
        console.log(`  Failing: ${report.failing}`);
        console.log(`  Pending: ${report.pending}`);
        if (report.blocked > 0) console.log(`  Blocked: ${report.blocked}`);
      }
      break;
    }
    case "coverage": {
      const result = checkCoverage(dir);
      const contract = loadValidationContract(dir);
      const allIds = contract ? parseAssertionIds(contract) : [];
      const claimed = allIds.length - result.unclaimed.length;
      if (json) {
        console.log(
          JSON.stringify(
            {
              total: allIds.length,
              claimed,
              unclaimed: result.unclaimed,
              duplicates: result.duplicates,
            },
            null,
            2,
          ),
        );
      } else {
        console.log(`Assertion Coverage: ${claimed}/${allIds.length} claimed`);
        if (result.unclaimed.length > 0) {
          console.log(`  Unclaimed: ${result.unclaimed.join(", ")}`);
        }
        if (Object.keys(result.duplicates).length > 0) {
          console.log(`  Duplicate claims:`);
          for (const [id, taskIds] of Object.entries(result.duplicates)) {
            console.log(`    ${id}: tasks ${taskIds.join(", ")}`);
          }
        }
        if (result.unclaimed.length === 0 && Object.keys(result.duplicates).length === 0) {
          console.log("  Full coverage — all assertions claimed.");
        }
      }
      break;
    }
    case "help":
    case undefined:
      console.log(`Usage: tmux-ide validate <show|assert|report|coverage>

  show                                                       Show contract + assertion state
  assert <ID> --status passing|failing|blocked [--evidence]  Update assertion status
  report                                                     Summary of assertion results
  coverage                                                   Check assertion coverage`);
      break;
    default:
      outputError(
        "Usage: tmux-ide validate <show|assert|report|coverage>\nRun: tmux-ide validate help",
        "USAGE",
      );
  }
}

// --- Goal ---

function handleGoal(
  dir: string,
  sub: string | undefined,
  args: string[],
  values: TaskCommandValues,
  json: boolean,
): void {
  switch (sub) {
    case "list": {
      const goals = loadGoals(dir);
      if (json) {
        console.log(JSON.stringify(goals, null, 2));
      } else if (goals.length === 0) {
        console.log('No goals. Run: tmux-ide goal create "..."');
      } else {
        for (const g of goals) {
          const tasks = loadTasksForGoal(dir, g.id);
          const done = tasks.filter((t) => t.status === "done").length;
          console.log(`  ${g.id}  [${g.status}]  ${g.title}  (${done}/${tasks.length} tasks)`);
        }
      }
      break;
    }
    case "create": {
      const title = args[0];
      if (!title) outputError('Usage: tmux-ide goal create "title"', "USAGE");
      const { goal, goalId } = createGoalRecord(dir, {
        title,
        description: values.description ?? "",
        acceptance: values.acceptance ?? "",
        priority: parseInt(values.priority ?? "2", 10),
        specialty: values.specialty ?? null,
        milestone: values.milestone ?? null,
      });
      if (json) {
        console.log(JSON.stringify(goal, null, 2));
      } else {
        console.log(`Created goal ${goalId}: ${title}`);
      }
      break;
    }
    case "update": {
      const id = args[0];
      if (!id) outputError("Usage: tmux-ide goal update <id>", "USAGE");
      const { goal } = updateGoalRecord(dir, {
        goalId: id,
        status: values.status,
        description: values.description,
        acceptance: values.acceptance,
        priority: values.priority ? parseInt(values.priority, 10) : undefined,
        milestone: values.milestone,
      });
      if (json) {
        console.log(JSON.stringify(goal, null, 2));
      } else {
        console.log(`Updated goal ${id}`);
      }
      break;
    }
    case "done": {
      const id = args[0];
      if (!id) outputError("Usage: tmux-ide goal done <id>", "USAGE");
      const { goal } = doneGoalRecord(dir, id);
      if (json) {
        console.log(JSON.stringify(goal, null, 2));
      } else {
        console.log(`Goal ${id} marked done: ${goal.title}`);
      }
      break;
    }
    case "show": {
      const id = args[0];
      if (!id) outputError("Usage: tmux-ide goal show <id>", "USAGE");
      const goal = loadGoal(dir, id);
      if (!goal) outputError(`Goal ${id} not found`, "NOT_FOUND");
      const tasks = loadTasksForGoal(dir, id);
      if (json) {
        console.log(JSON.stringify({ goal, tasks }, null, 2));
      } else {
        console.log(`Goal ${goal.id}: ${goal.title}`);
        console.log(`  Status: ${goal.status}`);
        if (goal.acceptance) console.log(`  Acceptance: ${goal.acceptance}`);
        if (tasks.length > 0) {
          console.log(`  Tasks:`);
          for (const t of tasks) {
            console.log(`    ${t.id}  [${t.status}]  ${t.title}`);
          }
        }
      }
      break;
    }
    case "delete": {
      const id = args[0];
      if (!id) outputError("Usage: tmux-ide goal delete <id>", "USAGE");
      deleteGoalRecord(dir, id);
      if (json) {
        console.log(JSON.stringify({ deleted: id }));
      } else {
        console.log(`Deleted goal ${id}`);
      }
      break;
    }
    case "help":
    case undefined:
      console.log(`Usage: tmux-ide goal <list|create|update|done|show|delete>

  list                                 List all goals
  create "title" [-p N] [-d "desc"]    Create a goal
  update <id> [-s status] [-p N]       Update a goal
  done <id>                            Mark goal complete
  show <id>                            Show goal with tasks
  delete <id>                          Delete a goal`);
      break;
    default:
      outputError(
        "Usage: tmux-ide goal <list|create|update|done|show|delete>\nRun: tmux-ide goal help",
        "USAGE",
      );
  }
}

// --- Task ---

function handleTask(
  dir: string,
  sub: string | undefined,
  args: string[],
  values: TaskCommandValues,
  json: boolean,
): void {
  switch (sub) {
    case "init": {
      ensureTasksDir(dir);
      if (json) {
        console.log(JSON.stringify({ initialized: true }));
      } else {
        console.log("Initialized .tasks/ directory");
      }
      break;
    }
    case "list": {
      let tasks = loadTasks(dir);
      const allTasks = tasks; // keep full list for dependency checks
      if (values.status) tasks = tasks.filter((t) => t.status === values.status);
      if (values.goal) tasks = tasks.filter((t) => t.goal === values.goal);
      tasks.sort((a, b) => a.priority - b.priority);
      if (json) {
        console.log(JSON.stringify(tasks, null, 2));
      } else if (tasks.length === 0) {
        console.log('No tasks. Run: tmux-ide task create "title"');
      } else {
        // Build goal name map for display
        const goals = loadGoals(dir);
        const goalNames = new Map(goals.map((g) => [g.id, g.title]));

        for (const t of tasks) {
          // Check if blocked by unfinished dependencies
          const blocked =
            t.depends_on.length > 0 &&
            t.depends_on.some((depId) => {
              const dep = allTasks.find((d) => d.id === depId);
              return !dep || dep.status !== "done";
            });

          const status = blocked ? "blocked" : t.status;
          const assignee = t.assignee ? ` @${t.assignee}` : "";
          const goalLabel = t.goal ? ` (${goalNames.get(t.goal) ?? `goal ${t.goal}`})` : "";
          const deps = blocked ? ` (depends: ${t.depends_on.join(", ")})` : "";
          console.log(`  ${t.id}  [${status}]  ${t.title}${assignee}${goalLabel}${deps}`);
        }
      }
      break;
    }
    case "create": {
      const title = args[0];
      if (!title)
        outputError(
          'Missing title. Usage:\n  tmux-ide task create "Fix the auth bug" -g 01 -p 1 -d "Token storage issue"',
          "USAGE",
        );
      const { task, taskId } = createTaskRecord(dir, {
        title,
        description: values.description ?? "",
        goalId: values.goal ?? null,
        assign: values.assign ?? null,
        priority: parseInt(values.priority ?? "2", 10),
        tags: values.tags,
        depends: values.depends,
        milestone: values.milestone ?? null,
        specialty: values.specialty ?? null,
        fulfills: values.fulfills,
      });
      if (json) {
        console.log(JSON.stringify(task, null, 2));
      } else {
        console.log(`Created task ${taskId}: ${title}`);
      }
      break;
    }
    case "update": {
      const id = args[0];
      if (!id) outputError("Usage: tmux-ide task update <id>", "USAGE");
      const { task } = updateTaskRecord(dir, {
        taskId: id,
        status: values.status,
        assign: values.assign,
        description: values.description,
        priority: values.priority ? parseInt(values.priority, 10) : undefined,
        tags: values.tags,
        goalId: values.goal,
        depends: values.depends,
        proof: values.proof,
        milestone: values.milestone,
        specialty: values.specialty,
        fulfills: values.fulfills,
      });
      if (json) {
        console.log(JSON.stringify(task, null, 2));
      } else {
        console.log(`Updated task ${id}`);
      }
      break;
    }
    case "done": {
      const id = args[0];
      if (!id) outputError("Usage: tmux-ide task done <id>", "USAGE");
      const { task } = doneTaskRecord(dir, id, values.proof);
      if (values.summary) {
        updateTaskRecord(dir, { taskId: id, summary: values.summary });
        task.salientSummary = values.summary;
      }

      // Auto-create GitHub PR if --pr flag is set
      let prWarning: string | undefined;
      if (values.pr) {
        if (isGhAvailable()) {
          const pr = createTaskPr(task, dir);
          if (pr) {
            if (!task.proof) task.proof = {};
            (task.proof as ProofSchema).pr = {
              number: pr.number,
              url: pr.url,
              status: "open",
            };
            if (!json) console.log(`PR created: ${pr.url}`);
          } else {
            prWarning = "PR creation failed (gh error)";
            console.error(`Warning: ${prWarning}`);
          }
        } else {
          prWarning = "gh CLI not found, skipping PR creation";
          console.error(`Warning: ${prWarning}`);
        }
      }

      saveTask(dir, task);
      if (json) {
        const output: Record<string, unknown> = { ...task };
        if (prWarning) output.prError = prWarning;
        console.log(JSON.stringify(output, null, 2));
      } else {
        console.log(`Task ${id} done: ${task.title}`);
      }
      // Check if all tasks for this goal are done
      if (task.goal && areGoalTasksDone(dir, task.goal)) {
        if (!json) {
          console.log(
            `All tasks for goal ${task.goal} are done. Run: tmux-ide goal done ${task.goal}`,
          );
        }
      }
      break;
    }
    case "claim": {
      const id = args[0];
      if (!id) outputError("Usage: tmux-ide task claim <id>", "USAGE");
      const { task } = claimTaskRecord(dir, id, values.assign ?? "");
      if (json) {
        console.log(JSON.stringify(task, null, 2));
      } else {
        const who = task.assignee ? ` by ${task.assignee}` : "";
        console.log(`Task ${id} claimed${who}: ${task.title}`);
      }
      break;
    }
    case "show": {
      const id = args[0];
      if (!id) outputError("Usage: tmux-ide task show <id>", "USAGE");
      const task = loadTask(dir, id);
      if (!task) outputError(`Task ${id} not found. Run: tmux-ide task list`, "NOT_FOUND");
      const mission = loadMission(dir);
      const goal = task.goal ? loadGoal(dir, task.goal) : null;
      if (json) {
        console.log(
          JSON.stringify({ mission: mission ?? null, goal: goal ?? null, task }, null, 2),
        );
      } else {
        if (mission) console.log(`Mission: ${mission.title}`);
        if (goal) {
          console.log(`Goal ${goal.id}: ${goal.title}`);
          if (goal.acceptance) console.log(`  Acceptance: ${goal.acceptance}`);
        }
        console.log(`Task ${task.id}: ${task.title}`);
        console.log(`  Status: ${task.status}`);
        if (task.description) console.log(`  Description: ${task.description}`);
        if (task.assignee) console.log(`  Assignee: ${task.assignee}`);
        if (task.tags.length > 0) console.log(`  Tags: ${task.tags.join(", ")}`);
        if (task.depends_on.length > 0) console.log(`  Depends on: ${task.depends_on.join(", ")}`);
        if (task.proof) console.log(`  Proof: ${JSON.stringify(task.proof)}`);
      }
      break;
    }
    case "edit": {
      const id = args[0];
      if (!id)
        outputError("Usage: tmux-ide task edit <id> --title 'new title' -d 'new desc'", "USAGE");
      const task = loadTask(dir, id);
      if (!task) outputError(`Task ${id} not found. Run: tmux-ide task list`, "NOT_FOUND");
      if (values.title) task.title = values.title;
      if (values.description) task.description = values.description;
      if (values.priority) task.priority = parseInt(values.priority, 10);
      if (values.tags) task.tags = values.tags.split(",").map((t) => t.trim());
      if (values.goal) task.goal = values.goal;
      if (values.depends) {
        const newDeps = values.depends.split(",").map((d) => d.trim());
        const cycle = detectCycle(dir, task.id, newDeps);
        if (cycle) {
          outputError(`Dependency cycle detected: ${cycle.join(" -> ")}`, "CYCLE");
          return;
        }
        task.depends_on = newDeps;
      }
      task.updated = new Date().toISOString();
      saveTask(dir, task);
      if (json) {
        console.log(JSON.stringify(task, null, 2));
      } else {
        console.log(`Edited task ${id}: ${task.title}`);
      }
      break;
    }
    case "unassign": {
      const id = args[0];
      if (!id) outputError("Usage: tmux-ide task unassign <id>", "USAGE");
      const task = loadTask(dir, id);
      if (!task) outputError(`Task ${id} not found. Run: tmux-ide task list`, "NOT_FOUND");
      task.assignee = null;
      task.status = "todo";
      task.updated = new Date().toISOString();
      saveTask(dir, task);
      if (json) {
        console.log(JSON.stringify(task, null, 2));
      } else {
        console.log(`Task ${id} unassigned, status reset to todo: ${task.title}`);
      }
      break;
    }
    case "delete": {
      const id = args[0];
      if (!id) outputError("Usage: tmux-ide task delete <id>", "USAGE");
      deleteTaskRecord(dir, id);
      if (json) {
        console.log(JSON.stringify({ deleted: id }));
      } else {
        console.log(`Deleted task ${id}`);
      }
      break;
    }
    case "help":
    case undefined:
      console.log(`Usage: tmux-ide task <subcommand>

  init                                     Initialize .tasks/ directory
  list [-s status] [-g goalId] [--json]    List tasks
  create "title" [-g id] [-p N] [-d ...]   Create a task
  edit <id> [--title ...] [-d ...] [-p N]  Edit task fields
  update <id> [-s status] [-a name]        Update task status/assignee
  done <id> [--proof "..."]                Mark task complete
  claim <id> [-a name]                     Claim and start a task
  unassign <id>                            Unassign and reset to todo
  show <id> [--json]                       Show task with full context
  delete <id>                              Delete a task

Short flags: -p priority, -g goal, -d description, -a assign,
             -s status, -t tags, -b branch`);
      break;
    default:
      outputError(`Unknown subcommand: ${sub}\nRun: tmux-ide task help`, "USAGE");
  }
}
