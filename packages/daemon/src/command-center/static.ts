import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { MiddlewareHandler } from "hono";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** File read cache: path -> { content, mimeType } */
const fileCache = new Map<string, { content: Uint8Array; mimeType: string }>();

/**
 * Resolve the dashboard build directory.
 *
 * Works in three layouts:
 *  1. Workspace dev — daemon runs from `packages/daemon/src/command-center/`,
 *     dashboard sits at the repo root.
 *  2. npm install via the root `tmux-ide` package — daemon is in
 *     `node_modules/@tmux-ide/daemon/...`, dashboard is at the host
 *     package root.
 *  3. Standalone daemon install — caller passes `TMUX_IDE_DASHBOARD_OUT`.
 *
 * Goal-16 flavor switch: `DASHBOARD_FLAVOR=solid` looks for the Solid
 * SPA's `dashboard-solid/dist` instead of the React `dashboard/out`.
 * Default stays React until G16-P4 cutover. The override env var also
 * supports either flavor — caller passes the full absolute path.
 */
function resolveDashboardOut(): string | null {
  const override = process.env.TMUX_IDE_DASHBOARD_OUT;
  if (override) return existsSync(override) ? override : null;

  const flavor = process.env.DASHBOARD_FLAVOR === "solid" ? "solid" : "react";
  const candidates =
    flavor === "solid"
      ? [["dashboard-solid", "dist"]]
      : [["dashboard", "out"]];

  const here = dirname(fileURLToPath(import.meta.url));
  // Walk up looking for a sibling build directory. Stops at filesystem
  // root.
  let current = here;
  for (let i = 0; i < 10; i += 1) {
    for (const segments of candidates) {
      const candidate = join(current, ...segments);
      if (existsSync(candidate)) return candidate;
    }
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Read a file from the out directory, returning cached result if available.
 */
function readCached(filePath: string): { content: Uint8Array; mimeType: string } | null {
  const cached = fileCache.get(filePath);
  if (cached) return cached;

  if (!existsSync(filePath) || !statSync(filePath).isFile()) return null;

  const ext = extname(filePath);
  const mimeType = MIME_TYPES[ext] ?? "application/octet-stream";
  const content = new Uint8Array(readFileSync(filePath));
  const entry = { content, mimeType };
  fileCache.set(filePath, entry);
  return entry;
}

/**
 * Determine the Cache-Control header for a given URL path.
 */
function cacheControl(urlPath: string, mimeType: string): string {
  if (urlPath.startsWith("/_next/static/")) {
    return "public, max-age=31536000, immutable";
  }
  if (mimeType.startsWith("text/html")) {
    return "no-cache";
  }
  return "public, max-age=3600";
}

/**
 * Hono middleware that serves the Next.js static export from dashboard/out/.
 * Gracefully no-ops if the out/ directory does not exist.
 */
export function serveDashboard(): MiddlewareHandler {
  const outDir = resolveDashboardOut();

  // If no out/ directory, return a no-op middleware
  if (!outDir) {
    return async (_c, next) => {
      await next();
    };
  }

  return async (c, next) => {
    const path = new URL(c.req.url).pathname;

    // Skip API, WebSocket, and health routes — let them fall through
    if (path.startsWith("/api/") || path.startsWith("/ws/") || path === "/health") {
      await next();
      return;
    }

    // Normalize: strip trailing slash (except for root "/")
    const normalized = path !== "/" && path.endsWith("/") ? path.slice(0, -1) : path;

    const serve = (file: { content: Uint8Array; mimeType: string }): Response =>
      new Response(new Uint8Array(file.content) as Uint8Array<ArrayBuffer>, {
        status: 200,
        headers: {
          "Content-Type": file.mimeType,
          "Cache-Control": cacheControl(path, file.mimeType),
        },
      });

    // 1. Try exact file match (e.g. /_next/static/chunks/abc.js)
    const exactPath = join(outDir, normalized);
    const exactFile = readCached(exactPath);
    if (exactFile) return serve(exactFile);

    // 2. Try index.html inside directory (e.g. /foo/ -> out/foo/index.html)
    const indexPath = join(outDir, normalized, "index.html");
    const indexFile = readCached(indexPath);
    if (indexFile) return serve(indexFile);

    // 3. SPA fallback for /project/* dynamic routes
    if (normalized.startsWith("/project/")) {
      const fallbackPath = join(outDir, "project", "__fallback", "index.html");
      const fallbackFile = readCached(fallbackPath);
      if (fallbackFile) return serve(fallbackFile);
    }

    // 4. General SPA fallback — serve out/index.html for client-side routing
    const rootIndex = join(outDir, "index.html");
    const rootFile = readCached(rootIndex);
    if (rootFile) return serve(rootFile);

    // Nothing found; let other handlers take over
    await next();
  };
}
