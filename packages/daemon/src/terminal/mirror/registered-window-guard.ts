export type RegisteredWindowReader = (
  signal: AbortSignal,
) => Promise<readonly { session: string; window: string }[]>;

/** A bounded registration/topology proof, shared by all retained channels. */
export class RegisteredWindowGuard {
  #epoch = 0;
  #current = false;
  #disposed = false;
  #conflicts = new Set<string>();
  #read: { abort: AbortController; promise: Promise<void> } | null = null;

  constructor(private readonly reader: RegisteredWindowReader) {}

  blocked(session: string): boolean {
    return !this.#current || this.#conflicts.has(session);
  }

  pending(): boolean {
    return !this.#current;
  }

  invalidate(): void {
    this.#epoch++;
    this.#current = false;
    this.#read?.abort.abort();
    this.#read = null;
  }

  dispose(): void {
    this.#disposed = true;
    this.invalidate();
  }

  async verify(): Promise<void> {
    if (this.#disposed) throw new Error("Registered window inventory is disposed");
    if (this.#current) return;
    if (this.#read) return this.#read.promise;
    const epoch = this.#epoch;
    const abort = new AbortController();
    const promise = Promise.resolve()
      .then(async () => {
        abort.signal.throwIfAborted();
        const rows = await this.reader(abort.signal);
        abort.signal.throwIfAborted();
        if (epoch !== this.#epoch) throw new Error("Window ownership changed during discovery");
        const owners = new Map<string, Set<string>>();
        for (const row of rows) {
          const sessions = owners.get(row.window) ?? new Set<string>();
          sessions.add(row.session);
          owners.set(row.window, sessions);
        }
        this.#conflicts = new Set(
          [...owners.values()]
            .filter((sessions) => sessions.size > 1)
            .flatMap((sessions) => [...sessions]),
        );
        this.#current = true;
      })
      .finally(() => {
        if (this.#read?.abort === abort) this.#read = null;
      });
    this.#read = { abort, promise };
    return promise;
  }
}
