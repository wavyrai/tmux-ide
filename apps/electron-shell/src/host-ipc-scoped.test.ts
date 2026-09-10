import { expect, it, vi } from "vitest";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import type { DesktopDaemonEvent } from "@tmux-ide/contracts";
import { registerHostIpc } from "./host-ipc.ts";
import type { DaemonConnectionAuthority } from "./daemon-connection-coordinator.ts";
import { HOST_IPC, scopedHostChannel } from "./ipc-channels.ts";
const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const identity = {
  protocolVersion: 1,
  productVersion: "test",
  instanceId: A,
  startedAt: "2026-07-21T00:00:00.000Z",
};
it("rejects arbitrary scopes and non-daemon scoped channels", () => {
  for (const scope of [
    "",
    "../../local",
    "machine",
    "http://localhost",
    A.toUpperCase().replace("0000", "ZZZZ"),
  ])
    expect(() => scopedHostChannel(scope, HOST_IPC.bootstrap)).toThrow();
  expect(() => scopedHostChannel(A, HOST_IPC.windowClose)).toThrow();
  expect(() => scopedHostChannel(null, "arbitrary")).toThrow();
  expect(scopedHostChannel(null, HOST_IPC.windowClose)).toBe(HOST_IPC.windowClose);
});
it("isolates registrations, colliding subscription ids, bootstrap retirement and disposal", async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const ipcMain = {
    handle: (
      channel: string,
      handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
    ) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  } as unknown as IpcMain;
  const mainFrame = { url: "file:///trusted/index.html" };
  const send = vi.fn();
  const webContents = { id: 7, mainFrame, send };
  const window = {
    webContents,
    isDestroyed: () => false,
    isMaximized: () => false,
    isFullScreen: () => false,
    isFocused: () => true,
  } as unknown as BrowserWindow;
  const event = { sender: webContents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
  const build = (scope: string | null) => {
    let publish: ((value: DesktopDaemonEvent) => void) | undefined;
    const unsubscribe = vi.fn(),
      releaseRenderer = vi.fn();
    const daemonResources = {
      state: () => ({ status: "connected", identity }),
      releaseRenderer,
      subscribe: async (_request: unknown, listener: (value: DesktopDaemonEvent) => void) => {
        publish = listener;
        return { status: "subscribed", unsubscribe };
      },
    } as unknown as DaemonConnectionAuthority;
    const registration = registerHostIpc({
      ipcMain,
      getWindow: () => window,
      appVersion: "test",
      platform: "darwin",
      daemonResources,
      ...(scope ? { channelScope: scope } : {}),
      selectProjectDirectory: async () => null,
      getTheme: () => ({ mode: "dark", highContrast: false, reducedMotion: false }),
      getUpdateStatus: () => ({ phase: "idle", currentVersion: "test", availableVersion: null }),
      readOnboardingIntroAcknowledged: () => false,
      acknowledgeOnboardingIntro: () => {},
      trustedRendererLocation: { kind: "packaged-url", url: mainFrame.url },
    });
    const invoke = (channel: string, ...args: unknown[]) =>
      handlers.get(scopedHostChannel(scope, channel))!(event, ...args);
    invoke(HOST_IPC.bootstrap);
    return {
      registration,
      invoke,
      unsubscribe,
      releaseRenderer,
      publish: () => publish?.({ type: "workspaces.changed" }),
    };
  };
  const local = build(null),
    localClose = handlers.get(HOST_IPC.windowClose),
    a = build(A),
    b = build(B);
  expect(handlers.get(HOST_IPC.windowClose)).toBe(localClose);
  expect(handlers.has(`${HOST_IPC.windowClose}/environment/${A}`)).toBe(false);
  const sa = await a.invoke(HOST_IPC.daemonSubscribe, { workspaceNames: [] }, A);
  const sb = await b.invoke(HOST_IPC.daemonSubscribe, { workspaceNames: [] }, A);
  expect(sa).toEqual(sb); // IDs intentionally collide within independent authorities.
  a.publish();
  b.publish();
  expect(send.mock.calls.slice(-2).map((call) => call[0])).toEqual([
    scopedHostChannel(A, HOST_IPC.daemonEvent),
    scopedHostChannel(B, HOST_IPC.daemonEvent),
  ]);
  a.invoke(HOST_IPC.bootstrap);
  expect(a.unsubscribe).toHaveBeenCalledOnce();
  expect(b.unsubscribe).not.toHaveBeenCalled();
  a.registration.dispose();
  expect(handlers.has(scopedHostChannel(A, HOST_IPC.bootstrap))).toBe(false);
  expect(handlers.has(scopedHostChannel(B, HOST_IPC.bootstrap))).toBe(true);
  expect(handlers.get(HOST_IPC.windowClose)).toBe(localClose);
  b.registration.dispose();
  local.registration.dispose();
  expect(handlers.size).toBe(0);
});
