import { resolve } from "node:path";
import { readConfig } from "./lib/yaml-io.ts";
import { outputError } from "./lib/output.ts";

export function validateConfig(config: unknown): string[] {
  const errors: string[] = [];

  if (config == null || typeof config !== "object" || Array.isArray(config)) {
    errors.push("config must be an object");
    return errors;
  }

  const cfg = config as Record<string, unknown>;

  if (cfg.name !== undefined && typeof cfg.name !== "string") {
    errors.push("'name' must be a string");
  }

  if (cfg.before !== undefined && typeof cfg.before !== "string") {
    errors.push("'before' must be a string");
  }

  if (!Array.isArray(cfg.rows)) {
    errors.push("'rows' must be an array");
  } else if (cfg.rows.length === 0) {
    errors.push("'rows' must not be empty");
  } else {
    for (let i = 0; i < cfg.rows.length; i++) {
      const row = cfg.rows[i] as Record<string, unknown>;
      if (!row.panes || !Array.isArray(row.panes)) {
        errors.push(`rows[${i}].panes must be an array`);
        continue;
      }
      if (row.panes.length === 0) {
        errors.push(`rows[${i}].panes must not be empty`);
      }
      if (row.size !== undefined) {
        validateSize(row.size, `rows[${i}].size`, errors);
      }
      for (let j = 0; j < row.panes.length; j++) {
        const pane = row.panes[j] as Record<string, unknown>;
        if (pane.title !== undefined && typeof pane.title !== "string") {
          errors.push(`rows[${i}].panes[${j}].title must be a string`);
        }
        if (pane.command !== undefined && typeof pane.command !== "string") {
          errors.push(`rows[${i}].panes[${j}].command must be a string`);
        }
        if (pane.dir !== undefined && typeof pane.dir !== "string") {
          errors.push(`rows[${i}].panes[${j}].dir must be a string`);
        }
        if (pane.focus !== undefined && typeof pane.focus !== "boolean") {
          errors.push(`rows[${i}].panes[${j}].focus must be a boolean`);
        }
        if (pane.env !== undefined) {
          if (pane.env == null || typeof pane.env !== "object" || Array.isArray(pane.env)) {
            errors.push(`rows[${i}].panes[${j}].env must be an object`);
          } else {
            for (const [key, val] of Object.entries(pane.env as Record<string, unknown>)) {
              if (typeof val !== "string" && typeof val !== "number") {
                errors.push(`rows[${i}].panes[${j}].env.${key} must be a string or number`);
              }
            }
          }
        }
        if (pane.size !== undefined) {
          validateSize(pane.size, `rows[${i}].panes[${j}].size`, errors);
        }
        if (pane.role !== undefined) {
          if (pane.role !== "lead" && pane.role !== "teammate") {
            errors.push(`rows[${i}].panes[${j}].role must be "lead" or "teammate"`);
          }
        }
        if (pane.task !== undefined && typeof pane.task !== "string") {
          errors.push(`rows[${i}].panes[${j}].task must be a string`);
        }
      }

      // Check multiple focus panes in this row
      const focusCount = (row.panes as Record<string, unknown>[]).filter(
        (p) => p.focus === true,
      ).length;
      if (focusCount > 1) {
        errors.push(`Row ${i} has ${focusCount} panes with focus: true (max 1)`);
      }

      // Check pane sizes sum within this row
      const paneSizes = (row.panes as Record<string, unknown>[])
        .map((p) => p.size)
        .filter((s): s is string => typeof s === "string" && /^[1-9]\d*%$/.test(s))
        .map((s) => parseInt(s, 10));
      const paneSum = paneSizes.reduce((a, b) => a + b, 0);
      if (paneSum > 100) {
        errors.push(`Row ${i} pane sizes sum to ${paneSum}%, which exceeds 100%`);
      }
    }

    // Check row sizes sum
    const rowSizes = (cfg.rows as Record<string, unknown>[])
      .map((r) => r.size)
      .filter((s): s is string => typeof s === "string" && /^[1-9]\d*%$/.test(s))
      .map((s) => parseInt(s, 10));
    const rowSum = rowSizes.reduce((a, b) => a + b, 0);
    if (rowSum > 100) {
      errors.push(`Row sizes sum to ${rowSum}%, which exceeds 100%`);
    }
  }

  // Validate team config
  if (cfg.team !== undefined) {
    if (cfg.team == null || typeof cfg.team !== "object" || Array.isArray(cfg.team)) {
      errors.push("'team' must be an object");
    } else {
      const team = cfg.team as Record<string, unknown>;
      if (team.name === undefined) {
        errors.push("'team.name' is required when team is specified");
      } else if (typeof team.name !== "string") {
        errors.push("'team.name' must be a string");
      }
      if (team.model !== undefined && typeof team.model !== "string") {
        errors.push("'team.model' must be a string");
      }
      if (team.permissions !== undefined && !Array.isArray(team.permissions)) {
        errors.push("'team.permissions' must be an array");
      }
    }
  }

  if (cfg.theme !== undefined) {
    if (cfg.theme == null || typeof cfg.theme !== "object" || Array.isArray(cfg.theme)) {
      errors.push("'theme' must be an object");
    } else {
      const theme = cfg.theme as Record<string, unknown>;
      for (const key of ["accent", "border", "bg", "fg"]) {
        if (theme[key] !== undefined && typeof theme[key] !== "string") {
          errors.push(`theme.${key} must be a string`);
        }
      }
    }
  }

  return errors;
}

function validateSize(value: unknown, path: string, errors: string[]): void {
  const s = String(value);
  if (!/^[1-9]\d*%$/.test(s)) {
    errors.push(`${path} "${value}" must be a percentage (e.g. "50%")`);
    return;
  }
  const num = parseInt(s, 10);
  if (num > 100) {
    errors.push(`${path} must not exceed 100%`);
  }
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
