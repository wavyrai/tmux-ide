import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import {
  decideOwnerAuthority,
  ownerAuthorityGate,
  ownerBearerMatches,
  requireOwnerAuthority,
  type OwnerAuthorityPolicy,
} from "./owner-authority.ts";

const OWNER = "owner-token";
const UNAVAILABLE: OwnerAuthorityPolicy = {
  whenOwnerless: "unavailable",
  unavailableMessage: "capability is unavailable",
  mismatchMessage: "requires owner authority",
};
const OPEN: OwnerAuthorityPolicy = {
  whenOwnerless: "serve-open",
  mismatchMessage: "requires owner authority",
};
const REJECT: OwnerAuthorityPolicy = {
  whenOwnerless: "reject",
  mismatchMessage: "requires owner authority",
};

describe("ownerBearerMatches", () => {
  it("matches only the exact whole header", () => {
    expect(ownerBearerMatches(`Bearer ${OWNER}`, OWNER)).toBe(true);
    expect(ownerBearerMatches(`bearer ${OWNER}`, OWNER)).toBe(false);
    expect(ownerBearerMatches(`Bearer ${OWNER} `, OWNER)).toBe(false);
    expect(ownerBearerMatches(OWNER, OWNER)).toBe(false);
    expect(ownerBearerMatches(`Bearer ${OWNER}x`, OWNER)).toBe(false);
    expect(ownerBearerMatches("Bearer other", OWNER)).toBe(false);
  });

  it("never matches without a header or without an owner token", () => {
    expect(ownerBearerMatches(null, OWNER)).toBe(false);
    expect(ownerBearerMatches(undefined, OWNER)).toBe(false);
    expect(ownerBearerMatches("", OWNER)).toBe(false);
    expect(ownerBearerMatches(`Bearer ${OWNER}`, null)).toBe(false);
    expect(ownerBearerMatches(null, null)).toBe(false);
  });
});

describe("decideOwnerAuthority", () => {
  it("authorizes an exact bearer under every policy", () => {
    for (const policy of ["unavailable", "reject", "serve-open"] as const) {
      expect(decideOwnerAuthority(`Bearer ${OWNER}`, OWNER, policy)).toEqual({
        kind: "authorized",
      });
    }
  });

  it("denies a wrong credential under every policy, ownerless behavior aside", () => {
    for (const policy of ["unavailable", "reject", "serve-open"] as const) {
      expect(decideOwnerAuthority("Bearer wrong", OWNER, policy)).toEqual({
        kind: "denied",
        reason: "credential-mismatch",
      });
      expect(decideOwnerAuthority(undefined, OWNER, policy)).toEqual({
        kind: "denied",
        reason: "credential-mismatch",
      });
    }
  });

  it("splits only on the ownerless case", () => {
    expect(decideOwnerAuthority(`Bearer ${OWNER}`, null, "unavailable")).toEqual({
      kind: "denied",
      reason: "no-owner-capability",
    });
    expect(decideOwnerAuthority(`Bearer ${OWNER}`, null, "reject")).toEqual({
      kind: "denied",
      reason: "no-owner-capability",
    });
    expect(decideOwnerAuthority(`Bearer ${OWNER}`, null, "serve-open")).toEqual({
      kind: "serve-open",
    });
    expect(decideOwnerAuthority(undefined, null, "serve-open")).toEqual({ kind: "serve-open" });
  });
});

/** Mounts a route whose body is `{ served: true }` behind the given gate. */
function gatedApp(ownerToken: string | null, policy: OwnerAuthorityPolicy): Hono {
  const app = new Hono();
  const gate = ownerAuthorityGate(ownerToken, policy);
  app.get("/probe", (c) => gate(c) ?? c.json({ served: true }));
  return app;
}

async function probe(app: Hono, header?: string): Promise<Response> {
  return app.request("http://localhost/probe", {
    headers: header === undefined ? {} : { Authorization: header },
  });
}

describe("ownerAuthorityGate", () => {
  it("serves the handler on an exact bearer", async () => {
    const response = await probe(gatedApp(OWNER, UNAVAILABLE), `Bearer ${OWNER}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ served: true });
  });

  it("answers 401 with the route's mismatch copy on a wrong or missing credential", async () => {
    for (const header of [undefined, "Bearer wrong", OWNER]) {
      const response = await probe(gatedApp(OWNER, UNAVAILABLE), header);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "requires owner authority" });
    }
  });

  it("answers 503 with the route's unavailable copy when the daemon holds no owner token", async () => {
    const response = await probe(gatedApp(null, UNAVAILABLE), `Bearer ${OWNER}`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "capability is unavailable" });
  });

  it("answers 401 for the ownerless `reject` policy — it has no 503 to serve", async () => {
    const response = await probe(gatedApp(null, REJECT), `Bearer ${OWNER}`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "requires owner authority" });
  });

  it("serves the handler when ownerless under `serve-open`, and still checks a real token", async () => {
    const open = await probe(gatedApp(null, OPEN));
    expect(open.status).toBe(200);
    expect(await open.json()).toEqual({ served: true });

    const mismatched = await probe(gatedApp(OWNER, OPEN), "Bearer wrong");
    expect(mismatched.status).toBe(401);
  });
});

describe("requireOwnerAuthority", () => {
  it("gates as middleware and passes an authorized request to the handler", async () => {
    const app = new Hono();
    app.get("/probe", requireOwnerAuthority(OWNER, UNAVAILABLE), (c) => c.json({ served: true }));

    const denied = await probe(app, "Bearer wrong");
    expect(denied.status).toBe(401);

    const allowed = await probe(app, `Bearer ${OWNER}`);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ served: true });
  });
});
