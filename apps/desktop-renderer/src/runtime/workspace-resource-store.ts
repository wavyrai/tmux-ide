import {
  DesktopApplicationShellTargetSchemaZ,
  isDaemonWireProtocolCompatible,
  type DaemonInstanceIdentity,
  type DesktopApplicationShellTarget,
  type DesktopDaemonCapabilityErrorCode,
} from "@tmux-ide/contracts";

import { daemonGenerationKey } from "./connection-state.ts";

/**
 * Shared internals for the generation-bound Files and Changes read stores.
 *
 * Every store is pinned to a {@link DesktopApplicationShellTarget} — a semantic
 * workspace name plus a non-secret daemon generation. A target change bumps the
 * store generation, and any response that resolves against a superseded
 * generation is dropped rather than trusted. The daemon endpoint, owner
 * credential, and physical transport never cross into this layer: reads are
 * issued through the reviewed HostCapabilities facade and every response is
 * re-validated at the boundary before it reaches application code.
 */

export type WorkspaceResourceTarget = DesktopApplicationShellTarget;

export interface WorkspaceResourceClock {
  now(): number;
}

export const defaultWorkspaceResourceClock: WorkspaceResourceClock = {
  now: () => Date.now(),
};

/** A resolved daemon-stamped read, its typed unavailability, or a transport error. */
export type WorkspaceResourceSlot<TResource> =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly resource: TResource; readonly updatedAt: number }
  | {
      readonly status: "error";
      readonly code: DesktopDaemonCapabilityErrorCode;
      readonly reason: string;
    };

export type WorkspaceResourceTargetValidation =
  | { readonly ok: true; readonly target: WorkspaceResourceTarget; readonly key: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Strictly validate an untrusted store target. A path, credential, or
 * incompatible protocol is rejected here so it can never reach a request.
 */
export function validateWorkspaceResourceTarget(
  value: unknown,
): WorkspaceResourceTargetValidation {
  const parsed = DesktopApplicationShellTargetSchemaZ.safeParse(value);
  if (!parsed.success) {
    return { ok: false, reason: "Workspace resource target is invalid." };
  }
  if (!isDaemonWireProtocolCompatible(parsed.data.daemon.protocolVersion)) {
    return {
      ok: false,
      reason: `Daemon protocol ${parsed.data.daemon.protocolVersion} is not compatible with this renderer.`,
    };
  }
  return { ok: true, target: parsed.data, key: daemonGenerationKey(parsed.data) };
}

export function sameDaemonGeneration(
  expected: DaemonInstanceIdentity,
  actual: DaemonInstanceIdentity,
): boolean {
  return (
    actual.protocolVersion === expected.protocolVersion &&
    actual.productVersion === expected.productVersion &&
    actual.instanceId === expected.instanceId &&
    actual.startedAt === expected.startedAt
  );
}
