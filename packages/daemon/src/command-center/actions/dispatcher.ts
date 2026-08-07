/**
 * v2 action dispatcher — single Hono route that resolves an action name
 * against the registry, parses input + output with Zod, runs the handler,
 * and broadcasts an `action.complete` WS frame on success.
 *
 * Endpoint: `POST /api/v2/action/:name`
 *
 * Wire envelope:
 *   200 OK  { ok: true,  result }
 *   200 OK  { ok: false, error: { code, message, details? } }   (typed app error)
 *   400     malformed JSON body
 *   404     unknown action name (transport-level — name isn't in the registry)
 *
 * `ok: false` is intentionally HTTP 200: it represents a typed application
 * outcome the client is expected to handle. HTTP 4xx/5xx remain reserved
 * for transport-level failures.
 */

import type { Context } from "hono";
import { ZodError } from "zod";
import {
  COMMAND_PROTOCOL_VERSION,
  isActionName,
  type ActionErrorEnvelope,
  type ActionName,
} from "./contract.ts";
import { ActionError, wrapInternalError } from "./errors.ts";
import { getLooseActionEntry } from "./registry.ts";
import {
  broadcastActionComplete,
  broadcastResourceChanged,
  broadcastWorkspacePromotionCompleted,
  type ResourceChangedBroadcast,
} from "../ws-events.ts";
import {
  AppWindowMutationResultSchemaZ,
  WorkspaceMultiplexerMutationResultSchemaZ,
  WorkspaceOpenMutationResultSchemaZ,
  WorkspacePaneCreateMutationResultSchemaZ,
  WorkspacePromoteMutationResultSchemaZ,
} from "@tmux-ide/contracts";
import { daemonActionCommandRegistry } from "./command-definitions.ts";
import type { WorkspacePaneCreationBackend } from "./handlers/workspace-pane-create.ts";
import type { WorkspaceMultiplexerBackend } from "./handlers/workspace-multiplexer.ts";
import type { WorkspaceOpenBackend } from "./handlers/workspace-open.ts";
import type { WorkspacePromotionBackend } from "./handlers/workspace-promote.ts";
import type { AppWindowMutationBackend } from "./handlers/app-window-mutate.ts";

export interface DispatcherDeps {
  /** Override the WS broadcaster (tests / non-default daemons). */
  broadcast?: (name: string, result: unknown) => void;
  /** Override the typed promotion-completed receipt broadcaster (tests). */
  broadcastPromotionCompleted?: (workspaceName: string, outcome: "promoted" | "replayed") => void;
  /** Override the scoped replayable invalidation broadcaster (tests). */
  broadcastResourceChanged?: (change: ResourceChangedBroadcast, daemonInstanceId: string) => void;
  /** Trusted daemon generation; never accepted from an HTTP request body. */
  daemonInstanceId?: string;
  /** Instance-owned privileged mutation authority; never module-global. */
  workspacePaneCreationBackend?: WorkspacePaneCreationBackend;
  /** Instance-owned config-free admission authority; never renderer-authored. */
  workspaceOpenBackend?: WorkspaceOpenBackend;
  /** Instance-owned session-promotion admission authority; never renderer-authored. */
  workspacePromotionBackend?: WorkspacePromotionBackend;
  /** Instance-owned AppWindow authority; renderer never supplies its envelope. */
  appWindowMutationBackend?: AppWindowMutationBackend;
  /** Instance-owned multiplexer verb authority; never module-global. */
  workspaceMultiplexerBackend?: WorkspaceMultiplexerBackend;
}

interface DispatchOk {
  ok: true;
  result: unknown;
}

