import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";

export interface AssertionEntry {
  status: "pending" | "passing" | "failing";
  verifiedBy: string | null;
  verifiedAt: string | null;
  evidence: string | null;
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
 * Get the IDs of all failing assertions.
 */
export function getFailedAssertions(state: ValidationState): string[] {
  return Object.entries(state.assertions)
    .filter(([, e]) => e.status === "failing")
    .map(([id]) => id);
}
