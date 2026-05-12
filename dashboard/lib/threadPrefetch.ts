/**
 * Thread-prefetch cache for instant chat-v2 navigation.
 *
 * Companion to dashboard/lib/historyBootstrap.ts (a913196). The two are
 * orthogonal: historyBootstrap packs prior messages into an LLM-context
 * string; this module front-loads the *fetched thread state* so clicking
 * a thread renders without a network round-trip.
 *
 * Strategy:
 *   1. Boot: V2ChatView already calls `chatThreadList()`. After it
 *      returns, call `bootstrapPrefetchFromList(threads, { topN: 5 })`.
 *      The cache eagerly fetches the top-N most-recently-updated threads
 *      in parallel.
 *   2. Hit: `useOrchestrationRecovery` (the only on-switch fetcher today)
 *      swaps `chatThreadGet(id)` for `getOrFetchThread(id)`. Cache hits
 *      resolve synchronously via a pre-resolved promise; misses fall
 *      back to `chatThreadGet` and populate the cache.
 *   3. Stale-while-revalidate: on `document.visibilitychange` → visible,
 *      every cache entry older than `STALE_MS` re-fetches in the
 *      background. The hook keeps returning the old value until the
 *      refresh resolves.
 *
 * The cache is a Zustand store so subscribers re-render on update; the
 * patterns mirror `dashboard/components/chat-v2/useChatStore.ts`.
 */

"use client";

import { useEffect, useMemo, useRef } from "react";
import { create } from "zustand";

import { chatThreadGet } from "@/lib/api";
import type { ThreadIndexEntry, ThreadState } from "@/components/chat-v2/types";

// ---------------------------------------------------------------------------
// Tuning knobs (test-overridable)
// ---------------------------------------------------------------------------

/** Default fan-out for `bootstrapPrefetchFromList`. */
export const DEFAULT_TOP_N = 5;

/**
 * Threshold above which a cached entry is considered stale and triggers a
 * background re-fetch on the next visibility-change. 5 s mirrors the chat
 * poll cadence used elsewhere in chat-v2.
 */
export const STALE_MS = 5_000;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface CacheEntry {
  /** The fetched state; `null` means the thread is known not to exist (404). */
  state: ThreadState | null;
  /** Date.now() at the time of the last successful fetch. */
  fetchedAt: number;
  /** Latest error from a fetch attempt — cleared when a fresh fetch resolves. */
  error: Error | null;
}

interface ThreadPrefetchState {
  cache: Record<string, CacheEntry>;
  /** In-flight promises keyed by threadId so concurrent requests dedupe. */
  inflight: Record<string, Promise<ThreadState | null>>;
  /** Side-effect: insert a successful fetch result. */
  setSuccess(threadId: string, state: ThreadState | null): void;
  /** Side-effect: insert a failed fetch result (keeps any prior state). */
  setError(threadId: string, error: Error): void;
  /** Track / clear an in-flight promise. */
  setInflight(threadId: string, promise: Promise<ThreadState | null> | null): void;
  /** Drop a single entry — used by tests and on explicit thread delete. */
  invalidate(threadId: string): void;
  /** Drop everything (test helper). */
  reset(): void;
}

export const useThreadPrefetchStore = create<ThreadPrefetchState>((set) => ({
  cache: {},
  inflight: {},
  setSuccess(threadId, state) {
    set((s) => ({
      cache: {
        ...s.cache,
        [threadId]: { state, fetchedAt: Date.now(), error: null },
      },
    }));
  },
  setError(threadId, error) {
    set((s) => {
      const prev = s.cache[threadId];
      return {
        cache: {
          ...s.cache,
          [threadId]: {
            state: prev?.state ?? null,
            fetchedAt: prev?.fetchedAt ?? 0,
            error,
          },
        },
      };
    });
  },
  setInflight(threadId, promise) {
    set((s) => {
      const next = { ...s.inflight };
      if (promise === null) delete next[threadId];
      else next[threadId] = promise;
      return { inflight: next };
    });
  },
  invalidate(threadId) {
    set((s) => {
      const next = { ...s.cache };
      delete next[threadId];
      const nextInflight = { ...s.inflight };
      delete nextInflight[threadId];
      return { cache: next, inflight: nextInflight };
    });
  },
  reset() {
    set({ cache: {}, inflight: {} });
  },
}));

// ---------------------------------------------------------------------------
// Fetch helpers (imperative API)
// ---------------------------------------------------------------------------

/**
 * Read-only cache lookup. Returns `undefined` if the thread has never been
 * fetched; returns the entry (possibly with `state: null` for a known-404
 * thread) when warm. Doesn't trigger a fetch.
 */
export function getCached(threadId: string): CacheEntry | undefined {
  return useThreadPrefetchStore.getState().cache[threadId];
}

/**
 * Fetch a thread, dedup'd via the in-flight map. Returns the cached value
 * synchronously when warm (wraps in `Promise.resolve`), otherwise issues a
 * fresh `chatThreadGet` and stores the result.
 */
export function getOrFetchThread(threadId: string): Promise<ThreadState | null> {
  // Side-effect: ensure the visibility listener is installed the first
  // time anyone touches the cache. The hook (`usePreloadedThread`) also
  // calls this, but the imperative path (used by `useOrchestrationRecovery`)
  // was bypassing it — meaning stale-while-revalidate never armed in
  // production. Installing on first imperative call closes that gap.
  ensureVisibilityListener();
  const store = useThreadPrefetchStore.getState();
  const cached = store.cache[threadId];
  if (cached && cached.error === null) {
    // Cache hit — resolve synchronously. Stale-while-revalidate is the
    // visibility listener's job, not the read path.
    return Promise.resolve(cached.state);
  }
  const inflight = store.inflight[threadId];
  if (inflight) return inflight;
  const promise = chatThreadGet(threadId)
    .then((state) => {
      useThreadPrefetchStore.getState().setSuccess(threadId, state);
      return state;
    })
    .catch((err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      useThreadPrefetchStore.getState().setError(threadId, error);
      throw error;
    })
    .finally(() => {
      useThreadPrefetchStore.getState().setInflight(threadId, null);
    });
  store.setInflight(threadId, promise);
  return promise;
}

