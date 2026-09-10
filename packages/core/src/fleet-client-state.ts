import {
  FleetClientStateSchema,
  type FleetClientState,
  type FleetClientStateChange,
} from "@tmux-ide/contracts/fleet-client-state";

export function emptyFleetClientState(): FleetClientState {
  return { version: 1, favorites: [], collapsed: [], recent: [], catalog: [] };
}

/** Intent edits avoid toggling twice when an idempotent preference update is retried. */
export function changeFleetClientState(
  state: FleetClientState,
  change: FleetClientStateChange,
): FleetClientState {
  const membership = (values: string[], key: string, enabled: boolean, max: number) =>
    (enabled
      ? [...values.filter((value) => value !== key), key]
      : values.filter((value) => value !== key)
    ).slice(-max);
  switch (change.type) {
    case "cache": {
      const previous = state.catalog.find((route) => route.routeId === change.route.routeId);
      if (previous && previous.seenAt > change.route.seenAt) return state;
      return FleetClientStateSchema.parse({
        ...state,
        catalog: [
          ...state.catalog.filter((route) => route.routeId !== change.route.routeId),
          change.route,
        ].slice(-64),
      });
    }
    case "favorite":
      return { ...state, favorites: membership(state.favorites, change.key, change.enabled, 128) };
    case "collapse":
      return { ...state, collapsed: membership(state.collapsed, change.key, change.enabled, 64) };
    case "visit":
      return {
        ...state,
        recent: [change.key, ...state.recent.filter((key) => key !== change.key)].slice(0, 64),
      };
    case "forget-route":
      return {
        ...state,
        catalog: state.catalog.filter((route) => route.routeId !== change.routeId),
      };
  }
}
