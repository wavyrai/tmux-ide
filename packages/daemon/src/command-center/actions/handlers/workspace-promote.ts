import type {
  WorkspacePromoteArguments,
  WorkspacePromoteMutationRequest,
  WorkspacePromoteMutationResult,
} from "@tmux-ide/contracts";

import { WorkspacePromotionError } from "../../../lib/workspace-promotion.ts";
import { ActionError } from "../errors.ts";
import type { ActionExecutionContext } from "../registry.ts";

export interface WorkspacePromotionBackend {
  promote(input: WorkspacePromoteMutationRequest): Promise<WorkspacePromoteMutationResult>;
}

export async function workspacePromoteHandler(
  input: WorkspacePromoteArguments,
  context: ActionExecutionContext = {},
  deps: { authority?: WorkspacePromotionBackend } = {},
): Promise<WorkspacePromoteMutationResult> {
  const authority = deps.authority ?? context.workspacePromotionBackend;
  if (!authority) {
    throw new ActionError({
      code: "workspace_unavailable",
      message: "Workspace promotion is not available from this daemon.",
    });
  }
  if (!context.operationId || !context.daemonInstanceId) {
    throw new ActionError({
      code: "bad_request",
      message: "Workspace promotion requires trusted host retry and generation metadata.",
    });
  }
  try {
    return await authority.promote({
      operationId: context.operationId,
      expectedDaemonInstanceId: context.daemonInstanceId,
      intent: input,
    });
  } catch (error) {
    if (!(error instanceof WorkspacePromotionError)) throw error;
    throw new ActionError({
      code: error.code,
      message: error.message,
      details: error.context,
      cause: error,
    });
  }
}
