/** Binary sniffing is shared by the critical Changes path and optional Files. */
export const BINARY_SNIFF_BYTES = 8000;

export function isBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}
