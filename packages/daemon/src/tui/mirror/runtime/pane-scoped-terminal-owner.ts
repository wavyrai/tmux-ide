export type PaneContentVersionListener = (version: number) => void;

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
    for (const listener of this.#listeners.get(paneId) ?? []) listener(this.#publication);
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
