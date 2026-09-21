import { createFleetDialScheduler } from "@tmux-ide/daemon-client/fleet-dial-scheduler";
import { randomUUID } from "node:crypto";
import {
  LOCAL_MACHINE_ID,
  SavedMachineSchema,
  SavedMachineRegistrySchema,
  type CanonicalDaemonInfo,
  type SavedMachine,
} from "@tmux-ide/contracts";
import {
  createApplicationDaemonAuthority,
  type ApplicationDaemonEndpoint,
} from "./application-daemon-authority-owner.ts";

type Owner = ReturnType<typeof createApplicationDaemonAuthority>;
type GenerationListener = (generation: string | null) => void;
export interface ApplicationMachineAuthorityHandle {
  readonly id: string;
  readonly label: string;
  readonly kind: "local" | "ssh";
  readonly ready: Promise<boolean>;
  read(): CanonicalDaemonInfo | null;
  isAlive(info: CanonicalDaemonInfo): Promise<boolean>;
  endpoint(): ApplicationDaemonEndpoint;
  observe(listener: GenerationListener): Promise<() => void>;
}
export interface ApplicationMachineAuthoritySummary {
  readonly id: string;
  readonly label: string;
  readonly kind: "local" | "ssh";
  readonly state: ApplicationDaemonEndpoint["state"];
  readonly sshTarget?: string;
}
export interface ApplicationMachineAuthoritySnapshot {
  readonly selectedMachineId: string;
  readonly machines: readonly ApplicationMachineAuthoritySummary[];
}
export interface ApplicationMachineAuthorityManagerDependencies {
  createOwner(): Owner;
  retryDelayMs?: number;
}
interface Machine {
  readonly id: string;
  readonly label: string;
  readonly kind: "local" | "ssh";
  readonly profile?: SavedMachine;
  owner: Owner;
  readonly handle: ApplicationMachineAuthorityHandle;
  readonly listeners: Set<GenerationListener>;
  epoch: number;
  stopObserver: (() => void) | null;
  observingOwner: Owner | null;
  stopStatus: (() => void) | null;
}

