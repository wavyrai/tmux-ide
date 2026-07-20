import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { WORKSPACE_SEMANTIC_PANE_OPTION } from "@tmux-ide/contracts";
import type { Pane, Row, PaneAction } from "../types.ts";
import { shellEscape } from "./shell.ts";

export interface LaunchPaneAction extends PaneAction {
  /** Stable across tmux restarts and config insertion/reorder for this pane. */
  semanticPaneId: string;
}

export interface LaunchPlanDiagnostic {
  code: "AMBIGUOUS_IMPLICIT_PANE_ID";
  message: string;
}

/**
 * Explicit `pane.id` is authoritative. The fallback hashes declarative pane
 * metadata, never its row/column. A title is part of fallback identity so two
 * same-command agents remain distinct across reorder; users who want title
 * edits to preserve identity should set `id` (new onboarding does so).
 */
export function semanticPaneIdForPane(pane: Pane): string {
  if (pane.id) return pane.id;
  const metadata = JSON.stringify({
    title: pane.title ?? null,
    command: pane.command ?? null,
    type: pane.type ?? null,
    target: pane.target ?? null,
    dir: pane.dir ?? null,
    role: pane.role ?? null,
    env: Object.entries(pane.env ?? {}).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  });
  const digest = createHash("sha256").update(metadata).digest("hex").slice(0, 16);
  const label = paneIdentityLabel(pane);
  return `pane-${label}-${digest}`;
}

export function paneIdentityOptions(
  action: Pick<LaunchPaneAction, "semanticPaneId" | "paneRole" | "paneType" | "title">,
): ReadonlyArray<readonly [option: string, value: string]> {
  return [
    [WORKSPACE_SEMANTIC_PANE_OPTION, action.semanticPaneId],
    ["@ide_role", action.paneRole ?? "shell"],
    ["@ide_name", action.title ?? ""],
    ["@ide_type", action.paneType ?? "shell"],
  ];
}

export function buildPaneCommand(pane: Pane): string | null {
  if (!pane.command) return null;
  return pane.command;
}

export function collectPaneStartupPlan(
  rows: Row[],
  paneMap: string[][],
  firstPanesOfRows: Set<string>,
  dir: string,
): { focusPane: string; paneActions: LaunchPaneAction[]; diagnostics: LaunchPlanDiagnostic[] } {
  let focusPane = paneMap[0]![0]!;
  const paneActions: LaunchPaneAction[] = [];
  const diagnostics: LaunchPlanDiagnostic[] = [];
  const paneIdentities = assignPaneIdentities(rows, diagnostics);

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

      const action: LaunchPaneAction = {
        targetPane: tmuxPane,
        semanticPaneId: paneIdentities[rowIdx]![paneIdx]!,
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

  return { focusPane, paneActions, diagnostics };
}

function assignPaneIdentities(
  rows: readonly Row[],
  diagnostics: LaunchPlanDiagnostic[],
): string[][] {
  const bases = rows.map((row) => row.panes.map(semanticPaneIdForPane));
  const implicitCounts = new Map<string, number>();
  const explicitIds = new Set<string>();
  for (const [rowIndex, row] of rows.entries()) {
    for (const [paneIndex, pane] of row.panes.entries()) {
      const base = bases[rowIndex]![paneIndex]!;
      if (pane.id) {
        if (explicitIds.has(base)) throw new Error(`duplicate explicit pane id "${base}"`);
        explicitIds.add(base);
      } else {
        implicitCounts.set(base, (implicitCounts.get(base) ?? 0) + 1);
      }
    }
  }

  const occurrences = new Map<string, number>();
  const assigned = new Set(explicitIds);
  return rows.map((row, rowIndex) =>
    row.panes.map((pane, paneIndex) => {
      const base = bases[rowIndex]![paneIndex]!;
      if (pane.id) return base;
      const total = implicitCounts.get(base) ?? 1;
      const occurrence = (occurrences.get(base) ?? 0) + 1;
      occurrences.set(base, occurrence);
      const candidate = total === 1 ? base : `${base}-${occurrence}`;
      if (assigned.has(candidate)) {
        throw new Error(
          `explicit pane id "${candidate}" collides with a derived pane identity; choose another explicit id`,
        );
      }
      assigned.add(candidate);
      if (total > 1 && occurrence === 1) {
        diagnostics.push({
          code: "AMBIGUOUS_IMPLICIT_PANE_ID",
          message: `${total} panes produce the same implicit identity fingerprint. Assigned occurrence suffixes for compatibility; add explicit pane ids to preserve their individual identity across insert/delete.`,
        });
      }
      return candidate;
    }),
  );
}

function paneIdentityLabel(pane: Pane): string {
  const raw =
    pane.title ?? pane.type ?? pane.role ?? pane.command?.trim().split(/\s+/u)[0] ?? "shell";
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 32);
  return slug || "pane";
}