function resourceChangesForAction(
  actionName: ActionName,
  result: unknown,
): readonly ResourceChangedBroadcast[] {
  if (actionName === "workspace.app-window.mutate") {
    const mutation = AppWindowMutationResultSchemaZ.safeParse(result);
    if (!mutation.success || mutation.data.outcome !== "applied") return [];
    return [
      {
        workspaceName: mutation.data.workspaceName,
        resource: "application-shell",
        revision: mutation.data.documentRevision,
        causeOperationId: mutation.data.operationId,
      },
    ];
  }
  if (actionName === "workspace.pane.create") {
    const mutation = WorkspacePaneCreateMutationResultSchemaZ.safeParse(result);
    if (!mutation.success || mutation.data.outcome !== "created") return [];
    return [
      {
        workspaceName: mutation.data.resource.workspaceName,
        resource: "application-shell",
        causeOperationId: mutation.data.operationId,
      },
      {
        workspaceName: null,
        resource: "fleet-catalog",
        causeOperationId: mutation.data.operationId,
      },
    ];
  }
  if (actionName === "workspace.open") {
    const mutation = WorkspaceOpenMutationResultSchemaZ.safeParse(result);
    if (!mutation.success || mutation.data.outcome === "replayed") return [];
    const base = {
      workspaceName: mutation.data.resource.workspaceName,
      causeOperationId: mutation.data.operationId,
    } as const;
    return [
      { ...base, resource: "workspace-catalog" },
      { ...base, resource: "application-shell" },
      { ...base, workspaceName: null, resource: "fleet-catalog" },
    ];
  }
  if (actionName === "workspace.promote") {
    const mutation = WorkspacePromoteMutationResultSchemaZ.safeParse(result);
    if (!mutation.success || mutation.data.outcome !== "promoted") return [];
    const base = {
      workspaceName: mutation.data.resource.workspaceName,
      causeOperationId: mutation.data.operationId,
    } as const;
    return [
      { ...base, resource: "workspace-catalog" },
      { ...base, resource: "application-shell" },
      { ...base, workspaceName: null, resource: "fleet-catalog" },
    ];
  }
  if (actionName.startsWith("workspace.")) {
    const mutation = WorkspaceMultiplexerMutationResultSchemaZ.safeParse(result);
    if (!mutation.success || mutation.data.outcome !== "applied") return [];
    const changes: ResourceChangedBroadcast[] = [
      {
        workspaceName: mutation.data.workspaceName,
        resource: "application-shell",
        causeOperationId: mutation.data.operationId,
      },
    ];
    if (
      mutation.data.verb === "workspace.window.split" ||
      mutation.data.verb === "workspace.window.kill" ||
      mutation.data.verb === "workspace.pane.kill" ||
      mutation.data.verb === "workspace.session.kill"
    ) {
      changes.push({
        workspaceName: null,
        resource: "fleet-catalog",
        causeOperationId: mutation.data.operationId,
      });
    }
    if (mutation.data.verb === "workspace.session.kill") {
      changes.push({
        workspaceName: mutation.data.workspaceName,
        resource: "workspace-catalog",
        causeOperationId: mutation.data.operationId,
      });
    }
    return changes;
  }
  return [];
}

function errorEnvelope(err: ActionError): ActionErrorEnvelope {
  return { ok: false, error: err.toEnvelope() };
}

function zodErrorEnvelope(err: ZodError): ActionErrorEnvelope {
  return {
    ok: false,
    error: {
      code: "validation_failed",
      message: "Input failed schema validation",
      details: { issues: err.issues },
    },
  };
}

function outputZodErrorEnvelope(err: ZodError): ActionErrorEnvelope {
  // A handler returned a value that does not conform to its declared output
  // schema — log loudly and surface as `internal`. The dashboard treats
  // this the same as any other server bug.
  console.error("[actions] handler output failed schema validation", err.issues);
  return {
    ok: false,
    error: {
      code: "internal",
      message: "Handler returned an invalid result",
      details: { issues: err.issues },
    },
  };
}

/**
 * Build the Hono handler. Exposed as a factory so tests can inject a
 * broadcaster and assert on the WS event without mounting a real server.
 */
