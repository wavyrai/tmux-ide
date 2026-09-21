export interface FleetEnvironmentRoute {
  readonly id: string;
  /** Populated only after authenticated resource/identity verification. */
  readonly environmentId: string | null;
  readonly generation: string | null;
  readonly ready: boolean;
}

export interface FleetEnvironmentGroup {
  readonly environmentId: string | null;
  readonly routeIds: readonly string[];
  readonly primaryRouteId: string;
  readonly conflict: boolean;
}

/** Display-only join. Selecting a primary route never grants or redirects input authority. */
export function groupFleetEnvironments(
  routes: readonly FleetEnvironmentRoute[],
  selectedRouteId: string,
  preferred: ReadonlyMap<string, string> = new Map(),
): readonly FleetEnvironmentGroup[] {
  const buckets = new Map<string, FleetEnvironmentRoute[]>();
  for (const route of routes) {
    const key = JSON.stringify(
      route.environmentId && route.generation
        ? ["environment", route.environmentId]
        : ["route", route.id],
    );
    const bucket = buckets.get(key) ?? [];
    bucket.push(route);
    buckets.set(key, bucket);
  }
  return [...buckets.values()].flatMap<FleetEnvironmentGroup>((bucket) => {
    // Include last verified offline generations: a stale alias must reauthenticate before
    // it can be joined to a replacement or a potentially cloned environment.
    const conflict = new Set(bucket.map((route) => route.generation)).size > 1;
    if (conflict)
      return bucket.map((route) => ({
        environmentId: route.environmentId,
        routeIds: [route.id],
        primaryRouteId: route.id,
        conflict: true,
      }));
    const first = bucket[0]!;
    const preferredId = first.environmentId ? preferred.get(first.environmentId) : undefined;
    const primary =
      bucket.find((route) => route.id === selectedRouteId && route.ready) ??
      bucket.find((route) => route.id === preferredId && route.ready) ??
      bucket.find((route) => route.ready) ??
      bucket.find((route) => route.id === preferredId) ??
      first;
    return [
      {
        environmentId: first.environmentId,
        routeIds: bucket.map((route) => route.id),
        primaryRouteId: primary.id,
        conflict: false,
      },
    ];
  });
}
