import { contextBridge, ipcRenderer } from "electron";
import {
  AppWindowMutationArgumentsSchemaZ,
  AppWindowMutationHostResultSchemaZ,
  DESKTOP_HOST_API_VERSION,
  DesktopDaemonEventSubscriptionRequestSchemaZ,
  DesktopDaemonCapabilitiesResultSchemaZ,
  DesktopDaemonEventWireEnvelopeSchemaZ,
  DesktopDaemonFetchApplicationShellRequestSchemaZ,
  DesktopDaemonFetchApplicationShellResultSchemaZ,
  DesktopDaemonFetchWorkspaceChangeDiffRequestSchemaZ,
  DesktopDaemonFetchWorkspaceChangeDiffResultSchemaZ,
  DesktopDaemonFetchWorkspaceChangesRequestSchemaZ,
  DesktopDaemonFetchWorkspaceChangesResultSchemaZ,
  DesktopDaemonFetchWorkspaceFilePreviewRequestSchemaZ,
  DesktopDaemonFetchWorkspaceFilePreviewResultSchemaZ,
  DesktopDaemonFetchWorkspaceFilesRequestSchemaZ,
  DesktopDaemonFetchWorkspaceFilesResultSchemaZ,
  DesktopDaemonListWorkspacesResultSchemaZ,
  DesktopDaemonRefreshConnectionResultSchemaZ,
  DesktopDaemonSubscribeWireResultSchemaZ,
  DesktopHostBootstrapSchemaZ,
  DesktopMenuResultSchemaZ,
  DesktopThemeStateSchemaZ,
  DesktopUpdateStatusSchemaZ,
  DesktopWindowStateSchemaZ,
  TerminalAttachRequestSchemaZ,
  TerminalAttachmentIssueResultSchemaZ,
  WorkspacePaneCreateHostResultSchemaZ,
  WorkspacePaneCreateInvocationSchemaZ,
  WorkspaceOpenHostResultSchemaZ,
  type DesktopDaemonEvent,
  type DesktopDaemonEventSubscriptionRequest,
  type DesktopDaemonFetchApplicationShellRequest,
  type DesktopDaemonFetchWorkspaceChangeDiffRequest,
  type DesktopDaemonFetchWorkspaceChangesRequest,
  type DesktopDaemonFetchWorkspaceFilePreviewRequest,
  type DesktopDaemonFetchWorkspaceFilesRequest,
  type DesktopThemeState,
  type DesktopUpdateStatus,
  type DesktopWindowState,
  type HostCapabilities,
  type TerminalAttachRequest,
  type WorkspacePaneCreateInvocation,
  type AppWindowMutationArguments,
} from "@tmux-ide/contracts";

import { HOST_IPC } from "./ipc-channels.ts";

const daemonListeners = new Map<string, (event: DesktopDaemonEvent) => void>();
const earlyDaemonEvents = new Map<string, DesktopDaemonEvent[]>();

function deliverDaemonEvent(
  listener: (event: DesktopDaemonEvent) => void,
  event: DesktopDaemonEvent,
): void {
  try {
    listener(event);
  } catch {
    // One application listener cannot break the preload event bridge.
  }
}

ipcRenderer.on(HOST_IPC.daemonEvent, (_event, value: unknown) => {
  const envelope = DesktopDaemonEventWireEnvelopeSchemaZ.parse(value);
  const listener = daemonListeners.get(envelope.subscriptionId);
  if (listener) {
    deliverDaemonEvent(listener, envelope.event);
    return;
  }
  // The socket can open while the subscribe invoke response is in flight.
  // Keep only a tiny bounded handoff buffer for that single IPC race.
  if (earlyDaemonEvents.size >= 64 && !earlyDaemonEvents.has(envelope.subscriptionId)) return;
  const queued = earlyDaemonEvents.get(envelope.subscriptionId) ?? [];
  if (queued.length < 8) queued.push(envelope.event);
  earlyDaemonEvents.set(envelope.subscriptionId, queued);
});

