import { describe, expect, it, vi } from "vitest";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import type {
  TerminalAttachmentIssueMutationRequest,
  TerminalAttachmentIssueResult,
  WorkspacePaneCreateMutationRequest,
} from "@tmux-ide/contracts";

import type { DaemonConnectionAuthority } from "./daemon-connection-coordinator.ts";
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
      createWorkspacePane: vi.fn(async (request: WorkspacePaneCreateMutationRequest) => ({
        operationId: request.operationId,
        daemonInstanceId: request.expectedDaemonInstanceId,
        outcome: "created" as const,
        resource: {
          resourceVersion: 1 as const,
          workspaceName: request.intent.workspaceName,
          semanticPaneId: `pane.${request.operationId.replaceAll("-", "")}`,
          kind: "terminal" as const,
          displayTitle: "Terminal",
          harnessProfileId: null,
          role: null,
          missionId: null,
        },
      })),
      issueTerminalAttachment: vi.fn(),
      state: () => ({
        status: "connected" as const,
        identity: {
          protocolVersion: 1,
          productVersion: "2.8.0",
          instanceId: daemon.descriptor.instanceId,
          startedAt: daemon.descriptor.startedAt,
        },
      }),
      refreshConnection: vi.fn(async () => ({
        outcome: "unchanged" as const,
        daemon: {
          status: "connected" as const,
          identity: {
            protocolVersion: 1,
            productVersion: "2.8.0",
            instanceId: daemon.descriptor.instanceId,
            startedAt: daemon.descriptor.startedAt,
          },
        },
      })),
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
      dispose: vi.fn(),
    } as unknown as DaemonConnectionAuthority;
    const registration = registerHostIpc({
      ipcMain,
      getWindow: () => window,
      appVersion: "test",
      platform: "darwin",
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

    const created = await handlers.get(HOST_IPC.daemonCreateWorkspacePane)?.(trustedEvent, {
      version: 1,
      id: "workspace.pane.create",
      source: { kind: "mouse", surface: "create-pane-dialog" },
      args: { kind: "terminal", workspaceName: "product" },
    });
    expect(created).toMatchObject({
      status: "ok",
      result: {
        daemonInstanceId: daemon.descriptor.instanceId,
        resource: { workspaceName: "product", kind: "terminal" },
      },
    });
    expect(daemonResources.createWorkspacePane).toHaveBeenCalledOnce();
    const authoredCreate = vi.mocked(daemonResources.createWorkspacePane).mock.calls[0]?.[0];
    expect(authoredCreate).toMatchObject({
      expectedDaemonInstanceId: daemon.descriptor.instanceId,
      intent: { kind: "terminal", workspaceName: "product" },
    });
    expect(authoredCreate?.operationId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(JSON.stringify(authoredCreate)).not.toMatch(
      /ownerToken|sessionName|paneId|cwd|argv|env/iu,
    );

    expect(
      await handlers.get(HOST_IPC.daemonCreateWorkspacePane)?.(trustedEvent, {
        version: 1,
        id: "workspace.pane.create",
        source: { kind: "mouse" },
        args: { kind: "terminal", workspaceName: "product", cwd: "/private/project" },
      }),
    ).toMatchObject({ status: "error", error: { code: "invalid-request" } });
    expect(daemonResources.createWorkspacePane).toHaveBeenCalledOnce();

    expect(
      await handlers.get(HOST_IPC.daemonIssueTerminalAttachment)?.(trustedEvent, {
        protocolVersion: 1,
        target: { workspaceName: "product", semanticPaneId: "pane.worker" },
        viewerMode: "interactive",
        viewport: { cols: 120, rows: 40 },
      }),
    ).toMatchObject({ status: "error", error: { code: "renderer-origin-unavailable" } });
    expect(daemonResources.issueTerminalAttachment).not.toHaveBeenCalled();

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

    expect(await handlers.get(HOST_IPC.daemonRefreshConnection)?.(trustedEvent)).toMatchObject({
      outcome: "unchanged",
      daemon: { status: "connected" },
    });
    expect(stopDaemonSubscription).not.toHaveBeenCalled();
    await expect(
      handlers.get(HOST_IPC.daemonRefreshConnection)?.(trustedEvent, {
        apiBaseUrl: "http://127.0.0.1:9999",
      }),
    ).rejects.toThrow("refresh request was invalid");
    await expect(
      handlers.get(HOST_IPC.daemonRefreshConnection)?.({
        sender: { id: 8 },
        senderFrame: mainFrame,
      } as unknown as IpcMainInvokeEvent),
    ).rejects.toThrow("untrusted renderer");

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
    await expect(handlers.get(HOST_IPC.daemonRefreshConnection)?.(trustedEvent)).rejects.toThrow(
      "untrusted renderer",
    );
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
      state: () => ({
        status: "connected" as const,
        identity: {
          protocolVersion: 1,
          productVersion: "2.8.0",
          instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
          startedAt: "2026-07-21T00:00:00.000Z",
        },
      }),
      refreshConnection: vi.fn(async () => ({
        outcome: "unchanged" as const,
        daemon: {
          status: "connected" as const,
          identity: {
            protocolVersion: 1,
            productVersion: "2.8.0",
            instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
            startedAt: "2026-07-21T00:00:00.000Z",
          },
        },
      })),
      listWorkspaces: vi.fn(),
      fetchApplicationShell: vi.fn(),
      subscribe: vi.fn(async (_names, listener) => {
        publish = listener;
        return { status: "subscribed", unsubscribe: stop };
      }),
      releaseRenderer: vi.fn(),
      dispose: vi.fn(),
    } as unknown as DaemonConnectionAuthority;
    const registration = registerHostIpc({
      ipcMain,
      getWindow: () => window,
      appVersion: "test",
      platform: "darwin",
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

  it("authors terminal authority in main and discards a ticket completed after retirement", async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: (
        channel: string,
        handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
      ) => handlers.set(channel, handler),
      removeHandler: (channel: string) => handlers.delete(channel),
    } as unknown as IpcMain;
    const mainFrame = { url: "http://127.0.0.1:5173/src/main.tsx" };
    const webContents = { id: 17, mainFrame, send: vi.fn() };
    const window = {
      isDestroyed: () => false,
      isMaximized: () => false,
      isFullScreen: () => false,
      isFocused: () => true,
      webContents,
    } as unknown as BrowserWindow;
    const identity = {
      protocolVersion: 1,
      productVersion: "2.8.0",
      instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
      startedAt: "2026-07-21T00:00:00.000Z",
    };
    const descriptorFor = (request: TerminalAttachmentIssueMutationRequest, ticket: string) => ({
      protocolVersion: 1 as const,
      webSocketUrl: "ws://127.0.0.1:6060/v1/terminal/attachments/redeem",
      subprotocol: "tmux-ide-terminal.v1" as const,
      redemptionTicket: ticket,
      daemonInstanceId: identity.instanceId,
      requestId: request.requestId,
      expiresAt: Date.now() + 30_000,
      effectiveViewerMode: "interactive" as const,
    });
    const issueTerminalAttachment = vi.fn(
      async (
        request: TerminalAttachmentIssueMutationRequest,
        origin: string,
      ): Promise<TerminalAttachmentIssueResult> => {
        expect(origin).toBe("http://127.0.0.1:5173");
        return {
          status: "issued" as const,
          descriptor: descriptorFor(request, `ta1_${"A".repeat(43)}`),
        };
      },
    );
    const daemonResources = {
      state: () => ({ status: "connected" as const, identity }),
      createWorkspacePane: vi.fn(),
      issueTerminalAttachment,
      refreshConnection: vi.fn(),
      listWorkspaces: vi.fn(),
      fetchApplicationShell: vi.fn(),
      subscribe: vi.fn(),
      releaseRenderer: vi.fn(),
      dispose: vi.fn(),
    } as unknown as DaemonConnectionAuthority;
    const registration = registerHostIpc({
      ipcMain,
      getWindow: () => window,
      appVersion: "test",
      platform: "darwin",
      daemonResources,
      requestQuit: vi.fn(),
      selectProjectDirectory: async () => null,
      getTheme: () => ({ mode: "dark", highContrast: false, reducedMotion: false }),
      trustedRendererLocation: {
        kind: "development-origin",
        origin: "http://127.0.0.1:5173",
      },
    });
    const event = { sender: webContents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
    handlers.get(HOST_IPC.bootstrap)?.(event);
    const attachment = {
      protocolVersion: 1,
      target: { workspaceName: "product", semanticPaneId: "pane.worker" },
      viewerMode: "interactive",
      viewport: { cols: 120, rows: 40 },
    };

    const issued = await handlers.get(HOST_IPC.daemonIssueTerminalAttachment)?.(event, attachment);
    expect(issued).toMatchObject({
      status: "issued",
      descriptor: { daemonInstanceId: identity.instanceId },
    });
    const authored = issueTerminalAttachment.mock.calls[0]?.[0];
    expect(authored).toMatchObject({
      expectedDaemonInstanceId: identity.instanceId,
      attachment,
    });
    expect(authored?.requestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(JSON.stringify(authored)).not.toMatch(/ownerToken|authorization|rendererOrigin/iu);

    expect(
      await handlers.get(HOST_IPC.daemonIssueTerminalAttachment)?.(event, {
        ...attachment,
        ownerToken: "renderer-secret",
      }),
    ).toMatchObject({ status: "error", error: { code: "invalid-request" } });
    expect(issueTerminalAttachment).toHaveBeenCalledOnce();
    await expect(
      handlers.get(HOST_IPC.daemonIssueTerminalAttachment)?.(
        {
          sender: webContents,
          senderFrame: { url: mainFrame.url },
        } as unknown as IpcMainInvokeEvent,
        attachment,
      ),
    ).rejects.toThrow("untrusted renderer");

    let finishIssue: ((result: TerminalAttachmentIssueResult) => void) | undefined;
    issueTerminalAttachment.mockImplementationOnce(
      async () =>
        new Promise<TerminalAttachmentIssueResult>((resolve) => {
          finishIssue = resolve;
        }),
    );
    const pending = handlers.get(HOST_IPC.daemonIssueTerminalAttachment)?.(event, attachment);
    await vi.waitFor(() => expect(issueTerminalAttachment).toHaveBeenCalledTimes(2));
    const lateRequest = issueTerminalAttachment.mock.calls[1]?.[0];
    registration.releaseRenderer();
    finishIssue?.({
      status: "issued",
      descriptor: descriptorFor(lateRequest!, `ta1_${"B".repeat(43)}`),
    });
    const retired = await pending;
    expect(retired).toMatchObject({ status: "error", error: { code: "disposed" } });
    expect(JSON.stringify(retired)).not.toContain(`ta1_${"B".repeat(43)}`);
    expect(daemonResources.releaseRenderer).toHaveBeenCalledOnce();
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
