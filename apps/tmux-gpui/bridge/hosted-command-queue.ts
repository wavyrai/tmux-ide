/** Single consumer, bounded buffered commands and at most one blocked producer. No replay on close. */
export function createHostedCommandQueue(capacity = 64, maxBytes = 128 * 1024) {
  const queued: { value: unknown; bytes: number }[] = [];
  let bytes = 0,
    closed = false,
    ended = false;
  let waiting: ((value: IteratorResult<unknown>) => void) | undefined;
  let capacityWaiter: (() => void) | undefined;
  function own(value: unknown) {
    let nodes = 0;
    const validate = (entry: unknown, depth = 0): void => {
      if (++nodes > 10000 || depth > 20) throw Error("Invalid hosted command");
      if (entry === null || typeof entry === "boolean") return;
      if (typeof entry === "string") {
        if (Buffer.byteLength(entry) > maxBytes) throw Error("Hosted input capacity exceeded");
        return;
      }
      if (typeof entry === "number" && Number.isFinite(entry)) return;
      if (
        typeof entry !== "object" ||
        (!Array.isArray(entry) &&
          Object.getPrototypeOf(entry) !== Object.prototype &&
          Object.getPrototypeOf(entry) !== null)
      )
        throw Error("Invalid hosted command");
      for (const key of Reflect.ownKeys(entry)) {
        if (Array.isArray(entry) && key === "length") continue;
        const property = Object.getOwnPropertyDescriptor(entry, key)!;
        if (typeof key !== "string" || !("value" in property) || !property.enumerable)
          throw Error("Invalid hosted command");
        validate(property.value, depth + 1);
      }
    };
    validate(value);
    const text = JSON.stringify(value),
      count = Buffer.byteLength(text);
    if (count > maxBytes) throw Error("Hosted input capacity exceeded");
    return { value: JSON.parse(text) as unknown, bytes: count };
  }
  function fits(count: number) {
    return queued.length < capacity && bytes + count <= maxBytes;
  }
  function wake() {
    const notify = capacityWaiter;
    capacityWaiter = undefined;
    notify?.();
  }
  function enqueue(entry: { value: unknown; bytes: number }) {
    const { value, bytes: count } = entry;
    if (closed || ended) throw Error("Hosted input closed");
    if (count > maxBytes || !fits(count)) throw Error("Hosted input capacity exceeded");
    if (waiting) {
      const accept = waiting;
      waiting = undefined;
      accept({ value, done: false });
    } else {
      queued.push(entry);
      bytes += count;
    }
  }
  return {
    send(value: unknown) {
      enqueue(own(value));
    },
    async admit(value: unknown) {
      const entry = own(value),
        count = entry.bytes;
      if (count > maxBytes) throw Error("Hosted input capacity exceeded");
      while (!closed && !ended && !fits(count)) {
        if (capacityWaiter) throw Error("Concurrent hosted input admission");
        await new Promise<void>((resolve) => {
          capacityWaiter = resolve;
        });
      }
      enqueue(entry);
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
