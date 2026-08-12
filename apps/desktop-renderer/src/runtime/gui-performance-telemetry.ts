import type { LocalPerformanceAuthorityV1, LocalPerformanceSnapshotV1 } from "@tmux-ide/contracts";
import { LocalPerformanceAggregator } from "@tmux-ide/core";

export interface GuiPerformanceTelemetryOptions {
  readonly authority?: LocalPerformanceAuthorityV1;
  readonly now?: () => number;
  readonly sampleCapacity?: number;
  readonly scheduleFrame?: (callback: (atMs: number) => void) => () => void;
  readonly scheduleIdle?: (callback: () => void, delayMs: number) => () => void;
  readonly activeIdleMs?: number;
}

export interface GuiPerformancePaintTransaction {
  commit(): void;
  cancel(): void;
}

export interface GuiPerformanceTelemetrySink {
  readonly enabled: boolean;
  beginParse(): (() => void) | null;
  beginPaint(): GuiPerformancePaintTransaction | null;
  commitDelivery(): void;
  recordRendered(dirtyRows: number): void;
  recordQueueDepth(current: number, capacity?: number | null): void;
  recordRevisionLag(lag: number): void;
  recordReseed(): void;
}

interface PendingPaint {
  readonly epoch: number;
  readonly aggregator: LocalPerformanceAggregator;
  readonly startedAt: number;
  readonly startRenderSequence: number;
  committed: boolean;
  cancelled: boolean;
}

const MAX_PENDING_PAINTS = 256;
const EMPTY_AUTHORITY: LocalPerformanceAuthorityV1 = Object.freeze({
  daemonInstanceId: null,
  workspaceName: null,
  generation: null,
  incarnation: null,
});

export function guiPerformanceHudRequested(search: string): boolean {
  return new URLSearchParams(search).get("performanceHud") === "1";
}

/**
 * One demand-only browser diagnostics coordinator shared by every xterm pane.
 * Hot paths only update bounded counters and request at most one browser frame;
 * snapshot validation, percentile sorting, and Solid publication happen in the
 * coalesced frame callback, never in terminal protocol delivery.
 */
export class GuiPerformanceTelemetry implements GuiPerformanceTelemetrySink {
  readonly #now: () => number;
  readonly #sampleCapacity: number | undefined;
  readonly #scheduleFrame: (callback: (atMs: number) => void) => () => void;
  readonly #scheduleIdle: (callback: () => void, delayMs: number) => () => void;
  readonly #activeIdleMs: number;
  readonly #listeners = new Set<(snapshot: LocalPerformanceSnapshotV1 | null) => void>();
  #authority: LocalPerformanceAuthorityV1;
  #aggregator: LocalPerformanceAggregator;
  #enabled = false;
  #disposed = false;
  #epoch = 0;
  #frameScheduled = false;
  #cancelFrame: (() => void) | null = null;
  #cancelIdle: (() => void) | null = null;
  #renderSequence = 0;
  #renderDirty = false;
  #dirtyRows = 0;
  #lastObservedRenderAt: number | null = null;
  #lastBrowserRenderAt: number | null = null;
  #activeFps: number | null = null;
  #pendingPaints: PendingPaint[] = [];

