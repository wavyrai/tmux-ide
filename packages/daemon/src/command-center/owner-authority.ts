import { timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";

/**
 * The one owner-bearer check for the daemon's HTTP surface.
 *
 * The owner token is the private, per-generation capability the Electron main
 * process holds. It is never the remote-access token and never the local
 * bypass token, so it is compared here and nowhere else: five routes used to
 * carry their own byte-identical `bearerMatches` and their own idea of what an
 * absent credential means, which is five chances for the alpha's authorization
 * story to be wrong on one route.
 *
 * What is NOT unified is the policy. Routes legitimately disagree about the
 * ownerless case, so each states its own at the call site
 * ({@link OwnerAuthorityPolicy}) — one spelling of the check, one declared
 * policy per route.
 */

/**
 * What a route answers when THIS daemon generation holds no owner token at all.
 *
 * - `unavailable` — the capability cannot exist without a credential, so the
 *   route reports 503. This is the default for owner-only resources.
 * - `reject` — the request is refused with the route's own rejection shape
 *   (the issue routes answer a typed envelope, not a status/body pair).
 * - `serve-open` — the absence of a credential IS the answer the caller asked
 *   for, so the handler runs. Only the readiness ladder qualifies: its
 *   `credential-held` rung reports exactly this.
 */
export type OwnerlessPolicy = "unavailable" | "reject" | "serve-open";

export type OwnerAuthorityDecision =
  | { readonly kind: "authorized" }
  | { readonly kind: "serve-open" }
  | {
      readonly kind: "denied";
      readonly reason: "no-owner-capability" | "credential-mismatch";
    };

/**
 * Constant-time compare of a whole `Authorization` header against the owner
 * bearer. A missing header or a daemon generation with no owner token never
 * matches — callers that want the ownerless case handled differently ask
 * {@link decideOwnerAuthority} instead.
 */
export function ownerBearerMatches(
  header: string | null | undefined,
  ownerToken: string | null,
): boolean {
  if (!header || !ownerToken) return false;
  const supplied = Buffer.from(header, "utf8");
  const expected = Buffer.from(`Bearer ${ownerToken}`, "utf8");
  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
}

/** The pure decision: the check plus the route's ownerless policy. */
export function decideOwnerAuthority(
  header: string | null | undefined,
  ownerToken: string | null,
  whenOwnerless: OwnerlessPolicy,
): OwnerAuthorityDecision {
  if (!ownerToken) {
    if (whenOwnerless === "serve-open") return { kind: "serve-open" };
    return { kind: "denied", reason: "no-owner-capability" };
  }
  return ownerBearerMatches(header, ownerToken)
    ? { kind: "authorized" }
    : { kind: "denied", reason: "credential-mismatch" };
}

/**
 * A route's declared owner policy, including the exact rejection copy it
 * serves. The union makes the 503 body reachable only from the policy that can
 * actually answer 503.
 */
export type OwnerAuthorityPolicy =
  | {
      readonly whenOwnerless: "unavailable";
      /** 503 body when this daemon generation holds no owner capability. */
      readonly unavailableMessage: string;
      /** 401 body when the supplied credential is absent or wrong. */
      readonly mismatchMessage: string;
    }
  | { readonly whenOwnerless: "reject"; readonly mismatchMessage: string }
  | { readonly whenOwnerless: "serve-open"; readonly mismatchMessage: string };

/**
 * Builds a gate for handlers that check inline: returns the rejection Response,
 * or `null` when the handler should run (authorized, or ownerless under
 * `serve-open`).
 */
export function ownerAuthorityGate(
  ownerToken: string | null,
  policy: OwnerAuthorityPolicy,
): (c: Context) => Response | null {
  return (c) => {
    const decision = decideOwnerAuthority(
      c.req.header("Authorization"),
      ownerToken,
      policy.whenOwnerless,
    );
    if (decision.kind !== "denied") return null;
    if (decision.reason === "no-owner-capability" && policy.whenOwnerless === "unavailable") {
      return c.json({ error: policy.unavailableMessage }, 503);
    }
    return c.json({ error: policy.mismatchMessage }, 401);
  };
}

/** The same gate as Hono middleware, for routes that mount it as a layer. */
export function requireOwnerAuthority(
  ownerToken: string | null,
  policy: OwnerAuthorityPolicy,
): MiddlewareHandler {
  const gate = ownerAuthorityGate(ownerToken, policy);
  return async (c, next) => gate(c) ?? next();
}
