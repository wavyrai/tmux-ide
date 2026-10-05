export interface PerformanceRecordSink {
  write(record: string): boolean;
}

/** Bounded backpressure policy for the opt-in lifecycle log. */
export class BoundedPerformanceRecordWriter {
  readonly #sink: PerformanceRecordSink;
  readonly #criticalLimit: number;
  readonly #pendingCritical = new Set<string>();
  readonly #pending: { record: string; bytes: number; key?: string }[] = [];
  readonly #pendingByteLimit: number;
  #pendingBytes = 0;
  #flushPromise: Promise<void> | null = null;
  #resolveFlush: (() => void) | null = null;
  #saturated = false;
  #failed = false;
  #droppedRecords = 0;

  constructor(sink: PerformanceRecordSink, criticalLimit = 16, pendingByteLimit = 64 * 1024) {
    this.#sink = sink;
    this.#criticalLimit = criticalLimit;
    this.#pendingByteLimit = pendingByteLimit;
  }

  write(record: string): boolean {
    if (this.#failed) return false;
    if (this.#saturated) {
      return this.#enqueue(record);
    }
    return this.#writeAccepted(record);
  }

  writeCritical(key: string, record: string): boolean {
    if (this.#failed) return false;
    if (this.#pendingCritical.has(key)) return true;
    if (!this.#saturated) return this.#writeAccepted(record);
    if (this.#pendingCritical.size >= this.#criticalLimit) {
      this.#droppedRecords += 1;
      return false;
    }
    return this.#enqueue(record, key);
  }

  drain(): void {
    if (this.#failed) return;
    this.#saturated = false;
    while (this.#pending.length > 0 && !this.#saturated && !this.#failed) {
      const next = this.#pending.shift()!;
      this.#pendingBytes -= next.bytes;
      if (next.key !== undefined) this.#pendingCritical.delete(next.key);
      this.#writeAccepted(next.record);
    }
    if (this.#pending.length === 0) this.#finishFlush();
  }

  /** Wait until retained records reach the stream; its owner then flushes/end()s it. */
  flush(): Promise<void> {
    if (this.#failed || this.#pending.length === 0) return Promise.resolve();
    this.#flushPromise ??= new Promise((resolve) => {
      this.#resolveFlush = resolve;
    });
    return this.#flushPromise;
  }

  fail(): void {
    this.#failed = true;
    this.#pendingCritical.clear();
    this.#pending.length = 0;
    this.#pendingBytes = 0;
    this.#finishFlush();
  }

  #enqueue(record: string, key?: string): boolean {
    const bytes = Buffer.byteLength(record);
    // Ordinary bursts get one extra stream-sized buffer. Critical records have
    // a separate byte reserve as well as their existing key-count limit.
    const limit = this.#pendingByteLimit + (key === undefined ? 0 : 64 * 1024);
    if (this.#pending.length >= 1024 || this.#pendingBytes + bytes > limit) {
      this.#droppedRecords += 1;
      return false;
    }
    if (key !== undefined) this.#pendingCritical.add(key);
    this.#pending.push({ record, bytes, ...(key === undefined ? {} : { key }) });
    this.#pendingBytes += bytes;
    return true;
  }

  #finishFlush(): void {
    this.#resolveFlush?.();
    this.#resolveFlush = null;
    this.#flushPromise = null;
  }

  diagnostics(): Readonly<{
    droppedRecords: number;
    failed: boolean;
    pendingCriticalRecords: number;
  }> {
    return Object.freeze({
      droppedRecords: this.#droppedRecords,
      failed: this.#failed,
      pendingCriticalRecords: this.#pendingCritical.size,
    });
  }

  #writeAccepted(record: string): boolean {
    try {
      this.#saturated = !this.#sink.write(record);
      return true;
    } catch {
      this.fail();
      return false;
    }
  }
}
