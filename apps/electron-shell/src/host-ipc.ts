import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import {
  DESKTOP_HOST_API_VERSION,
  type DesktopDaemonPreflight,
  type DesktopHostBootstrap,
  type DesktopPlatform,
  type DesktopThemeState,
  type DesktopWindowState,
} from "@tmux-ide/contracts";

import { HOST_INVOKE_CHANNELS, HOST_IPC } from "./ipc-channels.ts";

export interface HostIpcDependencies {
  ipcMain: IpcMain;
  getWindow: () => BrowserWindow | null;
  appVersion: string;
  platform: DesktopPlatform;
  daemon: DesktopDaemonPreflight;
  rendererDidBootstrap?: () => void;
  requestQuit: () => void;
  selectProjectDirectory: (window: BrowserWindow) => Promise<string | null>;
  getTheme: () => DesktopThemeState;
  trustedRendererLocation: TrustedRendererLocation;
}

export type TrustedRendererLocation =
  | { kind: "packaged-url"; url: string }
  | { kind: "development-origin"; origin: string };

export function rendererLocationIsTrusted(
  frameUrl: string,
  trusted: TrustedRendererLocation,
): boolean {
  try {
    const location = new URL(frameUrl);
    if (trusted.kind === "packaged-url") return location.toString() === trusted.url;
    return location.origin === trusted.origin;
  } catch {
    return false;
  }
}

export function snapshotWindow(window: BrowserWindow | null): DesktopWindowState {
  return {
    maximized: window?.isMaximized() ?? false,
    fullscreen: window?.isFullScreen() ?? false,
    focused: window?.isFocused() ?? false,
  };
}

function trustedWindow(
  event: IpcMainInvokeEvent,
  getWindow: () => BrowserWindow | null,
  trustedRendererLocation: TrustedRendererLocation,
): BrowserWindow {
  const window = getWindow();
  if (
    !window ||
    window.isDestroyed() ||
    event.sender.id !== window.webContents.id ||
    event.senderFrame !== window.webContents.mainFrame ||
    !rendererLocationIsTrusted(event.senderFrame.url, trustedRendererLocation)
  ) {
    throw new Error("desktop host request came from an untrusted renderer");
  }
  return window;
}

export function registerHostIpc(deps: HostIpcDependencies): () => void {
  const handle = (
    channel: (typeof HOST_INVOKE_CHANNELS)[number],
    handler: (event: IpcMainInvokeEvent) => unknown,
  ) => {
    deps.ipcMain.removeHandler(channel);
    deps.ipcMain.handle(channel, handler);
  };

  handle(HOST_IPC.bootstrap, (event): DesktopHostBootstrap => {
    const window = trustedWindow(event, deps.getWindow, deps.trustedRendererLocation);
    const bootstrap: DesktopHostBootstrap = {
      apiVersion: DESKTOP_HOST_API_VERSION,
      runtime: "electron",
      platform: deps.platform,
      appVersion: deps.appVersion,
      theme: deps.getTheme(),
      window: snapshotWindow(window),
      daemon: deps.daemon,
    };
    deps.rendererDidBootstrap?.();
    return bootstrap;
  });
  handle(HOST_IPC.lifecycleQuit, (event) => {
    trustedWindow(event, deps.getWindow, deps.trustedRendererLocation);
    deps.requestQuit();
  });
  handle(HOST_IPC.windowGetState, (event) =>
    snapshotWindow(trustedWindow(event, deps.getWindow, deps.trustedRendererLocation)),
  );
  handle(HOST_IPC.windowMinimize, (event) => {
    const window = trustedWindow(event, deps.getWindow, deps.trustedRendererLocation);
    window.minimize();
    return snapshotWindow(window);
  });
  handle(HOST_IPC.windowToggleMaximized, (event) => {
    const window = trustedWindow(event, deps.getWindow, deps.trustedRendererLocation);
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    return snapshotWindow(window);
  });
  handle(HOST_IPC.windowClose, (event) => {
    trustedWindow(event, deps.getWindow, deps.trustedRendererLocation).close();
  });
  handle(HOST_IPC.menuShowApplication, (event) => {
    trustedWindow(event, deps.getWindow, deps.trustedRendererLocation);
    return { status: "unavailable" as const };
  });
  handle(HOST_IPC.dialogSelectProjectDirectory, async (event) => {
    const window = trustedWindow(event, deps.getWindow, deps.trustedRendererLocation);
    const path = await deps.selectProjectDirectory(window);
    return path ? { path } : null;
  });
  handle(HOST_IPC.themeGetState, (event) => {
    trustedWindow(event, deps.getWindow, deps.trustedRendererLocation);
    return deps.getTheme();
  });

  return () => {
    for (const channel of HOST_INVOKE_CHANNELS) deps.ipcMain.removeHandler(channel);
  };
}

export function publishWindowState(window: BrowserWindow): void {
  if (!window.isDestroyed())
    window.webContents.send(HOST_IPC.windowStateChanged, snapshotWindow(window));
}

export function publishTheme(window: BrowserWindow | null, theme: DesktopThemeState): void {
  if (window && !window.isDestroyed()) window.webContents.send(HOST_IPC.themeChanged, theme);
}
