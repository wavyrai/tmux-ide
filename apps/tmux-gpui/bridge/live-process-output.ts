import type { Writable } from "node:stream";
import { createSnapshotSerializer } from "./snapshot-wire.ts";
import { drainProcessOutput } from "./process-session-retirement.ts";
import type { HostedLiveEvent } from "./hosted-live-types.ts";

/** Process fallback framing only. Hosted sessions hand the same typed values directly to their host. */
export function createLiveProcessOutput(output: Writable, encoding: "legacy" | "rle-v1") {
  const snapshotJson = createSnapshotSerializer(encoding);
  let blocked = false,
    pending: string | null = null,
    orderedBytes = 0;
  const ordered: string[] = [];
  const maxOrderedBytes = 64 * 1024 * 1024;
  function serialize(event: HostedLiveEvent) {
    if (!("connection" in event) && "rawKittyImage" in event) {
      const { metadata, bytes } = event.rawKittyImage;
      return (
        JSON.stringify({
          kittyImageChunk: { ...metadata, data: Buffer.from(bytes).toString("base64") },
        }) + "\n"
      );
    }
    if (!("connection" in event)) return JSON.stringify(event) + "\n";
    const { snapshot, surfaces, ...fields } = event;
    const head = JSON.stringify(fields).slice(1, -1);
    const tail =
      ',"snapshot":' +
      snapshotJson(snapshot) +
      (surfaces
        ? ', "surfaces":[' +
          surfaces
            .map(
              (s) =>
                '{"paneId":' +
                JSON.stringify(s.paneId) +
                ',"snapshot":' +
                snapshotJson(s.snapshot) +
                "}",
            )
            .join(",") +
          "]"
        : "") +
      "}";
    return '{"surfaceBytes":' + Buffer.byteLength(tail) + "," + head + tail + "\n";
  }
  function flush() {
    blocked = false;
    while (ordered.length && !blocked) {
      const line = ordered.shift()!;
      orderedBytes -= Buffer.byteLength(line);
      blocked = !output.write(line);
    }
    if (blocked) return;
    if (pending) {
      const line = pending;
      pending = null;
      blocked = !output.write(line);
    }
  }
  output.on("drain", flush);
  return {
    emit(event: HostedLiveEvent) {
      const line = serialize(event),
        bytes = Buffer.byteLength(line);
      if (bytes > 8 * 1024 * 1024) throw Error("Preview frame too large");
      if (!blocked) {
        blocked = !output.write(line);
        return true;
      }
      if ("connection" in event) {
        pending = line;
        return true;
      }
      if (orderedBytes + bytes > maxOrderedBytes) return false;
      ordered.push(line);
      orderedBytes += bytes;
      return true;
    },
    drain: (signal: AbortSignal) => drainProcessOutput(output, () => blocked, signal),
    close() {
      output.off("drain", flush);
      ordered.length = 0;
      orderedBytes = 0;
      pending = null;
      if (!output.writableFinished) output.destroy();
    },
  };
}
