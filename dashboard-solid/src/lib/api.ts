/**
 * Effect-wrapped REST client — Solid edition.
 *
 * Mirrors `dashboard/lib/api.ts` for the slice G16-P1 needs (just
 * `fetchSessions` so the widgets gallery can resolve a project name +
 * dir to pin TUI tile deep-links to). Each fetcher returns an
 * `Effect.Effect<TOk, ApiError>` so the widgets route can compose with
 * other effects later in Goal-16 without retrofitting.
 *
 * `resolveApiBase` is identical to the React side: env override wins,
 * SSR returns "" (this app is SPA-only so SSR never runs in
 * production), localhost gets pinned to 127.0.0.1 to skip the IPv6
 * stall.
 */

import { Effect, Data } from "effect";
import type { SessionOverview } from "@tmux-ide/contracts";

export class ApiError extends Data.TaggedError("ApiError")<{
  readonly status: number;
  readonly message: string;
  readonly cause?: unknown;
}> {}

function resolveApiBase(): string {
  const explicit = (import.meta as { env?: Record<string, string> }).env?.VITE_API_URL;
  if (explicit) return explicit;
  if (typeof window === "undefined") return "";
  const envPort = (import.meta as { env?: Record<string, string> }).env?.VITE_API_PORT;
  const port = envPort ?? "6060";
  const host = window.location.hostname === "localhost" ? "127.0.0.1" : window.location.hostname;
  return `${window.location.protocol}//${host}:${port}`;
}

export const API_BASE: string = resolveApiBase();

/**
 * Effect-wrapped `fetch`. Maps a non-2xx response to a `ApiError` with
 * the daemon's error body when it can be parsed, otherwise a synthetic
 * status-only message. Network failures (DNS, connection refused) also
 * land on `ApiError` with `status: 0`.
 */
function request<T>(path: string, init?: RequestInit): Effect.Effect<T, ApiError> {
  return Effect.tryPromise({
    try: async () => {
      const res = await fetch(`${API_BASE}${path}`, { cache: "no-store", ...init });
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body?.error) message = body.error;
        } catch {
          // Body wasn't JSON; the status-only message stands.
        }
        throw new ApiError({ status: res.status, message });
      }
      return (await res.json()) as T;
    },
    catch: (cause) =>
      cause instanceof ApiError
        ? cause
        : new ApiError({ status: 0, message: cause instanceof Error ? cause.message : String(cause), cause }),
  });
}

/**
 * GET /api/sessions — list registered tmux-ide sessions. Widgets gallery
 * uses the first session's name + dir to pin TUI tile deep-links so
 * `/v2/widget/:name?session=&dir=` resolves to something real.
 */
export function fetchSessions(): Effect.Effect<readonly SessionOverview[], ApiError> {
  return request<{ sessions: SessionOverview[] }>("/api/sessions").pipe(
    Effect.map((data) => data.sessions ?? []),
  );
}
