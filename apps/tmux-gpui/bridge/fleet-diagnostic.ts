import type { FleetConnectionStatus } from "../../../packages/daemon-client/src/fleet-connection-status.ts";

export type NativeFleetDiagnostic = Pick<FleetConnectionStatus, "phase" | "failure">;

const phases = new Set<FleetConnectionStatus["phase"]>([
  "connecting",
  "ready",
  "reconnecting",
  "needs-attention",
  "disconnected",
]);
const failures = new Set<NonNullable<FleetConnectionStatus["failure"]>>([
  "unavailable",
  "identity-mismatch",
  "invalid-target",
  "invalid-descriptor",
  "incompatible",
  "ssh-authentication",
  "ssh-host-key",
  "remote-cli-missing",
  "daemon-missing",
]);

/** Presentation metadata only: never copy transport details or infer action authority. */
export function projectFleetDiagnostic(
  status: FleetConnectionStatus | undefined,
): NativeFleetDiagnostic | undefined {
  if (
    !status ||
    !phases.has(status.phase) ||
    (status.failure !== null && !failures.has(status.failure))
  )
    return undefined;
  return { phase: status.phase, failure: status.failure };
}
