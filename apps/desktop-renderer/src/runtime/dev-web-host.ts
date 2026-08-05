/**
 * A `HostCapabilities` implementation for a plain browser tab (m44.2).
 *
 * In production the Electron preload publishes `window.tmuxIdeHost`, and every
 * daemon call crosses the main-process broker. This module is the development
 * twin of that broker: it speaks the same daemon HTTP routes and the same
 * WebSockets from inside the page, so the renderer can be driven by an
 * app-level browser test suite without Electron. It is selected only when
 * {@link resolveDevWebHostConfig} says so — see `dev-web-host-config.ts` for
 * the fail-closed activation policy, and `../../DEV-WEB-HOST.md` for the run
 * recipe.
 *
 * What is deliberately NOT rebuilt here: retry supervision, generation
 * bookkeeping, capacity policy, and the credential boundary that keeps the
 * owner bearer out of the renderer. Those are production concerns of the
 * Electron broker. Here the harness already holds the owner token — it started
 * the daemon — so the honest simplification is to send it directly rather than
 * to simulate a privilege boundary that does not exist in this mode.
 *
 * Reuse note: the response contracts come from `@tmux-ide/contracts`, the same
 * zod schemas the broker parses with, so a wire change breaks both. The broker
 * class itself lives in `apps/electron-shell` and depends on Node `ws` and the
 * main-process supervisor, so it is not importable from the renderer.
 */
import {
  APPLICATION_SHELL_RESOURCE_V3_VERSION,
  ApplicationShellResourceV3SchemaZ,
  AppWindowMutationResultSchemaZ,
  DaemonEventServerFrameSchemaZ,
  DESKTOP_HOST_API_VERSION,
  DesktopDaemonCapabilitiesResultSchemaZ,
  DesktopDaemonEventSubscriptionRequestSchemaZ,
  DesktopDaemonFetchApplicationShellRequestSchemaZ,
  FleetCatalogResourceV1SchemaZ,
  PANE_STREAM_ISSUE_PATH,
  PANE_STREAM_PROTOCOL_VERSION,
  PaneStreamIssueResultSchemaZ,
  PaneStreamLeaseRequestSchemaZ,
  StartupReadinessResourceSchemaZ,
  TERMINAL_ATTACHMENT_ISSUE_PATH,
  TerminalAttachmentIssueResultSchemaZ,
  WorkspaceCatalogResourceV1SchemaZ,
  WorkspaceChangeDiffEnvelopeV1SchemaZ,
  WorkspaceChangesCatalogEnvelopeV1SchemaZ,
  WorkspaceFilePreviewEnvelopeV1SchemaZ,
  WorkspaceFilesCatalogEnvelopeV1SchemaZ,
  WorkspacePaneCreateMutationResultSchemaZ,
  WorkspacePromoteMutationResultSchemaZ,
  WorkspacePromotionFailureSchemaZ,
  type AppWindowMutationArguments,
  type AppWindowMutationHostResult,
  type DaemonEventServerFrame,
  type DaemonInstanceIdentity,
  type DesktopDaemonCapabilitiesResult,
  type DesktopDaemonCapabilityError,
  type DesktopDaemonCapabilityErrorCode,
  type DesktopDaemonEvent,
  type DesktopDaemonEventSubscriptionRequest,
  type DesktopDaemonFetchApplicationShellRequest,
  type DesktopDaemonFetchApplicationShellResult,
  type DesktopDaemonFetchFleetCatalogResult,
  type DesktopDaemonFetchWorkspaceChangeDiffRequest,
  type DesktopDaemonFetchWorkspaceChangeDiffResult,
  type DesktopDaemonFetchWorkspaceChangesRequest,
  type DesktopDaemonFetchWorkspaceChangesResult,
  type DesktopDaemonFetchWorkspaceFilePreviewRequest,
  type DesktopDaemonFetchWorkspaceFilePreviewResult,
  type DesktopDaemonFetchWorkspaceFilesRequest,
  type DesktopDaemonFetchWorkspaceFilesResult,
  type DesktopDaemonHostSubscriptionResult,
  type DesktopDaemonListWorkspacesResult,
  type DesktopDaemonRefreshConnectionResult,
  type DesktopHostBootstrap,
  type DesktopPlatform,
  type DesktopThemeState,
  type DesktopWindowState,
  type HostCapabilities,
  type PaneStreamIssueResult,
  type PaneStreamLeaseRequest,
  type StartupReadinessLadder,
  type TerminalAttachRequest,
  type TerminalAttachmentIssueResult,
  type WorkspacePaneCreateHostResult,
  type WorkspacePaneCreateInvocation,
  type WorkspacePromoteArguments,
  type WorkspacePromoteHostResult,
} from "@tmux-ide/contracts";
import { z } from "zod";

