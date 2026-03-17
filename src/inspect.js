import { resolve, basename } from "node:path";
import { readConfig } from "./lib/yaml-io.js";
import { validateConfig } from "./validate.js";
import { outputError } from "./lib/output.js";
import { getSessionState, listPanes } from "./lib/tmux.js";

export function buildInspection(dir, { config, configPath, running, panes }) {
  const errors = validateConfig(config);
  const rows = Array.isArray(config?.rows) ? config.rows : [];
  const resolvedRows = rows.map((row, rowIndex) => ({
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
  const session = config?.name ?? basename(dir);

  return {
    dir,
    configPath,
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

export async function inspect(targetDir, { json } = {}) {
  const dir = resolve(targetDir ?? ".");

  let config;
  let configPath;
  try {
    ({ config, configPath } = readConfig(dir));
  } catch (error) {
    outputError(`Cannot read ide.yml: ${error.message}`, "READ_ERROR");
    return;
  }

  const session = config?.name ?? basename(dir);
  const state = getSessionState(session);
  const panes = state.running ? listPanes(session) : [];
  const data = buildInspection(dir, { config, configPath, running: state.running, panes });

  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  console.log(`Directory: ${data.dir}`);
  console.log(`Config:    ${data.configPath}`);
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
      const parts = [];
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
