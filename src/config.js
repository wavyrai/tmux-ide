import { resolve } from "node:path";
import { readConfig, writeConfig } from "./lib/yaml-io.js";
import { setByPath } from "./lib/dot-path.js";
import { outputError } from "./lib/output.js";

export async function config(targetDir, { json, action, args } = {}) {
  const dir = resolve(targetDir ?? ".");

  switch (action) {
    case "dump":
      return dumpConfig(dir, { json });
    case "set":
      return setConfig(dir, args, { json });
    case "add-pane":
      return addPane(dir, args, { json });
    case "remove-pane":
      return removePane(dir, args, { json });
    case "add-row":
      return addRow(dir, args, { json });
    case "enable-team":
      return enableTeam(dir, args, { json });
    case "disable-team":
      return disableTeam(dir, { json });
    default:
      return dumpConfig(dir, { json });
  }
}

function dumpConfig(dir, { json }) {
  let cfg;
  try {
    ({ config: cfg } = readConfig(dir));
  } catch (e) {
    outputError(`Cannot read ide.yml: ${e.message}`, "READ_ERROR");
    return;
  }

  if (json) {
    console.log(JSON.stringify(cfg, null, 2));
  } else {
    // Pretty print for humans
    console.log(JSON.stringify(cfg, null, 2));
  }
}

function setConfig(dir, args, { json }) {
  const [dotpath, ...rest] = args;
  if (!dotpath || rest.length === 0) {
    outputError("Usage: tmux-ide config set <dotpath> <value>", "USAGE");
    return;
  }

  let cfg;
  try {
    ({ config: cfg } = readConfig(dir));
  } catch (e) {
    outputError(`Cannot read ide.yml: ${e.message}`, "READ_ERROR");
    return;
  }

  if (!isConfigObject(cfg)) {
    outputError("Invalid ide.yml: config root must be an object", "INVALID_CONFIG");
    return;
  }

  let value = rest.join(" ");
  // Try to parse as number or boolean
  if (value === "true") value = true;
  else if (value === "false") value = false;
  else if (/^\d+$/.test(value)) value = parseInt(value);

  setByPath(cfg, dotpath, value);
  writeConfig(dir, cfg);

  if (json) {
    console.log(JSON.stringify({ ok: true, path: dotpath, value }, null, 2));
  } else {
    console.log(`Set ${dotpath} = ${JSON.stringify(value)}`);
  }
}

function addPane(dir, args, { json }) {
  const { row, title, command, size } = parseNamedArgs(args);
  if (row === undefined) {
    outputError(
      "Usage: tmux-ide config add-pane --row <N> --title <T> [--command <C>] [--size <S>]",
      "USAGE",
    );
    return;
  }

  let cfg;
  try {
    ({ config: cfg } = readConfig(dir));
  } catch (e) {
    outputError(`Cannot read ide.yml: ${e.message}`, "READ_ERROR");
    return;
  }

  if (!Array.isArray(cfg?.rows)) {
    outputError("Invalid ide.yml: 'rows' must be an array", "INVALID_CONFIG");
    return;
  }

  const rowIdx = parseIndex(row);
  if (rowIdx == null) {
    outputError(`Invalid row index "${row}"`, "USAGE");
    return;
  }

  if (!cfg.rows[rowIdx]) {
    outputError(`Row ${rowIdx} does not exist`, "INVALID_ROW");
    return;
  }

  if (!Array.isArray(cfg.rows[rowIdx].panes)) {
    outputError(`Invalid ide.yml: row ${rowIdx} panes must be an array`, "INVALID_CONFIG");
    return;
  }

  const pane = {};
  if (title) pane.title = title;
  if (command) pane.command = command;
  if (size) pane.size = size;

  cfg.rows[rowIdx].panes.push(pane);
  writeConfig(dir, cfg);

  if (json) {
    console.log(JSON.stringify({ ok: true, row: rowIdx, pane }, null, 2));
  } else {
    console.log(`Added pane "${title ?? "untitled"}" to row ${rowIdx}`);
  }
}

function removePane(dir, args, { json }) {
  const { row, pane } = parseNamedArgs(args);
  if (row === undefined || pane === undefined) {
    outputError("Usage: tmux-ide config remove-pane --row <N> --pane <M>", "USAGE");
    return;
  }

  let cfg;
  try {
    ({ config: cfg } = readConfig(dir));
  } catch (e) {
    outputError(`Cannot read ide.yml: ${e.message}`, "READ_ERROR");
    return;
  }

  if (!Array.isArray(cfg?.rows)) {
    outputError("Invalid ide.yml: 'rows' must be an array", "INVALID_CONFIG");
    return;
  }

  const rowIdx = parseIndex(row);
  const paneIdx = parseIndex(pane);
  if (rowIdx == null || paneIdx == null) {
    outputError("Usage: tmux-ide config remove-pane --row <N> --pane <M>", "USAGE");
    return;
  }

  if (!Array.isArray(cfg.rows[rowIdx]?.panes)) {
    outputError(`Invalid ide.yml: row ${rowIdx} panes must be an array`, "INVALID_CONFIG");
    return;
  }

  if (!cfg.rows[rowIdx].panes[paneIdx]) {
    outputError(`Pane ${paneIdx} in row ${rowIdx} does not exist`, "INVALID_PANE");
    return;
  }

  const removed = cfg.rows[rowIdx].panes.splice(paneIdx, 1)[0];
  writeConfig(dir, cfg);

  if (json) {
    console.log(JSON.stringify({ ok: true, row: rowIdx, pane: paneIdx, removed }, null, 2));
  } else {
    console.log(`Removed pane ${paneIdx} ("${removed.title ?? "untitled"}") from row ${rowIdx}`);
  }
}

