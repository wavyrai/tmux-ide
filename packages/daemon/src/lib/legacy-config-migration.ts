import { WorkspaceConfigV1SchemaZ, type WorkspaceConfigV1 } from "@tmux-ide/contracts";
import yaml from "js-yaml";
import type { IdeConfig, Pane } from "../types.ts";

export type LegacyMigrationDiagnosticCode =
  | "UNSUPPORTED_TEAM"
  | "UNSUPPORTED_ORCHESTRATOR"
  | "UNSUPPORTED_COMMAND_CENTER"
  | "UNSUPPORTED_DASHBOARD"
  | "UNSUPPORTED_AUTH"
  | "UNSUPPORTED_TUNNEL"
  | "UNSUPPORTED_HQ"
  | "UNSUPPORTED_SIDEBAR"
  | "UNSUPPORTED_UNKNOWN_FIELD"
  | "UNSUPPORTED_PANE_ROLE"
  | "UNSUPPORTED_PANE_TASK"
  | "UNSUPPORTED_PANE_SPECIALTY"
  | "UNSUPPORTED_PANE_SKILL";

export interface LegacyMigrationDiagnostic {
  code: LegacyMigrationDiagnosticCode;
  path: string;
  message: string;
}

export interface LegacyMigrationResult {
  workspace: WorkspaceConfigV1;
  diagnostics: LegacyMigrationDiagnostic[];
}

const ROOT_UNSUPPORTED: [keyof IdeConfig, LegacyMigrationDiagnosticCode, string][] = [
  ["team", "UNSUPPORTED_TEAM", "agent team metadata is compatibility-only in ide.yml"],
  [
    "orchestrator",
    "UNSUPPORTED_ORCHESTRATOR",
    "retired orchestrator settings are not WorkspaceConfigV1",
  ],
  ["command_center", "UNSUPPORTED_COMMAND_CENTER", "command-center settings are runtime state"],
  ["dashboard", "UNSUPPORTED_DASHBOARD", "dashboard settings are retired"],
  ["auth", "UNSUPPORTED_AUTH", "auth settings are not part of WorkspaceConfigV1"],
  ["tunnel", "UNSUPPORTED_TUNNEL", "tunnel settings are not part of WorkspaceConfigV1"],
  ["hq", "UNSUPPORTED_HQ", "HQ settings are not part of WorkspaceConfigV1"],
  ["sidebar", "UNSUPPORTED_SIDEBAR", "sidebar sugar is not part of WorkspaceConfigV1"],
];

const PANE_UNSUPPORTED: [keyof Pane, LegacyMigrationDiagnosticCode, string][] = [
  ["role", "UNSUPPORTED_PANE_ROLE", "agent pane role metadata is not migrated"],
  ["task", "UNSUPPORTED_PANE_TASK", "agent pane task metadata is not migrated"],
  ["specialty", "UNSUPPORTED_PANE_SPECIALTY", "agent pane specialty metadata is not migrated"],
  ["skill", "UNSUPPORTED_PANE_SKILL", "agent pane skill metadata is not migrated"],
];

function pushDiagnostic(
  diagnostics: LegacyMigrationDiagnostic[],
  code: LegacyMigrationDiagnosticCode,
  path: string,
  message: string,
): void {
  diagnostics.push({ code, path, message });
}

function cloneTerminalPane(
  pane: Pane,
): NonNullable<WorkspaceConfigV1["terminal"]>["rows"][number]["panes"][number] {
  const result: NonNullable<WorkspaceConfigV1["terminal"]>["rows"][number]["panes"][number] = {};
  if (pane.id !== undefined) result.id = pane.id;
  if (pane.title !== undefined) result.title = pane.title;
  if (pane.command !== undefined) result.command = pane.command;
  if (pane.type !== undefined) result.type = pane.type;
  if (pane.target !== undefined) result.target = pane.target;
  if (pane.dir !== undefined) result.dir = pane.dir;
  if (pane.size !== undefined) result.size = pane.size;
  if (pane.focus !== undefined) result.focus = pane.focus;
  if (pane.env !== undefined) {
    result.env = { ...pane.env };
  }
  return result;
}

export function convertLegacyConfigToWorkspace(legacy: IdeConfig): LegacyMigrationResult {
  const diagnostics: LegacyMigrationDiagnostic[] = [];
  const rows = legacy.rows.map((row, rowIndex) => ({
    ...(row.size === undefined ? {} : { size: row.size }),
    panes: row.panes.map((pane, paneIndex) => {
      for (const [key, code, message] of PANE_UNSUPPORTED) {
        if (pane[key] !== undefined) {
          pushDiagnostic(diagnostics, code, `rows.${rowIndex}.panes.${paneIndex}.${key}`, message);
        }
      }
      return cloneTerminalPane(pane);
    }),
  }));

  for (const [key, code, message] of ROOT_UNSUPPORTED) {
    if (legacy[key] !== undefined) pushDiagnostic(diagnostics, code, String(key), message);
  }

  const candidate: WorkspaceConfigV1 = {
    version: 1,
    ...(legacy.name === undefined ? {} : { name: legacy.name }),
    ...(legacy.before === undefined ? {} : { before: legacy.before }),
    terminal: {
      rows,
      ...(legacy.theme === undefined ? {} : { theme: { ...legacy.theme } }),
    },
    app: {
      views: [
        { id: "home", title: "Home", panel: "home" },
        { id: "terminals", title: "Terminals", panel: "terminals" },
        { id: "files", title: "Files", panel: "files" },
        { id: "diff", title: "Diff", panel: "diff" },
        { id: "missions", title: "Missions", panel: "missions" },
      ],
    },
  };

  const parsed = WorkspaceConfigV1SchemaZ.parse(candidate);
  return { workspace: parsed, diagnostics };
}

export function workspaceConfigToLegacyProjection(workspace: WorkspaceConfigV1): IdeConfig {
  return {
    ...(workspace.name === undefined ? {} : { name: workspace.name }),
    ...(workspace.before === undefined ? {} : { before: workspace.before }),
    rows: (workspace.terminal?.rows ?? [{ panes: [{ title: "Shell" }] }]).map((row) => ({
      ...(row.size === undefined ? {} : { size: row.size }),
      panes: row.panes.map((pane) => ({
        ...(pane.id === undefined ? {} : { id: pane.id }),
        ...(pane.title === undefined ? {} : { title: pane.title }),
        ...(pane.command === undefined ? {} : { command: pane.command }),
        ...(pane.type === undefined ? {} : { type: pane.type }),
        ...(pane.target === undefined ? {} : { target: pane.target }),
        ...(pane.dir === undefined ? {} : { dir: pane.dir }),
        ...(pane.size === undefined ? {} : { size: pane.size }),
        ...(pane.focus === undefined ? {} : { focus: pane.focus }),
        ...(pane.env === undefined ? {} : { env: { ...pane.env } }),
      })),
    })),
    ...(workspace.terminal?.theme === undefined ? {} : { theme: { ...workspace.terminal.theme } }),
  };
}

export function workspaceConfigToYaml(workspace: WorkspaceConfigV1): string {
  return yaml.dump(workspace, { lineWidth: -1, noRefs: true, quotingType: '"' });
}
