/**
 * Module-level pool of PtySessions keyed by id (G20-P2).
 *
 * Sessions survive React/Solid component unmounts — switching tabs
 * unmounts the visible PtyPane but the session keeps its WS open + a
 * non-disposed xterm parked in the off-screen host. `releaseSession`
 * fully disposes when the user closes the tab.
 */

import { PtySession } from "./PtySession";

const pool = new Map<string, PtySession>();

/** Return the PtySession for `id`, creating one if it doesn't exist
 *  yet. The caller is responsible for `session.connect()`. */
export function acquireSession(id: string): PtySession {
  let session = pool.get(id);
  if (!session) {
    session = new PtySession(id);
    pool.set(id, session);
  }
  return session;
}

/** Look up an existing session without creating one. Used by code
 *  paths that just want to observe a session's status (e.g. the tab
 *  strip's unread badge). */
export function peekSession(id: string): PtySession | null {
  return pool.get(id) ?? null;
}

/** Dispose + remove. Called when the user closes a tab. */
export function releaseSession(id: string): void {
  const session = pool.get(id);
  if (!session) return;
  session.dispose();
  pool.delete(id);
}

/** Iterate every live session — used by PaneSizingContext to push
 *  resize to every background session inside the pane. */
export function eachSession(): IterableIterator<PtySession> {
  return pool.values();
}

/** Dispose every session in the pool. Wired into
 *  `TerminalPoolProvider`'s `onCleanup`. */
export function disposeAllSessions(): void {
  for (const id of [...pool.keys()]) {
    releaseSession(id);
  }
}

/** Test helper: clear without disposing (used to reset state between
 *  vitest specs that don't create FrontendPty instances). */
export function _resetSessionPoolForTests(): void {
  pool.clear();
}
