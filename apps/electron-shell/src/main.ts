import { join } from "node:path";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  net,
  protocol,
  screen,
  session,
} from "electron";
import {
  DESKTOP_PACKAGED_RENDERER_ENTRY_URL,
  DESKTOP_PACKAGED_RENDERER_ORIGIN,
  type DesktopPlatform,
  type DesktopThemeState,
} from "@tmux-ide/contracts";

import { canonicalDaemonPreflight, type DaemonPreflight } from "./daemon-preflight.ts";
import {
  acknowledgeOnboardingIntro,
  readOnboardingIntroAcknowledged,
} from "../../../packages/daemon/src/lib/onboarding-marker.ts";
import { DaemonConnectionCoordinator } from "./daemon-connection-coordinator.ts";
import { shutdownDesktopDaemonRuntime } from "./daemon-runtime-shutdown.ts";
import {
  DesktopDaemonSupervisor,
  type DesktopDaemonSupervisorSnapshot,
} from "./daemon-supervisor.ts";
import { DesktopQuitCoordinator } from "./desktop-quit-coordinator.ts";
import {
  publishTheme,
  publishUpdateStatus,
  publishWindowState,
  registerHostIpc,
  type RegisteredHostIpc,
  type TrustedRendererLocation,
} from "./host-ipc.ts";
import { DesktopUpdater } from "./update/desktop-updater.ts";
import { unsignedFeedManifestVerifier } from "./update/update-verify.ts";
import { applyStagedUpdate } from "./update/staged-update.ts";
import {
  clearPendingMarker,
  createStagedUpdateFilesystem,
  createUpdaterIo,
  readPendingMarker,
  resolveUpdateStateDir,
  resolveUpdaterConfig,
} from "./update/update-runtime.ts";
import {
  developmentRendererContentSecurityPolicy,
  installPackagedRendererProtocol,
  installDevelopmentRendererCsp,
  packagedRendererContentSecurityPolicy,
  registerPackagedRendererScheme,
} from "./packaged-renderer-protocol.ts";
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
  daemonSupervisor?: Pick<DesktopDaemonSupervisor, "start" | "stopOwned" | "snapshot">;
  loadTimeoutMs?: number;
}

registerPackagedRendererScheme(protocol);

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

/** The on-disk install target a staged update would swap into place. */
function resolveInstallPath(): string {
  const exe = app.getPath("exe");
  // macOS: .app/Contents/MacOS/<exe> → the .app bundle root.
  if (process.platform === "darwin") return join(exe, "..", "..", "..");
  return join(exe, "..");
}

/**
 * Apply a verified update staged by a PRIOR session, before anything else comes
 * up. Runs only for a packaged app; a dev run is never touched. Normally a no-op
 * (no marker). On a successful swap the process relaunches to run the new bytes.
 * Returns true when startup should halt because a relaunch is in progress.
 */
