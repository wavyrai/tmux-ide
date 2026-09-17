/** Physical control-channel budget; independent from terminal replica flow control. */
export function createBoundedControlWriter(
  socket: {
    readonly bufferedAmount?: number;
    send(data: string, callback: (error?: Error) => void): void;
  },
  retire: () => void,
  limits = { entries: 256, bytes: 1024 * 1024, timeoutMs: 5000 },
) {
  const pending = new Map<symbol, { bytes: number; timer: ReturnType<typeof setTimeout> }>();
  let bytes = 0;
  let disposed = false;
  const dispose = () => {
    disposed = true;
    for (const item of pending.values()) clearTimeout(item.timer);
    pending.clear();
    bytes = 0;
  };
  const fail = () => {
    if (disposed) return;
    dispose();
    retire();
  };
  return {
    dispose,
    snapshot: () => ({ entries: pending.size, bytes, disposed }),
    send(data: string) {
      if (disposed) return;
      const size = Buffer.byteLength(data);
      if (
        pending.size >= limits.entries ||
        bytes + (socket.bufferedAmount ?? 0) + size > limits.bytes
      ) {
        fail();
        return;
      }
      const id = Symbol();
      const timer = setTimeout(fail, limits.timeoutMs);
      timer.unref?.();
      pending.set(id, { bytes: size, timer });
      bytes += size;
      try {
        socket.send(data, (error) => {
          const item = pending.get(id);
          if (!item) return;
          clearTimeout(item.timer);
          pending.delete(id);
          bytes -= item.bytes;
          if (error) fail();
        });
      } catch {
        fail();
      }
    },
  };
}
