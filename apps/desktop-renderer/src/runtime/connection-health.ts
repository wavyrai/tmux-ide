import type { DesktopDaemonTransportState } from "@tmux-ide/contracts";

/**
 * PURE derivation of connection health for renderer status displays.
 *
 * Transport health and data-sync health are independent axes: a healthy
 * socket with a failed read is "connected, sync error" — never a fake
 * reconnect — and a supervisor-owned reconnect is reported with its real
 * attempt state instead of being inferred from missing data. Every consumer
 * (application-shell store, catalog stores, fleet sidebar, workspace
 * unavailable surfaces) goes through this one shape so the wording and the
 * semantics cannot drift apart.
 */

export type DesktopConnectionHealth =
  /** Verified transport; data reads are trusted to be current. */
  | { readonly kind: "connected" }
  /** Verified transport, but the latest data read failed or is stale. */
  | { readonly kind: "connected-sync-degraded"; readonly reason: string }
  /** A socket exists but has not verified its daemon generation yet. */
  | { readonly kind: "connecting" }
  /** The supervisor owns a scheduled retry; nothing else may reconnect. */
  | {
      readonly kind: "reconnecting";
      readonly attempt: number;
      readonly maximumAttempts: number;
      readonly nextRetryAt: number;
      readonly reason: string;
    }
  /** The bounded retry budget is exhausted; only an explicit retry restarts it. */
  | { readonly kind: "stopped"; readonly reason: string }
  /** No transport is required or none has reported yet. */
  | { readonly kind: "unknown" };

export interface DataSyncHealth {
  /** Whether the most recent read of this resource family succeeded. */
  readonly ok: boolean;
  readonly reason?: string;
}

/** PURE — one honest compound state from independent transport and sync axes. */
export function deriveConnectionHealth(
  transport: DesktopDaemonTransportState | null,
  sync: DataSyncHealth,
): DesktopConnectionHealth {
  if (transport === null || transport.phase === "idle") return { kind: "unknown" };
  if (transport.phase === "connecting") return { kind: "connecting" };
  if (transport.phase === "connected") {
    return sync.ok
      ? { kind: "connected" }
      : {
          kind: "connected-sync-degraded",
          reason: sync.reason ?? "The latest workspace read failed.",
        };
  }
  if (transport.phase === "reconnecting") {
    return {
      kind: "reconnecting",
      attempt: transport.attempt,
      maximumAttempts: transport.maximumAttempts,
      nextRetryAt: transport.nextRetryAt,
      reason: transport.error.reason,
    };
  }
  if (transport.phase === "stopped") {
    return { kind: "stopped", reason: transport.error.reason };
  }
  // degraded: a fault was observed and the supervisor is deciding recovery.
  return {
    kind: "reconnecting",
    attempt: 0,
    maximumAttempts: 0,
    nextRetryAt: 0,
    reason: transport.error.reason,
  };
}

export interface ConnectionStatusStrip {
  readonly state: "connected" | "recovering" | "disconnected";
  readonly message: string;
  readonly safeState: string;
  readonly nextAction: string;
}

/**
 * PURE — the runtime status-strip presentation for a non-healthy derived
 * connection, or null when the projection's own connection segment should
 * render. This is the single place transport-versus-sync wording lives so a
 * failed subscription on a healthy socket reads "connected, sync degraded"
 * and never masquerades as a reconnect.
 */
export function statusStripFromConnectionHealth(
  health: DesktopConnectionHealth,
): ConnectionStatusStrip | null {
  switch (health.kind) {
    case "connected":
    case "unknown":
      return null;
    case "connecting":
      return {
        state: "recovering",
        message: "Connecting to the engine event stream",
        safeState: "Showing the last synced workspace",
        nextAction: "Waiting for the daemon hello",
      };
    case "connected-sync-degraded":
      return {
        state: "recovering",
        message: `Connected — sync degraded: ${health.reason}`,
        safeState: "Live events remain connected",
        nextAction: "Reload the workspace resource",
      };
    case "reconnecting":
      return {
        state: "recovering",
        message:
          health.attempt > 0
            ? `Reconnecting to the engine (attempt ${health.attempt} of ${health.maximumAttempts})`
            : `Reconnecting to the engine — ${health.reason}`,
        safeState: "Showing the last synced workspace",
        nextAction: "The connection supervisor is retrying automatically",
      };
    case "stopped":
      return {
        state: "disconnected",
        message: "Engine event reconnection attempts were exhausted",
        safeState: "Showing the last synced workspace",
        nextAction: "Recheck the daemon to reconnect",
      };
  }
}

/**
 * PURE — the status-display sentence for a supervisor transport state, used
 * verbatim as store `reason` text so stale/degraded notices report the real
 * retry position instead of a generic disconnect.
 */
export function transportStateReason(transport: DesktopDaemonTransportState): string | null {
  switch (transport.phase) {
    case "idle":
    case "connected":
      return null;
    case "connecting":
      return "Connecting to the engine event stream.";
    case "degraded":
      return `Engine event connection degraded — ${transport.error.reason}`;
    case "reconnecting":
      return `Reconnecting to the engine (attempt ${transport.attempt} of ${transport.maximumAttempts}).`;
    case "stopped":
      return "Engine event reconnection attempts were exhausted. Recheck the daemon to reconnect.";
  }
}