function addRow(dir, args, { json }) {
  const { size } = parseNamedArgs(args);

  let cfg;
  try {
    ({ config: cfg } = readConfig(dir));
  } catch (e) {
    outputError(`Cannot read ide.yml: ${e.message}`, "READ_ERROR");
    return;
  }

  if (!isConfigObject(cfg)) {
    outputError("Invalid ide.yml: config root must be an object", "INVALID_CONFIG");
    return;
  }

  if (cfg.rows !== undefined && !Array.isArray(cfg.rows)) {
    outputError("Invalid ide.yml: 'rows' must be an array", "INVALID_CONFIG");
    return;
  }

  const row = { panes: [{ title: "Shell" }] };
  if (size) row.size = size;

  cfg.rows = cfg.rows ?? [];
  cfg.rows.push(row);
  writeConfig(dir, cfg);

  const rowIdx = cfg.rows.length - 1;
  if (json) {
    console.log(JSON.stringify({ ok: true, row: rowIdx, size: size ?? null }, null, 2));
  } else {
    console.log(`Added row ${rowIdx}${size ? ` (${size})` : ""}`);
  }
}

function enableTeam(dir, args, { json }) {
  const { name } = parseNamedArgs(args);

  let cfg;
  try {
    ({ config: cfg } = readConfig(dir));
  } catch (e) {
    outputError(`Cannot read ide.yml: ${e.message}`, "READ_ERROR");
    return;
  }

  if (!isConfigObject(cfg)) {
    outputError("Invalid ide.yml: config root must be an object", "INVALID_CONFIG");
    return;
  }

  if (cfg.rows !== undefined && !Array.isArray(cfg.rows)) {
    outputError("Invalid ide.yml: 'rows' must be an array", "INVALID_CONFIG");
    return;
  }

  const teamName = name ?? cfg.name ?? "my-team";
  cfg.team = { name: teamName };

  // Find claude panes and assign roles: first as lead, rest as teammates
  let leadAssigned = false;
  for (const row of cfg.rows ?? []) {
    for (const pane of row.panes ?? []) {
      if (pane.command === "claude" || pane.role === "lead" || pane.role === "teammate") {
        if (!leadAssigned) {
          pane.role = "lead";
          leadAssigned = true;
        } else {
          pane.role = "teammate";
        }
      }
    }
  }
  if (!leadAssigned) {
    delete cfg.team;
    outputError("Cannot enable agent team: no Claude panes found", "INVALID_CONFIG");
    return;
  }

  writeConfig(dir, cfg);

  if (json) {
    console.log(JSON.stringify({ ok: true, team: cfg.team, roles: summarizeRoles(cfg) }, null, 2));
  } else {
    console.log(`Enabled agent team "${teamName}"`);
  }
}

function disableTeam(dir, { json }) {
  let cfg;
  try {
    ({ config: cfg } = readConfig(dir));
  } catch (e) {
    outputError(`Cannot read ide.yml: ${e.message}`, "READ_ERROR");
    return;
  }

  if (!isConfigObject(cfg)) {
    outputError("Invalid ide.yml: config root must be an object", "INVALID_CONFIG");
    return;
  }

  if (cfg.rows !== undefined && !Array.isArray(cfg.rows)) {
    outputError("Invalid ide.yml: 'rows' must be an array", "INVALID_CONFIG");
    return;
  }

  delete cfg.team;
  for (const row of cfg.rows ?? []) {
    if (!Array.isArray(row?.panes)) continue;
    for (const pane of row.panes ?? []) {
      delete pane.role;
      delete pane.task;
    }
  }

  writeConfig(dir, cfg);

  if (json) {
    console.log(JSON.stringify({ ok: true, disabled: true }, null, 2));
  } else {
    console.log("Disabled agent team");
  }
}

function summarizeRoles(cfg) {
  const roles = [];
  for (let i = 0; i < (cfg.rows ?? []).length; i++) {
    for (let j = 0; j < (cfg.rows[i].panes ?? []).length; j++) {
      const p = cfg.rows[i].panes[j];
      if (p.role) {
        roles.push({ row: i, pane: j, title: p.title ?? null, role: p.role });
      }
    }
  }
  return roles;
}

function parseNamedArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--") && i + 1 < args.length) {
      const key = args[i].slice(2);
      result[key] = args[i + 1];
      i++;
    }
  }
  return result;
}

function isConfigObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function parseIndex(value) {
  if (!/^\d+$/.test(String(value))) return null;
  return Number.parseInt(value, 10);
}
