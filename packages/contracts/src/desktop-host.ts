import { z } from "zod";
import {
  DaemonChildOutputTailSchemaZ,
  DesktopDaemonHostIssueCodeSchemaZ,
} from "./desktop-daemon-issue.ts";
// The daemon issue vocabulary lives in a leaf module so the readiness ladder
// can read it without importing this file back; it stays part of this contract's
// public surface.
export {
  DAEMON_CHILD_OUTPUT_MAX_LINES,
  DAEMON_CHILD_OUTPUT_MAX_LINE_LENGTH,
  DaemonChildOutputTailSchemaZ,
  DesktopDaemonHostIssueCodeSchemaZ,
} from "./desktop-daemon-issue.ts";
export type { DaemonChildOutputTail, DesktopDaemonHostIssueCode } from "./desktop-daemon-issue.ts";
import { StartupReadinessLadderSchemaZ } from "./startup-readiness.ts";
import {
  APPLICATION_SHELL_RESOURCE_V2_VERSION,
  APPLICATION_SHELL_RESOURCE_V3_VERSION,
  ApplicationShellResourceSchemaZ,
} from "./application-shell-resource.ts";
import { DaemonInstanceIdentitySchemaZ } from "./daemon-wire.ts";
import { CommandAvailabilitySchemaZ } from "./commands.ts";
import type { DesktopUpdateStatus } from "./desktop-update.ts";
import {
  WorkspaceFilePreviewEnvelopeV1SchemaZ,
  WorkspaceFilesCatalogEnvelopeV1SchemaZ,
} from "./workspace-files-resource.ts";
import {
  WorkspaceChangeDiffEnvelopeV1SchemaZ,
  WorkspaceChangesCatalogEnvelopeV1SchemaZ,
} from "./workspace-changes-resource.ts";
import {
  WorkspaceChangeResourceIdSchemaZ,
  WorkspaceFileResourceIdSchemaZ,
} from "./workspace-resource-identity.ts";
import { FleetCatalogResourceV1SchemaZ } from "./fleet-catalog.ts";
import type {
  TerminalAttachRequest,
  TerminalAttachmentIssueResult,
} from "./terminal-attachments.ts";
import type { PaneStreamIssueResult, PaneStreamLeaseRequest } from "./pane-stream.ts";
import type {
  WorkspacePaneCreateHostResult,
  WorkspacePaneCreateInvocation,
} from "./workspace-pane-creation.ts";
import type { WorkspaceOpenHostResult } from "./workspace-open.ts";
import type {
  WorkspacePromoteArguments,
  WorkspacePromoteHostResult,
} from "./workspace-promotion.ts";
import type {
  AppWindowMutationArguments,
  AppWindowMutationHostResult,
} from "./app-window-mutation.ts";

/** Versioned, deliberately narrow bridge exposed by a desktop host preload. */
export const DESKTOP_HOST_API_VERSION = 12 as const;

/** Stable tuple origin for the packaged, sandboxed Electron renderer. */
export const DESKTOP_PACKAGED_RENDERER_SCHEME = "tmux-ide" as const;
export const DESKTOP_PACKAGED_RENDERER_HOST = "app" as const;
export const DESKTOP_PACKAGED_RENDERER_ORIGIN =
  `${DESKTOP_PACKAGED_RENDERER_SCHEME}://${DESKTOP_PACKAGED_RENDERER_HOST}` as const;
export const DESKTOP_PACKAGED_RENDERER_ENTRY_URL =
  `${DESKTOP_PACKAGED_RENDERER_ORIGIN}/index.html` as const;

export const DesktopRuntimeKindSchemaZ = z.enum(["browser", "electron"]);
export const DesktopPlatformSchemaZ = z.enum(["darwin", "linux", "win32", "unknown"]);
export const DesktopThemeModeSchemaZ = z.enum(["light", "dark"]);

export const DesktopThemeStateSchemaZ = z
  .object({
    mode: DesktopThemeModeSchemaZ,
    highContrast: z.boolean(),
    reducedMotion: z.boolean(),
  })
  .strict();

export const DesktopWindowStateSchemaZ = z
  .object({
    maximized: z.boolean(),
    fullscreen: z.boolean(),
    focused: z.boolean(),
  })
  .strict();

const DesktopDaemonLoopbackUrlSchemaZ = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]") &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.pathname === "/" &&
    url.search.length === 0 &&
    url.hash.length === 0
  );
}, "daemon URL must be an uncredentialed loopback HTTP origin");

