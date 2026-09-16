import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { WorkspaceAdmissionResourceSchemaZ } from "@tmux-ide/contracts";
import { mountWorkspaceAdmissionRoute } from "./workspace-admission-route.ts";
import { WorkspacePromotionAuthority } from "../../lib/workspace-promotion.ts";
import { WorkspaceOpenAuthority } from "../../lib/workspace-open.ts";
const daemon = {
  protocolVersion: 1,
  productVersion: "1.0.0",
  instanceId: "0f5a2a3e-6f0a-4f1a-9f2b-1c2d3e4f5a6b",
  startedAt: "2026-08-04T11:59:00.000Z",
};
it("reads counters repeatedly without probing I/O or consuming admission", async () => {
  const runTmux = vi.fn(() => {
    throw new Error("must not probe");
  });
  const promotion = new WorkspacePromotionAuthority({
    daemonInstanceId: daemon.instanceId,
    io: { runTmux },
    maxPendingOperations: 1,
  });
  const open = new WorkspaceOpenAuthority({
    daemonInstanceId: daemon.instanceId,
    io: { runTmux },
    maxPendingOperations: 2,
  });
  const app = new Hono();
  mountWorkspaceAdmissionRoute(app, { daemon, ownerToken: "owner", promotion, open });
  for (let i = 0; i < 20; i++) {
    const response = await app.request("/api/resources/workspace-admission", {
      headers: { Authorization: "Bearer owner" },
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = WorkspaceAdmissionResourceSchemaZ.parse(await response.json());
    expect(body.promotion).toMatchObject({
      pending: 0,
      limit: 1,
      disposed: false,
      retained: 0,
      retentionMayBlock: false,
    });
    expect(body.open).toMatchObject({ pending: 0, limit: 2, disposed: false, retained: 0 });
  }
  expect(runTmux).not.toHaveBeenCalled();
  const pending = promotion.promote({
    operationId: "10000000-0000-4000-8000-000000000001",
    expectedDaemonInstanceId: daemon.instanceId,
    intent: { sessionId: "session.aaaaaaaaaaaaaaaaaaaa" },
  });
  // Admission is synchronous; passive snapshot does not drain the queue.
  expect(promotion.admissionSnapshot()).toMatchObject({ pending: 1, limit: 1, retained: 0 });
  const disposed = promotion.dispose();
  expect(promotion.admissionSnapshot()).toMatchObject({ pending: 1, disposed: true });
  await expect(pending).rejects.toThrow();
  await disposed;
  expect(promotion.admissionSnapshot()).toMatchObject({ pending: 0, disposed: true });
  await open.dispose();
});
it("gates before reading, and reports absent/failing backends as unknown without raw errors", async () => {
  const read = vi.fn(() => {
    throw new Error("Bearer secret");
  });
  const app = new Hono();
  mountWorkspaceAdmissionRoute(app, {
    daemon,
    ownerToken: "owner",
    promotion: { admissionSnapshot: read },
  });
  expect((await app.request("/api/resources/workspace-admission")).status).toBe(401);
  expect(read).not.toHaveBeenCalled();
  const response = await app.request("/api/resources/workspace-admission", {
    headers: { Authorization: "Bearer owner" },
  });
  expect(await response.json()).toMatchObject({ promotion: null, open: null });
  const ownerless = new Hono();
  mountWorkspaceAdmissionRoute(ownerless, { daemon, ownerToken: null });
  expect((await ownerless.request("/api/resources/workspace-admission")).status).toBe(503);
});
