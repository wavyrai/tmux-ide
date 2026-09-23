import { realpathSync, statSync } from "node:fs";
import { isNamedSocketAuthorityUnbound } from "./tmux-named-socket-fence.ts";
import type { WorkspacePaneTmuxAuthority } from "./workspace-pane-creation.ts";
import { createHash } from "node:crypto";
import {
  captureUnixSocketIdentity,
  revalidateUnixSocketIdentity,
} from "./unix-socket-authority.ts";

export interface TmuxServerProof {
  readonly version: 1;
  readonly kind: "live" | "unbound-name";
  readonly digest: string;
}

/** Two read-only, no-start queries fence the socket and server incarnation. */
export function captureTmuxServerProof(
  run: (args: readonly string[]) => string,
): TmuxServerProof | null {
  const args = ["-N", "display-message", "-p", "#{socket_path}|#{pid}|#{start_time}"];
  try {
    const raw = run(args).trimEnd();
    const match = /^(.*)\|([1-9][0-9]*)\|([1-9][0-9]*)$/u.exec(raw);
    if (!match || raw.length > 8192) return null;
    const socket = captureUnixSocketIdentity(match[1]!);
    if (run(args).trimEnd() !== raw) return null;
    revalidateUnixSocketIdentity(socket);
    return {
      version: 1,
      kind: "live",
      digest: createHash("sha256")
        .update(JSON.stringify([socket.path, match[2], match[3]]))
        .digest("hex"),
    };
  } catch {
    return null;
  }
}

export async function captureTmuxServerProofAsync(
  run: (args: readonly string[]) => Promise<string>,
): Promise<TmuxServerProof | null> {
  const args = ["-N", "display-message", "-p", "#{socket_path}|#{pid}|#{start_time}"];
  try {
    const raw = (await run(args)).trimEnd();
    const match = /^(.*)\|([1-9][0-9]*)\|([1-9][0-9]*)$/u.exec(raw);
    if (!match || raw.length > 8192) return null;
    const socket = captureUnixSocketIdentity(match[1]!);
    if ((await run(args)).trimEnd() !== raw) return null;
    revalidateUnixSocketIdentity(socket);
    return {
      version: 1,
      kind: "live",
      digest: createHash("sha256")
        .update(JSON.stringify([socket.path, match[2], match[3]]))
        .digest("hex"),
    };
  } catch {
    return null;
  }
}

/** A selector commitment is not evidence of an absent or live server. */
export function captureUnboundTmuxSelectorProof(
  authority: WorkspacePaneTmuxAuthority,
): TmuxServerProof | null {
  if (!isNamedSocketAuthorityUnbound(authority) || authority.socketSelector.kind !== "name")
    return null;
  try {
    const executable = realpathSync(authority.executablePath);
    const stat = statSync(executable, { bigint: true });
    const uid = process.getuid?.();
    if (uid === undefined || !stat.isFile()) return null;
    return {
      version: 1,
      kind: "unbound-name",
      digest: createHash("sha256")
        .update(
          JSON.stringify([
            "sanitized-tmux-environment-v1",
            executable,
            String(stat.dev),
            String(stat.ino),
            String(stat.mtimeNs),
            String(stat.size),
            uid,
            authority.socketSelector.name,
          ]),
        )
        .digest("hex"),
    };
  } catch {
    return null;
  }
}
