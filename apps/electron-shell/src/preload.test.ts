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
  it("exposes only named, schema-validated semantic create and attachment issue calls", async () => {
    const capabilities = electron.exposeInMainWorld.mock.calls[0]?.[1] as HostCapabilities;
    const callsBefore = electron.invoke.mock.calls.length;
    const invocation = {
      version: 1 as const,
      id: "workspace.pane.create" as const,
      source: { kind: "mouse" as const, surface: "create-pane-dialog" },
      args: { kind: "terminal" as const, workspaceName: "product" },
    };
    electron.invoke.mockImplementationOnce(async (channel: string, value: unknown) => {
      expect(channel).toBe(HOST_IPC.daemonCreateWorkspacePane);
      expect(value).toEqual(invocation);
      return {
        status: "error",
        error: { code: "daemon-unavailable", reason: "The canonical daemon is unavailable." },
      };
    });
    await expect(capabilities.daemon.createWorkspacePane(invocation)).resolves.toMatchObject({
      status: "error",
      error: { code: "daemon-unavailable" },
    });

    const attachment = {
      protocolVersion: 1 as const,
      target: { workspaceName: "product", semanticPaneId: "pane.worker" },
      viewerMode: "interactive" as const,
      viewport: { cols: 120, rows: 40 },
    };
    electron.invoke.mockImplementationOnce(async (channel: string, value: unknown) => {
      expect(channel).toBe(HOST_IPC.daemonIssueTerminalAttachment);
      expect(value).toEqual(attachment);
      return {
        status: "error",
        error: {
          code: "attachment-unavailable",
          reason: "The terminal attachment is unavailable.",
          retryable: true,
        },
      };
    });
    await expect(capabilities.daemon.issueTerminalAttachment(attachment)).resolves.toMatchObject({
      status: "error",
      error: { code: "attachment-unavailable" },
    });

    await expect(
      capabilities.daemon.createWorkspacePane({
        ...invocation,
        ownerToken: "renderer-secret",
      } as typeof invocation),
    ).rejects.toThrow();
    expect(electron.invoke.mock.calls).toHaveLength(callsBefore + 2);
  });

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
