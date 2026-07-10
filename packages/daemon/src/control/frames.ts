/**
 * NDJSON framing for the control socket — PURE.
 *
 * One frame = one JSON object on one `\n`-terminated line. TCP-style streams
 * deliver arbitrary chunk boundaries, so the splitter buffers a partial
 * trailing line across feeds and hands back only COMPLETE lines. Encoding is
 * the trivial inverse; it lives here so every writer produces identical
 * frames (a `JSON.stringify` can never contain a raw newline, so one write
 * call per frame is atomic on the wire).
 */

/** Refuse to buffer a partial line beyond this — a client streaming an
 *  unterminated megabyte is broken or hostile, not slow. */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/** Serialize one frame: the JSON line plus its terminator. */
export function encodeFrame(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * A stateful chunk → complete-lines splitter. Feed it raw socket data; it
 * returns every COMPLETE line received so far (blank lines are dropped) and
 * keeps the trailing partial line buffered for the next feed. Throws when the
 * partial line outgrows {@link MAX_FRAME_BYTES} — the caller should drop the
 * connection.
 */
export function createFrameSplitter(): (chunk: string) => string[] {
  let buffer = "";
  return (chunk: string): string[] => {
    buffer += chunk;
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    if (buffer.length > MAX_FRAME_BYTES) {
      buffer = "";
      throw new Error(`frame exceeds ${MAX_FRAME_BYTES} bytes without a newline`);
    }
    return parts.filter((line) => line.trim().length > 0);
  };
}
