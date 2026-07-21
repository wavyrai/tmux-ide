import { contextBridge, ipcRenderer } from "electron";
import {
  DESKTOP_HOST_API_VERSION,
  DesktopDirectorySelectionSchemaZ,
  DesktopHostBootstrapSchemaZ,
  DesktopMenuResultSchemaZ,
  DesktopThemeStateSchemaZ,
  DesktopWindowStateSchemaZ,
  type DesktopThemeState,
  type DesktopWindowState,
  type HostCapabilities,
} from "@tmux-ide/contracts";

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
  dialog: Object.freeze({
    selectProjectDirectory: async () =>
      DesktopDirectorySelectionSchemaZ.nullable().parse(
        await ipcRenderer.invoke(HOST_IPC.dialogSelectProjectDirectory),
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
});

contextBridge.exposeInMainWorld("tmuxIdeHost", capabilities);
