/** Bounded best-effort process logging. The event loop never waits for disk writes. */
import { close, closeSync, constants, fstatSync, ftruncate, openSync, write } from "node:fs";
export function createBoundedDevelopmentLog(
  path: string,
  options: {
    limitBytes?: number;
    queueBytes?: number;
    write?: (fd: number, data: Buffer) => Promise<number>;
  } = {},
) {
  const limit = options.limitBytes ?? 1024 * 1024;
  const capacity = options.queueBytes ?? 64 * 1024;
  const fd = openSync(
    path,
    constants.O_CREAT |
      constants.O_APPEND |
      constants.O_WRONLY |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
    0o600,
  );
  const stat = fstatSync(fd);
  if (
    !stat.isFile() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    stat.nlink !== 1
  ) {
    closeSync(fd);
    throw new Error("Unsafe development log");
  }
  let size = stat.size;
  let bytes = 0;
  let droppedBytes = 0;
  let failed = false;
  let accepting = true;
  let flight: Promise<void> | null = null;
  const queue: Buffer[] = [];
  const append =
    options.write ??
    ((fd, data) =>
      new Promise<number>((resolve, reject) =>
        write(fd, data, (error, written) => (error ? reject(error) : resolve(written))),
      ));
  const drain = async () => {
    try {
      while (queue.length) {
        const data = queue[0]!;
        if (size + data.length > limit) {
          await new Promise<void>((resolve, reject) =>
            ftruncate(fd, 0, (error) => (error ? reject(error) : resolve())),
          );
          size = 0;
        }
        let offset = 0;
        while (offset < data.length) {
          const count = await append(fd, data.subarray(offset));
          if (count <= 0) throw new Error("Log write made no progress");
          offset += count;
          size += count;
        }
        queue.shift();
        bytes -= data.length;
      }
    } catch {
      failed = true;
      queue.length = 0;
      bytes = 0;
    }
  };
  const begin = () => {
    if (flight) return;
    flight = drain().finally(() => {
      flight = null;
      if (queue.length && !failed) begin();
    });
  };
  return {
    write(chunk: string | Uint8Array) {
      if (!accepting || failed) return;
      const chunkLimit = Math.min(8192, capacity, limit);
      const data =
        typeof chunk === "string"
          ? Buffer.from(chunk.slice(-chunkLimit))
          : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      const trimmed = data.subarray(Math.max(0, data.length - chunkLimit));
      droppedBytes += Math.max(
        0,
        (typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength) - trimmed.length,
      );
      if (queue.length >= 128 || bytes + trimmed.length > capacity) {
        droppedBytes += trimmed.length;
        return;
      }
      const notice = droppedBytes
        ? Buffer.from(`[development log dropped ${droppedBytes} bytes]\n`)
        : null;
      if (notice && queue.length < 127 && bytes + notice.length + trimmed.length <= capacity) {
        queue.push(notice);
        bytes += notice.length;
        droppedBytes = 0;
      }
      queue.push(Buffer.from(trimmed));
      bytes += trimmed.length;
      begin();
    },
    snapshot: () => ({ queuedBytes: bytes, queuedEntries: queue.length, droppedBytes, failed }),
    async close() {
      accepting = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const closing = (flight ?? Promise.resolve()).then(
        () => new Promise<void>((resolve) => close(fd, () => resolve())),
      );
      await Promise.race([
        closing,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 1000);
        }),
      ]);
      if (timer) clearTimeout(timer);
    },
  };
}
