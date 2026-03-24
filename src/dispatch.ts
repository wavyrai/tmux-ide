import { resolve, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { loadMission, loadGoal, loadTask } from "./lib/task-store.ts";
import { IdeError } from "./lib/errors.ts";

interface DispatchOptions {
  taskId: string;
  json?: boolean;
}

/**
 * Print task dispatch context to stdout so agents can read it directly.
 *
 * 1. If a dispatch file exists (.tasks/dispatch/{id}.md), print it.
 * 2. Otherwise, build the context from the task store (mission + goal + task).
 * 3. In JSON mode, output a structured object.
 * 4. Always end with the completion command hint.
 */
export async function dispatch(
  targetDir: string | null | undefined,
  opts: DispatchOptions,
): Promise<void> {
  const dir = resolve(targetDir ?? ".");
  const { taskId, json } = opts;

  if (!taskId) {
    throw new IdeError("Missing task ID. Usage: tmux-ide dispatch <id>", {
      code: "USAGE",
    });
  }

  // Try dispatch file first
  const dispatchFile = join(dir, ".tasks", "dispatch", `${taskId}.md`);
  const hasDispatchFile = existsSync(dispatchFile);

  // Always load the task for structured data
  const task = loadTask(dir, taskId);
  if (!task && !hasDispatchFile) {
    throw new IdeError(`Task "${taskId}" not found and no dispatch file exists`, {
      code: "TASK_NOT_FOUND",
    });
  }

  // Load mission and goal context
  const mission = loadMission(dir);
  const goal = task?.goal ? loadGoal(dir, task.goal) : null;

  if (json) {
    const prompt = hasDispatchFile ? readFileSync(dispatchFile, "utf-8") : buildPrompt(dir, task!);
    const result: Record<string, unknown> = {
      task: task ?? null,
      mission: mission ?? null,
      goal: goal ?? null,
      prompt,
      worktree: task?.branch ? `task/${taskId}-worktree` : null,
      branch: task?.branch ?? null,
    };
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Text mode: print the readable prompt
  if (hasDispatchFile) {
    const content = readFileSync(dispatchFile, "utf-8");
    console.log(content);
  } else {
    console.log(buildPrompt(dir, task!));
  }

  // Always print the completion hint
  console.log("");
  console.log(`When done: tmux-ide task done ${taskId} --proof "what you did"`);
}

/**
 * Build a human-readable prompt from the task store.
 * Mirrors the logic of buildTaskPrompt() in orchestrator.ts but without
 * requiring a worktree path (the task may already have a branch assigned).
 */
function buildPrompt(dir: string, task: NonNullable<ReturnType<typeof loadTask>>): string {
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
  if (task.branch) prompt += `\nBranch: ${task.branch}\n`;

  return prompt.trim();
}
