import type {
  FleetAgentMutateArguments,
  FleetAgentMutateResult,
  WorkspaceSessionCreateArguments,
  WorkspaceSessionCreateResult,
} from "@tmux-ide/contracts";

import { FleetLifecycleAuthorityError } from "../../../lib/fleet-lifecycle-authority.ts";
import { ActionError } from "../errors.ts";
import type { ActionExecutionContext } from "../registry.ts";

export interface FleetLifecycleBackend {
  createSession(
    operationId: string,
    generation: string,
    input: WorkspaceSessionCreateArguments,
  ): Promise<WorkspaceSessionCreateResult>;
  mutateAgent(
    operationId: string,
    generation: string,
    input: FleetAgentMutateArguments,
  ): Promise<FleetAgentMutateResult>;
}

function authorityContext(context: ActionExecutionContext): [string, string] {
  if (
    !context.operationId ||
    !context.daemonInstanceId ||
    !context.hostClientId ||
    !context.ownerAuthorized
  ) {
    throw new ActionError({
      code: "bad_request",
      message: "Fleet lifecycle requires owner, operation, generation, and client identity.",
    });
  }
  return [context.operationId, context.daemonInstanceId];
}

async function mapAuthority<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof FleetLifecycleAuthorityError)) throw error;
    throw new ActionError({
      code: "workspace_unavailable",
      message: error.message,
      details: { lifecycleCode: error.code },
      cause: error,
    });
  }
}

export async function workspaceSessionCreateHandler(
  input: WorkspaceSessionCreateArguments,
  context: ActionExecutionContext,
): Promise<WorkspaceSessionCreateResult> {
  if (!context.fleetLifecycleBackend)
    throw new ActionError({
      code: "workspace_unavailable",
      message: "Fleet lifecycle is unavailable.",
    });
  const [operation, generation] = authorityContext(context);
  return await mapAuthority(() =>
    context.fleetLifecycleBackend!.createSession(operation, generation, input),
  );
}

export async function fleetAgentMutateHandler(
  input: FleetAgentMutateArguments,
  context: ActionExecutionContext,
): Promise<FleetAgentMutateResult> {
  if (!context.fleetLifecycleBackend)
    throw new ActionError({
      code: "workspace_unavailable",
      message: "Fleet lifecycle is unavailable.",
    });
  const [operation, generation] = authorityContext(context);
  return await mapAuthority(() =>
    context.fleetLifecycleBackend!.mutateAgent(operation, generation, input),
  );
}
