export type AsyncDisposer = () => void | Promise<void>;

/**
 * Owns one asynchronously-created resource across replacement and shutdown.
 *
 * Creation cannot be cancelled, so every request captures a generation. A
 * resource that resolves after replacement/disposal is retired immediately
 * instead of being adopted by a dead UI root.
 */
export class AsyncDisposableSlot<Key> {
  private generation = 0;
  private currentKey: Key | null = null;
  private currentDisposer: AsyncDisposer | null = null;
  private disposed = false;

  get key(): Key | null {
    return this.currentKey;
  }

  ensure(key: Key, create: () => Promise<AsyncDisposer>): void {
    if (this.disposed || Object.is(this.currentKey, key)) return;

    const generation = ++this.generation;
    this.currentKey = key;
    const previous = this.currentDisposer;
    this.currentDisposer = null;
    this.retire(previous);

    void create()
      .then((disposer) => {
        if (this.disposed || generation !== this.generation) {
          this.retire(disposer);
          return;
        }
        this.currentDisposer = disposer;
      })
      .catch(() => {
        if (!this.disposed && generation === this.generation) this.currentKey = null;
      });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.currentKey = null;
    const current = this.currentDisposer;
    this.currentDisposer = null;
    this.retire(current);
  }

  private retire(disposer: AsyncDisposer | null): void {
    if (!disposer) return;
    try {
      void Promise.resolve(disposer()).catch(() => {});
    } catch {
      // Resource cleanup is best-effort and must not interrupt later owners.
    }
  }
}