  constructor(options: GuiPerformanceTelemetryOptions = {}) {
    this.#now = options.now ?? (() => performance.now());
    this.#sampleCapacity = options.sampleCapacity;
    this.#scheduleFrame =
      options.scheduleFrame ??
      ((callback) => {
        const frame = requestAnimationFrame(callback);
        return () => cancelAnimationFrame(frame);
      });
    this.#scheduleIdle =
      options.scheduleIdle ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
      });
    this.#activeIdleMs = options.activeIdleMs ?? 1_000;
    if (!Number.isFinite(this.#activeIdleMs) || this.#activeIdleMs <= 0) {
      throw new TypeError("active idle duration must be finite and positive");
    }
    this.#authority = options.authority ?? EMPTY_AUTHORITY;
    this.#aggregator = this.#createAggregator();
  }

  get enabled(): boolean {
    return this.#enabled && !this.#disposed;
  }

  enable(): void {
    if (this.#disposed || this.#enabled) return;
    this.#enabled = true;
    this.#epoch += 1;
    this.#aggregator.enable();
    this.#resetFrameState();
    this.#requestPublication();
  }

  disable(): void {
    if (this.#disposed || !this.#enabled) return;
    this.#enabled = false;
    this.#epoch += 1;
    this.#cancelScheduledWork();
    this.#resetFrameState();
    this.#aggregator.disable();
  }

  setAuthority(authority: LocalPerformanceAuthorityV1): void {
    if (this.#disposed || sameAuthority(authority, this.#authority)) return;
    const wasEnabled = this.#enabled;
    this.#epoch += 1;
    this.#cancelScheduledWork();
    this.#aggregator.disable();
    this.#authority = authority;
    this.#aggregator = this.#createAggregator();
    if (wasEnabled) this.#aggregator.enable();
    this.#resetFrameState();
    if (wasEnabled) this.#requestPublication();
  }

  beginParse(): (() => void) | null {
    if (!this.enabled) return null;
    const epoch = this.#epoch;
    const aggregator = this.#aggregator;
    const startedAt = this.#now();
    let settled = false;
    return () => {
      if (settled || !this.#accepts(epoch, aggregator)) return;
      settled = true;
      aggregator.recordParse(Math.max(0, this.#now() - startedAt));
      this.#requestPublication();
    };
  }

  beginPaint(): GuiPerformancePaintTransaction | null {
    if (!this.enabled) return null;
    const pending: PendingPaint = {
      epoch: this.#epoch,
      aggregator: this.#aggregator,
      startedAt: this.#now(),
      startRenderSequence: this.#renderSequence,
      committed: false,
      cancelled: false,
    };
    if (this.#pendingPaints.length >= MAX_PENDING_PAINTS) {
      const evicted = this.#pendingPaints.shift();
      if (evicted) evicted.cancelled = true;
    }
    this.#pendingPaints.push(pending);
    return {
      commit: () => {
        if (pending.cancelled || !this.#accepts(pending.epoch, pending.aggregator)) return;
        pending.committed = true;
        this.#requestPublication();
      },
      cancel: () => {
        pending.cancelled = true;
      },
    };
  }

  commitDelivery(): void {
    if (this.enabled) this.#requestPublication();
  }

  /** xterm onRender hook: O(1), allocation-free, and global across all panes. */
  recordRendered(dirtyRows: number): void {
    if (!this.enabled) return;
    this.#renderSequence += 1;
    this.#renderDirty = true;
    this.#dirtyRows = Math.min(Number.MAX_SAFE_INTEGER, this.#dirtyRows + dirtyRows);
    this.#requestPublication();
  }

  recordQueueDepth(current: number, capacity: number | null = null): void {
    if (!this.enabled) return;
    this.#aggregator.recordQueueDepth(current, capacity);
    this.#requestPublication();
  }

  recordRevisionLag(lag: number): void {
    if (!this.enabled) return;
    this.#aggregator.recordRevisionLag(lag);
    this.#requestPublication();
  }

  recordReseed(): void {
    if (!this.enabled) return;
    this.#aggregator.recordReseed();
    this.#requestPublication();
  }

  snapshot(): LocalPerformanceSnapshotV1 | null {
    const snapshot = this.#aggregator.snapshot();
    return snapshot ? Object.freeze({ ...snapshot, activeFps: this.#activeFps }) : null;
  }

  subscribe(listener: (snapshot: LocalPerformanceSnapshotV1 | null) => void): () => void {
    if (this.#disposed) return () => undefined;
    this.#listeners.add(listener);
    try {
      listener(null);
    } catch {
      // Diagnostics observers never participate in terminal delivery.
    }
    if (this.enabled) this.#requestPublication();
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#enabled = false;
    this.#epoch += 1;
    this.#cancelScheduledWork();
    this.#resetFrameState();
    this.#aggregator.disable();
    this.#listeners.clear();
  }

  #requestPublication(): void {
    if (!this.enabled || this.#frameScheduled) return;
    this.#frameScheduled = true;
    const epoch = this.#epoch;
    this.#cancelFrame = this.#scheduleFrame((atMs) => {
      this.#cancelFrame = null;
      this.#frameScheduled = false;
      if (!this.enabled || epoch !== this.#epoch) return;
      this.#flushFrame(atMs);
    });
  }

  #flushFrame(atMs: number): void {
    const hadRender = this.#renderDirty;
    if (hadRender) {
      this.#lastObservedRenderAt = atMs;
      this.#aggregator.recordDirtyRows(this.#dirtyRows);
      if (this.#lastBrowserRenderAt !== null && atMs > this.#lastBrowserRenderAt) {
        const interval = atMs - this.#lastBrowserRenderAt;
        this.#aggregator.recordFrame(interval);
        this.#activeFps = 1_000 / interval;
      }
      this.#lastBrowserRenderAt = atMs;
      this.#renderDirty = false;
      this.#dirtyRows = 0;
      this.#armIdleRetirement();
    }

    const renderAt = this.#lastObservedRenderAt;
    const currentRenderSequence = this.#renderSequence;
    const retained: PendingPaint[] = [];
    for (const pending of this.#pendingPaints) {
      if (pending.cancelled || !this.#accepts(pending.epoch, pending.aggregator)) continue;
      if (
        pending.committed &&
        renderAt !== null &&
        currentRenderSequence > pending.startRenderSequence
      ) {
        pending.aggregator.recordPaint(Math.max(0, renderAt - pending.startedAt));
      } else {
        retained.push(pending);
      }
    }
    this.#pendingPaints = retained;
    this.#publish();
  }

  #armIdleRetirement(): void {
    this.#cancelIdle?.();
    const epoch = this.#epoch;
    this.#cancelIdle = this.#scheduleIdle(() => {
      this.#cancelIdle = null;
      if (!this.enabled || epoch !== this.#epoch) return;
      this.#activeFps = null;
      this.#lastBrowserRenderAt = null;
      this.#requestPublication();
    }, this.#activeIdleMs);
  }

  #accepts(epoch: number, aggregator: LocalPerformanceAggregator): boolean {
    return this.enabled && epoch === this.#epoch && aggregator === this.#aggregator;
  }

  #cancelScheduledWork(): void {
    this.#cancelFrame?.();
    this.#cancelFrame = null;
    this.#frameScheduled = false;
    this.#cancelIdle?.();
    this.#cancelIdle = null;
  }

  #resetFrameState(): void {
    this.#renderSequence = 0;
    this.#renderDirty = false;
    this.#dirtyRows = 0;
    this.#lastObservedRenderAt = null;
    this.#lastBrowserRenderAt = null;
    this.#activeFps = null;
    this.#pendingPaints = [];
  }

  #createAggregator(): LocalPerformanceAggregator {
    return new LocalPerformanceAggregator({
      source: "web",
      authority: this.#authority,
      ...(this.#sampleCapacity === undefined ? {} : { sampleCapacity: this.#sampleCapacity }),
    });
  }

  #publish(): void {
    if (this.#disposed) return;
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) {
      try {
        listener(snapshot);
      } catch {
        // Diagnostics observers never participate in terminal delivery.
      }
    }
  }
}

function sameAuthority(
  left: LocalPerformanceAuthorityV1,
  right: LocalPerformanceAuthorityV1,
): boolean {
  return (
    left.daemonInstanceId === right.daemonInstanceId &&
    left.workspaceName === right.workspaceName &&
    left.generation === right.generation &&
    left.incarnation === right.incarnation
  );
}
