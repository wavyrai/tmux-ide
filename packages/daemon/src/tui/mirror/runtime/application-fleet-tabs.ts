export interface FleetTabTarget {
  readonly key: string;
  readonly machineId: string;
  readonly liveSessionId: string;
  readonly label: string;
  readonly hostLabel: string;
}
/** Retained targets, with at most one active terminal owner. Suspended tabs own no streams. */
export function createFleetTabs(options: {
  resolve(target: FleetTabTarget): FleetTabTarget | null;
  retireActive(): void;
  open(target: FleetTabTarget): Promise<boolean>;
  publish(): void;
  unavailable(): void;
}) {
  const tabs = new Map<string, FleetTabTarget>();
  let active: string | null = null;
  let pending: string | null = null;
  let epoch = 0;
  let disposed = false;
  return {
    snapshot: () => ({ tabs: [...tabs.values()], active }),
    remember(target: FleetTabTarget) {
      if (disposed) return;
      if (!tabs.has(target.key) && tabs.size >= 8) {
        const removable = [...tabs.keys()].find((key) => key !== active);
        if (removable) tabs.delete(removable);
      }
      tabs.set(target.key, Object.freeze({ ...target }));
      active = target.key;
      options.publish();
    },
    async activate(key: string) {
      const saved = tabs.get(key);
      if (disposed || !saved) return false;
      const target = options.resolve(saved);
      if (!target) {
        options.unavailable();
        return false;
      }
      const token = ++epoch;
      pending = key;
      options.retireActive();
      active = null;
      options.publish();
      const opened = await options.open(target).catch(() => false);
      if (disposed || token !== epoch || !tabs.has(key)) return false;
      pending = null;
      if (!opened) {
        options.unavailable();
        return false;
      }
      active = key;
      options.publish();
      return true;
    },
    close(key: string) {
      if (!tabs.has(key)) return;
      if (active === key || pending === key) {
        epoch++;
        options.retireActive();
        active = null;
        pending = null;
      }
      tabs.delete(key);
      options.publish();
    },
    suspend() {
      epoch++;
      active = null;
      pending = null;
      options.publish();
    },
    cancel() {
      epoch++;
    },
    dispose() {
      disposed = true;
      epoch++;
      tabs.clear();
      active = null;
    },
  };
}
