import { describe, expect, it } from "vitest";

import { createApp } from "./server.ts";

const OWNER = "capability-owner";

describe("daemon capability negotiation", () => {
  it("requires private owner authority", async () => {
    const app = createApp({ remoteAccess: { ownerToken: OWNER } });
    const response = await app.request("http://localhost/api/v2/capabilities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(401);
  });

  it("stamps actual backend availability with daemon identity", async () => {
    const daemonIdentity = {
      productVersion: "test",
      instanceId: "20000000-0000-4000-8000-000000000002",
      startedAt: "2026-07-22T00:00:00.000Z",
    };
    for (const available of [false, true]) {
      const app = createApp({
        remoteAccess: { ownerToken: OWNER },
        daemonIdentity,
        appWindowMutationBackend: available ? { mutate: async () => Promise.reject() } : undefined,
      });
      const response = await app.request("http://localhost/api/v2/capabilities", {
        method: "POST",
        headers: { Authorization: `Bearer ${OWNER}`, "Content-Type": "application/json" },
        body: "{}",
      });
      expect(await response.json()).toMatchObject({
        status: "ok",
        daemon: { instanceId: daemonIdentity.instanceId },
        capabilities: { appWindowMutation: { available } },
      });
    }
  });
});
