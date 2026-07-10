/**
 * Subscriber fan-out bookkeeping for the control server — PURE.
 *
 * Tracks the set of live subscribers and delivers each emitted event to all
 * of them. The `onFirst`/`onLast` edges let the server run its detection
 * tick ONLY while someone is listening (0→1 starts it, 1→0 stops it), so an
 * idle `tmux-ide serve` costs nothing between requests.
 */

export interface Fanout<T> {
  /** Register a sink. Returns its unsubscribe (idempotent). */
  add(sink: (event: T) => void): () => void;
  /** Deliver `event` to every sink. A throwing sink is dropped, not fatal. */
  emit(event: T): void;
  size(): number;
}

export function createFanout<T>(
  edges: { onFirst?: () => void; onLast?: () => void } = {},
): Fanout<T> {
  const sinks = new Set<(event: T) => void>();
  const remove = (sink: (event: T) => void): void => {
    if (!sinks.delete(sink)) return;
    if (sinks.size === 0) edges.onLast?.();
  };
  return {
    add(sink) {
      sinks.add(sink);
      if (sinks.size === 1) edges.onFirst?.();
      return () => remove(sink);
    },
    emit(event) {
      for (const sink of [...sinks]) {
        try {
          sink(event);
        } catch {
          // A sink that throws (a torn-down connection) removes itself.
          remove(sink);
        }
      }
    },
    size: () => sinks.size,
  };
}
