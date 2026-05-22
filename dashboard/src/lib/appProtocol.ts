/**
 * Minimal protocol resolver — Solid port of the slice the project
 * shell uses.
 *
 * The React version (`dashboard/lib/appProtocol.ts`) also handles
 * Electron-injected runtime ports, an auth-token cookie, and SSL
 * upgrades. P2 covers the browser-only path; the Electron path lands
 * with the Tauri/Electron consumer in G16-P3.
 */

import { API_BASE } from "./api";

function authQuery(): string {
  if (typeof window === "undefined") return "";
  const token = window.sessionStorage?.getItem("tmux-ide.auth.token");
  return token ? `?token=${encodeURIComponent(token)}` : "";
}

export function withApiBase(path: string): string {
  const sep = path.startsWith("/") ? "" : "/";
  return `${API_BASE}${sep}${path}`;
}

/** Map HTTP API base → ws(s):// URL. */
export function withWsBase(path: string): string {
  const sep = path.startsWith("/") ? "" : "/";
  const httpUrl = `${API_BASE}${sep}${path}`;
  const wsUrl = httpUrl.replace(/^http/, "ws");
  const auth = authQuery();
  if (!auth) return wsUrl;
  return wsUrl.includes("?") ? `${wsUrl}&${auth.slice(1)}` : `${wsUrl}${auth}`;
}

export function resolveAuthToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.sessionStorage?.getItem("tmux-ide.auth.token") ?? null;
}
