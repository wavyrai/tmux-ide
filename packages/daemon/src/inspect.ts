import { resolve } from "node:path";
import { validateConfig } from "./validate.ts";
import { outputError } from "./lib/output.ts";
import { ConfigError } from "./lib/errors.ts";
import { getSessionState, listPanes } from "@tmux-ide/tmux-bridge";
import type { IdeConfig } from "./types.ts";
import type { ResolvedConfigKind } from "./lib/resolved-config.ts";
import { resolveProjectConfigContext } from "./lib/config-context.ts";

interface ResolvedPane {
  index: number;
  title: string | null;
  command: string | null;
  dir: string;
  size: string | null;
  focus: boolean;
  role: string | null;
  task: string | null;
  env: Record<string, unknown>;
}

interface ResolvedRow {
  index: number;
  size: string | null;
  panes: ResolvedPane[];
}

interface Inspection {
  dir: string;
  configPath: string;
  configKind: ResolvedConfigKind;
  ideConfigPath: string | null;
  valid: boolean;
  errors: string[];
  session: string;
  before: string | null;
  summary: { rows: number; panes: number; focus: string | null };
  team: IdeConfig["team"] | null;
  theme: IdeConfig["theme"] | null;
  focus: { row: number; pane: number; title: string | null } | null;
  rows: ResolvedRow[];
  rawConfig: IdeConfig;
  tmux: { running: boolean; panes: ReturnType<typeof listPanes> };
}

export function buildInspection(
  dir: string,
  {
    config,
    configPath,
    running,
    panes,
    configKind,
    ideConfigPath,
    session,
  }: {
    config: IdeConfig;
    configPath: string;
    configKind: ResolvedConfigKind;
    ideConfigPath: string | null;
    session: string;
    running: boolean;
    panes: ReturnType<typeof listPanes>;
  },
): Inspection {
  const errors = validateConfig(config);
  const rows = Array.isArray(config?.rows) ? config.rows : [];
  const resolvedRows: ResolvedRow[] = rows.map((row, rowIndex) => ({
    index: rowIndex,
    size: row.size ?? null,
    panes: (Array.isArray(row?.panes) ? row.panes : []).map((pane, paneIndex) => ({
      index: paneIndex,
      title: pane.title ?? null,
      command: pane.command ?? null,
      dir: pane.dir ?? ".",
      size: pane.size ?? null,
      focus: pane.focus === true,
      role: pane.role ?? null,
      task: pane.task ?? null,
      env: pane.env ?? {},
    })),
  }));

  const focusPane =
    resolvedRows
      .flatMap((row) => row.panes.map((pane) => ({ row: row.index, pane })))
      .find(({ pane }) => pane.focus) ?? null;
  return {
    dir,
    configPath,
    configKind,
    ideConfigPath,
    valid: errors.length === 0,
    errors,
    session,
    before: config?.before ?? null,
    summary: {
      rows: resolvedRows.length,
      panes: resolvedRows.reduce((sum, row) => sum + row.panes.length, 0),
      focus: focusPane ? `rows.${focusPane.row}.panes.${focusPane.pane.index}` : null,
    },
    team: config?.team ?? null,
    theme: config?.theme ?? null,
    focus: focusPane
      ? {
          row: focusPane.row,
          pane: focusPane.pane.index,
          title: focusPane.pane.title,
        }
      : null,
    rows: resolvedRows,
    rawConfig: config,
    tmux: {
      running,
      panes,
    },
  };
}

export async function inspect(
  targetDir: string | undefined,
  { json }: { json?: boolean } = {},
): Promise<void> {
  const dir = resolve(targetDir ?? ".");

  let config;
  let configPath: string;
  let configKind: ResolvedConfigKind;
  let session: string;
  try {
    const context = await resolveProjectConfigContext(dir);
    const resolved = context.resolved;
    if (!resolved?.launchConfig || !resolved.path) {
      outputError("Cannot read workspace config: no config found", "READ_ERROR");
      return;
    }
    config = resolved.launchConfig;
    configPath = resolved.path;
    configKind = resolved.kind;
    session = context.sessionName;
  } catch (error) {
    if (error instanceof ConfigError) {
      outputError(error.message, error.code ?? "READ_ERROR");
      return;
    }
    outputError(`Cannot read workspace config: ${(error as Error).message}`, "READ_ERROR");
    return;
  }

  const state = getSessionState(session);
  const panes = state.running ? listPanes(session) : [];
  const data = buildInspection(dir, {
    config,
    configPath,
    configKind,
    ideConfigPath: configKind === "legacy" ? configPath : null,
    session,
    running: state.running,
    panes,
  });

  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  console.log(`Directory: ${data.dir}`);
  console.log(`Config:    ${data.configPath}`);
  console.log(`Kind:      ${data.configKind}`);
  console.log(`Valid:     ${data.valid ? "yes" : "no"}`);
  console.log(`Session:   ${data.session}`);
  console.log(`Running:   ${data.tmux.running ? "yes" : "no"}`);
  console.log(`Rows:      ${data.summary.rows}`);
  console.log(`Panes:     ${data.summary.panes}`);
  console.log(`Team:      ${data.team ? data.team.name : "disabled"}`);

  if (data.focus) {
    console.log(
      `Focus:     row ${data.focus.row}, pane ${data.focus.pane}${data.focus.title ? ` (${data.focus.title})` : ""}`,
    );
  }

  if (!data.valid) {
    console.log("\nValidation Errors:");
    for (const error of data.errors) {
      console.log(`  - ${error}`);
    }
  }

  console.log("\nResolved Layout:");
  for (const row of data.rows) {
    console.log(`  Row ${row.index}${row.size ? ` (${row.size})` : ""}`);
    for (const pane of row.panes) {
      const parts: string[] = [];
      if (pane.title) parts.push(pane.title);
      if (pane.command) parts.push(`cmd=${pane.command}`);
      if (pane.dir && pane.dir !== ".") parts.push(`dir=${pane.dir}`);
      if (pane.role) parts.push(`role=${pane.role}`);
      if (pane.focus) parts.push("focus");
      console.log(`    - pane ${pane.index}: ${parts.join(" | ") || "shell"}`);
    }
  }

  if (data.tmux.running && data.tmux.panes.length > 0) {
    console.log("\nLive Panes:");
    for (const pane of data.tmux.panes) {
      const active = pane.active ? " (active)" : "";
      console.log(`  ${pane.index}: ${pane.title} [${pane.width}x${pane.height}]${active}`);
    }
  }
}
