import type { ApplicationShellResourceV2, CanonicalDaemonInfo } from "@tmux-ide/contracts";

import type { HomeCatalogSession, HomeCatalogSnapshot } from "./home-catalog.ts";
import {
  projectHomeAgentRows,
  sortHomeAgentRows,
  type HomeAgentRow,
  type HomeAgentSnapshot,
} from "@tmux-ide/presentation/home-agent-roster";

export interface HomeAgentObservationHandlers {
  ready(unavailableSessionKeys: readonly string[]): void;
  invalidate(sessionKey?: string): void;
  /** Advisory cadence: an already-running read satisfies this refresh. */
  refresh?(sessionKey?: string): void;
  unavailable(): void;
}

export interface HomeAgentDependencies {
  readDaemon(): CanonicalDaemonInfo | null;
  fetchShell(
    daemon: CanonicalDaemonInfo,
    session: HomeCatalogSession,
    signal: AbortSignal,
  ): Promise<ApplicationShellResourceV2>;
  connect(
    daemon: CanonicalDaemonInfo,
    sessions: readonly HomeCatalogSession[],
    handlers: HomeAgentObservationHandlers,
  ): { close(): void };
}

export interface HomeAgentObserver {
  adoptCatalog(snapshot: HomeCatalogSnapshot): void;
  setActive(active: boolean): void;
  invalidate(sessionKey?: string): void;
  retry(): void;
  loadMore(): void;
  getSnapshot(): HomeAgentSnapshot;
  isCurrentTarget(
    target: Pick<
      HomeAgentRow,
      "key" | "sessionName" | "agentId" | "paneId" | "daemonInstanceId" | "liveSessionId"
    >,
  ): boolean;
  subscribe(listener: (snapshot: HomeAgentSnapshot) => void): () => void;
  dispose(): void;
}

type Slot = {
  session: HomeCatalogSession;
  status: "loading" | "live" | "unavailable";
  rows: HomeAgentRow[];
  dirty: boolean;
  lastRead: number;
  revision: number;
  controller: AbortController | null;
  observationAvailable: boolean;
  notYetAvailable: boolean;
};

