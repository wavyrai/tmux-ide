import type {
  OpenTuiGenerationHost,
  OpenTuiGenerationHostSnapshot,
} from "./open-tui-generation-host.ts";
import type { OpenTuiApplicationShellConnection } from "../application-shell-daemon-connection.ts";

export interface OpenTuiSessionOwnerDependencies {
  readonly prepareConnection: (
    sessionName: string,
  ) => Promise<OpenTuiApplicationShellConnection | null>;
  readonly createHost: (
    sessionName: string,
    initialConnection: OpenTuiApplicationShellConnection | null,
  ) => OpenTuiGenerationHost;
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

type ConnectionPreparationOutcome =
  | {
      readonly status: "prepared";
      readonly connection: OpenTuiApplicationShellConnection | null;
    }
  | { readonly status: "rejected"; readonly error: unknown };

const PREPARATION_DISPOSED = Symbol("open-tui-session-owner-preparation-disposed");

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
  const disposalController = new AbortController();

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

  const prepareConnection = async (
    sessionName: string,
  ): Promise<OpenTuiApplicationShellConnection | null | typeof PREPARATION_DISPOSED> => {
    const preparation = dependencies.prepareConnection(sessionName);
    const outcome: Promise<ConnectionPreparationOutcome> = preparation.then(
      (connection) => ({ status: "prepared", connection }),
      (error: unknown) => ({ status: "rejected", error }),
    );
    const signal = disposalController.signal;
    if (signal.aborted) {
      void outcome.then((late) => {
        if (late.status === "prepared") late.connection?.dispose();
      });
      return PREPARATION_DISPOSED;
    }

    let stopListening = (): void => undefined;
    const disposal = new Promise<typeof PREPARATION_DISPOSED>((resolve) => {
      const aborted = (): void => resolve(PREPARATION_DISPOSED);
      signal.addEventListener("abort", aborted, { once: true });
      stopListening = () => signal.removeEventListener("abort", aborted);
    });
    const settled = await Promise.race([outcome, disposal]);
    stopListening();
    if (settled === PREPARATION_DISPOSED) {
      // The owner no longer waits for an unowned routing request. Its handled
      // outcome keeps late rejection process-safe and retires a late success
      // exactly once without requiring a generation host to exist.
      void outcome.then((late) => {
        if (late.status === "prepared") late.connection?.dispose();
      });
      return PREPARATION_DISPOSED;
    }
    if (settled.status === "rejected") throw settled.error;
    return settled.connection;
  };

  return {
    sessionName: () => current?.sessionName ?? null,
    snapshot: () => current?.latest ?? null,
    open(sessionName, workspacePrepared = false) {
      return serial(async () => {
        if (disposed) return false;
        if (current?.sessionName === sessionName) return true;
        const initialConnection = workspacePrepared ? null : await prepareConnection(sessionName);
        if (initialConnection === PREPARATION_DISPOSED) return false;
        if (!workspacePrepared && !initialConnection) return false;
        if (disposed) {
          initialConnection?.dispose();
          return false;
        }

        const previous = current;
        let host: OpenTuiGenerationHost;
        try {
          host = dependencies.createHost(sessionName, initialConnection);
        } catch (error) {
          initialConnection?.dispose();
          throw error;
        }
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
      disposalController.abort();
      const owners = [...new Set([current, preparing].filter((owner) => owner !== null))];
      current = null;
      preparing = null;
      dependencies.onSnapshot(null);
      disposePromise = Promise.all(owners.map((owner) => retire(owner))).then(() => queue);
      return disposePromise;
    },
  };
}
