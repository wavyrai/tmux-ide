import { changeFleetClientState, emptyFleetClientState } from "@tmux-ide/core";
import {
  FleetClientStateResponseSchema,
  type FleetClientStateChange,
  type FleetClientState,
} from "@tmux-ide/contracts/fleet-client-state";
import { loadFleetClientState } from "../../../lib/fleet-client-state.ts";
import {
  canonicalDaemonUrl,
  isCanonicalDaemonAlive,
  readCanonicalDaemonInfo,
} from "../../../lib/canonical-daemon.ts";

/** Local preference writer always targets the verified LOCAL daemon, never selected SSH. */
export function createApplicationFleetPreferences(
  options: { onError?(message: string): void } = {},
) {
  let state: FleetClientState;
  let writable = true;
  try {
    state = loadFleetClientState();
  } catch {
    state = emptyFleetClientState();
    writable = false;
  }
  const listeners = new Set<(state: FleetClientState) => void>();
  const pending = new Map<string, FleetClientStateChange>();
  const lifetime = new AbortController();
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let saving = false;
  let missingReported = false;
  let failureReported = false;
  const retry = () => {
    retryTimer ??= setTimeout(() => {
      retryTimer = null;
      void flush();
    }, 5000);
  };
  const requeue = (key: string, change: FleetClientStateChange) => {
    // A newer optimistic edit wins over the failed in-flight write.
    if (!pending.has(key)) pending.set(key, change);
    retry();
  };
  const publish = () => {
    for (const listener of listeners) listener(state);
  };
  const flush = async () => {
    if (saving || !writable || lifetime.signal.aborted) return;
    saving = true;
    try {
      while (pending.size && !lifetime.signal.aborted) {
        const [key, change] = pending.entries().next().value!;
        pending.delete(key);
        const daemon = readCanonicalDaemonInfo();
        if (!daemon || !daemon.authToken) {
          if (!missingReported)
            options.onError?.(
              "Fleet preferences are kept in memory until a local daemon is running.",
            );
          missingReported = true;
          requeue(key, change);
          return;
        }

        try {
          if (!(await isCanonicalDaemonAlive(daemon))) throw new Error();
          if (lifetime.signal.aborted) return;
          const response = await fetch(
            canonicalDaemonUrl("http", daemon.bindHostname, daemon.port) +
              "/api/resources/fleet-client-state",
            {
              method: "POST",
              redirect: "error",
              signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(3000)]),
              headers: {
                Authorization: `Bearer ${daemon.authToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ expectedInstanceId: daemon.instanceId, change }),
            },
          );
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error();
          }
          const result = FleetClientStateResponseSchema.parse(await response.json());
          if (
            result.daemon.instanceId !== daemon.instanceId ||
            result.daemon.startedAt !== daemon.startedAt
          )
            throw new Error();
          failureReported = false;
          missingReported = false;
          // Keep newer in-flight optimistic edits; the daemon's reducer already merged disk state.
        } catch {
          if (lifetime.signal.aborted) return;
          if (!failureReported)
            options.onError?.(
              "Fleet preferences could not be saved. Update the local daemon or check its state file.",
            );
          failureReported = true;
          requeue(key, change);
          return;
        }
      }
    } finally {
      saving = false;
    }
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: (state: FleetClientState) => void) {
      listeners.add(listener);
      listener(state);
      return () => {
        listeners.delete(listener);
      };
    },
    change(change: FleetClientStateChange) {
      if (lifetime.signal.aborted) return;
      state = changeFleetClientState(state, change);
      publish();
      if (!writable) {
        options.onError?.("Fleet preferences are invalid; the original file was preserved.");
        return;
      }
      const key =
        change.type === "cache"
          ? `cache:${change.route.routeId}`
          : change.type === "forget-route"
            ? `forget:${change.routeId}`
            : `${change.type}:${change.key}`;
      pending.set(key, change);
      void flush();
    },
    dispose() {
      lifetime.abort();
      if (retryTimer) clearTimeout(retryTimer);
      pending.clear();
      listeners.clear();
    },
  };
}