function onValidatedEvent<T>(
  channel: string,
  parse: (value: unknown) => T,
  listener: (value: T) => void,
): () => void {
  const receive = (_event: Electron.IpcRendererEvent, value: unknown) => listener(parse(value));
  ipcRenderer.on(channel, receive);
  return () => ipcRenderer.removeListener(channel, receive);
}

const capabilities: HostCapabilities = Object.freeze({
  apiVersion: DESKTOP_HOST_API_VERSION,
  bootstrap: async () =>
    DesktopHostBootstrapSchemaZ.parse(await ipcRenderer.invoke(HOST_IPC.bootstrap)),
  lifecycle: Object.freeze({
    requestQuit: async () => {
      await ipcRenderer.invoke(HOST_IPC.lifecycleQuit);
    },
  }),
  window: Object.freeze({
    getState: async () =>
      DesktopWindowStateSchemaZ.parse(await ipcRenderer.invoke(HOST_IPC.windowGetState)),
    minimize: async () =>
      DesktopWindowStateSchemaZ.parse(await ipcRenderer.invoke(HOST_IPC.windowMinimize)),
    toggleMaximized: async () =>
      DesktopWindowStateSchemaZ.parse(await ipcRenderer.invoke(HOST_IPC.windowToggleMaximized)),
    close: async () => {
      await ipcRenderer.invoke(HOST_IPC.windowClose);
    },
    onStateChanged: (listener: (state: DesktopWindowState) => void) =>
      onValidatedEvent(
        HOST_IPC.windowStateChanged,
        (value) => DesktopWindowStateSchemaZ.parse(value),
        listener,
      ),
  }),
  menu: Object.freeze({
    showApplicationMenu: async () =>
      DesktopMenuResultSchemaZ.parse(await ipcRenderer.invoke(HOST_IPC.menuShowApplication)),
  }),
  workspace: Object.freeze({
    openProjectDirectory: async () =>
      WorkspaceOpenHostResultSchemaZ.nullable().parse(
        await ipcRenderer.invoke(HOST_IPC.workspaceOpenProjectDirectory),
      ),
  }),
  theme: Object.freeze({
    getState: async () =>
      DesktopThemeStateSchemaZ.parse(await ipcRenderer.invoke(HOST_IPC.themeGetState)),
    onChanged: (listener: (state: DesktopThemeState) => void) =>
      onValidatedEvent(
        HOST_IPC.themeChanged,
        (value) => DesktopThemeStateSchemaZ.parse(value),
        listener,
      ),
  }),
  update: Object.freeze({
    getStatus: async () =>
      DesktopUpdateStatusSchemaZ.parse(await ipcRenderer.invoke(HOST_IPC.updateGetStatus)),
    onStatusChanged: (listener: (status: DesktopUpdateStatus) => void) =>
      onValidatedEvent(
        HOST_IPC.updateStatusChanged,
        (value) => DesktopUpdateStatusSchemaZ.parse(value),
        listener,
      ),
  }),
  daemon: Object.freeze({
    capabilities: async () =>
      DesktopDaemonCapabilitiesResultSchemaZ.parse(
        await ipcRenderer.invoke(HOST_IPC.daemonCapabilities),
      ),
    mutateAppWindow: async (intent: AppWindowMutationArguments) => {
      const parsed = AppWindowMutationArgumentsSchemaZ.parse(intent);
      return AppWindowMutationHostResultSchemaZ.parse(
        await ipcRenderer.invoke(HOST_IPC.daemonMutateAppWindow, parsed),
      );
    },
    createWorkspacePane: async (invocation: WorkspacePaneCreateInvocation) => {
      const parsed = WorkspacePaneCreateInvocationSchemaZ.parse(invocation);
      return WorkspacePaneCreateHostResultSchemaZ.parse(
        await ipcRenderer.invoke(HOST_IPC.daemonCreateWorkspacePane, parsed),
      );
    },
    issueTerminalAttachment: async (request: TerminalAttachRequest) => {
      const parsed = TerminalAttachRequestSchemaZ.parse(request);
      return TerminalAttachmentIssueResultSchemaZ.parse(
        await ipcRenderer.invoke(HOST_IPC.daemonIssueTerminalAttachment, parsed),
      );
    },
    refreshConnection: async () =>
      DesktopDaemonRefreshConnectionResultSchemaZ.parse(
        await ipcRenderer.invoke(HOST_IPC.daemonRefreshConnection),
      ),
    listWorkspaces: async () =>
      DesktopDaemonListWorkspacesResultSchemaZ.parse(
        await ipcRenderer.invoke(HOST_IPC.daemonListWorkspaces),
      ),
    fetchApplicationShell: async (request: DesktopDaemonFetchApplicationShellRequest) => {
      const parsed = DesktopDaemonFetchApplicationShellRequestSchemaZ.parse(request);
      return DesktopDaemonFetchApplicationShellResultSchemaZ.parse(
        await ipcRenderer.invoke(HOST_IPC.daemonFetchApplicationShell, parsed),
      );
    },
    fetchWorkspaceFiles: async (request: DesktopDaemonFetchWorkspaceFilesRequest) => {
      const parsed = DesktopDaemonFetchWorkspaceFilesRequestSchemaZ.parse(request);
      return DesktopDaemonFetchWorkspaceFilesResultSchemaZ.parse(
        await ipcRenderer.invoke(HOST_IPC.daemonFetchWorkspaceFiles, parsed),
      );
    },
    fetchWorkspaceFilePreview: async (request: DesktopDaemonFetchWorkspaceFilePreviewRequest) => {
      const parsed = DesktopDaemonFetchWorkspaceFilePreviewRequestSchemaZ.parse(request);
      return DesktopDaemonFetchWorkspaceFilePreviewResultSchemaZ.parse(
        await ipcRenderer.invoke(HOST_IPC.daemonFetchWorkspaceFilePreview, parsed),
      );
    },
    fetchWorkspaceChanges: async (request: DesktopDaemonFetchWorkspaceChangesRequest) => {
      const parsed = DesktopDaemonFetchWorkspaceChangesRequestSchemaZ.parse(request);
      return DesktopDaemonFetchWorkspaceChangesResultSchemaZ.parse(
        await ipcRenderer.invoke(HOST_IPC.daemonFetchWorkspaceChanges, parsed),
      );
    },
    fetchWorkspaceChangeDiff: async (request: DesktopDaemonFetchWorkspaceChangeDiffRequest) => {
      const parsed = DesktopDaemonFetchWorkspaceChangeDiffRequestSchemaZ.parse(request);
      return DesktopDaemonFetchWorkspaceChangeDiffResultSchemaZ.parse(
        await ipcRenderer.invoke(HOST_IPC.daemonFetchWorkspaceChangeDiff, parsed),
      );
    },
    subscribe: async (
      request: DesktopDaemonEventSubscriptionRequest,
      listener: (event: DesktopDaemonEvent) => void,
    ) => {
      const parsed = DesktopDaemonEventSubscriptionRequestSchemaZ.parse(request);
      const result = DesktopDaemonSubscribeWireResultSchemaZ.parse(
        await ipcRenderer.invoke(HOST_IPC.daemonSubscribe, parsed),
      );
      if (result.status === "error") return result;
      daemonListeners.set(result.subscriptionId, listener);
      for (const event of earlyDaemonEvents.get(result.subscriptionId) ?? []) {
        deliverDaemonEvent(listener, event);
      }
      earlyDaemonEvents.delete(result.subscriptionId);
      let active = true;
      return {
        status: "subscribed" as const,
        unsubscribe: () => {
          if (!active) return;
          active = false;
          daemonListeners.delete(result.subscriptionId);
          earlyDaemonEvents.delete(result.subscriptionId);
          void ipcRenderer.invoke(HOST_IPC.daemonUnsubscribe, result.subscriptionId).catch(() => {
            // Main also clears subscriptions when the renderer/window is released.
          });
        },
      };
    },
  }),
});

contextBridge.exposeInMainWorld("tmuxIdeHost", capabilities);
