export interface PerformanceRecordSink {
  write(record: string): boolean;
}

/** Bounded backpressure policy for the opt-in lifecycle log. */
export class BoundedPerformanceRecordWriter {
  readonly #sink: PerformanceRecordSink;
  readonly #criticalLimit: number;
  readonly #pendingCritical = new Map<string, string>();
  #saturated = false;
  #failed = false;
  #droppedRecords = 0;

  constructor(sink: PerformanceRecordSink, criticalLimit = 16) {
    this.#sink = sink;
    this.#criticalLimit = criticalLimit;
  }

  write(record: string): boolean {
    if (this.#failed) return false;
    if (this.#saturated) {
      this.#droppedRecords += 1;
      return false;
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
    this.#pendingCritical.set(key, record);
    return true;
  }

  drain(): void {
    if (this.#failed) return;
    this.#saturated = false;
    for (const [key, record] of this.#pendingCritical) {
      this.#pendingCritical.delete(key);
      if (!this.#writeAccepted(record)) break;
    }
  }

  fail(): void {
    this.#failed = true;
    this.#pendingCritical.clear();
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
