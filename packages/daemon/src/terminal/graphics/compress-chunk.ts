import { deflate } from "node:zlib";
import {
  encodeTerminalGraphicsCompressed,
  TERMINAL_GRAPHICS_BLOB_CHUNK_BYTES,
  type TerminalGraphicsBinaryHeader,
} from "@tmux-ide/contracts";

// Across panes, windows and connections: no queued compression backlog and at
// most two chunk inputs/outputs retained by libuv. Never compress on the JS loop.
let active = 0;
// Prefer flat-color UI chunks. A bounded, spread-out sample avoids spending a
// libuv job on noisy frames. False negatives only choose the raw fallback.
function likelyCompressible(bytes: Uint8Array): boolean {
  const counts = new Uint16Array(256);
  const samples = 4096;
  for (let i = 0; i < samples; i++) {
    const value = bytes[Math.floor((i * (bytes.length - 1)) / (samples - 1))]!;
    if (++counts[value]! >= samples / 32) return true;
  }
  return false;
}
export async function compressGraphicsChunk(
  header: TerminalGraphicsBinaryHeader,
  bytes: Uint8Array,
): Promise<Uint8Array | null> {
  if (
    active >= 2 ||
    bytes.length < 4096 ||
    bytes.length > TERMINAL_GRAPHICS_BLOB_CHUNK_BYTES ||
    (header.blob.format !== "rgb" && header.blob.format !== "rgba")
  )
    return null;
  if (!likelyCompressible(bytes)) return null;
  active++;
  try {
    const encoded = await new Promise<Buffer | null>((resolve) => {
      deflate(bytes, { level: 1 }, (error, result) => resolve(error ? null : result));
    });
    // Savings must cover metadata and be material; incompressible images retain
    // the original binary path. PNG/producer-zlib are never recompressed.
    if (!encoded || encoded.length + 128 > bytes.length * 0.875) return null;
    return encodeTerminalGraphicsCompressed(
      { ...header, compression: "zlib", decodedBytes: bytes.length },
      encoded,
    );
  } finally {
    active--;
  }
}
