import { afterEach, expect, it, vi } from "vitest";
import { emptyFleetClientState } from "@tmux-ide/core";
const f = vi.hoisted(() => ({ read: vi.fn(), alive: vi.fn(async () => true), load: vi.fn() }));
vi.mock("../../../lib/canonical-daemon.ts", () => ({
  readCanonicalDaemonInfo: f.read,
  isCanonicalDaemonAlive: f.alive,
  canonicalDaemonUrl: () => "http://127.0.0.1:4000",
}));
vi.mock("../../../lib/fleet-client-state.ts", () => ({ loadFleetClientState: f.load }));
import { createApplicationFleetPreferences } from "./application-fleet-preferences.ts";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});
it("retains newer optimistic edits through a failed write and retries against the local owner", async () => {
  vi.useFakeTimers();
  f.load.mockReturnValue(emptyFleetClientState());
  const daemon = {
    instanceId: "11111111-1111-4111-8111-111111111111",
    startedAt: "2026-09-10T00:00:00Z",
    productVersion: "test",
    protocolVersion: 2,
    authToken: "local-only",
  };
  f.read.mockReturnValue(daemon);
  let fail!: (e: Error) => void;
  const request = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    )
    .mockImplementation(async () =>
      Response.json({
        daemon: {
          instanceId: daemon.instanceId,
          startedAt: daemon.startedAt,
          productVersion: "test",
          protocolVersion: 2,
        },
        state: emptyFleetClientState(),
      }),
    );
  vi.stubGlobal("fetch", request);
  const preferences = createApplicationFleetPreferences();
  try {
    preferences.change({ type: "favorite", key: "session", enabled: true });
    await vi.advanceTimersByTimeAsync(0);
    preferences.change({ type: "favorite", key: "session", enabled: false });
    fail(new Error("transient"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(request).toHaveBeenCalledTimes(2);
    const init = request.mock.calls[1][1];
    expect(JSON.parse(init.body).change.enabled).toBe(false);
    expect(init.headers.Authorization).toBe("Bearer local-only");
    expect(preferences.getSnapshot().favorites).toEqual([]);
  } finally {
    preferences.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});
it("preserves a corrupt file and stays memory-only", () => {
  f.load.mockImplementation(() => {
    throw new Error("corrupt");
  });
  const request = vi.fn();
  vi.stubGlobal("fetch", request);
  const preferences = createApplicationFleetPreferences();
  preferences.change({ type: "visit", key: "session" });
  expect(preferences.getSnapshot().recent).toEqual(["session"]);
  expect(request).not.toHaveBeenCalled();
  preferences.dispose();
});
