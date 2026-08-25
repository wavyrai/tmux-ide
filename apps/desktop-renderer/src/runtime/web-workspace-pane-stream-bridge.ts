import type { SessionRuntimeActivityKind, SessionRuntimePresenceState } from "@tmux-ide/contracts";

import type {
  PaneMirrorEvent,
  PaneStreamLayoutEvent,
  PaneStreamLayoutSnapshotEvent,
  PaneStreamSessionHandle,
  PaneStreamSessionListeners,
  PaneStreamTransport,
  PaneStreamTransportError,
} from "../terminal/pane-stream-transport.ts";

interface BridgeConnection {
  readonly workspaceName: string;
  readonly targetEpoch: number;
  readonly panes: ReadonlySet<string>;
  readonly interactive: boolean;
  readonly listeners: PaneStreamSessionListeners;
  readonly lanes: Map<string, { running: boolean; pending: PaneMirrorEvent | null }>;
  active: boolean;
  epoch: number;
}

type Card5SinkControl = {
  blocked: boolean;
  offeredCount: number;
  deliveredCount: number;
  coalescedCount: number;
  pendingCurrent: number;
  pendingPeak: number;
  queueCap: 1;
  waiters: Set<() => void>;
};

type Card5SinkGlobals = typeof globalThis & {
  __TMUX_IDE_CARD5_EVIDENCE_ENABLED__?: boolean;
  __TMUX_IDE_CARD5_SINK_CONTROL__?: {
    setBlocked(blocked: boolean): void;
    snapshot(): Readonly<Omit<Card5SinkControl, "waiters">>;
  };
};

/** Local compositor view of the one WorkspaceClient-owned physical stream. */
export interface WebWorkspacePaneStreamBridge extends PaneStreamTransport {
  publishPane(pane: string, event: PaneMirrorEvent): void;
  publishLayout(layout: PaneStreamLayoutEvent): void;
  publishLayoutSnapshot(snapshot: PaneStreamLayoutSnapshotEvent): void;
  replacePaneSet(panes: ReadonlySet<string>): void;
  end(error: PaneStreamTransportError | null): void;
  bindSession(session: PaneStreamSessionHandle | null, workspaceName?: string): void;
}

