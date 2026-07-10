/**
 * Request dispatch for the control socket — PURE given its handler map.
 *
 * Takes one raw frame line, parses + validates the versioned envelope,
 * routes to the verb's handler, and shapes the response envelope — including
 * every failure mode (unparseable JSON, bad envelope, unknown verb, invalid
 * params, handler error). Handlers are injected, so this whole layer unit-
 * tests without a socket or a tmux server.
 *
 * Error codes on the wire:
 *   bad-request    unparseable frame / envelope / params (message says which)
 *   unknown-verb   the verb isn't in this server's handler map
 *   not-found      the named pane/session/target doesn't exist
 *   timeout        a `wait` ran out of time
 *   internal       the handler threw something unexpected
 */
import {
  CONTROL_PROTOCOL_VERSION,
  controlRequestSchema,
  type ControlResponse,
} from "@tmux-ide/contracts";
import { IdeError } from "../lib/errors.ts";

/** Thrown by handlers to reach the wire with a specific code. */
export class ControlVerbError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** What a handler gets besides its (already unknown-typed) params. */
export interface VerbContext {
  /** Flip this connection into receiving event frames (the `subscribe` verb). */
  subscribe: () => void;
}

export type VerbHandler = (params: unknown, ctx: VerbContext) => Promise<unknown> | unknown;

const ok = (id: string | number, data: unknown): ControlResponse => ({
  v: CONTROL_PROTOCOL_VERSION,
  id,
  ok: true,
  data,
});

const fail = (id: string | number | null, code: string, message: string): ControlResponse => ({
  v: CONTROL_PROTOCOL_VERSION,
  id,
  ok: false,
  error: { code, message },
});

/** Best-effort id recovery from a frame that failed envelope validation. */
function extractId(value: unknown): string | number | null {
  if (typeof value === "object" && value !== null && "id" in value) {
    const id = (value as { id: unknown }).id;
    if (typeof id === "string" || typeof id === "number") return id;
  }
  return null;
}

/**
 * Dispatch one raw line to `handlers`. ALWAYS resolves to a response frame —
 * a protocol error is an answer, never a dropped request or a thrown error
 * (only the transport decides to drop connections).
 */
export async function dispatchLine(
  line: string,
  handlers: Record<string, VerbHandler>,
  ctx: VerbContext,
): Promise<ControlResponse> {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return fail(null, "bad-request", "frame is not valid JSON");
  }

  const parsed = controlRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(
      extractId(raw),
      "bad-request",
      `invalid request envelope (need {v:${CONTROL_PROTOCOL_VERSION}, id, verb})`,
    );
  }

  const { id, verb, params } = parsed.data;
  const handler = handlers[verb];
  if (!handler) {
    return fail(id, "unknown-verb", `unknown verb "${verb}"`);
  }

  try {
    return ok(id, await handler(params ?? {}, ctx));
  } catch (err) {
    if (err instanceof ControlVerbError) return fail(id, err.code, err.message);
    if (err instanceof IdeError) {
      // Data-layer errors carry honest codes already (SESSION_NOT_FOUND, …).
      const code = err.code === "USAGE" ? "bad-request" : "not-found";
      return fail(id, code, err.message);
    }
    return fail(id, "internal", (err as Error)?.message ?? "internal error");
  }
}
