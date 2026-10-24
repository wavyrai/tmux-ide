import { outputMarker } from "./renderer-probe.mjs";
export const OUTPUT_BYTES = 2 * 1024 * 1024;
// Fixed ASCII lines and bounded chunks; the final marker follows every output byte.
export function* outputChunks(nonce) {
  const marker = outputMarker(nonce);
  for (let first = 0; first < OUTPUT_BYTES / 128; first += 64) {
    let chunk = "";
    for (let row = first; row < first + 64; row++)
      chunk += `PROBE-BURST:${nonce}:${String(row).padStart(5, "0")} `.padEnd(126, ".") + "\r\n";
    yield chunk;
  }
  yield `\x1b[H\x1b[2K${marker}`;
}
export async function writeOutput(nonce, write) {
  for (const chunk of outputChunks(nonce)) await write(chunk);
}
