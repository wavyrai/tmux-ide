import type {
  WorkspaceOpenCancelledResult,
  WorkspaceOpenCommittedResult,
  WorkspaceOpenDecisionArguments,
  WorkspaceOpenArguments,
  WorkspaceOpenMutationRequest,
  WorkspaceOpenMutationResult,
  WorkspaceOpenPrepareArguments,
  WorkspaceOpenPreparedResult,
} from "@tmux-ide/contracts";

import { WorkspaceOpenError } from "../../../lib/workspace-open.ts";
import { WorkspaceOpenHandoffError } from "../../../lib/workspace-open-handoff.ts";
import { ActionError } from "../errors.ts";
import type { ActionExecutionContext } from "../registry.ts";

export interface WorkspaceOpenBackend {
  open(input: WorkspaceOpenMutationRequest): Promise<WorkspaceOpenMutationResult>;
}

export interface WorkspaceOpenHandoffBackend {
  prepare(
    operationId: string,
    generation: string,
    clientId: string,
    input: WorkspaceOpenPrepareArguments,
  ): Promise<WorkspaceOpenPreparedResult>;
  commit(
    operationId: string,
    generation: string,
    clientId: string,
    input: WorkspaceOpenDecisionArguments,
  ): WorkspaceOpenCommittedResult;
  cancel(
    operationId: string,
    generation: string,
    clientId: string,
    input: WorkspaceOpenDecisionArguments,
  ): WorkspaceOpenCancelledResult;
}

function handoffContext(context: ActionExecutionContext): [string, string, string] {
  if (!context.operationId || !context.daemonInstanceId || !context.hostClientId) {
    throw new ActionError({
      code: "bad_request",
      message: "Workspace handoff requires trusted operation, generation, and client identity.",
    });
  }
  return [context.operationId, context.daemonInstanceId, context.hostClientId];
}

async function mapHandoff<T>(run: () => Promise<T> | T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof WorkspaceOpenHandoffError)) throw error;
    throw new ActionError({
      code: "workspace_unavailable",
      message: error.message,
      details: { handoffCode: error.code },
      cause: error,
    });
  }
}

export async function workspaceOpenPrepareHandler(
  input: WorkspaceOpenPrepareArguments,
  context: ActionExecutionContext,
): Promise<WorkspaceOpenPreparedResult> {
  const backend = context.workspaceOpenHandoffBackend;
  if (!backend)
    throw new ActionError({
      code: "workspace_unavailable",
      message: "Atomic workspace handoff is unavailable.",
    });
  const [operation, generation, client] = handoffContext(context);
  return await mapHandoff(() => backend.prepare(operation, generation, client, input));
}

export async function workspaceOpenCommitHandler(
  input: WorkspaceOpenDecisionArguments,
  context: ActionExecutionContext,
): Promise<WorkspaceOpenCommittedResult> {
  const backend = context.workspaceOpenHandoffBackend;
  if (!backend)
    throw new ActionError({
      code: "workspace_unavailable",
      message: "Atomic workspace handoff is unavailable.",
    });
  const [operation, generation, client] = handoffContext(context);
  return await mapHandoff(() => backend.commit(operation, generation, client, input));
}

export async function workspaceOpenCancelHandler(
  input: WorkspaceOpenDecisionArguments,
  context: ActionExecutionContext,
): Promise<WorkspaceOpenCancelledResult> {
  const backend = context.workspaceOpenHandoffBackend;
  if (!backend)
    throw new ActionError({
      code: "workspace_unavailable",
      message: "Atomic workspace handoff is unavailable.",
    });
  const [operation, generation, client] = handoffContext(context);
  return await mapHandoff(() => backend.cancel(operation, generation, client, input));
}

export async function workspaceOpenHandler(
  input: WorkspaceOpenArguments,
  context: ActionExecutionContext = {},
  deps: { authority?: WorkspaceOpenBackend } = {},
): Promise<WorkspaceOpenMutationResult> {
  const authority = deps.authority ?? context.workspaceOpenBackend;
  if (!authority) {
    throw new ActionError({
      code: "workspace_unavailable",
      message: "Config-free workspace opening is not available from this daemon.",
    });
  }
  if (!context.operationId || !context.daemonInstanceId) {
    throw new ActionError({
      code: "bad_request",
      message: "Workspace opening requires trusted host retry and generation metadata.",
    });
  }
  try {
    return await authority.open({
      operationId: context.operationId,
      expectedDaemonInstanceId: context.daemonInstanceId,
      intent: input,
    });
  } catch (error) {
    if (!(error instanceof WorkspaceOpenError)) throw error;
    throw new ActionError({
      code: error.code,
      message: error.message,
      details: error.context,
      cause: error,
    });
  }
}