import type { DevWebHostConfig } from "./dev-web-host-config.ts";

const REQUEST_TIMEOUT_MS = 5_000;
const PROMOTE_TIMEOUT_MS = 15_000;
const EVENTS_PATH = "/ws/events";

function capabilityError(
  code: DesktopDaemonCapabilityErrorCode,
  reason: string,
): DesktopDaemonCapabilityError {
  return { code, reason };
}

const REQUEST_FAILED = capabilityError("request-failed", "The daemon request failed.");
const INVALID_RESPONSE = capabilityError("invalid-response", "The daemon response was invalid.");
const INVALID_REQUEST = capabilityError("invalid-request", "The request was invalid.");
const DISPOSED = capabilityError("disposed", "The development host was disposed.");

class DevHostFailure extends Error {
  constructor(readonly error: DesktopDaemonCapabilityError) {
    super(error.reason);
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

export function sameIdentity(
  left: DaemonInstanceIdentity | null,
  right: DaemonInstanceIdentity | null,
): boolean {
  if (!left || !right) return false;
  return (
    left.instanceId === right.instanceId &&
    left.startedAt === right.startedAt &&
    left.protocolVersion === right.protocolVersion &&
    left.productVersion === right.productVersion
  );
}

export interface DevWorkspaceCatalogEntry {
  readonly workspaceName: string;
  readonly sessionName: string;
}

function shellEventsForSession(
  catalog: readonly DevWorkspaceCatalogEntry[],
  sessionName: string,
): DesktopDaemonEvent[] {
  return catalog
    .filter((entry) => entry.sessionName === sessionName)
    .map((entry) => ({ type: "application-shell.changed", workspaceName: entry.workspaceName }));
}

function shellEventsForEveryWorkspace(
  catalog: readonly DevWorkspaceCatalogEntry[],
): DesktopDaemonEvent[] {
  return catalog.map((entry) => ({
    type: "application-shell.changed",
    workspaceName: entry.workspaceName,
  }));
}

/**
 * Project one daemon wire frame onto the renderer-safe invalidations the stores
 * consume, given the workspace catalog that maps a raw tmux session name back
 * to a workspace. This mirrors the production broker's projection — the daemon
 * speaks session names, the renderer only ever hears workspace names — so a
 * browser session refreshes on exactly the same signals an Electron session
 * does. Frames the renderer has no resource for (init output, keepalives)
 * project to nothing.
 */
export function projectDaemonServerFrame(
  frame: DaemonEventServerFrame,
  catalog: readonly DevWorkspaceCatalogEntry[],
): readonly DesktopDaemonEvent[] {
  switch (frame.type) {
    case "snapshot":
    case "config.changed":
    case "terminals.changed":
      return shellEventsForSession(catalog, frame.sessionName);
    case "agent-status.changed":
      // Session-scoped ground truth refreshes that session's shell AND the
      // whole fleet catalog, whose opaque session ids do not map back to a
      // tmux session name here.
      return [...shellEventsForSession(catalog, frame.sessionName), { type: "fleet.changed" }];
    case "fleet.changed":
      return [{ type: "fleet.changed" }];
    case "workspace.added":
    case "workspace.removed":
      return [{ type: "workspaces.changed" }];
    case "sessions.changed":
    case "projects.changed":
    case "action.complete":
      return [{ type: "workspaces.changed" }, ...shellEventsForEveryWorkspace(catalog)];
    case "protocol.error":
      return [
        {
          type: "connection.changed",
          state: "degraded",
          error: capabilityError("protocol-error", "The daemon reported a protocol error."),
        },
      ];
    default:
      return [];
  }
}

interface DevWebHost extends HostCapabilities {
  /** Tear down the event socket and abort every in-flight request. */
  dispose(): void;
}

export function createDevWebHostCapabilities(config: DevWebHostConfig): DevWebHost {
  const controllers = new Set<AbortController>();
  const listeners = new Set<(event: DesktopDaemonEvent) => void>();
  let identity: DaemonInstanceIdentity | null = null;
  // The session-name → workspace-name map the event projection needs. Refreshed
  // by every catalog read; an empty cache simply projects fewer shell events
  // until the first read lands.
  let catalogCache: readonly DevWorkspaceCatalogEntry[] = [];
  let socket: WebSocket | null = null;
  let socketVerified = false;
  let disposed = false;

  const url = (pathname: string): string => `${config.daemonOrigin}${pathname}`;

  async function request(
    pathname: string,
    init: { readonly method: "GET" | "POST"; readonly body?: unknown },
    extraHeaders: Readonly<Record<string, string>> = {},
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    if (disposed) throw new DevHostFailure(DISPOSED);
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url(pathname), {
        method: init.method,
        headers: {
          ...extraHeaders,
          accept: "application/json",
          Authorization: `Bearer ${config.ownerToken}`,
          ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new DevHostFailure(
          response.status === 404
            ? capabilityError("workspace-not-found", "The requested resource is unavailable.")
            : REQUEST_FAILED,
        );
      }
      return await response.json();
    } catch (error) {
      if (error instanceof DevHostFailure) throw error;
      throw new DevHostFailure(disposed ? DISPOSED : REQUEST_FAILED);
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
    }
  }

  /**
   * The daemon's own startup readiness ladder, or null.
   *
   * Diagnostics only, and treated as such: it is bounded by the shared request
   * timeout, every failure answers null, and a null simply leaves the renderer
   * with what it could observe for itself.
   */
  async function readStartupReadinessLadder(): Promise<StartupReadinessLadder | null> {
    try {
      const parsed = StartupReadinessResourceSchemaZ.safeParse(
        await request("/api/resources/startup-readiness", { method: "GET" }),
      );
      return parsed.success ? parsed.data.ladder : null;
    } catch {
      return null;
    }
  }

  function failureOf(error: unknown): DesktopDaemonCapabilityError {
    if (error instanceof DevHostFailure) return error.error;
    return disposed ? DISPOSED : REQUEST_FAILED;
  }

  /**
   * The daemon identity, read once per generation from the owner-gated
   * capabilities route. Every resource read is checked against it, exactly as
   * the production broker does, so a daemon restart mid-session surfaces as a
   * generation mismatch instead of silently mixing two generations.
   */
  async function loadIdentity(): Promise<DaemonInstanceIdentity> {
    if (identity) return identity;
    const result = DesktopDaemonCapabilitiesResultSchemaZ.parse(
      await request("/api/v2/capabilities", { method: "POST", body: {} }),
    );
    if (result.status !== "ok") throw new DevHostFailure(result.error);
    identity = result.daemon;
    return identity;
  }

  function requireIdentity(): DaemonInstanceIdentity {
    if (!identity) {
      throw new DevHostFailure(
        capabilityError("daemon-unavailable", "The daemon generation is unknown."),
      );
    }
    return identity;
  }

  async function workspaceCatalog(): Promise<readonly DevWorkspaceCatalogEntry[]> {
    const parsed = WorkspaceCatalogResourceV1SchemaZ.safeParse(
      await request("/api/resources/workspace-catalog", { method: "GET" }),
    );
    if (!parsed.success) throw new DevHostFailure(INVALID_RESPONSE);
    if (!sameIdentity(parsed.data.daemon, requireIdentity())) {
      throw new DevHostFailure(
        capabilityError("daemon-identity-mismatch", "The daemon generation changed."),
      );
    }
    catalogCache = parsed.data.workspaces.map(({ workspaceName, sessionName }) => ({
      workspaceName,
      sessionName,
    }));
    return catalogCache;
  }

  async function catalogEntryFor(workspaceName: string): Promise<DevWorkspaceCatalogEntry> {
    const entry = (await workspaceCatalog()).find(
      (candidate) => candidate.workspaceName === workspaceName,
    );
    if (!entry) {
      throw new DevHostFailure(
        capabilityError("workspace-not-found", "The workspace is not in the catalog."),
      );
    }
    return entry;
  }

  /**
   * Read one per-workspace resource. `segment` picks which name the route is
   * keyed on — the daemon is NOT uniform here: `application-shell` is addressed
   * by raw tmux session name, while files/changes and their detail routes are
   * addressed by workspace name. Getting this wrong is a silent 404, not a
   * typed refusal, so both callers name their choice explicitly.
   */
  async function workspaceResource<Schema extends z.ZodType>(
    workspaceName: string,
    segment: "sessionName" | "workspaceName",
    pathname: (encodedName: string) => string,
    schema: Schema,
  ): Promise<
    | { status: "ok"; envelope: z.infer<Schema> }
    | { status: "error"; error: DesktopDaemonCapabilityError }
  > {
    try {
      await loadIdentity();
      const entry = await catalogEntryFor(workspaceName);
      const parsed = schema.safeParse(
        await request(pathname(encodeURIComponent(entry[segment])), { method: "GET" }),
      );
      if (!parsed.success) throw new DevHostFailure(INVALID_RESPONSE);
      return { status: "ok", envelope: parsed.data };
    } catch (error) {
      return { status: "error", error: failureOf(error) };
    }
  }

  async function action(
    command: string,
    intent: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    return request(
      `/api/v2/action/${command}`,
      { method: "POST", body: intent },
      { "X-Tmux-Ide-Operation-Id": crypto.randomUUID() },
      timeoutMs,
    );
  }

  function emit(event: DesktopDaemonEvent): void {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // A listener fault must not stop the rest of the fan-out.
      }
    }
  }

