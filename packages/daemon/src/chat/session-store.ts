/**
 * Session store (T078) — multi-agent threads.
 *
 * A Thread can host multiple Sessions; each Session is one provider
 * instance with its own runtimeMode/activeTurnId/role. This store keeps
 * the canonical Session records keyed by `(threadId, sessionId)` and
 * emits `chat.session.*` t3-style events as records are added,
 * mutated, or removed.
 *
 * Pure in-memory — persistence is the responsibility of the higher-level
 * thread-store aggregate (Thread.sessions[]) so the store stays
 * unit-testable without filesystem fixtures, in line with turn-store
 * and activity-log.
 */

import { randomUUID } from "node:crypto";
import type {
  ChatThreadEvent,
  RuntimeMode,
  Session,
  SessionRole,
  SessionStatus,
} from "@tmux-ide/contracts";

export interface AddSessionInput {
  threadId: string;
  /** Override the auto-generated session id (tests / replay). */
  id?: string;
  status?: SessionStatus;
  providerName: string | null;
  providerInstanceId?: string;
  runtimeMode?: RuntimeMode;
  role?: SessionRole;
  displayName?: string;
  activeTurnId?: string | null;
}

export interface UpdateSessionStatusInput {
  threadId: string;
  sessionId: string;
  status: SessionStatus;
  lastError?: string | null;
  activeTurnId?: string | null;
}

export interface SessionStore {
  add(input: AddSessionInput): Session;
  remove(threadId: string, sessionId: string): Session | null;
  get(threadId: string, sessionId: string): Session | null;
  list(threadId: string): Session[];
  updateStatus(input: UpdateSessionStatusInput): Session;
  /** Drop all sessions for a thread (used on thread.delete). */
  clear(threadId: string): void;
}

export interface MakeSessionStoreOptions {
  now?: () => Date;
  randomId?: () => string;
  /** Emit `chat.session.*` events. Optional so isolated unit tests can stay silent. */
  emit?: (event: ChatThreadEvent) => void;
}

export class SessionStoreError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "duplicate",
  ) {
    super(message);
    this.name = "SessionStoreError";
  }
}

export function makeSessionStore(opts: MakeSessionStoreOptions = {}): SessionStore {
  const now = opts.now ?? (() => new Date());
  const randomId = opts.randomId ?? randomUUID;
  const emit = opts.emit ?? (() => undefined);
  const byThread = new Map<string, Map<string, Session>>();

  function bucket(threadId: string): Map<string, Session> {
    let b = byThread.get(threadId);
    if (!b) {
      b = new Map();
      byThread.set(threadId, b);
    }
    return b;
  }

  return {
    add(input) {
      const b = bucket(input.threadId);
      const id = input.id ?? randomId();
      if (b.has(id)) {
        throw new SessionStoreError(
          `Session ${id} already exists on thread ${input.threadId}`,
          "duplicate",
        );
      }
      const session: Session = {
        id,
        threadId: input.threadId,
        status: input.status ?? "idle",
        providerName: input.providerName,
        ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
        runtimeMode: input.runtimeMode ?? "full-access",
        ...(input.role ? { role: input.role } : {}),
        ...(input.displayName ? { displayName: input.displayName } : {}),
        activeTurnId: input.activeTurnId ?? null,
        lastError: null,
        updatedAt: now().toISOString(),
      };
      b.set(id, session);
      emit({ type: "chat.session.added", threadId: input.threadId, session });
      return session;
    },
    remove(threadId, sessionId) {
      const b = byThread.get(threadId);
      const existing = b?.get(sessionId) ?? null;
      if (!existing) return null;
      b!.delete(sessionId);
      emit({ type: "chat.session.removed", threadId, sessionId });
      return existing;
    },
    get(threadId, sessionId) {
      return byThread.get(threadId)?.get(sessionId) ?? null;
    },
    list(threadId) {
      const b = byThread.get(threadId);
      return b ? [...b.values()] : [];
    },
    updateStatus(input) {
      const b = byThread.get(input.threadId);
      const existing = b?.get(input.sessionId);
      if (!existing) {
        throw new SessionStoreError(
          `Session ${input.sessionId} not found on thread ${input.threadId}`,
          "not_found",
        );
      }
      const next: Session = {
        ...existing,
        status: input.status,
        lastError: input.lastError !== undefined ? input.lastError : existing.lastError,
        activeTurnId: input.activeTurnId !== undefined ? input.activeTurnId : existing.activeTurnId,
        updatedAt: now().toISOString(),
      };
      b!.set(input.sessionId, next);
      emit({
        type: "chat.session.status-changed",
        threadId: input.threadId,
        sessionId: input.sessionId,
        status: next.status,
        ...(next.lastError !== undefined ? { lastError: next.lastError } : {}),
        ...(next.activeTurnId !== undefined ? { activeTurnId: next.activeTurnId } : {}),
      });
      return next;
    },
    clear(threadId) {
      byThread.delete(threadId);
    },
  };
}
