import { resolve } from "node:path";
import type { Pane, Row, PaneAction } from "../types.ts";
import { shellEscape } from "./shell.ts";

export function buildPaneCommand(pane: Pane): string | null {
  if (!pane.command) return null;
  return pane.command;
}

export function collectPaneStartupPlan(
  rows: Row[],
  paneMap: string[][],
  firstPanesOfRows: Set<string>,
  dir: string,
): { focusPane: string; paneActions: PaneAction[] } {
  let focusPane = paneMap[0]![0]!;
  const paneActions: PaneAction[] = [];

  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx]!;
    const panes = row.panes ?? [];

    for (let paneIdx = 0; paneIdx < panes.length; paneIdx++) {
      const pane = panes[paneIdx]!;
      const tmuxPane = paneMap[rowIdx]![paneIdx]!;
      // Derive @ide_role from pane config
      let paneRole: string;
      if (pane.role === "lead") {
        paneRole = "lead";
      } else if (pane.role === "teammate" || pane.role === "planner") {
        paneRole = "teammate";
      } else if (pane.type) {
        paneRole = "widget";
      } else {
        paneRole = "shell";
      }

      // Derive @ide_type from pane config
      let paneType: string;
      if (pane.type) {
        paneType = pane.type;
      } else if (pane.command && /claude|codex/i.test(pane.command)) {
        paneType = "agent";
      } else {
        paneType = "shell";
      }

      const action: PaneAction = {
        targetPane: tmuxPane,
        title: pane.title ?? null,
        chdir: null,
        exports: [],
        command: null,
        widgetType: pane.type ?? null,
        widgetTarget: pane.target ?? null,
        paneRole,
        paneType,
      };

      if (pane.dir && firstPanesOfRows.has(tmuxPane)) {
        action.chdir = resolve(dir, pane.dir);
      }

      if (pane.env && typeof pane.env === "object") {
        action.exports = Object.entries(pane.env).map(
          ([key, value]) => `export ${shellEscape(key)}=${shellEscape(String(value))}`,
        );
      }

      let command = buildPaneCommand(pane);
      // Inject --name flag into Claude/Codex commands so the agent
      // sets its own pane title to match the configured name.
      // This is agent-agnostic: any CLI that respects --name will work.
      if (command && pane.title && /claude|codex/i.test(command) && !command.includes("--name")) {
        command = `${command} --name ${shellEscape(pane.title)}`;
      }
      if (command) {
        action.command = command;
      }

      if (pane.focus) {
        focusPane = tmuxPane;
      }

      paneActions.push(action);
    }
  }

  return { focusPane, paneActions };
}
