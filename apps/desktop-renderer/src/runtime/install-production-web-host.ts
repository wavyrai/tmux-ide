import { createDevWebHostCapabilities } from "./dev-web-host.ts";
import { webSocketOriginFor } from "./dev-web-host-config.ts";

/**
 * Install the packaged loopback Web host.
 *
 * The document capability itself is consumed by the shared browser host and
 * never grants daemon access directly. The loopback server exchanges it for a
 * stable host identity and keeps both the daemon endpoint and owner bearer out
 * of browser JavaScript.
 */
export function installProductionWebHost(): boolean {
  if (typeof window === "undefined" || window.tmuxIdeHost !== undefined) return false;
  const capability = document.querySelector<HTMLMetaElement>(
    'meta[name="tmux-ide-dev-host-session"]',
  );
  if (!capability) return false;
  window.tmuxIdeHost = createDevWebHostCapabilities({
    daemonOrigin: window.location.origin,
    daemonWebSocketOrigin: webSocketOriginFor(window.location.origin),
    ownerToken: null,
    transport: "same-origin-gateway",
  });
  return true;
}
