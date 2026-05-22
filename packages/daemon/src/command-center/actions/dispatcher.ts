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
import { isActionName, type ActionErrorEnvelope, type ActionName } from "./contract.ts";
import { ActionError, wrapInternalError } from "./errors.ts";
import { getLooseActionEntry } from "./registry.ts";
import { broadcastActionComplete } from "../ws-events.ts";

export interface DispatcherDeps {
  /** Override the WS broadcaster (tests / non-default daemons). */
  broadcast?: (name: string, result: unknown) => void;
}

interface DispatchOk {
  ok: true;
  result: unknown;
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

    const inputParsed = entry.inputSchema.safeParse(body);
    if (!inputParsed.success) {
      return c.json(zodErrorEnvelope(inputParsed.error) satisfies ActionErrorEnvelope, 200);
    }

    let result: unknown;
    try {
      result = await entry.handler(inputParsed.data);
    } catch (err) {
      const wrapped = wrapInternalError(err);
      return c.json(errorEnvelope(wrapped) satisfies ActionErrorEnvelope, 200);
    }

    const outputParsed = entry.resultSchema.safeParse(result);
    if (!outputParsed.success) {
      return c.json(outputZodErrorEnvelope(outputParsed.error) satisfies ActionErrorEnvelope, 200);
    }

    // Fire-and-forget: subscribers learn about the success via the WS bus.
    try {
      broadcast(actionName, outputParsed.data);
    } catch (err) {
      // Broadcast failure must not turn a successful action into a failure.
      console.error("[actions] broadcast failed:", err);
    }

    return c.json({ ok: true, result: outputParsed.data } satisfies DispatchOk, 200);
  };
}
