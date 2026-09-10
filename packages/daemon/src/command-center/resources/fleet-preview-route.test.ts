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
    if (args[0] === "list-windows") return "@1\tmain\n@2\tbuild";
    return "%1\t1\t1";
  });
  const id = discoverLiveSessionSummaries(run)[0].liveSessionId;
  const capture = createFleetPreviewCapture(run);
  expect(await capture(id)).toBe("safe red");
  expect(changed).toBe(true);
  expect(
    run.mock.calls.every(([args]) =>
      ["list-panes", "list-windows", "capture-pane"].includes(args[0]),
    ),
  ).toBe(true);
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

it("browses exact windows without selecting them and rejects foreign or removed windows", async () => {
  let removed = false;
  let captured = false;
  const run = vi.fn((args: string[]) => {
    if (args.includes("-a")) return "1\t$1\t123\tsession";
    if (args[0] === "list-windows") return "@1\tmain\n@2\tbuild";
    if (args[0] === "capture-pane") {
      captured = true;
      return "window snapshot";
    }
    return "%1\t1\t1\t@1\t0\tmain\n" + (removed && captured ? "" : "%2\t0\t1\t@2\t1\tbuild");
  });
  const id = discoverLiveSessionSummaries(run)[0].liveSessionId;
  const capture = createFleetPreviewCapture(run);
  expect(await capture.snapshot(id, undefined, "@2")).toEqual({
    windows: [
      { id: "@1", index: 0, name: "main", active: true, paneIds: ["%1"] },
      { id: "@2", index: 1, name: "build", active: false, paneIds: ["%2"] },
    ],
    selectedWindowId: "@2",
    text: "window snapshot",
  });
  expect(run).toHaveBeenCalledWith(["capture-pane", "-p", "-t", "%2", "-S", "-24"], undefined);
  expect(await capture.snapshot(id, undefined, "@99")).toBeNull();
  captured = false;
  removed = true;
  expect(await capture.snapshot(id, undefined, "@2")).toBeNull();
  expect(
    run.mock.calls.every(([args]) =>
      ["list-panes", "list-windows", "capture-pane"].includes(args[0]),
    ),
  ).toBe(true);
});

it("retains legacy response text while exposing structured window metadata", async () => {
  const app = new Hono();
  const daemon = {
    instanceId: "11111111-1111-4111-8111-111111111111",
    startedAt: "2026-09-10T00:00:00Z",
    productVersion: "test",
    protocolVersion: 2,
  };
  const snapshot = vi.fn(async () => ({
    windows: [{ id: "@1", index: 0, name: "main", active: true }],
    selectedWindowId: "@1",
    text: "safe",
  }));
  const capture = Object.assign(
    vi.fn(async () => "legacy"),
    { snapshot },
  );
  mountFleetPreviewRoute(app, { daemon, ownerToken: "owner", capture });
  const result = await app.request("/api/resources/fleet-preview", {
    method: "POST",
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({
      expectedInstanceId: daemon.instanceId,
      liveSessionId: "live-session.12345678901234567890",
      windowId: "@1",
    }),
  });
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ text: "safe", selectedWindowId: "@1" });
  expect(snapshot).toHaveBeenCalledWith(
    "live-session.12345678901234567890",
    expect.any(AbortSignal),
    "@1",
  );
  expect(capture).not.toHaveBeenCalled();
});

it("bounds pane membership to256 IDs and keeps selected window membership first", async () => {
  const run = vi.fn((args: string[]) => {
    if (args.includes("-a")) return "1\t$1\t123\tsession";
    if (args[0] === "list-windows") return "@1\tmain\n@2\tbuild";
    if (args[0] === "capture-pane") return "text";
    return [
      ...Array.from({ length: 256 }, (_, i) => `%${i}\t1\t${i === 0 ? 1 : 0}\t@1\t0`),
      "%300\t0\t1\t@2\t1",
    ].join("\n");
  });
  const id = discoverLiveSessionSummaries(run)[0].liveSessionId;
  const result = await createFleetPreviewCapture(run).snapshot(id, undefined, "@2");
  expect(result?.windows.find((w) => w.id === "@2")?.paneIds).toEqual(["%300"]);
  expect(result?.windows.find((w) => w.id === "@1")?.paneIds).toBeUndefined();
  expect(result?.windows.reduce((sum, w) => sum + (w.paneIds?.length ?? 0), 0)).toBeLessThanOrEqual(
    256,
  );
});

it("bounds parallel metadata work to two commands while keeping capture fenced", async () => {
  let active = 0;
  let peak = 0;
  const session = "1\t$1\t123\tsession";
  const id = discoverLiveSessionSummaries(() => session)[0].liveSessionId;
  const run = async (args: string[]) => {
    active++;
    peak = Math.max(peak, active);
    await Promise.resolve();
    active--;
    if (args.includes("-a")) return session;
    if (args[0] === "list-windows") return "@1\tmain";
    if (args[0] === "capture-pane") return "frame";
    return "%1\t1\t1\t@1\t0";
  };
  expect((await createFleetPreviewCapture(run).snapshot(id))?.text).toBe("frame");
  expect(peak).toBe(2);
  expect(active).toBe(0);
});
