/**
 * Action handlers for the multiplexer verbs.
 *
 * One handler factory serves all seven routes. The action name supplies the
 * verb, so the renderer never puts it on the wire and a request cannot claim to
 * be a split while arriving at the kill route.
 */
import type {
  ActionInput,
  ActionResult,
  WorkspaceMultiplexerIntent,
  WorkspaceMultiplexerMutationRequest,
  WorkspaceMultiplexerMutationResult,
  WorkspaceMultiplexerVerb,
} from "@tmux-ide/contracts";

import { WorkspaceMultiplexerError } from "../../../lib/workspace-multiplexer-verbs.ts";
import { ActionError } from "../errors.ts";
import type { ActionExecutionContext } from "../registry.ts";

export interface WorkspaceMultiplexerBackend {
  mutate(input: WorkspaceMultiplexerMutationRequest): Promise<WorkspaceMultiplexerMutationResult>;
}

async function runVerb(
  verb: WorkspaceMultiplexerVerb,
  input: object,
  context: ActionExecutionContext,
  deps: { authority?: WorkspaceMultiplexerBackend },
): Promise<WorkspaceMultiplexerMutationResult> {
  const authority = deps.authority ?? context.workspaceMultiplexerBackend;
  if (!authority) {
    throw new ActionError({
      code: "workspace_unavailable",
      message: "Multiplexer verbs are not available from this daemon.",
    });
  }
  if (!context.operationId || !context.daemonInstanceId) {
    throw new ActionError({
      code: "bad_request",
      message: "Multiplexer verbs require trusted host retry and generation metadata.",
    });
  }
  try {
    return await authority.mutate({
      operationId: context.operationId,
      expectedDaemonInstanceId: context.daemonInstanceId,
      intent: { ...input, verb } as WorkspaceMultiplexerIntent,
    });
  } catch (error) {
    if (!(error instanceof WorkspaceMultiplexerError)) throw error;
    throw new ActionError({
      code: error.code,
      message: error.message,
      details: error.context,
      cause: error,
    });
  }
}

/**
 * The authority answers with the union; the route's contract declares the one
 * member that matches its verb. The narrowing is safe because the verb the
 * authority acted on is the one this factory supplied, and the dispatcher still
 * parses the answer against the route's result schema before it reaches a
 * client — so a mismatch would be refused there rather than rendered.
 */
function verbHandler<V extends WorkspaceMultiplexerVerb>(verb: V) {
  return async (
    input: ActionInput<V>,
    context: ActionExecutionContext = {},
    deps: { authority?: WorkspaceMultiplexerBackend } = {},
  ): Promise<ActionResult<V>> => (await runVerb(verb, input, context, deps)) as ActionResult<V>;
}

export const workspaceWindowSplitHandler = verbHandler("workspace.window.split");
export const workspaceWindowKillHandler = verbHandler("workspace.window.kill");
export const workspacePaneKillHandler = verbHandler("workspace.pane.kill");
export const workspaceSessionKillHandler = verbHandler("workspace.session.kill");
export const workspaceRenameHandler = verbHandler("workspace.rename");
export const workspacePaneZoomToggleHandler = verbHandler("workspace.pane.zoom.toggle");
export const workspacePaneSelectHandler = verbHandler("workspace.pane.select");
