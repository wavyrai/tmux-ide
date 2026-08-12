import type { LocalPerformanceAuthorityV1, LocalPerformanceSnapshotV1 } from "@tmux-ide/contracts";
import { LocalPerformanceAggregator } from "@tmux-ide/core";

export interface GuiPerformanceTelemetryOptions {
  readonly authority?: LocalPerformanceAuthorityV1;
  readonly now?: () => number;
  readonly sampleCapacity?: number;
  readonly scheduleFrame?: (callback: (atMs: number) => void) => () => void;
  readonly scheduleIdle?: (callback: () => void, delayMs: number) => () => void;
  readonly activeIdleMs?: number;
  readonly onChannelCountChanged?: (count: number) => void;
}

export interface GuiPerformancePaintTransaction {
  commit(): void;
  cancel(): void;
}

export interface GuiPerformanceRenderChannel {
  readonly id: number;
}

export interface GuiPerformanceTelemetrySink {
  readonly enabled: boolean;
  createRenderChannel(): GuiPerformanceRenderChannel;
  refreshRenderChannel(channel: GuiPerformanceRenderChannel): GuiPerformanceRenderChannel | null;
  retireRenderChannel(channel: GuiPerformanceRenderChannel): void;
  beginParse(): (() => void) | null;
  beginPaint(channel: GuiPerformanceRenderChannel | null): GuiPerformancePaintTransaction | null;
  commitDelivery(): void;
  recordRendered(channel: GuiPerformanceRenderChannel | null, dirtyRows: number): void;
  recordQueueDepth(current: number, capacity?: number | null): void;
  recordRevisionLag(lag: number): void;
  recordReseed(): void;
}

interface PendingPaint {
  readonly epoch: number;
  readonly aggregator: LocalPerformanceAggregator;
  readonly startedAt: number;
  readonly startRenderSequence: number;
  readonly channel: GuiPerformanceRenderChannel;
  committed: boolean;
  cancelled: boolean;
}

interface RenderChannelState {
  epoch: number;
  retired: boolean;
  renderSequence: number;
  lastObservedRenderAt: number | null;
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
  readonly #onChannelCountChanged: ((count: number) => void) | undefined;
  readonly #listeners = new Set<(snapshot: LocalPerformanceSnapshotV1 | null) => void>();
  #authority: LocalPerformanceAuthorityV1;
  #aggregator: LocalPerformanceAggregator;
  #enabled = false;
  #disposed = false;
  #epoch = 0;
  #frameScheduled = false;
  #cancelFrame: (() => void) | null = null;
  #cancelIdle: (() => void) | null = null;
  #renderDirty = false;
  #dirtyRows = 0;
  #lastBrowserRenderAt: number | null = null;
  #activeFps: number | null = null;
  #pendingPaints: PendingPaint[] = [];
  #nextChannelId = 1;
  readonly #channels = new Map<GuiPerformanceRenderChannel, RenderChannelState>();
  readonly #renderedChannels = new Set<GuiPerformanceRenderChannel>();

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
    this.#onChannelCountChanged = options.onChannelCountChanged;
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

  createRenderChannel(): GuiPerformanceRenderChannel {
    const channel = Object.freeze({ id: this.#nextChannelId++ });
    this.#channels.set(channel, {
      epoch: this.#epoch,
      retired: false,
      renderSequence: 0,
      lastObservedRenderAt: null,
    });
    this.#onChannelCountChanged?.(this.#channels.size);
    return channel;
  }

  refreshRenderChannel(channel: GuiPerformanceRenderChannel): GuiPerformanceRenderChannel | null {
    const state = this.#channels.get(channel);
    if (!state || state.retired) return null;
    if (state.epoch === this.#epoch) return channel;
    this.#channels.delete(channel);
    this.#onChannelCountChanged?.(this.#channels.size);
    return this.createRenderChannel();
  }

  retireRenderChannel(channel: GuiPerformanceRenderChannel): void {
    const state = this.#channels.get(channel);
    if (!state) return;
    this.#renderedChannels.delete(channel);
    this.#channels.delete(channel);
    this.#onChannelCountChanged?.(this.#channels.size);
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

  beginPaint(channel: GuiPerformanceRenderChannel | null): GuiPerformancePaintTransaction | null {
    if (!this.enabled || !channel) return null;
    const channelState = this.#activeChannel(channel);
    if (!channelState) return null;
    const pending: PendingPaint = {
      epoch: this.#epoch,
      aggregator: this.#aggregator,
      startedAt: this.#now(),
      startRenderSequence: channelState.renderSequence,
      channel,
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
  recordRendered(channel: GuiPerformanceRenderChannel | null, dirtyRows: number): void {
    if (!this.enabled || !channel) return;
    const state = this.#activeChannel(channel);
    if (!state) return;
    state.renderSequence += 1;
    this.#renderedChannels.add(channel);
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
      for (const channel of this.#renderedChannels) {
        const state = this.#activeChannel(channel);
        if (state) state.lastObservedRenderAt = atMs;
      }
      this.#renderedChannels.clear();
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

    const retained: PendingPaint[] = [];
    for (const pending of this.#pendingPaints) {
      if (pending.cancelled || !this.#accepts(pending.epoch, pending.aggregator)) continue;
      const channelState = this.#activeChannel(pending.channel);
      if (
        pending.committed &&
        channelState &&
        channelState.lastObservedRenderAt !== null &&
        channelState.renderSequence > pending.startRenderSequence
      ) {
        pending.aggregator.recordPaint(
          Math.max(0, channelState.lastObservedRenderAt - pending.startedAt),
        );
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

  #activeChannel(channel: GuiPerformanceRenderChannel): RenderChannelState | null {
    const state = this.#channels.get(channel);
    return state && !state.retired && state.epoch === this.#epoch ? state : null;
  }

  #cancelScheduledWork(): void {
    this.#cancelFrame?.();
    this.#cancelFrame = null;
    this.#frameScheduled = false;
    this.#cancelIdle?.();
    this.#cancelIdle = null;
  }

  #resetFrameState(): void {
    this.#renderDirty = false;
    this.#dirtyRows = 0;
    this.#lastBrowserRenderAt = null;
    this.#activeFps = null;
    this.#pendingPaints = [];
    this.#renderedChannels.clear();
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
