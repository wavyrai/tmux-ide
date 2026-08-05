import {
  DesktopDaemonCapabilityStateSchemaZ,
  isDaemonWireProtocolCompatible,
  type DaemonInstanceIdentity,
  type DesktopDaemonCapabilityError,
  type DesktopDaemonEvent,
  type DesktopDaemonTransportState,
  type HostCapabilities,
} from "@tmux-ide/contracts";

import { transportStateReason } from "./connection-health.ts";
import type {
  GenerationBoundAdapter,
  GenerationBoundDisposition,
  GenerationBoundFailureSource,
  GenerationBoundFetchResult,
  GenerationBoundTargetValidation,
  GenerationBoundView,
} from "./generation-bound-store.ts";

/**
 * The half of the Pattern-A adapter shared by every catalog read that goes
 * through the reviewed {@link HostCapabilities} facade: daemon-identity target
 * validation, the `{ workspaceNames: [] }` subscription that receives the
 * workspace-agnostic invalidations, the capability-error disposition, and the
 * failure vocabulary. A caller adds only its fetch, its invalidation event
 * types, its wording, and its projector.
 */

export type DaemonCatalogFailure = DesktopDaemonCapabilityError;

export type DaemonCatalogView<TResource> = GenerationBoundView<
  DaemonInstanceIdentity,
  TResource,
  DaemonCatalogFailure
>;

/** Codes that a projector may publish as a terminal `degraded` state. */
export type DaemonCatalogTerminalCode = "daemon-identity-mismatch" | "invalid-response";

export interface DaemonCatalogWording {
  /** e.g. "Daemon fleet events are not connected." */
  readonly staleReason: string;
  /** e.g. "Daemon fleet events are unavailable." */
  readonly eventsUnavailable: string;
  /** e.g. "Daemon fleet event recovery attempts were exhausted." */
  readonly eventsExhausted: string;
  /** e.g. "Desktop host fleet catalog request failed." */
  readonly requestFailed: string;
  /** e.g. "Desktop host fleet event subscription failed." */
  readonly subscriptionFailed: string;
}

export interface DaemonCatalogAdapterOptions<TResource, TState> {
  readonly host: Pick<HostCapabilities, "daemon">;
  /** Event types that invalidate this catalog and force a refetch. */
  readonly invalidatesOn: readonly DesktopDaemonEvent["type"][];
  readonly wording: DaemonCatalogWording;
  fetch(
    daemon: DaemonInstanceIdentity,
  ): Promise<GenerationBoundFetchResult<TResource, DaemonCatalogFailure>>;
  project(view: DaemonCatalogView<TResource>): TState;
}

export function sameDaemonIdentity(
  left: DaemonInstanceIdentity | null,
  right: DaemonInstanceIdentity | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.protocolVersion === right.protocolVersion &&
    left.productVersion === right.productVersion &&
    left.instanceId === right.instanceId &&
    left.startedAt === right.startedAt
  );
}

export function daemonIdentityKey(daemon: DaemonInstanceIdentity): string {
  return [daemon.protocolVersion, daemon.productVersion, daemon.instanceId, daemon.startedAt].join(
    "\u0000",
  );
}

/** Narrow a fatal failure onto the two codes a catalog surface can publish. */
export function daemonCatalogTerminalCode(
  failure: DaemonCatalogFailure,
): DaemonCatalogTerminalCode {
  return failure.code === "daemon-identity-mismatch"
    ? "daemon-identity-mismatch"
    : "invalid-response";
}

function validateDaemonTarget(
  value: unknown,
): GenerationBoundTargetValidation<DaemonInstanceIdentity, DaemonCatalogFailure> {
  const parsed = DesktopDaemonCapabilityStateSchemaZ.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      failure: {
        code: "invalid-response",
        reason: "Desktop daemon capability state is invalid.",
      },
    };
  }
  if (parsed.data.status !== "connected") {
    return {
      ok: false,
      failure: {
        code: parsed.data.status === "degraded" ? "daemon-degraded" : "daemon-unavailable",
        reason: parsed.data.reason,
      },
    };
  }
  if (!isDaemonWireProtocolCompatible(parsed.data.identity.protocolVersion)) {
    return {
      ok: false,
      failure: { code: "invalid-response", reason: "Desktop daemon protocol is incompatible." },
    };
  }
  return {
    ok: true,
    target: parsed.data.identity,
    key: daemonIdentityKey(parsed.data.identity),
  };
}

function catalogDisposition(
  failure: DaemonCatalogFailure,
  source: GenerationBoundFailureSource,
): GenerationBoundDisposition {
  if (
    failure.code === "daemon-identity-mismatch" ||
    failure.code === "invalid-response" ||
    failure.code === "protocol-error"
  ) {
    // A differently stamped or malformed response poisons this generation's
    // authority; asking the same generation again on a timer cannot repair it.
    return "fatal";
  }
  if (source === "event") return "retry";
  return failure.code === "request-timeout" ||
    failure.code === "request-failed" ||
    failure.code === "event-unavailable"
    ? "retry"
    : "degrade";
}

export function createDaemonCatalogAdapter<TResource, TState>(
  options: DaemonCatalogAdapterOptions<TResource, TState>,
): GenerationBoundAdapter<DaemonInstanceIdentity, TResource, DaemonCatalogFailure, TState> {
  const invalidatesOn = new Set<DesktopDaemonEvent["type"]>(options.invalidatesOn);
  const { host, wording } = options;
  return {
    // The catalog target is pushed on every daemon-capability change, so
    // re-asserting the current generation IS the reconnect-driven refetch path.
    reassert: "refresh",
    validateTarget: validateDaemonTarget,
    fetch: (daemon) => options.fetch(daemon),
    connect: (_daemon, handlers) => {
      const listener = (event: DesktopDaemonEvent): void => {
        if (invalidatesOn.has(event.type)) {
          handlers.invalidate();
          return;
        }
        if (event.type === "transport.changed") {
          handlers.transportChanged(event.transport);
          return;
        }
        if (event.type !== "connection.changed") return;
        if (event.state === "live") {
          handlers.live();
          return;
        }
        handlers.failed(
          event.error ?? { code: "event-unavailable", reason: wording.eventsUnavailable },
        );
      };
      // The empty workspace set is the only subscription that receives the
      // workspace-agnostic invalidations.
      return host.daemon
        .subscribe({ workspaceNames: [] }, listener)
        .then((result) =>
          result.status === "subscribed"
            ? ({ status: "connected", close: result.unsubscribe } as const)
            : ({ status: "failed", failure: result.error } as const),
        );
    },
    disposition: catalogDisposition,
    rejectionFailure: (source) =>
      source === "request"
        ? { code: "request-failed", reason: wording.requestFailed }
        : { code: "event-unavailable", reason: wording.subscriptionFailed },
    transportFailure: (transport: DesktopDaemonTransportState) => ({
      code: "event-unavailable",
      reason: transportStateReason(transport) ?? wording.eventsUnavailable,
    }),
    eventExhaustedFailure: () => ({
      code: "event-unavailable",
      reason: wording.eventsExhausted,
    }),
    project: options.project,
  };
}
