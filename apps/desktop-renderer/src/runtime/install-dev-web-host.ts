/**
 * Entry-point wiring for the browser-only development host (m44.2).
 *
 * Runs once, before the application module is imported, and publishes the
 * development host under the SAME `window.tmuxIdeHost` name the Electron
 * preload uses. Everything downstream — `resolveHostCapabilities`, the narrow
 * facade check, `App`'s preview-versus-live branch — therefore needs no change
 * and no development-only branch of its own: the app either sees a host bridge
 * or it does not.
 *
 * The bridge is never replaced. If a preload already published one, this is a
 * no-op, so the production path can never be shadowed by development code.
 */
import { createDevWebHostCapabilities } from "./dev-web-host.ts";
import { resolveDevWebHostConfig, type DevWebHostResolution } from "./dev-web-host-config.ts";

/**
 * Install the development host if — and only if — every activation factor
 * holds. Returns the resolution so callers (and tests) can see why it stayed
 * off. See `dev-web-host-config.ts` for the policy itself.
 */
export function installDevWebHost(): DevWebHostResolution {
  const resolution = resolveDevWebHostConfig({
    developmentBuild: import.meta.env.DEV,
    hostBridgePresent: typeof window !== "undefined" && window.tmuxIdeHost !== undefined,
    optInFlag: import.meta.env.VITE_TMUX_IDE_DEV_HOST,
    optInQuery:
      typeof window === "undefined"
        ? undefined
        : (new URLSearchParams(window.location.search).get("devHost") ?? undefined),
    daemonUrl: import.meta.env.VITE_TMUX_IDE_DEV_DAEMON_URL,
    ownerToken: import.meta.env.VITE_TMUX_IDE_DEV_OWNER_TOKEN,
    gatewayFlag: import.meta.env.VITE_TMUX_IDE_DEV_GATEWAY,
    pageOrigin: typeof window === "undefined" ? undefined : window.location.origin,
  });
  if (resolution.status === "active") {
    window.tmuxIdeHost = createDevWebHostCapabilities(resolution.config);
    console.info(
      `[tmux-ide] development web host active via ${resolution.config.transport} at ${resolution.config.daemonOrigin}`,
    );
  }
  return resolution;
}
