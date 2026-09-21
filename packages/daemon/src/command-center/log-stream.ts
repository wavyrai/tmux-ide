import type { LogEntry } from "../lib/log.ts";
interface Frame {
  event: string;
  data: string;
}
interface Stream {
  readonly aborted?: boolean;
  writeSSE(frame: Frame): Promise<unknown>;
  onAbort(listener: () => void): void;
  abort(): void;
}
/** One bounded queue including backfill and the currently blocked write. */
export async function streamBoundedLogs(
  stream: Stream,
  options: {
    backfill: () => readonly LogEntry[];
    subscribe: (listener: (entry: LogEntry) => void) => () => void;
    match: (entry: LogEntry) => boolean;
    entries?: number;
    bytes?: number;
    writeTimeoutMs?: number;
  },
): Promise<void> {
  const maxEntries = options.entries ?? 256;
  const maxBytes = options.bytes ?? 1024 * 1024;
  const queue: Array<{ frame: Frame; bytes: number }> = [];
  let bytes = 0;
  let closed = false;
  let wake: (() => void) | null = null;
  let unsubscribe = () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelWrite: (() => void) | null = null;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    queue.length = 0;
    bytes = 0;
    if (timer) clearTimeout(timer);
    timer = null;
    wake?.();
    wake = null;
    cancelWrite?.();
    cancelWrite = null;
  };
  const abort = () => {
    cleanup();
    stream.abort();
  };
  stream.onAbort(cleanup);
  if (stream.aborted) cleanup();
  if (closed) return;
  const push = (frame: Frame): boolean => {
    const size = Buffer.byteLength(frame.data) + Buffer.byteLength(frame.event) + 32;
    if (queue.length >= maxEntries || bytes + size > maxBytes) return false;
    queue.push({ frame, bytes: size });
    bytes += size;
    wake?.();
    wake = null;
    return true;
  };
  unsubscribe = options.subscribe((entry) => {
    if (!closed && options.match(entry) && !push({ event: "entry", data: JSON.stringify(entry) }))
      abort();
  });
  if (closed) {
    unsubscribe();
    return;
  }
  try {
    // Keep newest bounded history, reserving room for gap/bookmark metadata.
    const retained: Frame[] = [];
    let retainedBytes = 0;
    let gap = false;
    {
      const history = options.backfill();
      for (let index = history.length - 1; index >= 0; index--) {
        if (!options.match(history[index]!)) continue;
        const frame = { event: "entry", data: JSON.stringify(history[index]) };
        const size = Buffer.byteLength(frame.data) + 37;
        if (retained.length >= maxEntries - 2 || retainedBytes + size > maxBytes - 256) {
          gap = true;
          break;
        }
        retained.unshift(frame);
        retainedBytes += size;
      }
    }
    if (gap && !push({ event: "gap", data: "backfill-truncated" })) {
      abort();
      return;
    }
    for (const frame of retained)
      if (!push(frame)) {
        abort();
        return;
      }
    retained.length = 0;
    if (
      !push({
        event: "bookmark",
        data: String(queue.filter((item) => item.frame.event === "entry").length),
      })
    ) {
      abort();
      return;
    }
    while (!closed) {
      const item = queue[0];
      if (!item) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      const cancelled = new Promise<void>((resolve) => {
        cancelWrite = resolve;
      });
      timer = setTimeout(abort, options.writeTimeoutMs ?? 5000);
      timer.unref?.();
      await Promise.race([Promise.resolve().then(() => stream.writeSSE(item.frame)), cancelled]);
      if (timer) clearTimeout(timer);
      timer = null;
      cancelWrite = null;
      if (!closed) {
        queue.shift();
        bytes -= item.bytes;
      }
    }
  } finally {
    cleanup();
  }
}
