/** Credential-free diagnostics; transport errors themselves never enter a view model. */
export type FleetConnectionFailureCode =
  | "unavailable"
  | "identity-mismatch"
  | "invalid-target"
  | "invalid-descriptor"
  | "incompatible"
  | "ssh-authentication"
  | "ssh-host-key"
  | "remote-cli-missing"
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
    case "identity-mismatch":
      return "This SSH route reached a different environment. Review the imported machine identity.";
    case "invalid-target":
      return "Check the SSH alias in this machine's settings.";
    case "incompatible":
      return "Incompatible daemon protocol. Update the remote daemon, then retry.";
    case "invalid-descriptor":
      return "Remote daemon discovery returned an invalid response. Check the installation.";
    case "daemon-missing":
      return "No running daemon. Retrying automatically; start tmux-ide on this machine if needed.";
    case "ssh-authentication":
      return "SSH authentication failed. Check the machine's SSH credentials, then retry.";
    case "ssh-host-key":
      return "SSH host key verification failed. Verify the host in your terminal, then retry.";
    case "remote-cli-missing":
      return "Remote tmux-ide command not found. Check its installation and non-interactive SSH PATH.";
    case "unavailable":
      return "Connection failed. Check reachability, SSH authentication and host trust.";
    default:
      return status.phase === "ready" ? "Connected" : "Connecting…";
  }
}
