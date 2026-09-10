/** Credential-free diagnostics; transport errors themselves never enter a view model. */
export type FleetConnectionFailureCode =
  | "unavailable"
  | "invalid-target"
  | "invalid-descriptor"
  | "incompatible"
  | "daemon-missing";

export interface FleetConnectionStatus {
  readonly phase: "connecting" | "ready" | "reconnecting" | "needs-attention" | "disconnected";
  readonly attempt: number;
  readonly nextRetryAt: number | null;
  readonly failure: FleetConnectionFailureCode | null;
}

export function fleetConnectionMessage(status: FleetConnectionStatus): string {
  if (status.phase === "disconnected") return "Disconnected. Retry to connect.";
  switch (status.failure) {
    case "invalid-target":
      return "Check the SSH alias in this machine's settings.";
    case "incompatible":
      return "Incompatible daemon protocol. Update the remote daemon, then retry.";
    case "invalid-descriptor":
      return "Remote daemon discovery returned an invalid response. Check the installation.";
    case "daemon-missing":
      return "No running daemon. Start tmux-ide on this machine, then retry.";
    case "unavailable":
      return "Connection failed. Check reachability, SSH authentication and host trust.";
    default:
      return status.phase === "ready" ? "Connected" : "Connecting…";
  }
}
