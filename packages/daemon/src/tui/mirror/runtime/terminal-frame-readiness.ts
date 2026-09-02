import type { OpenTuiGenerationHostSnapshot } from "./open-tui-generation-host.ts";

interface TerminalFrameReadinessOptions {
  readonly requestRender: () => void;
  readonly scheduleAfterFrame?: (callback: () => void) => void;
  readonly markReady: (key: string, snapshot: OpenTuiGenerationHostSnapshot) => boolean;
  readonly drainDetailed: (snapshot: OpenTuiGenerationHostSnapshot) => void;
  readonly needsDetailedDrain?: (snapshot: OpenTuiGenerationHostSnapshot) => boolean;
}

export interface TerminalFrameReadiness {
  adopt(snapshot: OpenTuiGenerationHostSnapshot | null): void;
  observeFrame(): void;
  dispose(): void;
}

/** Coordinates the frame after a canonical blit without owning rendering. */
export function createTerminalFrameReadiness(
  options: TerminalFrameReadinessOptions,
): TerminalFrameReadiness {
  let published: OpenTuiGenerationHostSnapshot | null = null;
  let disposed = false;
  let publishedKey: string | null = null;
  let postFrameCheckScheduled = false;
  let postFrameScheduleEpoch = 0;
  const requestedFollowups = new Set<string>();
  const recorded = new Set<string>();
  const schedule = options.scheduleAfterFrame ?? queueMicrotask;
  const keyFor = (snapshot: OpenTuiGenerationHostSnapshot): string | null =>
    snapshot.daemonGeneration ? `${snapshot.daemonGeneration}:${snapshot.rendererEpoch}` : null;

  return {
    adopt(snapshot) {
      published = snapshot;
      const nextKey = snapshot ? keyFor(snapshot) : null;
      if (nextKey !== publishedKey) {
        requestedFollowups.clear();
        recorded.clear();
        postFrameCheckScheduled = false;
        postFrameScheduleEpoch += 1;
        publishedKey = nextKey;
      }
    },
    observeFrame() {
      const snapshot = published;
      if (
        disposed ||
        !snapshot ||
        snapshot.status !== "live" ||
        !snapshot.daemonGeneration ||
        !snapshot.adapter
      )
        return;
      const key = keyFor(snapshot)!;
      if (snapshot.adapter.hasPaintedCanonicalSnapshot()) {
        if (!recorded.has(key)) {
          try {
            if (options.markReady(key, snapshot)) recorded.add(key);
          } catch {
            // Opt-in readiness diagnostics never own renderer lifecycle.
          }
        }
        try {
          options.drainDetailed(snapshot);
        } catch {
          // Opt-in detailed diagnostics never own renderer lifecycle.
        }
      }
      const requestReadinessFollowup =
        !snapshot.adapter.hasPaintedCanonicalSnapshot() &&
        snapshot.adapter.hasCanonicalSnapshot() &&
        !requestedFollowups.has(key);
      if (requestReadinessFollowup) requestedFollowups.add(key);
      if ((!requestReadinessFollowup && !options.needsDetailedDrain) || postFrameCheckScheduled)
        return;
      postFrameCheckScheduled = true;
      const scheduleEpoch = ++postFrameScheduleEpoch;
      const expected = snapshot;
      schedule(() => {
        if (scheduleEpoch !== postFrameScheduleEpoch) return;
        postFrameCheckScheduled = false;
        if (disposed || published !== expected || keyFor(expected) !== key) return;
        try {
          if (requestReadinessFollowup || options.needsDetailedDrain?.(expected))
            options.requestRender();
        } catch {
          // Opt-in readiness diagnostics never own renderer lifecycle.
        }
      });
    },
    dispose() {
      disposed = true;
      published = null;
      postFrameCheckScheduled = false;
      postFrameScheduleEpoch += 1;
      requestedFollowups.clear();
      recorded.clear();
    },
  };
}
