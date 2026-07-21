import {
  DESKTOP_HOST_API_VERSION,
  DesktopHostBootstrapSchemaZ,
  DesktopThemeStateSchemaZ,
  DesktopWindowStateSchemaZ,
  type DesktopPlatform,
  type DesktopThemeState,
  type DesktopWindowState,
  type HostCapabilities,
} from "@tmux-ide/contracts";

declare global {
  interface Window {
    tmuxIdeHost?: HostCapabilities;
  }
}

function browserPlatform(): DesktopPlatform {
  const platform = navigator.platform.toLowerCase();
  if (platform.includes("mac")) return "darwin";
  if (platform.includes("win")) return "win32";
  if (platform.includes("linux")) return "linux";
  return "unknown";
}

function browserTheme(): DesktopThemeState {
  return {
    mode: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    highContrast: window.matchMedia("(prefers-contrast: more)").matches,
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  };
}

const FALLBACK_INITIAL_THEME: DesktopThemeState = Object.freeze({
  mode: "dark",
  highContrast: false,
  reducedMotion: false,
});

/** Synchronous paint seed; async host bootstrap remains the authoritative state. */
export function readInitialThemeState(): DesktopThemeState {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return FALLBACK_INITIAL_THEME;
  }
  return browserTheme();
}

function browserWindowState(): DesktopWindowState {
  return {
    maximized: false,
    fullscreen: document.fullscreenElement !== null,
    focused: document.hasFocus(),
  };
}

function subscribeMedia(listener: (state: DesktopThemeState) => void): () => void {
  const queries = [
    window.matchMedia("(prefers-color-scheme: dark)"),
    window.matchMedia("(prefers-contrast: more)"),
    window.matchMedia("(prefers-reduced-motion: reduce)"),
  ];
  const changed = () => listener(browserTheme());
  for (const query of queries) query.addEventListener("change", changed);
  return () => {
    for (const query of queries) query.removeEventListener("change", changed);
  };
}

export function createBrowserHostCapabilities(): HostCapabilities {
  const capabilities: HostCapabilities = {
    apiVersion: DESKTOP_HOST_API_VERSION,
    bootstrap: async () => ({
      apiVersion: DESKTOP_HOST_API_VERSION,
      runtime: "browser",
      platform: browserPlatform(),
      appVersion: "browser-dev",
      theme: browserTheme(),
      window: browserWindowState(),
      daemon: {
        status: "unavailable",
        code: "preview-only",
        reason: "Browser preview does not attach to the desktop daemon.",
      },
    }),
    lifecycle: {
      requestQuit: async () => undefined,
    },
    window: {
      getState: async () => browserWindowState(),
      minimize: async () => browserWindowState(),
      toggleMaximized: async () => browserWindowState(),
      close: async () => undefined,
      onStateChanged: () => () => undefined,
    },
    menu: {
      showApplicationMenu: async () => ({ status: "unavailable" }),
    },
    dialog: {
      selectProjectDirectory: async () => null,
    },
    theme: {
      getState: async () => browserTheme(),
      onChanged: subscribeMedia,
    },
  };
  return capabilities;
}

function hasNarrowFacade(value: unknown): value is HostCapabilities {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<HostCapabilities>;
  return (
    candidate.apiVersion === DESKTOP_HOST_API_VERSION &&
    typeof candidate.bootstrap === "function" &&
    typeof candidate.lifecycle?.requestQuit === "function" &&
    typeof candidate.window?.getState === "function" &&
    typeof candidate.window?.minimize === "function" &&
    typeof candidate.window?.toggleMaximized === "function" &&
    typeof candidate.window?.close === "function" &&
    typeof candidate.window?.onStateChanged === "function" &&
    typeof candidate.menu?.showApplicationMenu === "function" &&
    typeof candidate.dialog?.selectProjectDirectory === "function" &&
    typeof candidate.theme?.getState === "function" &&
    typeof candidate.theme?.onChanged === "function"
  );
}

export function resolveHostCapabilities(
  candidate: unknown = typeof window === "undefined" ? undefined : window.tmuxIdeHost,
): HostCapabilities {
  return hasNarrowFacade(candidate) ? candidate : createBrowserHostCapabilities();
}

export async function readHostBootstrap(host: HostCapabilities) {
  return DesktopHostBootstrapSchemaZ.parse(await host.bootstrap());
}

export function parseWindowState(value: unknown) {
  return DesktopWindowStateSchemaZ.parse(value);
}

export function parseThemeState(value: unknown) {
  return DesktopThemeStateSchemaZ.parse(value);
}
