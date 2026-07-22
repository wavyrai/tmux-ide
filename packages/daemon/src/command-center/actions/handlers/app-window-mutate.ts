import type {
  AppWindowMutationArguments,
  AppWindowMutationRequest,
  AppWindowMutationResult,
} from "@tmux-ide/contracts";

import { AppWindowMutationError } from "../../../lib/app-window-mutation.ts";
import { ActionError } from "../errors.ts";
import type { ActionExecutionContext } from "../registry.ts";

export interface AppWindowMutationBackend {
  mutate(input: AppWindowMutationRequest): Promise<AppWindowMutationResult>;
}

export async function appWindowMutateHandler(
  input: AppWindowMutationArguments,
  context: ActionExecutionContext = {},
  deps: { authority?: AppWindowMutationBackend } = {},
): Promise<AppWindowMutationResult> {
  const authority = deps.authority ?? context.appWindowMutationBackend;
  if (!authority) {
    throw new ActionError({
      code: "workspace_unavailable",
      message: "App-window mutation is not available from this daemon.",
    });
  }
  if (!context.operationId || !context.daemonInstanceId) {
    throw new ActionError({
      code: "bad_request",
      message: "App-window mutation requires trusted host retry and generation metadata.",
    });
  }
  try {
    return await authority.mutate({
      operationId: context.operationId,
      expectedDaemonInstanceId: context.daemonInstanceId,
      intent: input,
    });
  } catch (error) {
    if (!(error instanceof AppWindowMutationError)) throw error;
    const actionCode =
      error.code === "revision_conflict" || error.code === "document_unavailable"
        ? "workspace_resource_changed"
        : error.code === "mutation_failed"
          ? "internal"
          : error.code;
    throw new ActionError({
      code: actionCode,
      message: error.message,
      details: error.context,
      cause: error,
    });
  }
}
