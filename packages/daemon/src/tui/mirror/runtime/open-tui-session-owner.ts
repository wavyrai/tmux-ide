import type {
  OpenTuiGenerationHost,
  OpenTuiGenerationHostSnapshot,
} from "./open-tui-generation-host.ts";

export interface OpenTuiSessionOwnerDependencies {
  readonly ensureWorkspace: (sessionName: string) => Promise<boolean>;
  readonly createHost: (sessionName: string) => OpenTuiGenerationHost;
  readonly onSnapshot: (snapshot: OpenTuiGenerationHostSnapshot | null) => void;
}

export interface OpenTuiSessionOwner {
  readonly sessionName: () => string | null;
  readonly snapshot: () => OpenTuiGenerationHostSnapshot | null;
  open(sessionName: string, workspacePrepared?: boolean): Promise<boolean>;
  dispose(): Promise<void>;
}

interface OwnedHost {
  readonly sessionName: string;
  readonly host: OpenTuiGenerationHost;
  stop: () => void;
  latest: OpenTuiGenerationHostSnapshot;
  retirement: Promise<void> | null;
}

/**
 * Serial, target-aware application owner for fixed-session generation hosts.
 * A replacement prepares while the active host retains its painted frame,
 * publishes only after start succeeds, then awaits retirement of the old host.
 */
export function createOpenTuiSessionOwner(
  dependencies: OpenTuiSessionOwnerDependencies,
): OpenTuiSessionOwner {
  let current: OwnedHost | null = null;
  let preparing: OwnedHost | null = null;
  let disposed = false;
  let disposePromise: Promise<void> | null = null;
  let queue: Promise<void> = Promise.resolve();

  const serial = <Value>(operation: () => Promise<Value>): Promise<Value> => {
    const result = queue.then(operation, operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const retire = async (owner: OwnedHost): Promise<void> => {
    if (owner.retirement) return owner.retirement;
    owner.stop();
    owner.retirement = owner.host.dispose();
    return owner.retirement;
  };

  return {
    sessionName: () => current?.sessionName ?? null,
    snapshot: () => current?.latest ?? null,
    open(sessionName, workspacePrepared = false) {
      return serial(async () => {
        if (disposed) return false;
        if (current?.sessionName === sessionName) return true;
        if (!workspacePrepared && !(await dependencies.ensureWorkspace(sessionName))) return false;
        if (disposed) return false;

        const previous = current;
        const host = dependencies.createHost(sessionName);
        const candidate: OwnedHost = {
          sessionName,
          host,
          stop: () => undefined,
          latest: host.getSnapshot(),
          retirement: null,
        };
        preparing = candidate;
        candidate.stop = host.subscribe((snapshot) => {
          candidate.latest = snapshot;
          // On the first open, connecting/unavailable state is useful. During
          // A→B preparation, retain the active A snapshot until B is usable.
          if ((!previous && current === null) || current === candidate) {
            dependencies.onSnapshot(snapshot);
          }
        });

        const started = await host.start().catch(() => false);
        if (preparing === candidate) preparing = null;
        if (!started || disposed) {
          await retire(candidate);
          if (!previous && current === null) dependencies.onSnapshot(null);
          return false;
        }

        current = candidate;
        dependencies.onSnapshot(candidate.latest);
        if (previous) await retire(previous);
        return true;
      });
    },
    dispose() {
      if (disposePromise) return disposePromise;
      disposed = true;
      const owners = [...new Set([current, preparing].filter((owner) => owner !== null))];
      current = null;
      preparing = null;
      dependencies.onSnapshot(null);
      disposePromise = Promise.all(owners.map((owner) => retire(owner))).then(() => queue);
      return disposePromise;
    },
  };
}
