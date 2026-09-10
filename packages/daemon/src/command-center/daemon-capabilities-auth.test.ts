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
  it("only includes window viewport capability when explicitly requested", async () => {
    const app = createApp({ remoteAccess: { ownerToken: OWNER } });
    const read = async (query: string) =>
      (
        await app.request(`http://localhost/api/v2/capabilities${query}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${OWNER}`, "Content-Type": "application/json" },
          body: "{}",
        })
      ).json();
    expect((await read("")).capabilities).not.toHaveProperty("semanticWindowViewport");
    expect((await read("?windowViewport=1")).capabilities.semanticWindowViewport).toEqual({
      available: false,
      reason: "This daemon has no pane-stream backend.",
    });
  });
  it("withholds scoped fitting until cross-window sizing is qualified", async () => {
    const app = createApp({
      remoteAccess: { ownerToken: OWNER },
      paneStreamIssueBackend: {
        issue: async () => {
          throw new Error("not called");
        },
      },
    });
    const response = await app.request("http://localhost/api/v2/capabilities?windowViewport=1", {
      method: "POST",
      headers: { Authorization: `Bearer ${OWNER}`, "Content-Type": "application/json" },
      body: "{}",
    });
    expect((await response.json()).capabilities.semanticWindowViewport).toEqual({
      available: false,
      reason: "Window fitting is awaiting isolated sizing qualification.",
    });
  });
});
