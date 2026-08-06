import { describe, expect, it, vi } from "vitest";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import type {
  AppWindowMutationRequest,
  DesktopDaemonCapabilityState,
  StartupReadinessLadder,
  PaneStreamIssueMutationRequest,
  PaneStreamIssueResult,
  TerminalAttachmentIssueMutationRequest,
  TerminalAttachmentIssueResult,
  WorkspaceOpenMutationRequest,
  WorkspacePaneCreateMutationRequest,
  WorkspacePromoteMutationRequest,
} from "@tmux-ide/contracts";
import {
  DESKTOP_PACKAGED_RENDERER_ENTRY_URL,
  DESKTOP_PACKAGED_RENDERER_ORIGIN,
  buildStartupReadinessLadder,
} from "@tmux-ide/contracts";

import type { DaemonConnectionAuthority } from "./daemon-connection-coordinator.ts";
import { BrokerPromotionFailure } from "./daemon-resource-broker.ts";
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
      mutateAppWindow: vi.fn(async (request: AppWindowMutationRequest) => ({
        operationId: request.operationId,
        daemonInstanceId: request.expectedDaemonInstanceId,
        outcome: "applied" as const,
        workspaceName: request.intent.workspaceName,
        documentRevision: request.intent.expectedDocumentRevision + 1,
      })),
      openWorkspace: vi.fn(async (request: WorkspaceOpenMutationRequest) => ({
        operationId: request.operationId,
        daemonInstanceId: request.expectedDaemonInstanceId,
        outcome: "created" as const,
        resource: {
          resourceVersion: 1 as const,
          workspaceName: "project-00112233445566778899aabbccddeeff",
          initialPaneId: "pane.workspace.00112233445566778899aabbccddeeff",
        },
      })),
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
      issuePaneStream: vi.fn(),
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
      fetchWorkspaceFiles: vi.fn(async () => ({
        status: "error",
        error: { code: "workspace-not-found", reason: "files sentinel" },
      })),
      fetchWorkspaceFilePreview: vi.fn(async () => ({
        status: "error",
        error: { code: "workspace-not-found", reason: "preview sentinel" },
      })),
      fetchWorkspaceChanges: vi.fn(async () => ({
        status: "error",
        error: { code: "workspace-not-found", reason: "changes sentinel" },
      })),
      fetchWorkspaceChangeDiff: vi.fn(async () => ({
        status: "error",
        error: { code: "workspace-not-found", reason: "diff sentinel" },
      })),
      fetchFleetCatalog: vi.fn(async () => ({
        status: "ok",
        envelope: {
          version: 1,
          daemon: {
            protocolVersion: 1,
            productVersion: "2.8.0",
            instanceId: daemon.descriptor.instanceId,
            startedAt: daemon.descriptor.startedAt,
          },
          sessions: [],
        },
      })),
      promoteWorkspace: vi.fn(async (request: WorkspacePromoteMutationRequest) => ({
        operationId: request.operationId,
        daemonInstanceId: request.expectedDaemonInstanceId,
        outcome: "promoted" as const,
        resource: { resourceVersion: 1 as const, workspaceName: "web" },
      })),
      subscribe: vi.fn(async (_names, listener) => {
        publishDaemonEvent = listener;
        return { status: "subscribed", unsubscribe: stopDaemonSubscription };
      }),
      releaseRenderer: vi.fn(),
      dispose: vi.fn(),
    } as unknown as DaemonConnectionAuthority;
    const selectProjectDirectory = vi.fn(async () => "/private/project");
    const acknowledgeOnboardingIntro = vi.fn();
    const registration = registerHostIpc({
      ipcMain,
      getWindow: () => window,
      appVersion: "test",
      platform: "darwin",
      daemonResources,

      selectProjectDirectory,
      getTheme: () => ({ mode: "dark", highContrast: false, reducedMotion: false }),
      getUpdateStatus: () => ({ phase: "idle", currentVersion: "test", availableVersion: null }),
      readOnboardingIntroAcknowledged: () => false,
      acknowledgeOnboardingIntro,
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
      onboarding: { introAcknowledged: false },
    });
    expect(handlers.get(HOST_IPC.onboardingAcknowledgeIntro)?.(trustedEvent)).toBeUndefined();
    expect(acknowledgeOnboardingIntro).toHaveBeenCalledTimes(1);
    expect(() =>
      handlers.get(HOST_IPC.onboardingAcknowledgeIntro)?.({
        sender: webContents,
        senderFrame: {},
      } as unknown as IpcMainInvokeEvent),
    ).toThrow("untrusted renderer");
    expect(() =>
      bootstrap?.({ sender: webContents, senderFrame: {} } as unknown as IpcMainInvokeEvent),
    ).toThrow("untrusted renderer");
    expect(() =>
      bootstrap?.({ sender: { id: 8 }, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent),
    ).toThrow("untrusted renderer");

    expect(
      await handlers.get(HOST_IPC.daemonRequest)?.(trustedEvent, { resource: "listWorkspaces" }),
    ).toMatchObject({
      status: "ok",
      workspaces: [{ workspaceName: "product" }],
    });
    expect(
      await handlers.get(HOST_IPC.daemonRequest)?.(trustedEvent, {
        resource: "fetchApplicationShell",
        request: {
          workspaceName: "product",
          resourceVersion: 3,
        },
      }),
    ).toMatchObject({ status: "error", error: { code: "workspace-not-found" } });
    expect(
      await handlers.get(HOST_IPC.daemonRequest)?.(trustedEvent, {
        resource: "fetchApplicationShell",
        request: {
          workspaceName: "product",
          resourceVersion: 2,
        },
      }),
    ).toMatchObject({ status: "error", error: { code: "workspace-not-found" } });
    expect(
      await handlers.get(HOST_IPC.daemonRequest)?.(trustedEvent, {
        resource: "fetchApplicationShell",
        request: {
          workspaceName: "product",
          sessionName: "raw-target",
        },
      }),
    ).toMatchObject({ status: "error", error: { code: "invalid-request" } });
    expect(daemonResources.fetchApplicationShell).toHaveBeenNthCalledWith(1, "product", 3);
    expect(daemonResources.fetchApplicationShell).toHaveBeenNthCalledWith(2, "product", 2);
    expect(daemonResources.fetchApplicationShell).toHaveBeenCalledTimes(2);

    expect(
      await handlers.get(HOST_IPC.daemonRequest)?.(trustedEvent, {
        resource: "fetchWorkspaceFiles",
        request: {
          workspaceName: "product",
          directoryId: "file.rootrootrootroot01",
        },
      }),
    ).toMatchObject({ status: "error", error: { reason: "files sentinel" } });
    expect(daemonResources.fetchWorkspaceFiles).toHaveBeenCalledWith({
      workspaceName: "product",
      directoryId: "file.rootrootrootroot01",
    });
    expect(
      await handlers.get(HOST_IPC.daemonRequest)?.(trustedEvent, {
        resource: "fetchWorkspaceFiles",
        request: { unexpected: true },
      }),
    ).toMatchObject({ status: "error", error: { code: "invalid-request" } });
    expect(daemonResources.fetchWorkspaceFiles).toHaveBeenCalledTimes(1);

    expect(
      await handlers.get(HOST_IPC.daemonRequest)?.(trustedEvent, {
        resource: "fetchWorkspaceFilePreview",
        request: {
          workspaceName: "product",
          fileId: "file.entryentryentry001",
        },
      }),
    ).toMatchObject({ status: "error", error: { reason: "preview sentinel" } });
    expect(
      await handlers.get(HOST_IPC.daemonRequest)?.(trustedEvent, {
        resource: "fetchWorkspaceChanges",
        request: {
          workspaceName: "product",
        },
      }),
    ).toMatchObject({ status: "error", error: { reason: "changes sentinel" } });
    expect(
      await handlers.get(HOST_IPC.daemonRequest)?.(trustedEvent, {
        resource: "fetchWorkspaceChangeDiff",
        request: {
          workspaceName: "product",
          changeId: "change.changechangechange01",
        },
      }),
    ).toMatchObject({ status: "error", error: { reason: "diff sentinel" } });
    expect(daemonResources.fetchWorkspaceChangeDiff).toHaveBeenCalledWith({
      workspaceName: "product",
      changeId: "change.changechangechange01",
    });

    expect(
      await handlers.get(HOST_IPC.daemonRequest)?.(trustedEvent, { resource: "fetchFleetCatalog" }),
    ).toMatchObject({
      status: "ok",
      envelope: { version: 1, sessions: [] },
    });
    expect(daemonResources.fetchFleetCatalog).toHaveBeenCalledTimes(1);
    expect(
      await handlers.get(HOST_IPC.daemonRequest)?.(trustedEvent, {
        resource: "promoteWorkspace",
        request: {
          sessionId: "session.aaaaaaaaaaaaaaaa",
        },
      }),
    ).toMatchObject({ status: "ok", result: { outcome: "promoted" } });
    // The renderer supplies only the opaque session id; main authors the envelope.
    const authoredPromote = vi.mocked(daemonResources.promoteWorkspace).mock.calls[0]?.[0];
    expect(authoredPromote?.intent).toEqual({ sessionId: "session.aaaaaaaaaaaaaaaa" });
    expect(authoredPromote?.expectedDaemonInstanceId).toBe(daemon.descriptor.instanceId);
    expect(
      await handlers.get(HOST_IPC.daemonRequest)?.(trustedEvent, {
        resource: "promoteWorkspace",
        request: { sessionId: "$3" },
      }),
    ).toMatchObject({ status: "error", error: { code: "invalid-request" } });

    // A typed daemon verdict is forwarded to the renderer verbatim (specific
    // reason), not flattened into the generic request-failed transport line.
    vi.mocked(daemonResources.promoteWorkspace).mockRejectedValueOnce(
      new BrokerPromotionFailure({
        kind: "promotion",
        code: "promotion_verification_failed",
        reason: "project_directory_unavailable",
      }),
    );
    expect(
      await handlers.get(HOST_IPC.daemonRequest)?.(trustedEvent, {
        resource: "promoteWorkspace",
        request: {
          sessionId: "session.aaaaaaaaaaaaaaaa",
        },
      }),
    ).toEqual({
      status: "error",
      error: {
        kind: "promotion",
        code: "promotion_verification_failed",
        reason: "project_directory_unavailable",
      },
    });

    // A plain transport rejection still collapses to the generic line.
    vi.mocked(daemonResources.promoteWorkspace).mockRejectedValueOnce(new Error("socket reset"));
    expect(
      await handlers.get(HOST_IPC.daemonRequest)?.(trustedEvent, {
        resource: "promoteWorkspace",
        request: {
          sessionId: "session.aaaaaaaaaaaaaaaa",
        },
      }),
    ).toMatchObject({ status: "error", error: { code: "request-failed" } });

    const created = await handlers.get(HOST_IPC.daemonRequest)?.(trustedEvent, {
      resource: "createWorkspacePane",
      request: {
        version: 1,
        id: "workspace.pane.create",
        source: { kind: "mouse", surface: "create-pane-dialog" },
        args: { kind: "terminal", workspaceName: "product" },
      },
    });
    expect(created).toMatchObject({
      status: "ok",
      result: {
        daemonInstanceId: daemon.descriptor.instanceId,
        resource: { workspaceName: "product", kind: "terminal" },
      },
    });
    expect(daemonResources.createWorkspacePane).toHaveBeenCalledOnce();
    const mutated = await handlers.get(HOST_IPC.daemonRequest)?.(trustedEvent, {
      resource: "mutateAppWindow",
      request: {
        workspaceName: "product",
        expectedDocumentRevision: 4,
        command: { type: "window.focus", windowId: null },
      },
    });
    expect(mutated).toMatchObject({
      status: "ok",
      result: { workspaceName: "product", documentRevision: 5 },
    });
    expect(daemonResources.mutateAppWindow).toHaveBeenCalledOnce();
    expect(vi.mocked(daemonResources.mutateAppWindow).mock.calls[0]?.[0]).toMatchObject({
      expectedDaemonInstanceId: daemon.descriptor.instanceId,
      intent: { workspaceName: "product", expectedDocumentRevision: 4 },
    });
    const authoredCreate = vi.mocked(daemonResources.createWorkspacePane).mock.calls[0]?.[0];
    expect(authoredCreate).toMatchObject({
      expectedDaemonInstanceId: daemon.descriptor.instanceId,
      intent: { kind: "terminal", workspaceName: "product" },
    });
    expect(authoredCreate?.operationId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(JSON.stringify(authoredCreate)).not.toMatch(
      /ownerToken|sessionName|paneId|cwd|argv|env/iu,
    );

    const opened = await handlers.get(HOST_IPC.workspaceOpenProjectDirectory)?.(trustedEvent);
    expect(opened).toMatchObject({
      status: "ok",
      result: {
        daemonInstanceId: daemon.descriptor.instanceId,
        resource: { workspaceName: "project-00112233445566778899aabbccddeeff" },
      },
    });
    expect(selectProjectDirectory).toHaveBeenCalledWith(window);
    expect(daemonResources.openWorkspace).toHaveBeenCalledOnce();
    const authoredOpen = vi.mocked(daemonResources.openWorkspace).mock.calls[0]?.[0];
    expect(authoredOpen).toMatchObject({
      expectedDaemonInstanceId: daemon.descriptor.instanceId,
      intent: { projectDir: "/private/project" },
    });
    expect(authoredOpen?.operationId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(JSON.stringify(opened)).not.toMatch(/private\/project|projectDir|sessionName/iu);

    await expect(
      handlers.get(HOST_IPC.workspaceOpenProjectDirectory)?.(trustedEvent, {
        projectDir: "/renderer/substitution",
      }),
    ).resolves.toMatchObject({ status: "error", error: { code: "invalid-request" } });
    expect(selectProjectDirectory).toHaveBeenCalledOnce();
    expect(daemonResources.openWorkspace).toHaveBeenCalledOnce();

    await expect(
      handlers.get(HOST_IPC.workspaceOpenProjectDirectory)?.({
        sender: { id: 8 },
        senderFrame: mainFrame,
      } as unknown as IpcMainInvokeEvent),
    ).rejects.toThrow("untrusted renderer");
    expect(selectProjectDirectory).toHaveBeenCalledOnce();

    vi.mocked(daemonResources.openWorkspace).mockImplementationOnce(async (request) => ({
      operationId: request.operationId,
      daemonInstanceId: "00000000-0000-4000-8000-000000000099",
      outcome: "created" as const,
      resource: {
        resourceVersion: 1 as const,
        workspaceName: "project-00112233445566778899aabbccddeeff",
        initialPaneId: "pane.workspace.00112233445566778899aabbccddeeff",
      },
    }));
    await expect(
      handlers.get(HOST_IPC.workspaceOpenProjectDirectory)?.(trustedEvent),
    ).resolves.toMatchObject({
      status: "error",
      error: { code: "daemon-identity-mismatch" },
    });

    expect(
      await handlers.get(HOST_IPC.daemonRequest)?.(trustedEvent, {
        resource: "createWorkspacePane",
        request: {
          version: 1,
          id: "workspace.pane.create",
          source: { kind: "mouse" },
          args: { kind: "terminal", workspaceName: "product", cwd: "/private/project" },
        },
      }),
    ).toMatchObject({ status: "error", error: { code: "invalid-request" } });
    expect(daemonResources.createWorkspacePane).toHaveBeenCalledOnce();

    expect(
      await handlers.get(HOST_IPC.daemonRequest)?.(trustedEvent, {
        resource: "issueTerminalAttachment",
        request: {
          protocolVersion: 1,
          target: { workspaceName: "product", semanticPaneId: "pane.worker" },
          viewerMode: "interactive",
          geometryOwnership: "passive",
          viewport: { cols: 120, rows: 40 },
        },
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

    expect(
      await handlers.get(HOST_IPC.daemonRequest)?.(trustedEvent, { resource: "refreshConnection" }),
    ).toMatchObject({
      outcome: "unchanged",
      daemon: { status: "connected" },
    });
    expect(stopDaemonSubscription).not.toHaveBeenCalled();
    // A renderer cannot smuggle a payload into a resource that takes none: the
    // variant is strict, so the request is refused before the coordinator runs.
    const refreshesBefore = vi.mocked(daemonResources.refreshConnection).mock.calls.length;
    expect(
      await handlers.get(HOST_IPC.daemonRequest)?.(trustedEvent, {
        resource: "refreshConnection",
        request: {
          apiBaseUrl: "http://127.0.0.1:9999",
        },
      }),
    ).toMatchObject({ status: "error", error: { code: "invalid-request" } });
    expect(vi.mocked(daemonResources.refreshConnection).mock.calls.length).toBe(refreshesBefore);
    await expect(
      handlers.get(HOST_IPC.daemonRequest)?.(
        {
          sender: { id: 8 },
          senderFrame: mainFrame,
        } as unknown as IpcMainInvokeEvent,
        { resource: "refreshConnection" },
      ),
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
    const pendingList = handlers.get(HOST_IPC.daemonRequest)?.(trustedEvent, {
      resource: "listWorkspaces",
    });
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
    await expect(
      handlers.get(HOST_IPC.daemonRequest)?.(trustedEvent, { resource: "refreshConnection" }),
    ).rejects.toThrow("untrusted renderer");
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
    const oldGenerationList = handlers.get(HOST_IPC.daemonRequest)?.(trustedEvent, {
      resource: "listWorkspaces",
    });
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

      selectProjectDirectory: async () => null,
      getTheme: () => ({ mode: "dark", highContrast: false, reducedMotion: false }),
      getUpdateStatus: () => ({ phase: "idle", currentVersion: "test", availableVersion: null }),
      readOnboardingIntroAcknowledged: () => false,
      acknowledgeOnboardingIntro: () => undefined,
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

  it.each([
    {
      label: "development renderer",
      frameUrl: "http://127.0.0.1:5173/src/main.tsx",
      expectedOrigin: "http://127.0.0.1:5173",
      trustedRendererLocation: {
        kind: "development-origin" as const,
        origin: "http://127.0.0.1:5173",
      },
    },
    {
      label: "packaged renderer",
      frameUrl: DESKTOP_PACKAGED_RENDERER_ENTRY_URL,
      expectedOrigin: DESKTOP_PACKAGED_RENDERER_ORIGIN,
      trustedRendererLocation: {
        kind: "packaged-origin" as const,
        origin: DESKTOP_PACKAGED_RENDERER_ORIGIN,
        entryUrl: DESKTOP_PACKAGED_RENDERER_ENTRY_URL,
      },
    },
  ])(
    "authors terminal authority for the $label and discards a ticket completed after retirement",
    async ({ frameUrl, expectedOrigin, trustedRendererLocation }) => {
      const handlers = new Map<
        string,
        (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
      >();
      const ipcMain = {
        handle: (
          channel: string,
          handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
        ) => handlers.set(channel, handler),
        removeHandler: (channel: string) => handlers.delete(channel),
      } as unknown as IpcMain;
      const mainFrame = { url: frameUrl };
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
        effectiveGeometryOwnership: "passive" as const,
      });
      const issueTerminalAttachment = vi.fn(
        async (
          request: TerminalAttachmentIssueMutationRequest,
          origin: string,
        ): Promise<TerminalAttachmentIssueResult> => {
          expect(origin).toBe(expectedOrigin);
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

        selectProjectDirectory: async () => null,
        getTheme: () => ({ mode: "dark", highContrast: false, reducedMotion: false }),
        getUpdateStatus: () => ({ phase: "idle", currentVersion: "test", availableVersion: null }),
        readOnboardingIntroAcknowledged: () => false,
        acknowledgeOnboardingIntro: () => undefined,
        trustedRendererLocation,
      });
      const event = {
        sender: webContents,
        senderFrame: mainFrame,
      } as unknown as IpcMainInvokeEvent;
      handlers.get(HOST_IPC.bootstrap)?.(event);
      const attachment = {
        protocolVersion: 1,
        target: { workspaceName: "product", semanticPaneId: "pane.worker" },
        viewerMode: "interactive",
        geometryOwnership: "passive",
        viewport: { cols: 120, rows: 40 },
      };

      const issued = await handlers.get(HOST_IPC.daemonRequest)?.(event, {
        resource: "issueTerminalAttachment",
        request: attachment,
      });
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
        await handlers.get(HOST_IPC.daemonRequest)?.(event, {
          resource: "issueTerminalAttachment",
          request: {
            ...attachment,
            ownerToken: "renderer-secret",
          },
        }),
      ).toMatchObject({ status: "error", error: { code: "invalid-request" } });
      expect(issueTerminalAttachment).toHaveBeenCalledOnce();
      await expect(
        handlers.get(HOST_IPC.daemonRequest)?.(
          {
            sender: webContents,
            senderFrame: { url: mainFrame.url },
          } as unknown as IpcMainInvokeEvent,
          { resource: "issueTerminalAttachment", request: attachment },
        ),
      ).rejects.toThrow("untrusted renderer");

      let finishIssue: ((result: TerminalAttachmentIssueResult) => void) | undefined;
      issueTerminalAttachment.mockImplementationOnce(
        async () =>
          new Promise<TerminalAttachmentIssueResult>((resolve) => {
            finishIssue = resolve;
          }),
      );
      const pending = handlers.get(HOST_IPC.daemonRequest)?.(event, {
        resource: "issueTerminalAttachment",
        request: attachment,
      });
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
    },
  );

  it("accepts a configured development origin but not a lookalike or foreign origin", () => {
    const trusted = { kind: "development-origin", origin: "http://127.0.0.1:5173" } as const;
    expect(rendererLocationIsTrusted("http://127.0.0.1:5173/src/main.tsx", trusted)).toBe(true);
    expect(rendererLocationIsTrusted("http://127.0.0.1:5173.evil.invalid/", trusted)).toBe(false);
    expect(rendererLocationIsTrusted("http://127.0.0.1:5174/", trusted)).toBe(false);
    expect(rendererLocationIsTrusted("not a URL", trusted)).toBe(false);
  });

  it("accepts only the exact packaged application entry URL", () => {
    const trusted = {
      kind: "packaged-origin",
      origin: DESKTOP_PACKAGED_RENDERER_ORIGIN,
      entryUrl: DESKTOP_PACKAGED_RENDERER_ENTRY_URL,
    } as const;
    expect(rendererLocationIsTrusted(DESKTOP_PACKAGED_RENDERER_ENTRY_URL, trusted)).toBe(true);
    expect(rendererLocationIsTrusted("tmux-ide://app/", trusted)).toBe(false);
    expect(rendererLocationIsTrusted("tmux-ide://app.evil.invalid/index.html", trusted)).toBe(
      false,
    );
    expect(rendererLocationIsTrusted("file:///trusted/renderer/index.html", trusted)).toBe(false);
  });
});

describe("host IPC pane-stream issuance (m43 card 3)", () => {
  const PANES = ["pane.workspace.a1", "pane.workspace.b2"];

  function paneStreamHarness(options: {
    readonly frameUrl: string;
    readonly trustedRendererLocation: Parameters<
      typeof registerHostIpc
    >[0]["trustedRendererLocation"];
    readonly issuePaneStream: ReturnType<typeof vi.fn>;
    readonly daemonState?: DesktopDaemonCapabilityState;
  }) {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: (
        channel: string,
        handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
      ) => handlers.set(channel, handler),
      removeHandler: (channel: string) => handlers.delete(channel),
    } as unknown as IpcMain;
    const mainFrame = { url: options.frameUrl };
    const webContents = { id: 23, mainFrame, send: vi.fn() };
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
    const daemonResources = {
      state: () => options.daemonState ?? { status: "connected" as const, identity },
      issuePaneStream: options.issuePaneStream,
      releaseRenderer: vi.fn(),
      dispose: vi.fn(),
    } as unknown as DaemonConnectionAuthority;
    const registration = registerHostIpc({
      ipcMain,
      getWindow: () => window,
      appVersion: "test",
      platform: "darwin",
      daemonResources,

      selectProjectDirectory: async () => null,
      getTheme: () => ({ mode: "dark", highContrast: false, reducedMotion: false }),
      getUpdateStatus: () => ({ phase: "idle", currentVersion: "test", availableVersion: null }),
      readOnboardingIntroAcknowledged: () => false,
      acknowledgeOnboardingIntro: () => undefined,
      trustedRendererLocation: options.trustedRendererLocation,
    });
    const event = {
      sender: webContents,
      senderFrame: mainFrame,
    } as unknown as IpcMainInvokeEvent;
    handlers.get(HOST_IPC.bootstrap)?.(event);
    return { handlers, event, identity, registration, webContents, mainFrame, daemonResources };
  }

  function streamDescriptor(request: PaneStreamIssueMutationRequest, instanceId: string) {
    return {
      protocolVersion: 1 as const,
      webSocketUrl: "ws://127.0.0.1:6060/v1/terminal/pane-streams/redeem",
      subprotocol: "tmux-ide-pane-stream.v1" as const,
      redemptionTicket: `ps1_${"A".repeat(43)}`,
      daemonInstanceId: instanceId,
      requestId: request.requestId,
      expiresAt: Date.now() + 15_000,
      panes: [...request.stream.panes],
      effectiveViewerMode: request.stream.viewerMode,
    };
  }

  it("authors the private envelope in main and refuses renderer-authored identity", async () => {
    const issuePaneStream = vi.fn(
      async (
        request: PaneStreamIssueMutationRequest,
        origin: string,
      ): Promise<PaneStreamIssueResult> => {
        expect(origin).toBe("http://127.0.0.1:5173");
        return {
          status: "issued",
          descriptor: streamDescriptor(request, request.expectedDaemonInstanceId),
        };
      },
    );
    const h = paneStreamHarness({
      frameUrl: "http://127.0.0.1:5173/src/main.tsx",
      trustedRendererLocation: { kind: "development-origin", origin: "http://127.0.0.1:5173" },
      issuePaneStream,
    });
    const stream = {
      protocolVersion: 1,
      workspaceName: "product",
      panes: PANES,
      viewerMode: "read-only",
    };
    const issued = await h.handlers.get(HOST_IPC.daemonRequest)?.(h.event, {
      resource: "issuePaneStream",
      request: stream,
    });
    expect(issued).toMatchObject({
      status: "issued",
      descriptor: { daemonInstanceId: h.identity.instanceId, panes: PANES },
    });
    const authored = issuePaneStream.mock.calls[0]?.[0];
    expect(authored).toMatchObject({
      expectedDaemonInstanceId: h.identity.instanceId,
      stream,
    });
    expect(authored?.requestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(JSON.stringify(authored)).not.toMatch(/ownerToken|authorization|rendererOrigin/iu);

    // A renderer-smuggled envelope field is an invalid request, never forwarded.
    expect(
      await h.handlers.get(HOST_IPC.daemonRequest)?.(h.event, {
        resource: "issuePaneStream",
        request: {
          ...stream,
          expectedDaemonInstanceId: "spoofed",
        },
      }),
    ).toMatchObject({ status: "error", error: { code: "invalid-request" } });
    expect(issuePaneStream).toHaveBeenCalledOnce();
    h.registration.dispose();
  });

  it("reports a degraded daemon as degraded, not merely unavailable", async () => {
    const issuePaneStream = vi.fn();
    const h = paneStreamHarness({
      frameUrl: "http://127.0.0.1:5173/src/main.tsx",
      trustedRendererLocation: { kind: "development-origin", origin: "http://127.0.0.1:5173" },
      issuePaneStream,
      daemonState: {
        status: "degraded",
        code: "identity-mismatch",
        reason: "The canonical daemon record names another instance.",
      },
    });
    expect(
      await h.handlers.get(HOST_IPC.daemonRequest)?.(h.event, {
        resource: "issuePaneStream",
        request: {
          protocolVersion: 1,
          workspaceName: "product",
          panes: PANES,
          viewerMode: "read-only",
        },
      }),
    ).toMatchObject({ status: "error", error: { code: "daemon-degraded" } });
    expect(issuePaneStream).not.toHaveBeenCalled();
  });

  it("rejects an untrusted or origin-less renderer before touching the broker", async () => {
    const issuePaneStream = vi.fn();
    const h = paneStreamHarness({
      frameUrl: "file:///trusted/renderer/index.html",
      trustedRendererLocation: { kind: "packaged-url", url: "file:///trusted/renderer/index.html" },
      issuePaneStream,
    });
    // packaged-url has no canonical Origin: pane streams are honestly unavailable.
    expect(
      await h.handlers.get(HOST_IPC.daemonRequest)?.(h.event, {
        resource: "issuePaneStream",
        request: {
          protocolVersion: 1,
          workspaceName: "product",
          panes: PANES,
          viewerMode: "read-only",
        },
      }),
    ).toMatchObject({ status: "error", error: { code: "renderer-origin-unavailable" } });
    expect(issuePaneStream).not.toHaveBeenCalled();

    await expect(
      h.handlers.get(HOST_IPC.daemonRequest)?.(
        {
          sender: h.webContents,
          senderFrame: { url: h.mainFrame.url },
        } as unknown as IpcMainInvokeEvent,
        {
          resource: "issuePaneStream",
          request: {
            protocolVersion: 1,
            workspaceName: "product",
            panes: PANES,
            viewerMode: "read-only",
          },
        },
      ),
    ).rejects.toThrow("untrusted renderer");
    h.registration.dispose();
  });

  it("discards a one-use stream ticket completed after renderer release", async () => {
    let finishIssue: ((result: PaneStreamIssueResult) => void) | undefined;
    let issued: PaneStreamIssueMutationRequest | undefined;
    const issuePaneStream = vi.fn(
      async (authored: PaneStreamIssueMutationRequest): Promise<PaneStreamIssueResult> => {
        issued = authored;
        return new Promise<PaneStreamIssueResult>((resolve) => {
          finishIssue = resolve;
        });
      },
    );
    const h = paneStreamHarness({
      frameUrl: "http://127.0.0.1:5173/src/main.tsx",
      trustedRendererLocation: { kind: "development-origin", origin: "http://127.0.0.1:5173" },
      issuePaneStream,
    });
    const pending = h.handlers.get(HOST_IPC.daemonRequest)?.(h.event, {
      resource: "issuePaneStream",
      request: {
        protocolVersion: 1,
        workspaceName: "product",
        panes: PANES,
        viewerMode: "read-only",
      },
    });
    await vi.waitFor(() => expect(issuePaneStream).toHaveBeenCalledOnce());
    const request = issued as PaneStreamIssueMutationRequest;
    h.registration.releaseRenderer();
    finishIssue?.({
      status: "issued",
      descriptor: {
        ...streamDescriptor(request, h.identity.instanceId),
        redemptionTicket: `ps1_${"C".repeat(43)}`,
      },
    });
    const retired = await pending;
    expect(retired).toMatchObject({ status: "error", error: { code: "disposed" } });
    expect(JSON.stringify(retired)).not.toContain(`ps1_${"C".repeat(43)}`);
    h.registration.dispose();
  });
});

describe("host IPC single daemon request channel (m45.3)", () => {
  const IDENTITY = {
    protocolVersion: 1,
    productVersion: "2.8.0",
    instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
    startedAt: "2026-07-21T00:00:00.000Z",
  };

  function harness(
    options: {
      readonly readStartupReadiness?: () => Promise<StartupReadinessLadder | null>;
      readonly daemonOverrides?: Partial<Record<string, unknown>>;
    } = {},
  ) {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: (
        channel: string,
        handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
      ) => handlers.set(channel, handler),
      removeHandler: (channel: string) => handlers.delete(channel),
    } as unknown as IpcMain;
    const mainFrame = { url: "file:///trusted/renderer/index.html" };
    const webContents = { id: 31, mainFrame, send: vi.fn() };
    const window = {
      isDestroyed: () => false,
      isMaximized: () => false,
      isFullScreen: () => false,
      isFocused: () => true,
      webContents,
    } as unknown as BrowserWindow;
    const listWorkspaces = vi.fn(async () => ({
      status: "ok" as const,
      daemon: IDENTITY,
      workspaces: [{ workspaceName: "product" }],
    }));
    const issuePaneStream = vi.fn();
    const daemonResources = {
      state: () => ({ status: "connected" as const, identity: IDENTITY }),
      listWorkspaces,
      issuePaneStream,
      releaseRenderer: vi.fn(),
      dispose: vi.fn(),
      ...options.daemonOverrides,
    } as unknown as DaemonConnectionAuthority;
    const registration = registerHostIpc({
      ipcMain,
      getWindow: () => window,
      appVersion: "test",
      platform: "darwin",
      daemonResources,
      ...(options.readStartupReadiness
        ? { readStartupReadiness: options.readStartupReadiness }
        : {}),
      selectProjectDirectory: async () => null,
      getTheme: () => ({ mode: "dark", highContrast: false, reducedMotion: false }),
      getUpdateStatus: () => ({ phase: "idle", currentVersion: "test", availableVersion: null }),
      readOnboardingIntroAcknowledged: () => false,
      acknowledgeOnboardingIntro: () => undefined,
      trustedRendererLocation: {
        kind: "packaged-url" as const,
        url: "file:///trusted/renderer/index.html",
      },
    });
    const event = { sender: webContents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
    handlers.get(HOST_IPC.bootstrap)?.(event);
    const request = (value: unknown) => handlers.get(HOST_IPC.daemonRequest)?.(event, value);
    return { handlers, event, request, registration, listWorkspaces, mainFrame, webContents };
  }

  it("serves every resource over one channel and registers no per-resource handler", () => {
    const h = harness();
    expect([...h.handlers.keys()].filter((channel) => channel.includes("/daemon/")).sort()).toEqual(
      [
        HOST_IPC.daemonEvent,
        HOST_IPC.daemonRequest,
        HOST_IPC.daemonSubscribe,
        HOST_IPC.daemonUnsubscribe,
      ]
        .filter((channel) => channel !== HOST_IPC.daemonEvent)
        .sort(),
    );
    h.registration.dispose();
  });

  it("refuses an unnamed or unknown resource outright", async () => {
    const h = harness();
    for (const value of [undefined, null, "listWorkspaces", {}, { resource: "readEverything" }]) {
      await expect(async () => await h.request(value)).rejects.toThrow(
        /unknown resource|request was invalid/u,
      );
    }
    expect(h.listWorkspaces).not.toHaveBeenCalled();
    h.registration.dispose();
  });

  it("refuses a known resource with an unreadable payload in that resource's vocabulary", async () => {
    const h = harness();
    expect(
      await h.request({ resource: "fetchWorkspaceChangeDiff", request: { workspaceName: "p" } }),
    ).toMatchObject({ status: "error", error: { code: "invalid-request" } });
    // The lease issues answer in the issue vocabulary, which carries `retryable`.
    expect(
      await h.request({ resource: "issuePaneStream", request: { workspaceName: "p" } }),
    ).toMatchObject({
      status: "error",
      error: { code: "invalid-request", retryable: expect.any(Boolean) },
    });
    expect(await h.request({ resource: "issueTerminalAttachment", request: {} })).toMatchObject({
      status: "error",
      error: { code: "invalid-request", retryable: expect.any(Boolean) },
    });
    h.registration.dispose();
  });

  it("keeps the renderer-generation authority check exactly as strict", async () => {
    const h = harness();
    await expect(handlerFor(h, { sender: { id: 99 }, senderFrame: h.mainFrame })).rejects.toThrow(
      "untrusted renderer",
    );
    await expect(handlerFor(h, { sender: h.webContents, senderFrame: {} })).rejects.toThrow(
      "untrusted renderer",
    );
    // A renderer released mid-flight loses authority for the answer as well.
    let finishList: (() => void) | undefined;
    h.listWorkspaces.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          finishList = () =>
            resolve({ status: "ok", daemon: IDENTITY, workspaces: [{ workspaceName: "product" }] });
        }),
    );
    const pending = h.request({ resource: "listWorkspaces" });
    h.registration.releaseRenderer();
    finishList?.();
    await expect(pending).rejects.toThrow("untrusted renderer generation");
    h.registration.dispose();
  });

  function handlerFor(
    h: ReturnType<typeof harness>,
    event: { sender: unknown; senderFrame: unknown },
  ) {
    return Promise.resolve().then(() =>
      h.handlers.get(HOST_IPC.daemonRequest)?.(event as unknown as IpcMainInvokeEvent, {
        resource: "listWorkspaces",
      }),
    );
  }

  it("serves the daemon's own readiness ladder, and reports honestly when it has none", async () => {
    const ladder = buildStartupReadinessLadder(
      [
        { status: "satisfied" },
        {
          status: "stuck",
          reason: { vocabulary: "startup-readiness", code: "owner-capability-unavailable" },
        },
      ],
      "2026-08-05T00:00:00.000Z",
    );
    const served = harness({ readStartupReadiness: async () => ladder });
    expect(await served.request({ resource: "startupReadiness" })).toMatchObject({
      status: "ok",
      ladder: { blockedAt: "credential-held" },
    });
    served.registration.dispose();

    const empty = harness({ readStartupReadiness: async () => null });
    expect(await empty.request({ resource: "startupReadiness" })).toMatchObject({
      status: "error",
    });
    empty.registration.dispose();

    // A probe that throws is a missing diagnostic, never a thrown request.
    const broken = harness({
      readStartupReadiness: async () => {
        throw new Error("probe exploded");
      },
    });
    expect(await broken.request({ resource: "startupReadiness" })).toMatchObject({
      status: "error",
    });
    broken.registration.dispose();
  });
});
