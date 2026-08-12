export type OptionalFeatureMap = Record<string, unknown>;

export type OptionalFeatureLoaders<Features extends OptionalFeatureMap> = {
  readonly [Key in keyof Features]?: () => Promise<Features[Key]>;
};

export interface OptionalFeatureRegistryMetrics {
  readonly admitted: boolean;
  readonly disposed: boolean;
  readonly generation: number;
  readonly requests: number;
  readonly retainedIntents: number;
  readonly joinedRequests: number;
  readonly unavailableRequests: number;
  readonly loadsStarted: number;
  readonly loadsSucceeded: number;
  readonly loadsFailed: number;
  readonly activeLoads: number;
  readonly cacheHits: number;
  readonly publications: number;
  readonly lateResultsDiscarded: number;
}

export class OptionalFeatureRegistryDisposedError extends Error {
  readonly code = "optional-feature-registry-disposed";

  constructor() {
    super("Optional feature registry is disposed");
    this.name = "OptionalFeatureRegistryDisposedError";
  }
}

interface Deferred<Value> {
  readonly promise: Promise<Value | undefined>;
  readonly resolve: (value: Value | undefined) => void;
  readonly reject: (reason: unknown) => void;
}

type FeatureSlot<Value> =
  | { readonly phase: "queued"; readonly deferred: Deferred<Value> }
  | { readonly phase: "loading"; readonly deferred: Deferred<Value>; readonly generation: number }
  | { readonly phase: "ready"; readonly value: Value };

const eraseFeatureSlot = <Value>(slot: FeatureSlot<Value>): FeatureSlot<unknown> =>
  slot as unknown as FeatureSlot<unknown>;

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value | undefined) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value | undefined>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

/**
 * Lifecycle owner for optional application feature modules.
 *
 * Intent may arrive before terminal readiness, but loaders cannot run until
 * `admit()`. Each feature has one retained promise, one physical load, and one
 * cached publication. Disposal advances the authority generation and rejects
 * callers immediately; an already-running loader may settle, but its result is
 * counted and discarded rather than published into a retired application.
 */
export class OptionalFeatureRegistry<Features extends OptionalFeatureMap> {
  readonly #loaders: OptionalFeatureLoaders<Features>;
  readonly #slots = new Map<keyof Features, FeatureSlot<unknown>>();
  #admitted = false;
  #disposed = false;
  #generation = 1;
  #requests = 0;
  #retainedIntents = 0;
  #joinedRequests = 0;
  #unavailableRequests = 0;
  #loadsStarted = 0;
  #loadsSucceeded = 0;
  #loadsFailed = 0;
  #activeLoads = 0;
  #cacheHits = 0;
  #publications = 0;
  #lateResultsDiscarded = 0;

  constructor(loaders: OptionalFeatureLoaders<Features>) {
    this.#loaders = loaders;
  }

  request<Key extends keyof Features>(key: Key): Promise<Features[Key] | undefined> {
    this.#requests += 1;
    if (this.#disposed) return Promise.reject(new OptionalFeatureRegistryDisposedError());

    const loader = this.#loaders[key];
    if (!loader) {
      this.#unavailableRequests += 1;
      return Promise.resolve(undefined);
    }

    const existing = this.#slots.get(key) as FeatureSlot<Features[Key]> | undefined;
    if (existing?.phase === "ready") {
      this.#cacheHits += 1;
      return Promise.resolve(existing.value);
    }
    if (existing) {
      this.#joinedRequests += 1;
      return existing.deferred.promise;
    }

    const pending = deferred<Features[Key]>();
    this.#slots.set(key, eraseFeatureSlot({ phase: "queued", deferred: pending }));
    if (this.#admitted) this.#start(key, loader, pending);
    else this.#retainedIntents += 1;
    return pending.promise;
  }

  admit(): boolean {
    if (this.#disposed || this.#admitted) return false;
    this.#admitted = true;
    for (const [key, slot] of this.#slots) {
      if (slot.phase !== "queued") continue;
      const loader = this.#loaders[key];
      if (loader) this.#start(key, loader, slot.deferred as Deferred<Features[typeof key]>);
    }
    return true;
  }

  peek<Key extends keyof Features>(key: Key): Features[Key] | undefined {
    const slot = this.#slots.get(key) as FeatureSlot<Features[Key]> | undefined;
    return slot?.phase === "ready" ? slot.value : undefined;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation += 1;
    const error = new OptionalFeatureRegistryDisposedError();
    for (const slot of this.#slots.values()) {
      if (slot.phase !== "ready") slot.deferred.reject(error);
    }
    this.#slots.clear();
  }

  getMetrics(): OptionalFeatureRegistryMetrics {
    return {
      admitted: this.#admitted,
      disposed: this.#disposed,
      generation: this.#generation,
      requests: this.#requests,
      retainedIntents: this.#retainedIntents,
      joinedRequests: this.#joinedRequests,
      unavailableRequests: this.#unavailableRequests,
      loadsStarted: this.#loadsStarted,
      loadsSucceeded: this.#loadsSucceeded,
      loadsFailed: this.#loadsFailed,
      activeLoads: this.#activeLoads,
      cacheHits: this.#cacheHits,
      publications: this.#publications,
      lateResultsDiscarded: this.#lateResultsDiscarded,
    };
  }

  #start<Key extends keyof Features>(
    key: Key,
    loader: () => Promise<Features[Key]>,
    pending: Deferred<Features[Key]>,
  ): void {
    const generation = this.#generation;
    this.#loadsStarted += 1;
    this.#activeLoads += 1;
    this.#slots.set(
      key,
      eraseFeatureSlot({
        phase: "loading",
        deferred: pending,
        generation,
      }),
    );

    let load: Promise<Features[Key]>;
    try {
      load = loader();
    } catch (error) {
      load = Promise.reject(error);
    }
    void load.then(
      (value) => {
        this.#activeLoads -= 1;
        this.#loadsSucceeded += 1;
        const slot = this.#slots.get(key) as FeatureSlot<Features[Key]> | undefined;
        if (
          this.#disposed ||
          generation !== this.#generation ||
          slot?.phase !== "loading" ||
          slot.generation !== generation ||
          slot.deferred !== pending
        ) {
          this.#lateResultsDiscarded += 1;
          return;
        }
        this.#publications += 1;
        this.#slots.set(key, eraseFeatureSlot({ phase: "ready", value }));
        pending.resolve(value);
      },
      (error) => {
        this.#activeLoads -= 1;
        this.#loadsFailed += 1;
        const slot = this.#slots.get(key) as FeatureSlot<Features[Key]> | undefined;
        if (
          this.#disposed ||
          generation !== this.#generation ||
          slot?.phase !== "loading" ||
          slot.generation !== generation ||
          slot.deferred !== pending
        ) {
          this.#lateResultsDiscarded += 1;
          return;
        }
        this.#slots.delete(key);
        pending.reject(error);
      },
    );
  }
}