/** Verified daemon descriptor retained by desktop main-process transports. */
export const DesktopDaemonHostDescriptorSchemaZ = z
  .object({
    apiBaseUrl: DesktopDaemonLoopbackUrlSchemaZ,
    protocolVersion: z.number().int().positive(),
    productVersion: z.string().trim().min(1),
    instanceId: z.uuid(),
    startedAt: z.iso.datetime({ offset: true }),
    /** Stable environment identity; absent until a daemon that mints it runs. */
    environmentId: z.uuid().optional(),
  })
  .strict();

/**
 * Why the desktop daemon supervisor stopped its restart loop. Structural
 * failures only: transient failures (crashes, timeouts, unreachable probes)
 * never halt the loop and therefore never carry one of these.
 * Added on m42/supervision (additive; m42/connection-state rebases over this).
 */
export const DesktopDaemonSupervisorFatalReasonSchemaZ = z.enum([
  "protocol-incompatible",
  "record-invalid",
  "endpoint-not-loopback",
  "identity-mismatch",
  "health-mismatch",
  "spawn-failed",
  "child-fatal-exit",
]);

const DesktopDaemonHostIssueSchemaFields = {
  code: DesktopDaemonHostIssueCodeSchemaZ,
  reason: z.string().min(1),
} as const;

const DesktopDaemonCapabilityIssueSchemaFields = {
  code: DesktopDaemonHostIssueCodeSchemaZ,
  reason: z.string().min(1).max(240),
  /**
   * The daemon child's captured last words, when this desktop generation owned
   * a child that produced any. Absent when the daemon was never ours to spawn
   * (an attached foreign daemon) or when it printed nothing.
   */
  childOutput: DaemonChildOutputTailSchemaZ.optional(),
  /**
   * The daemon's OWN startup readiness ladder, read while this disconnected
   * state was composed.
   *
   * A daemon can be answering HTTP while this desktop still cannot use it — a
   * changed generation, a broker that could not be built, an identity record
   * that no longer matches. That is exactly when the ladder is worth having:
   * the two rungs only the daemon can answer (`credential-held`,
   * `attachment-issuable`) and the honest empty-fleet distinction exist nowhere
   * else. Absent when the daemon could not be read at all, and the renderer
   * then falls back to what the host itself observed.
   */
  startupReadiness: StartupReadinessLadderSchemaZ.optional(),
} as const;

export const DesktopDaemonHostStateSchemaZ = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("connected"),
      descriptor: DesktopDaemonHostDescriptorSchemaZ,
    })
    .strict(),
  z.object({ status: z.literal("unavailable"), ...DesktopDaemonHostIssueSchemaFields }).strict(),
  z.object({ status: z.literal("degraded"), ...DesktopDaemonHostIssueSchemaFields }).strict(),
]);

/** @deprecated Compatibility name for existing host bootstrap consumers. */
export const DesktopDaemonPreflightSchemaZ = DesktopDaemonHostStateSchemaZ;

/**
 * Renderer-safe daemon availability. The verified origin and process identity
 * deliberately remain in Electron main; browser code receives neither.
 */
export const DesktopDaemonCapabilityStateSchemaZ = z.discriminatedUnion("status", [
  z.object({ status: z.literal("connected"), identity: DaemonInstanceIdentitySchemaZ }).strict(),
  z
    .object({ status: z.literal("unavailable"), ...DesktopDaemonCapabilityIssueSchemaFields })
    .strict(),
  z.object({ status: z.literal("degraded"), ...DesktopDaemonCapabilityIssueSchemaFields }).strict(),
]);

export const DesktopWorkspaceNameSchemaZ = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine(
    (value) =>
      [...value].every((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 && code !== 127;
      }),
    "workspace name contains control characters",
  );

export const DesktopDaemonCapabilityErrorCodeSchemaZ = z.enum([
  "preview-only",
  "daemon-unavailable",
  "daemon-degraded",
  "invalid-request",
  "workspace-not-found",
  "request-timeout",
  "response-too-large",
  "invalid-response",
  "daemon-identity-mismatch",
  "request-failed",
  "resource-changed",
  "event-unavailable",
  "protocol-error",
  "disposed",
]);

export const DesktopDaemonCapabilityErrorSchemaZ = z
  .object({
    code: DesktopDaemonCapabilityErrorCodeSchemaZ,
    reason: z.string().min(1).max(240),
  })
  .strict();

