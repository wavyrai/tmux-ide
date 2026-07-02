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
  goalCreateHandler,
  goalDeleteHandler,
  goalDoneHandler,
  goalUpdateHandler,
  milestoneCreateHandler,
  milestoneUpdateHandler,
  missionClearHandler,
  missionPlanCompleteHandler,
  missionSetHandler,
  taskClaimHandler,
  taskCreateHandler,
  taskDeleteHandler,
  taskDoneHandler,
  taskUpdateHandler,
} from "./handlers/task-system.ts";
import {
  skillCreateHandler,
  skillDeleteHandler,
  skillUpdateHandler,
} from "./handlers/skill-actions.ts";
import {
  configAddPaneHandler,
  configAddRowHandler,
  configDisableTeamHandler,
  configEnableTeamHandler,
  configRemovePaneHandler,
  configSetHandler,
} from "./handlers/config-actions.ts";
import { validationAssertHandler, validationReportHandler } from "./handlers/validation-actions.ts";
import {
  webhookAddHandler,
  webhookRemoveHandler,
  webhookTestHandler,
} from "./handlers/webhook-actions.ts";
import { appSetRemoteAccessHandler } from "./handlers/app-set-remote-access.ts";
import { daemonShutdownHandler } from "./handlers/daemon-shutdown.ts";
import {
  agentHeartbeatHandler,
  agentRegisterHandler,
  agentUnregisterHandler,
} from "./handlers/agent-actions.ts";
import { chatContextCaptureTerminalHandler } from "../../chat/context-actions.ts";
import {
  chatPermissionRespondHandler,
  chatProvidersListHandler,
  chatSessionCancelHandler,
  chatSessionEditFromTurnHandler,
  chatSessionSendHandler,
  chatThreadCreateHandler,
  chatThreadDeleteHandler,
  chatThreadGetHandler,
  chatThreadListHandler,
  chatThreadRenameHandler,
  chatThreadSetProviderHandler,
  chatThreadUsageHandler,
} from "./handlers/chat-actions.ts";

export type ActionHandler<N extends ActionName> = (
  input: ActionInput<N>,
) => Promise<ActionResult<N>> | ActionResult<N>;

