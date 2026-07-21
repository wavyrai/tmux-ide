import {
  DesktopDaemonHostStateSchemaZ,
  isDaemonWireProtocolCompatible,
  type CanonicalDaemonInfo,
  type DaemonHealth,
  type DaemonIdentity,
  type DesktopDaemonHostState,
} from "@tmux-ide/contracts";
import {
  canonicalDaemonUrl,
  inspectCanonicalDaemonInfo,
  isCanonicalDaemonAlive,
  probeCanonicalDaemonHealth,
  probeCanonicalDaemonIdentity,
  type CanonicalDaemonInfoState,
} from "../../../packages/daemon/src/canonical.ts";

export interface DaemonPreflight {
  probe(signal: AbortSignal): Promise<DesktopDaemonHostState>;
}

export interface CanonicalDaemonAttachOperations {
  inspect(): CanonicalDaemonInfoState;
  isAlive(info: CanonicalDaemonInfo): Promise<boolean>;
  probeIdentity(info: CanonicalDaemonInfo): Promise<DaemonIdentity | null>;
  probeHealth(info: CanonicalDaemonInfo): Promise<DaemonHealth | null>;
  httpOrigin(info: CanonicalDaemonInfo): string;
}

const canonicalAttachOperations: CanonicalDaemonAttachOperations = {
  inspect: inspectCanonicalDaemonInfo,
  isAlive: isCanonicalDaemonAlive,
  probeIdentity: probeCanonicalDaemonIdentity,
  probeHealth: probeCanonicalDaemonHealth,
  httpOrigin: (info) => canonicalDaemonUrl("http", info.bindHostname, info.port),
};

function unavailable(
  code: Extract<DesktopDaemonHostState, { status: "unavailable" }>["code"],
  reason: string,
): DesktopDaemonHostState {
  return { status: "unavailable", code, reason };
}

function degraded(
  code: Extract<DesktopDaemonHostState, { status: "degraded" }>["code"],
  reason: string,
): DesktopDaemonHostState {
  return { status: "degraded", code, reason };
}

function probeWasAborted(signal: AbortSignal): DesktopDaemonHostState | null {
  return signal.aborted
    ? unavailable("probe-timeout", "Canonical daemon verification was cancelled.")
    : null;
}

function endpointIsLoopback(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]") &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  } catch {
    return false;
  }
}

export function createCanonicalDaemonPreflight(
  operations: CanonicalDaemonAttachOperations = canonicalAttachOperations,
): DaemonPreflight {
  return {
    probe: async (signal) => {
      const state = operations.inspect();
      if (state.status === "missing") {
        return unavailable("record-missing", "No running canonical tmux-ide daemon was found.");
      }
      if (state.status === "invalid") {
        return degraded(
          "record-invalid",
          `Canonical daemon record is not trustworthy (${state.reason}): ${state.detail}`,
        );
      }
      const { info } = state;
      if (!isDaemonWireProtocolCompatible(info.protocolVersion)) {
        return degraded(
          "protocol-incompatible",
          `Canonical daemon protocol ${info.protocolVersion} is not supported by this app.`,
        );
      }

      const apiBaseUrl = operations.httpOrigin(info);
      if (!endpointIsLoopback(apiBaseUrl)) {
        return degraded(
          "endpoint-not-loopback",
          "Canonical daemon endpoint did not resolve to a loopback HTTP origin.",
        );
      }
      const abortedBeforePid = probeWasAborted(signal);
      if (abortedBeforePid) return abortedBeforePid;
      if (!(await operations.isAlive(info))) {
        return unavailable("process-not-running", "Canonical daemon process is no longer running.");
      }

      const abortedBeforeIdentity = probeWasAborted(signal);
      if (abortedBeforeIdentity) return abortedBeforeIdentity;
      const identity = await operations.probeIdentity(info);
      if (!identity) {
        return unavailable(
          "identity-unreachable",
          "Canonical daemon identity endpoint could not be verified.",
        );
      }
      if (!isDaemonWireProtocolCompatible(identity.protocolVersion)) {
        return degraded(
          "protocol-incompatible",
          `Canonical daemon identity protocol ${identity.protocolVersion} is not supported by this app.`,
        );
      }
      if (
        identity.pid !== info.pid ||
        identity.protocolVersion !== info.protocolVersion ||
        identity.productVersion !== info.productVersion ||
        identity.instanceId !== info.instanceId ||
        identity.startedAt !== info.startedAt
      ) {
        return degraded(
          "identity-mismatch",
          "Canonical daemon identity does not match the securely discovered record.",
        );
      }

      const abortedBeforeHealth = probeWasAborted(signal);
      if (abortedBeforeHealth) return abortedBeforeHealth;
      const health = await operations.probeHealth(info);
      if (!health) {
        return unavailable(
          "health-unreachable",
          "Canonical daemon health endpoint is unreachable.",
        );
      }
      if (!isDaemonWireProtocolCompatible(health.protocolVersion)) {
        return degraded(
          "protocol-incompatible",
          `Canonical daemon health protocol ${health.protocolVersion} is not supported by this app.`,
        );
      }
      if (
        health.protocolVersion !== info.protocolVersion ||
        health.productVersion !== info.productVersion
      ) {
        return degraded(
          "health-mismatch",
          "Canonical daemon health metadata does not match its discovered identity.",
        );
      }

      return {
        status: "connected",
        descriptor: {
          apiBaseUrl,
          protocolVersion: info.protocolVersion,
          productVersion: info.productVersion,
          instanceId: info.instanceId,
          startedAt: info.startedAt,
        },
      };
    },
  };
}

export const canonicalDaemonPreflight = createCanonicalDaemonPreflight();

export async function runDaemonPreflight(
  preflight: DaemonPreflight,
  timeoutMs = 2_500,
): Promise<DesktopDaemonHostState> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<DesktopDaemonHostState>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve(unavailable("probe-timeout", `Daemon preflight timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    timeout.unref?.();
  });

  try {
    const result = await Promise.race([
      preflight
        .probe(controller.signal)
        .catch((error: unknown) =>
          unavailable(
            "probe-failed",
            error instanceof Error ? error.message : "Daemon preflight failed.",
          ),
        ),
      deadline,
    ]);
    return DesktopDaemonHostStateSchemaZ.parse(result);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
