/** In-process retirement must release retained canonical state, not just stop its transports. */
export function releaseLiveSessionResources(options: {
  replicas: Map<string, { retire(): void }>;
  kitty: { retire(): void };
  viewport: { update(snapshot: null): unknown };
  surfaces: Map<string, unknown>;
  lifetimes: Map<string, unknown>;
}) {
  const failures: unknown[] = [];
  for (const release of [
    ...[...options.replicas.values()].map((replica) => () => replica.retire()),
    () => options.kitty.retire(),
    () => options.viewport.update(null),
  ]) {
    try {
      release();
    } catch (error) {
      failures.push(error);
    }
  }
  options.replicas.clear();
  options.surfaces.clear();
  options.lifetimes.clear();
  if (failures.length) throw new AggregateError(failures, "Session state release failed");
}
