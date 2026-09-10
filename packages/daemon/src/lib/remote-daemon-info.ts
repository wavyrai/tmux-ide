import { type CanonicalDaemonInfo } from "@tmux-ide/contracts";
import {
  canonicalDaemonUrl,
  isCanonicalDaemonAlive,
  readCanonicalDaemonInfo,
} from "./canonical-daemon.ts";
import {
  probeSshDaemonIdentity,
  RemoteDaemonHandshakeSchema,
  RemoteDaemonHandshakeFailureSchema,
  type RemoteDaemonHandshake,
} from "./ssh-daemon-transport.ts";

class RemoteDaemonInfoError extends Error {
  constructor(
    message: string,
    readonly code: "daemon-missing" | "incompatible" | "unavailable",
  ) {
    super(message);
  }
}

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
    throw new RemoteDaemonInfoError(
      "No running tmux-ide daemon. Start tmux-ide on this machine first.",
      "daemon-missing",
    );
  const parsed = RemoteDaemonHandshakeSchema.safeParse({ version: 1, daemon: info });
  if (!parsed.success)
    throw new RemoteDaemonInfoError(
      "The daemon does not support authenticated SSH discovery.",
      "incompatible",
    );
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
    throw new RemoteDaemonInfoError(
      "Could not verify the running daemon's identity and owner authority.",
      "unavailable",
    );
  }
  return parsed.data;
}

/** Structured failure without stderr inference, credentials, or arbitrary error details. */
export async function readRemoteDaemonHandshakeResult(
  dependencies: Parameters<typeof readRemoteDaemonHandshake>[0] = {},
) {
  try {
    return await readRemoteDaemonHandshake(dependencies);
  } catch (error) {
    return RemoteDaemonHandshakeFailureSchema.parse({
      version: 1,
      error: { code: error instanceof RemoteDaemonInfoError ? error.code : "unavailable" },
    });
  }
}
