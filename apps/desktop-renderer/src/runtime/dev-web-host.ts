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
 * The host uses the renderer-neutral runtime supervisor shared with OpenTUI for
 * its long-lived event connection. The same-origin development gateway owns the
 * reusable daemon bearer and rewrites the one-use terminal sockets back onto
 * the page origin, so browser JavaScript has the same credential boundary as a
 * packaged client. Direct mode remains only as a compatibility path for older
 * harnesses.
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
  WorkspaceMultiplexerMutationResultSchemaZ,
  DaemonEventServerFrameSchemaZ,
  DESKTOP_HOST_API_VERSION,
  DesktopDaemonCapabilitiesResultSchemaZ,
  DesktopDaemonEventSubscriptionRequestSchemaZ,
  FleetCatalogResourceV1SchemaZ,
  PANE_STREAM_ISSUE_PATH,
  PANE_STREAM_PROTOCOL_VERSION,
  PaneStreamIssueResultSchemaZ,
  PaneStreamLeaseRequestSchemaZ,
  StartupReadinessResourceSchemaZ,
  TERMINAL_ATTACHMENT_ISSUE_PATH,
  TerminalAttachmentIssueResultSchemaZ,
  WorkspaceCatalogResourceV2SchemaZ,
  WorkspaceChangeDiffEnvelopeV1SchemaZ,
  WorkspaceChangesCatalogEnvelopeV1SchemaZ,
  WorkspaceFilePreviewEnvelopeV1SchemaZ,
  WorkspaceFilesCatalogEnvelopeV1SchemaZ,
  WorkspaceMissionsEnvelopeV1SchemaZ,
  WorkspacePaneCreateMutationResultSchemaZ,
  WorkspacePromoteMutationResultSchemaZ,
  WorkspacePromotionFailureSchemaZ,
  WidgetAssetSchemaZ,
  createDaemonResourceMethods,
  daemonWorkspaceRouteName,
  type DaemonEventServerFrame,
  type DaemonEventResourceInterest,
  type DaemonInstanceIdentity,
  type DaemonResourceRequest,
  type DaemonWorkspaceResourceKind,
  type DesktopDaemonCapabilityError,
  type DesktopDaemonCapabilityErrorCode,
  type DesktopDaemonEvent,
  type DesktopDaemonEventSubscriptionRequest,
  type DesktopDaemonHostSubscriptionResult,
  type DesktopHostBootstrap,
  type DesktopPlatform,
  type DesktopThemeState,
  type DesktopWindowState,
  type HostCapabilities,
  type StartupReadinessLadder,
} from "@tmux-ide/contracts";
import {
  advanceResourceReplica,
  initialResourceReplica,
  type ResourceReplicaState,
} from "@tmux-ide/daemon-client/resource-replica";
import { z } from "zod";
import {
  createRuntimeConnectionSupervisor,
  type RuntimeConnection,
  type RuntimeConnectionSupervisor,
} from "@tmux-ide/daemon-client/connection-supervisor";

import { developmentWebSocketUrl, type DevWebHostConfig } from "./dev-web-host-config.ts";
import {
  browserWebSocketHandshakeUrl,
  installBrowserWebSocketUrlRewriter,
} from "./browser-websocket-session.ts";
import { browserInitiatedWebSocketCloseCode } from "../browser-websocket.ts";

const REQUEST_TIMEOUT_MS = 5_000;
const PROMOTE_TIMEOUT_MS = 15_000;
const EVENTS_PATH = "/ws/events";
const MAX_EVENT_FRAME_BYTES = 512 * 1024;

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

