import { createSignal, onCleanup, type Accessor } from "solid-js";
import {
  DesktopDaemonFetchFleetCatalogResultSchemaZ,
  type DaemonInstanceIdentity,
  type FleetCatalogResourceV1,
  type HostCapabilities,
} from "@tmux-ide/contracts";

import {
  createDaemonCatalogAdapter,
  daemonCatalogTerminalCode,
  sameDaemonIdentity,
  type DaemonCatalogView,
} from "./daemon-catalog-store.ts";
import {
  createGenerationBoundStore,
  type GenerationBoundClock,
  type GenerationBoundRetryPolicy,
} from "./generation-bound-store.ts";

/**
 * Generation-bound renderer store for the read-only fleet catalog.
 *
 * The loading/stale/retry/disposal policy lives once in
 * {@link ./generation-bound-store.ts}; this module supplies the fleet's fetch,
 * its invalidation events, and its projection. It subscribes with an empty
 * workspace set — the only subscription that receives the workspace-agnostic
 * `fleet.changed` invalidation — and re-fetches on `fleet.changed` and on
 * `workspaces.changed` (a promotion added a workspace-backed session).
 * `fleet.changed` reaches this store for BOTH kinds of change: fleet
 * COMPOSITION (the daemon's adopted-session poller) AND a ground-truth
 * agent-status transition — the latter arrives at the daemon as a
 * session-scoped `agent-status.changed` frame that the desktop broker folds
 * into a fleet-wide `fleet.changed` (see the daemon-resource-broker
 * `#projectServerFrame` fold; the daemon itself never emits `fleet.changed` on
 * a status flip). So a pane `@agent_state` flip refreshes this store's status
 * glyphs without opening the session and without a manual refetch. The daemon
 * endpoint, owner credential, and physical socket never reach here.
 */

export interface DesktopFleetCatalogSnapshot {
  readonly daemon: DaemonInstanceIdentity;
  readonly catalog: FleetCatalogResourceV1;
  readonly updatedAt: number;
}

interface DesktopFleetCatalogStateBase {
  readonly generation: number;
  readonly daemon: DaemonInstanceIdentity | null;
}

export type DesktopFleetCatalogState =
  | (DesktopFleetCatalogStateBase & { readonly status: "loading"; readonly snapshot: null })
  | (DesktopFleetCatalogStateBase & {
      readonly status: "live";
      readonly snapshot: DesktopFleetCatalogSnapshot;
    })
  | (DesktopFleetCatalogStateBase & {
      readonly status: "stale";
      readonly snapshot: DesktopFleetCatalogSnapshot;
      readonly reason: string;
    })
  | (DesktopFleetCatalogStateBase & {
      readonly status: "degraded";
      readonly snapshot: DesktopFleetCatalogSnapshot | null;
      readonly code:
        | "daemon-unavailable"
        | "daemon-degraded"
        | "daemon-identity-mismatch"
        | "invalid-response"
        | "event-unavailable";
      readonly reason: string;
    })
  | (DesktopFleetCatalogStateBase & {
      readonly status: "error";
      readonly snapshot: DesktopFleetCatalogSnapshot | null;
      readonly code: "request-failed" | "retry-exhausted";
      readonly reason: string;
    })
  | (DesktopFleetCatalogStateBase & {
      readonly status: "disposed";
      readonly daemon: null;
      readonly snapshot: null;
    });

export type DesktopFleetCatalogClock = GenerationBoundClock;
export type DesktopFleetCatalogRetryPolicy = Pick<
  GenerationBoundRetryPolicy,
  "initialDelayMs" | "maximumDelayMs" | "maximumAttempts"
>;

export interface DesktopFleetCatalogStoreOptions {
  readonly host: Pick<HostCapabilities, "daemon">;
  readonly daemon: unknown;
  readonly clock?: DesktopFleetCatalogClock;
  readonly retry?: Partial<DesktopFleetCatalogRetryPolicy>;
}

export type DesktopFleetCatalogStateListener = (state: DesktopFleetCatalogState) => void;

export interface DesktopFleetCatalogStore {
  getState(): DesktopFleetCatalogState;
  subscribe(listener: DesktopFleetCatalogStateListener): () => void;
  refresh(): void;
  setDaemon(daemon: unknown): void;
  dispose(): void;
}

export interface SolidDesktopFleetCatalogStore {
  readonly state: Accessor<DesktopFleetCatalogState>;
  refresh(): void;
  setDaemon(daemon: unknown): void;
  dispose(): void;
}

