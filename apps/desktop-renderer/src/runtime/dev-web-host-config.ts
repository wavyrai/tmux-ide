/**
 * Activation policy for the browser-only development host (m44.2).
 *
 * The renderer normally reaches the daemon through the Electron preload bridge
 * (`window.tmuxIdeHost`). This module decides — with no IO — whether a plain
 * browser tab may instead talk to a real daemon through the same-origin Vite
 * gateway. Every factor below is required, so the default in every build that
 * is not an explicitly configured developer session is "inactive", and the
 * renderer keeps its existing honest preview surface.
 *
 * ADR-0002 permits a renderer-direct, origin-bound WebSocket but rules out
 * "arbitrary browser tabs" and wildcard dev origins. This policy is how that
 * line is held: activation needs a development build, an absent production
 * bridge, a deliberate opt-in, and a loopback-only page origin. The gateway
 * process owns the daemon endpoint and owner credential; neither enters browser
 * JavaScript. Production never satisfies the first factor, because
 * `import.meta.env.DEV` is false in every built bundle.
 */

/** Why the development host stayed off. Named so the console line is useful. */
export type DevWebHostInactiveReason =
  | "not-a-development-build"
  | "host-bridge-present"
  | "opt-in-absent"
  | "daemon-url-absent"
  | "daemon-url-not-loopback"
  | "owner-token-absent";

export interface DevWebHostConfig {
  /** Canonical `http://127.0.0.1:<port>` origin of the daemon HTTP API. */
  readonly daemonOrigin: string;
  /** Canonical `ws://127.0.0.1:<port>` origin for the daemon's sockets. */
  readonly daemonWebSocketOrigin: string;
  /**
   * Direct mode's owner bearer. Null behind the same-origin development
   * gateway, where Vite injects it and browser JavaScript never receives it.
   */
  readonly ownerToken: string | null;
  readonly transport: "direct" | "same-origin-gateway";
}

export type DevWebHostResolution =
  | { readonly status: "active"; readonly config: DevWebHostConfig }
  | { readonly status: "inactive"; readonly reason: DevWebHostInactiveReason };

export interface DevWebHostResolutionInput {
  /** `import.meta.env.DEV` — false in every built bundle. */
  readonly developmentBuild: boolean;
  /** Whether an Electron preload published `window.tmuxIdeHost`. */
  readonly hostBridgePresent: boolean;
  /** `import.meta.env.VITE_TMUX_IDE_DEV_HOST` — "1" opts in. */
  readonly optInFlag: string | undefined;
  /** The page's `?devHost=1` query value, if any. An alternative opt-in. */
  readonly optInQuery: string | undefined;
  /** `import.meta.env.VITE_TMUX_IDE_DEV_DAEMON_URL`. */
  readonly daemonUrl: string | undefined;
  /** `import.meta.env.VITE_TMUX_IDE_DEV_OWNER_TOKEN`. */
  readonly ownerToken: string | undefined;
  /** `import.meta.env.VITE_TMUX_IDE_DEV_GATEWAY`. */
  readonly gatewayFlag?: string | undefined;
  /** Browser page origin; required only by same-origin gateway mode. */
  readonly pageOrigin?: string | undefined;
}

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * A canonical `http://<loopback>:<port>` origin, or null. Anything routable off
 * this machine is refused: the owner bearer and the pane bytes it unlocks must
 * never be aimed at a remote host by a stray environment variable.
 */
export function loopbackHttpOriginOrNull(value: string | undefined): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return null;
  if (/[\0\r\n\t ]/u.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "" && url.pathname !== "/") return null;
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) return null;
  if (!url.port) return null;
  return url.origin;
}

/** The `ws:`/`wss:` sibling of a canonical loopback HTTP origin. */
export function webSocketOriginFor(httpOrigin: string): string {
  return httpOrigin.startsWith("https:")
    ? `wss:${httpOrigin.slice("https:".length)}`
    : `ws:${httpOrigin.slice("http:".length)}`;
}

function optedIn(flag: string | undefined, query: string | undefined): boolean {
  return flag === "1" || query === "1";
}

/**
 * Decide whether this page may run the development host. Every refusal is
 * final for the page load — there is no retry or fallback that could turn an
 * unconfigured tab into a live one.
 */
export function resolveDevWebHostConfig(input: DevWebHostResolutionInput): DevWebHostResolution {
  if (!input.developmentBuild) return { status: "inactive", reason: "not-a-development-build" };
  if (input.hostBridgePresent) return { status: "inactive", reason: "host-bridge-present" };
  if (!optedIn(input.optInFlag, input.optInQuery)) {
    return { status: "inactive", reason: "opt-in-absent" };
  }
  if (input.gatewayFlag === "1") {
    const pageOrigin = loopbackHttpOriginOrNull(input.pageOrigin);
    if (pageOrigin === null) return { status: "inactive", reason: "daemon-url-not-loopback" };
    return {
      status: "active",
      config: {
        daemonOrigin: pageOrigin,
        daemonWebSocketOrigin: webSocketOriginFor(pageOrigin),
        ownerToken: null,
        transport: "same-origin-gateway",
      },
    };
  }
  if (typeof input.daemonUrl !== "string" || input.daemonUrl.length === 0) {
    return { status: "inactive", reason: "daemon-url-absent" };
  }
  const daemonOrigin = loopbackHttpOriginOrNull(input.daemonUrl);
  if (daemonOrigin === null) return { status: "inactive", reason: "daemon-url-not-loopback" };
  if (typeof input.ownerToken !== "string" || input.ownerToken.length === 0) {
    return { status: "inactive", reason: "owner-token-absent" };
  }
  return {
    status: "active",
    config: {
      daemonOrigin,
      daemonWebSocketOrigin: webSocketOriginFor(daemonOrigin),
      ownerToken: input.ownerToken,
      transport: "direct",
    },
  };
}
