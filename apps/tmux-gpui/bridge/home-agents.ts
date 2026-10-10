import type { ApplicationShellProjectionInputV2, TmuxServerScope } from "@tmux-ide/contracts";
import {
  projectHomeAgentRows,
  sortHomeAgentRows,
  type HomeAgentCatalogSession,
  type HomeAgentRow,
  type HomeAgentSnapshot,
} from "../../../packages/presentation/src/home-agent-roster.ts";

type Slot = {
  session: HomeAgentCatalogSession;
  phase: "loading" | "live" | "unavailable";
  rows: HomeAgentRow[];
  controller: AbortController | null;
  started: boolean;
};
export interface HomeAgentDependencies {
  readShell(
    session: HomeAgentCatalogSession,
    signal: AbortSignal,
  ): Promise<{ server: TmuxServerScope; resource: ApplicationShellProjectionInputV2 }>;
  publish(snapshot: HomeAgentSnapshot): void;
}
/** Home observation only. Browser owns cadence/activation; this owner never opens sessions.
 * Retired reads retain their concurrency slot until settlement, even if they ignore abort.
 */
export function createHomeAgentObserver(deps: HomeAgentDependencies) {
  let disposed = false;
  let epoch = 0;
  let inFlight = 0;
  let total = 0;
  let slots: Slot[] = [];
  function getSnapshot(): HomeAgentSnapshot {
    const count = (phase: Slot["phase"]) => slots.filter((s) => s.phase === phase).length;
    const observedSessions = count("live");
    const loadingSessions = count("loading");
    const unavailableSessions = count("unavailable");
    const truncatedSessions = total - slots.length;
    const phase =
      unavailableSessions > 0 && unavailableSessions === slots.length
        ? "unavailable"
        : !observedSessions && loadingSessions
          ? "loading"
          : loadingSessions || unavailableSessions || truncatedSessions
            ? "partial"
            : "live";
    return {
      phase,
      rows: sortHomeAgentRows(slots.flatMap((s) => s.rows)),
      observedSessions,
      totalSessions: total,
      loadingSessions,
      unavailableSessions,
      truncatedSessions,
      refreshingSessionKeys: slots.filter((s) => s.phase === "loading").map((s) => s.session.id),
      unavailableSessionKeys: slots
        .filter((s) => s.phase === "unavailable")
        .map((s) => s.session.id),
      note: unavailableSessions
        ? "Some session agent observations are unavailable. Refresh to retry."
        : truncatedSessions
          ? "Agent observation is limited to the first 32 sessions."
          : loadingSessions
            ? "Discovering agents…"
            : null,
    };
  }
  function publish() {
    if (!disposed) {
      try {
        deps.publish(getSnapshot());
      } catch {
        /* Presentation cannot own read lifetime. */
      }
    }
  }
  function pump() {
    if (disposed) return;
    for (const slot of slots) {
      if (inFlight >= 4) break;
      if (slot.phase !== "loading" || slot.started) continue;
      slot.started = true;
      const capturedEpoch = epoch;
      const controller = new AbortController();
      slot.controller = controller;
      inFlight++;
      void Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted();
          return deps.readShell(slot.session, controller.signal);
        })
        .then((shell) => {
          if (disposed || epoch !== capturedEpoch || controller.signal.aborted) return;
          const scope = slot.session.server!;
          if (
            shell.server.serverId !== scope.serverId ||
            shell.server.generation !== scope.generation
          )
            throw new Error("Stale shell scope");
          slot.rows = projectHomeAgentRows(slot.session, {
            resource: shell.resource,
            daemon: { instanceId: scope.generation },
          });
          slot.phase = "live";
        })
        .catch(() => {
          if (!disposed && epoch === capturedEpoch && !controller.signal.aborted) {
            slot.rows = [];
            slot.phase = "unavailable";
          }
        })
        .finally(() => {
          inFlight--;
          if (!disposed && epoch === capturedEpoch) publish();
          pump();
        });
    }
  }
  return {
    getSnapshot,
    refresh(sessions: readonly HomeAgentCatalogSession[]) {
      if (disposed) return;
      epoch++;
      for (const slot of slots) slot.controller?.abort();
      total = sessions.length;
      slots = sessions.slice(0, 32).map((input) => {
        const session = Object.freeze({
          ...input,
          ...(input.server ? { server: Object.freeze({ ...input.server }) } : {}),
        });
        return {
          session,
          phase:
            session.workspaceName && session.liveSessionId && session.server
              ? "loading"
              : "unavailable",
          rows: [],
          controller: null,
          started: false,
        };
      });
      publish();
      pump();
    },
    // Observation freshness only: opening must revalidate exact pane inventory.
    isCurrentTarget(target: HomeAgentRow) {
      return (
        !disposed &&
        slots.some(
          (slot) =>
            slot.phase === "live" &&
            slot.rows.some(
              (row) =>
                row.key === target.key &&
                row.liveSessionId === target.liveSessionId &&
                row.daemonInstanceId === target.daemonInstanceId &&
                row.server?.serverId === target.server?.serverId &&
                row.paneId !== null &&
                row.paneId === target.paneId &&
                row.agentId === target.agentId,
            ),
        )
      );
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      epoch++;
      for (const slot of slots) slot.controller?.abort();
      slots = [];
      total = 0;
    },
  };
}