export const DesktopDaemonWorkspaceSummarySchemaZ = z
  .object({ workspaceName: DesktopWorkspaceNameSchemaZ })
  .strict();

export const DesktopDaemonListWorkspacesResultSchemaZ = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ok"),
      daemon: DaemonInstanceIdentitySchemaZ,
      workspaces: z.array(DesktopDaemonWorkspaceSummarySchemaZ),
    })
    .strict(),
  z.object({ status: z.literal("error"), error: DesktopDaemonCapabilityErrorSchemaZ }).strict(),
]);

export const DesktopDaemonCapabilitiesResultSchemaZ = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ok"),
      daemon: DaemonInstanceIdentitySchemaZ,
      capabilities: z
        .object({
          appWindowMutation: CommandAvailabilitySchemaZ,
        })
        .strict(),
    })
    .strict(),
  z.object({ status: z.literal("error"), error: DesktopDaemonCapabilityErrorSchemaZ }).strict(),
]);

export const DesktopDaemonFetchApplicationShellRequestSchemaZ = z
  .object({
    workspaceName: DesktopWorkspaceNameSchemaZ,
    resourceVersion: z
      .union([
        z.literal(APPLICATION_SHELL_RESOURCE_V2_VERSION),
        z.literal(APPLICATION_SHELL_RESOURCE_V3_VERSION),
      ])
      .optional(),
  })
  .strict();

/** Store key: semantic workspace plus a non-secret daemon generation. */
export const DesktopApplicationShellTargetSchemaZ = z
  .object({
    daemon: DaemonInstanceIdentitySchemaZ,
    workspaceName: DesktopWorkspaceNameSchemaZ,
  })
  .strict();

export const DesktopDaemonFetchApplicationShellResultSchemaZ = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), envelope: ApplicationShellResourceSchemaZ }).strict(),
  z.object({ status: z.literal("error"), error: DesktopDaemonCapabilityErrorSchemaZ }).strict(),
]);

/**
 * Renderer-issued read requests for the native Files and Changes resources.
 * The daemon-issued opaque ids are the only cursor into a workspace; callers
 * never supply a path. Directory omission requests the workspace root catalog.
 */
export const DesktopDaemonFetchWorkspaceFilesRequestSchemaZ = z
  .object({
    workspaceName: DesktopWorkspaceNameSchemaZ,
    directoryId: WorkspaceFileResourceIdSchemaZ.optional(),
  })
  .strict();

export const DesktopDaemonFetchWorkspaceFilesResultSchemaZ = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), envelope: WorkspaceFilesCatalogEnvelopeV1SchemaZ }).strict(),
  z.object({ status: z.literal("error"), error: DesktopDaemonCapabilityErrorSchemaZ }).strict(),
]);

export const DesktopDaemonFetchWorkspaceFilePreviewRequestSchemaZ = z
  .object({
    workspaceName: DesktopWorkspaceNameSchemaZ,
    fileId: WorkspaceFileResourceIdSchemaZ,
  })
  .strict();

export const DesktopDaemonFetchWorkspaceFilePreviewResultSchemaZ = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), envelope: WorkspaceFilePreviewEnvelopeV1SchemaZ }).strict(),
  z.object({ status: z.literal("error"), error: DesktopDaemonCapabilityErrorSchemaZ }).strict(),
]);

export const DesktopDaemonFetchWorkspaceChangesRequestSchemaZ = z
  .object({ workspaceName: DesktopWorkspaceNameSchemaZ })
  .strict();

export const DesktopDaemonFetchWorkspaceChangesResultSchemaZ = z.discriminatedUnion("status", [
  z
    .object({ status: z.literal("ok"), envelope: WorkspaceChangesCatalogEnvelopeV1SchemaZ })
    .strict(),
  z.object({ status: z.literal("error"), error: DesktopDaemonCapabilityErrorSchemaZ }).strict(),
]);

export const DesktopDaemonFetchWorkspaceChangeDiffRequestSchemaZ = z
  .object({
    workspaceName: DesktopWorkspaceNameSchemaZ,
    changeId: WorkspaceChangeResourceIdSchemaZ,
  })
  .strict();

export const DesktopDaemonFetchWorkspaceChangeDiffResultSchemaZ = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), envelope: WorkspaceChangeDiffEnvelopeV1SchemaZ }).strict(),
  z.object({ status: z.literal("error"), error: DesktopDaemonCapabilityErrorSchemaZ }).strict(),
]);

