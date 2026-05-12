/**
 * Daemon liveness probe.
 *
 * Two-stage check:
 *   1. `process.kill(pid, 0)` — does the OS still know about that PID?
 *      Throws ESRCH if dead, EPERM if alive but un-signalable. EPERM still
 *      counts as "alive" for our purposes.
 *   2. GET ${baseUrl}/healthz with a 1s deadline. The daemon's healthz
 *      handler returns { ok: true, version, uptimeMs }. Any 200 response
 *      with `ok: true` counts as alive.
 *
 * Both stages must pass — a stale lock file with a PID that happens to be
 * reused by an unrelated process won't accidentally pass step 1.
 */

import type { LockData } from "./lock.ts";

export interface HealthOptions {
  /** Override fetch (tests). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Total budget in ms for the HTTP probe. Defaults to 1000. */
  timeoutMs?: number;
  /** Base URL override. Defaults to http://127.0.0.1:<lock.port>. */
  baseUrl?: string;
}

function pidIsAlive(pid: number): boolean {
  try {
    // Signal 0 is a no-op send — used to test whether the PID is reachable.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we lack permission — still alive.
    if (code === "EPERM") return true;
    return false;
  }
}

export async function isDaemonAlive(
  lock: LockData,
  options: HealthOptions = {},
): Promise<boolean> {
  if (!pidIsAlive(lock.pid)) return false;

  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) return false;

  const baseUrl = options.baseUrl ?? `http://127.0.0.1:${lock.port}`;
  const timeoutMs = options.timeoutMs ?? 1000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${baseUrl}/healthz`, {
      headers: { Authorization: `Bearer ${lock.token}` },
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    return !!body && body.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
