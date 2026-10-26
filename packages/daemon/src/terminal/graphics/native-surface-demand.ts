/** Bounded daemon-local demand for ordinary terminal image output. Unknown
 * native-client inventory preserves fallback; only proven absence can suppress it. */
export interface SurfaceViewerDemand {
  native(ready: boolean): void;
  close(): void;
}
type Viewer = { session: string; panes: ReadonlySet<string>; native: boolean };
export class NativeSurfaceDemand {
  #viewers = new Set<Viewer>();
  #presence = new Map<string, boolean>();
  #listeners = new Set<() => void>();
  #overflow = 0;
  #closed = false;
  #queued = false;
  presence(session: string, present: boolean | null): void {
    if (this.#closed) return;
    if (present === null) this.#presence.delete(session);
    else {
      if (!this.#presence.has(session) && this.#presence.size >= 256) {
        const oldest = this.#presence.keys().next().value;
        if (oldest !== undefined) this.#presence.delete(oldest);
      }
      this.#presence.set(session, present);
    }
    this.#notify();
  }
  viewer(session: string, panes: readonly string[]): SurfaceViewerDemand {
    const viewer: Viewer = { session, panes: new Set(panes), native: false };
    const retained = !this.#closed && this.#viewers.size < 256 && panes.length <= 256;
    if (retained) this.#viewers.add(viewer);
    else this.#overflow++;
    this.#notify();
    let closed = false;
    return {
      native: (ready) => {
        if (closed || viewer.native === ready) return;
        viewer.native = ready;
        this.#notify();
      },
      close: () => {
        if (closed) return;
        closed = true;
        if (retained) this.#viewers.delete(viewer);
        else this.#overflow--;
        this.#notify();
      },
    };
  }
  required(pane: string): boolean {
    if (this.#closed || this.#overflow) return true;
    let known = false;
    for (const viewer of this.#viewers) {
      if (!viewer.panes.has(pane)) continue;
      known = true;
      if (!viewer.native || this.#presence.get(viewer.session) !== false) return true;
    }
    return !known;
  }
  watch(listener: () => void): () => void {
    if (this.#closed || this.#listeners.size >= 256) throw new Error("Surface demand unavailable");
    this.#listeners.add(listener);
    this.#notify();
    return () => this.#listeners.delete(listener);
  }
  #notify(): void {
    if (this.#queued) return;
    this.#queued = true;
    queueMicrotask(() => {
      this.#queued = false;
      for (const listener of [...this.#listeners]) {
        if (!this.#listeners.has(listener)) continue;
        try {
          listener();
        } catch {
          this.#listeners.delete(listener);
        }
      }
      if (this.#closed) this.#listeners.clear();
    });
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#viewers.clear();
    this.#presence.clear();
    this.#notify();
  }
}
