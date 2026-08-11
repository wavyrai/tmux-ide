import { randomUUID } from "node:crypto";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import {
  AppWindowMutationHostResultSchemaZ,
  AppWindowMutationRequestSchemaZ,
  WorkspaceMultiplexerHostResultSchemaZ,
  WorkspaceMultiplexerMutationRequestSchemaZ,
  type MultiplexerVerbInvocation,
  DaemonResourceRequestSchemaZ,
  DESKTOP_PACKAGED_RENDERER_ENTRY_URL,
  DESKTOP_PACKAGED_RENDERER_ORIGIN,
  DESKTOP_HOST_API_VERSION,
  DesktopDaemonEventSubscriptionRequestSchemaZ,
  DesktopDaemonCapabilitiesResultSchemaZ,
  DesktopDaemonEventWireEnvelopeSchemaZ,
  DesktopDaemonRefreshConnectionResultSchemaZ,
  DesktopDaemonStartupReadinessResultSchemaZ,
  DesktopDaemonSubscriptionIdSchemaZ,
  DesktopDaemonSubscribeWireResultSchemaZ,
  DesktopHostBootstrapSchemaZ,
  DesktopUpdateStatusSchemaZ,
  TerminalAttachmentIssueMutationRequestSchemaZ,
  TerminalAttachmentIssueResultSchemaZ,
  PaneStreamIssueMutationRequestSchemaZ,
  PaneStreamIssueResultSchemaZ,
  WorkspacePaneCreateHostResultSchemaZ,
  WorkspacePaneCreateMutationRequestSchemaZ,
  WorkspaceOpenHostResultSchemaZ,
  WorkspaceOpenMutationRequestSchemaZ,
  WorkspacePromoteHostResultSchemaZ,
  WorkspacePromoteMutationRequestSchemaZ,
  isDaemonResourceKind,
  type AppWindowMutationArguments,
  type DaemonInstanceIdentity,
  type DaemonResourceKind,
  type DesktopDaemonCapabilityState,
  type DesktopHostBootstrap,
  type DesktopPlatform,
  type DesktopThemeState,
  type DesktopUpdateStatus,
  type DesktopWindowState,
  type PaneStreamLeaseRequest,
  type StartupReadinessLadder,
  type TerminalAttachRequest,
  type WorkspacePaneCreateInvocation,
  type WorkspacePromoteArguments,
} from "@tmux-ide/contracts";

import type { DaemonConnectionAuthority } from "./daemon-connection-coordinator.ts";
import {
  daemonCapabilityError,
  daemonCapabilityErrorFromUnknown,
  paneStreamIssueError,
  terminalAttachmentIssueError,
  workspacePromotionFailureFromUnknown,
} from "./daemon-resource-broker.ts";
import { HOST_INVOKE_CHANNELS, HOST_IPC } from "./ipc-channels.ts";

export interface HostIpcDependencies {
  ipcMain: IpcMain;
  getWindow: () => BrowserWindow | null;
  appVersion: string;
  platform: DesktopPlatform;
  daemonResources: DaemonConnectionAuthority;
  rendererDidBootstrap?: () => void;
  selectProjectDirectory: (window: BrowserWindow) => Promise<string | null>;
  /**
   * The daemon's own startup readiness ladder, or null when none was readable.
   * Diagnostics: it must be bounded and must never reject. Optional so bespoke
   * test hosts without a canonical daemon record stay valid.
   */
  readStartupReadiness?: () => Promise<StartupReadinessLadder | null>;
  getTheme: () => DesktopThemeState;
  getUpdateStatus: () => DesktopUpdateStatus;
  readOnboardingIntroAcknowledged: () => boolean;
  acknowledgeOnboardingIntro: () => void;
  trustedRendererLocation: TrustedRendererLocation;
}

export type TrustedRendererLocation =
  | { kind: "packaged-url"; url: string }
  | {
      kind: "packaged-origin";
      origin: typeof DESKTOP_PACKAGED_RENDERER_ORIGIN;
      entryUrl: typeof DESKTOP_PACKAGED_RENDERER_ENTRY_URL;
    }
  | { kind: "development-origin"; origin: string };

