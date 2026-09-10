import { afterEach, expect, it, vi } from "vitest";
import { createFleetPreviewOwner } from "./application-fleet-preview.ts";
afterEach(() => vi.useRealTimers());
it("debounces rapid navigation to one capture and rejects late replies after selection or disposal", async () => {
  vi.useFakeTimers();
  const publish = vi.fn();
  const owner = createFleetPreviewOwner(publish);
  let finish!: (value: string) => void;
  const first = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  for (let i = 0; i < 300; i++) owner.select(first);
  await vi.advanceTimersByTimeAsync(180);
  expect(first).toHaveBeenCalledOnce();
  const second = vi.fn(async () => "second host");
  owner.select(second);
  finish("stale first host");
  await vi.advanceTimersByTimeAsync(180);
  expect(publish).not.toHaveBeenCalledWith("stale first host");
  expect(publish).toHaveBeenLastCalledWith("second host");
  owner.select(first);
  owner.dispose();
  await vi.advanceTimersByTimeAsync(1000);
  expect(first).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not repeat a capture when metadata refreshes keep the same selected identity", async () => {
  vi.useFakeTimers();
  const read = vi.fn(async () => "snapshot"),
    publish = vi.fn();
  const owner = createFleetPreviewOwner(publish);
  owner.select(read, "session@generation-1");
  await vi.advanceTimersByTimeAsync(200);
  for (let i = 0; i < 100; i++) {
    owner.select(read, "session@generation-1");
    await vi.advanceTimersByTimeAsync(200);
  }
  expect(read).toHaveBeenCalledOnce();
  owner.select(read, "session@generation-2");
  await vi.advanceTimersByTimeAsync(200);
  expect(read).toHaveBeenCalledTimes(2);
  owner.dispose();
});

import {
  createAdaptiveFleetPreviewOwner,
  readFleetWindowPreview,
  type FleetPreviewResult,
} from "./application-fleet-preview.ts";
it("refreshes only after completion, backs off failures and stops completely when hidden", async () => {
  vi.useFakeTimers();
  let finish!: (result: FleetPreviewResult) => void;
  const read = vi.fn(
    () =>
      new Promise<FleetPreviewResult>((resolve) => {
        finish = resolve;
      }),
  );
  const publish = vi.fn();
  const owner = createAdaptiveFleetPreviewOwner(publish);
  owner.select(read, "route/session/window");
  await vi.advanceTimersByTimeAsync(180);
  owner.refresh();
  owner.refresh();
  await vi.advanceTimersByTimeAsync(5000);
  expect(read).toHaveBeenCalledOnce();
  finish({ status: "ready", snapshot: { windows: [], selectedWindowId: null, text: "snapshot" } });
  await vi.advanceTimersByTimeAsync(999);
  expect(read).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(2);
  finish({ status: "rate-limited" });
  await vi.advanceTimersByTimeAsync(1999);
  expect(read).toHaveBeenCalledTimes(2);
  expect(publish).toHaveBeenLastCalledWith({
    status: "unavailable",
    snapshot: { windows: [], selectedWindowId: null, text: "snapshot" },
    stale: true,
  });
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(3);
  owner.select();
  finish({ status: "ready", snapshot: { windows: [], selectedWindowId: null, text: "late" } });
  await vi.advanceTimersByTimeAsync(20000);
  expect(read).toHaveBeenCalledTimes(3);
  expect(publish).toHaveBeenLastCalledWith({ status: "idle", snapshot: null, stale: false });
  expect(vi.getTimerCount()).toBe(0);
  owner.dispose();
});

it("debounces adaptive navigation and preserves polling schedule across metadata-only refreshes", async () => {
  vi.useFakeTimers();
  const read = vi.fn(
    async (): Promise<FleetPreviewResult> => ({
      status: "ready",
      snapshot: { windows: [], selectedWindowId: null, text: "same" },
    }),
  );
  const publish = vi.fn();
  const owner = createAdaptiveFleetPreviewOwner(publish);
  for (let i = 0; i < 100; i++) owner.select(read, `route/${i}`);
  await vi.advanceTimersByTimeAsync(180);
  expect(read).toHaveBeenCalledOnce();
  const published = publish.mock.calls.length;
  for (let i = 0; i < 10; i++) {
    owner.select(read, "route/99");
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(read).toHaveBeenCalledTimes(2);
  expect(publish).toHaveBeenCalledTimes(published);
  owner.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it("validates preview metadata and never accepts a reply from a replaced route", async () => {
  const daemon = {
    bindHostname: "127.0.0.1",
    port: 4000,
    authToken: "test-only",
    instanceId: "11111111-1111-4111-8111-111111111111",
    startedAt: "2026-09-10T00:00:00Z",
  };
  let epoch = 1;
  const handle = {
    read: () => daemon,
    endpoint: () => ({ state: "ready", epoch }),
  } as unknown as import("./application-machine-authority.ts").ApplicationMachineAuthorityHandle;
  const liveSessionId = "live-session.12345678901234567890";
  const body = {
    daemon,
    liveSessionId,
    text: "hello\u001b[31m red\u001b[0m\u0007",
    windows: [{ id: "@1", index: 0, name: "main", active: true }],
    selectedWindowId: "@1",
  };
  const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
    Response.json(body),
  );
  vi.stubGlobal("fetch", fetchMock);
  try {
    expect(
      await readFleetWindowPreview(handle, liveSessionId, new AbortController().signal, "@1"),
    ).toMatchObject({ status: "ready", snapshot: { text: "hello red", selectedWindowId: "@1" } });
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toMatchObject({
      windowId: "@1",
      expectedInstanceId: daemon.instanceId,
    });
    fetchMock.mockImplementation(async () =>
      Response.json({ ...body, windows: Array.from({ length: 65 }, () => body.windows[0]) }),
    );
    expect(
      await readFleetWindowPreview(handle, liveSessionId, new AbortController().signal),
    ).toEqual({ status: "unavailable" });
    fetchMock.mockImplementation(async () => {
      epoch++;
      return Response.json(body);
    });
    expect(
      await readFleetWindowPreview(handle, liveSessionId, new AbortController().signal),
    ).toEqual({ status: "unavailable" });
    fetchMock.mockImplementation(async () => new Response("rate limited", { status: 429 }));
    expect(
      await readFleetWindowPreview(handle, liveSessionId, new AbortController().signal),
    ).toEqual({ status: "rate-limited" });
  } finally {
    vi.unstubAllGlobals();
  }
});

import { fleetPreviewActivity } from "./application-fleet-preview.ts";
it("summarizes only cached agents in the selected window and preserves unknown membership", () => {
  const agents = [
    { paneId: "%1", attention: true, activity: "waiting" },
    { paneId: "%2", attention: false, activity: "running" },
    { paneId: "%3", attention: true, activity: "failed" },
  ];
  expect(fleetPreviewActivity(["%1", "%2"], agents)).toBe("1 attention · 1 running");
  expect(fleetPreviewActivity(["%2"], agents)).toBe("0 attention · 1 running");
  expect(fleetPreviewActivity(["%5"], agents)).toBe("○ idle");
  expect(fleetPreviewActivity(undefined, agents)).toBe("? activity");
  expect(fleetPreviewActivity(["%1"], undefined)).toBe("? activity");
});
