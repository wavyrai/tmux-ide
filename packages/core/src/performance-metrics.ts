import {
  LocalPerformanceAuthorityV1SchemaZ,
  LocalPerformanceSnapshotV1SchemaZ,
  LocalPerformanceSourceSchemaZ,
  type LocalPerformanceAuthorityV1,
  type LocalPerformanceDistributionV1,
  type LocalPerformanceSnapshotV1,
  type LocalPerformanceSource,
} from "@tmux-ide/contracts";

import { deterministicPercentile } from "./performance-qualification.ts";

export const DEFAULT_LOCAL_PERFORMANCE_SAMPLE_CAPACITY = 120;
export const MAX_LOCAL_PERFORMANCE_SAMPLE_CAPACITY = 10_000;

export interface LocalPerformanceAggregatorOptions {
  readonly source: LocalPerformanceSource;
  readonly authority: LocalPerformanceAuthorityV1;
  readonly sampleCapacity?: number;
}

/**
 * Explicitly activated, fixed-memory local HUD metrics.
 *
 * Disabled record calls return before validation, clock reads, allocation, or
 * mutation. Hosts own event timing and call these methods only with durations
 * finalized inside their own monotonic clock domain.
 */
export class LocalPerformanceAggregator {
  readonly #source: LocalPerformanceSource;
  readonly #authority: LocalPerformanceAuthorityV1;
  readonly #sampleCapacity: number;
  #enabled = false;
  #sampleSequence = 0;
  #activeFps: number | null = null;
  #dirtyRows: FixedSampleWindow | null = null;
  #parseMs: FixedSampleWindow | null = null;
  #paintMs: FixedSampleWindow | null = null;
  #queueCurrent = 0;
  #queuePeak = 0;
  #queueCapacityCurrent: number | null = null;
  #queueCapacityPeak: number | null = null;
  #queueCapacityComplete = true;
  #revisionLagCurrent: number | null = null;
  #revisionLagPeak: number | null = null;
  #reseeds = 0;