/** Route one-use redemption sockets through the same-origin dev gateway. */
function browserWebSocketUrl(config: DevWebHostConfig, daemonUrl: string): string {
  if (config.transport === "direct") return daemonUrl;
  const parsed = new URL(daemonUrl);
  return `${config.daemonWebSocketOrigin}${parsed.pathname}${parsed.search}`;
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
  daemonInstanceId?: string,
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
    case "resource.changed":
      if (frame.resource === "application-shell") {
        const changed = (workspaceName: string): DesktopDaemonEvent => ({
          type: "application-shell.changed",
          workspaceName,
          ...(daemonInstanceId
            ? {
                daemonInstanceId,
                sequence: frame.sequence,
                revision: frame.revision,
                causeOperationId: frame.causeOperationId,
              }
            : {}),
        });
        return frame.workspaceName === null
          ? catalog.map((entry) => changed(entry.workspaceName))
          : catalog.some((entry) => entry.workspaceName === frame.workspaceName)
            ? [changed(frame.workspaceName)]
            : [];
      }
      if (frame.resource === "fleet-catalog") return [{ type: "fleet.changed" }];
      if (
        frame.resource === "workspace-files" ||
        frame.resource === "workspace-changes" ||
        frame.resource === "workspace-missions"
      ) {
        if (!daemonInstanceId) return [{ type: "workspaces.changed" }];
        const changed = (workspaceName: string): DesktopDaemonEvent => {
          const metadata = {
            workspaceName,
            daemonInstanceId,
            sequence: frame.sequence,
            revision: frame.revision,
            causeOperationId: frame.causeOperationId,
          };
          if (frame.resource === "workspace-files") {
            return { type: "workspace-files.changed", ...metadata };
          }
          if (frame.resource === "workspace-changes") {
            return { type: "workspace-changes.changed", ...metadata };
          }
          return { type: "workspace-missions.changed", ...metadata };
        };
        return frame.workspaceName === null
          ? catalog.map((entry) => changed(entry.workspaceName))
          : catalog.some((entry) => entry.workspaceName === frame.workspaceName)
            ? [changed(frame.workspaceName)]
            : [];
      }
      return [{ type: "workspaces.changed" }];
    case "resource.observed":
      return [];
    case "interaction.receipt":
      return catalog.some((entry) => entry.workspaceName === frame.workspaceName) ? [frame] : [];
    case "snapshot-required":
      return [{ type: "workspaces.changed" }, ...shellEventsForEveryWorkspace(catalog)];
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
  const subscriptions = new Map<
    number,
    {
      readonly request: DesktopDaemonEventSubscriptionRequest;
      readonly listener: (event: DesktopDaemonEvent) => void;
      readyRevision: number | null;
      readySettled: boolean;
      readySuccess: DesktopDaemonHostSubscriptionResult | null;
      readonly resolveReady: ((result: DesktopDaemonHostSubscriptionResult) => void) | null;
    }
  >();
  let nextSubscriptionId = 0;
  let identity: DaemonInstanceIdentity | null = null;
  // The session-name → workspace-name map the event projection needs. Refreshed
  // by every catalog read; an empty cache simply projects fewer shell events
  // until the first read lands.
  let catalogCache: readonly DevWorkspaceCatalogEntry[] = [];
  let socketVerified = false;
  let eventSocket: WebSocket | null = null;
  let sentSessions = new Set<string>();
  let sentInterests = new Map<string, DaemonEventResourceInterest>();
  let sentInterestMode: "unsent" | "legacy" | "explicit" = "unsent";
  let eventCursorSent = false;
  let eventSocketSemantic = false;
  let nextInterestRevision = 0;
  let lastSentInterestRevision = 0;
  let lastAckedInterestRevision = 0;
  const unavailableInterestKeys = new Set<string>();
  let eventSocketEpoch = 0;
  let eventReplica: ResourceReplicaState<null> = initialResourceReplica();
  let socketSupervisor: RuntimeConnectionSupervisor<true> | null = null;
  let stopSocketStateSubscription: (() => void) | null = null;
  let disposed = false;
  // Legacy direct mode already exposes the owner bearer to this page. Its
  // weaker trust boundary still gets a stable document identity so issue and
  // action routes never fall back to anonymous SDK authority.
  const directHostClientId =
    config.transport === "direct" ? `dev-web-direct:${crypto.randomUUID()}` : null;
  type DevHostSessionLease = { readonly generation: number; readonly token: string };
  let resolvedDevHostSession: DevHostSessionLease | null = null;
  const uninstallWebSocketSession = installBrowserWebSocketUrlRewriter((rawUrl) => {
    if (config.transport !== "same-origin-gateway") return rawUrl;
    const parsed = new URL(rawUrl);
    const privileged =
      parsed.origin === config.daemonWebSocketOrigin &&
      (parsed.pathname.startsWith("/ws/") ||
        parsed.pathname === "/v1/terminal/attachments/redeem" ||
        parsed.pathname === "/v1/terminal/pane-streams/redeem");
    if (!privileged) return rawUrl;
    if (!resolvedDevHostSession) throw new DevHostFailure(REQUEST_FAILED);
    return developmentWebSocketUrl(rawUrl, resolvedDevHostSession.token);
  });
  type DevHostSessionBootstrap = {
    readonly generation: number;
    readonly controller: AbortController;
    promise: Promise<DevHostSessionLease> | null;
    waiters: number;
    settled: boolean;
  };
  let nextDevHostSessionGeneration = 0;
  let devHostSession: DevHostSessionBootstrap | null = null;
  const takeEmbeddedDevHostSession = (): string | null => {
    if (config.transport !== "same-origin-gateway" || typeof document === "undefined") return null;
    const element = document.querySelector<HTMLMetaElement>(
      'meta[name="tmux-ide-dev-host-session"]',
    );
    const parsed = z.uuid().safeParse(element?.content);
    element?.remove();
    return parsed.success ? parsed.data : null;
  };
  let embeddedDevHostSession = takeEmbeddedDevHostSession();
  const useGatewayXmlHttpRequest = embeddedDevHostSession !== null;
  const httpRequest = (input: string, init: RequestInit): Promise<Response> => {
    if (!useGatewayXmlHttpRequest) return fetch(input, init);
    return new Promise<Response>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        init.signal?.removeEventListener("abort", abort);
        action();
      };
      const abort = (): void => {
        xhr.abort();
        finish(() => reject(new DOMException("The request was aborted", "AbortError")));
      };
      if (init.signal?.aborted) {
        abort();
        return;
      }
      xhr.open(init.method ?? "GET", input);
      const headers = new Headers(init.headers);
      headers.forEach((value, name) => xhr.setRequestHeader(name, value));
      xhr.addEventListener("load", () => {
        finish(() => {
          const responseHeaders = new Headers();
          for (const line of xhr
            .getAllResponseHeaders()
            .trim()
            .split(/[\r\n]+/u)) {
            const separator = line.indexOf(":");
            if (separator <= 0) continue;
            responseHeaders.append(
              line.slice(0, separator).trim(),
              line.slice(separator + 1).trim(),
            );
          }
          resolve(
            new Response(xhr.responseText, {
              status: xhr.status,
              statusText: xhr.statusText,
              headers: responseHeaders,
            }),
          );
        });
      });
      xhr.addEventListener("error", () =>
        finish(() => reject(new TypeError("The development gateway request failed"))),
      );
      xhr.addEventListener("abort", () =>
        finish(() => reject(new DOMException("The request was aborted", "AbortError"))),
      );
      init.signal?.addEventListener("abort", abort, { once: true });
      xhr.send(typeof init.body === "string" ? init.body : null);
    });
  };
  const loadDevHostSession = (
    staleGeneration: number | null = null,
    signal?: AbortSignal,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<DevHostSessionLease | null> => {
    if (config.transport !== "same-origin-gateway") return Promise.resolve(null);
    if (signal?.aborted) return Promise.reject(new DevHostFailure(DISPOSED));
    let bootstrap = devHostSession;
    // A stale caller replaces only the generation it actually used. If a
    // concurrent HTTP or WebSocket caller has already begun a newer refresh,
    // join that refresh instead of aborting it or minting another capability.
    if (staleGeneration !== null && bootstrap && bootstrap.generation <= staleGeneration) {
      bootstrap = null;
    }
    if (!bootstrap) {
      const controller = new AbortController();
      const generation = ++nextDevHostSessionGeneration;
      const record: DevHostSessionBootstrap = {
        generation,
        controller,
        promise: null,
        waiters: 0,
        settled: false,
      };
      if (
        staleGeneration !== null &&
        resolvedDevHostSession !== null &&
        resolvedDevHostSession.generation <= staleGeneration
      ) {
        resolvedDevHostSession = null;
      }
      devHostSession = record;
      const pending = (async () => {
        try {
          if (embeddedDevHostSession !== null) {
            const token = embeddedDevHostSession;
            embeddedDevHostSession = null;
            const lease = { generation, token };
            if (devHostSession !== record || disposed) throw new DevHostFailure(DISPOSED);
            resolvedDevHostSession = lease;
            return lease;
          }
          const response = await httpRequest(`${config.daemonOrigin}/api/dev/host-session`, {
            method: "POST",
            cache: "no-store",
            credentials: "omit",
            signal: controller.signal,
          });
          if (!response.ok) {
            console.warn(
              `[tmux-ide] development host session request failed -> ${response.status}`,
            );
            throw new DevHostFailure(REQUEST_FAILED);
          }
          const token = z
            .object({ token: z.uuid() })
            .strict()
            .parse(await response.json()).token;
          if (controller.signal.aborted) throw new DevHostFailure(DISPOSED);
          const lease = { generation, token };
          if (devHostSession !== record || disposed) throw new DevHostFailure(DISPOSED);
          resolvedDevHostSession = lease;
          return lease;
        } finally {
          record.settled = true;
        }
      })();
      record.promise = pending;
      bootstrap = record;
      // A failed bootstrap is not a permanent poison pill for this document.
      void pending.catch(() => {
        if (devHostSession === record) devHostSession = null;
      });
    }
    const current = bootstrap;
    const currentPromise = current.promise;
    if (currentPromise === null) return Promise.reject(new DevHostFailure(REQUEST_FAILED));
    current.waiters += 1;
    return new Promise<DevHostSessionLease | null>((resolve, reject) => {
      let active = true;
      const timer = setTimeout(() => timeout(), timeoutMs);
      const finish = (): boolean => {
        if (!active) return false;
        active = false;
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        current.waiters = Math.max(0, current.waiters - 1);
        return true;
      };
      const abortPhysicalIfLast = (): void => {
        if (!current.settled && current.waiters === 0 && devHostSession === current) {
          current.controller.abort();
        }
      };
      const cancel = (): void => {
        if (!finish()) return;
        abortPhysicalIfLast();
        reject(new DevHostFailure(DISPOSED));
      };
      const timeout = (): void => {
        if (!finish()) return;
        abortPhysicalIfLast();
        reject(new DevHostFailure(REQUEST_FAILED));
      };
      signal?.addEventListener("abort", cancel, { once: true });
      void currentPromise.then(
        (value) => {
          if (finish()) resolve(value);
        },
        (error) => {
          if (finish()) reject(error);
        },
      );
    });
  };

  const url = (pathname: string): string => `${config.daemonOrigin}${pathname}`;

  async function request(
    pathname: string,
    init: { readonly method: "GET" | "POST"; readonly body?: unknown },
    extraHeaders: Readonly<Record<string, string>> = {},
    timeoutMs = REQUEST_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (disposed) throw new DevHostFailure(DISPOSED);
    if (signal?.aborted) throw new DevHostFailure(DISPOSED);
    const controller = new AbortController();
    let abortCause: "caller" | "deadline" | null = null;
    const cancel = () => {
      if (abortCause === null) abortCause = "caller";
      controller.abort();
    };
    signal?.addEventListener("abort", cancel, { once: true });
    controllers.add(controller);
    const timer = setTimeout(() => {
      if (abortCause === null) abortCause = "deadline";
      controller.abort();
    }, timeoutMs);
    try {
      let hostSession = await loadDevHostSession(null, controller.signal, timeoutMs);
      const gatewayLogicalGet = config.transport === "same-origin-gateway" && init.method === "GET";
      const wireMethod = gatewayLogicalGet ? "POST" : init.method;
      const wireHeaders = {
        ...extraHeaders,
        ...(gatewayLogicalGet ? { "X-Tmux-Ide-Dev-Original-Method": "GET" } : {}),
        ...(hostSession ? { "X-Tmux-Ide-Dev-Host-Session": hostSession.token } : {}),
        ...(directHostClientId ? { "X-Tmux-Ide-Host-Client-Id": directHostClientId } : {}),
        accept: "application/json",
        ...(config.ownerToken ? { Authorization: `Bearer ${config.ownerToken}` } : {}),
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      };
      let response = await httpRequest(url(pathname), {
        method: wireMethod,
        headers: wireHeaders,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
      });
      const staleGatewaySession =
        !response.ok &&
        config.transport === "same-origin-gateway" &&
        response.status === 401 &&
        z
          .object({ code: z.literal("dev_host_session_invalid") })
          .passthrough()
          .safeParse(
            await response
              .clone()
              .json()
              .catch(() => null),
          ).success;
      if (staleGatewaySession) {
        hostSession = await loadDevHostSession(
          hostSession?.generation ?? null,
          controller.signal,
          timeoutMs,
        );
        response = await httpRequest(url(pathname), {
          method: wireMethod,
          headers: {
            ...extraHeaders,
            ...(gatewayLogicalGet ? { "X-Tmux-Ide-Dev-Original-Method": "GET" } : {}),
            ...(hostSession ? { "X-Tmux-Ide-Dev-Host-Session": hostSession.token } : {}),
            ...(directHostClientId ? { "X-Tmux-Ide-Host-Client-Id": directHostClientId } : {}),
            accept: "application/json",
            ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          signal: controller.signal,
        });
      }
      if (!response.ok) {
        console.warn(
          `[tmux-ide] development daemon request failed: ${init.method} ${pathname} -> ${response.status}`,
        );
        throw new DevHostFailure(
          response.status === 404
            ? capabilityError("workspace-not-found", "The requested resource is unavailable.")
            : REQUEST_FAILED,
        );
      }
      return await response.json();
    } catch (error) {
      if (error instanceof DevHostFailure) {
        if (error.error.code === "disposed" && abortCause === "deadline" && !disposed) {
          throw new DevHostFailure(REQUEST_FAILED);
        }
        throw error;
      }
      throw new DevHostFailure(disposed || abortCause === "caller" ? DISPOSED : REQUEST_FAILED);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
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
  async function readStartupReadinessLadder(
    signal?: AbortSignal,
  ): Promise<StartupReadinessLadder | null> {
    try {
      const parsed = StartupReadinessResourceSchemaZ.safeParse(
        await request(
          "/api/resources/startup-readiness",
          { method: "GET" },
          {},
          REQUEST_TIMEOUT_MS,
          signal,
        ),
      );
      return parsed.success ? parsed.data.ladder : null;
    } catch (error) {
      if (failureOf(error).code === "disposed") throw error;
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
  async function loadIdentity(signal?: AbortSignal): Promise<DaemonInstanceIdentity> {
    if (identity) return identity;
    const rawResult = await request(
      "/api/v2/capabilities",
      { method: "POST", body: {} },
      {},
      REQUEST_TIMEOUT_MS,
      signal,
    );
    const parsedResult = DesktopDaemonCapabilitiesResultSchemaZ.safeParse(rawResult);
    if (!parsedResult.success) {
      throw new DevHostFailure(INVALID_RESPONSE);
    }
    const result = parsedResult.data;
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

  async function workspaceCatalog(
    signal?: AbortSignal,
  ): Promise<readonly DevWorkspaceCatalogEntry[]> {
    const parsed = WorkspaceCatalogResourceV2SchemaZ.safeParse(
      await request(
        "/api/resources/workspace-catalog?version=2",
        { method: "GET" },
        {},
        REQUEST_TIMEOUT_MS,
        signal,
      ),
    );
    if (!parsed.success) throw new DevHostFailure(INVALID_RESPONSE);
    if (!sameIdentity(parsed.data.daemon, requireIdentity())) {
      throw new DevHostFailure(
        capabilityError("daemon-identity-mismatch", "The daemon generation changed."),
      );
    }
    catalogCache = parsed.data.intents
      .filter(({ availability }) => availability === "live")
      .map(({ workspaceName, sessionName }) => ({ workspaceName, sessionName }));
    sendEventSubscriptionDelta();
    return catalogCache;
  }

  async function catalogEntryFor(
    workspaceName: string,
    signal?: AbortSignal,
  ): Promise<DevWorkspaceCatalogEntry> {
    const entry = (await workspaceCatalog(signal)).find(
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
   * Read one per-workspace resource.
   *
   * Which catalog name the route is keyed on is NOT decided here. The daemon is
   * not uniform — `application-shell` takes a raw tmux session name while
   * files/changes take a workspace name — and a wrong choice is a silent 404,
   * not a typed refusal. That choice lives once, in the contracts route-key
   * table, and this host reads it by resource rather than restating it.
   */
  async function workspaceResource<Schema extends z.ZodType>(
    resource: DaemonWorkspaceResourceKind,
    workspaceName: string,
    pathname: (encodedName: string) => string,
    schema: Schema,
    signal?: AbortSignal,
  ): Promise<
    | { status: "ok"; envelope: z.infer<Schema> }
    | { status: "error"; error: DesktopDaemonCapabilityError }
  > {
    try {
      await loadIdentity(signal);
      const entry = await catalogEntryFor(workspaceName, signal);
      const routeName = daemonWorkspaceRouteName(resource, entry);
      const parsed = schema.safeParse(
        await request(
          pathname(encodeURIComponent(routeName)),
          { method: "GET" },
          {},
          REQUEST_TIMEOUT_MS,
          signal,
        ),
      );
      if (!parsed.success) throw new DevHostFailure(INVALID_RESPONSE);
      return { status: "ok", envelope: parsed.data };
    } catch (error) {
      return { status: "error", error: failureOf(error) };
    }
  }

  const ActionErrorEnvelopeSchemaZ = z.object({
    ok: z.literal(false),
    error: z.object({ code: z.string().min(1), message: z.string().min(1) }).loose(),
  });

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

  const interestKey = (interest: DaemonEventResourceInterest): string =>
    `${interest.resource}\0${interest.workspaceName ?? "global"}`;

  function requiredEventSessions(): Set<string> {
    const workspaces = new Set(
      [...subscriptions.values()].flatMap(({ request }) => request.workspaceNames),
    );
    return new Set(
      catalogCache
        .filter(({ workspaceName }) => workspaces.has(workspaceName))
        .map(({ sessionName }) => sessionName),
    );
  }

  function requiredEventInterests(): Map<string, DaemonEventResourceInterest> {
    const required = new Map<string, DaemonEventResourceInterest>();
    for (const { request } of subscriptions.values()) {
      if (request.resourceInterests === undefined) continue;
      for (const interest of request.resourceInterests)
        required.set(interestKey(interest), interest);
    }
    return required;
  }

  const requiresSemanticEvents = (): boolean =>
    [...subscriptions.values()].some(({ request }) => request.resourceInterests !== undefined);
  const requiresLegacyEvents = (): boolean =>
    [...subscriptions.values()].some(({ request }) => request.resourceInterests === undefined);
  const desiredSemanticMode = (): boolean => requiresSemanticEvents() && !requiresLegacyEvents();

  function eventInterest(event: DesktopDaemonEvent): DaemonEventResourceInterest | null {
    if (event.type === "workspaces.changed")
      return { resource: "workspace-catalog", workspaceName: null };
    if (event.type === "fleet.changed") return { resource: "fleet-catalog", workspaceName: null };
    if (event.type === "application-shell.changed" || event.type === "interaction.receipt") {
      return { resource: "application-shell", workspaceName: event.workspaceName };
    }
    if (event.type === "workspace-files.changed")
      return { resource: "workspace-files", workspaceName: event.workspaceName };
    if (event.type === "workspace-changes.changed")
      return { resource: "workspace-changes", workspaceName: event.workspaceName };
    if (event.type === "workspace-missions.changed")
      return { resource: "workspace-missions", workspaceName: event.workspaceName };
    return null;
  }

  function emit(event: DesktopDaemonEvent): void {
    for (const { request, listener } of [...subscriptions.values()]) {
      const interest = eventInterest(event);
      if (request.resourceInterests === undefined) {
        if (
          interest?.workspaceName !== null &&
          interest?.workspaceName !== undefined &&
          !request.workspaceNames.includes(interest.workspaceName)
        )
          continue;
      } else if (
        interest !== null &&
        !request.resourceInterests.some(
          (candidate) => interestKey(candidate) === interestKey(interest),
        )
      )
        continue;
      try {
        listener(event);
      } catch {
        // A listener fault must not stop the rest of the fan-out.
      }
    }
  }

  function establishEventCursor(daemonInstanceId: string, sequence: number): void {
    eventReplica = advanceResourceReplica(eventReplica, {
      type: "connected",
      daemonInstanceId,
    }).state;
    eventReplica = advanceResourceReplica(eventReplica, {
      type: "snapshot",
      daemonInstanceId,
      sequence,
      revision: sequence,
      value: null,
    }).state;
  }

  /**
   * One shared event socket for every subscriber, mirroring the production
   * broker's single-connection rule. It carries no credential: `/ws/events`
   * authenticates the peer by daemon generation in its `hello` frame, and the
   * daemon publishes only non-secret invalidations over it.
   */
  function sendEventSubscriptionDelta(): void {
    if (!eventSocket) return;
    const requiredSessions = requiredEventSessions();
    const requiredInterests = requiredEventInterests();
    if (eventSocketSemantic !== desiredSemanticMode()) {
      releaseSocket();
      ensureSocket();
      return;
    }
    const removedSessions = [...sentSessions].filter((name) => !requiredSessions.has(name));
    const addedSessions = [...requiredSessions].filter((name) => !sentSessions.has(name));
    const removedInterests = [...sentInterests]
      .filter(([key]) => !requiredInterests.has(key))
      .map(([, interest]) => interest);
    for (const interest of removedInterests) unavailableInterestKeys.delete(interestKey(interest));
    const addedInterests = [...requiredInterests]
      .filter(([key]) => !sentInterests.has(key))
      .map(([, interest]) => interest);
    if (!eventSocketSemantic && !requiresSemanticEvents()) {
      if (removedSessions.length > 0) {
        eventSocket.send(JSON.stringify({ type: "unsubscribe", sessions: removedSessions }));
      }
      if (addedSessions.length > 0 || !eventCursorSent) {
        eventSocket.send(
          JSON.stringify({
            type: "subscribe",
            sessions: addedSessions,
            ...(!eventCursorSent ? { afterSequence: eventReplica.sequence ?? 0 } : {}),
          }),
        );
        eventCursorSent = true;
      }
      sentSessions = requiredSessions;
      return;
    }
    const legacyEvents = requiresLegacyEvents();
    const legacyChanged =
      sentInterestMode === "unsent" ||
      (legacyEvents ? sentInterestMode !== "legacy" : sentInterestMode !== "explicit");
    let emittedRevision = 0;
    if (removedSessions.length > 0 || removedInterests.length > 0) {
      emittedRevision = ++nextInterestRevision;
      eventSocket.send(
        JSON.stringify({
          type: "unsubscribe",
          sessions: removedSessions,
          interests: removedInterests,
          legacyEvents,
          interestRevision: emittedRevision,
        }),
      );
    }
    if (
      addedSessions.length > 0 ||
      addedInterests.length > 0 ||
      !eventCursorSent ||
      legacyChanged
    ) {
      emittedRevision = ++nextInterestRevision;
      eventSocket.send(
        JSON.stringify({
          type: "subscribe",
          sessions: addedSessions,
          interests: addedInterests,
          legacyEvents,
          interestRevision: emittedRevision,
          ...(!eventCursorSent ? { afterSequence: eventReplica.sequence ?? 0 } : {}),
        }),
      );
      eventCursorSent = true;
    }
    sentSessions = requiredSessions;
    sentInterests = new Map(requiredInterests);
    sentInterestMode = legacyEvents ? "legacy" : "explicit";
    if (emittedRevision > 0) lastSentInterestRevision = emittedRevision;
    for (const subscription of subscriptions.values()) {
      if (subscription.readySettled || subscription.resolveReady === null) continue;
      subscription.readyRevision ??= lastSentInterestRevision;
      if (lastAckedInterestRevision >= subscription.readyRevision && subscription.readySuccess) {
        subscription.readySettled = true;
        subscription.resolveReady(subscription.readySuccess);
      }
    }
  }

  function ensureSocket(): void {
    if (disposed || socketSupervisor || subscriptions.size === 0) return;
    const supervisor = createRuntimeConnectionSupervisor<true>({
      connect: ({ signal }) => connectEventSocket(signal),
    });
    socketSupervisor = supervisor;
    stopSocketStateSubscription = supervisor.subscribe((state) => {
      if (socketSupervisor !== supervisor || disposed) return;
      socketVerified = state.phase === "live";
      if (state.phase === "live") {
        emit({ type: "connection.changed", state: "live", error: null });
      } else if (state.phase === "reconnecting") {
        emit({
          type: "connection.changed",
          state: "degraded",
          error: capabilityError(
            "event-unavailable",
            `The daemon event connection is reconnecting (attempt ${state.attempt}).`,
          ),
        });
      } else if (state.phase === "failed") {
        emit({
          type: "connection.changed",
          state: "degraded",
          error: capabilityError("event-unavailable", "The daemon event connection failed."),
        });
      }
    });
    supervisor.start();
  }

  async function connectEventSocket(signal: AbortSignal): Promise<RuntimeConnection<true>> {
    const eventHostSession = await loadDevHostSession(null, signal);
    if (signal.aborted || disposed) throw new DevHostFailure(DISPOSED);
    return new Promise((resolve, reject) => {
      const attemptEpoch = ++eventSocketEpoch;
      eventSocketSemantic = desiredSemanticMode();
      const eventsPath = eventSocketSemantic ? `${EVENTS_PATH}?mode=semantic` : EVENTS_PATH;
      const next = new WebSocket(
        browserWebSocketHandshakeUrl(
          browserWebSocketUrl(config, `${config.daemonWebSocketOrigin}${eventsPath}`),
        ),
      );
      let helloVerified = false;
      let connected = false;
      let resourceEventsSupported = false;
      let closedResolve!: (reason: unknown) => void;
      const closed = new Promise<unknown>((settle) => {
        closedResolve = settle;
      });
      const dispose = () => next.close(1000, "connection supervisor stopped");
      const finishConnected = (): void => {
        if (connected) return;
        connected = true;
        socketVerified = true;
        resolve({ value: true, closed, dispose });
      };
      signal.addEventListener("abort", dispose, { once: true });
      next.addEventListener("message", (event) => {
        if (attemptEpoch !== eventSocketEpoch) return;
        if (
          typeof event.data !== "string" ||
          new TextEncoder().encode(event.data).byteLength > MAX_EVENT_FRAME_BYTES
        ) {
          next.close(browserInitiatedWebSocketCloseCode(1009), "event frame is too large");
          return;
        }
        let raw: unknown;
        try {
          raw = JSON.parse(event.data);
        } catch {
          next.close(browserInitiatedWebSocketCloseCode(1002), "malformed event frame");
          return;
        }
        const frame = DaemonEventServerFrameSchemaZ.safeParse(raw);
        if (!frame.success) {
          next.close(browserInitiatedWebSocketCloseCode(1002), "invalid event frame");
          return;
        }
        if (!helloVerified) {
          if (frame.data.type !== "hello" || !sameIdentity(frame.data.daemon, identity)) {
            next.close(browserInitiatedWebSocketCloseCode(1008), "daemon generation mismatch");
            return;
          }
          const resumeSequence =
            eventReplica.daemonInstanceId === frame.data.daemon.instanceId
              ? (eventReplica.sequence ?? 0)
              : 0;
          establishEventCursor(frame.data.daemon.instanceId, resumeSequence);
          resourceEventsSupported = frame.data.eventSequence !== undefined;
          eventSocket = next;
          sentSessions = new Set();
          sentInterests = new Map();
          sentInterestMode = "unsent";
          eventCursorSent = false;
          lastSentInterestRevision = 0;
          lastAckedInterestRevision = 0;
          unavailableInterestKeys.clear();
          helloVerified = true;
          sendEventSubscriptionDelta();
          if (lastSentInterestRevision === 0) finishConnected();
          return;
        }
        if (frame.data.type === "hello") {
          next.close(browserInitiatedWebSocketCloseCode(1002), "duplicate daemon hello");
          return;
        }
        if (frame.data.type === "resource.interests-ack") {
          const transition = advanceResourceReplica(eventReplica, {
            type: "observed",
            daemonInstanceId: requireIdentity().instanceId,
            sequence: frame.data.sequence,
          });
          eventReplica = transition.state;
          if (transition.effects.some((effect) => effect.type === "request-snapshot")) {
            for (const mapped of projectDaemonServerFrame(
              {
                type: "snapshot-required",
                afterSequence: Math.max(0, frame.data.sequence - 1),
                oldestAvailableSequence: null,
                currentSequence: frame.data.sequence,
                reason: "journal-gap",
              },
              catalogCache,
            ))
              emit(mapped);
            establishEventCursor(requireIdentity().instanceId, frame.data.sequence);
          }
          lastAckedInterestRevision = Math.max(
            lastAckedInterestRevision,
            frame.data.interestRevision,
          );
          const unavailable = new Set(frame.data.unavailableInterests.map(interestKey));
          for (const key of unavailable) unavailableInterestKeys.add(key);
          for (const subscription of subscriptions.values()) {
            if (
              subscription.readySettled ||
              subscription.readyRevision === null ||
              subscription.readyRevision > frame.data.interestRevision
            )
              continue;
            subscription.readySettled = true;
            const failed = (subscription.request.resourceInterests ?? []).some((interest) =>
              unavailableInterestKeys.has(interestKey(interest)),
            );
            subscription.resolveReady?.(
              failed
                ? {
                    status: "error",
                    error: capabilityError(
                      "event-unavailable",
                      "The daemon resource observer is unavailable.",
                    ),
                  }
                : (subscription.readySuccess ?? { status: "error", error: DISPOSED }),
            );
          }
          if (frame.data.interestRevision >= lastSentInterestRevision) {
            const unavailableRequired = [...requiredEventInterests().keys()].some((key) =>
              unavailableInterestKeys.has(key),
            );
            if (unavailableRequired) {
              next.close(
                browserInitiatedWebSocketCloseCode(1011),
                "daemon resource observer unavailable",
              );
            } else {
              finishConnected();
            }
          }
          return;
        }
        if (frame.data.type === "snapshot-required") {
          eventReplica = advanceResourceReplica(eventReplica, {
            type: "gap",
            daemonInstanceId: requireIdentity().instanceId,
            sequence: frame.data.currentSequence,
          }).state;
          for (const mapped of projectDaemonServerFrame(frame.data, catalogCache)) emit(mapped);
          establishEventCursor(requireIdentity().instanceId, frame.data.currentSequence);
          return;
        }
        if (frame.data.type === "resource.changed") {
          const previousSequence = eventReplica.sequence;
          const transition = advanceResourceReplica(eventReplica, {
            type: "changed",
            daemonInstanceId: requireIdentity().instanceId,
            sequence: frame.data.sequence,
            revision: frame.data.revision,
            ...(frame.data.causeOperationId
              ? { causeOperationId: frame.data.causeOperationId }
              : {}),
          });
          eventReplica = transition.state;
          if (transition.effects.some((effect) => effect.type === "request-snapshot")) {
            for (const mapped of projectDaemonServerFrame(
              {
                type: "snapshot-required",
                afterSequence: previousSequence ?? 0,
                oldestAvailableSequence: null,
                currentSequence: frame.data.sequence,
                reason: "journal-gap",
              },
              catalogCache,
            ))
              emit(mapped);
            establishEventCursor(requireIdentity().instanceId, frame.data.sequence);
            return;
          }
          if (frame.data.sequence <= (previousSequence ?? -1)) return;
        }
        if (frame.data.type === "resource.observed") {
          const transition = advanceResourceReplica(eventReplica, {
            type: "observed",
            daemonInstanceId: requireIdentity().instanceId,
            sequence: frame.data.sequence,
          });
          eventReplica = transition.state;
          if (transition.effects.some((effect) => effect.type === "request-snapshot")) {
            for (const mapped of projectDaemonServerFrame(
              {
                type: "snapshot-required",
                afterSequence: Math.max(0, frame.data.sequence - 1),
                oldestAvailableSequence: null,
                currentSequence: frame.data.sequence,
                reason: "journal-gap",
              },
              catalogCache,
            ))
              emit(mapped);
            establishEventCursor(requireIdentity().instanceId, frame.data.sequence);
          }
          return;
        }
        if (frame.data.type === "interaction.receipt") {
          const transition = advanceResourceReplica(eventReplica, {
            type: "observed",
            daemonInstanceId: requireIdentity().instanceId,
            sequence: frame.data.sequence,
          });
          eventReplica = transition.state;
          if (transition.effects.some((effect) => effect.type === "request-snapshot")) {
            for (const mapped of projectDaemonServerFrame(
              {
                type: "snapshot-required",
                afterSequence: Math.max(0, frame.data.sequence - 1),
                oldestAvailableSequence: null,
                currentSequence: frame.data.sequence,
                reason: "journal-gap",
              },
              catalogCache,
            ))
              emit(mapped);
            establishEventCursor(requireIdentity().instanceId, frame.data.sequence);
            return;
          }
        }
        if (
          frame.data.type === "action.complete" &&
          resourceEventsSupported &&
          frame.data.name.startsWith("workspace.")
        ) {
          return;
        }
        for (const mapped of projectDaemonServerFrame(
          frame.data,
          catalogCache,
          requireIdentity().instanceId,
        ))
          emit(mapped);
      });
      next.addEventListener("close", (event) => {
        if (attemptEpoch !== eventSocketEpoch) return;
        eventSocketEpoch += 1;
        if (eventSocket === next) {
          eventSocket = null;
          sentSessions.clear();
          sentInterests.clear();
          sentInterestMode = "unsent";
          eventCursorSent = false;
        }
        signal.removeEventListener("abort", dispose);
        const reason = new Error(event.reason || `daemon event socket closed (${event.code})`);
        if (connected) closedResolve(reason);
        else {
          if (config.transport === "same-origin-gateway" && !signal.aborted) {
            // A gateway handshake cannot expose its HTTP 401 to browser JS.
            // Replace the document capability before the supervisor retries.
            void loadDevHostSession(eventHostSession?.generation ?? null).catch(() => undefined);
          }
          reject(reason);
        }
      });
      next.addEventListener("error", () => {
        if (attemptEpoch === eventSocketEpoch) next.close();
      });
    });
  }

  function releaseSocket(): void {
    eventSocketEpoch += 1;
    const current = socketSupervisor;
    socketSupervisor = null;
    socketVerified = false;
    eventSocket = null;
    sentSessions.clear();
    sentInterests.clear();
    sentInterestMode = "unsent";
    eventCursorSent = false;
    lastSentInterestRevision = 0;
    lastAckedInterestRevision = 0;
    unavailableInterestKeys.clear();
    stopSocketStateSubscription?.();
    stopSocketStateSubscription = null;
    void current?.stop();
  }

  /**
   * The whole daemon surface, as one dispatch over the request union.
   *
   * This replaces fifteen hand-written methods that between them re-derived the
   * identity check, the failure mapping, and the route keying. The production
   * broker answers the same union in Electron main; the two hosts now differ in
   * transport and credential custody, which is the honest difference, rather
   * than in how many resources each of them remembered to implement.
   */
  async function dispatchDaemonResource(
    daemonRequest: DaemonResourceRequest,
    signal?: AbortSignal,
  ): Promise<unknown> {
    switch (daemonRequest.resource) {
      case "capabilities":
        try {
          const result = DesktopDaemonCapabilitiesResultSchemaZ.parse(
            await request(
              "/api/v2/capabilities",
              { method: "POST", body: {} },
              {},
              REQUEST_TIMEOUT_MS,
              signal,
            ),
          );
          if (result.status === "ok") identity = result.daemon;
          return result;
        } catch (error) {
          return { status: "error", error: failureOf(error) };
        }
      case "refreshConnection": {
        const previous = identity;
        identity = null;
        try {
          const next = await loadIdentity(signal);
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
      }
      case "startupReadiness": {
        try {
          const ladder = await readStartupReadinessLadder(signal);
          return ladder === null
            ? {
                status: "error",
                error: capabilityError("daemon-unavailable", "No readiness ladder was readable."),
              }
            : { status: "ok", ladder };
        } catch (error) {
          return { status: "error", error: failureOf(error) };
        }
      }
      case "listWorkspaces":
        try {
          await loadIdentity(signal);
          const workspaces = (await workspaceCatalog(signal)).map(({ workspaceName }) => ({
            workspaceName,
          }));
          return { status: "ok", daemon: requireIdentity(), workspaces };
        } catch (error) {
          return { status: "error", error: failureOf(error) };
        }
      case "fetchFleetCatalog":
        try {
          await loadIdentity(signal);
          const parsed = FleetCatalogResourceV1SchemaZ.safeParse(
            await request(
              "/api/resources/fleet-catalog",
              { method: "GET" },
              {},
              REQUEST_TIMEOUT_MS,
              signal,
            ),
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
      case "fetchWidgetAsset":
        try {
          await loadIdentity(signal);
          const asset = WidgetAssetSchemaZ.parse(
            await request(
              `/api/widget-assets/${encodeURIComponent(daemonRequest.request.assetId)}`,
              {
                method: "GET",
              },
              {},
              REQUEST_TIMEOUT_MS,
              signal,
            ),
          );
          return { status: "ok", asset };
        } catch (error) {
          return { status: "error", error: failureOf(error) };
        }
      case "fetchApplicationShell": {
        try {
          await loadIdentity(signal);
        } catch (error) {
          return { status: "error", error: failureOf(error) };
        }
        const version =
          daemonRequest.request.resourceVersion ?? APPLICATION_SHELL_RESOURCE_V3_VERSION;
        return workspaceResource(
          "fetchApplicationShell",
          daemonRequest.request.workspaceName,
          (name) => `/api/project/${name}/application-shell?version=${version}`,
          ApplicationShellResourceV3SchemaZ,
          signal,
        );
      }
      case "fetchWorkspaceFiles": {
        const query = daemonRequest.request.directoryId
          ? `?directoryId=${encodeURIComponent(daemonRequest.request.directoryId)}`
          : "";
        return workspaceResource(
          "fetchWorkspaceFiles",
          daemonRequest.request.workspaceName,
          (name) => `/api/project/${name}/files${query}`,
          WorkspaceFilesCatalogEnvelopeV1SchemaZ,
          signal,
        );
      }
      case "fetchWorkspaceFilePreview": {
        const fileId = encodeURIComponent(daemonRequest.request.fileId);
        return workspaceResource(
          "fetchWorkspaceFilePreview",
          daemonRequest.request.workspaceName,
          (name) => `/api/project/${name}/file-preview?fileId=${fileId}`,
          WorkspaceFilePreviewEnvelopeV1SchemaZ,
          signal,
        );
      }
      case "fetchWorkspaceChanges":
        return workspaceResource(
          "fetchWorkspaceChanges",
          daemonRequest.request.workspaceName,
          (name) => `/api/project/${name}/changes`,
          WorkspaceChangesCatalogEnvelopeV1SchemaZ,
          signal,
        );
      case "fetchWorkspaceChangeDiff": {
        const changeId = encodeURIComponent(daemonRequest.request.changeId);
        return workspaceResource(
          "fetchWorkspaceChangeDiff",
          daemonRequest.request.workspaceName,
          (name) => `/api/project/${name}/change-diff?changeId=${changeId}`,
          WorkspaceChangeDiffEnvelopeV1SchemaZ,
          signal,
        );
      }
      case "fetchWorkspaceMissions":
        return workspaceResource(
          "fetchWorkspaceMissions",
          daemonRequest.request.workspaceName,
          (name) => `/api/project/${name}/missions`,
          WorkspaceMissionsEnvelopeV1SchemaZ,
          signal,
        );
      case "promoteWorkspace":
        try {
          const raw = await action("workspace.promote", daemonRequest.request, PROMOTE_TIMEOUT_MS);
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
      case "createWorkspacePane":
        try {
          const envelope = z
            .object({ ok: z.literal(true), result: WorkspacePaneCreateMutationResultSchemaZ })
            .strict()
            .parse(await action("workspace.pane.create", daemonRequest.request));
          return { status: "ok", result: envelope.result };
        } catch (error) {
          return { status: "error", error: failureOf(error) };
        }
      case "mutateAppWindow":
        try {
          const envelope = z
            .object({ ok: z.literal(true), result: AppWindowMutationResultSchemaZ })
            .strict()
            .parse(await action("workspace.app-window.mutate", daemonRequest.request));
          return { status: "ok", result: envelope.result };
        } catch (error) {
          return { status: "error", error: failureOf(error) };
        }
      case "invokeVerb":
        try {
          // The intent names its own route, so the development host needs no
          // per-verb branch either.
          const { verb, ...args } = daemonRequest.request.intent;
          const answer = await action(verb, args);
          /*
           * A refused verb answers 200 with `{ok:false, error}`, so without this
           * branch the refusal fell through to the envelope parse and reached
           * the user as the generic transport line — the daemon's own sentence,
           * which is the only actionable part, was discarded on the way.
           */
          const refusal = ActionErrorEnvelopeSchemaZ.safeParse(answer);
          if (refusal.success) {
            return {
              status: "error",
              error: {
                code:
                  refusal.data.error.code === "bad_request" ? "invalid-request" : "request-failed",
                reason: refusal.data.error.message.slice(0, 240),
              },
            };
          }
          const envelope = z
            .object({ ok: z.literal(true), result: WorkspaceMultiplexerMutationResultSchemaZ })
            .strict()
            .parse(answer);
          return { status: "ok", result: envelope.result };
        } catch (error) {
          return { status: "error", error: failureOf(error) };
        }
      case "issueTerminalAttachment":
        try {
          const requestId = crypto.randomUUID();
          const daemonInstanceId = (await loadIdentity()).instanceId;
          const issued = TerminalAttachmentIssueResultSchemaZ.parse(
            await request(
              TERMINAL_ATTACHMENT_ISSUE_PATH,
              {
                method: "POST",
                body: {
                  requestId,
                  expectedDaemonInstanceId: daemonInstanceId,
                  attachment: daemonRequest.request,
                },
              },
              {
                "X-Tmux-Ide-Request-Id": requestId,
                "X-Tmux-Ide-Expected-Daemon-Instance-Id": daemonInstanceId,
              },
            ),
          );
          return issued.status === "issued"
            ? TerminalAttachmentIssueResultSchemaZ.parse({
                ...issued,
                descriptor: {
                  ...issued.descriptor,
                  webSocketUrl: browserWebSocketUrl(config, issued.descriptor.webSocketUrl),
                },
              })
            : issued;
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
      case "issuePaneStream":
        try {
          const stream = PaneStreamLeaseRequestSchemaZ.parse({
            ...daemonRequest.request,
            protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
          });
          const requestId = crypto.randomUUID();
          const daemonInstanceId = (await loadIdentity()).instanceId;
          const issued = PaneStreamIssueResultSchemaZ.parse(
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
          return issued.status === "issued"
            ? PaneStreamIssueResultSchemaZ.parse({
                ...issued,
                descriptor: {
                  ...issued.descriptor,
                  webSocketUrl: browserWebSocketUrl(config, issued.descriptor.webSocketUrl),
                },
              })
            : issued;
        } catch {
          return {
            status: "error",
            error: {
              code: "attachment-unavailable",
              reason: "The pane-stream issue failed.",
              retryable: true,
            },
          };
        }
    }
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
    window: {
      minimize: async () => browserWindowState(),
      toggleMaximized: async () => browserWindowState(),
      close: async () => undefined,
      onStateChanged: () => () => undefined,
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
      ...createDaemonResourceMethods(dispatchDaemonResource),
      subscribe: async (
        subscriptionRequest: DesktopDaemonEventSubscriptionRequest,
        listener: (event: DesktopDaemonEvent) => void,
        signal?: AbortSignal,
      ): Promise<DesktopDaemonHostSubscriptionResult> => {
        if (disposed) return { status: "error", error: DISPOSED };
        if (signal?.aborted) return { status: "error", error: DISPOSED };
        if (!DesktopDaemonEventSubscriptionRequestSchemaZ.safeParse(subscriptionRequest).success) {
          return { status: "error", error: INVALID_REQUEST };
        }
        try {
          await loadIdentity(signal);
        } catch (error) {
          return { status: "error", error: failureOf(error) };
        }
        if (disposed || signal?.aborted) return { status: "error", error: DISPOSED };
        const subscriptionId = ++nextSubscriptionId;
        let resolveReady: ((result: DesktopDaemonHostSubscriptionResult) => void) | null = null;
        const ready =
          subscriptionRequest.resourceInterests === undefined
            ? null
            : new Promise<DesktopDaemonHostSubscriptionResult>((resolve) => {
                resolveReady = resolve;
              });
        subscriptions.set(subscriptionId, {
          request: subscriptionRequest,
          listener,
          readyRevision: null,
          readySettled: ready === null,
          readySuccess: null,
          resolveReady,
        });
        const cancelPending = (): void => {
          const pending = subscriptions.get(subscriptionId);
          if (!pending) return;
          subscriptions.delete(subscriptionId);
          if (!pending.readySettled) {
            pending.readySettled = true;
            pending.resolveReady?.({ status: "error", error: DISPOSED });
          }
          if (subscriptions.size === 0) releaseSocket();
          else sendEventSubscriptionDelta();
        };
        signal?.addEventListener("abort", cancelPending, { once: true });
        ensureSocket();
        sendEventSubscriptionDelta();
        // A subscriber joining an ALREADY-verified socket would otherwise never
        // hear that the connection is live — `connection.changed` fires once,
        // at handshake — and its surface would sit in the "event socket is not
        // connected" fallback forever. Replay the current state to the new
        // listener only, after the caller holds its unsubscribe handle.
        if (socketVerified) {
          queueMicrotask(() => {
            if (subscriptions.has(subscriptionId)) {
              listener({ type: "connection.changed", state: "live", error: null });
            }
          });
        }
        const subscribed: DesktopDaemonHostSubscriptionResult = {
          status: "subscribed",
          unsubscribe: () => {
            signal?.removeEventListener("abort", cancelPending);
            subscriptions.delete(subscriptionId);
            if (subscriptions.size === 0) releaseSocket();
            else sendEventSubscriptionDelta();
          },
        };
        const subscription = subscriptions.get(subscriptionId);
        if (subscription) subscription.readySuccess = subscribed;
        if (ready === null) {
          signal?.removeEventListener("abort", cancelPending);
          return signal?.aborted ? { status: "error", error: DISPOSED } : subscribed;
        }
        if (
          subscription &&
          socketVerified &&
          lastSentInterestRevision > 0 &&
          lastAckedInterestRevision >= lastSentInterestRevision
        ) {
          subscription.readySettled = true;
          subscription.resolveReady?.(subscribed);
        }
        let timeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
          const pending = subscriptions.get(subscriptionId);
          if (!pending || pending.readySettled) return;
          pending.readySettled = true;
          pending.resolveReady?.({
            status: "error",
            error: capabilityError(
              "event-unavailable",
              "The daemon resource observer did not become ready in time.",
            ),
          });
        }, REQUEST_TIMEOUT_MS);
        const settled = await ready.finally(() => {
          signal?.removeEventListener("abort", cancelPending);
          if (timeout !== null) clearTimeout(timeout);
          timeout = null;
        });
        if (settled.status === "error") {
          subscriptions.delete(subscriptionId);
          if (subscriptions.size === 0) releaseSocket();
          else sendEventSubscriptionDelta();
        }
        if (signal?.aborted && settled.status === "subscribed") {
          settled.unsubscribe();
          return { status: "error", error: DISPOSED };
        }
        return settled;
      },
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      uninstallWebSocketSession();
      resolvedDevHostSession = null;
      devHostSession?.controller.abort();
      devHostSession = null;
      for (const subscription of subscriptions.values()) {
        if (!subscription.readySettled) {
          subscription.readySettled = true;
          subscription.resolveReady?.({ status: "error", error: DISPOSED });
        }
      }
      subscriptions.clear();
      releaseSocket();
      for (const controller of controllers) controller.abort();
      controllers.clear();
    },
  };
  return capabilities;
}
