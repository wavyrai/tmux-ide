import {
  WorkspaceMultiplexerIntentSchemaZ,
  WorkspaceMultiplexerMutationResultSchemaZ,
  type WorkspaceMultiplexerIntent,
} from "@tmux-ide/contracts";
import type { SessionRuntimeRegistry } from "../terminal/session-runtime/registry.ts";
import type { createGuardedNativeSplitResize } from "./guarded-native-split-resize.ts";
import { WorkspaceMultiplexerError } from "./workspace-multiplexer-verbs.ts";

/** Only the authenticated geometry execution lane may call this adapter. */
export async function executeCanonicalSplitMutation(
  options: {
    generation: string;
    resolveSession(workspaceName: string): string | null;
    registry: Pick<SessionRuntimeRegistry, "readWindowSplitLayout" | "resizeWindowSplit">;
    runNative: ReturnType<typeof createGuardedNativeSplitResize>;
  },
  operationId: string,
  input: Extract<WorkspaceMultiplexerIntent, { verb: "workspace.window.split.resize" }>,
  authorizeBeforeEffect: (() => void) | undefined,
) {
  const intent = WorkspaceMultiplexerIntentSchemaZ.parse(input);
  if (intent.verb !== "workspace.window.split.resize") throw new TypeError("Expected split resize");
  if (!authorizeBeforeEffect) throw new WorkspaceMultiplexerError("workspace_unavailable");
  const session = options.resolveSession(intent.workspaceName);
  if (!session) throw new WorkspaceMultiplexerError("workspace_unavailable");
  const authorize = () => {
    if (options.resolveSession(intent.workspaceName) !== session)
      throw new WorkspaceMultiplexerError("workspace_unavailable");
    authorizeBeforeEffect();
  };
  authorize();
  const resource = await options.registry.readWindowSplitLayout(session, intent.target.window);
  const split = resource.splits.find((row) => row.splitId === intent.target.splitId);
  if (!split || resource.layoutId !== intent.target.layoutId)
    throw new WorkspaceMultiplexerError("workspace_unavailable");
  const result = await options.registry.resizeWindowSplit(
    session,
    intent.target,
    operationId,
    authorize,
    options.runNative,
  );
  if (result.status !== "applied")
    throw new WorkspaceMultiplexerError(
      result.status === "uncertain" ? "mutation_unverified" : "workspace_unavailable",
    );
  return WorkspaceMultiplexerMutationResultSchemaZ.parse({
    operationId,
    daemonInstanceId: options.generation,
    workspaceName: intent.workspaceName,
    verb: intent.verb,
    outcome: result.changed ? "applied" : "unchanged",
    target: intent.target,
    axis: split.axis,
    boundary: result.boundary,
    successor: result.successor ?? null,
  });
}
