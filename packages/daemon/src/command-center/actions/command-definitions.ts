import {
  ACTION_NAMES,
  ActionContractsZ,
  COMMAND_PROTOCOL_VERSION,
  type ActionName,
  type CommandDescriptor,
} from "@tmux-ide/contracts";
import type { ZodType } from "zod";
import { CommandRegistry, type CommandDefinition } from "../../lib/command-registry.ts";

interface ActionCommandMetadata {
  label: string;
  category: string;
  dangerous?: boolean;
}

const ACTION_COMMAND_METADATA: Record<ActionName, ActionCommandMetadata> = {
  "project.openTerminal": { label: "Open project terminal", category: "project" },
  "project.launch": { label: "Launch project", category: "project" },
  "project.stop": { label: "Stop project", category: "project", dangerous: true },
  "project.restart": { label: "Restart project", category: "project", dangerous: true },
  "project.activate": { label: "Activate project", category: "project" },
  "terminal.respawn": { label: "Respawn terminal", category: "terminal" },
  "terminal.stop": { label: "Stop terminal", category: "terminal", dangerous: true },
  "config.set": { label: "Set configuration value", category: "configuration" },
  "config.addPane": { label: "Add configuration pane", category: "configuration" },
  "config.removePane": {
    label: "Remove configuration pane",
    category: "configuration",
    dangerous: true,
  },
  "config.addRow": { label: "Add configuration row", category: "configuration" },
  "config.enableTeam": { label: "Enable legacy team configuration", category: "compatibility" },
  "config.disableTeam": {
    label: "Disable legacy team configuration",
    category: "compatibility",
  },
  "app.setRemoteAccess": { label: "Set remote access", category: "application" },
  "daemon.shutdown": { label: "Shut down daemon", category: "daemon", dangerous: true },
  "workspace.pane.create": { label: "Create workspace pane", category: "workspace" },
  "workspace.open": { label: "Open config-free workspace", category: "workspace" },
  "workspace.open.prepare": { label: "Prepare workspace handoff", category: "workspace" },
  "workspace.session.create": { label: "Create session", category: "workspace" },
  "fleet.agent.mutate": { label: "Manage fleet agent", category: "workspace" },
  "workspace.open.commit": { label: "Commit workspace handoff", category: "workspace" },
  "workspace.open.cancel": { label: "Cancel workspace handoff", category: "workspace" },
  "workspace.promote": { label: "Promote adopted session to workspace", category: "workspace" },
  "workspace.app-window.mutate": { label: "Mutate application window", category: "workspace" },
  "workspace.window.split": { label: "Split pane", category: "workspace" },
  "workspace.window.kill": { label: "Close window", category: "workspace", dangerous: true },
  "workspace.pane.kill": { label: "Close pane", category: "workspace", dangerous: true },
  "workspace.session.kill": { label: "Close session", category: "workspace", dangerous: true },
  "workspace.rename": { label: "Rename session or window", category: "workspace" },
  "workspace.pane.zoom.toggle": { label: "Toggle pane zoom", category: "workspace" },
  "workspace.pane.select": { label: "Focus pane", category: "workspace" },
  "workspace.pane.send": { label: "Send pane input", category: "workspace" },
  "workspace.pane.swap": { label: "Swap panes", category: "workspace" },
  "workspace.pane.resize": { label: "Resize pane", category: "workspace" },
};

function actionDescriptor(name: ActionName): CommandDescriptor {
  const metadata = ACTION_COMMAND_METADATA[name];
  return Object.freeze({
    version: COMMAND_PROTOCOL_VERSION,
    id: name,
    owner: "daemon",
    label: metadata.label,
    category: metadata.category,
    schemas: Object.freeze({
      input: `${name}.input.v1`,
      result: `${name}.result.v1`,
    }),
    dangerous: metadata.dangerous === true,
    // Existing HTTP/CLI compatibility paths do not add interactive prompts.
    confirmation: "none",
  });
}

/** Every existing action adapted to the shared, handler-free command catalog. */
export const DAEMON_ACTION_COMMAND_DEFINITIONS: readonly CommandDefinition[] = Object.freeze(
  ACTION_NAMES.map((name) =>
    Object.freeze({
      descriptor: actionDescriptor(name),
      inputSchema: ActionContractsZ[name].input as ZodType<unknown>,
      resultSchema: ActionContractsZ[name].result as ZodType<unknown>,
    }),
  ),
);

export const daemonActionCommandRegistry = new CommandRegistry(DAEMON_ACTION_COMMAND_DEFINITIONS);
