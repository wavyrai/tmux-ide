import {
  DesktopApplicationShellTargetSchemaZ,
  isDaemonWireProtocolCompatible,
  type DaemonInstanceIdentity,
  type DesktopDaemonCapabilityError,
  type DesktopDaemonEvent,
  type HostCapabilities,
} from "@tmux-ide/contracts";

import type { DesktopApplicationShellTarget } from "./connection-state.ts";
import {
  DaemonTransportError,
  type DaemonEventConnection,
  type DaemonEventHandlers,
  type DesktopDaemonTransport,
} from "./daemon-transport.ts";

function sameDaemonGeneration(
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

function validateTarget(value: unknown): DesktopApplicationShellTarget {
  const parsed = DesktopApplicationShellTargetSchemaZ.safeParse(value);
  if (!parsed.success || !isDaemonWireProtocolCompatible(parsed.data.daemon.protocolVersion)) {
    throw new DaemonTransportError(
      "descriptor-invalid",
      "Desktop host application-shell target is invalid or incompatible.",
    );
  }
  return parsed.data;
}

function transportError(error: DesktopDaemonCapabilityError): DaemonTransportError {
  switch (error.code) {
    case "workspace-not-found":
      return new DaemonTransportError("not-found", error.reason, 404);
    case "invalid-request":
      return new DaemonTransportError("descriptor-invalid", error.reason);
    case "daemon-identity-mismatch":
      return new DaemonTransportError("daemon-identity-mismatch", error.reason);
    case "invalid-response":
    case "response-too-large":
      return new DaemonTransportError("schema-invalid", error.reason);
    default:
      return new DaemonTransportError("network-error", error.reason);
  }
}

function aborted(): Error {
  const error = new Error("Desktop daemon resource request was aborted.");
  error.name = "AbortError";
  return error;
}

function eventToHandler(
  event: DesktopDaemonEvent,
  workspaceName: string,
  handlers: DaemonEventHandlers,
): void {
  if (event.type === "workspaces.changed") {
    handlers.onInvalidate();
    return;
  }
  if (event.type === "application-shell.changed") {
    if (event.workspaceName === workspaceName) handlers.onInvalidate();
    return;
  }
  if (event.state === "live") {
    handlers.onVerifiedOpen();
    return;
  }
  if (event.error?.code === "daemon-identity-mismatch") {
    handlers.onPeerMismatch(event.error.reason);
    return;
  }
  if (event.error?.code === "invalid-response" || event.error?.code === "response-too-large") {
    handlers.onMalformedFrame(event.error.reason);
    return;
  }
  if (event.error?.code === "event-unavailable") {
    handlers.onClose();
    return;
  }
  if (event.error?.code === "protocol-error") {
    handlers.onProtocolError(event.error.reason);
    return;
  }
  handlers.onError(event.error?.reason ?? "Desktop daemon event connection degraded.");
}

/**
 * Production renderer adapter. It delegates every resource operation to the
 * reviewed HostCapabilities facade and therefore never constructs a URL,
 * request header, daemon credential, raw session target, or physical socket.
 */
export function createHostDaemonTransport(
  host: Pick<HostCapabilities, "daemon">,
): DesktopDaemonTransport {
  return {
    validateTarget,

    async fetchApplicationShell(target, signal) {
      const safeTarget = validateTarget(target);
      if (signal.aborted) throw aborted();
      const request = host.daemon.fetchApplicationShell({
        workspaceName: safeTarget.workspaceName,
      });
      let rejectAborted: (() => void) | undefined;
      const abortRequest = new Promise<never>((_resolve, reject) => {
        rejectAborted = () => reject(aborted());
        signal.addEventListener("abort", rejectAborted, { once: true });
      });
      let result: Awaited<typeof request>;
      try {
        result = await Promise.race([request, abortRequest]);
      } finally {
        if (rejectAborted) signal.removeEventListener("abort", rejectAborted);
      }
      if (result.status === "error") throw transportError(result.error);
      if (!sameDaemonGeneration(safeTarget.daemon, result.envelope.daemon)) {
        throw new DaemonTransportError(
          "daemon-identity-mismatch",
          "Desktop host returned a resource from another daemon generation.",
        );
      }
      return result.envelope.resource;
    },

    connectEvents(target, handlers): DaemonEventConnection {
      const safeTarget = validateTarget(target);
      let closed = false;
      let unsubscribe: (() => void) | null = null;
      void host.daemon
        .subscribe({ workspaceNames: [safeTarget.workspaceName] }, (event) => {
          if (!closed) eventToHandler(event, safeTarget.workspaceName, handlers);
        })
        .then((result) => {
          if (result.status === "error") {
            if (!closed) handlers.onError(result.error.reason);
            return;
          }
          if (closed) result.unsubscribe();
          else unsubscribe = result.unsubscribe;
        })
        .catch(() => {
          if (!closed) handlers.onError("Desktop host event subscription failed.");
        });
      return {
        close: () => {
          if (closed) return;
          closed = true;
          unsubscribe?.();
          unsubscribe = null;
        },
      };
    },
  };
}
