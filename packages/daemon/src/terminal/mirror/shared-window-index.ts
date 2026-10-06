/** Event-fed physical window membership for one pinned tmux server. */
export class SharedWindowIndex<Owner> {
  readonly #windows = new Map<string, Set<Owner>>();
  readonly #owners = new Map<Owner, Set<string>>();
  readonly #conflicts = new Set<Owner>();

  conflicted(owner: Owner): boolean {
    return this.#conflicts.has(owner);
  }

  update(owner: Owner, windows: readonly string[]): Map<Owner, boolean> {
    const previous = this.#owners.get(owner) ?? new Set<string>();
    const next = new Set(windows);
    const affected = new Set<Owner>([owner]);
    for (const window of new Set([...previous, ...next])) {
      for (const peer of this.#windows.get(window) ?? []) affected.add(peer);
      if (previous.has(window) && !next.has(window)) {
        const peers = this.#windows.get(window)!;
        peers.delete(owner);
        if (!peers.size) this.#windows.delete(window);
      }
      if (next.has(window)) {
        const peers = this.#windows.get(window) ?? new Set<Owner>();
        peers.add(owner);
        this.#windows.set(window, peers);
      }
    }
    if (next.size) this.#owners.set(owner, next);
    else this.#owners.delete(owner);
    const changed = new Map<Owner, boolean>();
    for (const peer of affected) {
      const conflict = [...(this.#owners.get(peer) ?? [])].some(
        (window) => (this.#windows.get(window)?.size ?? 0) > 1,
      );
      if (conflict === this.#conflicts.has(peer)) continue;
      if (conflict) this.#conflicts.add(peer);
      else this.#conflicts.delete(peer);
      changed.set(peer, conflict);
    }
    return changed;
  }
}