  constructor(options: LocalPerformanceAggregatorOptions) {
    this.#source = LocalPerformanceSourceSchemaZ.parse(options.source);
    this.#authority = LocalPerformanceAuthorityV1SchemaZ.parse(options.authority);
    const capacity = options.sampleCapacity ?? DEFAULT_LOCAL_PERFORMANCE_SAMPLE_CAPACITY;
    if (
      !Number.isSafeInteger(capacity) ||
      capacity <= 0 ||
      capacity > MAX_LOCAL_PERFORMANCE_SAMPLE_CAPACITY
    )
      throw new TypeError(
        `sample capacity must be an integer in [1, ${MAX_LOCAL_PERFORMANCE_SAMPLE_CAPACITY}]`,
      );
    this.#sampleCapacity = capacity;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /** A false-to-true activation begins with empty metrics and retains sequence monotonicity. */
  enable(): boolean {
    if (this.#enabled) return false;
    this.#dirtyRows = new FixedSampleWindow(this.#sampleCapacity);
    this.#parseMs = new FixedSampleWindow(this.#sampleCapacity);
    this.#paintMs = new FixedSampleWindow(this.#sampleCapacity);
    this.#resetScalars();
    this.#enabled = true;
    return true;
  }

  /** Deactivation releases sample storage; subsequent record paths are immediate no-ops. */
  disable(): boolean {
    if (!this.#enabled) return false;
    this.#enabled = false;
    this.#dirtyRows = null;
    this.#parseMs = null;
    this.#paintMs = null;
    this.#resetScalars();
    return true;
  }

  recordFrame(frameIntervalMs: number): void {
    if (!this.#enabled) return;
    assertFinitePositive(frameIntervalMs, "frame interval");
    const fps = 1_000 / frameIntervalMs;
    if (!Number.isFinite(fps))
      throw new TypeError("frame interval is too small to derive a finite frame rate");
    this.#activeFps = fps;
    this.#advanceSequence();
  }

  recordDirtyRows(rows: number): void {
    if (!this.#enabled) return;
    assertSafeNonNegativeInteger(rows, "dirty rows");
    this.#dirtyRows!.push(rows);
    this.#advanceSequence();
  }

  recordParse(durationMs: number): void {
    if (!this.#enabled) return;
    assertFiniteNonNegative(durationMs, "parse duration");
    this.#parseMs!.push(durationMs);
    this.#advanceSequence();
  }

  recordPaint(durationMs: number): void {
    if (!this.#enabled) return;
    assertFiniteNonNegative(durationMs, "paint duration");
    this.#paintMs!.push(durationMs);
    this.#advanceSequence();
  }

  recordQueueDepth(current: number, capacity: number | null = null): void {
    if (!this.#enabled) return;
    assertSafeNonNegativeInteger(current, "queue depth");
    if (capacity !== null) {
      assertSafeNonNegativeInteger(capacity, "queue capacity");
      if (current > capacity) throw new RangeError("queue depth cannot exceed capacity");
    }
    this.#queueCurrent = current;
    this.#queuePeak = Math.max(this.#queuePeak, current);
    this.#queueCapacityCurrent = capacity;
    if (capacity === null) {
      this.#queueCapacityComplete = false;
      this.#queueCapacityPeak = null;
    } else if (this.#queueCapacityComplete) {
      this.#queueCapacityPeak = Math.max(this.#queueCapacityPeak ?? 0, capacity);
    }
    this.#advanceSequence();
  }

  recordRevisionLag(lag: number): void {
    if (!this.#enabled) return;
    assertSafeNonNegativeInteger(lag, "revision lag");
    this.#revisionLagCurrent = lag;
    this.#revisionLagPeak = Math.max(this.#revisionLagPeak ?? 0, lag);
    this.#advanceSequence();
  }

  recordReseed(): void {
    if (!this.#enabled) return;
    this.#reseeds += 1;
    this.#advanceSequence();
  }

  /** Allocates and validates an immutable view only when diagnostics are active and requested. */
  snapshot(): LocalPerformanceSnapshotV1 | null {
    if (!this.#enabled) return null;
    return LocalPerformanceSnapshotV1SchemaZ.parse({
      version: 1,
      source: this.#source,
      sampleSequence: this.#sampleSequence,
      authority: this.#authority,
      activeFps: this.#activeFps,
      dirtyRows: this.#dirtyRows!.summary(),
      parseMs: this.#parseMs!.summary(),
      paintMs: this.#paintMs!.summary(),
      queueDepth: {
        current: this.#queueCurrent,
        peak: this.#queuePeak,
        capacity: {
          current: this.#queueCapacityCurrent,
          peak: this.#queueCapacityComplete ? this.#queueCapacityPeak : null,
        },
      },
      revisionLag: { current: this.#revisionLagCurrent, peak: this.#revisionLagPeak },
      reseeds: this.#reseeds,
    });
  }

  #advanceSequence(): void {
    if (this.#sampleSequence === Number.MAX_SAFE_INTEGER)
      throw new RangeError("performance sample sequence exhausted");
    this.#sampleSequence += 1;
  }

  #resetScalars(): void {
    this.#activeFps = null;
    this.#queueCurrent = 0;
    this.#queuePeak = 0;
    this.#queueCapacityCurrent = null;
    this.#queueCapacityPeak = null;
    this.#queueCapacityComplete = true;
    this.#revisionLagCurrent = null;
    this.#revisionLagPeak = null;
    this.#reseeds = 0;
  }
}

class FixedSampleWindow {
  readonly #samples: Float64Array;
  #count = 0;
  #cursor = 0;
  #latest: number | null = null;

  constructor(capacity: number) {
    this.#samples = new Float64Array(capacity);
  }

  push(value: number): void {
    this.#samples[this.#cursor] = value;
    this.#cursor = (this.#cursor + 1) % this.#samples.length;
    this.#count = Math.min(this.#count + 1, this.#samples.length);
    this.#latest = value;
  }

  summary(): LocalPerformanceDistributionV1 {
    if (this.#count === 0)
      return Object.freeze({ count: 0, latest: null, p50: null, p95: null, max: null });
    const values = Array.from(this.#samples.subarray(0, this.#count));
    return Object.freeze({
      count: this.#count,
      latest: this.#latest,
      p50: deterministicPercentile(values, 0.5),
      p95: deterministicPercentile(values, 0.95),
      max: deterministicPercentile(values, 1),
    });
  }
}

function assertFinitePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0)
    throw new TypeError(`${label} must be finite and positive`);
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0)
    throw new TypeError(`${label} must be finite and non-negative`);
}

function assertSafeNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`${label} must be a safe non-negative integer`);
}
