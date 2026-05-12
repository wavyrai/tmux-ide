/**
 * Typed daemon HTTP client built from the route registry.
 *
 * Usage:
 *   const client = createApiClient({ apiBaseUrl: "http://127.0.0.1:6060", bearerToken: null });
 *   const sessions = await client.call("sessions.list");
 *   const detail = await client.call("project.detail", { params: { name: "tmux-ide" } });
 *   const spec = await client.call("widget.spawn", {
 *     params: { name: "explorer" },
 *     query: { session: "tmux-ide", dir: "/Users/me/repo" },
 *   });
 *
 * Routes marked `nullableOn404: true` return `T | null` instead of throwing
 * on a 404. Other non-2xx responses always throw.
 *
 * The client does NOT validate the response by default — runtime parse adds
 * a measurable cost on every call. Pass `{ validate: true }` to opt in for a
 * specific call (useful in tests). When `validate` is true the client runs
 * the response through the route's zod schema and throws on shape drift.
 */

import { z } from "zod";
import { routes, type RouteBody, type RouteName, type RouteParams, type RouteQuery, type RouteResponse } from "./routes.ts";

export interface ApiClientOptions {
  apiBaseUrl: string;
  bearerToken?: string | null;
  /** Override fetch (e.g. for tests). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export interface CallOptionsBase {
  /** Run the response through the route's zod schema. Off by default. */
  validate?: boolean;
  /** Forward an AbortSignal to the underlying fetch. */
  signal?: AbortSignal;
  /** Per-call header overrides (merged on top of the client defaults). */
  headers?: Record<string, string>;
}

export type CallOptions<R extends RouteName> = CallOptionsBase &
  (RouteParams<R> extends void ? { params?: undefined } : { params: RouteParams<R> }) &
  (RouteQuery<R> extends void ? { query?: undefined } : { query: RouteQuery<R> }) &
  (RouteBody<R> extends void ? { body?: undefined } : { body: RouteBody<R> });

export class ApiClientError extends Error {
  readonly status: number;
  readonly route: string;
  constructor(route: string, status: number, message: string) {
    super(`[${route}] HTTP ${status}: ${message}`);
    this.name = "ApiClientError";
    this.status = status;
    this.route = route;
  }
}

function fillPath(template: string, params: Record<string, string> | undefined): string {
  if (!params) return template;
  return template.replace(/:([A-Za-z0-9_]+)/g, (_match, key: string) => {
    const value = params[key];
    if (value === undefined || value === null) {
      throw new Error(`missing path param "${key}" for route ${template}`);
    }
    return encodeURIComponent(String(value));
  });
}

function buildQueryString(query: Record<string, string | undefined> | undefined): string {
  if (!query) return "";
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
}

export interface ApiClient {
  call<R extends RouteName>(
    name: R,
    opts?: CallOptions<R>,
  ): Promise<
    (typeof routes)[R] extends { nullableOn404: true }
      ? RouteResponse<R> | null
      : RouteResponse<R>
  >;
}

export function createApiClient(opts: ApiClientOptions): ApiClient {
  const fetchImpl: typeof fetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);

  return {
    async call(name, callOpts) {
      const route = routes[name];
      const co = (callOpts ?? {}) as CallOptionsBase & {
        params?: Record<string, string>;
        query?: Record<string, string | undefined>;
        body?: unknown;
      };

      const path = fillPath(route.path, co.params);
      const queryStr = buildQueryString(co.query);
      const url = `${opts.apiBaseUrl}${path}${queryStr}`;

      const headers: Record<string, string> = {
        ...(opts.bearerToken ? { Authorization: `Bearer ${opts.bearerToken}` } : {}),
        ...co.headers,
      };

      let body: BodyInit | undefined;
      if (co.body !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(co.body);
      }

      const init: RequestInit = {
        method: route.method,
        headers,
        cache: "no-store",
      };
      if (body !== undefined) init.body = body;
      if (co.signal) init.signal = co.signal;

      const res = await fetchImpl(url, init);

      if (!res.ok) {
        if ("nullableOn404" in route && route.nullableOn404 && res.status === 404) {
          return null as never;
        }
        const text = await res.text().catch(() => "");
        throw new ApiClientError(name, res.status, text.slice(0, 200));
      }

      const data = (await res.json()) as unknown;
      if (co.validate) {
        const parsed = (route.res as z.ZodTypeAny).safeParse(data);
        if (!parsed.success) {
          throw new ApiClientError(
            name,
            500,
            `response failed schema: ${parsed.error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; ")}`,
          );
        }
        return parsed.data as never;
      }
      return data as never;
    },
  };
}
