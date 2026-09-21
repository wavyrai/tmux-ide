import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { mountSavedMachineRoute } from "./saved-machine-route.ts";
it("rejects foreign authority, stale generations, secrets and oversized imports before merging", async () => {
  const daemon = {
    instanceId: "11111111-1111-4111-8111-111111111111",
    startedAt: "2026-09-10T00:00:00Z",
    protocolVersion: 2,
    productVersion: "test",
  };
  const registry = { version: 1 as const, machines: [] };
  const merge = vi.fn(() => registry);
  const app = new Hono();
  mountSavedMachineRoute(app, { daemon, ownerToken: "owner", read: () => registry, merge });
  const url = "/api/resources/saved-machines";
  const post = (body: unknown, token = "owner") =>
    app.request(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await app.request(url)).status).not.toBe(200);
  expect(
    (await post({ expectedInstanceId: daemon.instanceId, registry }, "other")).status,
  ).not.toBe(200);
  expect(
    (await post({ expectedInstanceId: "22222222-2222-4222-8222-222222222222", registry })).status,
  ).toBe(409);
  expect(
    (
      await post({
        expectedInstanceId: daemon.instanceId,
        registry: { ...registry, authToken: "secret" },
      })
    ).status,
  ).toBe(400);
  expect((await post({ padding: "x".repeat(65536) })).status).toBe(413);
  expect(merge).not.toHaveBeenCalled();
  const ok = await post({ expectedInstanceId: daemon.instanceId, registry });
  expect(ok.status).toBe(200);
  expect(ok.headers.get("cache-control")).toBe("no-store");
  expect(merge).toHaveBeenCalledOnce();
});
