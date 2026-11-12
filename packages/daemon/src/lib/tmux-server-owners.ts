import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  TmuxServerIdSchemaZ,
  TmuxServerRegistrationRequestSchemaZ,
  TmuxServerScopeSchemaZ,
  type TmuxServerScope,
  type TmuxServerDescriptor,
} from "@tmux-ide/contracts";
import type { WorkspacePaneTmuxAuthority } from "./workspace-pane-creation.ts";

// Admission limits, not performance claims. Discovery is explicit/on-demand.
export const MAX_TMUX_SERVER_OWNERS = 16;
export const TmuxServerSelectorSchemaZ = TmuxServerRegistrationRequestSchemaZ.shape.selector;
export const TmuxServerRegistrationSchemaZ = TmuxServerRegistrationRequestSchemaZ.extend({
  serverId: TmuxServerIdSchemaZ,
}).strict();
export type TmuxServerRegistration = z.infer<typeof TmuxServerRegistrationSchemaZ>;
export interface TmuxServerObservation {
  /** Private canonical path/server PID/start-time proof, never a public identity. */
  readonly fingerprint: string;
  readonly nativeServerIdentity?: { readonly pid: string; readonly startTime: string };
  readonly authority: WorkspacePaneTmuxAuthority;
  /** Synchronous socket fence. No subprocess on input or rendering paths. */
  readonly valid: () => boolean;
}
/**
 * Why a probe produced no observation. A failed probe is not proof that the
 * server is gone: tmux may be slow, the spawn may have failed, or the connect
 * may have been refused under load (#840).
 */
export interface TmuxServerProbeFailure {
  readonly failure: "timeout" | "exec-error" | "no-server" | "unparsable" | "socket-mismatch";
  readonly detail?: string;
  readonly durationMs?: number;
}
export type TmuxServerProbeResult = TmuxServerObservation | TmuxServerProbeFailure | null;
export function isTmuxServerObservation(
  result: TmuxServerProbeResult,
): result is TmuxServerObservation {
  return result !== null && "fingerprint" in result;
}
/**
 * Why an owner is disposed. Everything except "shutdown" happens while the
 * daemon process lives, so its streams must tell clients to reconnect.
 */
export type TmuxServerOwnerRetirement = "server-gone" | "server-replaced" | "removed" | "shutdown";
/** What the retired owner's pane streams are told, by retirement. */
export function retirementKeepsDaemon(retirement: TmuxServerOwnerRetirement | undefined): boolean {
  return retirement !== undefined && retirement !== "shutdown";
}
export interface DisposableTmuxServerOwner {
  dispose(retirement?: TmuxServerOwnerRetirement): Promise<void>;
}
export type TmuxServerOwnerRetirementTrigger =
  | "server-process-gone"
  | "socket-identity-changed"
  | "server-identity-unknown"
  | "fingerprint-changed"
  | "removed"
  | "owners-disposed";
/** One line per decision, so a dropped stream can be traced to its cause. */
export type TmuxServerOwnersEvent =
  | {
      readonly type: "owner-kept";
      readonly serverId: string;
      readonly generation: string;
      readonly probe: TmuxServerProbeFailure;
      readonly probeMs: number;
      readonly consecutiveProbeFailures: number;
    }
  | {
      readonly type: "owner-retired";
      readonly serverId: string;
      readonly generation: string;
      readonly trigger: TmuxServerOwnerRetirementTrigger;
      readonly probe?: TmuxServerProbeFailure;
      readonly probeMs?: number;
      readonly disposeMs: number;
      readonly disposeError?: string;
    }
  | {
      readonly type: "owner-created";
      readonly serverId: string;
      readonly generation: string;
      readonly createMs: number;
    }
  | {
      readonly type: "owner-create-failed";
      readonly serverId: string;
      readonly generation: string;
      readonly createMs: number;
      readonly error: string;
    };
