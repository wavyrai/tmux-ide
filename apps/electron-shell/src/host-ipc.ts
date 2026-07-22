import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import {
  DESKTOP_HOST_API_VERSION,
  DesktopDaemonEventSubscriptionRequestSchemaZ,
  DesktopDaemonEventWireEnvelopeSchemaZ,
  DesktopDaemonFetchApplicationShellRequestSchemaZ,
  DesktopDaemonRefreshConnectionResultSchemaZ,
  DesktopDaemonSubscriptionIdSchemaZ,
  DesktopDaemonSubscribeWireResultSchemaZ,
  DesktopHostBootstrapSchemaZ,
  type DesktopHostBootstrap,
  type DesktopPlatform,
  type DesktopThemeState,
  type DesktopWindowState,
} from "@tmux-ide/contracts";

import type { DaemonConnectionAuthority } from "./daemon-connection-coordinator.ts";
import { daemonCapabilityError } from "./daemon-resource-broker.ts";
import { HOST_INVOKE_CHANNELS, HOST_IPC } from "./ipc-channels.ts";

export interface HostIpcDependencies {
  ipcMain: IpcMain;
  getWindow: () => BrowserWindow | null;
  appVersion: string;
  platform: DesktopPlatform;
  daemonResources: DaemonConnectionAuthority;
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

function currentTrustedWindow(
  getWindow: () => BrowserWindow | null,
  trustedRendererLocation: TrustedRendererLocation,
): BrowserWindow | null {
  const window = getWindow();
  if (
    !window ||
    window.isDestroyed() ||
    !rendererLocationIsTrusted(window.webContents.mainFrame.url, trustedRendererLocation)
  ) {
    return null;
  }
  return window;
}

export interface RegisteredHostIpc {
  dispose(): void;
  releaseRenderer(): void;
  bindWindow(window: BrowserWindow): void;
}

export function registerHostIpc(deps: HostIpcDependencies): RegisteredHostIpc {
  interface RendererAuthority {
    readonly generation: number;
    readonly window: BrowserWindow;
    readonly webContentsId: number;
    readonly mainFrame: IpcMainInvokeEvent["senderFrame"];
  }
  interface DaemonSubscriptionAuthority {
    readonly generation: number;
    readonly unsubscribe: () => void;
  }

  const daemonSubscriptions = new Map<string, DaemonSubscriptionAuthority>();
  let nextDaemonSubscription = 0;
  let nextRendererGeneration = 0;
  let rendererAuthority: RendererAuthority | null = null;
  let boundWindow: BrowserWindow | null = null;
  let unbindWindow: (() => void) | null = null;

  const releaseRenderer = (): void => {
    const active = rendererAuthority !== null || daemonSubscriptions.size > 0;
    rendererAuthority = null;
    for (const subscription of daemonSubscriptions.values()) subscription.unsubscribe();
    daemonSubscriptions.clear();
    if (active) deps.daemonResources.releaseRenderer();
  };

  const beginRendererGeneration = (event: IpcMainInvokeEvent): RendererAuthority => {
    const window = trustedWindow(event, deps.getWindow, deps.trustedRendererLocation);
    releaseRenderer();
    rendererAuthority = {
      generation: ++nextRendererGeneration,
      window,
      webContentsId: window.webContents.id,
      mainFrame: event.senderFrame,
    };
    return rendererAuthority;
  };

  const trustedRendererAuthority = (event: IpcMainInvokeEvent): RendererAuthority => {
    const window = trustedWindow(event, deps.getWindow, deps.trustedRendererLocation);
    const authority = rendererAuthority;
    if (
      !authority ||
      authority.window !== window ||
      authority.webContentsId !== event.sender.id ||
      authority.mainFrame !== event.senderFrame
    ) {
      throw new Error("desktop host request came from an untrusted renderer generation");
    }
    return authority;
  };

  const assertRendererAuthority = (
    event: IpcMainInvokeEvent,
    expectedGeneration: number,
  ): RendererAuthority => {
    const authority = trustedRendererAuthority(event);
    if (authority.generation !== expectedGeneration) {
      throw new Error("desktop host request came from an untrusted renderer generation");
    }
    return authority;
  };

  const currentAuthorityWindow = (expectedGeneration: number): BrowserWindow | null => {
    const authority = rendererAuthority;
    const window = currentTrustedWindow(deps.getWindow, deps.trustedRendererLocation);
    if (
      !authority ||
      !window ||
      authority.generation !== expectedGeneration ||
      authority.window !== window ||
      authority.webContentsId !== window.webContents.id ||
      authority.mainFrame !== window.webContents.mainFrame
    ) {
      return null;
    }
    return window;
  };
  const handle = (
    channel: (typeof HOST_INVOKE_CHANNELS)[number],
    handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ) => {
    deps.ipcMain.removeHandler(channel);
    deps.ipcMain.handle(channel, handler);
  };

  handle(HOST_IPC.bootstrap, (event): DesktopHostBootstrap => {
    const { window } = beginRendererGeneration(event);
    const bootstrap: DesktopHostBootstrap = {
      apiVersion: DESKTOP_HOST_API_VERSION,
      runtime: "electron",
      platform: deps.platform,
      appVersion: deps.appVersion,
      theme: deps.getTheme(),
      window: snapshotWindow(window),
      daemon: deps.daemonResources.state(),
    };
    deps.rendererDidBootstrap?.();
    return DesktopHostBootstrapSchemaZ.parse(bootstrap);
  });
  handle(HOST_IPC.lifecycleQuit, (event) => {
    trustedRendererAuthority(event);
    deps.requestQuit();
  });
  handle(HOST_IPC.windowGetState, (event) =>
    snapshotWindow(trustedRendererAuthority(event).window),
  );
  handle(HOST_IPC.windowMinimize, (event) => {
    const { window } = trustedRendererAuthority(event);
    window.minimize();
    return snapshotWindow(window);
  });
  handle(HOST_IPC.windowToggleMaximized, (event) => {
    const { window } = trustedRendererAuthority(event);
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    return snapshotWindow(window);
  });
  handle(HOST_IPC.windowClose, (event) => {
    trustedRendererAuthority(event).window.close();
  });
  handle(HOST_IPC.menuShowApplication, (event) => {
    trustedRendererAuthority(event);
    return { status: "unavailable" as const };
  });
  handle(HOST_IPC.dialogSelectProjectDirectory, async (event) => {
    const authority = trustedRendererAuthority(event);
    const { window } = authority;
    const path = await deps.selectProjectDirectory(window);
    assertRendererAuthority(event, authority.generation);
    return path ? { path } : null;
  });
  handle(HOST_IPC.themeGetState, (event) => {
    trustedRendererAuthority(event);
    return deps.getTheme();
  });

  handle(HOST_IPC.daemonRefreshConnection, async (event, ...args) => {
    const authority = trustedRendererAuthority(event);
    if (args.length !== 0) throw new Error("desktop daemon refresh request was invalid");
    const result = DesktopDaemonRefreshConnectionResultSchemaZ.parse(
      await deps.daemonResources.refreshConnection(),
    );
    assertRendererAuthority(event, authority.generation);
    if (result.outcome === "generation-replaced" || result.outcome === "authority-retired") {
      // The coordinator already retired the underlying subscriptions after
      // delivering the typed generation event. Forget their private IPC ids.
      daemonSubscriptions.clear();
    }
    return result;
  });

  handle(HOST_IPC.daemonListWorkspaces, async (event, ...args) => {
    const authority = trustedRendererAuthority(event);
    if (args.length !== 0) {
      return { status: "error" as const, error: daemonCapabilityError("invalid-request") };
    }
    const result = await deps.daemonResources.listWorkspaces();
    assertRendererAuthority(event, authority.generation);
    return result;
  });
  handle(HOST_IPC.daemonFetchApplicationShell, async (event, ...args) => {
    const authority = trustedRendererAuthority(event);
    if (args.length !== 1) {
      return { status: "error" as const, error: daemonCapabilityError("invalid-request") };
    }
    const request = DesktopDaemonFetchApplicationShellRequestSchemaZ.safeParse(args[0]);
    if (!request.success) {
      return { status: "error" as const, error: daemonCapabilityError("invalid-request") };
    }
    const result = await deps.daemonResources.fetchApplicationShell(request.data.workspaceName);
    assertRendererAuthority(event, authority.generation);
    return result;
  });
  handle(HOST_IPC.daemonSubscribe, async (event, ...args) => {
    const authority = trustedRendererAuthority(event);
    if (args.length !== 1) {
      return { status: "error" as const, error: daemonCapabilityError("invalid-request") };
    }
    const request = DesktopDaemonEventSubscriptionRequestSchemaZ.safeParse(args[0]);
    if (!request.success) {
      return { status: "error" as const, error: daemonCapabilityError("invalid-request") };
    }
    const subscriptionId = DesktopDaemonSubscriptionIdSchemaZ.parse(
      `desktop-subscription-${++nextDaemonSubscription}`,
    );
    const result = await deps.daemonResources.subscribe(
      request.data.workspaceNames,
      (daemonEvent) => {
        const window = currentAuthorityWindow(authority.generation);
        if (!window) return;
        window.webContents.send(
          HOST_IPC.daemonEvent,
          DesktopDaemonEventWireEnvelopeSchemaZ.parse({ subscriptionId, event: daemonEvent }),
        );
      },
    );
    if (result.status === "error") {
      assertRendererAuthority(event, authority.generation);
      return result;
    }
    try {
      assertRendererAuthority(event, authority.generation);
    } catch (error) {
      result.unsubscribe();
      throw error;
    }
    daemonSubscriptions.set(subscriptionId, {
      generation: authority.generation,
      unsubscribe: result.unsubscribe,
    });
    return DesktopDaemonSubscribeWireResultSchemaZ.parse({ status: "subscribed", subscriptionId });
  });
  handle(HOST_IPC.daemonUnsubscribe, (event, ...args) => {
    const authority = trustedRendererAuthority(event);
    if (args.length !== 1) {
      return { status: "error" as const, error: daemonCapabilityError("invalid-request") };
    }
    const id = DesktopDaemonSubscriptionIdSchemaZ.safeParse(args[0]);
    if (!id.success) {
      return { status: "error" as const, error: daemonCapabilityError("invalid-request") };
    }
    const subscription = daemonSubscriptions.get(id.data);
    if (subscription?.generation === authority.generation) {
      subscription.unsubscribe();
      daemonSubscriptions.delete(id.data);
    }
    return { status: "ok" as const };
  });

  const bindWindow = (window: BrowserWindow): void => {
    if (boundWindow === window) return;
    unbindWindow?.();
    releaseRenderer();
    boundWindow = window;
    const releaseBoundRenderer = (): void => {
      if (boundWindow === window) releaseRenderer();
    };
    const onNavigation = (
      _event: Electron.Event,
      _url: string,
      _isInPlace: boolean,
      isMainFrame: boolean,
    ): void => {
      if (isMainFrame) releaseBoundRenderer();
    };
    const onLoading = (): void => releaseBoundRenderer();
    const onRenderProcessGone = (): void => releaseBoundRenderer();
    const onDestroyed = (): void => releaseBoundRenderer();
    const onClosed = (): void => releaseBoundRenderer();
    window.webContents.on("did-start-navigation", onNavigation);
    window.webContents.on("did-start-loading", onLoading);
    window.webContents.on("render-process-gone", onRenderProcessGone);
    window.webContents.on("destroyed", onDestroyed);
    window.on("closed", onClosed);
    unbindWindow = () => {
      window.webContents.removeListener("did-start-navigation", onNavigation);
      window.webContents.removeListener("did-start-loading", onLoading);
      window.webContents.removeListener("render-process-gone", onRenderProcessGone);
      window.webContents.removeListener("destroyed", onDestroyed);
      window.removeListener("closed", onClosed);
      if (boundWindow === window) boundWindow = null;
    };
  };
  return {
    bindWindow,
    releaseRenderer,
    dispose: () => {
      releaseRenderer();
      unbindWindow?.();
      unbindWindow = null;
      for (const channel of HOST_INVOKE_CHANNELS) deps.ipcMain.removeHandler(channel);
    },
  };
}

export function publishWindowState(window: BrowserWindow): void {
  if (!window.isDestroyed())
    window.webContents.send(HOST_IPC.windowStateChanged, snapshotWindow(window));
}

export function publishTheme(window: BrowserWindow | null, theme: DesktopThemeState): void {
  if (window && !window.isDestroyed()) window.webContents.send(HOST_IPC.themeChanged, theme);
}
