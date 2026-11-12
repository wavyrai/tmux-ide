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
 * "generation-restart" is the whole daemon generation restarting in place.
 */
export type TmuxServerOwnerRetirement =
  | "server-gone"
  | "server-replaced"
  | "removed"
  | "shutdown"
  | "generation-restart";
/** True when only this owner goes while its daemon generation keeps running. */
export function retirementKeepsGeneration(
  retirement: TmuxServerOwnerRetirement | undefined,
): boolean {
  return (
    retirement !== undefined && retirement !== "shutdown" && retirement !== "generation-restart"
  );
}
export interface DisposableTmuxServerOwner {
  dispose(retirement?: TmuxServerOwnerRetirement): Promise<void>;
}
export type TmuxServerOwnerRetirementTrigger =
  | "server-process-gone"
  | "socket-identity-changed"
  | "server-process-replaced"
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
      /** Evidence for retirement did not survive the confirming second probe. */
      readonly type: "retirement-unconfirmed";
      readonly serverId: string;
      readonly generation: string;
      readonly trigger: TmuxServerOwnerRetirementTrigger;
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
      readonly consecutiveCreateFailures: number;
      readonly retryInMs: number;
    };
/** Reads share one constructive pass and start at most one per this interval. */
export const OBSERVE_MIN_INTERVAL_MS = 1_000;
/** The longest a read waits for work already in flight before answering with what is known. */
export const OBSERVE_MAX_WAIT_MS = 1_000;
export const CREATE_RETRY_BASE_MS = 500;
export const CREATE_RETRY_MAX_MS = 30_000;
/** Delay before the next attempt to build an owner after `failures` consecutive failures. */
export function createRetryDelayMs(failures: number): number {
  return Math.min(CREATE_RETRY_MAX_MS, CREATE_RETRY_BASE_MS * 2 ** Math.max(0, failures - 1));
}
const RETIREMENT_OF: Record<TmuxServerOwnerRetirementTrigger, TmuxServerOwnerRetirement> = {
  "server-process-gone": "server-gone",
  "socket-identity-changed": "server-gone",
  "server-process-replaced": "server-gone",
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
  createFailures: number;
  /** Background and read passes leave a failing build alone until then. */
  nextCreateAt: number;
  /** An absent server is asked less and less often by the background sweep; reads still ask. */
  offlineMisses: number;
  nextSweepProbeAt: number;
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
  /**
   * Asked only when a probe missed and the owner would otherwise be kept: is
   * the process that now has the server's pid provably NOT that tmux server
   * (the server died and the pid was reused)? True is positive evidence.
   * False or a failure keeps the owner.
   *
   * A refused connection is deliberately not used for this. A tmux server that
   * is alive but not accepting for a while has a full accept queue, and the
   * kernel then answers ECONNREFUSED exactly as for a dead one: measured on
   * macOS with a stopped server, connection 129 was refused while the server
   * was fine (review C1). That would be the #840 drop again.
   */
  readonly serverProcessReplaced?: (identity: {
    readonly pid: string;
    readonly startTime: string;
  }) => Promise<boolean>;
  /**
   * A stat, no subprocess: can a server exist for this selector at all? While
   * the socket file is missing, neither the sweep nor a read spawns a probe.
   */
  readonly serverSocketPresent?: (selector: TmuxServerRegistration["selector"]) => boolean;
  /**
   * One connect, no subprocess: the socket file is there, but does it refuse
   * connections (a server that died and left it behind)? Then an offline
   * registration is not probed by the sweep or a read.
   */
  readonly selectorSocketRefuses?: (
    selector: TmuxServerRegistration["selector"],
  ) => Promise<boolean>;
  readonly onEvent?: (event: TmuxServerOwnersEvent) => void;
  readonly now?: () => number;
  readonly delay?: (milliseconds: number) => Promise<void>;
}
function unrefDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds).unref?.();
  });
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
  #inFlight = 0;
  #onlinePass: Promise<void> | null = null;
  #lastOnlinePassAt = Number.NEGATIVE_INFINITY;
  #serial<R>(work: () => Promise<R>): Promise<R> {
    this.#inFlight += 1;
    const run = this.#tail.then(() => {
      if (this.#disposed) throw new TmuxServerScopeError("disposed");
      return work();
    });
    const settled = () => {
      this.#inFlight -= 1;
    };
    run.then(settled, settled);
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
    retirement: TmuxServerOwnerRetirement = RETIREMENT_OF[trigger],
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
      await owner.dispose(retirement);
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
  /** A failing check is not evidence: only a clear "another process" counts. */
  async #serverProcessReplaced(observation: TmuxServerObservation): Promise<boolean> {
    const identity = observation.nativeServerIdentity;
    if (!identity || !this.options.serverProcessReplaced) return false;
    try {
      return (await this.options.serverProcessReplaced(identity)) === true;
    } catch {
      return false;
    }
  }
  #socketPresent(entry: Entry<T>): boolean {
    try {
      return this.options.serverSocketPresent?.(entry.registration.selector) ?? true;
    } catch {
      return true;
    }
  }
  /** Positive evidence that needs no subprocess: the socket was replaced or the server process is gone. */
  #hasCheapEvidence(entry: Entry<T>): boolean {
    const current = entry.observation;
    if (!entry.owner || !current) return false;
    if (!current.valid()) return true;
    const pid = current.nativeServerIdentity?.pid;
    return pid !== undefined && !(this.options.serverProcessAlive ?? processAlive)(pid);
  }
  async #refresh(
    entry: Entry<T>,
    observed?: TmuxServerProbeResult,
    pass: { readonly confirming?: boolean; readonly respectBackoff?: boolean } = {},
  ): Promise<void> {
    if (!entry.owner && pass.respectBackoff) {
      if (this.#now() < entry.nextCreateAt) return;
      let refuses = false;
      // Only when configured: an extra await here would reorder queued passes.
      if (this.options.selectorSocketRefuses) {
        try {
          refuses =
            (await this.options.selectorSocketRefuses(entry.registration.selector)) === true;
        } catch {
          /* Not evidence; ask tmux. */
        }
      }
      if (refuses) {
        // A stale socket: nothing can answer, so nothing is spawned.
        entry.offlineMisses += 1;
        entry.nextSweepProbeAt = this.#now() + createRetryDelayMs(entry.offlineMisses);
        return;
      }
    }
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
      // The pid is alive, but a pid can be reused after the server died: is
      // the process behind it still that server (review: pid reuse, C1)?
      else if (await this.#serverProcessReplaced(current)) trigger = "server-process-replaced";
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
    if (entry.owner && entry.scope && !pass.confirming) {
      // One observation never retires a live owner: ask once more and retire
      // only if the second answer still says so.
      const generation = entry.scope.generation;
      const again = await this.options.probe(entry.registration.selector);
      if (this.#disposed) return;
      await this.#refresh(entry, again, { ...pass, confirming: true });
      if (entry.scope?.generation === generation)
        this.#emit({
          type: "retirement-unconfirmed",
          serverId: entry.registration.serverId,
          generation,
          trigger,
        });
      return;
    }
    // Socket recreation also needs a fresh connection authority, even if PID survived.
    await this.#retire(entry, trigger, { failure, ms: probeMs });
    if (!next) {
      entry.offlineMisses += 1;
      entry.nextSweepProbeAt = this.#now() + createRetryDelayMs(entry.offlineMisses);
    }
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
      entry.createFailures += 1;
      const retryInMs = createRetryDelayMs(entry.createFailures);
      entry.nextCreateAt = this.#now() + retryInMs;
      this.#emit({
        type: "owner-create-failed",
        serverId: scope.serverId,
        generation: scope.generation,
        createMs: Math.round(this.#now() - createStarted),
        error: describeError(error),
        consecutiveCreateFailures: entry.createFailures,
        retryInMs,
      });
      return;
    } // Registration remains visible/offline; the background sweep retries with backoff.
    if (this.#disposed || !next.valid()) {
      await owner.dispose(this.#disposed ? "shutdown" : "server-gone");
      return;
    }
    entry.observation = next;
    entry.scope = scope;
    entry.owner = owner;
    entry.probeFailures = 0;
    entry.createFailures = 0;
    entry.nextCreateAt = 0;
    entry.offlineMisses = 0;
    entry.nextSweepProbeAt = 0;
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
        createFailures: 0,
        nextCreateAt: 0,
        offlineMisses: 0,
        nextSweepProbeAt: 0,
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
      createFailures: 0,
      nextCreateAt: 0,
      offlineMisses: 0,
      nextSweepProbeAt: 0,
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
      for (const entry of this.#entries.values()) {
        // No socket file, no server: an offline registration costs a stat, not a spawn.
        if (!entry.owner && !this.#socketPresent(entry)) continue;
        await this.#refresh(entry, undefined, { respectBackoff: true });
      }
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
  /**
   * What a read route may do (#840). It never probes, retires or replaces an
   * owner: it answers from what is known. For servers that are offline it
   * starts at most one shared, rate-limited pass that may bring them online,
   * and it waits a bounded time for work already in flight, so a list can
   * neither close a stream nor hang behind a teardown.
   */
  async observe(): Promise<readonly TmuxServerDescriptor[]> {
    if (this.#disposed) throw new TmuxServerScopeError("disposed");
    const now = this.#now();
    const offlineDue = [...this.#entries.values()].some(
      (entry) => !entry.owner && now >= entry.nextCreateAt && this.#socketPresent(entry),
    );
    if (
      offlineDue &&
      !this.#onlinePass &&
      now - this.#lastOnlinePassAt >= OBSERVE_MIN_INTERVAL_MS
    ) {
      this.#lastOnlinePassAt = now;
      const pass = this.#serial(async () => {
        for (const entry of this.#entries.values())
          if (!entry.owner && this.#socketPresent(entry))
            await this.#refresh(entry, undefined, { respectBackoff: true });
      })
        .catch(() => undefined)
        .finally(() => {
          if (this.#onlinePass === pass) this.#onlinePass = null;
        });
      this.#onlinePass = pass;
    }
    if (this.#inFlight > 0)
      await Promise.race([this.#tail, (this.options.delay ?? unrefDelay)(OBSERVE_MAX_WAIT_MS)]);
    return this.list();
  }
  /**
   * The background liveness check. Costs no subprocess while every owner's
   * socket and server process are still there; only evidence of a change, or
   * an offline server whose retry is due, starts the confirmed refresh.
   */
  sweep(): Promise<readonly TmuxServerDescriptor[]> {
    if (this.#disposed) return Promise.resolve([]);
    const now = this.#now();
    const due = [...this.#entries.values()].some((entry) =>
      entry.owner
        ? this.#hasCheapEvidence(entry)
        : now >= Math.max(entry.nextCreateAt, entry.nextSweepProbeAt) && this.#socketPresent(entry),
    );
    return due ? this.refresh() : Promise.resolve(this.list());
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
  /** `retirement` says whether the daemon stops or only restarts its generation. */
  dispose(retirement: "shutdown" | "generation-restart" = "shutdown"): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposed = true;
    this.#disposePromise = (async () => {
      await this.#tail;
      const entries = [...this.#entries.values()];
      this.#entries.clear();
      await Promise.allSettled(
        entries.map((entry) => this.#retire(entry, "owners-disposed", undefined, retirement)),
      );
    })();
    return this.#disposePromise;
  }
}
