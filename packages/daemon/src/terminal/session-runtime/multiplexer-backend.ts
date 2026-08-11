import type {
  SessionRuntimeSemanticIntent,
  WorkspaceMultiplexerMutationRequest,
  WorkspaceMultiplexerMutationResult,
} from "@tmux-ide/contracts";
import type { WorkspaceMultiplexerBackend } from "../../command-center/actions/handlers/workspace-multiplexer.ts";
import type { SessionRuntimeConsumer, SessionRuntimeRegistry } from "./registry.ts";

export interface SessionRuntimeMultiplexerBackendOptions {
  readonly registry: Pick<SessionRuntimeRegistry, "connect" | "generation">;
  readonly resolveSession: (workspaceName: string) => string | null;
}

/**
 * The command center's single route into tmux mutation authority.
 *
 * Every verb, including geometry, crosses the same session controller consumer.
 * The command center is currently one authenticated daemon-local client. The
 * m56.1d wire-identity cutover replaces this identity with the authenticated
 * originating client and then removes the subordinate window input guard.
 */
export function createSessionRuntimeMultiplexerBackend(
  options: SessionRuntimeMultiplexerBackendOptions,
): WorkspaceMultiplexerBackend {
  const consumers = new Map<string, SessionRuntimeConsumer>();

  return {
    mutate: async (
      request: WorkspaceMultiplexerMutationRequest,
    ): Promise<WorkspaceMultiplexerMutationResult> => {
      const session = options.resolveSession(request.intent.workspaceName);
      if (!session) {
        throw new Error(`Workspace ${request.intent.workspaceName} has no live tmux session`);
      }
      let consumer = consumers.get(session);
      if (!consumer) {
        consumer = options.registry.connect(
          session,
          "command-center",
          `command-center:${options.registry.generation}:${session}`,
        );
        consumers.set(session, consumer);
      }
      const lease = consumer.acquireController();
      const result = await consumer.submitIntent(
        lease,
        request.operationId,
        request.intent as SessionRuntimeSemanticIntent,
      );
      if (!result) throw new Error("Session mutation completed without a mutation result");
      return result;
    },
  };
}
