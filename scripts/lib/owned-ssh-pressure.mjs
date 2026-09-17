/** Finite, content-free pressure source for the opt-in SSH fixture; not product diagnostics. */
export function createFinitePressureWriter(writable, options = {}) {
  const chunkBytes = options.chunkBytes ?? 64 * 1024;
  const limitBytes = options.limitBytes ?? 16 * 1024 * 1024;
  if (
    !Number.isSafeInteger(chunkBytes) ||
    chunkBytes < 1 ||
    chunkBytes > 64 * 1024 ||
    !Number.isSafeInteger(limitBytes) ||
    limitBytes < chunkBytes ||
    limitBytes > 16 * 1024 * 1024 ||
    limitBytes % chunkBytes !== 0
  )
    throw new Error("Invalid fixture pressure bound");
  const bytes = Buffer.alloc(chunkBytes, 0x78);
  let acceptedBytes = 0,
    queuePeakBytes = 0,
    drains = 0,
    blocked = false,
    retired = false;
  let finish;
  const closed = new Promise((resolve) => {
    finish = resolve;
  });
  const snapshot = () => ({
    acceptedBytes,
    limitBytes,
    chunkBytes,
    queuePeakBytes,
    queuedBytes: writable.writableLength,
    drains,
    blocked,
    retired,
    exhausted: acceptedBytes === limitBytes,
  });
  const retire = () => {
    if (retired) return;
    retired = true;
    blocked = false;
    writable.removeListener("drain", drain);
    writable.removeListener("close", retire);
    writable.removeListener("finish", retire);
    writable.removeListener("error", retire);
    finish();
  };
  const pump = () => {
    if (retired || writable.destroyed) {
      retire();
      return;
    }
    while (acceptedBytes < limitBytes) {
      acceptedBytes += chunkBytes;
      const ready = writable.write(bytes);
      queuePeakBytes = Math.max(queuePeakBytes, writable.writableLength);
      if (!ready) {
        blocked = true;
        return;
      }
    }
    writable.end();
  };
  const drain = () => {
    drains++;
    blocked = false;
    pump();
  };
  writable.on("drain", drain);
  writable.once("close", retire);
  writable.once("finish", retire);
  writable.once("error", retire);
  pump();
  return {
    snapshot,
    closed,
    dispose: () => {
      writable.destroy();
    },
  };
}
