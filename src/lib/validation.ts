import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { loadTasks } from "./task-store.ts";

export interface AssertionEntry {
  status: "pending" | "passing" | "failing" | "blocked";
  verifiedBy: string | null;
  verifiedAt: string | null;
  evidence: string | null;
  blockedBy: string | null;
}

export interface ValidationState {
  assertions: Record<string, AssertionEntry>;
  lastVerified: string | null;
}

const TASKS_DIR = ".tasks";

/**
 * Read the validation contract markdown file.
 * Returns the file contents, or null if it doesn't exist.
 */
export function loadValidationContract(dir: string): string | null {
  const path = join(dir, TASKS_DIR, "validation-contract.md");
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}

/**
 * Read the validation state JSON file.
 * Returns the parsed state, or null if it doesn't exist or is corrupted.
 */
export function loadValidationState(dir: string): ValidationState | null {
  const path = join(dir, TASKS_DIR, "validation-state.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ValidationState;
  } catch {
    return null;
  }
}

/**
 * Write the validation state JSON file atomically.
 */
export function saveValidationState(dir: string, state: ValidationState): void {
  const path = join(dir, TASKS_DIR, "validation-state.json");
  const tmpPath = path + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmpPath, path);
}

/**
 * Check if all assertions in a validation state are passing.
 */
export function isAllPassing(state: ValidationState): boolean {
  const entries = Object.values(state.assertions);
  if (entries.length === 0) return false;
  return entries.every((e) => e.status === "passing");
}

/**
 * Get the IDs of all failing or blocked assertions.
 */
export function getFailedAssertions(state: ValidationState): string[] {
  return Object.entries(state.assertions)
    .filter(([, e]) => e.status === "failing" || e.status === "blocked")
    .map(([id]) => id);
}

// --- Coverage invariant ---

const ASSERTION_ID_PATTERN = /\*\*((?:VAL|ASSERT)[A-Z0-9_-]+)\*\*/g;

/**
 * Parse assertion IDs from a validation contract markdown.
 * Matches bold-wrapped IDs like **VAL-AUTH-001** or **ASSERT01**.
 */
export function parseAssertionIds(contract: string): string[] {
  const ids = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = ASSERTION_ID_PATTERN.exec(contract)) !== null) {
    ids.add(match[1]!);
  }
  return [...ids];
}

/**
 * Check coverage: every assertion in the contract should be claimed
 * by at least one task's fulfills.
 */
export function checkCoverage(dir: string): {
  unclaimed: string[];
  duplicates: Record<string, string[]>;
} {
  const contract = loadValidationContract(dir);
  if (!contract) return { unclaimed: [], duplicates: {} };

  const assertionIds = parseAssertionIds(contract);
  if (assertionIds.length === 0) return { unclaimed: [], duplicates: {} };

  const tasks = loadTasks(dir);
  const claimMap = new Map<string, string[]>();

  for (const task of tasks) {
    for (const id of task.fulfills) {
      const existing = claimMap.get(id) ?? [];
      existing.push(task.id);
      claimMap.set(id, existing);
    }
  }

  const unclaimed = assertionIds.filter((id) => !claimMap.has(id));
  const duplicates: Record<string, string[]> = {};
  for (const [id, taskIds] of claimMap) {
    if (taskIds.length > 1 && assertionIds.includes(id)) {
      duplicates[id] = taskIds;
    }
  }

  return { unclaimed, duplicates };
}
