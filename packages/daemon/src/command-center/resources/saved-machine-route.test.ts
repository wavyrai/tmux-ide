import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadSavedMachines,
  updateSavedMachines,
  watchSavedMachines,
} from "../../lib/saved-machines.ts";
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

it("fences profile mutations by local owner and generation", async () => {
  const daemon = {
    instanceId: "11111111-1111-4111-8111-111111111111",
    startedAt: "2026-10-05T00:00:00Z",
    protocolVersion: 2,
    productVersion: "test",
  };
  const id = "22222222-2222-4222-8222-222222222222";
  const update = vi.fn(() => ({ version: 1 as const, machines: [] }));
  const app = new Hono();
  mountSavedMachineRoute(app, { daemon, ownerToken: "owner", update });
  const patch = (change: unknown, token = "owner", expectedInstanceId = daemon.instanceId) =>
    app.request("/api/resources/saved-machines", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expectedInstanceId, change }),
    });
  expect((await patch({ id, operation: "remove" }, "foreign")).status).not.toBe(200);
  expect((await patch({ id, operation: "remove" }, "owner", id)).status).toBe(409);
  expect((await patch({ id, operation: "stop" })).status).toBe(400);
  expect((await patch({ id, operation: "remove", token: "secret" })).status).toBe(400);
  expect(update).not.toHaveBeenCalled();
  for (const operation of ["disable", "enable", "remove"] as const) {
    const response = await patch({ id, operation });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(update).toHaveBeenLastCalledWith(
      operation === "remove"
        ? { type: "remove", id }
        : { type: "update", id, patch: { enabled: operation === "enable" } },
    );
  }
  update.mockImplementationOnce(() => {
    throw new Error("private registry path");
  });
  const conflict = await patch({ id, operation: "remove" });
  expect(conflict.status).toBe(409);
  expect(await conflict.text()).not.toContain("private registry path");
});

it("publishes persisted enable/disable/removal to an existing registry observer", async () => {
  const root = mkdtempSync(join(tmpdir(), "machine-route-"));
  const path = join(root, "machines.json");
  const id = "22222222-2222-4222-8222-222222222222";
  const daemon = {
    instanceId: "11111111-1111-4111-8111-111111111111",
    startedAt: "2026-10-05T00:00:00Z",
    protocolVersion: 2,
    productVersion: "test",
  };
  updateSavedMachines(
    { type: "add", machine: { id, label: "Build", sshTarget: "builder", enabled: true } },
    path,
  );
  let observed = loadSavedMachines(path);
  const errors = vi.fn();
  const stop = watchSavedMachines(
    (value) => {
      observed = value;
    },
    errors,
    path,
  );
  try {
    const app = new Hono();
    mountSavedMachineRoute(app, {
      daemon,
      ownerToken: "owner",
      update: (change) => updateSavedMachines(change, path),
    });
    for (const operation of ["disable", "enable", "remove"] as const) {
      const response = await app.request("/api/resources/saved-machines", {
        method: "PATCH",
        headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
        body: JSON.stringify({ expectedInstanceId: daemon.instanceId, change: { id, operation } }),
      });
      expect(response.status).toBe(200);
      const expected =
        operation === "remove"
          ? []
          : [{ id, label: "Build", sshTarget: "builder", enabled: operation === "enable" }];
      expect(loadSavedMachines(path).machines).toEqual(expected);
      await vi.waitFor(() => expect(observed.machines).toEqual(expected));
    }
    expect(errors).not.toHaveBeenCalled();
  } finally {
    stop();
    rmSync(root, { recursive: true, force: true });
  }
});