/** Owns independent transport lifetimes; selecting a machine changes only the active route. */
export function createApplicationMachineAuthorityManager(
  dependencies: ApplicationMachineAuthorityManagerDependencies = {
    createOwner: createApplicationDaemonAuthority,
  },
) {
  const machines = new Map<string, Machine>();
  const subscribers = new Set<() => void>();
  const selectedObservers = new Set<GenerationListener>();
  const lifetime = new AbortController();
  const scheduler = createFleetDialScheduler();
  let selectedId: string = LOCAL_MACHINE_ID;
  let selectedEpoch = 0;
  let disposed = false;
  const safe = (callback: () => void) => {
    try {
      callback();
    } catch {
      /* Observers cannot own machine lifetime. */
    }
  };
  const publish = () => {
    for (const listener of subscribers) safe(listener);
  };
  const selectedGeneration = (generation: string | null) => {
    for (const listener of selectedObservers) safe(() => listener(generation));
  };
  const changed = (machine: Machine, generation: string | null) => {
    if (disposed) return;
    machine.epoch++;
    for (const listener of machine.listeners) safe(() => listener(generation));
    if (machine.id === selectedId) {
      selectedEpoch++;
      selectedGeneration(generation);
    }
    publish();
  };
  const observe = (machine: Machine, owner: Owner) => {
    if (machine.observingOwner === owner) return;
    machine.observingOwner = owner;
    void owner
      .observe((generation) => {
        if (machine.owner === owner) changed(machine, generation);
      })
      .then(
        (stop) => {
          if (disposed || machine.owner !== owner) stop();
          else machine.stopObserver = stop;
        },
        () => {
          /* Local filesystem watcher failure does not disable catalog polling. */
        },
      );
  };
  const makeMachine = (id: string, label: string, profile?: SavedMachine): Machine => {
    let settle!: (ready: boolean) => void;
    const ready = profile
      ? new Promise<boolean>((resolve) => {
          settle = resolve;
        })
      : Promise.resolve(true);
    const owner = dependencies.createOwner();
    const listeners = new Set<GenerationListener>();
    const machine = {
      id,
      label,
      kind: profile ? "ssh" : "local",
      profile,
      owner,
      listeners,
      epoch: 0,
      stopObserver: null,
      observingOwner: null,
      stopStatus: null,
    } as Machine;
    const handle: ApplicationMachineAuthorityHandle = Object.freeze({
      id,
      label,
      kind: machine.kind,
      ready,
      read: () => (disposed ? null : machine.owner.read()),
      isAlive: (info: CanonicalDaemonInfo) =>
        disposed ? Promise.resolve(false) : machine.owner.isAlive(info),
      endpoint: () =>
        Object.freeze({
          ...machine.owner.endpoint(),
          kind: machine.kind,
          label: profile ? label : null,
          epoch: machine.epoch,
          ...(disposed ? { state: "disconnected" as const, remote: null, localBaseUrl: null } : {}),
        }),
      observe: async (listener: GenerationListener) => {
        if (disposed) return () => {};
        if (machine.kind === "local") observe(machine, machine.owner);
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    });
    Object.assign(machine, { handle });
    machines.set(id, machine);
    if (!profile) return machine;
    // The owner selects SSH synchronously and owns ALL retries, including initial failure.
    machine.stopStatus = owner.observeConnection(publish);
    const initializing = owner.initialize(profile.sshTarget, lifetime.signal, {
      scheduler,
      expectedEnvironmentId: profile.expectedEnvironmentId,
      retryDelayMs: dependencies.retryDelayMs,
    });
    observe(machine, owner);
    publish();
    void initializing.then(
      () => settle(!disposed),
      () => settle(false),
    );
    return machine;
  };
  makeMachine(LOCAL_MACHINE_ID, "Local");
  const snapshot = (): ApplicationMachineAuthoritySnapshot =>
    Object.freeze({
      selectedMachineId: selectedId,
      machines: Object.freeze(
        [...machines.values()].map((machine) =>
          Object.freeze({
            id: machine.id,
            label: machine.label,
            kind: machine.kind,
            state: machine.handle.endpoint().state,
            ...(machine.profile ? { sshTarget: machine.profile.sshTarget } : {}),
          }),
        ),
      ),
    });
  const manager = {
    snapshot,
    getMachine: (id: string): ApplicationMachineAuthorityHandle | null =>
      machines.get(id)?.handle ?? null,
    subscribe(listener: () => void): () => void {
      if (disposed) return () => {};
      const local = machines.get(LOCAL_MACHINE_ID)!;
      observe(local, local.owner);
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
    retry(id: string): void {
      const machine = machines.get(id);
      if (disposed || !machine?.profile) return;
      scheduler.prioritize(machine.profile.sshTarget);
      void machine.owner.retry();
    },
    disconnect(id: string): void {
      if (disposed) return;
      machines.get(id)?.owner.disconnect();
    },
    select(id: string): boolean {
      if (disposed || !machines.has(id)) return false;
      if (selectedId === id) return true;
      // Revoke old generation bindings while their old machine is still selected.
      selectedEpoch++;
      selectedGeneration(null);
      selectedId = id;
      const target = machines.get(id)?.profile?.sshTarget;
      if (target) scheduler.prioritize(target);
      selectedEpoch++;
      selectedGeneration(machines.get(id)!.handle.read()?.instanceId ?? null);
      publish();
      return true;
    },
    add(input: SavedMachine): ApplicationMachineAuthorityHandle {
      if (disposed) throw new Error("Machine authority manager has been disposed");
      const profile = SavedMachineSchema.parse(input);
      const existing = machines.get(profile.id);
      if (existing) {
        if (
          existing.profile?.sshTarget !== profile.sshTarget ||
          existing.label !== profile.label ||
          existing.profile?.expectedEnvironmentId !== profile.expectedEnvironmentId
        )
          throw new Error("Machine identity is already registered");
        return existing.handle;
      }
      SavedMachineRegistrySchema.parse({
        version: 1,
        machines: [
          ...[...machines.values()].flatMap((machine) =>
            machine.profile ? [machine.profile] : [],
          ),
          profile,
        ],
      });
      if (!profile.enabled) throw new Error("Disabled machine profiles cannot be connected");
      const machine = makeMachine(profile.id, profile.label, profile);
      publish();
      return machine.handle;
    },
    initialize(profiles: readonly SavedMachine[]): void {
      SavedMachineRegistrySchema.parse({ version: 1, machines: profiles });
      for (const profile of profiles) if (profile.enabled) manager.add(profile);
    },
    read: (): CanonicalDaemonInfo | null => machines.get(selectedId)?.handle.read() ?? null,
    isAlive: (info: CanonicalDaemonInfo): Promise<boolean> =>
      machines.get(selectedId)?.handle.isAlive(info) ?? Promise.resolve(false),
    endpoint: (): ApplicationDaemonEndpoint =>
      Object.freeze({ ...machines.get(selectedId)!.handle.endpoint(), epoch: selectedEpoch }),
    async observeSelected(listener: GenerationListener): Promise<() => void> {
      if (disposed) return () => {};
      const local = machines.get(LOCAL_MACHINE_ID)!;
      observe(local, local.owner);
      selectedObservers.add(listener);
      return () => {
        selectedObservers.delete(listener);
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      selectedEpoch++;
      selectedGeneration(null);
      for (const machine of machines.values()) {
        machine.stopStatus?.();
        machine.stopObserver?.();
        machine.stopObserver = null;
        machine.owner.dispose();
        machine.listeners.clear();
      }
      publish();
      subscribers.clear();
      selectedObservers.clear();
    },
  };
  return manager;
}
export type ApplicationMachineAuthorityManager = ReturnType<
  typeof createApplicationMachineAuthorityManager
>;
export const applicationMachineAuthorityManager = createApplicationMachineAuthorityManager();
/** Compatibility entry for explicitly targeting a single alias; other machines remain independent. */
export async function initializeSelectedApplicationSshAuthority(
  alias: string,
  signal?: AbortSignal,
): Promise<void> {
  let handle = applicationMachineAuthorityManager
    .snapshot()
    .machines.find((machine) => machine.sshTarget === alias);
  if (!handle) {
    const added = applicationMachineAuthorityManager.add({
      id: randomUUID(),
      label: `SSH ${alias}`.slice(0, 80),
      sshTarget: alias,
      enabled: true,
    });
    handle = applicationMachineAuthorityManager
      .snapshot()
      .machines.find((machine) => machine.id === added.id)!;
  }
  applicationMachineAuthorityManager.select(handle.id);
  const abort = () => applicationMachineAuthorityManager.dispose();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const ready = await applicationMachineAuthorityManager.getMachine(handle.id)!.ready;
  if (!ready) throw new Error("Could not connect to SSH machine");
}
