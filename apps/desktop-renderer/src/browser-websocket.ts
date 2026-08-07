/**
 * Browser JavaScript may initiate WebSocket closure with only 1000 or an
 * application code in 3000..4999. Protocol/status codes such as 1008 are valid
 * when received from the peer, but passing them to `WebSocket.close()` throws
 * `InvalidAccessError` and prevents cleanup. Preserve the useful suffix in the
 * private-use range for local diagnostics.
 */
export function browserInitiatedWebSocketCloseCode(code: number | undefined): number | undefined {
  if (code === undefined || code === 1000 || (code >= 3000 && code <= 4999)) return code;
  if (Number.isInteger(code) && code >= 1001 && code <= 1999) return code + 3000;
  return 4000;
}
