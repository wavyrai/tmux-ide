import type {
  WorkspacePaneCreateArguments,
  WorkspacePaneCreateMutationRequest,
  WorkspacePaneCreateMutationResult,
} from "@tmux-ide/contracts";

import { WorkspacePaneCreationError } from "../../../lib/workspace-pane-creation.ts";
import { ActionError } from "../errors.ts";
import type { ActionExecutionContext } from "../registry.ts";

export interface WorkspacePaneCreationBackend {
  create(input: WorkspacePaneCreateMutationRequest): Promise<WorkspacePaneCreateMutationResult>;
}

export async function workspacePaneCreateHandler(
  input: WorkspacePaneCreateArguments,
  context: ActionExecutionContext = {},
  deps: { authority?: WorkspacePaneCreationBackend } = {},
): Promise<WorkspacePaneCreateMutationResult> {
  const authority = deps.authority ?? context.workspacePaneCreationBackend;
  if (!authority) {
    throw new ActionError({
      code: "workspace_unavailable",
      message: "Workspace pane creation is not available from this daemon.",
    });
  }
  if (!context.operationId || !context.daemonInstanceId) {
    throw new ActionError({
      code: "bad_request",
      message: "Workspace pane creation requires trusted host retry and generation metadata.",
    });
  }
  try {
    return await authority.create({
      operationId: context.operationId,
      expectedDaemonInstanceId: context.daemonInstanceId,
      intent: input,
    });
  } catch (error) {
    if (!(error instanceof WorkspacePaneCreationError)) throw error;
    throw new ActionError({
      code: error.code,
      message: error.message,
      details: error.context,
      cause: error,
    });
  }
}
