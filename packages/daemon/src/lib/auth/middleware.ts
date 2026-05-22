// Based on VibeTunnel (MIT) — github.com/amantus-ai/vibetunnel
import type { Context, Next, MiddlewareHandler } from "hono";
import { AuthService } from "./auth-service.ts";
import type { AuthConfig } from "./types.ts";

/**
 * Hono middleware that checks Authorization Bearer header.
 *
 * - Bypasses /health and /api/auth/* routes.
 * - When method is "none" (default), passes through everything (backward compatible).
 * - Otherwise validates the JWT and sets c.set("userId", ...).
 */
export function authMiddleware(authService: AuthService, config: AuthConfig): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    // Backward compatible: no auth required when method is "none"
    if (config.method === "none") {
      return next();
    }

    const path = new URL(c.req.url).pathname;

    // Bypass health and auth endpoints
    if (path === "/health" || path.startsWith("/api/auth/")) {
      return next();
    }

    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Missing or invalid Authorization header" }, 401);
    }

    const token = authHeader.slice(7);
    const result = authService.verifyToken(token);
    if (!result.valid) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    c.set("userId", result.userId);
    return next();
  };
}

/**
 * Validate a JWT token from a query parameter (for WebSocket upgrade).
 * Returns the userId if valid, null otherwise.
 */
export function validateWsToken(
  authService: AuthService,
  config: AuthConfig,
  token: string | null,
): string | null {
  if (config.method === "none") return "anonymous";
  if (!token) return null;
  const result = authService.verifyToken(token);
  return result.valid ? (result.userId ?? null) : null;
}
