import { resolve } from "node:path";
import { readConfig } from "./lib/yaml-io.ts";
import { outputError } from "./lib/output.ts";
import { IdeConfigSchema } from "./schemas/ide-config.ts";

/** Minimal shape of Zod parse issues (v3/v4 compatible for our mappers). */
interface ZodLikeIssue {
  path?: (string | number)[];
  code?: string;
  message?: string;
  expected?: string;
  received?: string;
}

export function validateConfig(config: unknown): string[] {
  if (config == null || typeof config !== "object" || Array.isArray(config)) {
    return ["config must be an object"];
  }

  const result = IdeConfigSchema.safeParse(config);

  if (!result.success) {
    return result.error.issues.map((issue) => mapZodIssue(issue as ZodLikeIssue, config));
  }

  // Phase 2: semantic checks (only when schema parse succeeds)
  const errors: string[] = [];
  const cfg = result.data;

  // 1. Row sizes sum ≤ 100%
  const rowSizes = cfg.rows.filter((r) => r.size !== undefined).map((r) => parseInt(r.size!, 10));
  const rowSum = rowSizes.reduce((a, b) => a + b, 0);
  if (rowSum > 100) {
    errors.push(`Row sizes sum to ${rowSum}%, which exceeds 100%`);
  }

  for (let i = 0; i < cfg.rows.length; i++) {
    const row = cfg.rows[i]!;

    // 2. Per-row pane sizes sum ≤ 100%
    const paneSizes = row.panes
      .filter((p) => p.size !== undefined)
      .map((p) => parseInt(p.size!, 10));
    const paneSum = paneSizes.reduce((a, b) => a + b, 0);
    if (paneSum > 100) {
      errors.push(`Row ${i} pane sizes sum to ${paneSum}%, which exceeds 100%`);
    }

    // 3. Max 1 focus:true per row
    const focusCount = row.panes.filter((p) => p.focus === true).length;
    if (focusCount > 1) {
      errors.push(`Row ${i} has ${focusCount} panes with focus: true (max 1)`);
    }

    // 4. type and command cannot coexist
    for (let j = 0; j < row.panes.length; j++) {
      const pane = row.panes[j]!;
      if (pane.type !== undefined && pane.command !== undefined) {
        errors.push(`rows[${i}].panes[${j}] cannot have both 'type' and 'command'`);
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Zod issue → legacy error string mapping
// ---------------------------------------------------------------------------

function formatPath(path: (string | number)[]): string {
  let result = "";
  for (let i = 0; i < path.length; i++) {
    const seg = path[i]!;
    if (typeof seg === "number") {
      result += `[${seg}]`;
    } else if (i === 0) {
      result += seg;
    } else {
      result += `.${seg}`;
    }
  }
  return result;
}

function shouldQuote(path: (string | number)[]): boolean {
  if (path.length === 1 && typeof path[0] === "string") return true;
  if (path[0] === "team") return true;
  return false;
}

function isSizePath(path: (string | number)[]): boolean {
  return path[path.length - 1] === "size";
}

function isEnvValuePath(path: (string | number)[]): boolean {
  const envIdx = path.indexOf("env");
  return envIdx >= 0 && envIdx < path.length - 1;
}

function getValueAtPath(obj: unknown, path: (string | number)[]): unknown {
  let current: unknown = obj;
  for (const seg of path) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[String(seg)];
  }
  return current;
}

const MS_FIELDS = new Set(["stall_timeout", "poll_interval"]);

function typeDesc(path: (string | number)[], expected: string): string {
  const base = expected.replace(/\s*\|\s*undefined/g, "").trim();
  let desc: string;
  if (base === "string") desc = "a string";
  else if (base === "boolean") desc = "a boolean";
  else if (base === "number") desc = "a number";
  else if (base === "array") desc = "an array";
  else if (base === "object" || base === "record") desc = "an object";
  else desc = base;

  const field = path[path.length - 1];
  if (path[0] === "orchestrator" && typeof field === "string" && MS_FIELDS.has(field)) {
    return `${desc} (ms)`;
  }
  return desc;
}

function mapZodIssue(issue: ZodLikeIssue, config: unknown): string {
  const path: (string | number)[] = issue.path ?? [];
  const code: string = issue.code ?? "";
  const rawPath = formatPath(path);
  const display = shouldQuote(path) ? `'${rawPath}'` : rawPath;
  const lastSeg = path[path.length - 1];

  // Env value: rows[i].panes[j].env.KEY
  if (isEnvValuePath(path)) {
    return `${formatPath(path)} must be a string or number`;
  }

  // Size field: regex or refine failure (but not a type error like size: 42)
  if (isSizePath(path) && code !== "invalid_type") {
    if (code === "custom") {
      return `${rawPath} must not exceed 100%`;
    }
    const val = getValueAtPath(config, path);
    return `${rawPath} "${val}" must be a percentage (e.g. "50%")`;
  }

  // Empty array (too_small from .min(1))
  if (code === "too_small") {
    return `${display} must not be empty`;
  }

  // Enum: pane type
  if (code === "invalid_value" && lastSeg === "type" && path.includes("panes")) {
    return `${rawPath} must be one of: explorer, changes, preview, tasks, costs, config, mission-control`;
  }

  // Enum: pane role
  if (code === "invalid_value" && lastSeg === "role") {
    return `${rawPath} must be "lead", "teammate", or "planner"`;
  }

  // Enum: dispatch_mode
  if (code === "invalid_value" && lastSeg === "dispatch_mode") {
    return `${rawPath} must be "tasks" or "goals"`;
  }

  // Team.name missing vs wrong type
  if (path.length === 2 && path[0] === "team" && path[1] === "name") {
    if (issue.received === "undefined") {
      return "'team.name' is required when team is specified";
    }
  }

  // Type mismatch
  if (code === "invalid_type") {
    return `${display} must be ${typeDesc(path, issue.expected ?? "")}`;
  }

  // Fallback
  return `${display}: ${issue.message ?? "invalid value"}`;
}

export async function validate(
  targetDir: string | undefined,
  { json }: { json?: boolean } = {},
): Promise<void> {
  const dir = resolve(targetDir ?? ".");
  let config;

  try {
    ({ config } = readConfig(dir));
  } catch (e) {
    outputError(`Cannot read ide.yml: ${(e as Error).message}`, "READ_ERROR");
    return;
  }

  const errors = validateConfig(config);
  const valid = errors.length === 0;

  if (json) {
    console.log(JSON.stringify({ valid, errors }, null, 2));
    return;
  }

  if (valid) {
    console.log("✓ ide.yml is valid");
  } else {
    console.log("✗ ide.yml has errors:");
    for (const e of errors) {
      console.log(`  - ${e}`);
    }
    process.exitCode = 1;
  }
}