export function createActionDispatcher(deps: DispatcherDeps = {}) {
  const broadcast = deps.broadcast ?? broadcastActionComplete;
  const broadcastPromotionCompleted =
    deps.broadcastPromotionCompleted ?? broadcastWorkspacePromotionCompleted;
  const broadcastResource = deps.broadcastResourceChanged ?? broadcastResourceChanged;

  return async function dispatcher(c: Context): Promise<Response> {
    const name = c.req.param("name");
    if (!name || !isActionName(name)) {
      return c.json(
        {
          ok: false,
          error: {
            code: "validation_failed",
            message: `Unknown action: ${name}`,
            details: { name },
          },
        } satisfies ActionErrorEnvelope,
        404,
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch (err) {
      // Malformed JSON is a transport problem, not an app outcome.
      return c.json(
        {
          ok: false,
          error: {
            code: "validation_failed",
            message: `Invalid JSON body: ${(err as Error).message ?? String(err)}`,
          },
        } satisfies ActionErrorEnvelope,
        400,
      );
    }

    const actionName: ActionName = name;
    const entry = getLooseActionEntry(actionName);

    // Preserve the public v2 action contract exactly: HTTP request bodies are
    // validated by the action schema before they are adapted to commands. In
    // particular, null/array/scalar bodies must keep the action schema's issue
    // paths rather than gaining a command-envelope `args` prefix.
    const inputParsed = entry.inputSchema.safeParse(body);
    if (!inputParsed.success) {
      return c.json(zodErrorEnvelope(inputParsed.error) satisfies ActionErrorEnvelope, 200);
    }

    const commandResolution = daemonActionCommandRegistry.resolve(
      {
        version: COMMAND_PROTOCOL_VERSION,
        id: actionName,
        source: { kind: "http" },
        args: inputParsed.data,
      },
      undefined,
    );
    if (!commandResolution.ok) {
      // The command adapter uses the same schema object as the action entry,
      // so this is an internal registry drift rather than a client failure.
      console.error("[actions] command adapter rejected action-schema-validated input", {
        actionName,
        error: commandResolution.error,
      });
      return c.json(
        {
          ok: false,
          error: {
            code: "internal",
            message: "Action command adapter rejected validated input",
          },
        } satisfies ActionErrorEnvelope,
        200,
      );
    }

    let result: unknown;
    try {
      const context = {
        operationId: c.req.header("X-Tmux-Ide-Operation-Id"),
        daemonInstanceId: deps.daemonInstanceId,
        workspacePaneCreationBackend: deps.workspacePaneCreationBackend,
        workspaceOpenBackend: deps.workspaceOpenBackend,
        workspacePromotionBackend: deps.workspacePromotionBackend,
        appWindowMutationBackend: deps.appWindowMutationBackend,
        workspaceMultiplexerBackend: deps.workspaceMultiplexerBackend,
      };
      result = entry.handlerWithContext
        ? await entry.handlerWithContext(commandResolution.command.input, context)
        : await entry.handler(commandResolution.command.input);
    } catch (err) {
      const wrapped = wrapInternalError(err);
      return c.json(errorEnvelope(wrapped) satisfies ActionErrorEnvelope, 200);
    }

    const outputParsed = (commandResolution.command.resultSchema ?? entry.resultSchema).safeParse(
      result,
    );
    if (!outputParsed.success) {
      return c.json(outputZodErrorEnvelope(outputParsed.error) satisfies ActionErrorEnvelope, 200);
    }

    const unchangedAppWindowMutation =
      actionName === "workspace.app-window.mutate" &&
      typeof outputParsed.data === "object" &&
      outputParsed.data !== null &&
      "outcome" in outputParsed.data &&
      outputParsed.data.outcome === "unchanged";
    if (!unchangedAppWindowMutation) {
      // Fire-and-forget: subscribers learn about durable state changes via WS.
      try {
        broadcast(actionName, outputParsed.data);
      } catch (err) {
        // Broadcast failure must not turn a successful action into a failure.
        console.error("[actions] broadcast failed:", err);
      }
    }

    if (deps.daemonInstanceId) {
      for (const change of resourceChangesForAction(actionName, outputParsed.data)) {
        try {
          broadcastResource(change, deps.daemonInstanceId);
        } catch (err) {
          console.error("[actions] resource invalidation broadcast failed:", err);
        }
      }
    }

    if (actionName === "workspace.promote") {
      // Typed completion receipt alongside the generic action.complete frame.
      // Re-narrowing through the result schema (already validated above) keeps
      // this cast-free; a mismatch is an internal drift worth logging, not a
      // client failure.
      const promoted = WorkspacePromoteMutationResultSchemaZ.safeParse(outputParsed.data);
      if (promoted.success) {
        try {
          broadcastPromotionCompleted(promoted.data.resource.workspaceName, promoted.data.outcome);
        } catch (err) {
          console.error("[actions] promotion receipt broadcast failed:", err);
        }
      } else {
        console.error("[actions] workspace.promote result did not match the mutation schema");
      }
    }

    return c.json({ ok: true, result: outputParsed.data } satisfies DispatchOk, 200);
  };
}
