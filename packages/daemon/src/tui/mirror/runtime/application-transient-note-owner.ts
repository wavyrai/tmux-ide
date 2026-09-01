export interface ApplicationTransientNoteClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ApplicationTransientNoteOwner {
  publish(note: string | null): void;
  dispose(): void;
}

/** Owns short-lived success notices without ever clearing a newer persistent status. */
export function createApplicationTransientNoteOwner(options: {
  read: () => string | null;
  write: (note: string | null) => void;
  ttlMs?: number;
  clock?: ApplicationTransientNoteClock;
}): ApplicationTransientNoteOwner {
  const clock =
    options.clock ??
    ({
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    } satisfies ApplicationTransientNoteClock);
  let timer: unknown | null = null;
  const clear = () => {
    if (timer === null) return;
    clock.clearTimeout(timer);
    timer = null;
  };
  return {
    publish(note) {
      clear();
      options.write(note);
      if (!note) return;
      timer = clock.setTimeout(() => {
        timer = null;
        if (options.read() === note) options.write(null);
      }, options.ttlMs ?? 1_000);
    },
    dispose: clear,
  };
}
