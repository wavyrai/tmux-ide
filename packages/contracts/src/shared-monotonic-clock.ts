/**
 * Reads the host monotonic counter used by libuv/Bun's Node compatibility
 * layer. The numerical epoch is deliberately not trusted across processes;
 * callers must calibrate it with a bounded round trip before comparing it.
 */
export function sharedMonotonicMicros(): number {
  const processLike = (
    globalThis as typeof globalThis & {
      process?: { hrtime?: { bigint?: () => bigint } };
    }
  ).process;
  const now = processLike?.hrtime?.bigint?.();
  if (typeof now !== "bigint") throw new Error("A monotonic bigint clock is unavailable");
  const micros = Number(now / 1_000n);
  if (!Number.isSafeInteger(micros) || micros < 0)
    throw new Error("The monotonic clock exceeded the supported range");
  return micros;
}
