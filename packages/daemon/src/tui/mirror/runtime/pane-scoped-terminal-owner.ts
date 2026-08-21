export type PaneContentVersionListener = (version: number, sourceEpoch: number) => void;

/**
 * Pane-local publication owner for the terminal hot path.
 *
 * The root owns topology only. Terminal delivery publishes into the addressed
 * pane's retained listener set, so output cannot clone root maps or invalidate
 * sibling panes/shell state. Generations fence late delivery across runtime
 * replacement while listeners remain stable for an adapter's lifetime.
 */
export class PaneScopedTerminalOwner {
  #generation = 0;
  #publication = 0;
  #sourceEpoch = 0;
  #disposed = false;
  readonly #versions = new Map<string, number>();
  readonly #sourceVersions = new Map<string, number>();
  readonly #listeners = new Map<string, Set<PaneContentVersionListener>>();

  beginGeneration(): number {
    if (this.#disposed) return this.#generation;
    this.#generation += 1;
    this.#versions.clear();
    this.#sourceVersions.clear();
    return this.#generation;
  }

  version(paneId: string): number {
    return this.#versions.get(paneId) ?? 0;
  }

  sourceEpoch(): number {
    return this.#sourceEpoch;
  }

  /**
   * Publish adoption or retirement of the retained terminal source.
   *
   * A semantic seed can arrive before the async runtime factory resolves. In
   * that ordering a resident PaneSurface has already walked against the empty
   * retained facade. Source replacement therefore needs its own pane-local
   * invalidation so every resident surface performs one full blit after the
   * backing replica becomes reachable, even when no later terminal bytes arrive.
   */
  replaceSource(): void {
    if (this.#disposed) return;
    this.#sourceEpoch += 1;
    const paneIds = new Set([...this.#versions.keys(), ...this.#listeners.keys()]);
    for (const paneId of paneIds) {
      const version = this.version(paneId);
      for (const listener of this.#listeners.get(paneId) ?? [])
        listener(version, this.#sourceEpoch);
    }
  }

  publish(generation: number, paneId: string, version: number): boolean {
    if (this.#disposed || generation !== this.#generation) return false;
    const previous = this.#sourceVersions.get(paneId) ?? 0;
    if (version <= previous) return false;
    this.#sourceVersions.set(paneId, version);

    // Replica versions restart when a runtime generation is replaced. Keep a
    // process-local monotonic token so a replacement whose first version is
    // also `1` still invalidates exactly the addressed pane.
    this.#publication += 1;
    this.#versions.set(paneId, this.#publication);
    for (const listener of this.#listeners.get(paneId) ?? [])
      listener(this.#publication, this.#sourceEpoch);
    return true;
  }

  subscribe(paneId: string, listener: PaneContentVersionListener): () => void {
    if (this.#disposed) return () => {};
    const listeners = this.#listeners.get(paneId) ?? new Set<PaneContentVersionListener>();
    listeners.add(listener);
    this.#listeners.set(paneId, listeners);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(paneId);
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation += 1;
    this.#versions.clear();
    this.#sourceVersions.clear();
    this.#listeners.clear();
  }
}
