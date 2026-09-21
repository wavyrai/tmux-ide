import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { emptyFleetClientState } from "@tmux-ide/core";
import { mountFleetClientStateRoute } from "./fleet-client-state-route.ts";

it("requires owner authority and exact generation before persisting preferences", async () => {
  const app = new Hono();
  const daemon = {
    instanceId: "11111111-1111-4111-8111-111111111111",
    startedAt: "2026-09-10T00:00:00Z",
    protocolVersion: 2,
    productVersion: "test",
  };
  const update = vi.fn(() => emptyFleetClientState());
  mountFleetClientStateRoute(app, {
    daemon,
    ownerToken: "owner",
    read: emptyFleetClientState,
    update,
  });
  const url = "/api/resources/fleet-client-state";
  expect((await app.request(url)).status).not.toBe(200);
  const post = (expectedInstanceId: string, authorization = "Bearer owner") =>
    app.request(url, {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ expectedInstanceId, change: { type: "visit", key: "x" } }),
    });
  expect((await post("22222222-2222-4222-8222-222222222222")).status).toBe(409);
  expect(update).not.toHaveBeenCalled();
  expect((await post(daemon.instanceId)).status).toBe(200);
  expect(update).toHaveBeenCalledOnce();
  expect((await app.request(url, { headers: { Authorization: "Bearer owner" } })).status).toBe(200);
});