/** Home-only observation; never creates a terminal client or mutates a session. */
export function createHomeAgentObserver(deps: HomeAgentDependencies): HomeAgentObserver {
  let active = false;
  let disposed = false;
  let limit = 32;
  let generation = 0;
  let inFlight = 0;
  let readOrder = 0;
  let ready = false;
  let transportFailed = false;
  let daemon: CanonicalDaemonInfo | null = null;
  let connection: { close(): void } | null = null;
  let catalog: HomeCatalogSnapshot | null = null;
  let signature = "";
  const slots = new Map<string, Slot>();
  const listeners = new Set<(snapshot: HomeAgentSnapshot) => void>();

  const snapshot = (): HomeAgentSnapshot => {
    const all = [...slots.values()];
    const observedSessions = all.filter((slot) => slot.status === "live").length;
    const unavailableSessions = all.filter((slot) => slot.status === "unavailable").length;
    const loadingSessions = all.filter((slot) => slot.status === "loading").length;
    const unopenedSessions = all.filter(
      (slot) => slot.status === "unavailable" && slot.notYetAvailable,
    ).length;
    const totalSessions = catalog?.sessions.length ?? 0;
    const truncatedSessions = Math.max(0, totalSessions - all.length);
    const unavailable =
      transportFailed ||
      catalog?.phase === "unavailable" ||
      (all.length > 0 && unavailableSessions === all.length);
    const phase = unavailable
      ? "unavailable"
      : (observedSessions === 0 && loadingSessions > 0) || !catalog || catalog.phase === "loading"
        ? "loading"
        : unavailableSessions > 0 || loadingSessions > 0 || truncatedSessions > 0
          ? "partial"
          : "live";
    return {
      phase,
      rows: sortHomeAgentRows(all.flatMap((slot) => slot.rows)),
      observedSessions,
      totalSessions,
      loadingSessions,
      unavailableSessions,
      truncatedSessions,
      refreshingSessionKeys: all
        .filter((slot) => slot.status === "loading")
        .map((slot) => slot.session.id),
      unavailableSessionKeys: all
        .filter((slot) => slot.status === "unavailable")
        .map((slot) => slot.session.id),
      note:
        transportFailed || catalog?.phase === "unavailable"
          ? "Agent updates unavailable. Retry to reconnect."
          : unopenedSessions > 0
            ? `${unopenedSessions} session${unopenedSessions === 1 ? " is" : "s are"} not yet available. Open a session in Terminals to make its agents available.`
            : unavailable
              ? "Agent observations unavailable. Retry to refresh."
              : unavailableSessions > 0
                ? `${unavailableSessions} session${unavailableSessions === 1 ? "" : "s"} unavailable; other agents are shown.`
                : truncatedSessions > 0
                  ? `Showing ${all.length} of ${totalSessions} sessions. Load more to observe the rest.`
                  : loadingSessions > 0
                    ? "Discovering agents…"
                    : null,
    };
  };
  const publish = () => {
    if (disposed) return;
    const next = snapshot();
    for (const listener of listeners) {
      try {
        listener(next);
      } catch {
        /* A presentation observer cannot own resource lifetime. */
      }
    }
  };
  const retire = () => {
    generation++;
    ready = false;
    connection?.close();
    connection = null;
    for (const slot of slots.values()) slot.controller?.abort();
    slots.clear();
    // Aborted promises still count against the global concurrency budget until
    // they settle; a dependency that ignores abort cannot create extra reads.
  };
  const pump = () => {
    if (!active || disposed || !ready || !daemon) return;
    // Least-recently-served slots run first; hot invalidations cannot starve siblings.
    for (const slot of [...slots.values()].sort((a, b) => a.lastRead - b.lastRead)) {
      if (inFlight >= 2) break;
      if (!slot.dirty || slot.controller) continue;
      slot.dirty = false;
      slot.lastRead = ++readOrder;
      const requestGeneration = generation;
      const requestDaemon = daemon;
      const revision = slot.revision;
      const controller = new AbortController();
      slot.controller = controller;
      inFlight++;
      void Promise.resolve()
        .then(() => deps.fetchShell(requestDaemon, slot.session, controller.signal))
        .then(
          (shell) => {
            if (
              disposed ||
              requestGeneration !== generation ||
              controller.signal.aborted ||
              revision !== slot.revision
            )
              return;
            if (shell.daemon.instanceId !== requestDaemon.instanceId) {
              slot.status = "unavailable";
              return;
            }
            slot.rows = projectHomeAgentRows(slot.session, shell);
            slot.status = "live";
            slot.notYetAvailable = false;
          },
          (error: unknown) => {
            if (
              disposed ||
              requestGeneration !== generation ||
              controller.signal.aborted ||
              revision !== slot.revision
            )
              return;
            slot.status = "unavailable";
            slot.notYetAvailable =
              !slot.session.workspaceName &&
              error instanceof Error &&
              error.message.includes("HTTP 404");
          },
        )
        .finally(() => {
          inFlight--;
          if (slot.controller === controller) slot.controller = null;
          // Retiring Home clears observation slots, not the resident selection.
          // An aborted read must not publish that empty retired state as removal.
          if (active && requestGeneration === generation) publish();
          pump();
        });
    }
  };
  const refresh = (sessionKey?: string) => {
    if (!active || disposed) return;
    for (const [key, slot] of slots) {
      if (sessionKey !== undefined && sessionKey !== key) continue;
      if (!slot.observationAvailable || slot.controller) continue;
      slot.dirty = true;
      slot.status = "loading";
    }
    publish();
    pump();
  };
  const invalidate = (sessionKey?: string) => {
    if (!active || disposed) return;
    for (const [key, slot] of slots) {
      if (sessionKey !== undefined && sessionKey !== key) continue;
      if (!slot.observationAvailable) continue;
      slot.revision++;
      slot.dirty = true;
      slot.status = "loading";
    }
    publish();
    pump();
  };
  const reconcile = (force = false) => {
    if (disposed || !active) return;
    const nextDaemon = deps.readDaemon();
    const sessions = catalog?.sessions.slice(0, limit) ?? [];
    const nextSignature = JSON.stringify([
      catalog?.phase,
      catalog?.daemonInstanceId,
      nextDaemon?.instanceId,
      sessions.map(({ id, name, workspaceName }) => [id, name, workspaceName]),
    ]);
    if (!force && signature === nextSignature) return;
    signature = nextSignature;
    const previous = new Map(slots);
    retire();
    daemon = nextDaemon;
    transportFailed = false;
    if (!catalog || catalog.phase !== "live") {
      publish();
      return;
    }
    if (!daemon || daemon.instanceId !== catalog.daemonInstanceId) {
      transportFailed = true;
      publish();
      return;
    }
    for (const session of sessions)
      slots.set(session.id, {
        session,
        status: "loading",
        rows:
          previous.get(session.id)?.rows.map((row) => ({ ...row, sessionName: session.name })) ??
          [],
        dirty: true,
        lastRead: 0,
        revision: 0,
        controller: null,
        observationAvailable: true,
        notYetAvailable: false,
      });
    if (sessions.length === 0) {
      ready = true;
      publish();
      return;
    }
    const token = generation;
    try {
      connection = deps.connect(daemon, sessions, {
        ready(unavailable) {
          if (token !== generation || disposed) return;
          ready = true;
          for (const key of unavailable) {
            const slot = slots.get(key);
            if (slot) {
              slot.status = "unavailable";
              slot.dirty = false;
              slot.observationAvailable = false;
            }
          }
          publish();
          pump();
        },
        invalidate(key) {
          if (token === generation) invalidate(key);
        },
        refresh(key) {
          if (token === generation) refresh(key);
        },
        unavailable() {
          if (token !== generation || disposed) return;
          transportFailed = true;
          ready = false;
          for (const slot of slots.values()) {
            slot.revision++;
            slot.controller?.abort();
            slot.status = "unavailable";
          }
          publish();
        },
      });
    } catch {
      transportFailed = true;
    }
    publish();
  };
  return {
    adoptCatalog(next) {
      if (
        next.phase === "loading" &&
        catalog?.phase === "live" &&
        next.daemonInstanceId === catalog.daemonInstanceId
      )
        return;
      catalog = next;
      reconcile();
    },
    setActive(next) {
      if (active === next || disposed) return;
      active = next;
      if (active) reconcile(true);
      else {
        retire();
        signature = "";
      }
    },
    invalidate,
    retry() {
      reconcile(true);
    },
    loadMore() {
      limit += 32;
      reconcile(true);
    },
    getSnapshot: snapshot,
    isCurrentTarget(target) {
      if (!active || disposed || !ready || transportFailed) return false;
      return [...slots.values()].some(
        (slot) =>
          slot.status === "live" &&
          slot.rows.some(
            (row) =>
              row.key === target.key &&
              row.sessionName === target.sessionName &&
              row.agentId === target.agentId &&
              row.paneId !== null &&
              row.paneId === target.paneId &&
              row.daemonInstanceId === target.daemonInstanceId &&
              row.liveSessionId === target.liveSessionId,
          ),
      );
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot());
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      active = false;
      retire();
      listeners.clear();
    },
  };
}

