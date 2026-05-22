/**
 * useMonacoLease — Solid hook for leasing a Monaco editor entry.
 *
 * Leases one editor on mount, releases it on cleanup. Returns a
 * Solid `Accessor<PoolEntry<T> | null>` that flips from null to the
 * lease once the pool resolves. Solid components reading the
 * accessor re-run when the lease arrives, matching the React+MobX
 * original's `IObservableValue` semantics.
 *
 * Replaces emdash's `use-monaco-lease.ts`. The lease arrival path is
 * intentionally tolerant of the component unmounting mid-flight: if
 * cleanup runs before `pool.lease()` resolves, the lease is released
 * directly instead of being handed to the signal (which has no
 * subscribers any more).
 */

import { createSignal, onCleanup, onMount, type Accessor } from "solid-js";
import type { PoolEntry } from "./pool";

interface Pool<T> {
  lease(): Promise<PoolEntry<T>>;
  release(entry: PoolEntry<T>): void;
}

export function useMonacoLease<T>(pool: Pool<T>): Accessor<PoolEntry<T> | null> {
  const [entry, setEntry] = createSignal<PoolEntry<T> | null>(null);
  let leased: PoolEntry<T> | null = null;
  let cancelled = false;

  onMount(() => {
    void pool.lease().then((e) => {
      if (cancelled) {
        pool.release(e);
        return;
      }
      leased = e;
      setEntry(e);
    });
  });

  onCleanup(() => {
    cancelled = true;
    if (leased) {
      pool.release(leased);
      leased = null;
      setEntry(null);
    }
  });

  return entry;
}
