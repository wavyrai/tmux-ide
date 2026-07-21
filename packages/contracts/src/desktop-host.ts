import { z } from "zod";
import { ApplicationShellResourceV1SchemaZ } from "./application-shell-resource.ts";
import { DaemonInstanceIdentitySchemaZ } from "./daemon-wire.ts";

/** Versioned, deliberately narrow bridge exposed by a desktop host preload. */
export const DESKTOP_HOST_API_VERSION = 3 as const;

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
  })
  .strict();

export const DesktopDaemonHostIssueCodeSchemaZ = z.enum([
  "record-missing",
  "record-invalid",
  "endpoint-not-loopback",
  "protocol-incompatible",
  "process-not-running",
  "identity-unreachable",
  "identity-mismatch",
  "health-unreachable",
  "health-mismatch",
  "probe-failed",
  "probe-timeout",
  "preview-only",
]);

const DesktopDaemonHostIssueSchemaFields = {
  code: DesktopDaemonHostIssueCodeSchemaZ,
  reason: z.string().min(1),
} as const;

const DesktopDaemonCapabilityIssueSchemaFields = {
  code: DesktopDaemonHostIssueCodeSchemaZ,
  reason: z.string().min(1).max(240),
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

export const DesktopDaemonFetchApplicationShellRequestSchemaZ = z
  .object({ workspaceName: DesktopWorkspaceNameSchemaZ })
  .strict();

/** Store key: semantic workspace plus a non-secret daemon generation. */
export const DesktopApplicationShellTargetSchemaZ = z
  .object({
    daemon: DaemonInstanceIdentitySchemaZ,
    workspaceName: DesktopWorkspaceNameSchemaZ,
  })
  .strict();

export const DesktopDaemonFetchApplicationShellResultSchemaZ = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), envelope: ApplicationShellResourceV1SchemaZ }).strict(),
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

export const DesktopDaemonEventSchemaZ = z.discriminatedUnion("type", [
  z.object({ type: z.literal("workspaces.changed") }).strict(),
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

export const DesktopHostBootstrapSchemaZ = z
  .object({
    apiVersion: z.literal(DESKTOP_HOST_API_VERSION),
    runtime: DesktopRuntimeKindSchemaZ,
    platform: DesktopPlatformSchemaZ,
    appVersion: z.string().min(1),
    theme: DesktopThemeStateSchemaZ,
    window: DesktopWindowStateSchemaZ,
    daemon: DesktopDaemonCapabilityStateSchemaZ,
  })
  .strict();

export const DesktopMenuResultSchemaZ = z.object({ status: z.literal("unavailable") }).strict();
export const DesktopDirectorySelectionSchemaZ = z.object({ path: z.string().min(1) }).strict();

export type DesktopRuntimeKind = z.infer<typeof DesktopRuntimeKindSchemaZ>;
export type DesktopPlatform = z.infer<typeof DesktopPlatformSchemaZ>;
export type DesktopThemeState = z.infer<typeof DesktopThemeStateSchemaZ>;
export type DesktopWindowState = z.infer<typeof DesktopWindowStateSchemaZ>;
export type DesktopDaemonHostDescriptor = z.infer<typeof DesktopDaemonHostDescriptorSchemaZ>;
export type DesktopDaemonHostIssueCode = z.infer<typeof DesktopDaemonHostIssueCodeSchemaZ>;
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
export type DesktopDaemonFetchApplicationShellRequest = z.infer<
  typeof DesktopDaemonFetchApplicationShellRequestSchemaZ
>;
export type DesktopApplicationShellTarget = z.infer<typeof DesktopApplicationShellTargetSchemaZ>;
export type DesktopDaemonFetchApplicationShellResult = z.infer<
  typeof DesktopDaemonFetchApplicationShellResultSchemaZ
>;
export type DesktopDaemonEventSubscriptionRequest = z.infer<
  typeof DesktopDaemonEventSubscriptionRequestSchemaZ
>;
export type DesktopDaemonEvent = z.infer<typeof DesktopDaemonEventSchemaZ>;
export type DesktopDaemonSubscribeWireResult = z.infer<
  typeof DesktopDaemonSubscribeWireResultSchemaZ
>;
/** @deprecated Compatibility name for existing host bootstrap consumers. */
export type DesktopDaemonPreflight = DesktopDaemonHostState;
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
  readonly dialog: {
    selectProjectDirectory(): Promise<DesktopDirectorySelection | null>;
  };
  readonly theme: {
    getState(): Promise<DesktopThemeState>;
    onChanged(listener: (state: DesktopThemeState) => void): DesktopHostUnsubscribe;
  };
  readonly daemon: {
    listWorkspaces(): Promise<DesktopDaemonListWorkspacesResult>;
    fetchApplicationShell(
      request: DesktopDaemonFetchApplicationShellRequest,
    ): Promise<DesktopDaemonFetchApplicationShellResult>;
    subscribe(
      request: DesktopDaemonEventSubscriptionRequest,
      listener: (event: DesktopDaemonEvent) => void,
    ): Promise<DesktopDaemonHostSubscriptionResult>;
  };
}
