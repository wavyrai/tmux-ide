import { describe, expect, it, vi } from "vitest";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";

import type { DaemonResourceBroker } from "./daemon-resource-broker.ts";
import { registerHostIpc, rendererLocationIsTrusted } from "./host-ipc.ts";
import { HOST_IPC } from "./ipc-channels.ts";

describe("host IPC trust boundary", () => {
  it("accepts only the current window main frame and removes every handler", async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: (
        channel: string,
        handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
      ) => handlers.set(channel, handler),
      removeHandler: (channel: string) => handlers.delete(channel),
    } as unknown as IpcMain;
    const mainFrame = { url: "file:///trusted/renderer/index.html" };
    const webContents = { id: 7, mainFrame, send: vi.fn() };
    const window = {
      isDestroyed: () => false,
      isMaximized: () => false,
      isFullScreen: () => false,
      isFocused: () => true,
      webContents,
    } as unknown as BrowserWindow;
    const daemon = {
      status: "connected" as const,
      descriptor: {
        apiBaseUrl: "http://127.0.0.1:6060",
        protocolVersion: 1,
        productVersion: "2.8.0",
        instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
        startedAt: "2026-07-21T00:00:00.000Z",
      },
    };
    let publishDaemonEvent: ((event: { type: "workspaces.changed" }) => void) | undefined;
    const stopDaemonSubscription = vi.fn();
    const daemonResources = {
      listWorkspaces: vi.fn(async () => ({
        status: "ok",
        daemon: {
          protocolVersion: 1,
          productVersion: "2.8.0",
          instanceId: daemon.descriptor.instanceId,
          startedAt: daemon.descriptor.startedAt,
        },
        workspaces: [{ workspaceName: "product" }],
      })),
      fetchApplicationShell: vi.fn(async () => ({
        status: "error",
        error: { code: "workspace-not-found", reason: "The requested workspace is unavailable." },
      })),
      subscribe: vi.fn(async (_names, listener) => {
        publishDaemonEvent = listener;
        return { status: "subscribed", unsubscribe: stopDaemonSubscription };
      }),
      releaseRenderer: vi.fn(),
    } as unknown as DaemonResourceBroker;
    const registration = registerHostIpc({
      ipcMain,
      getWindow: () => window,
      appVersion: "test",
      platform: "darwin",
      daemon,
      daemonResources,
      requestQuit: vi.fn(),
      selectProjectDirectory: async () => null,
      getTheme: () => ({ mode: "dark", highContrast: false, reducedMotion: false }),
      trustedRendererLocation: {
        kind: "packaged-url",
        url: "file:///trusted/renderer/index.html",
      },
    });

    const bootstrap = handlers.get(HOST_IPC.bootstrap);
    const trustedEvent = {
      sender: webContents,
      senderFrame: mainFrame,
    } as unknown as IpcMainInvokeEvent;
    expect(bootstrap?.(trustedEvent)).toMatchObject({
      runtime: "electron",
      appVersion: "test",
      daemon: { status: "connected", identity: { instanceId: daemon.descriptor.instanceId } },
    });
    expect(() =>
      bootstrap?.({ sender: webContents, senderFrame: {} } as unknown as IpcMainInvokeEvent),
    ).toThrow("untrusted renderer");
    expect(() =>
      bootstrap?.({ sender: { id: 8 }, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent),
    ).toThrow("untrusted renderer");

    expect(await handlers.get(HOST_IPC.daemonListWorkspaces)?.(trustedEvent)).toMatchObject({
      status: "ok",
      workspaces: [{ workspaceName: "product" }],
    });
    expect(
      await handlers.get(HOST_IPC.daemonFetchApplicationShell)?.(trustedEvent, {
        workspaceName: "product",
      }),
    ).toMatchObject({ status: "error", error: { code: "workspace-not-found" } });
    expect(
      await handlers.get(HOST_IPC.daemonFetchApplicationShell)?.(trustedEvent, {
        workspaceName: "product",
        sessionName: "raw-target",
      }),
    ).toMatchObject({ status: "error", error: { code: "invalid-request" } });
    expect(daemonResources.fetchApplicationShell).toHaveBeenCalledOnce();

    const subscribed = await handlers.get(HOST_IPC.daemonSubscribe)?.(trustedEvent, {
      workspaceNames: ["product"],
    });
    expect(subscribed).toEqual({
      status: "subscribed",
      subscriptionId: "desktop-subscription-1",
    });
    publishDaemonEvent?.({ type: "workspaces.changed" });
    expect(webContents.send).toHaveBeenCalledWith(HOST_IPC.daemonEvent, {
      subscriptionId: "desktop-subscription-1",
      event: { type: "workspaces.changed" },
    });

    let finishList: (() => void) | undefined;
    vi.mocked(daemonResources.listWorkspaces).mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          finishList = () =>
            resolve({
              status: "ok",
              daemon: {
                protocolVersion: 1,
                productVersion: "2.8.0",
                instanceId: daemon.descriptor.instanceId,
                startedAt: daemon.descriptor.startedAt,
              },
              workspaces: [{ workspaceName: "product" }],
            });
        }),
    );
    const pendingList = handlers.get(HOST_IPC.daemonListWorkspaces)?.(trustedEvent);
    mainFrame.url = "https://attacker.invalid/renderer";
    finishList?.();
    await expect(pendingList).rejects.toThrow("untrusted renderer");
    mainFrame.url = "file:///trusted/renderer/index.html";

    // A redirect must not retain bridge authority merely because the Electron
    // WebContents and WebFrameMain objects are still the expected identities.
    mainFrame.url = "https://attacker.invalid/renderer";
    expect(() =>
      bootstrap?.({ sender: webContents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent),
    ).toThrow("untrusted renderer");
    publishDaemonEvent?.({ type: "workspaces.changed" });
    expect(webContents.send).toHaveBeenCalledTimes(1);

    mainFrame.url = "file:///trusted/renderer/index.html";
    await handlers.get(HOST_IPC.daemonUnsubscribe)?.(trustedEvent, "desktop-subscription-1");
    expect(stopDaemonSubscription).toHaveBeenCalledOnce();

    // A same-location bootstrap still creates a new renderer document
    // generation. An older invoke must not regain authority after its await.
    let finishGenerationList: (() => void) | undefined;
    vi.mocked(daemonResources.listWorkspaces).mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          finishGenerationList = () =>
            resolve({
              status: "ok",
              daemon: {
                protocolVersion: 1,
                productVersion: "2.8.0",
                instanceId: daemon.descriptor.instanceId,
                startedAt: daemon.descriptor.startedAt,
              },
              workspaces: [{ workspaceName: "product" }],
            });
        }),
    );
    const oldGenerationList = handlers.get(HOST_IPC.daemonListWorkspaces)?.(trustedEvent);
    bootstrap?.(trustedEvent);
    finishGenerationList?.();
    await expect(oldGenerationList).rejects.toThrow("untrusted renderer generation");

    registration.dispose();
    expect(daemonResources.releaseRenderer).toHaveBeenCalledTimes(2);
    expect(handlers.size).toBe(0);
  });

  it("releases generation authority on navigation, renderer loss, crash, and window close", async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: (
        channel: string,
        handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
      ) => handlers.set(channel, handler),
      removeHandler: (channel: string) => handlers.delete(channel),
    } as unknown as IpcMain;
    const webContentsListeners = new Map<string, Set<(...args: never[]) => void>>();
    const windowListeners = new Map<string, Set<(...args: never[]) => void>>();
    const add = (
      listeners: Map<string, Set<(...args: never[]) => void>>,
      name: string,
      listener: (...args: never[]) => void,
    ) => {
      const current = listeners.get(name) ?? new Set();
      current.add(listener);
      listeners.set(name, current);
    };
    const remove = (
      listeners: Map<string, Set<(...args: never[]) => void>>,
      name: string,
      listener: (...args: never[]) => void,
    ) => listeners.get(name)?.delete(listener);
    const emit = (
      listeners: Map<string, Set<(...args: never[]) => void>>,
      name: string,
      ...args: unknown[]
    ) => {
      for (const listener of listeners.get(name) ?? []) listener(...(args as never[]));
    };
    const mainFrame = { url: "file:///trusted/renderer/index.html" };
    const webContents = {
      id: 9,
      mainFrame,
      send: vi.fn(),
      on: (name: string, listener: (...args: never[]) => void) =>
        add(webContentsListeners, name, listener),
      removeListener: (name: string, listener: (...args: never[]) => void) =>
        remove(webContentsListeners, name, listener),
    };
    const window = {
      isDestroyed: () => false,
      isMaximized: () => false,
      isFullScreen: () => false,
      isFocused: () => true,
      webContents,
      on: (name: string, listener: (...args: never[]) => void) =>
        add(windowListeners, name, listener),
      removeListener: (name: string, listener: (...args: never[]) => void) =>
        remove(windowListeners, name, listener),
    } as unknown as BrowserWindow;
    const stop = vi.fn();
    let publish: ((event: { type: "workspaces.changed" }) => void) | undefined;
    const daemonResources = {
      subscribe: vi.fn(async (_names, listener) => {
        publish = listener;
        return { status: "subscribed", unsubscribe: stop };
      }),
      releaseRenderer: vi.fn(),
    } as unknown as DaemonResourceBroker;
    const registration = registerHostIpc({
      ipcMain,
      getWindow: () => window,
      appVersion: "test",
      platform: "darwin",
      daemon: {
        status: "connected",
        descriptor: {
          apiBaseUrl: "http://127.0.0.1:6060",
          protocolVersion: 1,
          productVersion: "2.8.0",
          instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
          startedAt: "2026-07-21T00:00:00.000Z",
        },
      },
      daemonResources,
      requestQuit: vi.fn(),
      selectProjectDirectory: async () => null,
      getTheme: () => ({ mode: "dark", highContrast: false, reducedMotion: false }),
      trustedRendererLocation: {
        kind: "packaged-url",
        url: "file:///trusted/renderer/index.html",
      },
    });
    registration.bindWindow(window);
    const event = { sender: webContents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
    const bootstrap = handlers.get(HOST_IPC.bootstrap)!;
    const subscribe = handlers.get(HOST_IPC.daemonSubscribe)!;

    bootstrap(event);
    await subscribe(event, { workspaceNames: ["product"] });
    emit(webContentsListeners, "did-start-navigation", {}, "file:///trusted", false, true);
    expect(stop).toHaveBeenCalledTimes(1);
    publish?.({ type: "workspaces.changed" });
    expect(webContents.send).not.toHaveBeenCalled();

    bootstrap(event);
    await subscribe(event, { workspaceNames: ["product"] });
    emit(webContentsListeners, "did-start-loading");
    expect(stop).toHaveBeenCalledTimes(2);

    bootstrap(event);
    await subscribe(event, { workspaceNames: ["product"] });
    emit(webContentsListeners, "render-process-gone", {}, {});
    expect(stop).toHaveBeenCalledTimes(3);

    bootstrap(event);
    await subscribe(event, { workspaceNames: ["product"] });
    emit(webContentsListeners, "destroyed");
    expect(stop).toHaveBeenCalledTimes(4);

    bootstrap(event);
    await subscribe(event, { workspaceNames: ["product"] });
    emit(windowListeners, "closed");
    expect(stop).toHaveBeenCalledTimes(5);
    expect(daemonResources.releaseRenderer).toHaveBeenCalledTimes(5);
    registration.dispose();
  });

  it("accepts a configured development origin but not a lookalike or foreign origin", () => {
    const trusted = { kind: "development-origin", origin: "http://127.0.0.1:5173" } as const;
    expect(rendererLocationIsTrusted("http://127.0.0.1:5173/src/main.tsx", trusted)).toBe(true);
    expect(rendererLocationIsTrusted("http://127.0.0.1:5173.evil.invalid/", trusted)).toBe(false);
    expect(rendererLocationIsTrusted("http://127.0.0.1:5174/", trusted)).toBe(false);
    expect(rendererLocationIsTrusted("not a URL", trusted)).toBe(false);
  });
});