/**
 * The fleet catalog is a single, workspace-free read: it enumerates the whole
 * adopted tmux fleet (see {@link ./fleet-catalog.ts}). The renderer supplies no
 * cursor — there is one catalog per daemon generation — so the host method takes
 * no request payload and the result is the parsed, generation-stamped resource.
 */
export const DesktopDaemonFetchFleetCatalogResultSchemaZ = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), envelope: FleetCatalogResourceV1SchemaZ }).strict(),
  z.object({ status: z.literal("error"), error: DesktopDaemonCapabilityErrorSchemaZ }).strict(),
]);

export const DesktopDaemonEventSubscriptionRequestSchemaZ = z
  .object({
    /**
     * Empty subscribes to catalog/connection invalidations only. Non-empty
     * subscriptions additionally receive events for the named workspaces.
     */
    workspaceNames: z.array(DesktopWorkspaceNameSchemaZ).max(64),
  })
  .strict()
  .superRefine(({ workspaceNames }, ctx) => {
    if (new Set(workspaceNames).size !== workspaceNames.length) {
      ctx.addIssue({ code: "custom", message: "workspace names must be unique" });
    }
  });

export const DesktopDaemonSubscriptionIdSchemaZ = z
  .string()
  .regex(/^desktop-subscription-[1-9][0-9]{0,9}$/u);

/**
 * Derived transport health of the single daemon event connection, published by
 * the main-process connection supervisor — the ONE owner of transport retry.
 * Renderer surfaces derive their connection status from these states instead
 * of inferring health from the presence of a transport object or from their
 * own retry bookkeeping.
 *
 * - `idle`         — no live subscription requires a socket.
 * - `connecting`   — a socket exists but its hello handshake has not verified.
 * - `connected`    — the socket is open and generation-verified.
 * - `degraded`     — a transport fault was observed; recovery is being decided.
 * - `reconnecting` — the supervisor owns a scheduled retry (`attempt` of
 *                    `maximumAttempts`, firing at `nextRetryAt` epoch ms).
 * - `stopped`      — the bounded retry budget is exhausted; only an explicit
 *                    retry or a daemon-generation change restarts it.
 */
export const DesktopDaemonTransportStateSchemaZ = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("idle") }).strict(),
  z.object({ phase: z.literal("connecting") }).strict(),
  z.object({ phase: z.literal("connected") }).strict(),
  z.object({ phase: z.literal("degraded"), error: DesktopDaemonCapabilityErrorSchemaZ }).strict(),
  z
    .object({
      phase: z.literal("reconnecting"),
      attempt: z.number().int().min(1).max(1_000),
      maximumAttempts: z.number().int().min(1).max(1_000),
      nextRetryAt: z.number().int().nonnegative(),
      error: DesktopDaemonCapabilityErrorSchemaZ,
    })
    .strict(),
  z.object({ phase: z.literal("stopped"), error: DesktopDaemonCapabilityErrorSchemaZ }).strict(),
]);

export const DesktopDaemonEventSchemaZ = z.discriminatedUnion("type", [
  z.object({ type: z.literal("workspaces.changed") }).strict(),
  /**
   * The adopted-session fleet changed — its composition (a session adopted or
   * gone) OR the ground-truth agent status of some session in it. Workspace-free
   * like `workspaces.changed`: a fleet-catalog consumer re-fetches the whole
   * catalog. The daemon carries these as two session-agnostic broadcast frames
   * (`fleet.changed` / `agent-status.changed`); the main-process broker folds
   * both into this single renderer-safe invalidation.
   */
  z.object({ type: z.literal("fleet.changed") }).strict(),
  z
    .object({
      type: z.literal("application-shell.changed"),
      workspaceName: DesktopWorkspaceNameSchemaZ,
    })
    .strict(),
  z
    .object({
      type: z.literal("connection.changed"),
      state: z.enum(["live", "degraded"]),
      error: DesktopDaemonCapabilityErrorSchemaZ.nullable(),
    })
    .strict(),
  /**
   * The supervisor-derived transport state changed. Additive companion to
   * `connection.changed`: that event stays the coarse live/degraded signal,
   * while this one carries the full typed machine state (retry attempt,
   * next-retry time, fatal stop) so status displays derive rather than infer.
   */
  z
    .object({
      type: z.literal("transport.changed"),
      transport: DesktopDaemonTransportStateSchemaZ,
    })
    .strict(),
  z
    .object({
      type: z.literal("daemon-generation.changed"),
      previousIdentity: DaemonInstanceIdentitySchemaZ.nullable(),
      daemon: DesktopDaemonCapabilityStateSchemaZ,
    })
    .strict(),
]);

