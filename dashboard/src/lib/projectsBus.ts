/**
 * Lightweight WS subscription for the projects/sessions registry.
 *
 * Opens a single shared connection to `/ws/events` on first use,
 * increments a module-level `tick` signal whenever a
 * `projects.changed` or `sessions.changed` frame arrives, and closes
 * when the last consumer unsubscribes. Resources that read `tick()`
 * automatically refetch — no per-component reconnect logic.
 *
 * Reconnects with exponential backoff so a daemon restart doesn't
 * leave the welcome route flying blind.
 */

import { createSignal, onCleanup, onMount } from "solid-js";
import { withWsBase } from "@/lib/appProtocol";

const MIN_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;

const [tick, setTick] = createSignal(0);

/** Reactive bump counter — read inside `createResource` source to
 *  drive automatic refetch on every projects/sessions change. */
export function projectsBusTick(): number {
  return tick();
}

let refs = 0;
let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoff = MIN_BACKOFF_MS;
let stopped = false;

function bump(): void {
  setTick((n) => n + 1);
}

function connect(): void {
  if (stopped) return;
  let url: string;
  try {
    url = withWsBase("/ws/events");
  } catch {
    return;
  }
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch {
    reconnectTimer = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    return;
  }
  socket = ws;
  ws.addEventListener("open", () => {
    backoff = MIN_BACKOFF_MS;
  });
  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let frame: unknown;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!frame || typeof frame !== "object") return;
    const type = (frame as { type?: string }).type;
    if (type === "projects.changed" || type === "sessions.changed") {
      bump();
    }
  });
  ws.addEventListener("close", () => {
    socket = null;
    if (stopped) return;
    reconnectTimer = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  });
  ws.addEventListener("error", () => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  });
}

function start(): void {
  if (socket || reconnectTimer) return;
  stopped = false;
  backoff = MIN_BACKOFF_MS;
  connect();
}

function stop(): void {
  stopped = true;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    try {
      socket.close();
    } catch {
      /* ignore */
    }
    socket = null;
  }
}

/**
 * Hook: mount the shared projects/sessions WS subscription for the
 * lifetime of the calling component. Reference-counted so multiple
 * consumers (e.g. the welcome list and the quick-switcher overlay
 * mounted in the app root) share one socket.
 */
export function useProjectsBus(): void {
  onMount(() => {
    refs += 1;
    if (refs === 1) start();
  });
  onCleanup(() => {
    refs -= 1;
    if (refs <= 0) {
      refs = 0;
      stop();
    }
  });
}