const RETIREMENT_OF: Record<TmuxServerOwnerRetirementTrigger, TmuxServerOwnerRetirement> = {
  "server-process-gone": "server-gone",
  "socket-identity-changed": "server-gone",
  "server-identity-unknown": "server-gone",
  "fingerprint-changed": "server-replaced",
  removed: "removed",
  "owners-disposed": "shutdown",
};
function processAlive(pid: string): boolean {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    // Only "no such process" proves the server is gone.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
function describeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}
export class TmuxServerScopeError extends Error {
  constructor(
    readonly code: "not-found" | "offline" | "stale-generation" | "capacity" | "disposed",
  ) {
    super(`tmux server ${code}`);
    this.name = "TmuxServerScopeError";
  }
}
type Entry<T> = {
  registration: TmuxServerRegistration;
  observation: TmuxServerObservation | null;
  scope: TmuxServerScope | null;
  owner: T | null;
  probeFailures: number;
};
export interface TmuxServerOwnersOptions<T extends DisposableTmuxServerOwner> {
  readonly probe: (selector: TmuxServerRegistration["selector"]) => Promise<TmuxServerProbeResult>;
  readonly create: (
    registration: TmuxServerRegistration,
    scope: TmuxServerScope,
    observation: TmuxServerObservation,
  ) => Promise<T>;
  readonly persist?: (registrations: readonly TmuxServerRegistration[]) => void;
  /** Liveness of the tmux server process; injectable for tests. */
  readonly serverProcessAlive?: (pid: string) => boolean;
  readonly onEvent?: (event: TmuxServerOwnersEvent) => void;
  readonly now?: () => number;
}
/** One process; no shared mutable tmux authority, runtime cache or retry ledger. */
export class TmuxServerOwners<T extends DisposableTmuxServerOwner> {
  readonly #entries = new Map<string, Entry<T>>();
  #tail: Promise<unknown> = Promise.resolve();
  #disposed = false;
  #disposePromise: Promise<void> | null = null;
  constructor(readonly options: TmuxServerOwnersOptions<T>) {}
  #queuedRefresh: Promise<readonly TmuxServerDescriptor[]> | null = null;
  #queuedRefreshTail: Promise<unknown> | null = null;
  #serial<R>(work: () => Promise<R>): Promise<R> {
    const run = this.#tail.then(() => {
      if (this.#disposed) throw new TmuxServerScopeError("disposed");
      return work();
    });
    this.#tail = run.catch(() => undefined);
    return run;
  }
  #descriptor(entry: Entry<T>): TmuxServerDescriptor {
    return entry.scope
      ? { ...entry.scope, label: entry.registration.label, state: "online" }
      : {
          serverId: entry.registration.serverId,
          generation: null,
          label: entry.registration.label,
          state: "offline",
        };
  }
  list(): readonly TmuxServerDescriptor[] {
    return [...this.#entries.values()].map((entry) => this.#descriptor(entry));
  }
  registrations(): readonly TmuxServerRegistration[] {
    return [...this.#entries.values()].map((entry) => structuredClone(entry.registration));
  }
  #save(): void {
    this.options.persist?.(this.registrations());
  }
  #now(): number {
    return (this.options.now ?? performance.now.bind(performance))();
  }
  #emit(event: TmuxServerOwnersEvent): void {
    try {
      this.options.onEvent?.(event);
    } catch {
      /* Diagnostics never decide ownership. */
    }
  }
  async #retire(
    entry: Entry<T>,
    trigger: TmuxServerOwnerRetirementTrigger,
    probe?: { readonly failure: TmuxServerProbeFailure | null; readonly ms: number },
  ): Promise<void> {
    const owner = entry.owner;
    const generation = entry.scope?.generation;
    entry.owner = null;
    entry.scope = null;
    entry.observation = null;
    entry.probeFailures = 0;
    if (!owner) return;
    const started = this.#now();
    let failure: unknown;
    try {
      await owner.dispose(RETIREMENT_OF[trigger]);
    } catch (error) {
      failure = error;
    }
    this.#emit({
      type: "owner-retired",
      serverId: entry.registration.serverId,
      generation: generation ?? "",
      trigger,
      ...(probe?.failure ? { probe: probe.failure } : {}),
      ...(probe ? { probeMs: Math.round(probe.ms) } : {}),
      disposeMs: Math.round(this.#now() - started),
      ...(failure === undefined ? {} : { disposeError: describeError(failure) }),
    });
    if (failure !== undefined) throw failure;
  }
  async #refresh(entry: Entry<T>, observed?: TmuxServerProbeResult): Promise<void> {
    const probeStarted = this.#now();
    const result =
      observed === undefined ? await this.options.probe(entry.registration.selector) : observed;
    const probeMs = this.#now() - probeStarted;
    const next = isTmuxServerObservation(result) ? result : null;
    const current = entry.observation;
    if (next && current?.fingerprint === next.fingerprint && current.valid()) {
      entry.probeFailures = 0;
      return;
    }
    let trigger: TmuxServerOwnerRetirementTrigger = "fingerprint-changed";
    const failure: TmuxServerProbeFailure | null =
      result === null ? { failure: "no-server" } : isTmuxServerObservation(result) ? null : result;
    if (!next && entry.owner && entry.scope && current) {
      // A failed probe is not absence (#840). The owner is given up only on
      // positive evidence: its pinned socket was replaced, or the server
      // process it was built for no longer exists.
      const pid = current.nativeServerIdentity?.pid;
      if (!current.valid()) trigger = "socket-identity-changed";
      else if (pid === undefined) trigger = "server-identity-unknown";
      else if (!(this.options.serverProcessAlive ?? processAlive)(pid))
        trigger = "server-process-gone";
      else {
        entry.probeFailures += 1;
        this.#emit({
          type: "owner-kept",
          serverId: entry.registration.serverId,
          generation: entry.scope.generation,
          probe: failure!,
          probeMs: Math.round(probeMs),
          consecutiveProbeFailures: entry.probeFailures,
        });
        return;
      }
    } else if (next && current && !current.valid()) trigger = "socket-identity-changed";
    // Socket recreation also needs a fresh connection authority, even if PID survived.
    await this.#retire(entry, trigger, { failure, ms: probeMs });
    if (this.#disposed || !next || !next.valid()) return;
    const duplicate = [...this.#entries.values()].find(
      (other) =>
        other !== entry &&
        other.observation?.fingerprint === next.fingerprint &&
        other.observation.valid(),
    );
    if (duplicate) return; // Never construct a second owner for a proven live alias.
    const scope = { serverId: entry.registration.serverId, generation: randomUUID() };
    let owner: T;
    const createStarted = this.#now();
    try {
      owner = await this.options.create(entry.registration, scope, next);
    } catch (error) {
      this.#emit({
        type: "owner-create-failed",
        serverId: scope.serverId,
        generation: scope.generation,
        createMs: Math.round(this.#now() - createStarted),
        error: describeError(error),
      });
      return;
    } // Registration remains visible/offline; explicit refresh retries.
    if (this.#disposed || !next.valid()) {
      await owner.dispose(this.#disposed ? "shutdown" : "server-gone");
      return;
    }
    entry.observation = next;
    entry.scope = scope;
    entry.owner = owner;
    entry.probeFailures = 0;
    this.#emit({
      type: "owner-created",
      serverId: scope.serverId,
      generation: scope.generation,
      createMs: Math.round(this.#now() - createStarted),
    });
  }
  register(
    input: Omit<TmuxServerRegistration, "serverId"> & { serverId?: string },
  ): Promise<TmuxServerDescriptor> {
    return this.#serial(async () => {
      const registration = TmuxServerRegistrationSchemaZ.parse({
        ...input,
        serverId: input.serverId ?? `tmux-server.${randomUUID().replaceAll("-", "")}`,
      });
      const sameSelector = [...this.#entries.values()].find(
        (entry) =>
          JSON.stringify(entry.registration.selector) === JSON.stringify(registration.selector),
      );
      if (sameSelector) {
        await this.#refresh(sameSelector);
        return this.#descriptor(sameSelector);
      }
      if (this.#entries.has(registration.serverId))
        throw new TypeError("Server registration already exists");
      const probed = await this.options.probe(registration.selector);
      if (this.#disposed) throw new TmuxServerScopeError("disposed");
      const observation = isTmuxServerObservation(probed) ? probed : null;
      const alias =
        observation &&
        [...this.#entries.values()].find(
          (entry) =>
            entry.observation?.fingerprint === observation.fingerprint && entry.observation.valid(),
        );
      if (alias) return this.#descriptor(alias);
      if (this.#entries.size >= MAX_TMUX_SERVER_OWNERS) throw new TmuxServerScopeError("capacity");
      const entry: Entry<T> = {
        registration,
        observation: null,
        scope: null,
        owner: null,
        probeFailures: 0,
      };
      this.#entries.set(registration.serverId, entry);
      try {
        this.#save();
      } catch (error) {
        this.#entries.delete(registration.serverId);
        throw error;
      }
      await this.#refresh(entry, probed);
      return this.#descriptor(entry);
    });
  }
  /** Adopt the existing default owner rather than creating a duplicate mirror. */
  adopt(
    registrationInput: TmuxServerRegistration,
    scopeInput: TmuxServerScope,
    observation: TmuxServerObservation,
    owner: T,
  ): void {
    const registration = TmuxServerRegistrationSchemaZ.parse(registrationInput);
    const scope = TmuxServerScopeSchemaZ.parse(scopeInput);
    if (scope.serverId !== registration.serverId || this.#entries.size || this.#disposed)
      throw new TypeError("Invalid default owner adoption");
    this.#entries.set(scope.serverId, {
      registration,
      scope,
      observation,
      owner,
      probeFailures: 0,
    });
  }
  refresh(): Promise<readonly TmuxServerDescriptor[]> {
    // A refresh still waiting its turn has not probed anything yet, so it is
    // as fresh for a later caller as a new one: share it instead of queuing
    // another full refresh behind it (#709). Once it starts, callers queue anew.
    // Share it only while nothing has been queued behind it, so a refresh
    // stays ordered after any mutation queued before the caller asked.
    if (this.#queuedRefresh && this.#tail === this.#queuedRefreshTail) return this.#queuedRefresh;
    const queued = this.#serial(async () => {
      if (this.#queuedRefresh === queued) this.#queuedRefresh = null;
      // Sequential admission bounds subprocess work and avoids alias races.
      for (const entry of this.#entries.values()) await this.#refresh(entry);
      return this.list();
    });
    this.#queuedRefresh = queued;
    this.#queuedRefreshTail = this.#tail;
    const settle = () => {
      if (this.#queuedRefresh === queued) this.#queuedRefresh = null;
    };
    queued.then(settle, settle);
    return queued;
  }
  current(scopeInput: TmuxServerScope): T {
    const scope = TmuxServerScopeSchemaZ.parse(scopeInput);
    if (this.#disposed) throw new TmuxServerScopeError("disposed");
    const entry = this.#entries.get(scope.serverId);
    if (!entry) throw new TmuxServerScopeError("not-found");
    if (!entry.scope || !entry.owner) throw new TmuxServerScopeError("offline");
    if (entry.scope.generation !== scope.generation || !entry.observation?.valid())
      throw new TmuxServerScopeError("stale-generation");
    return entry.owner;
  }
  async withOwner<R>(scope: TmuxServerScope, work: (owner: T) => Promise<R>): Promise<R> {
    const owner = this.current(scope);
    const result = await work(owner);
    if (this.current(scope) !== owner) throw new TmuxServerScopeError("stale-generation");
    return result;
  }
  remove(serverId: string): Promise<void> {
    return this.#serial(async () => {
      const entry = this.#entries.get(TmuxServerIdSchemaZ.parse(serverId));
      if (!entry) throw new TmuxServerScopeError("not-found");
      this.#entries.delete(serverId);
      try {
        this.#save();
      } catch (error) {
        this.#entries.set(serverId, entry);
        throw error;
      }
      await this.#retire(entry, "removed"); // never kill-server or kill-session
    });
  }
  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposed = true;
    this.#disposePromise = (async () => {
      await this.#tail;
      const entries = [...this.#entries.values()];
      this.#entries.clear();
      await Promise.allSettled(entries.map((entry) => this.#retire(entry, "owners-disposed")));
    })();
    return this.#disposePromise;
  }
}