const DesktopDaemonDisconnectedCapabilityStateSchemaZ = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("unavailable"),
      ...DesktopDaemonCapabilityIssueSchemaFields,
    })
    .strict(),
  z.object({ status: z.literal("degraded"), ...DesktopDaemonCapabilityIssueSchemaFields }).strict(),
]);

const DesktopDaemonConnectedCapabilityStateSchemaZ = z
  .object({ status: z.literal("connected"), identity: DaemonInstanceIdentitySchemaZ })
  .strict();

/**
 * Renderer-safe outcome of a bounded main-process daemon revalidation. A
 * daemon identity is the only generation token that crosses the bridge.
 */
export const DesktopDaemonRefreshConnectionResultSchemaZ = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("unchanged"),
      daemon: DesktopDaemonCapabilityStateSchemaZ,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("generation-replaced"),
      previousIdentity: DaemonInstanceIdentitySchemaZ.nullable(),
      daemon: DesktopDaemonConnectedCapabilityStateSchemaZ,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("authority-retired"),
      previousIdentity: DaemonInstanceIdentitySchemaZ,
      daemon: DesktopDaemonDisconnectedCapabilityStateSchemaZ,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("state-changed"),
      daemon: DesktopDaemonDisconnectedCapabilityStateSchemaZ,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("superseded"),
      daemon: DesktopDaemonCapabilityStateSchemaZ,
    })
    .strict(),
]);

/** Private main/preload wire shapes. Subscription ids never reach application code. */
export const DesktopDaemonSubscribeWireResultSchemaZ = z.discriminatedUnion("status", [
  z
    .object({ status: z.literal("subscribed"), subscriptionId: DesktopDaemonSubscriptionIdSchemaZ })
    .strict(),
  z.object({ status: z.literal("error"), error: DesktopDaemonCapabilityErrorSchemaZ }).strict(),
]);

export const DesktopDaemonEventWireEnvelopeSchemaZ = z
  .object({
    subscriptionId: DesktopDaemonSubscriptionIdSchemaZ,
    event: DesktopDaemonEventSchemaZ,
  })
  .strict();

/**
 * First-run onboarding state carried at bootstrap. `introAcknowledged` is a
 * persisted, machine-local marker (see the daemon's onboarding-marker) so the
 * gentle intro layer shows exactly once and never returns after dismissal.
 */
export const DesktopOnboardingStateSchemaZ = z.object({ introAcknowledged: z.boolean() }).strict();

export const DesktopHostBootstrapSchemaZ = z
  .object({
    apiVersion: z.literal(DESKTOP_HOST_API_VERSION),
    runtime: DesktopRuntimeKindSchemaZ,
    platform: DesktopPlatformSchemaZ,
    appVersion: z.string().min(1),
    theme: DesktopThemeStateSchemaZ,
    window: DesktopWindowStateSchemaZ,
    daemon: DesktopDaemonCapabilityStateSchemaZ,
    onboarding: DesktopOnboardingStateSchemaZ,
  })
  .strict();

export const DesktopMenuResultSchemaZ = z.object({ status: z.literal("unavailable") }).strict();
export const DesktopDirectorySelectionSchemaZ = z.object({ path: z.string().min(1) }).strict();

export type DesktopRuntimeKind = z.infer<typeof DesktopRuntimeKindSchemaZ>;
export type DesktopPlatform = z.infer<typeof DesktopPlatformSchemaZ>;
export type DesktopThemeState = z.infer<typeof DesktopThemeStateSchemaZ>;
export type DesktopWindowState = z.infer<typeof DesktopWindowStateSchemaZ>;
export type DesktopDaemonHostDescriptor = z.infer<typeof DesktopDaemonHostDescriptorSchemaZ>;
export type DesktopDaemonSupervisorFatalReason = z.infer<
  typeof DesktopDaemonSupervisorFatalReasonSchemaZ
