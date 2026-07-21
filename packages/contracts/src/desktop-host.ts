import { z } from "zod";

/** Versioned, deliberately narrow bridge exposed by a desktop host preload. */
export const DESKTOP_HOST_API_VERSION = 2 as const;

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

/** Verified daemon identity safe to cross the main → preload → renderer boundary. */
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

export const DesktopHostBootstrapSchemaZ = z
  .object({
    apiVersion: z.literal(DESKTOP_HOST_API_VERSION),
    runtime: DesktopRuntimeKindSchemaZ,
    platform: DesktopPlatformSchemaZ,
    appVersion: z.string().min(1),
    theme: DesktopThemeStateSchemaZ,
    window: DesktopWindowStateSchemaZ,
    daemon: DesktopDaemonPreflightSchemaZ,
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
/** @deprecated Compatibility name for existing host bootstrap consumers. */
export type DesktopDaemonPreflight = DesktopDaemonHostState;
export type DesktopHostBootstrap = z.infer<typeof DesktopHostBootstrapSchemaZ>;
export type DesktopMenuResult = z.infer<typeof DesktopMenuResultSchemaZ>;
export type DesktopDirectorySelection = z.infer<typeof DesktopDirectorySelectionSchemaZ>;
export type DesktopHostUnsubscribe = () => void;

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
}
