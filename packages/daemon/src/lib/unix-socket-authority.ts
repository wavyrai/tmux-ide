import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const MAX_SOCKET_PATH_BYTES = 4_096;

/**
 * The longest socket path a client can connect to: `sockaddr_un.sun_path` less
 * its terminating NUL. 108 bytes on Linux, 104 on macOS and the BSDs.
 */
export function unixSocketPathLimit(platform: NodeJS.Platform = process.platform): number {
  return platform === "linux" ? 107 : 103;
}

export class UnixSocketPathTooLongError extends TypeError {
  constructor(bytes: number, limit: number) {
    super(
      `The tmux socket path is ${bytes} bytes; this platform allows ${limit}. Start the tmux server on a shorter socket path.`,
    );
    this.name = "UnixSocketPathTooLongError";
  }
}

export interface UnixSocketIdentity {
  /**
   * The spelling to connect with. The canonical path when it fits
   * {@link unixSocketPathLimit}; otherwise a shorter spelling proven to be the
   * same socket, such as /tmp for /private/tmp on macOS (#384).
   */
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly mtimeNs: bigint;
  readonly birthtimeNs: bigint;
}

function validSocketPath(path: string): boolean {
  return (
    isAbsolute(path) &&
    resolve(path) === path &&
    Buffer.byteLength(path) <= MAX_SOCKET_PATH_BYTES &&
    !/[\0\r\n]/u.test(path)
  );
}

export function captureUnixSocketIdentity(path: string): UnixSocketIdentity {
  if (!validSocketPath(path)) throw new TypeError("Unix socket path is invalid");
  const sourceParent = lstatSync(dirname(path));
  const source = lstatSync(path, { bigint: true });
  if (!sourceParent.isDirectory() || sourceParent.isSymbolicLink() || !source.isSocket())
    throw new TypeError("Unix socket authority is invalid");
  const canonicalPath = join(realpathSync(dirname(path)), basename(path));
  const canonical = lstatSync(canonicalPath, { bigint: true });
  if (!canonical.isSocket() || canonical.dev !== source.dev || canonical.ino !== source.ino)
    throw new TypeError("Unix socket authority changed while resolving");
  return Object.freeze({
    path: reachableSpelling(path, canonicalPath, canonical),
    dev: Number(canonical.dev),
    ino: Number(canonical.ino),
    mtimeNs: canonical.mtimeNs,
    birthtimeNs: canonical.birthtimeNs,
  });
}

/**
 * tmux refuses a socket path longer than `sun_path` ("File name too long"). A
 * server can still be running on such a socket when it was started through a
 * shorter spelling. Use that spelling, but only when it names the same socket
 * inode; `revalidateUnixSocketIdentity` checks that inode again before each use.
 */
function reachableSpelling(
  given: string,
  canonicalPath: string,
  canonical: { readonly dev: bigint; readonly ino: bigint },
): string {
  const limit = unixSocketPathLimit();
  if (Buffer.byteLength(canonicalPath) <= limit) return canonicalPath;
  const candidates = [given];
  if (process.platform === "darwin" && /^\/private\/(?:tmp|var)\//u.test(canonicalPath))
    candidates.push(canonicalPath.slice("/private".length));
  for (const candidate of candidates) {
    if (candidate === canonicalPath || Buffer.byteLength(candidate) > limit) continue;
    try {
      const socket = lstatSync(candidate, { bigint: true });
      if (socket.isSocket() && socket.dev === canonical.dev && socket.ino === canonical.ino)
        return candidate;
    } catch {
      // Not a usable spelling; try the next one.
    }
  }
  throw new UnixSocketPathTooLongError(Buffer.byteLength(canonicalPath), limit);
}

export function revalidateUnixSocketIdentity(identity: UnixSocketIdentity): string {
  if (
    !validSocketPath(identity.path) ||
    !Number.isSafeInteger(identity.dev) ||
    identity.dev < 0 ||
    !Number.isSafeInteger(identity.ino) ||
    identity.ino < 0 ||
    typeof identity.mtimeNs !== "bigint" ||
    identity.mtimeNs < 0n ||
    typeof identity.birthtimeNs !== "bigint" ||
    identity.birthtimeNs < 0n
  )
    throw new TypeError("Unix socket identity is invalid");
  const current = lstatSync(identity.path, { bigint: true });
  if (
    !current.isSocket() ||
    current.dev !== BigInt(identity.dev) ||
    current.ino !== BigInt(identity.ino) ||
    current.birthtimeNs !== identity.birthtimeNs ||
    (!birthtimeIdentifiesFile(process.platform) && current.mtimeNs !== identity.mtimeNs)
  )
    throw new TypeError("Unix socket authority changed before use");
  return identity.path;
}

/**
 * A socket that was replaced at the same path can get the same inode number
 * back, so device and inode alone do not identify it. Where the filesystem
 * records a real creation time (macOS and the BSDs), that settles it, and the
 * modification time must not: `touch` on the socket of a healthy tmux server
 * changes mtime and would otherwise retire its owner and close every stream.
 * Linux reports a creation time only on some filesystems and Node substitutes
 * the change time elsewhere, so there mtime stays part of the identity.
 */
export function birthtimeIdentifiesFile(platform: NodeJS.Platform): boolean {
  return (
    platform === "darwin" ||
    platform === "freebsd" ||
    platform === "openbsd" ||
    platform === "netbsd"
  );
}