  /**
   * One shared event socket for every subscriber, mirroring the production
   * broker's single-connection rule. It carries no credential: `/ws/events`
   * authenticates the peer by daemon generation in its `hello` frame, and the
   * daemon publishes only non-secret invalidations over it.
   */
  function ensureSocket(): void {
    if (disposed || socket || listeners.size === 0) return;
    const next = new WebSocket(`${config.daemonWebSocketOrigin}${EVENTS_PATH}`);
    socket = next;
    socketVerified = false;
    next.addEventListener("message", (event) => {
      if (socket !== next || typeof event.data !== "string") return;
      let raw: unknown;
      try {
        raw = JSON.parse(event.data);
      } catch {
        return;
      }
      const frame = DaemonEventServerFrameSchemaZ.safeParse(raw);
      if (!frame.success) return;
      if (!socketVerified) {
        if (frame.data.type !== "hello" || !sameIdentity(frame.data.daemon, identity)) {
          next.close(1008, "daemon generation mismatch");
          return;
        }
        socketVerified = true;
        // `connection.changed` only. `transport.changed` is the production
        // supervisor's own retry machine reporting itself; this host has no
        // such machine, and publishing a fake phase would make the renderer
        // defer to a supervisor that does not exist instead of running its own
        // bounded recovery.
        emit({ type: "connection.changed", state: "live", error: null });
        return;
      }
      if (frame.data.type === "hello") return;
      for (const mapped of projectDaemonServerFrame(frame.data, catalogCache)) emit(mapped);
    });
    next.addEventListener("close", () => {
      if (socket !== next) return;
      socket = null;
      socketVerified = false;
      if (disposed) return;
      emit({
        type: "connection.changed",
        state: "degraded",
        error: capabilityError("event-unavailable", "The daemon event connection closed."),
      });
    });
    next.addEventListener("error", () => {
      if (socket === next) next.close();
    });
  }