async function applyPendingUpdateOnLaunch(): Promise<boolean> {
  if (!app.isPackaged) return false;
  const stateDir = resolveUpdateStateDir(app.getPath("userData"));
  const marker = await readPendingMarker(stateDir);
  if (!marker) return false;
  const outcome = await applyStagedUpdate(
    marker,
    resolveInstallPath(),
    createStagedUpdateFilesystem(),
  );
  await clearPendingMarker(stateDir);
  if (outcome.status === "applied") {
    app.relaunch();
    app.exit(0);
    return true;
  }
  return false;
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
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let rendererPolicyReloadTimer: ReturnType<typeof setTimeout> | null = null;
  let lastBoundsWrite = Promise.resolve();
  let rendererDidBootstrap: (() => void) | null = null;
  let latestNormalBounds: DesktopWindowBounds | null = null;
  let daemonResources: DaemonConnectionCoordinator | null = null;
  let persistBounds = async (): Promise<void> => undefined;
  let disposePackagedRendererProtocol = (): void => undefined;
  let disposeDevelopmentRendererCsp = (): void => undefined;
  let onThemeUpdated: (() => void) | null = null;
  let desktopUpdater: DesktopUpdater | null = null;
  let releaseUpdateStatus: (() => void) | null = null;
  const daemonPreflight = deps.daemonPreflight ?? canonicalDaemonPreflight;
  const onOwnedDaemonCrash = (_snapshot: DesktopDaemonSupervisorSnapshot): void => {
    void daemonResources?.refreshConnection().catch((error: unknown) => {
      console.error("Failed to retire crashed desktop daemon authority", error);
    });
  };
  const daemonSupervisor =
    deps.daemonSupervisor ??
    new DesktopDaemonSupervisor({
      preflight: daemonPreflight,
      childEntryPath: join(__dirname, "daemon-child.cjs"),
      productVersion: app.getVersion(),
      onOwnedDaemonCrash,
    });
  const teardownDesktopHost = async (): Promise<void> => {
    if (persistTimer) clearTimeout(persistTimer);
    if (rendererPolicyReloadTimer) clearTimeout(rendererPolicyReloadTimer);
    if (onThemeUpdated) nativeTheme.removeListener("updated", onThemeUpdated);
    releaseUpdateStatus?.();
    desktopUpdater?.dispose();
    // Renderer terminal capabilities and the main-process broker are retired
    // before the exact Electron-owned daemon child is signalled.
    const results = await Promise.allSettled([
      Promise.resolve().then(() => disposeDevelopmentRendererCsp()),
      Promise.resolve().then(() => disposePackagedRendererProtocol()),
      shutdownDesktopDaemonRuntime({
        disposeHostIpc: () => hostIpc?.dispose(),
        disposeDaemonResources: () => daemonResources?.dispose(),
        stopOwnedDaemon: () => daemonSupervisor.stopOwned(),
      }),
    ]);
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) throw new AggregateError(failures, "desktop host cleanup failed");
  };
  // When an update is staged, quit becomes apply+quit: the marker is already
  // durable, so this only flips status to "applying" (the swap runs next launch)
  // before the rest of the host tears down. Never yanks the daemon or terminals.
  const finalizePendingUpdate = async (): Promise<void> => {
    await desktopUpdater?.finalizePendingUpdateForQuit();
  };
  const quitCoordinator = new DesktopQuitCoordinator({
    app,
    shutdownTasks: () => [finalizePendingUpdate, persistBounds, teardownDesktopHost],
    onShutdownError: (error: unknown) => console.error("Desktop shutdown was incomplete", error),
  });

  // This must precede both app readiness and daemon startup: a native quit can
  // arrive while either promise is pending.
  quitCoordinator.install();

  await app.whenReady();
  if (quitCoordinator.quitRequested) return;

  // A staged update from a prior session is swapped in here, before the daemon or
  // any window exists. On a successful swap this relaunches and never returns.
  if (await applyPendingUpdateOnLaunch()) return;

  desktopUpdater = new DesktopUpdater({
    config: resolveUpdaterConfig({
      enabled: app.isPackaged,
      platformKey: `${process.platform}-${process.arch}`,
      currentVersion: app.getVersion(),
    }),
    io: createUpdaterIo({
      stateDir: resolveUpdateStateDir(app.getPath("userData")),
      net: { fetch: (url) => net.fetch(url) },
      logger: (message, detail) => console.warn(`[update] ${message}`, detail ?? {}),
    }),
    verifier: unsignedFeedManifestVerifier(),
  });
  releaseUpdateStatus = desktopUpdater.subscribe((status) =>
    publishUpdateStatus(currentWindow, status),
  );

  const desktopSession = session.defaultSession;
  desktopSession.setPermissionCheckHandler(() => false);
  desktopSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );

  const stateStore = new DesktopWindowStateStore(
    join(app.getPath("userData"), "window-state.json"),
  );
  const developmentUrl = trustedDevelopmentUrl();
  const developmentOrigin = developmentUrl ? new URL(developmentUrl).origin : null;
  const daemon = await quitCoordinator.startUnlessQuitting(() => daemonSupervisor.start());
  if (!daemon) return;
  let daemonHttpOrigin = daemon.status === "connected" ? daemon.descriptor.apiBaseUrl : null;
  try {
    disposePackagedRendererProtocol = installPackagedRendererProtocol({
      protocol,
      fileFetcher: { fetch: (url) => net.fetch(url) },
      rendererRoot: join(__dirname, "renderer"),
      contentSecurityPolicy: () => packagedRendererContentSecurityPolicy(daemonHttpOrigin),
    });
  } catch (error) {
    await daemonSupervisor.stopOwned().catch(() => undefined);
    throw error;
  }
  try {
    disposeDevelopmentRendererCsp = developmentOrigin
      ? installDevelopmentRendererCsp({
          webRequest: desktopSession.webRequest,
          rendererOrigin: developmentOrigin,
          contentSecurityPolicy: () =>
            developmentRendererContentSecurityPolicy(daemonHttpOrigin, developmentOrigin),
        })
      : () => undefined;
  } catch (error) {
    await Promise.allSettled([
      Promise.resolve().then(() => disposePackagedRendererProtocol()),
      daemonSupervisor.stopOwned(),
    ]);
    throw error;
  }
  const abortDesktopStartup = async (): Promise<void> => {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => {
        disposeDevelopmentRendererCsp();
        disposePackagedRendererProtocol();
      }),
      shutdownDesktopDaemonRuntime({
        disposeHostIpc: () => hostIpc?.dispose(),
        disposeDaemonResources: () => daemonResources?.dispose(),
        stopOwnedDaemon: () => daemonSupervisor.stopOwned(),
      }),
    ]);
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) throw new AggregateError(failures, "desktop startup cleanup failed");
  };
  try {
    daemonResources = new DaemonConnectionCoordinator({
      initialDaemon: daemon,
      preflight: daemonPreflight,
      onHostStateChanged: (state) => {
        const nextOrigin = state.status === "connected" ? state.descriptor.apiBaseUrl : null;
        if (nextOrigin === daemonHttpOrigin) return;
        daemonHttpOrigin = nextOrigin;
        if (!currentWindow || currentWindow.isDestroyed()) return;
        if (rendererPolicyReloadTimer) clearTimeout(rendererPolicyReloadTimer);
        rendererPolicyReloadTimer = setTimeout(() => {
          rendererPolicyReloadTimer = null;
          if (currentWindow && !currentWindow.isDestroyed()) currentWindow.reload();
        }, 0);
      },
    });
  } catch (error) {
    await abortDesktopStartup().catch(() => undefined);
    throw error;
  }
  if (daemonSupervisor.snapshot().phase === "crashed") {
    void daemonResources.refreshConnection().catch((error: unknown) => {
      console.error("Failed to retire daemon authority after an early crash", error);
    });
  }
  const trustedRendererLocation: TrustedRendererLocation = developmentUrl
    ? { kind: "development-origin", origin: new URL(developmentUrl).origin }
    : {
        kind: "packaged-origin",
        origin: DESKTOP_PACKAGED_RENDERER_ORIGIN,
        entryUrl: DESKTOP_PACKAGED_RENDERER_ENTRY_URL,
      };

  persistBounds = async (): Promise<void> => {
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
          else await window.loadURL(DESKTOP_PACKAGED_RENDERER_ENTRY_URL);
        },
      });
    } finally {
      rendererDidBootstrap = null;
    }
    return window;
  };

  try {
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
      getUpdateStatus: () => desktopUpdater?.status() ?? {
        phase: "idle",
        currentVersion: app.getVersion(),
        availableVersion: null,
      },
      readOnboardingIntroAcknowledged,
      acknowledgeOnboardingIntro,
      trustedRendererLocation,
    });
  } catch (error) {
    await abortDesktopStartup().catch(() => undefined);
    throw error;
  }

  onThemeUpdated = (): void => publishTheme(currentWindow, themeState());
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

  try {
    await createWindow();
    // Non-blocking: the launch check and the modest cadence start only after the
    // window is up, so nothing about the update path ever gates startup.
    if (!smokeTest) desktopUpdater.start();
    if (smokeTest) {
      console.log(`tmux-ide desktop smoke ready daemon=${daemonSupervisor.snapshot().phase}`);
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
