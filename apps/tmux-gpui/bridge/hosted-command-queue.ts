/** Single consumer, bounded buffered commands and at most one blocked producer. No replay on close. */
export function createHostedCommandQueue(capacity = 64, maxBytes = 128 * 1024) {
  const queued: { value: unknown; bytes: number }[] = [];
  let bytes = 0,
    closed = false,
    ended = false;
  let waiting: ((value: IteratorResult<unknown>) => void) | undefined;
  let capacityWaiter: (() => void) | undefined;
  function size(value: unknown) {
    const text = JSON.stringify(value);
    if (text === undefined) throw Error("Invalid hosted command");
    return Buffer.byteLength(text);
  }
  function fits(count: number) {
    return queued.length < capacity && bytes + count <= maxBytes;
  }
  function wake() {
    const notify = capacityWaiter;
    capacityWaiter = undefined;
    notify?.();
  }
  function send(value: unknown) {
    if (closed || ended) throw Error("Hosted input closed");
    const count = size(value);
    if (count > maxBytes || !fits(count)) throw Error("Hosted input capacity exceeded");
    if (waiting) {
      const accept = waiting;
      waiting = undefined;
      accept({ value, done: false });
    } else {
      queued.push({ value, bytes: count });
      bytes += count;
    }
  }
  return {
    send,
    async admit(value: unknown) {
      const count = size(value);
      if (count > maxBytes) throw Error("Hosted input capacity exceeded");
      while (!closed && !ended && !fits(count)) {
        if (capacityWaiter) throw Error("Concurrent hosted input admission");
        await new Promise<void>((resolve) => {
          capacityWaiter = resolve;
        });
      }
      send(value);
    },
    end() {
      ended = true;
      wake();
      if (!queued.length) {
        waiting?.({ value: undefined, done: true });
        waiting = undefined;
      }
    },
    close() {
      closed = true;
      queued.length = 0;
      bytes = 0;
      wake();
      waiting?.({ value: undefined, done: true });
      waiting = undefined;
    },
    get pendingBytes() {
      return bytes;
    },
    async *[Symbol.asyncIterator]() {
      while (!closed) {
        const next = queued.shift();
        if (next) {
          bytes -= next.bytes;
          wake();
          yield next.value;
          continue;
        }
        if (ended) return;
        const result = await new Promise<IteratorResult<unknown>>((resolve) => {
          waiting = resolve;
        });
        if (result.done || closed) return;
        yield result.value;
      }
    },
  };
}