  function releaseSocket(): void {
    const current = socket;
    socket = null;
    socketVerified = false;
    current?.close(1000, "no subscribers");
  }

  const capabilities: DevWebHost = {
    apiVersion: DESKTOP_HOST_API_VERSION,
    bootstrap: async (): Promise<DesktopHostBootstrap> => {
      let daemon: DesktopHostBootstrap["daemon"];
      try {
        daemon = { status: "connected", identity: await loadIdentity() };
      } catch (error) {
        const failure = failureOf(error);
        // Browser mode carries the daemon's own readiness ladder for the same
        // reason the Electron shell does: the daemon may be answering while the
        // app still cannot use it, and only its ladder knows which rung stalled.
        const startupReadiness = await readStartupReadinessLadder();
        daemon = {
          status: "unavailable",
          code: "probe-failed",
          reason: failure.reason,
          ...(startupReadiness ? { startupReadiness } : {}),
        };
      }
      return {
        apiVersion: DESKTOP_HOST_API_VERSION,
        runtime: "browser",
        platform: browserPlatform(),
        appVersion: "dev-web-host",
        theme: browserTheme(),
        window: browserWindowState(),
        daemon,
        onboarding: { introAcknowledged: true },
      };
    },
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
    workspace: {
      // A browser tab has no native directory picker with a real filesystem
      // path, and the daemon will not accept a renderer-authored one.
      openProjectDirectory: async () => null,
    },
    onboarding: {
      acknowledgeIntro: async () => undefined,
    },
    theme: {
      getState: async () => browserTheme(),
      onChanged: subscribeMedia,
    },
    update: {
      getStatus: async () => ({
        phase: "idle",
        currentVersion: "dev-web-host",
        availableVersion: null,
      }),
      onStatusChanged: () => () => undefined,
    },
    daemon: {
      capabilities: async (): Promise<DesktopDaemonCapabilitiesResult> => {
        try {
          const result = DesktopDaemonCapabilitiesResultSchemaZ.parse(
            await request("/api/v2/capabilities", { method: "POST", body: {} }),
          );
          if (result.status === "ok") identity = result.daemon;
          return result;
        } catch (error) {
          return { status: "error", error: failureOf(error) };
        }
      },
      mutateAppWindow: async (
        intent: AppWindowMutationArguments,
      ): Promise<AppWindowMutationHostResult> => {
        try {
          const envelope = z
            .object({ ok: z.literal(true), result: AppWindowMutationResultSchemaZ })
            .strict()
            .parse(await action("workspace.app-window.mutate", intent));
          return { status: "ok", result: envelope.result };
        } catch (error) {
          return { status: "error", error: failureOf(error) };
        }
      },
      createWorkspacePane: async (
        invocation: WorkspacePaneCreateInvocation,
      ): Promise<WorkspacePaneCreateHostResult> => {
        try {
          const envelope = z
            .object({ ok: z.literal(true), result: WorkspacePaneCreateMutationResultSchemaZ })
            .strict()
            .parse(await action("workspace.pane.create", invocation));
          return { status: "ok", result: envelope.result };
        } catch (error) {
          return { status: "error", error: failureOf(error) };
        }
      },
      promoteWorkspace: async (
        intent: WorkspacePromoteArguments,
      ): Promise<WorkspacePromoteHostResult> => {
        try {
          const raw = await action("workspace.promote", intent, PROMOTE_TIMEOUT_MS);
          const refusal = z
            .object({ ok: z.literal(false), error: WorkspacePromotionFailureSchemaZ })
            .safeParse(raw);
          if (refusal.success) return { status: "error", error: refusal.data.error };
          const envelope = z
            .object({ ok: z.literal(true), result: WorkspacePromoteMutationResultSchemaZ })
            .strict()
            .parse(raw);
          return { status: "ok", result: envelope.result };
        } catch (error) {
          return { status: "error", error: failureOf(error) };
        }
      },
      issueTerminalAttachment: async (
        attachRequest: TerminalAttachRequest,
      ): Promise<TerminalAttachmentIssueResult> => {
        try {
          const requestId = crypto.randomUUID();
          const daemonInstanceId = (await loadIdentity()).instanceId;
          return TerminalAttachmentIssueResultSchemaZ.parse(
            await request(
              TERMINAL_ATTACHMENT_ISSUE_PATH,
              {
                method: "POST",
                body: {
                  requestId,
                  expectedDaemonInstanceId: daemonInstanceId,
                  attachment: attachRequest,
                },
              },
              {
                "X-Tmux-Ide-Request-Id": requestId,
                "X-Tmux-Ide-Expected-Daemon-Instance-Id": daemonInstanceId,
              },
            ),
          );
        } catch {
          return {
            status: "error",
            error: {
              code: "attachment-unavailable",
              reason: "The terminal attachment issue failed.",
              retryable: true,
            },
          };
        }
      },
      issuePaneStream: async (
        leaseRequest: PaneStreamLeaseRequest,
      ): Promise<PaneStreamIssueResult> => {
        try {
          const stream = PaneStreamLeaseRequestSchemaZ.parse({
            ...leaseRequest,
            protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
          });
          const requestId = crypto.randomUUID();
          const daemonInstanceId = (await loadIdentity()).instanceId;
          return PaneStreamIssueResultSchemaZ.parse(
            await request(
              PANE_STREAM_ISSUE_PATH,
              {
                method: "POST",
                body: { requestId, expectedDaemonInstanceId: daemonInstanceId, stream },
              },
              {
                "X-Tmux-Ide-Request-Id": requestId,
                "X-Tmux-Ide-Expected-Daemon-Instance-Id": daemonInstanceId,
              },
            ),
          );
        } catch {
          return {
            status: "error",
            error: {
              code: "stream-unavailable",
              reason: "The pane-stream issue failed.",
              retryable: true,
            },
          };
        }
      },
      refreshConnection: async (): Promise<DesktopDaemonRefreshConnectionResult> => {
        const previous = identity;
        identity = null;
        try {
          const next = await loadIdentity();
          if (previous && !sameIdentity(previous, next)) {
            return {
              outcome: "generation-replaced",
              previousIdentity: previous,
              daemon: { status: "connected", identity: next },
            };
          }
          return { outcome: "unchanged", daemon: { status: "connected", identity: next } };
        } catch (error) {
          const failure = failureOf(error);
          const daemon = {
            status: "unavailable" as const,
            code: "probe-failed" as const,
            reason: failure.reason,
          };
          return previous
            ? { outcome: "authority-retired", previousIdentity: previous, daemon }
            : { outcome: "state-changed", daemon };
        }
      },
      listWorkspaces: async (): Promise<DesktopDaemonListWorkspacesResult> => {
        try {
          await loadIdentity();
          const workspaces = (await workspaceCatalog()).map(({ workspaceName }) => ({
            workspaceName,
          }));
          return { status: "ok", daemon: requireIdentity(), workspaces };
        } catch (error) {
          return { status: "error", error: failureOf(error) };
        }
      },
      fetchFleetCatalog: async (): Promise<DesktopDaemonFetchFleetCatalogResult> => {
        try {
          await loadIdentity();
          const parsed = FleetCatalogResourceV1SchemaZ.safeParse(
            await request("/api/resources/fleet-catalog", { method: "GET" }),
          );
          if (!parsed.success) throw new DevHostFailure(INVALID_RESPONSE);
          if (!sameIdentity(parsed.data.daemon, requireIdentity())) {
            throw new DevHostFailure(
              capabilityError("daemon-identity-mismatch", "The daemon generation changed."),
            );
          }
          return { status: "ok", envelope: parsed.data };
        } catch (error) {
          return { status: "error", error: failureOf(error) };
        }
      },
      fetchApplicationShell: async (
        shellRequest: DesktopDaemonFetchApplicationShellRequest,
      ): Promise<DesktopDaemonFetchApplicationShellResult> => {
        const parsed = DesktopDaemonFetchApplicationShellRequestSchemaZ.safeParse(shellRequest);
        if (!parsed.success) return { status: "error", error: INVALID_REQUEST };
        try {
          await loadIdentity();
        } catch (error) {
          return { status: "error", error: failureOf(error) };
        }
        const version = parsed.data.resourceVersion ?? APPLICATION_SHELL_RESOURCE_V3_VERSION;
        return workspaceResource(
          parsed.data.workspaceName,
          "sessionName",
          (name) => `/api/project/${name}/application-shell?version=${version}`,
          ApplicationShellResourceV3SchemaZ,
        );
      },
      fetchWorkspaceFiles: async (
        filesRequest: DesktopDaemonFetchWorkspaceFilesRequest,
      ): Promise<DesktopDaemonFetchWorkspaceFilesResult> => {
        const query = filesRequest.directoryId
          ? `?directoryId=${encodeURIComponent(filesRequest.directoryId)}`
          : "";
        return workspaceResource(
          filesRequest.workspaceName,
          "workspaceName",
          (name) => `/api/project/${name}/files${query}`,
          WorkspaceFilesCatalogEnvelopeV1SchemaZ,
        );
      },
      fetchWorkspaceFilePreview: async (
        previewRequest: DesktopDaemonFetchWorkspaceFilePreviewRequest,
      ): Promise<DesktopDaemonFetchWorkspaceFilePreviewResult> =>
        workspaceResource(
          previewRequest.workspaceName,
          "workspaceName",
          (name) =>
            `/api/project/${name}/file-preview?fileId=${encodeURIComponent(previewRequest.fileId)}`,
          WorkspaceFilePreviewEnvelopeV1SchemaZ,
        ),
      fetchWorkspaceChanges: async (
        changesRequest: DesktopDaemonFetchWorkspaceChangesRequest,
      ): Promise<DesktopDaemonFetchWorkspaceChangesResult> =>
        workspaceResource(
          changesRequest.workspaceName,
          "workspaceName",
          (name) => `/api/project/${name}/changes`,
          WorkspaceChangesCatalogEnvelopeV1SchemaZ,
        ),
      fetchWorkspaceChangeDiff: async (
        diffRequest: DesktopDaemonFetchWorkspaceChangeDiffRequest,
      ): Promise<DesktopDaemonFetchWorkspaceChangeDiffResult> =>
        workspaceResource(
          diffRequest.workspaceName,
          "workspaceName",
          (name) =>
            `/api/project/${name}/change-diff?changeId=${encodeURIComponent(diffRequest.changeId)}`,
          WorkspaceChangeDiffEnvelopeV1SchemaZ,
        ),
      subscribe: async (
        subscriptionRequest: DesktopDaemonEventSubscriptionRequest,
        listener: (event: DesktopDaemonEvent) => void,
      ): Promise<DesktopDaemonHostSubscriptionResult> => {
        if (disposed) return { status: "error", error: DISPOSED };
        if (!DesktopDaemonEventSubscriptionRequestSchemaZ.safeParse(subscriptionRequest).success) {
          return { status: "error", error: INVALID_REQUEST };
        }
        try {
          await loadIdentity();
        } catch (error) {
          return { status: "error", error: failureOf(error) };
        }
        listeners.add(listener);
        ensureSocket();
        // A subscriber joining an ALREADY-verified socket would otherwise never
        // hear that the connection is live — `connection.changed` fires once,
        // at handshake — and its surface would sit in the "event socket is not
        // connected" fallback forever. Replay the current state to the new
        // listener only, after the caller holds its unsubscribe handle.
        if (socketVerified) {
          queueMicrotask(() => {
            if (listeners.has(listener)) {
              listener({ type: "connection.changed", state: "live", error: null });
            }
          });
        }
        return {
          status: "subscribed",
          unsubscribe: () => {
            listeners.delete(listener);
            if (listeners.size === 0) releaseSocket();
          },
        };
      },
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      releaseSocket();
      for (const controller of controllers) controller.abort();
      controllers.clear();
    },
  };
  return capabilities;
}
