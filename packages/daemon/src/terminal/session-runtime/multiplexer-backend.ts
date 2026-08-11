import type {
  SessionRuntimeSemanticIntent,
  WorkspaceMultiplexerMutationRequest,
  WorkspaceMultiplexerMutationResult,
} from "@tmux-ide/contracts";
import type { WorkspaceMultiplexerBackend } from "../../command-center/actions/handlers/workspace-multiplexer.ts";
import { WorkspaceMultiplexerError } from "../../lib/workspace-multiplexer-verbs.ts";
import type { SessionRuntimeConsumer, SessionRuntimeRegistry } from "./registry.ts";
import { SessionRuntimeIntentError } from "./semantic-mutation-executor.ts";
import { SessionRuntimeTransportBinder } from "./transport-binding.ts";

export interface SessionRuntimeMultiplexerBackendOptions {
  readonly registry: Pick<
    SessionRuntimeRegistry,
    | "connect"
    | "generation"
    | "submitAuthenticatedIntent"
    | "createExecutionHandle"
    | "bindExecutionSource"
    | "assertExecutionHandle"
    | "submitPaneCredentialIntent"
  >;
  readonly resolveSession: (workspaceName: string) => string | null;
  readonly resolvePaneSourceCredential?: (
    credential: string | undefined,
    session: string,
    claimedSemanticPaneId: string | undefined,
  ) => string | null;
}

/**
 * The command center's single route into tmux mutation authority.
 *
 * Trusted GUI/TUI hosts execute through their live transport controller,
 * pane-local CLI/SDK sends use a generation-bound send-only credential, and
 * the explicit owner route remains the sole anonymous fallback. Supplying a
 * stale principal always fails closed; it never falls through to owner power.
 */
export function createSessionRuntimeMultiplexerBackend(
  options: SessionRuntimeMultiplexerBackendOptions,
): WorkspaceMultiplexerBackend {
  interface OwnerUse {
    readonly consumer: SessionRuntimeConsumer;
    active: number;
  }
  const owners = new Map<string, OwnerUse>();
  const transportBinder = new SessionRuntimeTransportBinder(options.registry);
  let ownerEpoch = 0;

  const submit = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      // The executor owns lifecycle receipts, but command-center handlers still
      // need the multiplexer authority's typed refusal for stable HTTP mapping.
      if (
        error instanceof SessionRuntimeIntentError &&
        error.cause instanceof WorkspaceMultiplexerError
      ) {
        throw error.cause;
      }
      throw error;
    }
  };

  const withTrustedOrigin = (
    intent: SessionRuntimeSemanticIntent,
    origin: "gui" | "cli" | "sdk",
  ): SessionRuntimeSemanticIntent =>
    intent.verb === "workspace.pane.send" || intent.verb === "workspace.pane.read"
      ? { ...intent, origin }
      : intent;

  const acquireOwner = (session: string): OwnerUse => {
    let owner = owners.get(session);
    if (!owner) {
      ownerEpoch += 1;
      owner = {
        consumer: options.registry.connect(
          session,
          "command-center",
          `command-center:${options.registry.generation}:${session}:${ownerEpoch}`,
        ),
        active: 0,
      };
      owners.set(session, owner);
    }
    owner.active += 1;
    return owner;
  };

  const releaseOwner = async (session: string, owner: OwnerUse): Promise<void> => {
    owner.active -= 1;
    if (owner.active !== 0 || owners.get(session) !== owner) return;
    owners.delete(session);
    await owner.consumer.close();
  };

  return {
    mutate: async (
      request: WorkspaceMultiplexerMutationRequest,
      authenticatedHostClientId?: string,
      sourcePaneCredential?: string,
    ): Promise<WorkspaceMultiplexerMutationResult> => {
      const session = options.resolveSession(request.intent.workspaceName);
      if (!session) {
        throw new Error(`Workspace ${request.intent.workspaceName} has no live tmux session`);
      }
      const claimedSource =
        request.intent.verb === "workspace.pane.send"
          ? request.intent.sourceSemanticPaneId
          : undefined;
      if (authenticatedHostClientId) {
        const authenticatedContext = transportBinder.resolveExecutionHandle(
          session,
          authenticatedHostClientId,
          claimedSource,
        );
        if (!authenticatedContext) {
          throw new Error("Authenticated host has no live controller grant for this mutation");
        }
        const result = await submit(() =>
          options.registry.submitAuthenticatedIntent(
            authenticatedContext,
            request.operationId,
            withTrustedOrigin(request.intent as SessionRuntimeSemanticIntent, "gui"),
          ),
        );
        if (!result) throw new Error("Session mutation completed without a mutation result");
        return result;
      }
      const credentialSource = options.resolvePaneSourceCredential?.(
        sourcePaneCredential,
        session,
        claimedSource,
      );
      if (sourcePaneCredential) {
        if (!credentialSource) throw new Error("Pane source credential is invalid or stale");
        const result = await submit(() =>
          options.registry.submitPaneCredentialIntent(
            session,
            request.operationId,
            withTrustedOrigin(request.intent as SessionRuntimeSemanticIntent, "cli"),
            credentialSource,
            () => {
              const current = options.resolvePaneSourceCredential?.(
                sourcePaneCredential,
                session,
                claimedSource,
              );
              if (current !== credentialSource) {
                throw new Error("Pane source credential became invalid before execution");
              }
            },
          ),
        );
        if (!result) throw new Error("Session mutation completed without a mutation result");
        return result;
      }
      const owner = acquireOwner(session);
      try {
        const lease = owner.consumer.acquireController();
        const result = await submit(() =>
          owner.consumer.submitIntent(
            lease,
            request.operationId,
            withTrustedOrigin(request.intent as SessionRuntimeSemanticIntent, "sdk"),
          ),
        );
        if (!result) throw new Error("Session mutation completed without a mutation result");
        return result;
      } finally {
        await releaseOwner(session, owner);
      }
    },
  };
}
