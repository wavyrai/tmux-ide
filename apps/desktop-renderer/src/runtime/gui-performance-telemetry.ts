import type { LocalPerformanceAuthorityV1, LocalPerformanceSnapshotV1 } from "@tmux-ide/contracts";
import { LocalPerformanceAggregator } from "@tmux-ide/core";

export interface GuiPerformanceTelemetryOptions {
  readonly authority?: LocalPerformanceAuthorityV1;
  readonly now?: () => number;
  readonly sampleCapacity?: number;
  readonly scheduleIdle?: (callback: () => void, delayMs: number) => () => void;
  readonly activeIdleMs?: number;
}

export interface GuiPerformanceTelemetrySink {
  readonly enabled: boolean;
  beginParse(): (() => void) | null;
  beginPaint(dirtyRows?: number): (() => void) | null;
  commitDelivery(): void;
  recordRendered(dirtyRows: number): void;
  recordQueueDepth(current: number, capacity?: number | null): void;
  recordRevisionLag(lag: number): void;
  recordReseed(): void;
}

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
 * Demand-only browser metrics. There is deliberately no sampler here: real
 * terminal events advance the bounded aggregator and publish snapshots.
 */
export class GuiPerformanceTelemetry implements GuiPerformanceTelemetrySink {
  readonly #now: () => number;
  readonly #sampleCapacity: number | undefined;
  readonly #listeners = new Set<(snapshot: LocalPerformanceSnapshotV1 | null) => void>();
  readonly #scheduleIdle: (callback: () => void, delayMs: number) => () => void;
  readonly #activeIdleMs: number;
  #authority: LocalPerformanceAuthorityV1;
  #aggregator: LocalPerformanceAggregator;
  #enabled = false;
  #lastRenderAt: number | null = null;
  #disposed = false;
  #fpsActive = false;
  #cancelIdle: (() => void) | null = null;

  constructor(options: GuiPerformanceTelemetryOptions = {}) {
    this.#now = options.now ?? (() => performance.now());
    this.#sampleCapacity = options.sampleCapacity;
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
    this.#lastRenderAt = null;
    this.#fpsActive = false;
    this.#aggregator.enable();
    this.#publish();
  }

  disable(): void {
    if (this.#disposed || !this.#enabled) return;
    this.#enabled = false;
    this.#lastRenderAt = null;
    this.#fpsActive = false;
    this.#cancelIdle?.();
    this.#cancelIdle = null;
    this.#aggregator.disable();
    this.#publish();
  }

  setAuthority(authority: LocalPerformanceAuthorityV1): void {
    if (this.#disposed) return;
    if (
      authority.daemonInstanceId === this.#authority.daemonInstanceId &&
      authority.workspaceName === this.#authority.workspaceName &&
      authority.generation === this.#authority.generation &&
      authority.incarnation === this.#authority.incarnation
    ) {
      return;
    }
    const wasEnabled = this.#enabled;
    this.#aggregator.disable();
    this.#authority = authority;
    this.#aggregator = this.#createAggregator();
    if (wasEnabled) this.#aggregator.enable();
    this.#lastRenderAt = null;
    this.#fpsActive = false;
    this.#cancelIdle?.();
    this.#cancelIdle = null;
    this.#publish();
  }

  beginParse(): (() => void) | null {
    if (!this.enabled) return null;
    const startedAt = this.#now();
    let settled = false;
    return () => {
      if (settled || !this.enabled) return;
      settled = true;
      this.#aggregator.recordParse(Math.max(0, this.#now() - startedAt));
    };
  }

  beginPaint(dirtyRows?: number): (() => void) | null {
    if (!this.enabled) return null;
    const startedAt = this.#now();
    let settled = false;
    return () => {
      if (settled || !this.enabled) return;
      settled = true;
      const finishedAt = this.#now();
      this.#aggregator.recordPaint(Math.max(0, finishedAt - startedAt));
      if (dirtyRows !== undefined) this.#aggregator.recordDirtyRows(dirtyRows);
    };
  }

  commitDelivery(): void {
    if (!this.enabled) return;
    this.#publish();
  }

  /** One real xterm onRender opportunity; no animation frame is synthesized. */
  recordRendered(dirtyRows: number): void {
    if (!this.enabled) return;
    const renderedAt = this.#now();
    this.#aggregator.recordDirtyRows(dirtyRows);
    if (this.#lastRenderAt !== null && renderedAt > this.#lastRenderAt) {
      this.#aggregator.recordFrame(renderedAt - this.#lastRenderAt);
    }
    this.#lastRenderAt = renderedAt;
    this.#fpsActive = true;
    this.#cancelIdle?.();
    this.#cancelIdle = this.#scheduleIdle(() => {
      this.#cancelIdle = null;
      if (!this.enabled) return;
      this.#fpsActive = false;
      this.#publish();
    }, this.#activeIdleMs);
    this.#publish();
  }

  recordQueueDepth(current: number, capacity: number | null = null): void {
    if (!this.enabled) return;
    this.#aggregator.recordQueueDepth(current, capacity);
    this.#publish();
  }

  recordRevisionLag(lag: number): void {
    if (!this.enabled) return;
    this.#aggregator.recordRevisionLag(lag);
    this.#publish();
  }

  recordReseed(): void {
    if (!this.enabled) return;
    this.#aggregator.recordReseed();
    this.#publish();
  }

  snapshot(): LocalPerformanceSnapshotV1 | null {
    const snapshot = this.#aggregator.snapshot();
    return snapshot && !this.#fpsActive && snapshot.activeFps !== null
      ? Object.freeze({ ...snapshot, activeFps: null })
      : snapshot;
  }

  subscribe(listener: (snapshot: LocalPerformanceSnapshotV1 | null) => void): () => void {
    if (this.#disposed) return () => undefined;
    this.#listeners.add(listener);
    try {
      listener(this.snapshot());
    } catch {
      // Diagnostics observers never participate in terminal delivery.
    }
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#enabled = false;
    this.#cancelIdle?.();
    this.#cancelIdle = null;
    this.#aggregator.disable();
    this.#listeners.clear();
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
