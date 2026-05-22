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
 * The dashboard is a Vite SPA build (Goal-16 cutover); output lives at
 * `dashboard/dist/`. Callers can override via the `TMUX_IDE_DASHBOARD_OUT`
 * env var with an absolute path.
 */
function resolveDashboardOut(): string | null {
  const override = process.env.TMUX_IDE_DASHBOARD_OUT;
  if (override) return existsSync(override) ? override : null;

  const here = dirname(fileURLToPath(import.meta.url));

  // Workspace-checkout preference: if a `pnpm-workspace.yaml` is in
  // scope, prefer that workspace's `dashboard/dist`. This avoids the
  // stale-bundle footgun where `pnpm --filter @tmux-ide/dashboard
  // build` refreshes the workspace copy but the daemon keeps serving
  // a copy from a prior `build:dashboard` run inside its own dist/.
  //
  // The walk also captures the first match (depth-first) so the
  // npm-installed case — no workspace marker, daemon ships its own
  // bundled `dist/dashboard/dist` — keeps working without changes.
  let current = here;
  let workspaceMatch: string | null = null;
  let firstMatch: string | null = null;
  for (let i = 0; i < 10; i += 1) {
    const candidate = join(current, "dashboard", "dist");
    if (existsSync(candidate)) {
      if (firstMatch === null) firstMatch = candidate;
      if (existsSync(join(current, "pnpm-workspace.yaml"))) {
        workspaceMatch = candidate;
        break;
      }
    }
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return workspaceMatch ?? firstMatch;
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
function cacheControl(_urlPath: string, mimeType: string): string {
  if (mimeType.startsWith("text/html")) {
    return "no-cache";
  }
  // Vite emits hashed asset filenames under /assets/, so the body is
  // immutable; the rest (sourcemaps, fonts) gets a moderate TTL.
  return "public, max-age=31536000, immutable";
}

/**
 * Hono middleware that serves the dashboard SPA bundle from
 * `dashboard/dist/`. Gracefully no-ops if the directory does not exist.
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

    // 1. Try exact file match (e.g. /assets/index-abc123.js)
    const exactPath = join(outDir, normalized);
    const exactFile = readCached(exactPath);
    if (exactFile) return serve(exactFile);

    // 2. SPA fallback — every unmatched path renders index.html so the
    //    Solid Router can take over on the client side.
    const rootIndex = join(outDir, "index.html");
    const rootFile = readCached(rootIndex);
    if (rootFile) return serve(rootFile);

    // Nothing found; let other handlers take over.
    await next();
  };
}
