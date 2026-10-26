import { serve } from "@hono/node-server";
import { get } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadSavedMachines,
  updateSavedMachines,
  watchSavedMachines,
} from "../../lib/saved-machines.ts";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import type { SavedMachineRegistry } from "@tmux-ide/contracts";
import { mountSavedMachineRoute } from "./saved-machine-route.ts";
import { SAVED_MACHINE_WATCH_WAIT_MS } from "./saved-machine-watch.ts";
const daemon = {
  instanceId: "11111111-1111-4111-8111-111111111111",
  startedAt: "2026-10-25T00:00:00Z",
  protocolVersion: 4,
  productVersion: "test",
};
const empty = (): SavedMachineRegistry => ({ version: 1, machines: [] });
const changed = (): SavedMachineRegistry => ({
  version: 1,
  machines: [
    {
      id: "22222222-2222-4222-8222-222222222222",
      label: "Build",
      sshTarget: "build",
      enabled: true,
    },
  ],
});
function fixture() {
  const app = new Hono();
  let value = empty();
  const read = vi.fn(() => value);
  const stops: Array<ReturnType<typeof vi.fn>> = [];
  const listeners: Array<{ change: (value: SavedMachineRegistry) => void; error: () => void }> = [];
  const watch = vi.fn((change: (value: SavedMachineRegistry) => void, error: () => void) => {
    listeners.push({ change, error });
    const stop = vi.fn();
    stops.push(stop);
    return stop;
  });
  mountSavedMachineRoute(app, { daemon, ownerToken: "owner", read, watch });
  const request = (
    after?: string,
    signal?: AbortSignal,
    token = "owner",
    instance = daemon.instanceId,
  ) =>
    app.request(
      `/api/resources/saved-machines/watch?expectedInstanceId=${instance}${after ? `&after=${after}` : ""}`,
      { headers: { Authorization: `Bearer ${token}` }, signal },
    );
  return {
    app,
    read,
    watch,
    stops,
    listeners,
    request,
    set: (next: SavedMachineRegistry) => {
      value = next;
    },
  };
}
afterEach(() => vi.useRealTimers());
it("requires owner and exact generation before reading or watching", async () => {
  const f = fixture();
  expect((await f.request(undefined, undefined, "foreign")).status).toBe(401);
  expect(
    (await f.request(undefined, undefined, "owner", "22222222-2222-4222-8222-222222222222")).status,
  ).toBe(409);
  expect((await f.request("invalid")).status).toBe(400);
  expect(f.read).not.toHaveBeenCalled();
  expect(f.watch).not.toHaveBeenCalled();
  const response = await f.request();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({
    daemon,
    registry: empty(),
    revision: expect.stringMatching(/^[a-f0-9]{64}$/u),
  });
  expect(f.watch).not.toHaveBeenCalled();
});
it("ignores unchanged events and disposes once after a change", async () => {
  const f = fixture();
  const { revision } = await (await f.request()).json();
  const pending = f.request(revision);
  await vi.waitFor(() => expect(f.listeners).toHaveLength(1));
  f.listeners[0].change(empty());
  expect(f.stops[0]).not.toHaveBeenCalled();
  f.listeners[0].change(changed());
  const result = await (await pending).json();
  expect(result.registry).toEqual(changed());
  expect(result.revision).not.toBe(revision);
  expect(f.stops[0]).toHaveBeenCalledOnce();
  f.listeners[0].error();
  expect(f.stops[0]).toHaveBeenCalledOnce();
});
it("closes the read-before-subscribe race", async () => {
  const f = fixture();
  const { revision } = await (await f.request()).json();
  const stop = vi.fn();
  f.watch.mockImplementationOnce(() => {
    f.set(changed());
    return stop;
  });
  expect((await (await f.request(revision)).json()).registry).toEqual(changed());
  expect(stop).toHaveBeenCalledOnce();
});
it("cancels pending requests and disposes their watcher", async () => {
  const f = fixture();
  const { revision } = await (await f.request()).json();
  const controller = new AbortController();
  const pending = f.request(revision, controller.signal);
  await vi.waitFor(() => expect(f.listeners).toHaveLength(1));
  controller.abort();
  expect((await pending).status).toBe(408);
  expect(f.stops[0]).toHaveBeenCalledOnce();
});
it("disposes a watcher that reports an error synchronously", async () => {
  const f = fixture();
  const { revision } = await (await f.request()).json();
  const stop = vi.fn();
  f.watch.mockImplementationOnce((_change, error) => {
    error();
    return stop;
  });
  expect((await f.request(revision)).status).toBe(503);
  expect(stop).toHaveBeenCalledOnce();
});
it("bounds unchanged waits without polling the registry", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const { revision } = await (await f.request()).json();
  f.read.mockClear();
  const pending = f.request(revision);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.watch).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(SAVED_MACHINE_WATCH_WAIT_MS);
  expect(await (await pending).json()).toEqual({ daemon, revision, registry: null });
  expect(f.read).toHaveBeenCalledTimes(2);
  expect(f.stops[0]).toHaveBeenCalledOnce();
});
it("caps pending watches and releases capacity after abort", async () => {
  const f = fixture();
  const { revision } = await (await f.request()).json();
  const controllers = Array.from({ length: 32 }, () => new AbortController());
  const pending = controllers.map((c) => f.request(revision, c.signal));
  await vi.waitFor(() => expect(f.listeners).toHaveLength(32));
  expect((await f.request(revision)).status).toBe(429);
  controllers.forEach((c) => c.abort());
  for (const response of await Promise.all(pending)) expect(response.status).toBe(408);
  expect(f.stops.every((stop) => stop.mock.calls.length === 1)).toBe(true);
  expect((await f.request()).status).toBe(200);
});
it("fails closed on invalid event data without echoing it", async () => {
  const f = fixture();
  const { revision } = await (await f.request()).json();
  const pending = f.request(revision);
  await vi.waitFor(() => expect(f.listeners).toHaveLength(1));
  f.listeners[0].change({ ...empty(), secret: "private" } as SavedMachineRegistry);
  const response = await pending;
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("private");
  expect(f.stops[0]).toHaveBeenCalledOnce();
});

