/**
 * Coalesce an arbitrary event burst into at most one state publication per
 * renderer frame. The first event after an idle period flushes immediately;
 * sustained output is capped to the configured frame interval.
 *
 * This is intentionally independent of OpenTUI. Terminal output, mouse input,
 * and layout notifications can all request work without owning timers or
 * knowing how the renderer schedules frames.
 */
export interface FrameCoalescerClock {
  now(): number;
  schedule(run: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

const SYSTEM_CLOCK: FrameCoalescerClock = {
  now: () => performance.now(),
  schedule: (run, delayMs) => {
    if (delayMs <= 0) {
      const handle = { kind: "microtask" as const, cancelled: false };
      queueMicrotask(() => {
        if (!handle.cancelled) run();
      });
      return handle;
    }
    return setTimeout(run, delayMs);
  },
  cancel: (handle) => {
    if (
      typeof handle === "object" &&
      handle !== null &&
      "kind" in handle &&
      handle.kind === "microtask" &&
      "cancelled" in handle
    ) {
      handle.cancelled = true;
      return;
    }
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export class FrameCoalescer {
  private pending = false;
  private scheduled: unknown = null;
  private lastFlushAt = Number.NEGATIVE_INFINITY;
  private disposed = false;

  constructor(
    private readonly flush: () => void,
    private readonly frameIntervalMs = 1000 / 60,
    private readonly clock: FrameCoalescerClock = SYSTEM_CLOCK,
  ) {}

  request(): void {
    if (this.disposed) return;
    this.pending = true;
    if (this.scheduled !== null) return;
    const elapsed = this.clock.now() - this.lastFlushAt;
    const delay = Number.isFinite(elapsed) ? Math.max(0, this.frameIntervalMs - elapsed) : 0;
    this.scheduled = this.clock.schedule(() => this.run(), delay);
  }

  dispose(): void {
    this.disposed = true;
    this.pending = false;
    if (this.scheduled !== null) this.clock.cancel(this.scheduled);
    this.scheduled = null;
  }

  private run(): void {
    this.scheduled = null;
    if (this.disposed || !this.pending) return;
    this.pending = false;
    this.lastFlushAt = this.clock.now();
    this.flush();
  }
}