>;
export type DesktopDaemonHostState = z.infer<typeof DesktopDaemonHostStateSchemaZ>;
export type DesktopDaemonCapabilityState = z.infer<typeof DesktopDaemonCapabilityStateSchemaZ>;
export type DesktopDaemonCapabilityErrorCode = z.infer<
  typeof DesktopDaemonCapabilityErrorCodeSchemaZ
>;
export type DesktopDaemonCapabilityError = z.infer<typeof DesktopDaemonCapabilityErrorSchemaZ>;
export type DesktopDaemonWorkspaceSummary = z.infer<typeof DesktopDaemonWorkspaceSummarySchemaZ>;
export type DesktopDaemonListWorkspacesResult = z.infer<
  typeof DesktopDaemonListWorkspacesResultSchemaZ
>;
export type DesktopDaemonCapabilitiesResult = z.infer<
  typeof DesktopDaemonCapabilitiesResultSchemaZ
>;
export type DesktopDaemonFetchApplicationShellRequest = z.infer<
  typeof DesktopDaemonFetchApplicationShellRequestSchemaZ
>;
export type DesktopApplicationShellTarget = z.infer<typeof DesktopApplicationShellTargetSchemaZ>;
export type DesktopDaemonFetchApplicationShellResult = z.infer<
  typeof DesktopDaemonFetchApplicationShellResultSchemaZ
>;
export type DesktopDaemonFetchWorkspaceFilesRequest = z.infer<
  typeof DesktopDaemonFetchWorkspaceFilesRequestSchemaZ
>;
export type DesktopDaemonFetchWorkspaceFilesResult = z.infer<
  typeof DesktopDaemonFetchWorkspaceFilesResultSchemaZ
>;
export type DesktopDaemonFetchWorkspaceFilePreviewRequest = z.infer<
  typeof DesktopDaemonFetchWorkspaceFilePreviewRequestSchemaZ
>;
export type DesktopDaemonFetchWorkspaceFilePreviewResult = z.infer<
  typeof DesktopDaemonFetchWorkspaceFilePreviewResultSchemaZ
>;
export type DesktopDaemonFetchWorkspaceChangesRequest = z.infer<
  typeof DesktopDaemonFetchWorkspaceChangesRequestSchemaZ
>;
export type DesktopDaemonFetchWorkspaceChangesResult = z.infer<
  typeof DesktopDaemonFetchWorkspaceChangesResultSchemaZ
>;
export type DesktopDaemonFetchWorkspaceChangeDiffRequest = z.infer<
  typeof DesktopDaemonFetchWorkspaceChangeDiffRequestSchemaZ
>;
export type DesktopDaemonFetchWorkspaceChangeDiffResult = z.infer<
  typeof DesktopDaemonFetchWorkspaceChangeDiffResultSchemaZ
>;
export type DesktopDaemonFetchFleetCatalogResult = z.infer<
  typeof DesktopDaemonFetchFleetCatalogResultSchemaZ
>;
export type DesktopDaemonEventSubscriptionRequest = z.infer<
  typeof DesktopDaemonEventSubscriptionRequestSchemaZ
>;
export type DesktopDaemonTransportState = z.infer<typeof DesktopDaemonTransportStateSchemaZ>;
export type DesktopDaemonEvent = z.infer<typeof DesktopDaemonEventSchemaZ>;
export type DesktopDaemonRefreshConnectionResult = z.infer<
  typeof DesktopDaemonRefreshConnectionResultSchemaZ
>;
export type DesktopDaemonSubscribeWireResult = z.infer<
  typeof DesktopDaemonSubscribeWireResultSchemaZ
>;
/** @deprecated Compatibility name for existing host bootstrap consumers. */
export type DesktopDaemonPreflight = DesktopDaemonHostState;
export type DesktopOnboardingState = z.infer<typeof DesktopOnboardingStateSchemaZ>;
export type DesktopHostBootstrap = z.infer<typeof DesktopHostBootstrapSchemaZ>;
export type DesktopMenuResult = z.infer<typeof DesktopMenuResultSchemaZ>;
export type DesktopDirectorySelection = z.infer<typeof DesktopDirectorySelectionSchemaZ>;
export type DesktopHostUnsubscribe = () => void;
export type DesktopDaemonHostSubscriptionResult =
  | { readonly status: "subscribed"; readonly unsubscribe: DesktopHostUnsubscribe }
  | { readonly status: "error"; readonly error: DesktopDaemonCapabilityError };

