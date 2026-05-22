/**
 * Session.dir resolver — caches the OS-absolute working directory
 * for each known session.name. LSP responses come back with
 * `file:///abs/path/...` URIs; the dashboard needs `session.dir` so
 * it can relativize those to the workspace-scoped path expected by
 * `openFileAt` + the daemon's preview/save endpoints.
 *
 * One in-flight promise per session — concurrent callers share.
 */

import { Effect } from "effect";
import { fetchSessions } from "@/lib/api";

const cache = new Map<string, Promise<string | undefined>>();

export function getSessionDir(sessionName: string): Promise<string | undefined> {
  const hit = cache.get(sessionName);
  if (hit) return hit;
  const pending = Effect.runPromise(fetchSessions())
    .then((sessions) => sessions.find((s) => s.name === sessionName)?.dir)
    .catch(() => undefined);
  cache.set(sessionName, pending);
  pending.then((dir) => {
    // Don't poison the cache when the lookup fails — re-fetch on next call.
    if (!dir) cache.delete(sessionName);
  });
  return pending;
}

/** Test helper — clears the resolver cache. */
export function __resetSessionDirCacheForTests(): void {
  cache.clear();
}