/**
 * A roster answers "is this row current" with no while it re-reads the row's
 * session, and it re-reads whenever an agent appears or changes: the moment a
 * row gets clicked. This waits for that re-read to finish instead of taking
 * the no for an answer.
 */
export const ROSTER_SETTLE_MS = 3_000;

/**
 * Resolves true as soon as the target is current, false as soon as the roster
 * is not re-reading and the target still is not current, and whatever holds at
 * the bound or when `signal` aborts (aborted: false).
 */
export function waitForRosterTarget(options: {
  readonly isCurrent: () => boolean;
  readonly refreshing: () => boolean;
  /** Called on every roster publication; may deliver one synchronously. */
  readonly subscribe: (listener: () => void) => () => void;
  readonly signal: AbortSignal;
  readonly boundMs?: number;
}): Promise<boolean> {
  if (options.signal.aborted) return Promise.resolve(false);
  if (options.isCurrent()) return Promise.resolve(true);
  if (!options.refreshing()) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    let stop: (() => void) | null = null;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      stop?.();
      resolve(value);
    };
    const abort = (): void => finish(false);
    const check = (): void => {
      if (settled) return;
      if (options.isCurrent()) finish(true);
      else if (!options.refreshing()) finish(false);
    };
    const timer = setTimeout(
      () => finish(options.isCurrent()),
      options.boundMs ?? ROSTER_SETTLE_MS,
    );
    (timer as { unref?: () => void }).unref?.();
    options.signal.addEventListener("abort", abort, { once: true });
    const unsubscribe = options.subscribe(check);
    if (settled) unsubscribe();
    else stop = unsubscribe;
  });
}
