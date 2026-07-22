import type {
  WorkspaceOpenArguments,
  WorkspaceOpenMutationRequest,
  WorkspaceOpenMutationResult,
} from "@tmux-ide/contracts";

import { WorkspaceOpenError } from "../../../lib/workspace-open.ts";
import { ActionError } from "../errors.ts";
import type { ActionExecutionContext } from "../registry.ts";

export interface WorkspaceOpenBackend {
  open(input: WorkspaceOpenMutationRequest): Promise<WorkspaceOpenMutationResult>;
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
