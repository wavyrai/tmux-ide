import { contextBridge, ipcRenderer } from "electron";
import {
  DesktopIconCatalogSchemaZ,
  DESKTOP_HOST_API_VERSION,
  DesktopHostBootstrapSchemaZ,
  DesktopThemeStateSchemaZ,
  DesktopUpdateStatusSchemaZ,
  DesktopWindowStateSchemaZ,
  WorkspaceOpenHostResultSchemaZ,
  WorkspaceOpenPreparedHostResultSchemaZ,
  WorkspaceOpenCommittedHostResultSchemaZ,
  WorkspaceOpenCancelledHostResultSchemaZ,
  WorkspaceOpenDecisionArgumentsSchemaZ,
  type DesktopThemeState,
  type DesktopUpdateStatus,
  type DesktopWindowState,
  type HostCapabilities,
  type WorkspaceOpenDecisionArguments,
} from "@tmux-ide/contracts";

import { createPreloadDaemonBridge } from "./preload-daemon.ts";

import { HOST_IPC } from "./ipc-channels.ts";

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
  icons: Object.freeze({
    getCatalog: async () =>
      DesktopIconCatalogSchemaZ.parse(await ipcRenderer.invoke(HOST_IPC.iconCatalog)),
  }),
  apiVersion: DESKTOP_HOST_API_VERSION,
  bootstrap: async () =>
    DesktopHostBootstrapSchemaZ.parse(await ipcRenderer.invoke(HOST_IPC.bootstrap)),
  window: Object.freeze({
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
  workspace: Object.freeze({
    openProjectDirectory: async () =>
      WorkspaceOpenHostResultSchemaZ.nullable().parse(
        await ipcRenderer.invoke(HOST_IPC.workspaceOpenProjectDirectory),
      ),
    prepareProjectDirectory: async (previousWorkspaceName?: string | null, operationId?: string) =>
      WorkspaceOpenPreparedHostResultSchemaZ.nullable().parse(
        await ipcRenderer.invoke(
          HOST_IPC.workspacePrepareProjectDirectory,
          previousWorkspaceName ?? null,
          operationId,
        ),
      ),
    commitPreparedOpen: async (decision: WorkspaceOpenDecisionArguments, operationId?: string) =>
      WorkspaceOpenCommittedHostResultSchemaZ.parse(
        await ipcRenderer.invoke(
          HOST_IPC.workspaceCommitPreparedOpen,
          WorkspaceOpenDecisionArgumentsSchemaZ.parse(decision),
          operationId,
        ),
      ),
    cancelPreparedOpen: async (decision: WorkspaceOpenDecisionArguments, operationId?: string) =>
      WorkspaceOpenCancelledHostResultSchemaZ.parse(
        await ipcRenderer.invoke(
          HOST_IPC.workspaceCancelPreparedOpen,
          WorkspaceOpenDecisionArgumentsSchemaZ.parse(decision),
          operationId,
        ),
      ),
  }),
  onboarding: Object.freeze({
    acknowledgeIntro: async () => {
      await ipcRenderer.invoke(HOST_IPC.onboardingAcknowledgeIntro);
    },
  }),
  theme: Object.freeze({
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
  daemon: createPreloadDaemonBridge(ipcRenderer).daemon,
});

contextBridge.exposeInMainWorld("tmuxIdeHost", capabilities);
