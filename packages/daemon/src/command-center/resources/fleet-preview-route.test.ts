import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { createFleetPreviewCapture, mountFleetPreviewRoute } from "./fleet-preview-route.ts";
import { discoverLiveSessionSummaries } from "../discovery.ts";
it("captures only a currently matching session, strips terminal controls and never issues mutations", async () => {
  let changed = false;
  const run = vi.fn((args: string[]) => {
    if (args[0] === "capture-pane") {
      changed = true;
      return "safe\u001b[31m red\u001b[0m\u0007";
    }
    if (args.includes("-a")) return "1\t$1\t123\tsession";
    return "%1\t1\t1";
  });
  const id = discoverLiveSessionSummaries(run)[0].liveSessionId;
  const capture = createFleetPreviewCapture(run);
  expect(await capture(id)).toBe("safe red");
  expect(changed).toBe(true);
  expect(run.mock.calls.every(([args]) => ["list-panes", "capture-pane"].includes(args[0]))).toBe(
    true,
  );
  run.mockImplementation((args) =>
    args[0] === "capture-pane"
      ? "old text"
      : args.includes("-a")
        ? "2\t$1\t124\tsession"
        : "%1\t1\t1",
  );
  expect(await capture(id)).toBeNull();
});
it("requires owner and exact generation and bounds capture rate across clients", async () => {
  const daemon = {
    instanceId: "11111111-1111-4111-8111-111111111111",
    startedAt: "2026-09-10T00:00:00Z",
    productVersion: "test",
    protocolVersion: 2,
  };
  const capture = vi.fn(() => "snapshot");
  const app = new Hono();
  let now = 1000;
  mountFleetPreviewRoute(app, { daemon, ownerToken: "owner", capture, now: () => now });
  const post = (generation = daemon.instanceId, token = "owner") =>
    app.request("/api/resources/fleet-preview", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedInstanceId: generation,
        liveSessionId: "live-session.12345678901234567890",
      }),
    });
  expect((await post(undefined, "other")).status).not.toBe(200);
  expect((await post("22222222-2222-4222-8222-222222222222")).status).toBe(409);
  expect(capture).not.toHaveBeenCalled();
  expect((await post()).status).toBe(200);
  expect((await post()).status).toBe(429);
  now += 250;
  expect((await post()).status).toBe(200);
  expect(capture).toHaveBeenCalledTimes(2);
});

it("keeps other HTTP reads responsive while one bounded capture is pending", async () => {
  const app = new Hono();
  let finish!: (value: string) => void;
  const capture = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const daemon = {
    instanceId: "11111111-1111-4111-8111-111111111111",
    startedAt: "2026-09-10T00:00:00Z",
    productVersion: "test",
    protocolVersion: 2,
  };
  mountFleetPreviewRoute(app, { daemon, ownerToken: "owner", capture });
  const pending = app.request("/api/resources/fleet-preview", {
    method: "POST",
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({
      expectedInstanceId: daemon.instanceId,
      liveSessionId: "live-session.12345678901234567890",
    }),
  });
  await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
  expect(
    (
      await app.request("/api/resources/fleet-preview", {
        headers: { Authorization: "Bearer owner" },
      })
    ).status,
  ).toBe(200);
  finish("snapshot");
  expect((await pending).status).toBe(200);
});
