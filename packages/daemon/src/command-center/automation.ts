import { Hono, type Context } from "hono";
import { stripVTControlCharacters } from "node:util";
import { z } from "zod";
import {
  AUTOMATION_API_PATH,
  AutomationExecuteRequestSchemaZ,
  AutomationExecuteResponseSchemaZ,
  AutomationOperationHandleSchemaZ,
  AutomationPanesResponseSchemaZ,
  AutomationReserveRequestSchemaZ,
  AutomationReserveResponseSchemaZ,
  AutomationStatusResponseSchemaZ,
  SessionRuntimePaneReadResultSchemaZ,
  WorkspacePaneSendResultSchemaZ,
  type AutomationOperationIntent,
  type AutomationOperationSummary,
  type AutomationPanesResponse,
  type AutomationExecuteResponse,
  type AutomationErrorResponse,
} from "@tmux-ide/contracts";
import {
  AutomationOperationRegistry,
  AutomationOperationUnavailableError,
} from "../lib/automation-operation-registry.ts";
import type { NativeTmuxServerOwner } from "../lib/tmux-server-owner.ts";
import { TmuxServerOwners } from "../lib/tmux-server-owners.ts";
import { PANE_SOURCE_CREDENTIAL_HEADER } from "../lib/pane-source-credentials.ts";
import { ownerBearerMatches } from "./owner-authority.ts";

