import type { IncomingMessage, ServerResponse } from "node:http";
import type { MiddlewareHandler } from "hono";
import { ownerBearerMatches } from "./owner-authority.ts";

/**
 * How long an owner-authenticated HTTP connection may sit idle before the
 * daemon closes it. Node's default is 5 s, so a native app that paused for
 * longer found its proven connection gone; over SSH every replacement costs
 * a channel open and an identity proof (attach-rtt). The app keeps an idle
 * connection for at most 60 s, below this.
 */
export const OWNER_KEEP_ALIVE_MS = 65_000;

type NodeBindings = { incoming?: IncomingMessage; outgoing?: ServerResponse } | undefined;

/**
 * After a response to the owner bearer, keep that connection open for
 * `timeoutMs` while idle. Every other connection keeps Node's default.
 * Node arms its own keep-alive timer when the response finishes; this runs
 * after it and replaces the bound for this socket only. The next request on
 * the socket clears the timer as usual.
 */
export function ownerKeepAlive(
  ownerToken: string | null,
  timeoutMs: number = OWNER_KEEP_ALIVE_MS,
): MiddlewareHandler {
  return async (c, next) => {
    const bindings = c.env as NodeBindings;
    const outgoing = bindings?.outgoing;
    const socket = bindings?.incoming?.socket;
    if (outgoing && socket && ownerBearerMatches(c.req.header("Authorization"), ownerToken)) {
      outgoing.once("finish", () => {
        if (!socket.destroyed && outgoing.shouldKeepAlive) socket.setTimeout(timeoutMs);
      });
    }
    await next();
  };
}
