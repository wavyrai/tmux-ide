import {
  DAEMON_RESOURCE_KINDS,
  DESKTOP_HOST_API_VERSION,
  DesktopHostBootstrapSchemaZ,
  DesktopThemeStateSchemaZ,
  DesktopWindowStateSchemaZ,
  createDaemonResourceMethods,
  type DaemonResourceRequest,
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

const PREVIEW_DAEMON_ERROR = Object.freeze({
  code: "preview-only" as const,
  reason: "Live daemon resources are unavailable in browser preview.",
});

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

/**
 * Every daemon resource, refused the same way, in the vocabulary its own
 * caller switches on. One dispatcher replaces fifteen preview stubs; the two
 * lease issues keep their issue-error shape because a renderer branching on
 * `retryable` must not receive a capability error instead.
 */
async function previewDaemonResource(request: DaemonResourceRequest): Promise<unknown> {
  if (request.resource === "issueTerminalAttachment") {
    return {
      status: "error",
      error: {
        code: "preview-only",
        reason: "Terminal attachments are unavailable in browser preview.",
        retryable: false,
      },
    };
  }
  if (request.resource === "issuePaneStream") {
    return {
      status: "error",
      error: {
        code: "daemon-unavailable",
        reason: "Pane streams are unavailable in browser preview.",
        retryable: false,
      },
    };
  }
  if (request.resource === "refreshConnection") {
    return {
      outcome: "unchanged",
      daemon: {
        status: "unavailable",
        code: "preview-only",
        reason: "Browser preview does not attach to the desktop daemon.",
      },
    };
  }
  return { status: "error", error: PREVIEW_DAEMON_ERROR };
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
      onboarding: { introAcknowledged: false },
    }),
    window: {
      minimize: async () => browserWindowState(),
      toggleMaximized: async () => browserWindowState(),
      close: async () => undefined,
      onStateChanged: () => () => undefined,
    },
    workspace: {
      openProjectDirectory: async () => null,
    },
    onboarding: {
      acknowledgeIntro: async () => undefined,
    },
    theme: {
      onChanged: subscribeMedia,
    },
    update: {
      getStatus: async () => ({
        phase: "idle",
        currentVersion: "browser-dev",
        availableVersion: null,
      }),
      onStatusChanged: () => () => undefined,
    },
    daemon: {
      ...createDaemonResourceMethods(previewDaemonResource),
      subscribe: async () => ({ status: "error", error: PREVIEW_DAEMON_ERROR }),
    },
  };
  return capabilities;
}

/**
 * Is this object the bridge this renderer was built against?
 *
 * The daemon half is checked against `DAEMON_RESOURCE_KINDS` rather than a
 * hand-written list. That list used to be a fourth copy of the interface that
 * TypeScript could not keep in sync — the reason a new resource had to be added
 * twice in this one file — and it is now derived from the same union the
 * methods themselves are.
 */
function hasNarrowFacade(value: unknown): value is HostCapabilities {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<HostCapabilities>;
  const daemon = candidate.daemon as Record<string, unknown> | undefined;
  return (
    candidate.apiVersion === DESKTOP_HOST_API_VERSION &&
    typeof candidate.bootstrap === "function" &&
    typeof candidate.window?.minimize === "function" &&
    typeof candidate.window?.toggleMaximized === "function" &&
    typeof candidate.window?.close === "function" &&
    typeof candidate.window?.onStateChanged === "function" &&
    typeof candidate.workspace?.openProjectDirectory === "function" &&
    typeof candidate.onboarding?.acknowledgeIntro === "function" &&
    typeof candidate.theme?.onChanged === "function" &&
    typeof candidate.update?.getStatus === "function" &&
    typeof candidate.update?.onStatusChanged === "function" &&
    typeof candidate.daemon?.subscribe === "function" &&
    DAEMON_RESOURCE_KINDS.every((resource) => typeof daemon?.[resource] === "function")
  );
}

export function resolveHostCapabilities(
  candidate: unknown = typeof window === "undefined" ? undefined : window.tmuxIdeHost,
): HostCapabilities {
  if (candidate == null) return createBrowserHostCapabilities();
  if (!hasNarrowFacade(candidate)) {
    throw new Error("Desktop host bridge is present but incompatible with this renderer.");
  }
  return candidate;
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
