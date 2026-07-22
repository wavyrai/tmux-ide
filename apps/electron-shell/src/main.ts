import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { app, BrowserWindow, dialog, ipcMain, nativeTheme, screen, session } from "electron";
import type { DesktopPlatform, DesktopThemeState } from "@tmux-ide/contracts";

import {
  canonicalDaemonPreflight,
  runDaemonPreflight,
  type DaemonPreflight,
} from "./daemon-preflight.ts";
import { DaemonConnectionCoordinator } from "./daemon-connection-coordinator.ts";
import {
  publishTheme,
  publishWindowState,
  registerHostIpc,
  type RegisteredHostIpc,
  type TrustedRendererLocation,
} from "./host-ipc.ts";
import { ShutdownBarrier } from "./shutdown-barrier.ts";
import { loadHiddenWindow } from "./window-loader.ts";
import { denyRendererEscapes, secureWebPreferences } from "./window-security.ts";
import {
  DesktopWindowStateStore,
  captureDesktopWindowNormalBounds,
  restoreDesktopWindowBounds,
  type DesktopWindowBounds,
  type DesktopDisplayWorkArea,
} from "./window-state-store.ts";

export interface DesktopAppDependencies {
  daemonPreflight?: DaemonPreflight;
  loadTimeoutMs?: number;
}

const smokeTest = process.argv.includes("--smoke-test");

function platform(): DesktopPlatform {
  if (
    process.platform === "darwin" ||
    process.platform === "linux" ||
    process.platform === "win32"
  ) {
    return process.platform;
  }
  return "unknown";
}

function themeState(): DesktopThemeState {
  return {
    mode: nativeTheme.shouldUseDarkColors ? "dark" : "light",
    highContrast: nativeTheme.shouldUseHighContrastColors,
    // Electron does not currently expose this preference through nativeTheme.
    reducedMotion: false,
  };
}

function displayWorkAreas(): DesktopDisplayWorkArea[] {
  return screen.getAllDisplays().map(({ workArea }) => ({ ...workArea }));
}

function trustedDevelopmentUrl(): string | null {
  const raw = process.env.TMUX_IDE_RENDERER_URL;
  if (!raw) return null;
  const url = new URL(raw);
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")) {
    throw new Error("TMUX_IDE_RENDERER_URL must use http://127.0.0.1 or http://localhost");
  }
  return url.toString();
}