export function createWebWorkspacePaneStreamBridge(
  initialWorkspaceName: string,
): WebWorkspacePaneStreamBridge {
  const evidenceHost = globalThis as Card5SinkGlobals;
  const sinkControl: Card5SinkControl | null =
    evidenceHost.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__ === true
      ? {
          blocked: false,
          offeredCount: 0,
          deliveredCount: 0,
          coalescedCount: 0,
          pendingCurrent: 0,
          pendingPeak: 0,
          queueCap: 1,
          waiters: new Set(),
        }
      : null;
  if (sinkControl) {
    evidenceHost.__TMUX_IDE_CARD5_SINK_CONTROL__ = {
      setBlocked(blocked) {
        sinkControl.blocked = blocked;
        if (!blocked) {
          for (const release of sinkControl.waiters) release();
          sinkControl.waiters.clear();
        }
      },
      snapshot: () =>
        Object.freeze({
          blocked: sinkControl.blocked,
          offeredCount: Math.min(sinkControl.offeredCount, 0xffff_ffff),
          deliveredCount: Math.min(sinkControl.deliveredCount, 0xffff_ffff),
          coalescedCount: Math.min(sinkControl.coalescedCount, 0xffff_ffff),
          pendingCurrent: Math.min(sinkControl.pendingCurrent, 1),
          pendingPeak: Math.min(sinkControl.pendingPeak, 1),
          queueCap: 1,
        }),
    };
  }
  const connections = new Set<BridgeConnection>();
  const latest = new Map<string, Extract<PaneMirrorEvent, { type: "seed-batch" | "output" }>>();
  let layout: PaneStreamLayoutEvent | null = null;
  let layoutSnapshot: PaneStreamLayoutSnapshotEvent | null = null;
  let session: PaneStreamSessionHandle | null = null;
  let boundWorkspaceName = initialWorkspaceName;
  let targetEpoch = 0;
  let sessionEpoch = 0;
  let ended: PaneStreamTransportError | null | undefined;
  const replaySeed = (event: PaneMirrorEvent): PaneMirrorEvent =>
    event.type === "output" && event.replay
      ? {
          type: "seed-batch",
          batch: event.replay(),
          ...(event.canonical ? { canonical: event.canonical } : {}),
          ...(event.canonicalUpdate ? { canonicalUpdate: event.canonicalUpdate } : {}),
          ...(event.canonicalSnapshot ? { canonicalSnapshot: event.canonicalSnapshot } : {}),
        }
      : event;
  const isReplayAuthority = (
    event: PaneMirrorEvent,
  ): event is Extract<PaneMirrorEvent, { type: "seed-batch" | "output" }> =>
    event.type === "seed-batch" || (event.type === "output" && event.replay !== undefined);
  const coalescePending = (
    pending: PaneMirrorEvent | null,
    next: PaneMirrorEvent,
  ): PaneMirrorEvent => {
    // Closure is terminal. Otherwise never let a cursor/flow notification evict
    // the one bounded replay authority needed to reconstruct a skipped suffix.
    if (next.type === "closed" || isReplayAuthority(next)) return next;
    return pending && isReplayAuthority(pending) ? pending : next;
  };
  const enqueue = (connection: BridgeConnection, pane: string, event: PaneMirrorEvent): void => {
    if (
      !connection.active ||
      connection.targetEpoch !== targetEpoch ||
      connection.workspaceName !== boundWorkspaceName
    )
      return;
    if (sinkControl) sinkControl.offeredCount += 1;
    let lane = connection.lanes.get(pane);
    if (!lane) {
      lane = { running: false, pending: null };
      connection.lanes.set(pane, lane);
    }
    if (lane.running) {
      // A renderer-local consumer owns no upstream ACK. Retain only the latest
      // replayable authority while its current paint is in flight.
      lane.pending = coalescePending(lane.pending, event);
      if (sinkControl) sinkControl.coalescedCount += 1;
      if (sinkControl) {
        sinkControl.pendingCurrent = 1;
        sinkControl.pendingPeak = 1;
      }
      return;
    }
    lane.running = true;
    const drain = async (first: PaneMirrorEvent, startsCoalesced: boolean): Promise<void> => {
      let current: PaneMirrorEvent | null = first;
      let coalesced = startsCoalesced;
      try {
        while (
          connection.active &&
          connection.targetEpoch === targetEpoch &&
          connection.workspaceName === boundWorkspaceName &&
          current
        ) {
          if (sinkControl?.blocked) {
            await new Promise<void>((resolve) => sinkControl.waiters.add(resolve));
          }
          if (!connection.active) break;
          await connection.listeners.onPaneEvent(pane, coalesced ? replaySeed(current) : current);
          if (sinkControl) sinkControl.deliveredCount += 1;
          current = lane!.pending;
          lane!.pending = null;
          if (sinkControl) sinkControl.pendingCurrent = 0;
          coalesced = true;
        }
      } catch {
        // A renderer-local listener cannot reject the shared physical stream.
        // Any authority queued behind it is restarted as a replay seed below.
      } finally {
        lane!.running = false;
        const pending = lane!.pending;
        lane!.pending = null;
        if (sinkControl) sinkControl.pendingCurrent = 0;
        if (connection.lanes.get(pane) === lane) connection.lanes.delete(pane);
        if (connection.active && pending) {
          let restarted = connection.lanes.get(pane);
          if (!restarted) {
            restarted = { running: true, pending: null };
            connection.lanes.set(pane, restarted);
          } else {
            restarted.running = true;
          }
          lane = restarted;
          void drain(pending, true);
        }
      }
    };
    void drain(event, false);
  };
  const publishPane = (pane: string, event: PaneMirrorEvent): void => {
    if (event.type === "seed-batch") latest.set(pane, event);
    else if (event.type === "output" && event.replay) latest.set(pane, event);
    else if (event.type === "closed") latest.delete(pane);
    for (const connection of connections) {
      if (
        connection.targetEpoch === targetEpoch &&
        connection.workspaceName === boundWorkspaceName &&
        connection.panes.has(pane)
      )
        enqueue(connection, pane, event);
    }
  };
  return {
    async connect(request, listeners) {
      if (request.workspaceName !== boundWorkspaceName)
        return {
          status: "error",
          error: {
            code: "workspace-client-target-mismatch",
            reason: "The local terminal target is no longer current.",
            retryable: true,
          },
        };
      if (ended !== undefined)
        return {
          status: "error",
          error: ended ?? {
            code: "workspace-client-closed",
            reason: "The workspace client stream is closed.",
            retryable: true,
          },
        };
      const connection: BridgeConnection = {
        workspaceName: request.workspaceName,
        targetEpoch,
        panes: new Set(request.panes),
        interactive: request.viewerMode === "interactive",
        listeners,
        lanes: new Map(),
        active: true,
        epoch: 0,
      };
      connections.add(connection);
      if (layout) {
        const replayLayout = layout;
        queueMicrotask(() => {
          if (
            connection.active &&
            connection.targetEpoch === targetEpoch &&
            connection.workspaceName === boundWorkspaceName &&
            layout === replayLayout
          )
            listeners.onLayout?.(replayLayout);
        });
      }
      if (layoutSnapshot) {
        const replaySnapshot = layoutSnapshot;
        queueMicrotask(() => {
          if (
            connection.active &&
            connection.targetEpoch === targetEpoch &&
            connection.workspaceName === boundWorkspaceName &&
            layoutSnapshot === replaySnapshot
          )
            listeners.onLayoutSnapshot?.(replaySnapshot);
        });
      }
      for (const pane of request.panes) {
        const event = latest.get(pane);
        if (event)
          queueMicrotask(() => {
            if (
              !connection.active ||
              connection.targetEpoch !== targetEpoch ||
              connection.workspaceName !== boundWorkspaceName ||
              latest.get(pane) !== event
            )
              return;
            const replay =
              event.type === "seed-batch"
                ? event
                : event.replay
                  ? {
                      type: "seed-batch" as const,
                      batch: event.replay(),
                      ...(event.canonical ? { canonical: event.canonical } : {}),
                      ...(event.canonicalUpdate ? { canonicalUpdate: event.canonicalUpdate } : {}),
                      ...(event.canonicalSnapshot
                        ? { canonicalSnapshot: event.canonicalSnapshot }
                        : {}),
                    }
                  : null;
            if (replay) enqueue(connection, pane, replay);
          });
      }
      let disposed = false;
      return {
        status: "connected",
        session: {
          dispose() {
            if (disposed) return;
            disposed = true;
            connection.epoch += 1;
            connection.active = false;
            connections.delete(connection);
            connection.lanes.clear();
          },
          updatePresence(state: SessionRuntimePresenceState) {
            if (!connection.active || disposed || connection.workspaceName !== boundWorkspaceName)
              return;
            session?.updatePresence?.(state);
          },
          noteActivity(activity: SessionRuntimeActivityKind) {
            if (!connection.active || disposed || connection.workspaceName !== boundWorkspaceName)
              return;
            session?.noteActivity?.(activity);
          },
          connectionAuthorityClientId(authority) {
            const physical = session;
            const epoch = connection.epoch;
            const physicalEpoch = sessionEpoch;
            if (
              !connection.active ||
              disposed ||
              !connection.interactive ||
              connection.workspaceName !== boundWorkspaceName ||
              connection.epoch !== epoch ||
              sessionEpoch !== physicalEpoch ||
              session !== physical ||
              !physical?.connectionAuthorityClientId
            )
              return null;
            const clientId = physical.connectionAuthorityClientId(authority);
            return connection.active &&
              !disposed &&
              connection.interactive &&
              connection.workspaceName === boundWorkspaceName &&
              connection.epoch === epoch &&
              sessionEpoch === physicalEpoch &&
              session === physical
              ? clientId
              : null;
          },
          async write(pane, input) {
            const physical = session;
            const epoch = connection.epoch;
            const physicalEpoch = sessionEpoch;
            if (
              !connection.active ||
              disposed ||
              !connection.interactive ||
              connection.workspaceName !== boundWorkspaceName ||
              !connection.panes.has(pane) ||
              !physical?.write
            )
              return false;
            try {
              const result = await physical.write(pane, input);
              return connection.active &&
                !disposed &&
                connection.interactive &&
                connection.workspaceName === boundWorkspaceName &&
                connection.panes.has(pane) &&
                connection.epoch === epoch &&
                sessionEpoch === physicalEpoch &&
                session === physical
                ? result
                : false;
            } catch (error) {
              if (
                !connection.active ||
                disposed ||
                !connection.interactive ||
                connection.workspaceName !== boundWorkspaceName ||
                !connection.panes.has(pane) ||
                connection.epoch !== epoch ||
                sessionEpoch !== physicalEpoch ||
                session !== physical
              ) {
                return false;
              }
              throw error;
            }
          },
          async resize(cols, rows) {
            const physical = session;
            const epoch = connection.epoch;
            const physicalEpoch = sessionEpoch;
            if (
              !connection.active ||
              disposed ||
              !connection.interactive ||
              connection.workspaceName !== boundWorkspaceName ||
              !physical?.resize
            )
              return "lifecycle-retired";
            try {
              const result = await physical.resize(cols, rows);
              return connection.active &&
                !disposed &&
                connection.interactive &&
                connection.workspaceName === boundWorkspaceName &&
                connection.epoch === epoch &&
                sessionEpoch === physicalEpoch &&
                session === physical
                ? result
                : "lifecycle-retired";
            } catch (error) {
              if (
                !connection.active ||
                disposed ||
                !connection.interactive ||
                connection.workspaceName !== boundWorkspaceName ||
                connection.epoch !== epoch ||
                sessionEpoch !== physicalEpoch ||
                session !== physical
              ) {
                return "lifecycle-retired";
              }
              throw error;
            }
          },
          async requestAuthority(authority) {
            const physical = session;
            const epoch = connection.epoch;
            const physicalEpoch = sessionEpoch;
            if (
              !connection.active ||
              disposed ||
              !connection.interactive ||
              connection.workspaceName !== boundWorkspaceName ||
              !physical?.requestAuthority
            )
              return null;
            try {
              const result = await physical.requestAuthority(authority);
              return connection.active &&
                !disposed &&
                connection.interactive &&
                connection.workspaceName === boundWorkspaceName &&
                connection.epoch === epoch &&
                sessionEpoch === physicalEpoch &&
                session === physical
                ? result
                : null;
            } catch (error) {
              if (
                !connection.active ||
                disposed ||
                !connection.interactive ||
                connection.workspaceName !== boundWorkspaceName ||
                connection.epoch !== epoch ||
                sessionEpoch !== physicalEpoch ||
                session !== physical
              ) {
                return null;
              }
              throw error;
            }
          },
          async releaseAuthority(authority) {
            const physical = session;
            const epoch = connection.epoch;
            const physicalEpoch = sessionEpoch;
            if (
              !connection.active ||
              disposed ||
              !connection.interactive ||
              connection.workspaceName !== boundWorkspaceName ||
              !physical?.releaseAuthority ||
              !physical.connectionAuthorityClientId ||
              physical.connectionAuthorityClientId(authority) === null
            )
              return null;
            try {
              const result = await physical.releaseAuthority(authority);
              return connection.active &&
                !disposed &&
                connection.interactive &&
                connection.workspaceName === boundWorkspaceName &&
                connection.epoch === epoch &&
                sessionEpoch === physicalEpoch &&
                session === physical &&
                physical.connectionAuthorityClientId(authority) === null
                ? result
                : null;
            } catch (error) {
              if (
                !connection.active ||
                disposed ||
                !connection.interactive ||
                connection.workspaceName !== boundWorkspaceName ||
                connection.epoch !== epoch ||
                sessionEpoch !== physicalEpoch ||
                session !== physical
              ) {
                return null;
              }
              throw error;
            }
          },
        },
      };
    },
    publishPane(pane, event) {
      publishPane(pane, event);
    },
    publishLayout(next) {
      layout = next;
      for (const connection of connections) {
        if (
          connection.active &&
          connection.targetEpoch === targetEpoch &&
          connection.workspaceName === boundWorkspaceName
        )
          connection.listeners.onLayout?.(next);
      }
    },
    publishLayoutSnapshot(next) {
      layoutSnapshot = next;
      layout = null;
      for (const connection of connections) {
        if (
          connection.active &&
          connection.targetEpoch === targetEpoch &&
          connection.workspaceName === boundWorkspaceName
        )
          connection.listeners.onLayoutSnapshot?.(next);
      }
    },
    replacePaneSet(panes) {
      for (const pane of [...latest.keys()]) {
        if (!panes.has(pane)) publishPane(pane, { type: "closed" });
      }
    },
    end(error) {
      // A clean runtime retirement is a WorkspaceClient rebind boundary, not
      // a renderer-owned reconnect signal. Keep local bridge sessions alive;
      // the winning runtime will replace panes/layout and resume publication.
      if (error === null) {
        sessionEpoch += 1;
        session = null;
        return;
      }
      if (ended !== undefined) return;
      ended = error;
      for (const connection of connections) {
        connection.active = false;
        connection.lanes.clear();
        connection.listeners.onEnd(error);
      }
      connections.clear();
      if (sinkControl) {
        sinkControl.blocked = false;
        for (const release of sinkControl.waiters) release();
        sinkControl.waiters.clear();
        if (evidenceHost.__TMUX_IDE_CARD5_SINK_CONTROL__) {
          delete evidenceHost.__TMUX_IDE_CARD5_SINK_CONTROL__;
        }
      }
      latest.clear();
      layout = null;
      layoutSnapshot = null;
      sessionEpoch += 1;
      session = null;
    },
    bindSession(next, workspaceName = boundWorkspaceName) {
      if (next) ended = undefined;
      sessionEpoch += 1;
      const retired: BridgeConnection[] = [];
      if (workspaceName !== boundWorkspaceName) {
        targetEpoch += 1;
        for (const connection of [...connections]) {
          connection.epoch += 1;
          connection.active = false;
          connection.lanes.clear();
          connections.delete(connection);
          retired.push(connection);
        }
        latest.clear();
        layout = null;
        layoutSnapshot = null;
      }
      boundWorkspaceName = workspaceName;
      session = next;
      for (const connection of retired) {
        try {
          connection.listeners.onEnd({
            code: "workspace-client-target-mismatch",
            reason: "The local terminal target is no longer current.",
            retryable: true,
          });
        } catch {
          // A retired renderer-local listener cannot interrupt the target swap.
        }
      }
    },
  };
}
