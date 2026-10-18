import { registerVerifiedVersion } from "./diagnostic-versions.ts";
import { canonicalDaemonUrl } from "../../../packages/daemon/src/lib/canonical-daemon.ts";
import { randomUUID } from "node:crypto";
import type { createDaemonConnectionOwner } from "../../../packages/daemon/src/lib/daemon-connection-owner.ts";
import {
  probeSshDaemonIdentity,
  RemoteDaemonHandshakeSchema,
} from "../../../packages/daemon/src/lib/ssh-daemon-transport.ts";
import { listTmuxServers } from "../../../packages/daemon-client/src/tmux-server-client.ts";
import {
  isDaemonWireProtocolCompatible,
  TmuxServerScopeSchemaZ,
  type TmuxServerScope,
} from "../../../packages/contracts/src/index.ts";
import { hostSchema, type PreviewHost } from "./config.ts";

type Owner = Pick<
  ReturnType<typeof createDaemonConnectionOwner>,
  "endpoint" | "observeConnection" | "observe"
>;
const messages = {
  unavailable: "Machine connection is unavailable. Reconnect the machine and try again.",
  retired: "Machine connection changed. Select the machine again.",
  identity: "Machine identity could not be verified. Reconnect the machine.",
  incompatible: "Machine daemon is incompatible with this preview. Update the remote daemon.",
  "no-server": "The machine has no online tmux server. Open a tmux session and refresh.",
  "multiple-servers": "The machine has multiple online tmux servers. Select a server explicitly.",
  "server-changed":
    "The selected tmux server is no longer available. Refresh and select the session again.",
} as const;

/** Only fixed guidance crosses the native bridge; transport/parser errors may contain secrets. */
export class RemoteRouteError extends Error {
  constructor(readonly category: keyof typeof messages) {
    super(messages[category]);
    this.name = "RemoteRouteError";
  }
}

export interface RemotePreviewRoute {
  readonly host: PreviewHost;
  readonly signal: AbortSignal;
  assertCurrent(): void;
  verify(): Promise<void>;
  dispose(): void;
}

/**
 * A route borrows a single connection epoch. It never owns the SSH transport and
 * cannot mint local-editor provenance. Callers must dispose their catalog/child
 * when signal aborts, and dispose this route when navigation retires it.
 */
export async function createRemotePreviewRoute(
  owner: Owner,
  options: {
    request?: typeof fetch;
    signal?: AbortSignal;
    scope?: TmuxServerScope;
    diagnostic?: (
      reason:
        | "transport-state"
        | "connection-epoch"
        | "remote-identity"
        | "forward-address"
        | "identity-probe",
    ) => void;
  } = {},
): Promise<RemotePreviewRoute> {
  const parsedScope =
    options.scope === undefined ? null : TmuxServerScopeSchemaZ.safeParse(options.scope);
  if (parsedScope && !parsedScope.success) throw new RemoteRouteError("server-changed");
  const scope = parsedScope?.data;
  const diagnostic = (reason: Parameters<NonNullable<typeof options.diagnostic>>[0]) => {
    try {
      options.diagnostic?.(reason);
    } catch {
      /* Diagnostics cannot change retirement. */
    }
  };
  const parentSignal = options.signal;
  const fetchRequest = options.request ?? fetch;
  const captured = owner.endpoint();
  if (captured.kind !== "ssh" || captured.state !== "ready" || !captured.remote)
    throw new RemoteRouteError("unavailable");
  const controller = new AbortController();
  let unsubscribe = () => {};
  const dispose = () => {
    controller.abort();
    unsubscribe();
    parentSignal?.removeEventListener("abort", dispose);
  };
  const assertCurrent = () => {
    const next = owner.endpoint();
    if (
      controller.signal.aborted ||
      parentSignal?.aborted ||
      next.kind !== "ssh" ||
      next.state !== "ready" ||
      next.epoch !== captured.epoch ||
      next.remote !== captured.remote ||
      next.localBaseUrl !== captured.localBaseUrl
    ) {
      if (!controller.signal.aborted && !parentSignal?.aborted) {
        const reason =
          next.state !== "ready"
            ? "transport-state"
            : next.epoch !== captured.epoch
              ? "connection-epoch"
              : next.remote !== captured.remote
                ? "remote-identity"
                : "forward-address";
        diagnostic(reason);
      }
      dispose();
      throw new RemoteRouteError("retired");
    }
  };
  const changed = () => {
    try {
      assertCurrent();
    } catch {
      /* Retirement is published through signal. */
    }
  };
  unsubscribe = owner.observeConnection(changed);
  parentSignal?.addEventListener("abort", dispose, { once: true });
  try {
    // Generation retirement precedes reconnect status updates.
    const removeGeneration = await owner.observe(changed);
    const removeStatus = unsubscribe;
    unsubscribe = () => {
      removeGeneration();
      removeStatus();
    };
    assertCurrent();
    const parsed = RemoteDaemonHandshakeSchema.safeParse({ version: 1, daemon: captured.remote });
    const address = hostSchema.shape.baseUrl.safeParse(captured.localBaseUrl);
    if (!parsed.success || !address.success) throw new RemoteRouteError("unavailable");
    const daemon = parsed.data.daemon;
    const baseUrl = address.data.replace(/\/$/, "");
    if (!isDaemonWireProtocolCompatible(daemon.protocolVersion))
      throw new RemoteRouteError("incompatible");
    const request: typeof fetch = async (url, init) => {
      assertCurrent();
      const response = await fetchRequest(url, {
        ...init,
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(2500),
          ...(init?.signal ? [init.signal] : []),
        ]),
      });
      assertCurrent();
      return response;
    };
    const verify = async () => {
      try {
        assertCurrent();
        if (!(await probeSshDaemonIdentity(baseUrl, daemon, controller.signal, request)))
          throw new RemoteRouteError("identity");
        assertCurrent();
      } catch (error) {
        if (!controller.signal.aborted && !parentSignal?.aborted) diagnostic("identity-probe");
        dispose();
        if (error instanceof RemoteRouteError) throw error;
        throw new RemoteRouteError("unavailable");
      }
    };
    await verify();
    const { servers } = await listTmuxServers({
      baseUrl,
      ownerToken: daemon.authToken,
      hostClientId: `gpui-remote:${randomUUID()}`,
      origin: "tmux-ide://app",
      fetch: request,
      timeoutMs: 2500,
    });
    assertCurrent();
    const online = servers.filter((server) => server.state === "online");
    const matches = scope
      ? online.filter(
          (server) => server.serverId === scope.serverId && server.generation === scope.generation,
        )
      : online;
    if (scope && matches.length !== 1) throw new RemoteRouteError("server-changed");
    if (!scope && online.length !== 1)
      throw new RemoteRouteError(online.length ? "multiple-servers" : "no-server");
    const remoteSocketOrigin = new URL(canonicalDaemonUrl("ws", daemon.bindHostname, daemon.port))
      .origin;
    const host = hostSchema.parse({
      baseUrl,
      remoteSocketOrigin,
      ownerToken: daemon.authToken,
      scope: { serverId: matches[0]!.serverId, generation: matches[0]!.generation },
    });
    registerVerifiedVersion(host, daemon.productVersion, assertCurrent);
    Object.freeze(host.scope);
    Object.freeze(host);
    return { host, signal: controller.signal, assertCurrent, verify, dispose };
  } catch (error) {
    dispose();
    if (error instanceof RemoteRouteError) throw error;
    throw new RemoteRouteError("unavailable");
  }
}
