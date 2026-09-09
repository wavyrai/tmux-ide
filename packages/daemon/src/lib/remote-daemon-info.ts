import { type CanonicalDaemonInfo } from "@tmux-ide/contracts";
import {
  canonicalDaemonUrl,
  isCanonicalDaemonAlive,
  readCanonicalDaemonInfo,
} from "./canonical-daemon.ts";
import {
  probeSshDaemonIdentity,
  RemoteDaemonHandshakeSchema,
  type RemoteDaemonHandshake,
} from "./ssh-daemon-transport.ts";

/** Credential-bearing SSH handshake. Never starts or replaces a daemon. */
export async function readRemoteDaemonHandshake(
  dependencies: {
    readInfo?: () => CanonicalDaemonInfo | null;
    isAlive?: (info: CanonicalDaemonInfo) => Promise<boolean>;
    request?: typeof fetch;
  } = {},
): Promise<RemoteDaemonHandshake> {
  const info = (dependencies.readInfo ?? readCanonicalDaemonInfo)();
  if (!info || !(await (dependencies.isAlive ?? isCanonicalDaemonAlive)(info)))
    throw new Error("No running tmux-ide daemon. Start tmux-ide on this machine first.");
  const parsed = RemoteDaemonHandshakeSchema.safeParse({ version: 1, daemon: info });
  if (!parsed.success) throw new Error("The daemon does not support authenticated SSH discovery.");
  try {
    if (
      !(await probeSshDaemonIdentity(
        canonicalDaemonUrl("http", info.bindHostname, info.port),
        parsed.data.daemon,
        AbortSignal.timeout(3_000),
        dependencies.request ?? fetch,
      ))
    )
      throw new Error("Identity changed");
  } catch {
    // Remote stderr may be displayed by an SSH client. Do not include response
    // bodies, request objects or credential-bearing schema failures.
    throw new Error("Could not verify the running daemon's identity and owner authority.");
  }
  return parsed.data;
}
