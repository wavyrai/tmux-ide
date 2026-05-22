import { resolve } from "node:path";
import { readConfig, writeConfig } from "./lib/yaml-io.ts";
import { setByPath } from "./lib/dot-path.ts";
import { outputError } from "./lib/output.ts";
import { IdeConfigSchema } from "./schemas/ide-config.ts";
import type { IdeConfig, Pane, Row } from "./types.ts";
import { CliActionInvocationError, tryDispatchAction } from "./lib/cli-action-bridge.ts";

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

  const validation = IdeConfigSchema.safeParse(cfg);
  if (!validation.success) {
    const issues = validation.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    outputError(`Invalid config after mutation:\n${issues}`, "INVALID_CONFIG");
    return;
  }

  writeConfig(dir, cfg);
  return result;
}

export function mutateConfig<T>(
  dir: string,
  mutator: (cfg: IdeConfig) => T,
): {
  config: IdeConfig;
  result: T;
} {
  const { config: cfg } = readConfig(dir);
  if (!isConfigObject(cfg)) {
    throw new Error("Invalid ide.yml: config root must be an object");
  }

  const result = mutator(cfg);
  const validation = IdeConfigSchema.safeParse(cfg);
  if (!validation.success) {
    const issues = validation.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid config after mutation: ${issues}`);
  }

  writeConfig(dir, cfg);
  return { config: cfg, result };
}

function assertDotPath(path: string): void {
  const parts = path.split(".");
  if (
    !path.trim() ||
    parts.some((part) => !part) ||
    parts.some((part) => part === "__proto__" || part === "prototype" || part === "constructor")
  ) {
    throw new Error(`Invalid config path "${path}"`);
  }
}

export function configSetValue(dir: string, path: string, value: unknown): IdeConfig {
  assertDotPath(path);
  return mutateConfig(dir, (cfg) => {
    setByPath(cfg as unknown as Record<string, unknown>, path, value);
  }).config;
}

export function configAddPane(dir: string, rowIndex: number, pane: Partial<Pane>): IdeConfig {
  return mutateConfig(dir, (cfg) => {
    if (!Array.isArray(cfg.rows)) {
      throw new Error("Invalid ide.yml: 'rows' must be an array");
    }
    if (!cfg.rows[rowIndex]) {
      throw new Error(`Row ${rowIndex} does not exist`);
    }
    if (!Array.isArray(cfg.rows[rowIndex]!.panes)) {
      throw new Error(`Invalid ide.yml: row ${rowIndex} panes must be an array`);
    }
    cfg.rows[rowIndex]!.panes.push(pane as Pane);
  }).config;
}

export function configRemovePane(
  dir: string,
  rowIndex: number,
  paneIndex: number,
): {
  config: IdeConfig;
  removed: Pane;
} {
  const updated = mutateConfig(dir, (cfg) => {
    if (!Array.isArray(cfg.rows)) {
      throw new Error("Invalid ide.yml: 'rows' must be an array");
    }
    if (!Array.isArray(cfg.rows[rowIndex]?.panes)) {
      throw new Error(`Invalid ide.yml: row ${rowIndex} panes must be an array`);
    }
    const removed = cfg.rows[rowIndex]!.panes[paneIndex];
    if (!removed) {
      throw new Error(`Pane ${paneIndex} in row ${rowIndex} does not exist`);
    }
    cfg.rows[rowIndex]!.panes.splice(paneIndex, 1);
    return removed;
  });
  return { config: updated.config, removed: updated.result };
}

export function configAddRow(dir: string, size?: string): IdeConfig {
  return mutateConfig(dir, (cfg) => {
    if (cfg.rows !== undefined && !Array.isArray(cfg.rows)) {
      throw new Error("Invalid ide.yml: 'rows' must be an array");
    }
    const row: Row = { panes: [{ title: "Shell" }] };
    if (size) row.size = size;
    cfg.rows = cfg.rows ?? [];
    cfg.rows.push(row);
  }).config;
}

export function configEnableTeam(dir: string, name?: string): IdeConfig {
  return mutateConfig(dir, (cfg) => {
    if (cfg.rows !== undefined && !Array.isArray(cfg.rows)) {
      throw new Error("Invalid ide.yml: 'rows' must be an array");
    }
    cfg.team = { name: name ?? cfg.name ?? "my-team" };
    let leadAssigned = false;
    for (const row of cfg.rows ?? []) {
      for (const pane of row.panes ?? []) {
        if (pane.command === "claude" || pane.role === "lead" || pane.role === "teammate") {
          pane.role = leadAssigned ? "teammate" : "lead";
          leadAssigned = true;
        }
      }
    }
    if (!leadAssigned) {
      delete cfg.team;
      throw new Error("Cannot enable agent team: no Claude panes found");
    }
  }).config;
}

export function configDisableTeam(dir: string): IdeConfig {
  return mutateConfig(dir, (cfg) => {
    if (cfg.rows !== undefined && !Array.isArray(cfg.rows)) {
      throw new Error("Invalid ide.yml: 'rows' must be an array");
    }
    delete cfg.team;
    for (const row of cfg.rows ?? []) {
      if (!Array.isArray(row?.panes)) continue;
      for (const pane of row.panes) {
        delete pane.role;
        delete pane.task;
      }
    }
  }).config;
}

export async function config(
  targetDir: string | null,
  { json, action, args }: { json?: boolean; action?: string; args?: string[] } = {},
): Promise<void> {
  const dir = resolve(targetDir ?? ".");

  if (await tryDispatchConfigAction(dir, { json, action, args: args ?? [] })) return;

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

function printConfigActionError(err: unknown): void {
  if (err instanceof CliActionInvocationError) {
    outputError(err.message, err.code.toUpperCase());
  }
  throw err;
}

function coerceConfigValue(raw: string): string | boolean | number {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^\d+$/.test(raw)) return parseInt(raw);
  return raw;
}

async function tryDispatchConfigAction(
  dir: string,
  { json, action, args }: { json?: boolean; action?: string; args: string[] },
): Promise<boolean> {
  try {
    if (action === "set") {
      const [dotpath, ...rest] = args;
      if (!dotpath || rest.length === 0) return false;
      const value = coerceConfigValue(rest.join(" "));
      const result = await tryDispatchAction("config.set", { path: dotpath, value }, { cwd: dir });
      if (!result) return false;
      if (json) console.log(JSON.stringify({ ok: true, path: dotpath, value }, null, 2));
      else console.log(`Set ${dotpath} = ${JSON.stringify(value)}`);
      return true;
    }

    if (action === "add-pane") {
      const { row, title, command, size } = parseNamedArgs(args);
      if (row === undefined) return false;
      const rowIndex = parseIndex(row);
      if (rowIndex == null) return false;
      const result = await tryDispatchAction(
        "config.addPane",
        { rowIndex, title, command, size },
        { cwd: dir },
      );
      if (!result) return false;
      const pane = { title, command, size };
      if (json) console.log(JSON.stringify({ ok: true, row: rowIndex, pane }, null, 2));
      else console.log(`Added pane "${title ?? "untitled"}" to row ${rowIndex}`);
      return true;
    }

    if (action === "remove-pane") {
      const { row, pane } = parseNamedArgs(args);
      if (row === undefined || pane === undefined) return false;
      const rowIndex = parseIndex(row);
      const paneIndex = parseIndex(pane);
      if (rowIndex == null || paneIndex == null) return false;
      const before = readConfigSafe(dir);
      const removed = before?.rows[rowIndex]?.panes[paneIndex] ?? null;
      const result = await tryDispatchAction(
        "config.removePane",
        { rowIndex, paneIndex },
        { cwd: dir },
      );
      if (!result) return false;
      if (json) {
        console.log(JSON.stringify({ ok: true, row: rowIndex, pane: paneIndex, removed }, null, 2));
      } else {
        console.log(`Removed pane ${paneIndex} from row ${rowIndex}`);
      }
      return true;
    }

    if (action === "add-row") {
      const { size } = parseNamedArgs(args);
      const result = await tryDispatchAction("config.addRow", { size }, { cwd: dir });
      if (!result) return false;
      const row = result.config.rows.length - 1;
      if (json) console.log(JSON.stringify({ ok: true, row, size: size ?? null }, null, 2));
      else console.log(`Added row ${row}${size ? ` (${size})` : ""}`);
      return true;
    }

    if (action === "enable-team") {
      const { name } = parseNamedArgs(args);
      const result = await tryDispatchAction("config.enableTeam", { name }, { cwd: dir });
      if (!result) return false;
      const teamName = result.config.team?.name ?? name ?? result.config.name ?? "my-team";
      if (json) console.log(JSON.stringify({ ok: true, team: result.config.team }, null, 2));
      else console.log(`Enabled agent team "${teamName}"`);
      return true;
    }

    if (action === "disable-team") {
      const result = await tryDispatchAction("config.disableTeam", {}, { cwd: dir });
      if (!result) return false;
      if (json) console.log(JSON.stringify({ ok: true, disabled: true }, null, 2));
      else console.log("Disabled agent team");
      return true;
    }
  } catch (err) {
    printConfigActionError(err);
  }

  return false;
}

function setConfig(dir: string, args: string[], { json }: { json?: boolean }): void {
  const [dotpath, ...rest] = args;
  if (!dotpath || rest.length === 0) {
    outputError("Usage: tmux-ide config set <dotpath> <value>", "USAGE");
    return;
  }

  const value = coerceConfigValue(rest.join(" "));

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
