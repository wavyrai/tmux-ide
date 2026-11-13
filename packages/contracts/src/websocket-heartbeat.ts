/**
 * Liveness of long-lived daemon WebSockets (pane streams, /ws/events).
 *
 * The daemon sends protocol-level pings; every compliant client answers them
 * without knowing about this contract, so old clients are unaffected. The
 * daemon advertises the cadence in a response header of the upgrade (HTTP
 * 101), not in a frame: frame schemas are strict on both sides and an unknown
 * field would break a released client. A client that sees the header may
 * treat silence longer than `intervalMs * missedLimit` as a dead connection;
 * without the header the daemon does not ping and no such deadline is safe.
 */
export const WEBSOCKET_HEARTBEAT_HEADER = "x-tmux-ide-heartbeat";
export const WEBSOCKET_HEARTBEAT_INTERVAL_MS = 10_000;
export const WEBSOCKET_HEARTBEAT_MISSED_LIMIT = 3;
export const WEBSOCKET_HEARTBEAT_MIN_INTERVAL_MS = 250;
export const WEBSOCKET_HEARTBEAT_MAX_INTERVAL_MS = 60_000;

export interface WebSocketHeartbeatPolicy {
  readonly intervalMs: number;
  readonly missedLimit: number;
}

export function formatWebSocketHeartbeatHeader(policy: WebSocketHeartbeatPolicy): string {
  return `interval-ms=${policy.intervalMs}, missed-limit=${policy.missedLimit}`;
}

/** Returns null for an absent or malformed header: then no idle deadline applies. */
export function parseWebSocketHeartbeatHeader(
  value: string | null | undefined,
): WebSocketHeartbeatPolicy | null {
  const match = /^interval-ms=([1-9][0-9]{0,6}), missed-limit=([1-9][0-9]?)$/u.exec(value ?? "");
  if (!match) return null;
  const intervalMs = Number(match[1]);
  const missedLimit = Number(match[2]);
  if (
    intervalMs < WEBSOCKET_HEARTBEAT_MIN_INTERVAL_MS ||
    intervalMs > WEBSOCKET_HEARTBEAT_MAX_INTERVAL_MS
  )
    return null;
  return { intervalMs, missedLimit };
}
