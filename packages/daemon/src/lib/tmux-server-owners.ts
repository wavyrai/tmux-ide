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
export interface DisposableTmuxServerOwner {
  dispose(): Promise<void>;
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
};
export interface TmuxServerOwnersOptions<T extends DisposableTmuxServerOwner> {
  readonly probe: (
    selector: TmuxServerRegistration["selector"],
  ) => Promise<TmuxServerObservation | null>;
  readonly create: (
    registration: TmuxServerRegistration,
    scope: TmuxServerScope,
    observation: TmuxServerObservation,
  ) => Promise<T>;
  readonly persist?: (registrations: readonly TmuxServerRegistration[]) => void;
}
/** One process; no shared mutable tmux authority, runtime cache or retry ledger. */
export class TmuxServerOwners<T extends DisposableTmuxServerOwner> {
  readonly #entries = new Map<string, Entry<T>>();
  #tail: Promise<unknown> = Promise.resolve();
  #disposed = false;
  #disposePromise: Promise<void> | null = null;
  constructor(readonly options: TmuxServerOwnersOptions<T>) {}
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
  async #retire(entry: Entry<T>): Promise<void> {
    const owner = entry.owner;
    entry.owner = null;
    entry.scope = null;
    entry.observation = null;
    if (owner) await owner.dispose();
  }
  async #refresh(entry: Entry<T>, observed?: TmuxServerObservation | null): Promise<void> {
    const next =
      observed === undefined ? await this.options.probe(entry.registration.selector) : observed;
    if (next && entry.observation?.fingerprint === next.fingerprint && entry.observation.valid())
      return;
    // Absence revokes command/stream leases without claiming native server death.
    // Socket recreation also needs a fresh connection authority, even if PID survived.
    await this.#retire(entry);
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
    try {
      owner = await this.options.create(entry.registration, scope, next);
    } catch {
      return;
    } // Registration remains visible/offline; explicit refresh retries.
    if (this.#disposed || !next.valid()) {
      await owner.dispose();
      return;
    }
    entry.observation = next;
    entry.scope = scope;
    entry.owner = owner;
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
      const observation = await this.options.probe(registration.selector);
      if (this.#disposed) throw new TmuxServerScopeError("disposed");
      const alias =
        observation &&
        [...this.#entries.values()].find(
          (entry) =>
            entry.observation?.fingerprint === observation.fingerprint && entry.observation.valid(),
        );
      if (alias) return this.#descriptor(alias);
      if (this.#entries.size >= MAX_TMUX_SERVER_OWNERS) throw new TmuxServerScopeError("capacity");
      const entry: Entry<T> = { registration, observation: null, scope: null, owner: null };
      this.#entries.set(registration.serverId, entry);
      try {
        this.#save();
      } catch (error) {
        this.#entries.delete(registration.serverId);
        throw error;
      }
      await this.#refresh(entry, observation);
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
    this.#entries.set(scope.serverId, { registration, scope, observation, owner });
  }
  refresh(): Promise<readonly TmuxServerDescriptor[]> {
    return this.#serial(async () => {
      // Sequential admission bounds subprocess work and avoids alias races.
      for (const entry of this.#entries.values()) await this.#refresh(entry);
      return this.list();
    });
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
      await this.#retire(entry); // never kill-server or kill-session
    });
  }
  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposed = true;
    this.#disposePromise = (async () => {
      await this.#tail;
      const entries = [...this.#entries.values()];
      this.#entries.clear();
      await Promise.allSettled(entries.map((entry) => this.#retire(entry)));
    })();
    return this.#disposePromise;
  }
}