/**
 * The complete renderer-visible desktop surface. It intentionally has no
 * generic send/invoke/eval/command escape hatch. Every new capability must be
 * named and reviewed here first.
 */
export interface HostCapabilities {
  readonly apiVersion: typeof DESKTOP_HOST_API_VERSION;
  bootstrap(): Promise<DesktopHostBootstrap>;
  readonly lifecycle: {
    requestQuit(): Promise<void>;
  };
  readonly window: {
    getState(): Promise<DesktopWindowState>;
    minimize(): Promise<DesktopWindowState>;
    toggleMaximized(): Promise<DesktopWindowState>;
    close(): Promise<void>;
    onStateChanged(listener: (state: DesktopWindowState) => void): DesktopHostUnsubscribe;
  };
  readonly menu: {
    showApplicationMenu(): Promise<DesktopMenuResult>;
  };
  readonly workspace: {
    openProjectDirectory(): Promise<WorkspaceOpenHostResult | null>;
  };
  readonly onboarding: {
    /** Persist that the first-run intro layer has been dismissed. Idempotent. */
    acknowledgeIntro(): Promise<void>;
  };
  readonly theme: {
    getState(): Promise<DesktopThemeState>;
    onChanged(listener: (state: DesktopThemeState) => void): DesktopHostUnsubscribe;
  };
  /**
   * Packaged-app auto-update. Renderer-safe by construction: a coarse phase plus
   * two version strings, never a URL, path, checksum, or signature. The renderer
   * can only observe; the check/download/verify/stage/apply all run in main.
   */
  readonly update: {
    getStatus(): Promise<DesktopUpdateStatus>;
    onStatusChanged(listener: (status: DesktopUpdateStatus) => void): DesktopHostUnsubscribe;
  };
  readonly daemon: {
    capabilities(): Promise<DesktopDaemonCapabilitiesResult>;
    mutateAppWindow(intent: AppWindowMutationArguments): Promise<AppWindowMutationHostResult>;
    createWorkspacePane(
      invocation: WorkspacePaneCreateInvocation,
    ): Promise<WorkspacePaneCreateHostResult>;
    issueTerminalAttachment(request: TerminalAttachRequest): Promise<TerminalAttachmentIssueResult>;
    /**
     * Issue a one-use session-scoped pane-stream lease (m43 card 3). The
     * renderer authors only the semantic lease request; Electron main owns the
     * request/generation envelope, the owner bearer, and the trusted Origin.
     */
    issuePaneStream(request: PaneStreamLeaseRequest): Promise<PaneStreamIssueResult>;
    refreshConnection(): Promise<DesktopDaemonRefreshConnectionResult>;
    listWorkspaces(): Promise<DesktopDaemonListWorkspacesResult>;
    fetchApplicationShell(
      request: DesktopDaemonFetchApplicationShellRequest,
    ): Promise<DesktopDaemonFetchApplicationShellResult>;
    fetchWorkspaceFiles(
      request: DesktopDaemonFetchWorkspaceFilesRequest,
    ): Promise<DesktopDaemonFetchWorkspaceFilesResult>;
    fetchWorkspaceFilePreview(
      request: DesktopDaemonFetchWorkspaceFilePreviewRequest,
    ): Promise<DesktopDaemonFetchWorkspaceFilePreviewResult>;
    fetchWorkspaceChanges(
      request: DesktopDaemonFetchWorkspaceChangesRequest,
    ): Promise<DesktopDaemonFetchWorkspaceChangesResult>;
    fetchWorkspaceChangeDiff(
      request: DesktopDaemonFetchWorkspaceChangeDiffRequest,
    ): Promise<DesktopDaemonFetchWorkspaceChangeDiffResult>;
    /** Read the whole adopted fleet (owner-gated, generation-stamped, no cursor). */
    fetchFleetCatalog(): Promise<DesktopDaemonFetchFleetCatalogResult>;
    /**
     * Promote an adopted, catalog-visible session to an attachable workspace.
     * Owner-gated and idempotent; the renderer supplies only the opaque fleet
     * session id, and Electron main authors the operation/generation envelope.
     */
    promoteWorkspace(intent: WorkspacePromoteArguments): Promise<WorkspacePromoteHostResult>;
    subscribe(
      request: DesktopDaemonEventSubscriptionRequest,
      listener: (event: DesktopDaemonEvent) => void,
    ): Promise<DesktopDaemonHostSubscriptionResult>;
  };
}
