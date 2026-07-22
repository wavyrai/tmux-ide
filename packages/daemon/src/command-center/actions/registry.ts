/**
 * Registry: maps each action name to its input/output schemas and handler.
 *
 * The dispatcher in `dispatcher.ts` is the only consumer — it parses the
 * URL `:name` against `ACTION_NAMES`, then looks up the handler here. Every
 * handler accepts a typed input and returns the typed result; the
 * dispatcher applies output-side Zod validation as defense in depth.
 *
 * Adding a new action: define schemas in `contract.ts`, add a handler in
 * `handlers/`, then wire it here.
 */

import type { z } from "zod";
import {
  ActionContractsZ,
  type WorkspacePaneCreateMutationRequest,
  type WorkspacePaneCreateMutationResult,
  type ActionInput,
  type ActionName,
  type ActionResult,
} from "./contract.ts";
import { projectOpenTerminalHandler } from "./handlers/project-open-terminal.ts";
import { projectActivateHandler } from "./handlers/project-activate.ts";
import { projectLaunchHandler } from "./handlers/project-launch.ts";
import { projectStopHandler } from "./handlers/project-stop.ts";
import { projectRestartHandler } from "./handlers/project-restart.ts";
import { terminalRespawnHandler } from "./handlers/terminal-respawn.ts";
import { terminalStopHandler } from "./handlers/terminal-stop.ts";
import {
  configAddPaneHandler,
  configAddRowHandler,
  configDisableTeamHandler,
  configEnableTeamHandler,
  configRemovePaneHandler,
  configSetHandler,
} from "./handlers/config-actions.ts";
import { appSetRemoteAccessHandler } from "./handlers/app-set-remote-access.ts";
import { daemonShutdownHandler } from "./handlers/daemon-shutdown.ts";
import { workspacePaneCreateHandler } from "./handlers/workspace-pane-create.ts";

export interface ActionExecutionContext {
  readonly operationId?: string;
  readonly daemonInstanceId?: string;
  readonly workspacePaneCreationBackend?: {
    create(input: WorkspacePaneCreateMutationRequest): Promise<WorkspacePaneCreateMutationResult>;
  };
}

export type ActionHandler<N extends ActionName> = (
  input: ActionInput<N>,
) => Promise<ActionResult<N>> | ActionResult<N>;

export interface ActionRegistryEntry<N extends ActionName> {
  inputSchema: (typeof ActionContractsZ)[N]["input"];
  resultSchema: (typeof ActionContractsZ)[N]["result"];
  handler: ActionHandler<N>;
  handlerWithContext?: (
    input: ActionInput<N>,
    context: ActionExecutionContext,
  ) => Promise<ActionResult<N>> | ActionResult<N>;
}

type RegistryShape = {
  [N in ActionName]: ActionRegistryEntry<N>;
};

export const actionRegistry: RegistryShape = {
  "project.openTerminal": {
    inputSchema: ActionContractsZ["project.openTerminal"].input,
    resultSchema: ActionContractsZ["project.openTerminal"].result,
    handler: projectOpenTerminalHandler,
  },
  "project.launch": {
    inputSchema: ActionContractsZ["project.launch"].input,
    resultSchema: ActionContractsZ["project.launch"].result,
    handler: projectLaunchHandler,
  },
  "project.stop": {
    inputSchema: ActionContractsZ["project.stop"].input,
    resultSchema: ActionContractsZ["project.stop"].result,
    handler: projectStopHandler,
  },
  "project.restart": {
    inputSchema: ActionContractsZ["project.restart"].input,
    resultSchema: ActionContractsZ["project.restart"].result,
    handler: projectRestartHandler,
  },
  "project.activate": {
    inputSchema: ActionContractsZ["project.activate"].input,
    resultSchema: ActionContractsZ["project.activate"].result,
    handler: projectActivateHandler,
  },
  "terminal.respawn": {
    inputSchema: ActionContractsZ["terminal.respawn"].input,
    resultSchema: ActionContractsZ["terminal.respawn"].result,
    handler: terminalRespawnHandler,
  },
  "terminal.stop": {
    inputSchema: ActionContractsZ["terminal.stop"].input,
    resultSchema: ActionContractsZ["terminal.stop"].result,
    handler: terminalStopHandler,
  },
  "config.set": {
    inputSchema: ActionContractsZ["config.set"].input,
    resultSchema: ActionContractsZ["config.set"].result,
    handler: configSetHandler,
  },
  "config.addPane": {
    inputSchema: ActionContractsZ["config.addPane"].input,
    resultSchema: ActionContractsZ["config.addPane"].result,
    handler: configAddPaneHandler,
  },
  "config.removePane": {
    inputSchema: ActionContractsZ["config.removePane"].input,
    resultSchema: ActionContractsZ["config.removePane"].result,
    handler: configRemovePaneHandler,
  },
  "config.addRow": {
    inputSchema: ActionContractsZ["config.addRow"].input,
    resultSchema: ActionContractsZ["config.addRow"].result,
    handler: configAddRowHandler,
  },
  "config.enableTeam": {
    inputSchema: ActionContractsZ["config.enableTeam"].input,
    resultSchema: ActionContractsZ["config.enableTeam"].result,
    handler: configEnableTeamHandler,
  },
  "config.disableTeam": {
    inputSchema: ActionContractsZ["config.disableTeam"].input,
    resultSchema: ActionContractsZ["config.disableTeam"].result,
    handler: configDisableTeamHandler,
  },
  "app.setRemoteAccess": {
    inputSchema: ActionContractsZ["app.setRemoteAccess"].input,
    resultSchema: ActionContractsZ["app.setRemoteAccess"].result,
    handler: appSetRemoteAccessHandler,
  },
  "daemon.shutdown": {
    inputSchema: ActionContractsZ["daemon.shutdown"].input,
    resultSchema: ActionContractsZ["daemon.shutdown"].result,
    handler: daemonShutdownHandler,
  },
  "workspace.pane.create": {
    inputSchema: ActionContractsZ["workspace.pane.create"].input,
    resultSchema: ActionContractsZ["workspace.pane.create"].result,
    handler: (input) => workspacePaneCreateHandler(input),
    handlerWithContext: workspacePaneCreateHandler,
  },
};

/**
 * Generic accessor that preserves the `N` type binding. Exposed as a
 * convenience for tests; the dispatcher uses the registry directly.
 */
export function getActionEntry<N extends ActionName>(name: N): ActionRegistryEntry<N> {
  return actionRegistry[name];
}

// Re-export the loosely-typed shape used by the dispatcher loop. Casting
// once here prevents the dispatcher from carrying the conditional type
// through its run-time logic.
export type LooseActionEntry = ActionRegistryEntry<ActionName> & {
  inputSchema: z.ZodTypeAny;
  resultSchema: z.ZodTypeAny;
  handler: (input: unknown, context?: ActionExecutionContext) => Promise<unknown> | unknown;
  handlerWithContext?: (
    input: unknown,
    context: ActionExecutionContext,
  ) => Promise<unknown> | unknown;
};

export function getLooseActionEntry(name: ActionName): LooseActionEntry {
  return actionRegistry[name] as unknown as LooseActionEntry;
}