type Endpoint = AutomationOperationIntent["target"];
type ErrorCode = AutomationErrorResponse["error"]["code"];
class AutomationRequestError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
  }
}
export interface AutomationRoutesOptions {
  readonly ownerToken: string | null;
  readonly owners: TmuxServerOwners<NativeTmuxServerOwner>;
  readonly operations?: AutomationOperationRegistry<AutomationOperationSummary>;
}
async function boundedJson(request: Request): Promise<unknown> {
  if (!request.body) throw new AutomationRequestError("invalid-request");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      // Includes worst-case JSON escaping of the bounded 16KiB input.
      if (size > 128 * 1024) {
        void reader.cancel().catch(() => undefined);
        throw new AutomationRequestError("invalid-request");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
const label = (value: string) =>
  [...stripVTControlCharacters(value)]
    .filter((character) => {
      const code = character.codePointAt(0)!;
      return code >= 32 && (code < 127 || code > 159);
    })
    .join("")
    .slice(0, 160);
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** Separate daemon-minted handles; never falls back to raw tmux or remints on retry. */
export function mountAutomationRoutes(app: Hono, options: AutomationRoutesOptions): void {
  const operations =
    options.operations ?? new AutomationOperationRegistry<AutomationOperationSummary>();
  const base = AUTOMATION_API_PATH;
  app.use(`${base}/*`, async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!ownerBearerMatches(c.req.header("Authorization"), options.ownerToken))
      return c.json({ error: { code: "owner-required" } }, 401);
    await next();
  });
  const route = (work: (c: Context) => Promise<Response>) => async (c: Context) => {
    try {
      return await work(c);
    } catch (error) {
      const code =
        error instanceof AutomationRequestError
          ? error.code
          : error instanceof z.ZodError ||
              error instanceof SyntaxError ||
              error instanceof TypeError
            ? "invalid-request"
            : "server-unavailable";
      return c.json(
        { error: { code } },
        code === "invalid-request"
          ? 400
          : code === "capacity"
            ? 429
            : code === "server-unavailable"
              ? 503
              : 409,
      );
    }
  };
  const ownerFor = (endpoint: Endpoint, code: "invalid-source" | "invalid-target") => {
    try {
      return options.owners.current(endpoint.serverScope);
    } catch {
      throw new AutomationRequestError(code);
    }
  };
  const validate = async (intent: AutomationOperationIntent, credential: string | undefined) => {
    const target = ownerFor(intent.target, "invalid-target");
    await target.catalog();
    await target.terminalInventoryRuntime.discoverTerminalInventory();
    if (!target.interactionEvidence?.isCurrent(intent.target))
      throw new AutomationRequestError("invalid-target");
    const sourceOwner = intent.source ? ownerFor(intent.source, "invalid-source") : null;
    if (sourceOwner) {
      await sourceOwner.catalog();
      await sourceOwner.terminalInventoryRuntime.discoverTerminalInventory();
    }
    const source =
      intent.source && credential
        ? sourceOwner!.resolveInteractionSource(
            credential,
            intent.source.workspaceName,
            intent.source.semanticPaneId,
          )
        : null;
    if (intent.source && (!source || !same(source.endpoint, intent.source)))
      throw new AutomationRequestError("invalid-source");
    const authorizeBeforeEffect = () => {
      if (
        ownerFor(intent.target, "invalid-target") !== target ||
        !target.interactionEvidence?.isCurrent(intent.target)
      )
        throw new AutomationRequestError("invalid-target");
      if (intent.source) {
        if (ownerFor(intent.source, "invalid-source") !== sourceOwner)
          throw new AutomationRequestError("invalid-source");
        const current = sourceOwner!.resolveInteractionSource(
          credential!,
          intent.source.workspaceName,
          intent.source.semanticPaneId,
        );
        if (
          !current ||
          !same(current, source) ||
          !sourceOwner!.interactionEvidence?.isCurrent(intent.source)
        )
          throw new AutomationRequestError("invalid-source");
      }
    };
    authorizeBeforeEffect();
    return { target, source, authorizeBeforeEffect, fingerprint: JSON.stringify([intent, source]) };
  };
  app.get(
    `${base}/panes`,
    route(async (c) => {
      const panes: AutomationPanesResponse["panes"] = [];
      const credential = c.req.header(PANE_SOURCE_CREDENTIAL_HEADER);
      let source: Endpoint | null = null;
      for (const scope of await options.owners.observe()) {
        if (!scope.generation) continue;
        await options.owners.withOwner(
          { serverId: scope.serverId, generation: scope.generation },
          async (owner) => {
            await owner.catalog();
            const inventory = await owner.terminalInventoryRuntime.discoverTerminalInventory();
            for (const pane of inventory.panes) {
              if (!pane.semanticPaneId) continue;
              const endpoint = owner.interactionEvidence?.captureAuthoredEndpoint(
                pane.workspaceName,
                pane.semanticPaneId,
              );
              if (!endpoint) continue;
              if (credential) {
                const binding = owner.resolveInteractionSource(
                  credential,
                  endpoint.workspaceName,
                  endpoint.semanticPaneId,
                );
                if (binding && same(binding.endpoint, endpoint)) {
                  if (source && !same(source, endpoint))
                    throw new AutomationRequestError("invalid-source");
                  source = endpoint;
                }
              }
              if (panes.length >= 4096) throw new AutomationRequestError("capacity");
              panes.push({
                endpoint,
                title: pane.title ? label(pane.title) : null,
                sessionName: label(pane.sessionName),
              });
            }
          },
        );
      }
      if (credential && !source) throw new AutomationRequestError("invalid-source");
      return c.json(AutomationPanesResponseSchemaZ.parse({ version: 1, panes, source }));
    }),
  );
  app.post(
    `${base}/reserve`,
    route(async (c) => {
      const request = AutomationReserveRequestSchemaZ.parse(await boundedJson(c.req.raw));
      const authority = await validate(request.intent, c.req.header(PANE_SOURCE_CREDENTIAL_HEADER));
      try {
        const handle = operations.reserve(JSON.stringify([request.origin, authority.fingerprint]));
        return c.json(AutomationReserveResponseSchemaZ.parse({ version: 1, handle }), 201);
      } catch (error) {
        throw new AutomationRequestError(
          error instanceof AutomationOperationUnavailableError
            ? "operation-unavailable"
            : "capacity",
        );
      }
    }),
  );
  app.post(
    `${base}/execute`,
    route(async (c) => {
      const request = AutomationExecuteRequestSchemaZ.parse(await boundedJson(c.req.raw));
      const authority = await validate(request.intent, c.req.header(PANE_SOURCE_CREDENTIAL_HEADER));
      let read: AutomationExecuteResponse["read"];
      let result: AutomationOperationSummary;
      try {
        result = await operations.execute(
          request.handle,
          JSON.stringify([request.origin, authority.fingerprint]),
          async (operationId) => {
            try {
              authority.authorizeBeforeEffect();
              const intent =
                request.intent.kind === "read"
                  ? {
                      verb: "workspace.pane.read" as const,
                      workspaceName: request.intent.target.workspaceName,
                      semanticPaneId: request.intent.target.semanticPaneId,
                      origin: request.origin,
                    }
                  : {
                      verb: "workspace.pane.send" as const,
                      workspaceName: request.intent.target.workspaceName,
                      semanticPaneId: request.intent.target.semanticPaneId,
                      origin: request.origin,
                      text: request.intent.text,
                      submit: request.intent.enter,
                    };
              const response = await authority.target.submitAutomationIntent(operationId, intent, {
                origin: request.origin,
                destination: request.intent.target,
                source: authority.source,
                authorizeBeforeEffect: authority.authorizeBeforeEffect,
              });
              if (request.intent.kind === "read") {
                const snapshot = SessionRuntimePaneReadResultSchemaZ.parse(response);
                if (
                  snapshot.operationId !== operationId ||
                  snapshot.daemonInstanceId !== request.intent.target.serverScope.generation ||
                  snapshot.workspaceName !== request.intent.target.workspaceName ||
                  snapshot.semanticPaneId !== request.intent.target.semanticPaneId ||
                  snapshot.availability !== "available"
                )
                  throw new Error("Unavailable snapshot");
                read = { availability: "available", text: snapshot.text };
                return {
                  kind: "read",
                  capturedBytes: snapshot.capturedByteCount,
                  returnedBytes: snapshot.byteCount,
                  truncated: snapshot.truncated,
                };
              }
              const sent = WorkspacePaneSendResultSchemaZ.parse(response);
              if (
                sent.operationId !== operationId ||
                sent.daemonInstanceId !== request.intent.target.serverScope.generation ||
                sent.workspaceName !== request.intent.target.workspaceName ||
                sent.semanticPaneId !== request.intent.target.semanticPaneId
              )
                throw new Error("Unavailable send result");
              return { kind: "send", submitted: sent.submitted };
            } catch {
              // Registry may retain a rejection; never retain tmux stderr or captured content.
              throw new AutomationRequestError("operation-unavailable");
            }
          },
        );
      } catch {
        throw new AutomationRequestError("operation-unavailable");
      }
      if (result.kind === "read" && !read)
        read = { availability: "replay-unavailable", text: null };
      return c.json(
        AutomationExecuteResponseSchemaZ.parse({
          version: 1,
          handle: request.handle,
          result,
          ...(read ? { read } : {}),
        }),
      );
    }),
  );
  app.get(
    `${base}/operations/:generation/:operationId`,
    route(async (c) => {
      const handle = AutomationOperationHandleSchemaZ.parse({
        generation: c.req.param("generation"),
        operationId: c.req.param("operationId"),
      });
      return c.json(
        AutomationStatusResponseSchemaZ.parse({ version: 1, handle, ...operations.status(handle) }),
      );
    }),
  );
}