/**
 * Refetch in the background. Doesn't await — caller fires-and-forgets.
 * Used by the visibility listener; safe to call from anywhere.
 */
export function refetchInBackground(threadId: string): void {
  // Reuse getOrFetch's dedup but force a refresh by clearing the existing
  // entry first. Note: we keep the OLD state visible to subscribers until
  // the new fetch lands — that's the stale-while-revalidate behavior.
  const store = useThreadPrefetchStore.getState();
  if (store.inflight[threadId]) return;
  void chatThreadGet(threadId)
    .then((state) => useThreadPrefetchStore.getState().setSuccess(threadId, state))
    .catch((err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      useThreadPrefetchStore.getState().setError(threadId, error);
    });
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

export interface BootstrapPrefetchOptions {
  /** How many of the most-recently-updated threads to warm. Default 5. */
  topN?: number;
}

/**
 * Eagerly fetch the top-N most-recently-updated threads from `threads`.
 * Returns when all parallel fetches settle (success or failure). Per-thread
 * errors don't reject the outer promise — the cache absorbs them via
 * `setError`.
 */
export async function bootstrapPrefetchFromList(
  threads: ReadonlyArray<ThreadIndexEntry>,
  options: BootstrapPrefetchOptions = {},
): Promise<void> {
  const topN = options.topN ?? DEFAULT_TOP_N;
  const ranked = [...threads]
    .sort((a, b) => sortKey(b) - sortKey(a))
    .slice(0, Math.max(0, topN));
  await Promise.allSettled(
    ranked.map((t) =>
      getOrFetchThread(t.id).catch(() => undefined /* swallowed; cache holds err */),
    ),
  );
}

function sortKey(t: ThreadIndexEntry): number {
  // Prefer `updatedAt`, fall back to `createdAt`, then 0. Treat missing /
  // unparseable values as oldest so they sort to the bottom.
  const candidate = (t as { updatedAt?: string; createdAt?: string }).updatedAt
    ?? (t as { createdAt?: string }).createdAt;
  if (!candidate) return 0;
  const ms = new Date(candidate).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

// ---------------------------------------------------------------------------
// Hook + visibility listener
// ---------------------------------------------------------------------------

/**
 * React hook: returns the cached state for `threadId` plus loading + error
 * flags. On first use it kicks off a fetch (cache miss). When the cache is
 * warm the initial render already has the data — no spinner.
 *
 * Also installs a `visibilitychange` listener that refreshes every stale
 * entry when the tab comes back to the foreground. Multiple components
 * calling this hook deduplicate via the in-flight map.
 */
export interface UsePreloadedThreadResult {
  state: ThreadState | null;
  /** True while a fetch is in flight AND no prior value is cached. */
  loading: boolean;
  /** Latest fetch error, if any. Cleared once a fresh fetch succeeds. */
  error: Error | null;
  /** True when the entry was already in cache before this hook mounted. */
  warm: boolean;
}

export function usePreloadedThread(
  threadId: string | null,
): UsePreloadedThreadResult {
  const initialWarm = useRef<boolean>(
    threadId !== null && getCached(threadId) !== undefined,
  );

  const entry = useThreadPrefetchStore((s) =>
    threadId === null ? undefined : s.cache[threadId],
  );
  const isInflight = useThreadPrefetchStore((s) =>
    threadId === null ? false : Boolean(s.inflight[threadId]),
  );

  // Kick off a fetch on mount / threadId change when we have nothing.
  useEffect(() => {
    if (!threadId) return;
    if (getCached(threadId) === undefined) {
      void getOrFetchThread(threadId).catch(() => {
        // Error already stored in the cache; UI reads it from `entry`.
      });
    }
  }, [threadId]);

  ensureVisibilityListener();

  return useMemo<UsePreloadedThreadResult>(
    () => ({
      state: entry?.state ?? null,
      loading: !entry && isInflight,
      error: entry?.error ?? null,
      warm: initialWarm.current,
    }),
    [entry, isInflight],
  );
}

// ---------------------------------------------------------------------------
// Visibility listener — installed once per page lifetime
// ---------------------------------------------------------------------------

let visibilityInstalled = false;
let onVisibilityChange: (() => void) | null = null;

function ensureVisibilityListener(): void {
  if (visibilityInstalled) return;
  if (typeof document === "undefined") return;
  visibilityInstalled = true;
  onVisibilityChange = () => {
    if (document.visibilityState !== "visible") return;
    const now = Date.now();
    const { cache } = useThreadPrefetchStore.getState();
    for (const [threadId, entry] of Object.entries(cache)) {
      if (now - entry.fetchedAt > STALE_MS) {
        refetchInBackground(threadId);
      }
    }
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
}

/**
 * Test helper — tears down the visibility listener AND the in-memory
 * cache. NEVER called from production code.
 */
export function __resetThreadPrefetchForTests(): void {
  if (typeof document !== "undefined" && onVisibilityChange) {
    document.removeEventListener("visibilitychange", onVisibilityChange);
  }
  visibilityInstalled = false;
  onVisibilityChange = null;
  useThreadPrefetchStore.getState().reset();
}

/** Test helper — directly invokes the visibility handler. */
export function __triggerVisibilityChangeForTests(): void {
  onVisibilityChange?.();
}
