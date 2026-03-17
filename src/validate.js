import { resolve } from "node:path";
import { readConfig } from "./lib/yaml-io.js";
import { outputError } from "./lib/output.js";

export function validateConfig(config) {
  const errors = [];

  if (config == null || typeof config !== "object" || Array.isArray(config)) {
    errors.push("config must be an object");
    return errors;
  }

  if (config.name !== undefined && typeof config.name !== "string") {
    errors.push("'name' must be a string");
  }

  if (config.before !== undefined && typeof config.before !== "string") {
    errors.push("'before' must be a string");
  }

  if (!Array.isArray(config.rows)) {
    errors.push("'rows' must be an array");
  } else if (config.rows.length === 0) {
    errors.push("'rows' must not be empty");
  } else {
    for (let i = 0; i < config.rows.length; i++) {
      const row = config.rows[i];
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
        const pane = row.panes[j];
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
            for (const [key, val] of Object.entries(pane.env)) {
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
    }
  }

  // Validate team config
  if (config.team !== undefined) {
    if (config.team == null || typeof config.team !== "object" || Array.isArray(config.team)) {
      errors.push("'team' must be an object");
    } else {
      if (config.team.name === undefined) {
        errors.push("'team.name' is required when team is specified");
      } else if (typeof config.team.name !== "string") {
        errors.push("'team.name' must be a string");
      }
      if (config.team.model !== undefined && typeof config.team.model !== "string") {
        errors.push("'team.model' must be a string");
      }
      if (config.team.permissions !== undefined && !Array.isArray(config.team.permissions)) {
        errors.push("'team.permissions' must be an array");
      }
    }
  }

  if (config.theme !== undefined) {
    if (config.theme == null || typeof config.theme !== "object" || Array.isArray(config.theme)) {
      errors.push("'theme' must be an object");
    } else {
      for (const key of ["accent", "border", "bg", "fg"]) {
        if (config.theme[key] !== undefined && typeof config.theme[key] !== "string") {
          errors.push(`theme.${key} must be a string`);
        }
      }
    }
  }

  return errors;
}

function validateSize(value, path, errors) {
  const s = String(value);
  if (!/^\d+%$/.test(s)) {
    errors.push(`${path} "${value}" must be a percentage (e.g. "50%")`);
    return;
  }
  const num = parseInt(s, 10);
  if (num === 0) {
    errors.push(`${path} must not be 0%`);
  } else if (num > 100) {
    errors.push(`${path} must not exceed 100%`);
  }
}

export async function validate(targetDir, { json } = {}) {
  const dir = resolve(targetDir ?? ".");
  let config;

  try {
    ({ config } = readConfig(dir));
  } catch (e) {
    outputError(`Cannot read ide.yml: ${e.message}`, "READ_ERROR");
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
