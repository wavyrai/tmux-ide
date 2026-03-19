import { resolve } from "node:path";
import { readConfig, writeConfig } from "./lib/yaml-io.ts";
import { setByPath } from "./lib/dot-path.ts";
import { outputError } from "./lib/output.ts";
import type { IdeConfig, Pane, Row } from "./types.ts";

/**
 * Read config safely (read-only, no write). Returns config or undefined on error.
 */
function readConfigSafe(dir: string): IdeConfig | undefined {
  let cfg: IdeConfig;
  try {
    ({ config: cfg } = readConfig(dir));
  } catch (e) {
    outputError(`Cannot read ide.yml: ${(e as Error).message}`, "READ_ERROR");
    return;
  }
  return cfg;
}

/**
 * Read config, validate it's an object, run mutator, then write back.
 * Returns the mutator's return value, or undefined on error.
 */
function withConfig<T>(dir: string, mutator: (cfg: IdeConfig) => T): T | undefined {
  const cfg = readConfigSafe(dir);
  if (cfg === undefined) return;

  if (!isConfigObject(cfg)) {
    outputError("Invalid ide.yml: config root must be an object", "INVALID_CONFIG");
    return;
  }

  const result = mutator(cfg);
  writeConfig(dir, cfg);
  return result;
}

export async function config(
  targetDir: string | null,
  { json, action, args }: { json?: boolean; action?: string; args?: string[] } = {},
): Promise<void> {
  const dir = resolve(targetDir ?? ".");

  switch (action) {
    case "dump":
      return dumpConfig(dir, { json });
    case "set":
      return setConfig(dir, args ?? [], { json });
    case "add-pane":
      return addPane(dir, args ?? [], { json });
    case "remove-pane":
      return removePane(dir, args ?? [], { json });
    case "add-row":
      return addRow(dir, args ?? [], { json });
    case "enable-team":
      return enableTeam(dir, args ?? [], { json });
    case "disable-team":
      return disableTeam(dir, { json });
    default:
      return dumpConfig(dir, { json });
  }
}

function dumpConfig(dir: string, { json }: { json?: boolean }): void {
  const cfg = readConfigSafe(dir);
  if (cfg === undefined) return;

  if (json) {
    console.log(JSON.stringify(cfg, null, 2));
  } else {
    console.log(JSON.stringify(cfg, null, 2));
  }
}

function setConfig(dir: string, args: string[], { json }: { json?: boolean }): void {
  const [dotpath, ...rest] = args;
  if (!dotpath || rest.length === 0) {
    outputError("Usage: tmux-ide config set <dotpath> <value>", "USAGE");
    return;
  }

  let value: string | boolean | number = rest.join(" ");
  if (value === "true") value = true;
  else if (value === "false") value = false;
  else if (/^\d+$/.test(value)) value = parseInt(value);

  withConfig(dir, (cfg) => {
    setByPath(cfg as unknown as Record<string, unknown>, dotpath, value);
  });

  if (json) {
    console.log(JSON.stringify({ ok: true, path: dotpath, value }, null, 2));
  } else {
    console.log(`Set ${dotpath} = ${JSON.stringify(value)}`);
  }
}

function addPane(dir: string, args: string[], { json }: { json?: boolean }): void {
  const { row, title, command, size } = parseNamedArgs(args);
  if (row === undefined) {
    outputError(
      "Usage: tmux-ide config add-pane --row <N> --title <T> [--command <C>] [--size <S>]",
      "USAGE",
    );
    return;
  }

  const rowIdx = parseIndex(row);
  if (rowIdx == null) {
    outputError(`Invalid row index "${row}"`, "USAGE");
    return;
  }

  const pane: Partial<Pane> = {};
  if (title) pane.title = title;
  if (command) pane.command = command;
  if (size) pane.size = size;

  withConfig(dir, (cfg) => {
    if (!Array.isArray(cfg.rows)) {
      outputError("Invalid ide.yml: 'rows' must be an array", "INVALID_CONFIG");
    }

    if (!cfg.rows[rowIdx]) {
      outputError(`Row ${rowIdx} does not exist`, "INVALID_ROW");
    }

    if (!Array.isArray(cfg.rows[rowIdx]!.panes)) {
      outputError(`Invalid ide.yml: row ${rowIdx} panes must be an array`, "INVALID_CONFIG");
    }

    cfg.rows[rowIdx]!.panes.push(pane as Pane);
  });

  if (json) {
    console.log(JSON.stringify({ ok: true, row: rowIdx, pane }, null, 2));
  } else {
    console.log(`Added pane "${title ?? "untitled"}" to row ${rowIdx}`);
  }
}

