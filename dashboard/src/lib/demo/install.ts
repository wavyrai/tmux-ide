/**
 * Demo mode — installs a `window.fetch` interceptor that short-circuits
 * the dashboard's daemon API calls to canned responses from `demoData`.
 *
 * Activated by `?demo=1` on the URL, `localStorage.tmuxIdeDemo === "1"`,
 * or the hostname containing "demo" (deploys at e.g. demo.tmux-ide.dev).
 *
 * Calls into resources outside the daemon (Vite HMR, static asset URLs,
 * `localhost` ports other than the daemon port) pass through untouched.
 */
import { resolveDemoResponse } from "./demoData";

const DEMO_FLAG_KEY = "tmuxIdeDemo";

export function isDemoMode(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("demo") === "1") {
      window.localStorage.setItem(DEMO_FLAG_KEY, "1");
      return true;
    }
    if (window.localStorage.getItem(DEMO_FLAG_KEY) === "1") return true;
    if (window.location.hostname.startsWith("demo.")) return true;
    // Auto-activate when the SPA is served under a /demo/ subpath
    // (e.g. bundled into the docs site at docs/public/demo/). Visitors
    // get the canned data with no URL flag required.
    if (window.location.pathname.startsWith("/demo/")) return true;
    // Vite injects this when built with `--base=/demo/`.
    const baseUrl = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL;
    if (baseUrl && baseUrl !== "/" && baseUrl.includes("demo")) return true;
  } catch {
    // SSR / restricted contexts — fall through.
  }
  return false;
}

export function exitDemoMode(): void {
  try {
    window.localStorage.removeItem(DEMO_FLAG_KEY);
  } catch {
    // ignore
  }
}

let installed = false;

export function installDemoFetch(): void {
  if (installed) return;
  installed = true;

  const realFetch = window.fetch.bind(window);

  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = toUrl(input);
    // Only intercept API calls — let Vite HMR, static assets, etc. pass.
    if (!url.pathname.startsWith("/api/")) {
      return realFetch(input, init);
    }

    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    let body: unknown;
    if (init?.body && typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }

    const canned = resolveDemoResponse(url, method, body);
    if (!canned) {
      // Unknown endpoint — return a 404 envelope rather than calling
      // through to the real network (which would 500 on the demo deploy).
      return new Response(JSON.stringify({ error: "demo-no-fixture", path: url.pathname }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(canned.body), {
      status: canned.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof window.fetch;
}

function toUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input;
  const raw = typeof input === "string" ? input : input.url;
  try {
    return new URL(raw);
  } catch {
    return new URL(raw, window.location.origin);
  }
}
