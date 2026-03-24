import { execFileSync } from "node:child_process";
import type { Task } from "./task-store.ts";
import type { ProofSchema } from "../types.ts";

export interface PrResult {
  url: string;
  number: number;
}

/**
 * Check if the gh CLI is available.
 */
export function isGhAvailable(): boolean {
  try {
    execFileSync("gh", ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a GitHub PR for a completed task.
 * Returns the PR URL and number, or null if creation failed.
 */
export function createTaskPr(task: Task, cwd: string, baseBranch?: string): PrResult | null {
  if (!task.branch) return null;

  // Build PR body
  const bodyParts: string[] = [];
  if (task.description) bodyParts.push(task.description);
  if (task.proof) {
    bodyParts.push("");
    bodyParts.push("## Proof");
    const proof = task.proof as ProofSchema;
    if (proof.notes) bodyParts.push(proof.notes);
    if (proof.tests) bodyParts.push(`Tests: ${proof.tests.passed}/${proof.tests.total} passed`);
    if (proof.ci)
      bodyParts.push(`CI: ${proof.ci.status}${proof.ci.url ? ` (${proof.ci.url})` : ""}`);
  }
  if (task.tags.length > 0) {
    bodyParts.push("");
    bodyParts.push(`Tags: ${task.tags.join(", ")}`);
  }

  const title = `Task ${task.id}: ${task.title}`;
  const body = bodyParts.join("\n") || task.title;

  try {
    // Push the branch first (gh pr create needs it on remote)
    try {
      execFileSync("git", ["push", "-u", "origin", task.branch], {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      // Branch may already be pushed, or remote may not exist — continue anyway
    }

    // Create the PR
    const output = execFileSync(
      "gh",
      [
        "pr",
        "create",
        "--title",
        title,
        "--body",
        body,
        "--head",
        task.branch,
        ...(baseBranch ? ["--base", baseBranch] : []),
      ],
      {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();

    // gh pr create outputs the PR URL
    const url = output;
    // Extract PR number from URL (e.g. https://github.com/owner/repo/pull/42)
    const match = url.match(/\/pull\/(\d+)/);
    const number = match ? parseInt(match[1]!, 10) : 0;

    return { url, number };
  } catch {
    return null;
  }
}