function removePane(dir: string, args: string[], { json }: { json?: boolean }): void {
  const { row, pane } = parseNamedArgs(args);
  if (row === undefined || pane === undefined) {
    outputError("Usage: tmux-ide config remove-pane --row <N> --pane <M>", "USAGE");
    return;
  }

  const rowIdx = parseIndex(row);
  const paneIdx = parseIndex(pane);
  if (rowIdx == null || paneIdx == null) {
    outputError("Usage: tmux-ide config remove-pane --row <N> --pane <M>", "USAGE");
    return;
  }

  let removed: Pane | undefined;
  withConfig(dir, (cfg) => {
    if (!Array.isArray(cfg.rows)) {
      outputError("Invalid ide.yml: 'rows' must be an array", "INVALID_CONFIG");
    }

    if (!Array.isArray(cfg.rows[rowIdx]?.panes)) {
      outputError(`Invalid ide.yml: row ${rowIdx} panes must be an array`, "INVALID_CONFIG");
    }

    if (!cfg.rows[rowIdx]!.panes[paneIdx]) {
      outputError(`Pane ${paneIdx} in row ${rowIdx} does not exist`, "INVALID_PANE");
    }

    removed = cfg.rows[rowIdx]!.panes.splice(paneIdx, 1)[0];
  });

  if (json) {
    console.log(JSON.stringify({ ok: true, row: rowIdx, pane: paneIdx, removed }, null, 2));
  } else {
    console.log(`Removed pane ${paneIdx} ("${removed?.title ?? "untitled"}") from row ${rowIdx}`);
  }
}

function addRow(dir: string, args: string[], { json }: { json?: boolean }): void {
  const { size } = parseNamedArgs(args);

  let rowIdx: number | undefined;
  withConfig(dir, (cfg) => {
    if (cfg.rows !== undefined && !Array.isArray(cfg.rows)) {
      outputError("Invalid ide.yml: 'rows' must be an array", "INVALID_CONFIG");
    }

    const row: Row = { panes: [{ title: "Shell" }] };
    if (size) row.size = size;
    cfg.rows = cfg.rows ?? [];
    cfg.rows.push(row);
    rowIdx = cfg.rows.length - 1;
  });

  if (json) {
    console.log(JSON.stringify({ ok: true, row: rowIdx, size: size ?? null }, null, 2));
  } else {
    console.log(`Added row ${rowIdx}${size ? ` (${size})` : ""}`);
  }
}

function enableTeam(dir: string, args: string[], { json }: { json?: boolean }): void {
  const { name } = parseNamedArgs(args);

  let teamName: string | undefined;
  let result: { team: IdeConfig["team"]; roles: ReturnType<typeof summarizeRoles> } | undefined;
  withConfig(dir, (cfg) => {
    if (cfg.rows !== undefined && !Array.isArray(cfg.rows)) {
      outputError("Invalid ide.yml: 'rows' must be an array", "INVALID_CONFIG");
    }

    teamName = name ?? cfg.name ?? "my-team";
    cfg.team = { name: teamName };

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
    }

    result = { team: cfg.team, roles: summarizeRoles(cfg) };
  });

  if (json) {
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } else {
    console.log(`Enabled agent team "${teamName}"`);
  }
}

function disableTeam(dir: string, { json }: { json?: boolean }): void {
  withConfig(dir, (cfg) => {
    if (cfg.rows !== undefined && !Array.isArray(cfg.rows)) {
      outputError("Invalid ide.yml: 'rows' must be an array", "INVALID_CONFIG");
    }

    delete cfg.team;
    for (const row of cfg.rows ?? []) {
      if (!Array.isArray(row?.panes)) continue;
      for (const pane of row.panes) {
        delete pane.role;
        delete pane.task;
      }
    }
  });

  if (json) {
    console.log(JSON.stringify({ ok: true, disabled: true }, null, 2));
  } else {
    console.log("Disabled agent team");
  }
}

function summarizeRoles(
  cfg: IdeConfig,
): { row: number; pane: number; title: string | null; role: string }[] {
  const roles: { row: number; pane: number; title: string | null; role: string }[] = [];
  for (let i = 0; i < (cfg.rows ?? []).length; i++) {
    for (let j = 0; j < (cfg.rows[i]!.panes ?? []).length; j++) {
      const p = cfg.rows[i]!.panes[j]!;
      if (p.role) {
        roles.push({ row: i, pane: j, title: p.title ?? null, role: p.role });
      }
    }
  }
  return roles;
}

function parseNamedArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i]!.startsWith("--") && i + 1 < args.length) {
      const key = args[i]!.slice(2);
      result[key] = args[i + 1]!;
      i++;
    }
  }
  return result;
}

function isConfigObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function parseIndex(value: string): number | null {
  if (!/^\d+$/.test(String(value))) return null;
  return Number.parseInt(value, 10);
}
