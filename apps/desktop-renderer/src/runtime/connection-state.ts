import type {
  ApplicationShellProjectionInputV1,
  DesktopApplicationShellTarget as DesktopApplicationShellTargetContract,
  DesktopDaemonTransportState,
} from "@tmux-ide/contracts";

export type DesktopApplicationShellTarget = DesktopApplicationShellTargetContract;

interface DesktopResourceStateBase {
  readonly generation: number;
  /** Null until an untrusted caller target has passed strict validation. */
  readonly target: DesktopApplicationShellTarget | null;
  /**
   * The supervisor-derived transport state when the host transport pushes one;
   * null before the first push and for transports that own their own socket.
   * Status displays derive from this instead of inferring connection health.
   */
  readonly transport?: DesktopDaemonTransportState | null;
}

export type DesktopApplicationShellResourceState =
  | (DesktopResourceStateBase & {
      readonly status: "loading";
      readonly data: null;
    })
  | (DesktopResourceStateBase & {
      readonly status: "live";
      readonly data: ApplicationShellProjectionInputV1;
      readonly updatedAt: number;
    })
  | (DesktopResourceStateBase & {
      readonly status: "unavailable";
      readonly data: null;
      readonly code: "not-found" | "disconnected" | "reconnect-exhausted";
      readonly reason: string;
    })
  | (DesktopResourceStateBase & {
      readonly status: "degraded";
      readonly data: ApplicationShellProjectionInputV1 | null;
      readonly updatedAt: number | null;
      readonly code:
        | "descriptor-invalid"
        | "daemon-identity-mismatch"
        | "schema-invalid"
        | "event-frame-invalid";
      readonly reason: string;
    })
  | (DesktopResourceStateBase & {
      readonly status: "error";
      readonly data: null;
      readonly code: "network-error" | "http-error";
      readonly reason: string;
    })
  | (DesktopResourceStateBase & {
      readonly status: "stale";
      readonly data: ApplicationShellProjectionInputV1;
      readonly updatedAt: number;
      readonly reason: string;
    })
  /** Published once to the observers disposal retires, then never again. */
  | (DesktopResourceStateBase & {
      readonly status: "disposed";
      readonly target: null;
      readonly data: null;
    });

export function daemonGenerationKey(target: DesktopApplicationShellTarget): string {
  const { daemon } = target;
  return [
    daemon.protocolVersion,
    daemon.productVersion,
    daemon.instanceId,
    daemon.startedAt,
    target.workspaceName,
  ].join("\u0000");
}
