import { z } from "zod";

/** Versioned, deliberately narrow bridge exposed by a desktop host preload. */
export const DESKTOP_HOST_API_VERSION = 1 as const;

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

export const DesktopDaemonPreflightSchemaZ = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), apiBaseUrl: z.string().url() }).strict(),
  z.object({ status: z.literal("absent") }).strict(),
  z.object({ status: z.literal("deferred"), reason: z.string().min(1) }).strict(),
  z.object({ status: z.literal("unavailable"), reason: z.string().min(1) }).strict(),
]);

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
export type DesktopDaemonPreflight = z.infer<typeof DesktopDaemonPreflightSchemaZ>;
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
