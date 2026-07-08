/**
 * AckWriter — ack-paced, coalescing writes into an async sink (M21.5).
 *
 * xterm-headless's `write()` is asynchronous: bytes queue in its WriteBuffer
 * and parse on its own schedule, with a completion callback per write. Feeding
 * every control-mode `%output` chunk straight in piles up unbounded entries in
 * that internal queue during a flood. This writer paces instead: chunks
 * arriving while a write is in flight buffer HERE, and the completion callback
 * triggers exactly one follow-up write of everything buffered, joined. At most
 * ONE sink write is ever outstanding, order and content are preserved
 * byte-for-byte, and the caller (the control-channel reader loop) never waits.
 *
 * Pure core: the sink is injected (`term.write(data, done)` in production, a
 * recording stub in tests); no timers, no io.
 */
export class AckWriter {
  private queue: Uint8Array[] = [];
  private inFlight = false;

  /** `onAck` fires after EACH sink write completes — i.e. when those bytes are
   *  actually visible in the sink (parsed, for xterm). Consumers that gate
   *  rendering on "content changed" must re-arm on this, not on enqueue: with
   *  pacing, an enqueue-time signal can be consumed before the parse lands and
   *  the final frame would never render. */
  constructor(
    private readonly sink: (data: Uint8Array, done: () => void) => void,
    private readonly onAck?: () => void,
  ) {}

  /** Enqueue bytes; writes through immediately when the sink is idle. */
  write(data: Uint8Array): void {
    if (data.length === 0) return;
    this.queue.push(data);
    this.pump();
  }

  /** Bytes buffered here awaiting the in-flight write's ack (tests only). */
  pendingBytes(): number {
    let n = 0;
    for (const c of this.queue) n += c.length;
    return n;
  }

  /** A sink write is currently outstanding (tests only). */
  busy(): boolean {
    return this.inFlight;
  }

  private pump(): void {
    if (this.inFlight || this.queue.length === 0) return;
    const chunks = this.queue;
    this.queue = [];
    const data = chunks.length === 1 ? chunks[0]! : concatBytes(chunks);
    this.inFlight = true;
    let acked = false;
    this.sink(data, () => {
      if (acked) return; // a double-fired callback must not unleash overlap
      acked = true;
      this.inFlight = false;
      this.onAck?.();
      this.pump();
    });
  }
}

/** Join byte chunks into one contiguous array (exported for tests). */
export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