export interface ActionRegistryEntry<N extends ActionName> {
  inputSchema: (typeof ActionContractsZ)[N]["input"];
  resultSchema: (typeof ActionContractsZ)[N]["result"];
  handler: ActionHandler<N>;
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
  "task.create": {
    inputSchema: ActionContractsZ["task.create"].input,
    resultSchema: ActionContractsZ["task.create"].result,
    handler: taskCreateHandler,
  },
  "task.update": {
    inputSchema: ActionContractsZ["task.update"].input,
    resultSchema: ActionContractsZ["task.update"].result,
    handler: taskUpdateHandler,
  },
  "task.claim": {
    inputSchema: ActionContractsZ["task.claim"].input,
    resultSchema: ActionContractsZ["task.claim"].result,
    handler: taskClaimHandler,
  },
  "task.done": {
    inputSchema: ActionContractsZ["task.done"].input,
    resultSchema: ActionContractsZ["task.done"].result,
    handler: taskDoneHandler,
  },
  "task.delete": {
    inputSchema: ActionContractsZ["task.delete"].input,
    resultSchema: ActionContractsZ["task.delete"].result,
    handler: taskDeleteHandler,
  },
  "goal.create": {
    inputSchema: ActionContractsZ["goal.create"].input,
    resultSchema: ActionContractsZ["goal.create"].result,
    handler: goalCreateHandler,
  },
  "goal.update": {
    inputSchema: ActionContractsZ["goal.update"].input,
    resultSchema: ActionContractsZ["goal.update"].result,
    handler: goalUpdateHandler,
  },
  "goal.done": {
    inputSchema: ActionContractsZ["goal.done"].input,
    resultSchema: ActionContractsZ["goal.done"].result,
    handler: goalDoneHandler,
  },
  "goal.delete": {
    inputSchema: ActionContractsZ["goal.delete"].input,
    resultSchema: ActionContractsZ["goal.delete"].result,
    handler: goalDeleteHandler,
  },
  "milestone.create": {
    inputSchema: ActionContractsZ["milestone.create"].input,
    resultSchema: ActionContractsZ["milestone.create"].result,
    handler: milestoneCreateHandler,
  },
  "milestone.update": {
    inputSchema: ActionContractsZ["milestone.update"].input,
    resultSchema: ActionContractsZ["milestone.update"].result,
    handler: milestoneUpdateHandler,
  },
  "mission.set": {
    inputSchema: ActionContractsZ["mission.set"].input,
    resultSchema: ActionContractsZ["mission.set"].result,
    handler: missionSetHandler,
  },
  "mission.planComplete": {
    inputSchema: ActionContractsZ["mission.planComplete"].input,
    resultSchema: ActionContractsZ["mission.planComplete"].result,
    handler: missionPlanCompleteHandler,
  },
  "mission.clear": {
    inputSchema: ActionContractsZ["mission.clear"].input,
    resultSchema: ActionContractsZ["mission.clear"].result,
    handler: missionClearHandler,
  },
  "skill.create": {
    inputSchema: ActionContractsZ["skill.create"].input,
    resultSchema: ActionContractsZ["skill.create"].result,
    handler: skillCreateHandler,
  },
  "skill.update": {
    inputSchema: ActionContractsZ["skill.update"].input,
    resultSchema: ActionContractsZ["skill.update"].result,
    handler: skillUpdateHandler,
  },
  "skill.delete": {
    inputSchema: ActionContractsZ["skill.delete"].input,
    resultSchema: ActionContractsZ["skill.delete"].result,
    handler: skillDeleteHandler,
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
  "validation.assert": {
    inputSchema: ActionContractsZ["validation.assert"].input,
    resultSchema: ActionContractsZ["validation.assert"].result,
    handler: validationAssertHandler,
  },
  "validation.report": {
    inputSchema: ActionContractsZ["validation.report"].input,
    resultSchema: ActionContractsZ["validation.report"].result,
    handler: validationReportHandler,
  },
  "webhook.add": {
    inputSchema: ActionContractsZ["webhook.add"].input,
    resultSchema: ActionContractsZ["webhook.add"].result,
    handler: webhookAddHandler,
  },
  "webhook.remove": {
    inputSchema: ActionContractsZ["webhook.remove"].input,
    resultSchema: ActionContractsZ["webhook.remove"].result,
    handler: webhookRemoveHandler,
  },
  "webhook.test": {
    inputSchema: ActionContractsZ["webhook.test"].input,
    resultSchema: ActionContractsZ["webhook.test"].result,
    handler: webhookTestHandler,
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
  "agent.register": {
    inputSchema: ActionContractsZ["agent.register"].input,
    resultSchema: ActionContractsZ["agent.register"].result,
    handler: agentRegisterHandler,
  },
  "agent.heartbeat": {
    inputSchema: ActionContractsZ["agent.heartbeat"].input,
    resultSchema: ActionContractsZ["agent.heartbeat"].result,
    handler: agentHeartbeatHandler,
  },
  "agent.unregister": {
    inputSchema: ActionContractsZ["agent.unregister"].input,
    resultSchema: ActionContractsZ["agent.unregister"].result,
    handler: agentUnregisterHandler,
  },
  "chat.thread.list": {
    inputSchema: ActionContractsZ["chat.thread.list"].input,
    resultSchema: ActionContractsZ["chat.thread.list"].result,
    handler: chatThreadListHandler,
  },
  "chat.providers.list": {
    inputSchema: ActionContractsZ["chat.providers.list"].input,
    resultSchema: ActionContractsZ["chat.providers.list"].result,
    handler: chatProvidersListHandler,
  },
  "chat.thread.create": {
    inputSchema: ActionContractsZ["chat.thread.create"].input,
    resultSchema: ActionContractsZ["chat.thread.create"].result,
    handler: chatThreadCreateHandler,
  },
  "chat.thread.delete": {
    inputSchema: ActionContractsZ["chat.thread.delete"].input,
    resultSchema: ActionContractsZ["chat.thread.delete"].result,
    handler: chatThreadDeleteHandler,
  },
  "chat.thread.rename": {
    inputSchema: ActionContractsZ["chat.thread.rename"].input,
    resultSchema: ActionContractsZ["chat.thread.rename"].result,
    handler: chatThreadRenameHandler,
  },
  "chat.thread.setProvider": {
    inputSchema: ActionContractsZ["chat.thread.setProvider"].input,
    resultSchema: ActionContractsZ["chat.thread.setProvider"].result,
    handler: chatThreadSetProviderHandler,
  },
  "chat.thread.get": {
    inputSchema: ActionContractsZ["chat.thread.get"].input,
    resultSchema: ActionContractsZ["chat.thread.get"].result,
    handler: chatThreadGetHandler,
  },
  "chat.thread.usage": {
    inputSchema: ActionContractsZ["chat.thread.usage"].input,
    resultSchema: ActionContractsZ["chat.thread.usage"].result,
    handler: chatThreadUsageHandler,
  },
  "chat.session.send": {
    inputSchema: ActionContractsZ["chat.session.send"].input,
    resultSchema: ActionContractsZ["chat.session.send"].result,
    handler: chatSessionSendHandler,
  },
  "chat.session.cancel": {
    inputSchema: ActionContractsZ["chat.session.cancel"].input,
    resultSchema: ActionContractsZ["chat.session.cancel"].result,
    handler: chatSessionCancelHandler,
  },
  "chat.session.editFromTurn": {
    inputSchema: ActionContractsZ["chat.session.editFromTurn"].input,
    resultSchema: ActionContractsZ["chat.session.editFromTurn"].result,
    handler: chatSessionEditFromTurnHandler,
  },
  "chat.permission.respond": {
    inputSchema: ActionContractsZ["chat.permission.respond"].input,
    resultSchema: ActionContractsZ["chat.permission.respond"].result,
    handler: chatPermissionRespondHandler,
  },
  "chat.context.captureTerminal": {
    inputSchema: ActionContractsZ["chat.context.captureTerminal"].input,
    resultSchema: ActionContractsZ["chat.context.captureTerminal"].result,
    handler: chatContextCaptureTerminalHandler,
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
  handler: (input: unknown) => Promise<unknown> | unknown;
};

export function getLooseActionEntry(name: ActionName): LooseActionEntry {
  return actionRegistry[name] as unknown as LooseActionEntry;
}