const WORDING = {
  staleReason: "Daemon fleet events are not connected.",
  eventsUnavailable: "Daemon fleet events are unavailable.",
  eventsExhausted: "Daemon fleet event recovery attempts were exhausted.",
  requestFailed: "Desktop host fleet catalog request failed.",
  subscriptionFailed: "Desktop host fleet event subscription failed.",
} as const;

function projectFleetCatalog(
  view: DaemonCatalogView<FleetCatalogResourceV1>,
): DesktopFleetCatalogState {
  const { generation, target: daemon, phase } = view;
  if (view.disposed) {
    return { status: "disposed", generation, daemon: null, snapshot: null };
  }
  const snapshot: DesktopFleetCatalogSnapshot | null =
    view.snapshot && daemon
      ? { daemon, catalog: view.snapshot.resource, updatedAt: view.snapshot.updatedAt }
      : null;
  if (phase.kind === "loading") {
    return { status: "loading", generation, daemon, snapshot: null };
  }
  if (phase.kind === "live" && snapshot) {
    return { status: "live", generation, daemon, snapshot };
  }
  if (phase.kind === "stale" && snapshot) {
    return { status: "stale", generation, daemon, snapshot, reason: WORDING.staleReason };
  }
  if (phase.kind !== "failed") {
    return { status: "loading", generation, daemon, snapshot: null };
  }
  if (phase.source === "target") {
    return {
      status: "degraded",
      generation,
      daemon: null,
      snapshot: null,
      code:
        phase.failure.code === "daemon-degraded"
          ? "daemon-degraded"
          : phase.failure.code === "invalid-response"
            ? "invalid-response"
            : "daemon-unavailable",
      reason: phase.failure.reason,
    };
  }
  if (phase.fatal) {
    return {
      status: "degraded",
      generation,
      daemon,
      snapshot,
      code: daemonCatalogTerminalCode(phase.failure),
      reason: phase.failure.reason,
    };
  }
  if (phase.source === "event") {
    const reason = phase.exhausted ? WORDING.eventsExhausted : phase.failure.reason;
    if (snapshot) return { status: "stale", generation, daemon, snapshot, reason };
    return {
      status: "degraded",
      generation,
      daemon,
      snapshot: null,
      code: "event-unavailable",
      reason,
    };
  }
  if (snapshot) {
    return { status: "stale", generation, daemon, snapshot, reason: phase.failure.reason };
  }
  return {
    status: "error",
    generation,
    daemon,
    snapshot: null,
    code: phase.exhausted ? "retry-exhausted" : "request-failed",
    reason: phase.failure.reason,
  };
}

export function createDesktopFleetCatalogStore(
  options: DesktopFleetCatalogStoreOptions,
): DesktopFleetCatalogStore {
  const adapter = createDaemonCatalogAdapter<FleetCatalogResourceV1, DesktopFleetCatalogState>({
    host: options.host,
    invalidatesOn: ["fleet.changed", "workspaces.changed"],
    wording: WORDING,
    fetch: async (daemon) => {
      const raw = await options.host.daemon.fetchFleetCatalog();
      const parsed = DesktopDaemonFetchFleetCatalogResultSchemaZ.safeParse(raw);
      if (!parsed.success) {
        return {
          status: "failed",
          failure: {
            code: "invalid-response",
            reason: "Desktop host returned an invalid fleet catalog.",
          },
        };
      }
      if (parsed.data.status === "error") {
        return { status: "failed", failure: parsed.data.error };
      }
      if (!sameDaemonIdentity(parsed.data.envelope.daemon, daemon)) {
        return {
          status: "failed",
          failure: {
            code: "daemon-identity-mismatch",
            reason: "Fleet catalog came from another daemon generation.",
          },
        };
      }
      return { status: "ok", resource: parsed.data.envelope };
    },
    project: projectFleetCatalog,
  });
  const store = createGenerationBoundStore(adapter, options.daemon, {
    clock: options.clock,
    retry: options.retry,
  });
  return {
    getState: () => store.getState(),
    subscribe: (listener) => store.subscribe(listener),
    refresh: () => store.refresh(),
    setDaemon: (daemon) => store.setTarget(daemon),
    dispose: () => store.dispose(),
  };
}

/** Solid lifecycle adapter; the catalog policy remains framework-independent. */
export function createSolidDesktopFleetCatalogStore(
  options: DesktopFleetCatalogStoreOptions,
): SolidDesktopFleetCatalogStore {
  const store = createDesktopFleetCatalogStore(options);
  const [state, setState] = createSignal(store.getState(), { equals: false });
  const unsubscribe = store.subscribe(setState);
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    store.dispose();
  };
  onCleanup(dispose);
  return {
    state,
    refresh: () => store.refresh(),
    setDaemon: (daemon) => store.setDaemon(daemon),
    dispose,
  };
}
