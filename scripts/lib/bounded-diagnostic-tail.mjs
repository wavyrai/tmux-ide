import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

export const DIAGNOSTIC_TAIL_MAX_BYTES = 64 * 1024;

function safeStatIdentity(stat) {
  return (
    stat?.isFile?.() === true &&
    Number.isSafeInteger(stat.dev) &&
    Number.isSafeInteger(stat.ino) &&
    Number.isSafeInteger(stat.size) &&
    stat.size >= 0
  );
}

/** No-follow, bounded tail read with an exact same-file/same-size fence. */
export function readBoundedDiagnosticTail(
  path,
  {
    maxBytes = DIAGNOSTIC_TAIL_MAX_BYTES,
    openFile = openSync,
    statFile = fstatSync,
    readFile = readSync,
    closeFile = closeSync,
    allocate = Buffer.alloc,
  } = {},
) {
  if (typeof path !== "string" || path.length === 0 || path.length > 4_096)
    return Object.freeze({ available: false, reason: "invalid-path", text: "", bytesRead: 0 });
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DIAGNOSTIC_TAIL_MAX_BYTES)
    throw new Error("diagnostic tail limit must be a bounded positive safe integer");
  let descriptor = null;
  try {
    descriptor = openFile(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = statFile(descriptor);
    if (!safeStatIdentity(before))
      return Object.freeze({ available: false, reason: "invalid-file", text: "", bytesRead: 0 });
    const length = Math.min(before.size, maxBytes);
    const start = before.size - length;
    const buffer = allocate(length);
    if (!Buffer.isBuffer(buffer) || buffer.byteLength !== length)
      throw new Error("diagnostic tail allocator returned an invalid buffer");
    let bytesRead = 0;
    while (bytesRead < length) {
      const count = readFile(descriptor, buffer, bytesRead, length - bytesRead, start + bytesRead);
      if (!Number.isSafeInteger(count) || count < 0 || count > length - bytesRead)
        throw new Error("diagnostic tail reader returned an invalid byte count");
      if (count === 0) break;
      bytesRead += count;
    }
    const after = statFile(descriptor);
    if (
      !safeStatIdentity(after) ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      bytesRead !== length
    )
      return Object.freeze({
        available: false,
        reason: "file-changed",
        text: "",
        bytesRead: 0,
      });
    return Object.freeze({
      available: true,
      reason: null,
      text: buffer.subarray(0, bytesRead).toString("utf8"),
      bytesRead,
      truncated: before.size > bytesRead,
    });
  } catch {
    return Object.freeze({ available: false, reason: "read-failed", text: "", bytesRead: 0 });
  } finally {
    if (descriptor !== null) {
      try {
        closeFile(descriptor);
      } catch {
        // Evidence stays unavailable; cleanup and the original failure remain authoritative.
      }
    }
  }
}
