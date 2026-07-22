import { beforeAll, describe, expect, it, vi } from "vitest";

import type { DesktopDaemonEvent, HostCapabilities } from "@tmux-ide/contracts";

import { HOST_IPC } from "./ipc-channels.ts";

const electron = vi.hoisted(() => {
  const listeners = new Map<string, (event: unknown, value: unknown) => void>();
  return {
    listeners,
    exposeInMainWorld: vi.fn(),
    invoke: vi.fn(),
    on: vi.fn((channel: string, listener: (event: unknown, value: unknown) => void) => {
      listeners.set(channel, listener);
    }),
    removeListener: vi.fn(),
  };
});

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    invoke: electron.invoke,
    on: electron.on,
    removeListener: electron.removeListener,
  },
}));

beforeAll(async () => {
  await import("./preload.ts");
});

describe("desktop preload daemon bridge", () => {
  it("exposes and validates the semantic daemon refresh result", async () => {
    electron.invoke.mockImplementationOnce(async (channel: string) => {
      expect(channel).toBe(HOST_IPC.daemonRefreshConnection);
      return {
        outcome: "generation-replaced",
        previousIdentity: null,
        daemon: {
          status: "connected",
          identity: {
            protocolVersion: 1,
            productVersion: "2.8.0",
            instanceId: "3371dd7b-f76f-44e9-aefe-0e357a066056",
            startedAt: "2026-07-22T00:00:00.000Z",
          },
        },
      };
    });
    const capabilities = electron.exposeInMainWorld.mock.calls[0]?.[1] as HostCapabilities;

    await expect(capabilities.daemon.refreshConnection()).resolves.toMatchObject({
      outcome: "generation-replaced",
      daemon: { status: "connected" },
    });
  });

  it("hands off a verified event that arrives before the subscribe invoke resolves", async () => {
    const subscriptionId = "desktop-subscription-1";
    const earlyEvent: DesktopDaemonEvent = {
      type: "connection.changed",
      state: "live",
      error: null,
    };
    electron.invoke.mockImplementationOnce(async (channel: string) => {
      expect(channel).toBe(HOST_IPC.daemonSubscribe);
      electron.listeners.get(HOST_IPC.daemonEvent)?.({}, { subscriptionId, event: earlyEvent });
      return { status: "subscribed", subscriptionId };
    });
    const capabilities = electron.exposeInMainWorld.mock.calls[0]?.[1] as HostCapabilities;
    const received: DesktopDaemonEvent[] = [];
    const result = await capabilities.daemon.subscribe({ workspaceNames: ["product"] }, (event) =>
      received.push(event),
    );

    expect(result.status).toBe("subscribed");
    expect(received).toEqual([earlyEvent]);
  });
});