export function rendererLocationIsTrusted(
  frameUrl: string,
  trusted: TrustedRendererLocation,
): boolean {
  try {
    const location = new URL(frameUrl);
    if (trusted.kind === "packaged-url") return location.toString() === trusted.url;
    if (trusted.kind === "packaged-origin") {
      return (
        location.protocol === "tmux-ide:" &&
        location.hostname === "app" &&
        location.port.length === 0 &&
        location.username.length === 0 &&
        location.password.length === 0 &&
        location.search.length === 0 &&
        location.hash.length === 0 &&
        location.toString() === trusted.entryUrl
      );
    }
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

function sameDaemonIdentity(left: DaemonInstanceIdentity, right: DaemonInstanceIdentity): boolean {
  return (
    left.protocolVersion === right.protocolVersion &&
    left.productVersion === right.productVersion &&
    left.instanceId === right.instanceId &&
    left.startedAt === right.startedAt
  );
}

function disconnectedCapabilityError(state: DesktopDaemonCapabilityState) {
  return daemonCapabilityError(
    state.status === "degraded" ? "daemon-degraded" : "daemon-unavailable",
  );
}

function disconnectedTerminalError(state: DesktopDaemonCapabilityState) {
  return terminalAttachmentIssueError(
    state.status === "degraded" ? "daemon-degraded" : "daemon-unavailable",
  );
}

/**
 * How a well-named resource refuses a payload it cannot read.
 *
 * The two lease issues answer in their own issue vocabulary — a renderer
 * switching on `attachment-unavailable` must never receive a capability error
 * instead — so the refusal is chosen by tag, exactly as the fifteen separate
 * handlers each chose it for themselves.
 */
function invalidDaemonRequestResult(kind: DaemonResourceKind) {
  if (kind === "issueTerminalAttachment") {
    return { status: "error" as const, error: terminalAttachmentIssueError("invalid-request") };
  }
  if (kind === "issuePaneStream") {
    return { status: "error" as const, error: paneStreamIssueError("invalid-request") };
  }
  return { status: "error" as const, error: daemonCapabilityError("invalid-request") };
}

function disconnectedPaneStreamError(state: DesktopDaemonCapabilityState) {
  return paneStreamIssueError(
    state.status === "degraded" ? "daemon-degraded" : "daemon-unavailable",
  );
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
    readonly hostClientId: string;
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
      hostClientId: randomUUID(),
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
      onboarding: { introAcknowledged: deps.readOnboardingIntroAcknowledged() },
    };
    deps.rendererDidBootstrap?.();
    return DesktopHostBootstrapSchemaZ.parse(bootstrap);
  });
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
  handle(HOST_IPC.workspaceOpenProjectDirectory, async (event, ...args) => {
    const authority = trustedRendererAuthority(event);
    if (args.length !== 0) {
      return WorkspaceOpenHostResultSchemaZ.parse({
        status: "error",
        error: daemonCapabilityError("invalid-request"),
      });
    }
    const { window } = authority;
    const path = await deps.selectProjectDirectory(window);
    assertRendererAuthority(event, authority.generation);
    if (!path) return null;
    const before = deps.daemonResources.state();
    if (before.status !== "connected") {
      return WorkspaceOpenHostResultSchemaZ.parse({
        status: "error",
        error: disconnectedCapabilityError(before),
      });
    }
    const request = WorkspaceOpenMutationRequestSchemaZ.parse({
      operationId: randomUUID(),
      expectedDaemonInstanceId: before.identity.instanceId,
      intent: { projectDir: path },
    });
    try {
      const result = await deps.daemonResources.openWorkspace(request);
      try {
        assertRendererAuthority(event, authority.generation);
      } catch {
        return WorkspaceOpenHostResultSchemaZ.parse({
          status: "error",
          error: daemonCapabilityError("disposed"),
        });
      }
      const after = deps.daemonResources.state();
      if (
        after.status !== "connected" ||
        !sameDaemonIdentity(before.identity, after.identity) ||
        result.operationId !== request.operationId ||
        result.daemonInstanceId !== request.expectedDaemonInstanceId
      ) {
        return WorkspaceOpenHostResultSchemaZ.parse({
          status: "error",
          error: daemonCapabilityError("daemon-identity-mismatch"),
        });
      }
      return WorkspaceOpenHostResultSchemaZ.parse({ status: "ok", result });
    } catch {
      try {
        assertRendererAuthority(event, authority.generation);
      } catch {
        return WorkspaceOpenHostResultSchemaZ.parse({
          status: "error",
          error: daemonCapabilityError("disposed"),
        });
      }
      return WorkspaceOpenHostResultSchemaZ.parse({
        status: "error",
        error: daemonCapabilityError("request-failed"),
      });
    }
  });
  handle(HOST_IPC.onboardingAcknowledgeIntro, (event, ...args) => {
    trustedRendererAuthority(event);
    if (args.length !== 0) throw new Error("desktop onboarding acknowledge request was invalid");
    deps.acknowledgeOnboardingIntro();
  });
  handle(HOST_IPC.updateGetStatus, (event) => {
    trustedRendererAuthority(event);
    return DesktopUpdateStatusSchemaZ.parse(deps.getUpdateStatus());
  });

  const refreshConnection = async (event: IpcMainInvokeEvent, expectedGeneration: number) => {
    const result = DesktopDaemonRefreshConnectionResultSchemaZ.parse(
      await deps.daemonResources.refreshConnection(),
    );
    assertRendererAuthority(event, expectedGeneration);
    if (result.outcome === "generation-replaced" || result.outcome === "authority-retired") {
      // The coordinator already retired the underlying subscriptions after
      // delivering the typed generation event. Forget their private IPC ids.
      daemonSubscriptions.clear();
    }
    return result;
  };

  const capabilities = async (event: IpcMainInvokeEvent, expectedGeneration: number) => {
    const result = DesktopDaemonCapabilitiesResultSchemaZ.parse(
      await deps.daemonResources.capabilities(),
    );
    assertRendererAuthority(event, expectedGeneration);
    return result;
  };

  /**
   * The daemon's own ladder, for surfaces that are degraded WHILE the daemon is
   * connected — where the two rungs only it can answer are the whole diagnosis.
   * Never throws: an unreadable ladder is a missing diagnostic, not a fault.
   */
  const startupReadiness = async (event: IpcMainInvokeEvent, expectedGeneration: number) => {
    const read = deps.readStartupReadiness;
    if (!read) {
      return { status: "error" as const, error: daemonCapabilityError("daemon-unavailable") };
    }
    let ladder: StartupReadinessLadder | null;
    try {
      ladder = await read();
    } catch {
      ladder = null;
    }
    assertRendererAuthority(event, expectedGeneration);
    // safeParse, not parse: a daemon that answers with a ladder this build
    // cannot read leaves the surface without a diagnostic, which is the same
    // outcome as no ladder at all. It must not fail the request.
    const parsed = DesktopDaemonStartupReadinessResultSchemaZ.safeParse({ status: "ok", ladder });
    return parsed.success
      ? parsed.data
      : { status: "error" as const, error: daemonCapabilityError("invalid-response") };
  };

  const createWorkspacePane = async (
    event: IpcMainInvokeEvent,
    authority: RendererAuthority,
    invocation: { data: WorkspacePaneCreateInvocation },
  ) => {
    const before = deps.daemonResources.state();
    if (before.status !== "connected") {
      return WorkspacePaneCreateHostResultSchemaZ.parse({
        status: "error",
        error: disconnectedCapabilityError(before),
      });
    }
    const request = WorkspacePaneCreateMutationRequestSchemaZ.parse({
      operationId: randomUUID(),
      expectedDaemonInstanceId: before.identity.instanceId,
      intent: invocation.data.args,
    });
    try {
      const result = await deps.daemonResources.createWorkspacePane(request);
      try {
        assertRendererAuthority(event, authority.generation);
      } catch {
        return WorkspacePaneCreateHostResultSchemaZ.parse({
          status: "error",
          error: daemonCapabilityError("disposed"),
        });
      }
      const after = deps.daemonResources.state();
      if (
        after.status !== "connected" ||
        !sameDaemonIdentity(before.identity, after.identity) ||
        result.operationId !== request.operationId ||
        result.daemonInstanceId !== request.expectedDaemonInstanceId
      ) {
        return WorkspacePaneCreateHostResultSchemaZ.parse({
          status: "error",
          error: daemonCapabilityError("daemon-identity-mismatch"),
        });
      }
      return WorkspacePaneCreateHostResultSchemaZ.parse({ status: "ok", result });
    } catch {
      try {
        assertRendererAuthority(event, authority.generation);
      } catch {
        return WorkspacePaneCreateHostResultSchemaZ.parse({
          status: "error",
          error: daemonCapabilityError("disposed"),
        });
      }
      return WorkspacePaneCreateHostResultSchemaZ.parse({
        status: "error",
        error: daemonCapabilityError("request-failed"),
      });
    }
  };

  const mutateAppWindow = async (
    event: IpcMainInvokeEvent,
    authority: RendererAuthority,
    intent: { data: AppWindowMutationArguments },
  ) => {
    const before = deps.daemonResources.state();
    if (before.status !== "connected") {
      return AppWindowMutationHostResultSchemaZ.parse({
        status: "error",
        error: disconnectedCapabilityError(before),
      });
    }
    const request = AppWindowMutationRequestSchemaZ.parse({
      operationId: randomUUID(),
      expectedDaemonInstanceId: before.identity.instanceId,
      intent: intent.data,
    });
    try {
      const result = await deps.daemonResources.mutateAppWindow(request);
      try {
        assertRendererAuthority(event, authority.generation);
      } catch {
        return AppWindowMutationHostResultSchemaZ.parse({
          status: "error",
          error: daemonCapabilityError("disposed"),
        });
      }
      const after = deps.daemonResources.state();
      if (
        after.status !== "connected" ||
        !sameDaemonIdentity(before.identity, after.identity) ||
        result.operationId !== request.operationId ||
        result.daemonInstanceId !== request.expectedDaemonInstanceId ||
        result.workspaceName !== request.intent.workspaceName
      ) {
        return AppWindowMutationHostResultSchemaZ.parse({
          status: "error",
          error: daemonCapabilityError("daemon-identity-mismatch"),
        });
      }
      return AppWindowMutationHostResultSchemaZ.parse({ status: "ok", result });
    } catch (error) {
      try {
        assertRendererAuthority(event, authority.generation);
      } catch {
        return AppWindowMutationHostResultSchemaZ.parse({
          status: "error",
          error: daemonCapabilityError("disposed"),
        });
      }
      const after = deps.daemonResources.state();
      if (after.status !== "connected" || !sameDaemonIdentity(before.identity, after.identity)) {
        return AppWindowMutationHostResultSchemaZ.parse({
          status: "error",
          error: daemonCapabilityError("daemon-identity-mismatch"),
        });
      }
      return AppWindowMutationHostResultSchemaZ.parse({
        status: "error",
        error: daemonCapabilityErrorFromUnknown(error),
      });
    }
  };

  /**
   * Run one multiplexer verb on behalf of the renderer.
   *
   * The renderer authors the intent and nothing else. The operation id is
   * minted here, in the trusted process, for the same reason pane creation
   * mints its own: a renderer that could choose it could replay another
   * window's kill by reusing its id.
   */
  const invokeVerb = async (
    event: IpcMainInvokeEvent,
    authority: RendererAuthority,
    invocation: { data: MultiplexerVerbInvocation },
  ) => {
    const before = deps.daemonResources.state();
    if (before.status !== "connected") {
      return WorkspaceMultiplexerHostResultSchemaZ.parse({
        status: "error",
        error: disconnectedCapabilityError(before),
      });
    }
    const request = WorkspaceMultiplexerMutationRequestSchemaZ.parse({
      operationId: randomUUID(),
      expectedDaemonInstanceId: before.identity.instanceId,
      intent: invocation.data.intent,
    });
    try {
      const result = await deps.daemonResources.invokeVerb(request, authority.hostClientId);
      try {
        assertRendererAuthority(event, authority.generation);
      } catch {
        return WorkspaceMultiplexerHostResultSchemaZ.parse({
          status: "error",
          error: daemonCapabilityError("disposed"),
        });
      }
      const after = deps.daemonResources.state();
      if (
        after.status !== "connected" ||
        !sameDaemonIdentity(before.identity, after.identity) ||
        result.operationId !== request.operationId ||
        result.daemonInstanceId !== request.expectedDaemonInstanceId ||
        result.workspaceName !== request.intent.workspaceName
      ) {
        return WorkspaceMultiplexerHostResultSchemaZ.parse({
          status: "error",
          error: daemonCapabilityError("daemon-identity-mismatch"),
        });
      }
      return WorkspaceMultiplexerHostResultSchemaZ.parse({ status: "ok", result });
    } catch (error) {
      try {
        assertRendererAuthority(event, authority.generation);
      } catch {
        return WorkspaceMultiplexerHostResultSchemaZ.parse({
          status: "error",
          error: daemonCapabilityError("disposed"),
        });
      }
      return WorkspaceMultiplexerHostResultSchemaZ.parse({
        status: "error",
        error: daemonCapabilityErrorFromUnknown(error),
      });
    }
  };

  const issueTerminalAttachment = async (
    event: IpcMainInvokeEvent,
    authority: RendererAuthority,
    attachment: { data: TerminalAttachRequest },
  ) => {
    const rendererFrameUrl = authority.mainFrame?.url;
    if (
      !rendererFrameUrl ||
      !rendererLocationIsTrusted(rendererFrameUrl, deps.trustedRendererLocation)
    ) {
      return TerminalAttachmentIssueResultSchemaZ.parse({
        status: "error",
        error: terminalAttachmentIssueError("renderer-origin-unavailable"),
      });
    }
    const rendererOrigin =
      deps.trustedRendererLocation.kind === "development-origin"
        ? deps.trustedRendererLocation.origin
        : deps.trustedRendererLocation.kind === "packaged-origin"
          ? deps.trustedRendererLocation.origin
          : null;
    if (!rendererOrigin) {
      return TerminalAttachmentIssueResultSchemaZ.parse({
        status: "error",
        error: terminalAttachmentIssueError("renderer-origin-unavailable"),
      });
    }
    const before = deps.daemonResources.state();
    if (before.status !== "connected") {
      return TerminalAttachmentIssueResultSchemaZ.parse({
        status: "error",
        error: disconnectedTerminalError(before),
      });
    }
    const request = TerminalAttachmentIssueMutationRequestSchemaZ.parse({
      requestId: randomUUID(),
      expectedDaemonInstanceId: before.identity.instanceId,
      attachment: attachment.data,
    });
    try {
      const result = TerminalAttachmentIssueResultSchemaZ.parse(
        await deps.daemonResources.issueTerminalAttachment(
          request,
          rendererOrigin,
          authority.hostClientId,
        ),
      );
      try {
        assertRendererAuthority(event, authority.generation);
      } catch {
        return TerminalAttachmentIssueResultSchemaZ.parse({
          status: "error",
          error: terminalAttachmentIssueError("disposed"),
        });
      }
      const after = deps.daemonResources.state();
      if (
        after.status !== "connected" ||
        !sameDaemonIdentity(before.identity, after.identity) ||
        (result.status === "issued" &&
          (result.descriptor.requestId !== request.requestId ||
            result.descriptor.daemonInstanceId !== request.expectedDaemonInstanceId))
      ) {
        return TerminalAttachmentIssueResultSchemaZ.parse({
          status: "error",
          error: terminalAttachmentIssueError("daemon-identity-mismatch"),
        });
      }
      return result;
    } catch {
      try {
        assertRendererAuthority(event, authority.generation);
      } catch {
        return TerminalAttachmentIssueResultSchemaZ.parse({
          status: "error",
          error: terminalAttachmentIssueError("disposed"),
        });
      }
      return TerminalAttachmentIssueResultSchemaZ.parse({
        status: "error",
        error: terminalAttachmentIssueError("request-failed"),
      });
    }
  };

  const issuePaneStream = async (
    event: IpcMainInvokeEvent,
    authority: RendererAuthority,
    stream: { data: PaneStreamLeaseRequest },
  ) => {
    const rendererFrameUrl = authority.mainFrame?.url;
    if (
      !rendererFrameUrl ||
      !rendererLocationIsTrusted(rendererFrameUrl, deps.trustedRendererLocation)
    ) {
      return PaneStreamIssueResultSchemaZ.parse({
        status: "error",
        error: paneStreamIssueError("renderer-origin-unavailable"),
      });
    }
    const rendererOrigin =
      deps.trustedRendererLocation.kind === "development-origin"
        ? deps.trustedRendererLocation.origin
        : deps.trustedRendererLocation.kind === "packaged-origin"
          ? deps.trustedRendererLocation.origin
          : null;
    if (!rendererOrigin) {
      return PaneStreamIssueResultSchemaZ.parse({
        status: "error",
        error: paneStreamIssueError("renderer-origin-unavailable"),
      });
    }
    const before = deps.daemonResources.state();
    if (before.status !== "connected") {
      return PaneStreamIssueResultSchemaZ.parse({
        status: "error",
        error: disconnectedPaneStreamError(before),
      });
    }
    const request = PaneStreamIssueMutationRequestSchemaZ.parse({
      requestId: randomUUID(),
      expectedDaemonInstanceId: before.identity.instanceId,
      stream: stream.data,
    });
    try {
      const result = PaneStreamIssueResultSchemaZ.parse(
        await deps.daemonResources.issuePaneStream(request, rendererOrigin, authority.hostClientId),
      );
      try {
        assertRendererAuthority(event, authority.generation);
      } catch {
        return PaneStreamIssueResultSchemaZ.parse({
          status: "error",
          error: paneStreamIssueError("disposed"),
        });
      }
      const after = deps.daemonResources.state();
      if (
        after.status !== "connected" ||
        !sameDaemonIdentity(before.identity, after.identity) ||
        (result.status === "issued" &&
          (result.descriptor.requestId !== request.requestId ||
            result.descriptor.daemonInstanceId !== request.expectedDaemonInstanceId))
      ) {
        return PaneStreamIssueResultSchemaZ.parse({
          status: "error",
          error: paneStreamIssueError("daemon-identity-mismatch"),
        });
      }
      return result;
    } catch {
      try {
        assertRendererAuthority(event, authority.generation);
      } catch {
        return PaneStreamIssueResultSchemaZ.parse({
          status: "error",
          error: paneStreamIssueError("disposed"),
        });
      }
      return PaneStreamIssueResultSchemaZ.parse({
        status: "error",
        error: paneStreamIssueError("request-failed"),
      });
    }
  };

  /** The reads that need nothing but the broker call and the generation recheck. */
  const readResource = async <T>(
    event: IpcMainInvokeEvent,
    expectedGeneration: number,
    read: () => Promise<T>,
  ): Promise<T> => {
    const result = await read();
    assertRendererAuthority(event, expectedGeneration);
    return result;
  };

  const promoteWorkspace = async (
    event: IpcMainInvokeEvent,
    authority: RendererAuthority,
    intent: { data: WorkspacePromoteArguments },
  ) => {
    const before = deps.daemonResources.state();
    if (before.status !== "connected") {
      return WorkspacePromoteHostResultSchemaZ.parse({
        status: "error",
        error: disconnectedCapabilityError(before),
      });
    }
    const request = WorkspacePromoteMutationRequestSchemaZ.parse({
      operationId: randomUUID(),
      expectedDaemonInstanceId: before.identity.instanceId,
      intent: intent.data,
    });
    try {
      const result = await deps.daemonResources.promoteWorkspace(request);
      try {
        assertRendererAuthority(event, authority.generation);
      } catch {
        return WorkspacePromoteHostResultSchemaZ.parse({
          status: "error",
          error: daemonCapabilityError("disposed"),
        });
      }
      const after = deps.daemonResources.state();
      if (
        after.status !== "connected" ||
        !sameDaemonIdentity(before.identity, after.identity) ||
        result.operationId !== request.operationId ||
        result.daemonInstanceId !== request.expectedDaemonInstanceId
      ) {
        return WorkspacePromoteHostResultSchemaZ.parse({
          status: "error",
          error: daemonCapabilityError("daemon-identity-mismatch"),
        });
      }
      return WorkspacePromoteHostResultSchemaZ.parse({ status: "ok", result });
    } catch (error) {
      try {
        assertRendererAuthority(event, authority.generation);
      } catch {
        return WorkspacePromoteHostResultSchemaZ.parse({
          status: "error",
          error: daemonCapabilityError("disposed"),
        });
      }
      // A typed daemon verdict (session_not_adopted, workspace_conflict, a
      // promotion_verification_failed reason, …) is forwarded verbatim so the
      // dialog can render its specific reason; only a genuine transport failure
      // falls through to the generic request-failed line.
      const promotionFailure = workspacePromotionFailureFromUnknown(error);
      if (promotionFailure) {
        return WorkspacePromoteHostResultSchemaZ.parse({
          status: "error",
          error: promotionFailure,
        });
      }
      return WorkspacePromoteHostResultSchemaZ.parse({
        status: "error",
        error: daemonCapabilityError("request-failed"),
      });
    }
  };

  /**
   * The one daemon hop.
   *
   * Every resource arrives here, is validated once against the closed union,
   * and is dispatched on its tag. What did NOT collapse is semantics: each
   * mutation keeps its own before/after identity comparison, its own error
   * vocabulary, and its own renderer-generation recheck, because those differ
   * per resource and always did. Only the plumbing was ever duplicated.
   */
  handle(HOST_IPC.daemonRequest, async (event, ...args) => {
    const authority = trustedRendererAuthority(event);
    if (args.length !== 1) throw new Error("desktop daemon request was invalid");
    const named = args[0];
    const kind =
      typeof named === "object" && named !== null
        ? (named as { resource?: unknown }).resource
        : undefined;
    // An unnamed or unknown resource is not a refusable request — there is no
    // vocabulary to refuse it in — so it is rejected outright.
    if (!isDaemonResourceKind(kind)) {
      throw new Error("desktop daemon request named an unknown resource");
    }
    const parsed = DaemonResourceRequestSchemaZ.safeParse(named);
    if (!parsed.success) return invalidDaemonRequestResult(kind);
    const daemonRequest = parsed.data;
    switch (daemonRequest.resource) {
      case "capabilities":
        return capabilities(event, authority.generation);
      case "refreshConnection":
        return refreshConnection(event, authority.generation);
      case "startupReadiness":
        return startupReadiness(event, authority.generation);
      case "listWorkspaces":
        return readResource(event, authority.generation, () =>
          deps.daemonResources.listWorkspaces(),
        );
      case "fetchFleetCatalog":
        return readResource(event, authority.generation, () =>
          deps.daemonResources.fetchFleetCatalog(),
        );
      case "fetchWidgetAsset":
        return readResource(event, authority.generation, () =>
          deps.daemonResources.fetchWidgetAsset(daemonRequest.request),
        );
      case "fetchApplicationShell":
        return readResource(event, authority.generation, () =>
          deps.daemonResources.fetchApplicationShell(
            daemonRequest.request.workspaceName,
            daemonRequest.request.resourceVersion,
          ),
        );
      case "fetchWorkspaceFiles":
        return readResource(event, authority.generation, () =>
          deps.daemonResources.fetchWorkspaceFiles(daemonRequest.request),
        );
      case "fetchWorkspaceFilePreview":
        return readResource(event, authority.generation, () =>
          deps.daemonResources.fetchWorkspaceFilePreview(daemonRequest.request),
        );
      case "fetchWorkspaceChanges":
        return readResource(event, authority.generation, () =>
          deps.daemonResources.fetchWorkspaceChanges(daemonRequest.request),
        );
      case "fetchWorkspaceChangeDiff":
        return readResource(event, authority.generation, () =>
          deps.daemonResources.fetchWorkspaceChangeDiff(daemonRequest.request),
        );
      case "fetchWorkspaceMissions":
        return readResource(event, authority.generation, () =>
          deps.daemonResources.fetchWorkspaceMissions(daemonRequest.request),
        );
      case "promoteWorkspace":
        return promoteWorkspace(event, authority, { data: daemonRequest.request });
      case "createWorkspacePane":
        return createWorkspacePane(event, authority, { data: daemonRequest.request });
      case "mutateAppWindow":
        return mutateAppWindow(event, authority, { data: daemonRequest.request });
      case "invokeVerb":
        return invokeVerb(event, authority, { data: daemonRequest.request });
      case "issueTerminalAttachment":
        return issueTerminalAttachment(event, authority, { data: daemonRequest.request });
      case "issuePaneStream":
        return issuePaneStream(event, authority, { data: daemonRequest.request });
    }
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
    const result = await deps.daemonResources.subscribe(request.data, (daemonEvent) => {
      const window = currentAuthorityWindow(authority.generation);
      if (!window) return;
      window.webContents.send(
        HOST_IPC.daemonEvent,
        DesktopDaemonEventWireEnvelopeSchemaZ.parse({ subscriptionId, event: daemonEvent }),
      );
    });
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

export function publishUpdateStatus(
  window: BrowserWindow | null,
  status: DesktopUpdateStatus,
): void {
  if (window && !window.isDestroyed()) {
    window.webContents.send(HOST_IPC.updateStatusChanged, DesktopUpdateStatusSchemaZ.parse(status));
  }
}
