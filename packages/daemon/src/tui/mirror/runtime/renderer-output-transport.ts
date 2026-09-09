import { writeSync } from "node:fs";
import { Writable } from "node:stream";
import { optimizeRendererFrame } from "./renderer-frame-optimizer.ts";

/**
 * A distinct Writable opts OpenTUI into its NativeSpanFeed backend. Each native
 * frame reaches this sink as one span, rather than using native stdout writes.
 * Redundant style transitions are removed without changing rendered cells.
 * A local TTY uses synchronous writes: Bun async stdout fragmented frames over
 * more event-loop turns in the wire probe. Other destinations retain callbacks.
 * This path is opt-in because a slow TTY can block the JS thread while writing.
 * The destination callback keeps that span alive until the terminal accepts it.
 * This preserves frame boundaries at the Writable layer, not OS-write atomicity.
 */
export function createRendererOutputTransport(destination: NodeJS.WriteStream = process.stdout): {
  stdout: NodeJS.WriteStream;
  dispose: () => void;
} {
  const write = destination.write.bind(destination);
  const stdout = new Writable({
    write(chunk: Buffer, encoding, callback) {
      const frame = optimizeRendererFrame(chunk);
      if (destination === process.stdout && destination.isTTY) {
        try {
          let offset = 0;
          while (offset < frame.length) {
            const written = writeSync(process.stdout.fd, frame, offset, frame.length - offset);
            if (written <= 0) throw new Error("Terminal output made no progress");
            offset += written;
          }
          callback();
        } catch (error) {
          callback(error as Error);
        }
      } else write(frame, encoding, callback);
    },
  });
  Object.defineProperties(stdout, {
    isTTY: { get: () => destination.isTTY },
    columns: { get: () => destination.columns },
    rows: { get: () => destination.rows },
  });
  const onResize = () => stdout.emit("resize");
  const onError = (error: Error) => stdout.destroy(error);
  destination.on("resize", onResize);
  destination.on("error", onError);

  return {
    stdout: stdout as NodeJS.WriteStream,
    // Do not end/destroy either stream here: renderer.destroy() can still have
    // shutdown spans queued for delivery. The destination belongs to the host.
    dispose() {
      destination.off("resize", onResize);
      destination.off("error", onError);
    },
  };
}