it("observes real atomic registry replacement", async () => {
  const root = mkdtempSync(join(tmpdir(), "native-machine-watch-"));
  const path = join(root, "machines.json");
  const controller = new AbortController();
  const app = new Hono();
  const watch = vi.fn((change: (value: SavedMachineRegistry) => void, error: () => void) =>
    watchSavedMachines(change, error, path),
  );
  mountSavedMachineRoute(app, {
    daemon,
    ownerToken: "owner",
    read: () => loadSavedMachines(path),
    watch,
  });
  const url = `/api/resources/saved-machines/watch?expectedInstanceId=${daemon.instanceId}`;
  const headers = { Authorization: "Bearer owner" };
  try {
    const { revision } = await (await app.request(url, { headers })).json();
    const pending = app.request(`${url}&after=${revision}`, { headers, signal: controller.signal });
    await vi.waitFor(() => expect(watch).toHaveBeenCalledOnce());
    updateSavedMachines({ type: "add", machine: changed().machines[0] }, path);
    const response = await pending;
    expect(response.status).toBe(200);
    expect((await response.json()).registry).toEqual(changed());
  } finally {
    controller.abort();
    rmSync(root, { recursive: true, force: true });
  }
});
it("releases watcher ownership on a real HTTP client disconnect", async () => {
  const f = fixture();
  const { revision } = await (await f.request()).json();
  const server = serve({ fetch: f.app.fetch, hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing listener");
  const request = get(
    `http://127.0.0.1:${address.port}/api/resources/saved-machines/watch?expectedInstanceId=${daemon.instanceId}&after=${revision}`,
    { headers: { Authorization: "Bearer owner" } },
  );
  request.on("error", () => {});
  try {
    await vi.waitFor(() => expect(f.listeners).toHaveLength(1));
    request.destroy();
    await vi.waitFor(() => expect(f.stops[0]).toHaveBeenCalledOnce());
  } finally {
    request.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