export async function runDesktopApp(deps: DesktopAppDependencies = {}): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  let currentWindow: BrowserWindow | null = null;
  let hostIpc: RegisteredHostIpc | null = null;
  let quittingAfterBarrier = false;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let lastBoundsWrite = Promise.resolve();
  let rendererDidBootstrap: (() => void) | null = null;
  let latestNormalBounds: DesktopWindowBounds | null = null;
  const shutdown = new ShutdownBarrier();

  await app.whenReady();

  const desktopSession = session.defaultSession;
  desktopSession.setPermissionCheckHandler(() => false);
  desktopSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );

  const stateStore = new DesktopWindowStateStore(
    join(app.getPath("userData"), "window-state.json"),
  );
  const daemonPreflight = deps.daemonPreflight ?? canonicalDaemonPreflight;
  const daemon = await runDaemonPreflight(daemonPreflight);
  const daemonResources = new DaemonConnectionCoordinator({
    initialDaemon: daemon,
    preflight: daemonPreflight,
  });
  const developmentUrl = trustedDevelopmentUrl();
  const packagedRendererPath = join(__dirname, "renderer", "index.html");
  const trustedRendererLocation: TrustedRendererLocation = developmentUrl
    ? { kind: "development-origin", origin: new URL(developmentUrl).origin }
    : { kind: "packaged-url", url: pathToFileURL(packagedRendererPath).toString() };

  const persistBounds = async (): Promise<void> => {
    latestNormalBounds = captureDesktopWindowNormalBounds(currentWindow, latestNormalBounds);
    if (!latestNormalBounds) return lastBoundsWrite;
    const bounds = latestNormalBounds;
    lastBoundsWrite = lastBoundsWrite.catch(() => undefined).then(() => stateStore.write(bounds));
    return lastBoundsWrite;
  };

  const scheduleBoundsPersistence = (): void => {
    latestNormalBounds = captureDesktopWindowNormalBounds(currentWindow, latestNormalBounds);
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persistBounds().catch((error: unknown) => {
        console.error("Failed to persist desktop window bounds", error);
      });
    }, 250);
  };

  const createWindow = async (): Promise<BrowserWindow> => {
    const rendererReady = new Promise<void>((resolve) => {
      rendererDidBootstrap = resolve;
    });
    const savedBounds = await stateStore.read();
    const bounds = restoreDesktopWindowBounds(savedBounds, displayWorkAreas());
    latestNormalBounds = bounds;
    const window = new BrowserWindow({
      ...bounds,
      show: false,
      minWidth: 720,
      minHeight: 480,
      backgroundColor: "#101116",
      title: "tmux-ide",
      titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
      trafficLightPosition: process.platform === "darwin" ? { x: 14, y: 16 } : undefined,
      webPreferences: secureWebPreferences(join(__dirname, "preload.cjs")),
    });
    currentWindow = window;
    denyRendererEscapes(window.webContents);
    hostIpc?.bindWindow(window);

    window.on("maximize", () => publishWindowState(window));
    window.on("unmaximize", () => publishWindowState(window));
    window.on("enter-full-screen", () => publishWindowState(window));
    window.on("leave-full-screen", () => publishWindowState(window));
    window.on("focus", () => publishWindowState(window));
    window.on("blur", () => publishWindowState(window));
    window.on("move", scheduleBoundsPersistence);
    window.on("resize", scheduleBoundsPersistence);
    window.on("close", () => void persistBounds());
    window.on("closed", () => {
      if (currentWindow === window) {
        currentWindow = null;
        hostIpc?.releaseRenderer();
      }
    });

    try {
      await loadHiddenWindow(window, {
        timeoutMs: deps.loadTimeoutMs,
        reveal: !smokeTest,
        rendererReady,
        load: async () => {
          if (developmentUrl) await window.loadURL(developmentUrl);
          else await window.loadFile(packagedRendererPath);
        },
      });
    } finally {
      rendererDidBootstrap = null;
    }
    return window;
  };

  hostIpc = registerHostIpc({
    ipcMain,
    getWindow: () => currentWindow,
    appVersion: app.getVersion(),
    platform: platform(),
    daemonResources,
    rendererDidBootstrap: () => rendererDidBootstrap?.(),
    requestQuit: () => app.quit(),
    selectProjectDirectory: async (window) => {
      const result = await dialog.showOpenDialog(window, {
        title: "Open project",
        properties: ["openDirectory", "createDirectory"],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    getTheme: themeState,
    trustedRendererLocation,
  });

  const onThemeUpdated = (): void => publishTheme(currentWindow, themeState());
  nativeTheme.on("updated", onThemeUpdated);

  app.on("second-instance", () => {
    if (!currentWindow) return;
    if (currentWindow.isMinimized()) currentWindow.restore();
    currentWindow.show();
    currentWindow.focus();
  });

  app.on("activate", () => {
    if (currentWindow) return;
    void createWindow().catch((error: unknown) => {
      dialog.showErrorBox("tmux-ide could not open", String(error));
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", (event) => {
    if (quittingAfterBarrier) return;
    event.preventDefault();
    void shutdown
      .run([
        persistBounds,
        () => {
          if (persistTimer) clearTimeout(persistTimer);
          hostIpc?.dispose();
          daemonResources.dispose();
          nativeTheme.removeListener("updated", onThemeUpdated);
        },
      ])
      .catch((error: unknown) => console.error("Desktop shutdown was incomplete", error))
      .finally(() => {
        quittingAfterBarrier = true;
        app.quit();
      });
  });

  try {
    await createWindow();
    if (smokeTest) {
      console.log("tmux-ide desktop smoke ready");
      app.quit();
    }
  } catch (error) {
    if (!smokeTest) dialog.showErrorBox("tmux-ide could not start", String(error));
    process.exitCode = 1;
    app.quit();
  }
}

void runDesktopApp().catch((error: unknown) => {
  console.error("tmux-ide desktop host failed", error);
  app.exit(1);
});
