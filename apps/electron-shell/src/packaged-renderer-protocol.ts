import { readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  DESKTOP_PACKAGED_RENDERER_ENTRY_URL,
  DESKTOP_PACKAGED_RENDERER_HOST,
  DESKTOP_PACKAGED_RENDERER_ORIGIN,
  DESKTOP_PACKAGED_RENDERER_SCHEME,
} from "@tmux-ide/contracts";

interface SchemeRegistrar {
  registerSchemesAsPrivileged(
    schemes: {
      scheme: string;
      privileges: Record<string, boolean>;
    }[],
  ): void;
}

interface ProtocolHandlerRegistry {
  handle(scheme: string, handler: (request: Request) => Response | Promise<Response>): void;
  unhandle(scheme: string): void;
}

interface FileFetcher {
  fetch(url: string): Promise<Response>;
}

interface RendererWebRequest {
  onHeadersReceived(
    filter: { urls: string[] },
    listener:
      | ((
          details: {
            readonly url: string;
            readonly resourceType: string;
            readonly responseHeaders?: Record<string, string | string[]>;
          },
          callback: (response: {
            readonly responseHeaders?: Record<string, string | string[]>;
          }) => void,
        ) => void)
      | null,
  ): void;
}

export interface PackagedRendererProtocolOptions {
  readonly protocol: ProtocolHandlerRegistry;
  readonly fileFetcher: FileFetcher;
  readonly rendererRoot: string;
  readonly contentSecurityPolicy: () => string;
}

export interface DevelopmentRendererCspOptions {
  readonly webRequest: RendererWebRequest;
  readonly rendererOrigin: string;
  readonly contentSecurityPolicy: () => string;
}

const ASSET_PATH = /^\/assets\/[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/u;
const PACKAGED_ASSET_EXTENSIONS = new Set([
  ".avif",
  ".css",
  ".ico",
  ".js",
  ".png",
  ".svg",
  ".webp",
  ".woff",
  ".woff2",
]);

/** Must run exactly once, synchronously, before Electron's ready event. */
export function registerPackagedRendererScheme(protocol: SchemeRegistrar): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: DESKTOP_PACKAGED_RENDERER_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        codeCache: true,
        bypassCSP: false,
        allowServiceWorkers: false,
        corsEnabled: false,
        stream: false,
      },
    },
  ]);
}

function requestedRendererPath(rawUrl: string): "/index.html" | `/assets/${string}` | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (
    url.protocol !== `${DESKTOP_PACKAGED_RENDERER_SCHEME}:` ||
    url.hostname !== DESKTOP_PACKAGED_RENDERER_HOST ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.includes("%") ||
    url.pathname.includes("\\")
  ) {
    return null;
  }
  if (url.pathname === "/" || url.pathname === "/index.html") return "/index.html";
  return ASSET_PATH.test(url.pathname) ? (url.pathname as `/assets/${string}`) : null;
}

function rendererHeaders(contentSecurityPolicy: string): Headers {
  return new Headers({
    "Cache-Control": "no-store",
    "Content-Security-Policy": contentSecurityPolicy,
    "Content-Type": "text/html; charset=UTF-8",
    "Cross-Origin-Opener-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
  });
}

/**
 * Serves only the built renderer entry point and flat Vite assets. There is no
 * arbitrary file-protocol bridge and no path authored by the renderer reaches
 * the filesystem unchecked.
 */
export function installPackagedRendererProtocol(
  options: PackagedRendererProtocolOptions,
): () => void {
  const rendererRoot = options.rendererRoot;
  options.protocol.handle(DESKTOP_PACKAGED_RENDERER_SCHEME, async (request) => {
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    const pathname = requestedRendererPath(request.url);
    if (!pathname) return new Response("Not found", { status: 404 });
    if (pathname === "/index.html") {
      try {
        const html = await readFile(join(rendererRoot, "index.html"), "utf8");
        return new Response(html, {
          status: 200,
          headers: rendererHeaders(options.contentSecurityPolicy()),
        });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    }
    const assetName = basename(pathname);
    if (
      assetName !== pathname.slice("/assets/".length) ||
      !PACKAGED_ASSET_EXTENSIONS.has(extname(assetName).toLowerCase())
    ) {
      return new Response("Not found", { status: 404 });
    }
    try {
      return await options.fileFetcher.fetch(
        pathToFileURL(join(rendererRoot, "assets", assetName)).toString(),
      );
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
  return () => options.protocol.unhandle(DESKTOP_PACKAGED_RENDERER_SCHEME);
}

function canonicalLoopbackWebSocketOrigin(httpOrigin: string): string | null {
  try {
    const url = new URL(httpOrigin);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      !url.port ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.origin !== httpOrigin
    ) {
      return null;
    }
    url.protocol = "ws:";
    return url.origin;
  } catch {
    return null;
  }
}

/** Packaged documents receive one response-header policy for the verified daemon. */
export function packagedRendererContentSecurityPolicy(daemonHttpOrigin: string | null): string {
  const daemonWebSocketOrigin = daemonHttpOrigin
    ? canonicalLoopbackWebSocketOrigin(daemonHttpOrigin)
    : null;
  const connectSources = ["'self'", ...(daemonWebSocketOrigin ? [daemonWebSocketOrigin] : [])];
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connectSources.join(" ")}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join("; ");
}

export function developmentRendererContentSecurityPolicy(
  daemonHttpOrigin: string | null,
  developmentHttpOrigin: string,
): string {
  const developmentWebSocketOrigin = canonicalLoopbackWebSocketOrigin(developmentHttpOrigin);
  const daemonWebSocketOrigin = daemonHttpOrigin
    ? canonicalLoopbackWebSocketOrigin(daemonHttpOrigin)
    : null;
  const connectSources = [
    "'self'",
    ...(developmentWebSocketOrigin ? [developmentWebSocketOrigin] : []),
    ...(daemonWebSocketOrigin && daemonWebSocketOrigin !== developmentWebSocketOrigin
      ? [daemonWebSocketOrigin]
      : []),
  ];
  return packagedRendererContentSecurityPolicy(null).replace(
    "connect-src 'self'",
    `connect-src ${connectSources.join(" ")}`,
  );
}

/** Replaces Vite's preview header with Vite/HMR plus one verified daemon. */
export function installDevelopmentRendererCsp(options: DevelopmentRendererCspOptions): () => void {
  const canonicalOrigin = new URL(options.rendererOrigin).origin;
  if (
    canonicalOrigin !== options.rendererOrigin ||
    !canonicalLoopbackWebSocketOrigin(canonicalOrigin)
  ) {
    throw new TypeError("Development renderer origin must be canonical loopback HTTP.");
  }
  options.webRequest.onHeadersReceived({ urls: [`${canonicalOrigin}/*`] }, (details, callback) => {
    if (details.resourceType !== "mainFrame" || new URL(details.url).origin !== canonicalOrigin) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    const responseHeaders = Object.fromEntries(
      Object.entries(details.responseHeaders ?? {}).filter(
        ([name]) => name.toLowerCase() !== "content-security-policy",
      ),
    );
    callback({
      responseHeaders: {
        ...responseHeaders,
        "Content-Security-Policy": [options.contentSecurityPolicy()],
      },
    });
  });
  return () => options.webRequest.onHeadersReceived({ urls: [`${canonicalOrigin}/*`] }, null);
}

export { DESKTOP_PACKAGED_RENDERER_ENTRY_URL, DESKTOP_PACKAGED_RENDERER_ORIGIN };
