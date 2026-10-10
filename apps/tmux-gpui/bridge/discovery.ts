import { randomUUID } from "node:crypto";
import {
  getCanonicalDaemonInfoPath,
  inspectCanonicalDaemonInfoPath,
  canonicalDaemonUrl,
} from "../../../packages/daemon/src/lib/canonical-daemon.ts";
import {
  DaemonIdentitySchema,
  DAEMON_WIRE_PROTOCOL_VERSION,
  isDaemonWireProtocolCompatible,
} from "../../../packages/contracts/src/index.ts";
import { listTmuxServers } from "../../../packages/daemon-client/src/tmux-server-client.ts";
import { hostSchema, type PreviewHost } from "./config.ts";

const discoveryMessages = Object.freeze({
  "no-daemon":
    "No usable local daemon was found. If tmux-ide is installed, run tmux-ide --headless in a terminal and keep it running, then Refresh sessions.",
  unavailable:
    "The local daemon could not be reached. Check the tmux-ide daemon, then Refresh sessions.",
  "no-server":
    "The daemon has no online tmux server. Open an ordinary tmux session, then Refresh sessions.",
  "multiple-servers":
    "Multiple tmux servers are online. Launch with an explicit private host file to select a server.",
  "identity-changed":
    "Local daemon identity changed. Refresh sessions to discover the current daemon.",
  "record-changed": "Local daemon record changed. Refresh sessions to discover the current daemon.",
});
/** Fixed guidance only: never interpolate private records, URLs or caught errors. */
export class DaemonDiscoveryError extends Error {
  constructor(readonly category: keyof typeof discoveryMessages) {
    super(discoveryMessages[category]);
    this.name = "DaemonDiscoveryError";
  }
}

/** Only numeric, validated protocol versions may cross the private-error boundary. */
export class DaemonCompatibilityError extends Error {
  constructor(protocolVersion: number) {
    if (!Number.isSafeInteger(protocolVersion) || protocolVersion <= 0)
      throw new Error("Invalid daemon protocol version");
    super(
      `Daemon protocol ${protocolVersion} is incompatible with this preview (requires ${DAEMON_WIRE_PROTOCOL_VERSION}). Update the daemon or preview, then refresh.`,
    );
    this.name = "DaemonCompatibilityError";
  }
}

/** Read-only discovery. Never bootstrap, repair, or replace a user's daemon. */
export async function discoverPreviewHost(
  path = getCanonicalDaemonInfoPath(),
  request: typeof fetch = fetch,
): Promise<PreviewHost> {
  const state = inspectCanonicalDaemonInfoPath(path);
  if (state.status !== "valid" || !state.info.authToken)
    throw new DaemonDiscoveryError("no-daemon");
  const info = state.info;
  // Validate loopback before even the credential-free probe.
  const baseUrl = hostSchema.shape.baseUrl.parse(
    canonicalDaemonUrl("http", info.bindHostname, info.port, "/"),
  );
  let response: Response;
  try {
    response = await request(new URL("/identity", baseUrl), {
      redirect: "error",
      signal: AbortSignal.timeout(2500),
    });
  } catch {
    throw new DaemonDiscoveryError("unavailable");
  }
  if (!response.ok) throw new DaemonDiscoveryError("unavailable");
  const identity = DaemonIdentitySchema.parse(await response.json());
  if (
    identity.instanceId !== info.instanceId ||
    identity.pid !== info.pid ||
    identity.startedAt !== info.startedAt ||
    identity.protocolVersion !== info.protocolVersion ||
    identity.environmentId !== info.environmentId
  )
    throw new DaemonDiscoveryError("identity-changed");
  if (!isDaemonWireProtocolCompatible(identity.protocolVersion))
    throw new DaemonCompatibilityError(identity.protocolVersion);
  const { servers } = await listTmuxServers({
    baseUrl,
    ownerToken: info.authToken!,
    hostClientId: `gpui-discovery:${randomUUID()}`,
    origin: "tmux-ide://app",
    fetch: request,
    timeoutMs: 2500,
  });
  const online = servers.filter((server) => server.state === "online");
  if (online.length === 0) throw new DaemonDiscoveryError("no-server");
  if (online.length > 1) throw new DaemonDiscoveryError("multiple-servers");
  const current = inspectCanonicalDaemonInfoPath(path);
  if (current.status !== "valid" || JSON.stringify(current.info) !== JSON.stringify(info))
    throw new DaemonDiscoveryError("record-changed");
  return hostSchema.parse({
    baseUrl,
    ownerToken: info.authToken,
    scope: { serverId: online[0]!.serverId, generation: online[0]!.generation },
  });
}
