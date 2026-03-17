import { resolve } from "node:path";

export function buildPaneCommand(pane) {
  if (!pane.command) return null;
  return pane.command;
}

export function collectPaneStartupPlan(rows, paneMap, firstPanesOfRows, dir) {
  let focusPane = paneMap[0][0];
  const paneActions = [];

  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx];
    const panes = row.panes ?? [];

    for (let paneIdx = 0; paneIdx < panes.length; paneIdx++) {
      const pane = panes[paneIdx];
      const tmuxPane = paneMap[rowIdx][paneIdx];
      const action = {
        targetPane: tmuxPane,
        title: pane.title ?? null,
        chdir: null,
        exports: [],
        command: null,
      };

      if (pane.dir && firstPanesOfRows.has(tmuxPane)) {
        action.chdir = resolve(dir, pane.dir);
      }

      if (pane.env && typeof pane.env === "object") {
        action.exports = Object.entries(pane.env).map(([key, value]) => `export ${key}=${value}`);
      }

      const command = buildPaneCommand(pane);
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
