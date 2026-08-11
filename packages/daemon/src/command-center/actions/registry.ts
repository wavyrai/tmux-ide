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
  type AppWindowMutationRequest,
  type AppWindowMutationResult,
  ActionContractsZ,
  type WorkspacePaneCreateMutationRequest,
  type WorkspacePaneCreateMutationResult,
  type WorkspaceOpenMutationRequest,
  type WorkspaceOpenMutationResult,
  type WorkspacePromoteMutationRequest,
  type WorkspacePromoteMutationResult,
  type WorkspaceMultiplexerMutationRequest,
  type WorkspaceMultiplexerMutationResult,
  type ActionInput,
  type ActionName,
  type ActionResult,
} from "./contract.ts";
import { appWindowMutateHandler } from "./handlers/app-window-mutate.ts";
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
import { workspaceOpenHandler } from "./handlers/workspace-open.ts";
import { workspacePromoteHandler } from "./handlers/workspace-promote.ts";
import {
  workspacePaneKillHandler,
  workspacePaneResizeHandler,
  workspacePaneSelectHandler,
  workspacePaneSendHandler,
  workspacePaneSwapHandler,
  workspacePaneZoomToggleHandler,
  workspaceRenameHandler,
  workspaceSessionKillHandler,
  workspaceWindowKillHandler,
  workspaceWindowSplitHandler,
} from "./handlers/workspace-multiplexer.ts";

export interface ActionExecutionContext {
  readonly operationId?: string;
  readonly daemonInstanceId?: string;
  readonly workspacePaneCreationBackend?: {
    create(input: WorkspacePaneCreateMutationRequest): Promise<WorkspacePaneCreateMutationResult>;
  };
  readonly workspaceOpenBackend?: {
    open(input: WorkspaceOpenMutationRequest): Promise<WorkspaceOpenMutationResult>;
  };
  readonly workspacePromotionBackend?: {
    promote(input: WorkspacePromoteMutationRequest): Promise<WorkspacePromoteMutationResult>;
  };
  readonly appWindowMutationBackend?: {
    mutate(input: AppWindowMutationRequest): Promise<AppWindowMutationResult>;
  };
  readonly workspaceMultiplexerBackend?: {
    mutate(
      input: WorkspaceMultiplexerMutationRequest,
      authenticatedHostClientId?: string,
      sourcePaneCredential?: string,
      ownerAuthorized?: boolean,
    ): Promise<WorkspaceMultiplexerMutationResult>;
  };
  /** Owner-authenticated host principal injected outside request JSON. */
  readonly hostClientId?: string;
  /** Generation-scoped local tmux pane proof, carried only in a header. */
  readonly sourcePaneCredential?: string;
  /** Verified owner bearer fact injected by middleware, never request JSON. */
  readonly ownerAuthorized?: boolean;
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
  "workspace.open": {
    inputSchema: ActionContractsZ["workspace.open"].input,
    resultSchema: ActionContractsZ["workspace.open"].result,
    handler: (input) => workspaceOpenHandler(input),
    handlerWithContext: workspaceOpenHandler,
  },
  "workspace.promote": {
    inputSchema: ActionContractsZ["workspace.promote"].input,
    resultSchema: ActionContractsZ["workspace.promote"].result,
    handler: (input) => workspacePromoteHandler(input),
    handlerWithContext: workspacePromoteHandler,
  },
  "workspace.app-window.mutate": {
    inputSchema: ActionContractsZ["workspace.app-window.mutate"].input,
    resultSchema: ActionContractsZ["workspace.app-window.mutate"].result,
    handler: (input) => appWindowMutateHandler(input),
    handlerWithContext: appWindowMutateHandler,
  },
  "workspace.window.split": {
    inputSchema: ActionContractsZ["workspace.window.split"].input,
    resultSchema: ActionContractsZ["workspace.window.split"].result,
    handler: (input) => workspaceWindowSplitHandler(input),
    handlerWithContext: workspaceWindowSplitHandler,
  },
  "workspace.window.kill": {
    inputSchema: ActionContractsZ["workspace.window.kill"].input,
    resultSchema: ActionContractsZ["workspace.window.kill"].result,
    handler: (input) => workspaceWindowKillHandler(input),
    handlerWithContext: workspaceWindowKillHandler,
  },
  "workspace.pane.kill": {
    inputSchema: ActionContractsZ["workspace.pane.kill"].input,
    resultSchema: ActionContractsZ["workspace.pane.kill"].result,
    handler: (input) => workspacePaneKillHandler(input),
    handlerWithContext: workspacePaneKillHandler,
  },
  "workspace.session.kill": {
    inputSchema: ActionContractsZ["workspace.session.kill"].input,
    resultSchema: ActionContractsZ["workspace.session.kill"].result,
    handler: (input) => workspaceSessionKillHandler(input),
    handlerWithContext: workspaceSessionKillHandler,
  },
  "workspace.rename": {
    inputSchema: ActionContractsZ["workspace.rename"].input,
    resultSchema: ActionContractsZ["workspace.rename"].result,
    handler: (input) => workspaceRenameHandler(input),
    handlerWithContext: workspaceRenameHandler,
  },
  "workspace.pane.zoom.toggle": {
    inputSchema: ActionContractsZ["workspace.pane.zoom.toggle"].input,
    resultSchema: ActionContractsZ["workspace.pane.zoom.toggle"].result,
    handler: (input) => workspacePaneZoomToggleHandler(input),
    handlerWithContext: workspacePaneZoomToggleHandler,
  },
  "workspace.pane.select": {
    inputSchema: ActionContractsZ["workspace.pane.select"].input,
    resultSchema: ActionContractsZ["workspace.pane.select"].result,
    handler: (input) => workspacePaneSelectHandler(input),
    handlerWithContext: workspacePaneSelectHandler,
  },
  "workspace.pane.send": {
    inputSchema: ActionContractsZ["workspace.pane.send"].input,
    resultSchema: ActionContractsZ["workspace.pane.send"].result,
    handler: (input) => workspacePaneSendHandler(input),
    handlerWithContext: workspacePaneSendHandler,
  },
  "workspace.pane.swap": {
    inputSchema: ActionContractsZ["workspace.pane.swap"].input,
    resultSchema: ActionContractsZ["workspace.pane.swap"].result,
    handler: (input) => workspacePaneSwapHandler(input),
    handlerWithContext: workspacePaneSwapHandler,
  },
  "workspace.pane.resize": {
    inputSchema: ActionContractsZ["workspace.pane.resize"].input,
    resultSchema: ActionContractsZ["workspace.pane.resize"].result,
    handler: (input) => workspacePaneResizeHandler(input),
    handlerWithContext: workspacePaneResizeHandler,
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
